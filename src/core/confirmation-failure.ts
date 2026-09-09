import type { AuthorizationClaim } from "./confirmation-ledger";
import type {
  AuthorizationClaimSource,
  PendingAuthorization, PendingQuestionState,
} from "./confirmation-ledger";
import { projectAuthorizationCandidates } from "./authorization-context";
import type { AuthorizationContext } from "./session-context";
import {
  createQuestionAuthorizationScope,
  type AuthorizationCandidate,
  type TranscriptUnavailableReason,
} from "./transcript-types";
import type { ReviewerTranscript } from "./transcript-types";
import type { CommandApprovalError } from "./user-facing";

export type ConfirmationIssueFailureCode =
  | "confirmation_disposed"
  | "confirmation_render_failed"
  | "confirmation_claim_active"
  | "issue_timeout"
  | "issue_sdk_error"
  | "issue_malformed"
  | "issue_limit_exceeded"
  | "issue_identity_mismatch"
  | "issue_order_mismatch"
  | "issue_boundary_absent_from_window";

export type ConfirmationIssueResult =
  | { readonly kind: "error"; readonly error: CommandApprovalError }
  | { readonly kind: "failure"; readonly code: ConfirmationIssueFailureCode };

export type ConfirmationClaimUnavailableCode =
  | "claim_timeout"
  | "claim_sdk_error"
  | "claim_malformed";

export type ConfirmationClaimRejectionCode =
  | "claim_confirmation_disposed"
  | "claim_expired"
  | "claim_replayed"
  | "claim_in_use"
  | "claim_effect_mismatch"
  | "claim_disclosure_mismatch"
  | "claim_payload_mismatch"
  | "claim_call_mismatch"
  | "claim_boundary_mismatch"
  | "claim_unissued_question"
  | "claim_question_mismatch"
  | "claim_ambiguous"
  | "claim_denied"
  | "claim_limit_exceeded"
  | "claim_identity_mismatch"
  | "claim_order_mismatch";

export type ConfirmationClaimResult =
  | { readonly kind: "none"; readonly transcript?: ReviewerTranscript }
  | { readonly kind: "awaiting" }
  | { readonly kind: "unavailable"; readonly code: ConfirmationClaimUnavailableCode }
  | { readonly kind: "rejected"; readonly code: ConfirmationClaimRejectionCode }
  | { readonly kind: "claimed"; readonly claim: AuthorizationClaim };

export type ConfirmationQuestionEventResult =
  | { readonly kind: "ignored" }
  | { readonly kind: "recorded" }
  | { readonly kind: "rejected"; readonly code: "event_order_mismatch" | "event_identity_mismatch" | "event_payload_mismatch" };

export type ConfirmationCheckUnavailableCode = "check_timeout" | "check_sdk_error" | "check_malformed";
export type ConfirmationCheckRejectionCode =
  | "check_confirmation_disposed" | "check_expired" | "check_limit_exceeded" | "check_identity_mismatch"
  | "check_order_mismatch" | "check_boundary_mismatch" | "check_invalid_user_message"
  | "check_ambiguous_suffix" | "check_phrase_mismatch" | "check_token_mismatch";
export type ConfirmationCheckResult =
  | { readonly kind: "none" }
  | { readonly kind: "awaiting" }
  | { readonly kind: "unavailable"; readonly code: ConfirmationCheckUnavailableCode }
  | { readonly kind: "rejected"; readonly code: ConfirmationCheckRejectionCode }
  | { readonly kind: "confirmed"; readonly proof: { readonly status: "confirmed"; readonly effect_sha256: string; readonly disclosure_sha256: string }; readonly transcript: ReviewerTranscript };

export const classifyIssueFailure = (
  reason: TranscriptUnavailableReason,
): ConfirmationIssueFailureCode => {
  switch (reason) {
    case "timeout":
      return "issue_timeout";
    case "sdk_error":
      return "issue_sdk_error";
    case "malformed":
      return "issue_malformed";
    case "limit_exceeded":
      return "issue_limit_exceeded";
    case "identity_mismatch":
      return "issue_identity_mismatch";
    case "order_mismatch":
      return "issue_order_mismatch";
  }
};

