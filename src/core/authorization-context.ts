import {
  CompletedQuestionStateSchema,
  normalizeQuestionPayload,
  questionCompletionAgrees,
  questionPayloadDigest,
} from "./confirmation-disclosure";
import type { ParsedTranscriptEntry, ParsedTranscriptPart } from "./transcript-schema";
import { hasOnlyAutomaticEmptyDiffSummary } from "./transcript-summary";
import {
  MAX_AUTHORIZATION_CANDIDATES,
  MAX_AUTHORIZATION_CANDIDATES_UTF8_BYTES,
  MAX_TRANSCRIPT_TEXT_CHARS_PER_PART,
  isHostValidatedQuestionAuthorizationScope,
  type AuthorizationCandidate,
  type AuthorizationSourceIdentity,
  type CurrentCallIdentity,
  type QuestionAuthorizationScope,
} from "./transcript-types";

const SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;

export type AuthorizationCandidateProjectionInput = {
  readonly entries: readonly ParsedTranscriptEntry[];
  readonly parentSessionID: string;
  readonly currentCall?: {
    readonly callID: string;
    readonly tool: string;
    readonly effectSha256: string;
  };
  readonly questionAuthorizationScope?: QuestionAuthorizationScope;
};
export type AuthorizationCandidateProjection =
  | { readonly ok: true; readonly candidates: readonly AuthorizationCandidate[] }
  | { readonly ok: false; readonly reason: "malformed" | "limit_exceeded" };
type LocatedCurrentCall = {
  readonly entry: ParsedTranscriptEntry;
  readonly responsePosition: number;
  readonly part: Extract<ParsedTranscriptPart, { readonly type: "tool" }>;
  readonly partPosition: number;
};
type ScopedQuestionProjection =
  | { readonly ok: true; readonly candidate?: Extract<AuthorizationCandidate, { readonly kind: "question_answer" }> }
  | { readonly ok: false; readonly reason: "malformed" | "limit_exceeded" };

const ordinaryUserSource = (
  entry: ParsedTranscriptEntry,
  responsePosition: number,
): { readonly source: AuthorizationSourceIdentity; readonly text: string } | undefined => {
  if (entry.info.role !== "user"
    || (entry.info.summary !== undefined && !hasOnlyAutomaticEmptyDiffSummary(entry))
    || entry.info.system !== undefined || entry.parts.length !== 1) return undefined;
  const part = entry.parts[0];
  if (!part || part.type !== "text" || part.synthetic === true || part.ignored === true
    || part.text.length > MAX_TRANSCRIPT_TEXT_CHARS_PER_PART) return undefined;
  return Object.freeze({
    source: Object.freeze({
      sessionID: entry.info.sessionID,
      messageID: entry.info.id,
      created: entry.info.time.created,
      responsePosition,
      partID: part.id,
      partPosition: 0,
    }),
    text: part.text,
  });
};

