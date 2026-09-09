import { createHash } from "node:crypto";
import { z } from "zod";
import { stableJsonStringify } from "./stable-json";
import type { MonotonicDeadline } from "./bounded-race";
import { sha256Hex, type CommandEffectResult, type CurrentCommandEffectResult } from "./command-effect";
import { classifyIssueFailure, type ConfirmationCheckResult, type ConfirmationClaimResult, type ConfirmationIssueResult, type ConfirmationQuestionEventResult } from "./confirmation-failure";
import type { AuthorizationClaim, ConfirmationLedger, PendingAuthorization } from "./confirmation-ledger";
import { confirmationQuestionPayloadDigest, renderConfirmationBody, type ConfirmationChallenge, type ConfirmationValues } from "./confirmation-renderer";
import type { AuthorizationContext } from "./session-context";
import {
  MAX_QUESTION_ANSWER_CHARS, MAX_QUESTION_ANSWERS_PER_QUESTION, MAX_QUESTION_COUNT,
  MAX_QUESTION_HEADER_CHARS, MAX_QUESTION_OPTION_DESCRIPTION_CHARS, MAX_QUESTION_OPTION_LABEL_CHARS,
  MAX_QUESTION_OPTIONS_PER_QUESTION, MAX_QUESTION_PAYLOAD_UTF8_BYTES, MAX_QUESTION_TEXT_CHARS,
  type NormalizedQuestion,
} from "./transcript-types";
import type { ApprovalVerdict, ReviewResponse } from "./types";
import { renderCommandApprovalError } from "./user-facing";

const hasOnlyUnicodeScalars = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};
const boundedScalarString = (max: number) => z.string().max(max).refine(hasOnlyUnicodeScalars);
const QuestionOptionSchema = z.strictObject({
  label: boundedScalarString(MAX_QUESTION_OPTION_LABEL_CHARS),
  description: boundedScalarString(MAX_QUESTION_OPTION_DESCRIPTION_CHARS),
});
const QuestionPromptSchema = z.strictObject({
  header: boundedScalarString(MAX_QUESTION_HEADER_CHARS), question: boundedScalarString(MAX_QUESTION_TEXT_CHARS),
  options: z.array(QuestionOptionSchema).max(MAX_QUESTION_OPTIONS_PER_QUESTION), multiple: z.boolean().optional(), custom: z.literal(true).optional(),
});
export const CanonicalQuestionPayloadSchema = z.strictObject({
  questions: z.array(z.strictObject({
    custom: z.literal(true), header: boundedScalarString(MAX_QUESTION_HEADER_CHARS), multiple: z.boolean(),
    options: z.array(QuestionOptionSchema).max(MAX_QUESTION_OPTIONS_PER_QUESTION),
    question: boundedScalarString(MAX_QUESTION_TEXT_CHARS),
  })).min(1).max(MAX_QUESTION_COUNT),
});
export const CompletedQuestionStateSchema = z.strictObject({
  status: z.literal("completed"),
  input: z.strictObject({ questions: z.array(QuestionPromptSchema).min(1).max(MAX_QUESTION_COUNT) }),
  output: boundedScalarString(MAX_QUESTION_PAYLOAD_UTF8_BYTES), title: boundedScalarString(MAX_QUESTION_TEXT_CHARS),
  metadata: z.strictObject({
    answers: z.array(z.array(boundedScalarString(MAX_QUESTION_ANSWER_CHARS)).max(MAX_QUESTION_ANSWERS_PER_QUESTION)).max(MAX_QUESTION_COUNT),
    truncated: z.literal(false).optional(),
  }),
  time: z.strictObject({ start: z.number().finite(), end: z.number().finite(), compacted: z.number().finite().optional() }),
  attachments: z.array(z.never()).max(0).optional(),
});
export type ParsedCompletedQuestionState = z.infer<typeof CompletedQuestionStateSchema>;
const canonicalString = (value: string): string => {
  let result = '"';
  for (const scalar of value) {
    const code = scalar.charCodeAt(0);
    if (scalar === '"') result += '\\"';
    else if (scalar === "\\") result += "\\\\";
    else if (code <= 0x1f) result += `\\u00${code.toString(16).padStart(2, "0")}`;
    else result += scalar;
  }
  return `${result}"`;
};
export const normalizeQuestionPrompts = (input: unknown): readonly NormalizedQuestion[] | undefined => {
  const parsed = z.array(QuestionPromptSchema).min(1).max(MAX_QUESTION_COUNT).safeParse(input);
  return parsed.success ? Object.freeze(parsed.data.map((question) => Object.freeze({
  header: question.header, question: question.question,
  options: Object.freeze(question.options.map((option) => Object.freeze({
    label: option.label, description: option.description,
  }))),
  multiple: question.multiple ?? false, custom: true,
  }))) : undefined;
};
export const normalizeQuestionPayload = (
  state: ParsedCompletedQuestionState,
): readonly NormalizedQuestion[] => normalizeQuestionPrompts(state.input.questions) ?? Object.freeze([]);
export const canonicalQuestionPayloadJson = (questions: readonly NormalizedQuestion[]): string | undefined => {
  if (questions.some((question) => !hasOnlyUnicodeScalars(question.header)
    || !hasOnlyUnicodeScalars(question.question) || question.options.some((option) => !hasOnlyUnicodeScalars(option.label)
      || !hasOnlyUnicodeScalars(option.description)))) return undefined;
  const serializedQuestions = questions.map((question) => {
    const options = question.options.map((option) => (
      `{"description":${canonicalString(option.description)},"label":${canonicalString(option.label)}}`
    )).join(",");
    return `{"custom":true,"header":${canonicalString(question.header)},"multiple":${String(question.multiple)},"options":[${options}],"question":${canonicalString(question.question)}}`;
  }).join(",");
  return `{"questions":[${serializedQuestions}]}`;
};
export const questionPayloadDigest = (questions: readonly NormalizedQuestion[]): string | undefined => {
  const serialized = canonicalQuestionPayloadJson(questions);
  return serialized === undefined || new TextEncoder().encode(serialized).byteLength > MAX_QUESTION_PAYLOAD_UTF8_BYTES
    ? undefined : createHash("sha256").update(serialized, "utf8").digest("hex");
};
export const questionCompletionAgrees = (state: ParsedCompletedQuestionState): boolean => {
  if (state.metadata.answers.length !== state.input.questions.length) return false;
  const formatted = state.input.questions.map((question, index) => {
    const answer = state.metadata.answers[index];
    return `"${question.question}"="${answer && answer.length > 0 ? answer.join(", ") : "Unanswered"}"`;
  }).join(", ");
  const plural = state.input.questions.length > 1 ? "s" : "";
  return state.title === `Asked ${state.input.questions.length} question${plural}`
    && state.output === `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`;
};