export const classifyClaimFailure = (
  reason: TranscriptUnavailableReason,
): Extract<ConfirmationClaimResult, { readonly kind: "unavailable" | "rejected" }> => {
  switch (reason) {
    case "timeout":
      return { kind: "unavailable", code: "claim_timeout" };
    case "sdk_error":
      return { kind: "unavailable", code: "claim_sdk_error" };
    case "malformed":
      return { kind: "unavailable", code: "claim_malformed" };
    case "limit_exceeded":
      return { kind: "rejected", code: "claim_limit_exceeded" };
    case "identity_mismatch":
      return { kind: "rejected", code: "claim_identity_mismatch" };
    case "order_mismatch":
      return { kind: "rejected", code: "claim_order_mismatch" };
  }
};

type DirectCandidate = Extract<AuthorizationCandidate, { readonly kind: "direct_user" }>;
export type PendingEvidenceResult =
  | { readonly kind: "awaiting"; readonly question?: PendingQuestionState }
  | { readonly kind: "rejected"; readonly code: "claim_boundary_mismatch" | "claim_unissued_question" | "claim_question_mismatch" | "claim_ambiguous" | "claim_call_mismatch"; readonly question?: PendingQuestionState }
  | { readonly kind: "available"; readonly source: AuthorizationClaimSource; readonly question?: PendingQuestionState };
