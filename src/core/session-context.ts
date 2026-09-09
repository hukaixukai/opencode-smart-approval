import type { Hooks } from "@opencode-ai/plugin";
import { canonicalRootSpelling } from "./anchored-fs";
import { runBoundedCall, type MonotonicDeadline } from "./bounded-race";
import type { ConfirmationService } from "./confirmation-service";
import { parseConfirmationQuestionEvent } from "./confirmation-renderer";
import type { OpenCodeClientAdapter } from "./opencode-client-adapter";
import type { ReviewRegistry } from "./review-registry";
import { SessionMessagesResultSchema, TranscriptEnvelopeSchema, type ParsedTranscriptEntry } from "./transcript-schema";
import { copyBoundedTranscriptJson, projectCopiedTranscriptEnvelope } from "./transcript-projector";
import {
  emptyTranscriptSnapshot, type AuthorizationTranscriptSnapshot, type ReviewerTranscript,
  type TranscriptFetchInput, type TranscriptSnapshot, type TranscriptUnavailableReason,
} from "./transcript-types";
import { failClosedOpenCodeReview, reviewWithOpenCode, type OpenCodeReviewerRuntime } from "./opencode-reviewer";
import type { ReviewAuthorizationCandidate } from "./review-request";
import type { TirithScan } from "./risk-tool";
import type { CommandContext, ReviewResponse, RuleEvaluation, ShellAnalysis } from "./types";

export type {
  AuthorizationCandidate, AuthorizationEntry, AuthorizationMessage, AuthorizationSnapshot,
  AuthorizationTranscriptSnapshot, QuestionAuthorizationScope, ReviewerTranscript,
  ReviewerTranscriptMessage, ReviewerTranscriptPart, TranscriptFetchInput, TranscriptSnapshot,
  TranscriptUnavailableReason,
} from "./transcript-types";
export {
  MAX_AUTHORIZATION_CANDIDATES, MAX_AUTHORIZATION_CANDIDATES_UTF8_BYTES,
  MAX_TRANSCRIPT_ENVELOPE_UTF8_BYTES, MAX_TRANSCRIPT_PARTS_PER_MESSAGE,
  MAX_TRANSCRIPT_TEXT_CHARS_PER_PART, MAX_TRANSCRIPT_TOOL_NAME_CHARS,
  MAX_TRANSCRIPT_TOTAL_CHARS, MAX_TRANSCRIPT_TOTAL_PARTS,
} from "./transcript-types";
export { canonicalQuestionPayloadJson, questionPayloadDigest } from "./confirmation-disclosure";
export {
  projectAuthorizationEnvelope, projectTranscriptEnvelope, type TranscriptProjectionInput,
} from "./transcript-projector";

export const AUTHORIZATION_CONTEXT_LIMIT = 32;
export const AUTHORIZATION_CALL_TIMEOUT_MS = 2_000;
export const redactReviewerTranscript = (transcript: ReviewerTranscript): ReviewerTranscript => transcript;
const disabled = (): TranscriptSnapshot => emptyTranscriptSnapshot({ status: "disabled" });
const unavailable = (reason: "timeout" | "sdk_error" | "malformed" | "limit_exceeded"): TranscriptSnapshot =>
  emptyTranscriptSnapshot({ status: "unavailable", reason });
const reviewerSnapshot = (snapshot: AuthorizationTranscriptSnapshot): TranscriptSnapshot => Object.freeze({ reviewer: snapshot.reviewer, authorizationMessages: snapshot.authorizationMessages });