export type ConfirmationDisclosure = ConfirmationValues;
export const CONFIRMATION_TTL_MS = 5 * 60 * 1_000;
type CurrentConfirmationEffect = Extract<CurrentCommandEffectResult, { readonly ok: true }>;
type LegacyConfirmationEffect = Extract<CommandEffectResult, { readonly ok: true }>;
export type ConfirmationEffect = CurrentConfirmationEffect | LegacyConfirmationEffect;
export type ConfirmationReview = Extract<ReviewResponse, { readonly outcome: "needs_confirmation" }>;
export type ConfirmationQuestionEvent =
  | { readonly type: "question.asked"; readonly parentSessionID: string; readonly questionRequestID: string; readonly questionMessageID: string; readonly questionCallID: string; readonly questions: readonly unknown[] }
  | { readonly type: "question.replied"; readonly parentSessionID: string; readonly questionRequestID: string; readonly answers: readonly (readonly string[])[] }
  | { readonly type: "question.rejected"; readonly parentSessionID: string; readonly questionRequestID: string };
export type AuthorizationStage = "user_rule" | "builtin_rule" | "tirith" | "reviewer";
export type ConfirmationStateService = {
  issue(input: { readonly effect: ConfirmationEffect; readonly review: ConfirmationReview; readonly tool: string; readonly deadline: MonotonicDeadline }): Promise<ConfirmationIssueResult>;
  claim(input: { readonly effect: ConfirmationEffect; readonly deadline: MonotonicDeadline }): Promise<ConfirmationClaimResult>;
  handleQuestionEvent(event: ConfirmationQuestionEvent): Promise<ConfirmationQuestionEventResult>;
  observe(claim: AuthorizationClaim, stage: AuthorizationStage): boolean;
  release(claim: AuthorizationClaim): boolean;
  finish(claim: AuthorizationClaim): boolean;
  clearSession(parentSessionID: string): Promise<void>;
  dispose(): Promise<void>;
};
export type LegacyConfirmationService = {
  issue(input: { readonly effect: ConfirmationEffect; readonly review: ConfirmationReview; readonly tool: string; readonly deadline: MonotonicDeadline }): Promise<ConfirmationIssueResult>;
  check(input: { readonly effect: LegacyConfirmationEffect; readonly deadline: MonotonicDeadline }): Promise<ConfirmationCheckResult>;
  redact(parentSessionID: string, transcript: import("./transcript-types").ReviewerTranscript): import("./transcript-types").ReviewerTranscript;
  clearSession(parentSessionID: string): Promise<void>;
  dispose(): Promise<void>;
};
export type ConfirmationService = ConfirmationStateService | LegacyConfirmationService;
export type ConfirmationContextFetch = (effect: ConfirmationEffect, deadline: MonotonicDeadline) => Promise<
  { readonly ok: true; readonly context: AuthorizationContext } | { readonly ok: false; readonly reason: "timeout" | "sdk_error" }