const directCandidate = (context: AuthorizationContext): DirectCandidate | undefined => {
  const candidates = context.snapshot.authorizationCandidates.filter((candidate) => candidate.kind === "direct_user");
  return candidates.length === 1 ? candidates[0] : undefined;
};
export const promptAuthorizationSource = (
  context: AuthorizationContext,
): Extract<AuthorizationClaimSource, { readonly kind: "prompt" }> | undefined => {
  const candidate = directCandidate(context);
  return candidate ? Object.freeze({ kind: "prompt", candidate, deterministicAuthorization: false }) : undefined;
};
const fallbackSource = (
  pending: PendingAuthorization,
  context: AuthorizationContext,
  candidate: DirectCandidate,
): Extract<PendingEvidenceResult, { readonly kind: "available" | "rejected" }> => {
  const users = context.snapshot.authorizationMessages.filter(
    (message) => message.responsePosition > pending.boundary.challengeResponsePosition,
  );
  return users.length !== 1 || users[0]?.messageID !== candidate.source.messageID
    || candidate.source.responsePosition <= pending.boundary.challengeResponsePosition
    ? { kind: "rejected", code: "claim_ambiguous" }
    : { kind: "available", source: Object.freeze({ kind: "fallback", candidate, deterministicAuthorization: false }) };
};
export const pendingAuthorizationEvidence = (
  pending: PendingAuthorization,
  context: AuthorizationContext,
  currentCall: Readonly<{ readonly callID: string; readonly tool: string; readonly effectSha256: string }>,
): PendingEvidenceResult => {
  const candidate = directCandidate(context);
  if (currentCall.callID === pending.boundary.blockedCallID || currentCall.effectSha256 !== pending.effectSha256) {
    return { kind: "rejected", code: "claim_call_mismatch" };
  }
  const currentMatches = context.entries.flatMap((entry, responsePosition) => entry.parts.flatMap((part) =>
    part.type === "tool" && part.callID === currentCall.callID && part.tool === currentCall.tool ? [{ responsePosition }] : []));
  const currentPosition = currentMatches[0]?.responsePosition;
  if (currentMatches.length !== 1 || currentPosition === undefined) return { kind: "rejected", code: "claim_call_mismatch" };
  const challenge = context.entries[pending.boundary.challengeResponsePosition];
  const blockedPart = challenge?.parts[pending.boundary.blockedPartPosition];
  if (!challenge || challenge.info.role !== "assistant" || challenge.info.id !== pending.boundary.challengeMessageID
    || challenge.info.time.created !== pending.boundary.challengeCreated || !blockedPart || blockedPart.type !== "tool"
    || blockedPart.id !== pending.boundary.blockedPartID || blockedPart.callID !== pending.boundary.blockedCallID) {
    return { kind: "rejected", code: "claim_boundary_mismatch" };
  }
  const questionParts: { readonly responsePosition: number; readonly partPosition: number }[] = [];
  for (let responsePosition = pending.boundary.challengeResponsePosition + 1;
    responsePosition < currentPosition; responsePosition += 1) {
    const entry = context.entries[responsePosition];
    if (!entry || entry.info.role !== "assistant" || entry.info.summary === true) continue;
    for (const [partPosition, part] of entry.parts.entries()) {
      if (part.type === "tool" && part.tool === "question") questionParts.push({ responsePosition, partPosition });
    }
  }
  if (questionParts.length > 1) return { kind: "rejected", code: "claim_ambiguous" };
  const located = questionParts[0];
  const questionEntry = located ? context.entries[located.responsePosition] : undefined;
  const questionPart = located ? questionEntry?.parts[located.partPosition] : undefined;
  switch (pending.question.kind) {
    case "waiting": return located ? { kind: "rejected", code: "claim_unissued_question" } : { kind: "awaiting" };
    case "terminal": return { kind: "rejected", code: "claim_question_mismatch" };
    case "asked": {
      if (!located || !questionEntry || !questionPart) return { kind: "awaiting" };
      if (questionEntry.info.id !== pending.question.questionMessageID || questionPart.type !== "tool"
        || questionPart.callID !== pending.question.questionCallID) return { kind: "rejected", code: "claim_question_mismatch" };
      if (questionPart.state.status !== "error") return questionPart.state.status === "completed"
        ? { kind: "rejected", code: "claim_unissued_question" } : { kind: "awaiting" };
      if (!candidate) return { kind: "rejected", code: "claim_call_mismatch" };
      const question = Object.freeze({ ...pending.question, kind: "fallback" as const, reason: "error" as const });
      return { ...fallbackSource(pending, context, candidate), question };
    }
    case "fallback":
      return !located || !questionEntry || !questionPart || questionEntry.info.id !== pending.question.questionMessageID
        || questionPart.type !== "tool" || questionPart.callID !== pending.question.questionCallID
        ? { kind: "rejected", code: "claim_question_mismatch" }
        : candidate ? fallbackSource(pending, context, candidate) : { kind: "rejected", code: "claim_call_mismatch" };
    case "replied": {
      if (!located || !questionEntry || !questionPart) return { kind: "awaiting" };
      if (questionEntry.info.id !== pending.question.questionMessageID || questionPart.type !== "tool"
        || questionPart.callID !== pending.question.questionCallID) return { kind: "rejected", code: "claim_question_mismatch" };
      if (questionPart.state.status !== "completed") return { kind: "awaiting" };
      const scope = createQuestionAuthorizationScope({
        parentSessionID: pending.parentSessionID, generation: pending.generation,
        blockedCallID: pending.boundary.blockedCallID, blockedPartID: pending.boundary.blockedPartID,
        blockedPartPosition: pending.boundary.blockedPartPosition, retryCallID: currentCall.callID,
        currentEffectSha256: pending.effectSha256, disclosureSha256: pending.disclosureSha256,
        questionPayloadDigest: pending.questionPayloadDigest, challengeMessageID: pending.boundary.challengeMessageID,
        challengeCreated: pending.boundary.challengeCreated,
        challengeResponsePosition: pending.boundary.challengeResponsePosition,
        questionMessageID: pending.question.questionMessageID, questionCreated: questionEntry.info.time.created,
        questionResponsePosition: located.responsePosition, questionPartID: questionPart.id,
        questionPartPosition: located.partPosition, questionCallID: pending.question.questionCallID,
      });
      if (!scope) return { kind: "rejected", code: "claim_question_mismatch" };
      const scoped = projectAuthorizationCandidates({
        entries: context.entries,
        parentSessionID: pending.parentSessionID,
        currentCall,
        questionAuthorizationScope: scope,
      });
      if (!scoped.ok) return { kind: "rejected", code: "claim_question_mismatch" };
      const questions = scoped.candidates.filter((item) => item.kind === "question_answer");
      const question = questions[0];
      if (questions.length !== 1 || !question || question.payloadDigest !== pending.questionPayloadDigest
        || JSON.stringify(question.answers) !== JSON.stringify(pending.question.answers)
        || question.answers.length !== 1 || question.answers[0]?.length !== 1) {
        return { kind: "rejected", code: "claim_question_mismatch" };
      }
      const answer = question.answers[0]?.[0];
      return answer === undefined ? { kind: "rejected", code: "claim_question_mismatch" } : {
        kind: "available",
        source: Object.freeze({ kind: "question", candidate: question, scope,
          questionRequestID: pending.question.questionRequestID, answer,
          deterministicAuthorization: answer === "Authorize once" }),
      };
    }
  }
};