export const fetchSessionContext = async (input: TranscriptFetchInput): Promise<TranscriptSnapshot> => {
  if (!input.client || input.limit <= 0) return disabled();
  if (!Number.isSafeInteger(input.limit)) return unavailable("limit_exceeded");
  if (input.signal.aborted) return unavailable("timeout");
  let response: unknown;
  try {
    response = await input.client.session.messages({
      path: { id: input.parentSessionID },
      query: { directory: input.canonicalDirectory, limit: input.limit },
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal.aborted || (error instanceof Error && error.name === "TimeoutError")) return unavailable("timeout");
    return unavailable("sdk_error");
  }
  const copied = copyBoundedTranscriptJson(response);
  if (!copied.ok) return unavailable(copied.reason);
  const result = SessionMessagesResultSchema.safeParse(copied.value);
  if (!result.success) return unavailable("malformed");
  if (result.data.error !== undefined) return unavailable("sdk_error");
  if (result.data.data === undefined) return unavailable("malformed");
  return reviewerSnapshot(projectCopiedTranscriptEnvelope({
    data: result.data.data,
    parentSessionID: input.parentSessionID,
    canonicalDirectory: input.canonicalDirectory,
    limit: input.limit,
    ...(input.currentCall === undefined ? {} : { currentCall: input.currentCall }),
    ...(input.questionAuthorizationScope === undefined ? {} : { questionAuthorizationScope: input.questionAuthorizationScope }),
  }));
};

export type AdapterTranscriptFetchInput = Omit<TranscriptFetchInput, "client"> & {
  readonly adapter: Pick<OpenCodeClientAdapter, "messages"> | undefined;
};
export const fetchSessionContextWithAdapter = async (
  input: AdapterTranscriptFetchInput,
): Promise<TranscriptSnapshot> => {
  if (!input.adapter || input.limit <= 0) return disabled();
  if (!Number.isSafeInteger(input.limit)) return unavailable("limit_exceeded");
  if (input.signal.aborted) return unavailable("timeout");
  const result = await input.adapter.messages({
    sessionID: input.parentSessionID,
    directory: input.canonicalDirectory,
    limit: input.limit,
    signal: input.signal,
  });
  if (!result.ok) {
    if (input.signal.aborted) return unavailable("timeout");
    if (result.code === "limit_exceeded") return unavailable("limit_exceeded");
    if (result.code === "malformed_json") return unavailable("malformed");
    return unavailable("sdk_error");
  }
  return reviewerSnapshot(projectCopiedTranscriptEnvelope({
    data: result.data,
    parentSessionID: input.parentSessionID,
    canonicalDirectory: input.canonicalDirectory,
    limit: input.limit,
    ...(input.currentCall === undefined ? {} : { currentCall: input.currentCall }),
    ...(input.questionAuthorizationScope === undefined ? {} : { questionAuthorizationScope: input.questionAuthorizationScope }),
  }));
};

export type AuthorizationContext = {
  readonly snapshot: AuthorizationTranscriptSnapshot;
  readonly entries: readonly ParsedTranscriptEntry[];
  readonly copied: unknown;
};
const unavailableAuthorizationContext = (reason: TranscriptUnavailableReason): AuthorizationContext => Object.freeze({
  snapshot: Object.freeze({
    ...emptyTranscriptSnapshot(Object.freeze({ status: "unavailable", reason })), authorizationCandidates: Object.freeze([]),
  }),
  entries: Object.freeze([]),
  copied: Object.freeze([]),
});
export const fetchAuthorizationContext = async (input: {
  readonly adapter: Pick<OpenCodeClientAdapter, "messages">;
  readonly parentSessionID: string;
  readonly canonicalDirectory: string;
  readonly currentCall: { readonly callID: string; readonly tool: string; readonly effectSha256: string };
  readonly questionAuthorizationScope?: import("./transcript-types").QuestionAuthorizationScope;
  readonly signal: AbortSignal;
}): Promise<AuthorizationContext> => {
  const result = await input.adapter.messages({
    sessionID: input.parentSessionID,
    directory: input.canonicalDirectory,
    limit: AUTHORIZATION_CONTEXT_LIMIT,
    signal: input.signal,
  });
  if (!result.ok) {
    if (input.signal.aborted) return unavailableAuthorizationContext("timeout");
    if (result.code === "limit_exceeded") return unavailableAuthorizationContext("limit_exceeded");
    if (result.code === "malformed_json") return unavailableAuthorizationContext("malformed");
    return unavailableAuthorizationContext("sdk_error");
  }
  const copied = copyBoundedTranscriptJson(result.data);
  if (!copied.ok) return unavailableAuthorizationContext(copied.reason);
  const parsed = TranscriptEnvelopeSchema.safeParse(copied.value);
  if (!parsed.success) return unavailableAuthorizationContext("malformed");
  const snapshot = projectCopiedTranscriptEnvelope({
    data: copied.value,
    parentSessionID: input.parentSessionID,
    canonicalDirectory: input.canonicalDirectory,
    limit: AUTHORIZATION_CONTEXT_LIMIT,
    currentCall: input.currentCall,
    ...(input.questionAuthorizationScope ? { questionAuthorizationScope: input.questionAuthorizationScope } : {}),
  });
  return snapshot.reviewer.status === "available"
    ? Object.freeze({ snapshot, entries: Object.freeze(parsed.data), copied: copied.value })
    : unavailableAuthorizationContext(snapshot.reviewer.status === "unavailable" ? snapshot.reviewer.reason : "malformed");
};

export const reviewDirectoriesMatch = (contextDirectory: string, reviewerDirectory: string): boolean => {
  const context = canonicalRootSpelling(contextDirectory);
  const reviewer = canonicalRootSpelling(reviewerDirectory);
  return context.ok && context.value.absolute === contextDirectory
    && reviewer.ok && reviewer.value.absolute === reviewerDirectory;
};
export const fetchDecisionTranscript = async (input: {
  readonly deadline: MonotonicDeadline;
  readonly timeoutMs: number;
  readonly adapter: Pick<OpenCodeClientAdapter, "messages"> | undefined;
  readonly parentSessionID: string;
  readonly canonicalDirectory: string;
  readonly currentCall?: { readonly callID: string; readonly tool: string; readonly effectSha256: string };
  readonly limit: number;
  readonly claimed: ReviewerTranscript | undefined;
}): Promise<TranscriptSnapshot> => {
  if (input.claimed) return Object.freeze({ reviewer: input.claimed, authorizationMessages: Object.freeze([]) });
  const call = await runBoundedCall({
    deadline: input.deadline,
    timeoutMs: input.timeoutMs,
    operation: (signal) => fetchSessionContextWithAdapter({
      adapter: input.adapter,
      parentSessionID: input.parentSessionID,
      canonicalDirectory: input.canonicalDirectory,
      ...(input.currentCall ? { currentCall: input.currentCall } : {}),
      limit: input.limit,
      signal,
    }),
  });
  return call.ok ? call.value : unavailable(call.code === "rejected" ? "sdk_error" : "timeout");
};

export const reviewDecisionWithContext = async (input: {
  readonly deadline: MonotonicDeadline; readonly timeoutMs: number;
  readonly reviewerRuntime: OpenCodeReviewerRuntime | undefined; readonly context: CommandContext;
  readonly currentCall: { readonly callID: string; readonly tool: string; readonly effectSha256: string } | undefined;
  readonly shellAnalysis: ShellAnalysis; readonly evaluation: RuleEvaluation; readonly tirith: TirithScan;
  readonly contextMessages: number; readonly claimedTranscript: ReviewerTranscript | undefined;
  readonly authorizationCandidate: ReviewAuthorizationCandidate | undefined; readonly cleanupEnabled: boolean;
}): Promise<ReviewResponse> => {
  const transcript = await fetchDecisionTranscript({
    deadline: input.deadline,
    timeoutMs: input.timeoutMs,
    adapter: input.reviewerRuntime?.adapter,
    parentSessionID: input.context.sessionID,
    canonicalDirectory: input.reviewerRuntime?.directory ?? input.context.cwd,
    ...(input.currentCall ? { currentCall: input.currentCall } : {}),
    limit: input.contextMessages,
    claimed: input.claimedTranscript,
  });
  return input.reviewerRuntime
    ? reviewWithOpenCode(input.reviewerRuntime, {
        parentSessionID: input.context.sessionID,
        deadline: input.deadline,
        cleanupEnabled: input.cleanupEnabled,
        request: {
          context: input.context,
          shellAnalysis: input.shellAnalysis,
          evaluation: input.evaluation,
          tirith: input.tirith,
          transcript: transcript.reviewer,
          ...(input.authorizationCandidate === undefined ? {} : { authorizationCandidate: input.authorizationCandidate }),
        },
      })
    : failClosedOpenCodeReview("client_unavailable");
};

export const createApprovalPluginEventHook = (input: {
  readonly workspace: string;
  readonly registry: ReviewRegistry;
  readonly confirmation: ConfirmationService | undefined;
  readonly closed: () => boolean;
}): NonNullable<Hooks["event"]> => async ({ event }) => {
  if (input.closed()) return;
  const questionEvent = parseConfirmationQuestionEvent(event);
  if (questionEvent) {
    if (input.confirmation && "handleQuestionEvent" in input.confirmation) {
      await input.confirmation.handleQuestionEvent(questionEvent);
    }
    return;
  }
  switch (event.type) {
    case "session.idle":
      await input.registry.idle(event.properties.sessionID, input.workspace);
      break;
    case "session.deleted": {
      const canonical = canonicalRootSpelling(event.properties.info.directory);
      if (canonical.ok && canonical.value.absolute === input.workspace) {
        input.registry.deleted(event.properties.info.id, input.workspace);
        await input.confirmation?.clearSession(event.properties.info.id);
      }
      break;
    }
    case "server.instance.disposed": {
      const canonical = canonicalRootSpelling(event.properties.directory);
      if (canonical.ok && canonical.value.absolute === input.workspace) {
        await input.registry.dispose(input.workspace);
        await input.confirmation?.dispose();
      }
      break;
    }
  }
};