const locateCurrentCall = (
  input: AuthorizationCandidateProjectionInput,
): LocatedCurrentCall | undefined => {
  const current = input.currentCall;
  if (!current || !SOURCE_ID.test(current.callID) || !SOURCE_ID.test(current.tool)
    || !SHA256_HEX.test(current.effectSha256)) return undefined;
  const matches: LocatedCurrentCall[] = [];
  for (const [responsePosition, entry] of input.entries.entries()) {
    if (entry.info.role !== "assistant") continue;
    for (const [partPosition, part] of entry.parts.entries()) {
      if (part.type === "tool" && part.callID === current.callID && part.tool === current.tool) {
        matches.push({ entry, responsePosition, part, partPosition });
      }
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
};

const projectScopedQuestionCandidate = (input: {
  readonly entries: readonly ParsedTranscriptEntry[];
  readonly current: CurrentCallIdentity;
  readonly currentResponsePosition: number;
  readonly directResponsePosition?: number;
  readonly scope?: QuestionAuthorizationScope;
}): ScopedQuestionProjection => {
  const scope = input.scope;
  if (scope === undefined) return { ok: true };
  if (!isHostValidatedQuestionAuthorizationScope(scope)
    || scope.parentSessionID !== input.current.sessionID || scope.retryCallID !== input.current.callID
    || scope.currentEffectSha256 !== input.current.effectSha256
    || scope.questionResponsePosition >= input.currentResponsePosition
    || !(scope.questionResponsePosition + 1 === input.currentResponsePosition
      || (input.directResponsePosition !== undefined
        && input.directResponsePosition + 1 === input.currentResponsePosition
        && scope.questionResponsePosition < input.directResponsePosition))) return { ok: false, reason: "malformed" };
  const challenge = input.entries[scope.challengeResponsePosition];
  const blockedPart = challenge?.parts[scope.blockedPartPosition];
  const questionEntry = input.entries[scope.questionResponsePosition];
  const questionPart = questionEntry?.parts[scope.questionPartPosition];
  if (!challenge || challenge.info.role !== "assistant" || challenge.info.id !== scope.challengeMessageID
    || challenge.info.time.created !== scope.challengeCreated || !blockedPart || blockedPart.type !== "tool"
    || blockedPart.id !== scope.blockedPartID || blockedPart.callID !== scope.blockedCallID
    || blockedPart.tool !== input.current.tool || !questionEntry || questionEntry.info.role !== "assistant"
    || questionEntry.info.summary === true || questionEntry.info.id !== scope.questionMessageID
    || questionEntry.info.time.created !== scope.questionCreated || questionEntry.info.parentID !== challenge.info.parentID
    || !questionPart || questionPart.type !== "tool" || questionPart.tool !== "question"
    || questionPart.id !== scope.questionPartID || questionPart.callID !== scope.questionCallID
    || questionPart.state.status !== "completed") return { ok: false, reason: "malformed" };
  const matches: { readonly responsePosition: number; readonly partPosition: number }[] = [];
  for (let responsePosition = scope.challengeResponsePosition + 1;
    responsePosition < input.currentResponsePosition; responsePosition += 1) {
    const entry = input.entries[responsePosition];
    if (!entry || entry.info.role !== "assistant" || entry.info.summary === true) continue;
    for (const [partPosition, part] of entry.parts.entries()) {
      if (part.type === "tool" && part.tool === "question" && part.state.status === "completed") {
        matches.push({ responsePosition, partPosition });
      }
    }
  }
  const match = matches[0];
  if (matches.length !== 1 || !match || match.responsePosition !== scope.questionResponsePosition
    || match.partPosition !== scope.questionPartPosition) return { ok: false, reason: "malformed" };
  const parsed = CompletedQuestionStateSchema.safeParse(questionPart.state);
  if (!parsed.success) return {
    ok: false,
    reason: parsed.error.issues.some((issue) => issue.code === "too_big") ? "limit_exceeded" : "malformed",
  };
  if (!questionCompletionAgrees(parsed.data)) return { ok: false, reason: "malformed" };
  const questions = normalizeQuestionPayload(parsed.data);
  const payloadDigest = questionPayloadDigest(questions);
  if (payloadDigest === undefined) return { ok: false, reason: "limit_exceeded" };
  if (payloadDigest !== scope.questionPayloadDigest) return { ok: false, reason: "malformed" };
  return {
    ok: true,
    candidate: Object.freeze({
      kind: "question_answer",
      source: Object.freeze({
        sessionID: scope.parentSessionID,
        messageID: scope.questionMessageID,
        created: scope.questionCreated,
        responsePosition: scope.questionResponsePosition,
        partID: scope.questionPartID,
        partPosition: scope.questionPartPosition,
        callID: scope.questionCallID,
      }),
      current: input.current,
      scope,
      questions,
      answers: Object.freeze(parsed.data.metadata.answers.map((answer) => Object.freeze([...answer]))),
      payloadDigest,
    }),
  };
};

export const projectAuthorizationCandidates = (
  input: AuthorizationCandidateProjectionInput,
): AuthorizationCandidateProjection => {
  if (!input.currentCall) return input.questionAuthorizationScope
    ? { ok: false, reason: "malformed" }
    : { ok: true, candidates: Object.freeze([]) };
  const located = locateCurrentCall(input);
  if (!located || located.entry.info.summary === true) return { ok: true, candidates: Object.freeze([]) };
  const current: CurrentCallIdentity = Object.freeze({
    sessionID: input.parentSessionID,
    messageID: located.entry.info.id,
    created: located.entry.info.time.created,
    responsePosition: located.responsePosition,
    partID: located.part.id,
    partPosition: located.partPosition,
    callID: input.currentCall.callID,
    tool: input.currentCall.tool,
    effectSha256: input.currentCall.effectSha256,
  });
  const candidates: AuthorizationCandidate[] = [];
  const retryResponsePosition = located.responsePosition - 1;
  const previous = input.entries[retryResponsePosition];
  const direct = previous && located.entry.info.parentID === previous.info.id
    ? ordinaryUserSource(previous, retryResponsePosition) : undefined;
  if (direct) candidates.push(Object.freeze({ kind: "direct_user", source: direct.source, current, text: direct.text }));
  if (input.questionAuthorizationScope !== undefined) {
    const question = projectScopedQuestionCandidate({
      entries: input.entries,
      current,
      currentResponsePosition: located.responsePosition,
      ...(direct ? { directResponsePosition: retryResponsePosition } : {}),
      scope: input.questionAuthorizationScope,
    });
    if (!question.ok) return question;
    if (!question.candidate) return { ok: false, reason: "malformed" };
    candidates.push(question.candidate);
  }
  if (candidates.length > MAX_AUTHORIZATION_CANDIDATES) return { ok: false, reason: "limit_exceeded" };
  const frozen = Object.freeze(candidates);
  return new TextEncoder().encode(JSON.stringify(frozen)).byteLength > MAX_AUTHORIZATION_CANDIDATES_UTF8_BYTES
    ? { ok: false, reason: "limit_exceeded" }
    : { ok: true, candidates: frozen };
};