>;

export const createConfirmationDisclosure = (
  values: ConfirmationValues,
): { readonly ok: true; readonly sha256: string } | { readonly ok: false } => {
  const serialized = stableJsonStringify({
    command: values.command,
    cwd: values.cwd,
    action: values.action,
    data: values.data,
    destination: values.destination,
    risk: values.risk,
  });
  return serialized.ok
    ? { ok: true, sha256: sha256Hex(serialized.value) }
    : { ok: false };
};

const confirmationVerdict = (review: ConfirmationReview): ApprovalVerdict => ({
  decision: "block", source: "review", reasonSource: "reviewer", riskLevel: review.riskLevel,
  userAuthorization: review.userAuthorization,
  categories: review.categories.some((category) => category.id === "security.explicit_confirmation_required")
    ? review.categories : [...review.categories, { id: "security.explicit_confirmation_required", score: 1 }],
  reasons: review.reasons, matchedRuleLabels: [],
});

export const createConfirmationIssue = (input: {
  readonly ledger: ConfirmationLedger;
  readonly fetchContext: ConfirmationContextFetch;
  readonly closed: () => boolean;
}): ConfirmationStateService["issue"] => async ({ effect, review, tool, deadline }) => input.ledger.runLocked(
  effect.effect.parentSessionID,
  async () => {
    if (input.closed()) return { kind: "failure", code: "confirmation_disposed" };
    if (!("currentCallID" in effect.effect)) return { kind: "failure", code: "confirmation_render_failed" };
    const values = { command: effect.effect.command, cwd: effect.effect.canonicalCwd, ...review.confirmation };
    const disclosure = createConfirmationDisclosure(values);
    const payloadDigest = confirmationQuestionPayloadDigest();
    if (!disclosure.ok || payloadDigest === undefined) return { kind: "failure", code: "confirmation_render_failed" };
    const current = input.ledger.slot(effect.effect.parentSessionID);
    if (current?.kind === "pending" && current.question.kind === "waiting" && current.effectSha256 === effect.sha256
      && current.disclosureSha256 === disclosure.sha256 && current.boundary.blockedCallID === effect.effect.currentCallID) {
      return { kind: "error", error: current.error };
    }
    if (current?.kind === "claimed") return { kind: "failure", code: "confirmation_claim_active" };
    const scaffold: ConfirmationChallenge = { values, effectSha256: effect.sha256, disclosureSha256: disclosure.sha256, replaced: current?.kind === "pending" };
    if (!renderConfirmationBody(scaffold).ok) return { kind: "failure", code: "confirmation_render_failed" };
    const fetched = await input.fetchContext(effect, deadline);
    if (input.closed()) return { kind: "failure", code: "confirmation_disposed" };
    if (!fetched.ok) return { kind: "failure", code: classifyIssueFailure(fetched.reason) };
    if (fetched.context.snapshot.reviewer.status !== "available") {
      const reason = fetched.context.snapshot.reviewer.status === "unavailable" ? fetched.context.snapshot.reviewer.reason : "malformed";
      return { kind: "failure", code: classifyIssueFailure(reason) };
    }
    const direct = fetched.context.snapshot.authorizationCandidates.filter((candidate) => candidate.kind === "direct_user");
    const candidate = direct[0];
    if (direct.length !== 1 || !candidate) return { kind: "failure", code: "issue_boundary_absent_from_window" };
    const rendered = renderCommandApprovalError({ kind: "confirmation", tool, verdict: confirmationVerdict(review), challenge: scaffold });
    if (rendered.kind !== "error") return { kind: "failure", code: rendered.code };
    const issuedAt = deadline.now();
    const pending: PendingAuthorization = Object.freeze({
      kind: "pending", parentSessionID: effect.effect.parentSessionID, canonicalCwd: effect.effect.canonicalCwd,
      effectSha256: effect.sha256, disclosureSha256: disclosure.sha256, questionPayloadDigest: payloadDigest,
      generation: input.ledger.nextGeneration(effect.effect.parentSessionID),
      boundary: Object.freeze({ challengeMessageID: candidate.current.messageID, challengeCreated: candidate.current.created,
        challengeResponsePosition: candidate.current.responsePosition, blockedPartID: candidate.current.partID,
        blockedPartPosition: candidate.current.partPosition, blockedCallID: candidate.current.callID }),
      issuedAt, expiresAt: issuedAt + CONFIRMATION_TTL_MS, question: Object.freeze({ kind: "waiting" }), error: rendered.error,
    });
    input.ledger.setSlot(effect.effect.parentSessionID, pending);
    return { kind: "error", error: rendered.error };
  },
);
