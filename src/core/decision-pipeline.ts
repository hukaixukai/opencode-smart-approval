import { evaluationWithTirithScan, scanWithTirith, verdictFromTirithScan } from "./risk-tool";
import { evaluateRulesFromAnalysis } from "./rules";
import { reviewDecisionWithContext, reviewDirectoriesMatch } from "./session-context";
import type { ApprovalVerdict, CommandContext, ResolvedPolicy, ReviewResponse, RuleEvaluation, ShellAnalysis } from "./types";
import { verdictFromReview, verdictFromRules } from "./verdict";
import { createMonotonicDeadline } from "./bounded-race";
import { failClosedOpenCodeReview, type OpenCodeReviewerRuntime } from "./opencode-reviewer";
import { createCommandEffect, createCurrentCommandEffect, type CurrentCommandEffectResult } from "./command-effect";
import type { AuthorizationClaim, ConfirmationService } from "./confirmation-service";
import type { ReviewAuthorizationCandidate } from "./review-request";
import type { ReviewerTranscript, TranscriptSnapshot } from "./transcript-types";

export const TRANSCRIPT_CALL_TIMEOUT_MS = 2_000;

type DecisionPipelineInput = Readonly<{
  policy: ResolvedPolicy; context: CommandContext; currentCallID?: string;
  reviewerRuntime: OpenCodeReviewerRuntime | undefined; analysis: ShellAnalysis;
  forceReview: boolean; confirmationService?: ConfirmationService;
}>;

const terminalRuleVerdict = (evaluation: RuleEvaluation): ApprovalVerdict | undefined => {
  if (evaluation.matchedRules.length === 0) return undefined;
  return verdictFromRules(evaluation);
};

class DecisionPipelineInvariantError extends Error { readonly name = "DecisionPipelineInvariantError"; }

const assertNever = (value: never): never => { void value; throw new DecisionPipelineInvariantError("unreachable decision pipeline variant"); };

const inconsistentReview = (review: ReviewResponse): ReviewResponse => ({
  ...failClosedOpenCodeReview("inconsistent_verdict"), riskLevel: review.riskLevel,
});

export const applyReviewAuthorizationConsistency = (input: Readonly<{
  review: ReviewResponse; authorizationCandidate: ReviewAuthorizationCandidate | undefined;
}>): ReviewResponse => {
  const review = { ...input.review, userAuthorization: input.authorizationCandidate ? input.review.userAuthorization : "unknown" };
  switch (review.outcome) {
    case "deny":
    case "needs_confirmation": return review;
    case "allow":
      switch (review.riskLevel) {
        case "low":
        case "medium": return review;
        case "high": return review.userAuthorization === "medium" || review.userAuthorization === "high"
            ? review
            : inconsistentReview(review);
        case "critical": return inconsistentReview(review);
        default: return assertNever(review.riskLevel);
      }
    default: return assertNever(review);
  }
};

export const currentReviewAuthorizationCandidate = (
  claim: AuthorizationClaim | undefined, effect: Extract<CurrentCommandEffectResult, { readonly ok: true }>,
): ReviewAuthorizationCandidate | undefined => {
  if (!claim) return undefined;
  const candidate = claim.authorizationCandidate;
  const source = claim.source.candidate.source;
  const current = claim.source.candidate.current;
  if (
    claim.parentSessionID !== effect.effect.parentSessionID || claim.callID !== effect.effect.currentCallID || claim.effectSha256 !== effect.sha256
    || candidate.source !== claim.source.kind || candidate.host_validation.review_attempt_id !== claim.reviewAttemptID
    || candidate.host_validation.parent_session_id !== effect.effect.parentSessionID || candidate.host_validation.issued_at !== claim.issuedAt
    || candidate.host_validation.expires_at !== claim.expiresAt || source.sessionID !== effect.effect.parentSessionID
    || candidate.source_identity.session_id !== source.sessionID || candidate.source_identity.message_id !== source.messageID
    || candidate.source_identity.created !== source.created || candidate.source_identity.response_position !== source.responsePosition
    || candidate.source_identity.part_id !== source.partID || candidate.source_identity.part_position !== source.partPosition
    || candidate.current_identity.session_id !== effect.effect.parentSessionID || candidate.current_identity.message_id !== current.messageID
    || candidate.current_identity.created !== current.created || candidate.current_identity.response_position !== current.responsePosition
    || candidate.current_identity.part_id !== current.partID || candidate.current_identity.part_position !== current.partPosition
    || candidate.current_identity.call_id !== effect.effect.currentCallID || candidate.current_identity.tool !== effect.effect.handledTool
    || candidate.current_identity.effect_sha256 !== effect.sha256
  ) return undefined;
  switch (claim.source.kind) {
    case "prompt":
    case "fallback":
      return candidate.evidence.kind === "natural_language"
        && candidate.evidence.text === claim.source.candidate.text
        ? candidate
        : undefined;
    case "question":
      return candidate.source === "question"
        && claim.source.scope.parentSessionID === effect.effect.parentSessionID && claim.source.scope.retryCallID === effect.effect.currentCallID
        && claim.source.scope.currentEffectSha256 === effect.sha256 && candidate.source_identity.call_id === claim.source.candidate.source.callID
        && candidate.question_request_id === claim.source.questionRequestID && candidate.disclosure_sha256 === claim.source.scope.disclosureSha256
        && candidate.question_payload_sha256 === claim.source.scope.questionPayloadDigest
        && candidate.question_integrity === (claim.source.deterministicAuthorization
          ? "issued_payload_and_answer_equal"
          : "issued_payload_equal")
        && candidate.evidence.questions === claim.source.candidate.questions && candidate.evidence.answers === claim.source.candidate.answers
        && candidate.evidence.selected_answer === claim.source.answer
        ? candidate
        : undefined;
    default:
      return assertNever(claim.source);
  }
};

export const resolveCommandVerdict = async (
  { policy, context, currentCallID, reviewerRuntime, analysis, forceReview, confirmationService }: DecisionPipelineInput,
): Promise<ApprovalVerdict> => {
  if (reviewerRuntime && !reviewDirectoriesMatch(context.cwd, reviewerRuntime.directory)) {
    return verdictFromReview(failClosedOpenCodeReview("directory_mismatch"), {
      decision: "review", matchedRules: [], categories: [], reasons: [],
    });
  }
  const currentEffect = currentCallID === undefined
    ? undefined
    : createCurrentCommandEffect({ context, analysis, currentCallID });
  const effect = currentEffect ?? createCommandEffect({ context, analysis });
  if (!effect.ok) {
    return verdictFromReview(failClosedOpenCodeReview("invalid_effect"), {
      decision: "review", matchedRules: [], categories: [], reasons: [],
    });
  }
  const deadline = createMonotonicDeadline(policy.review.timeoutMs);
  let claimedAuthorizationCandidate: ReviewAuthorizationCandidate | undefined;
  let claimedTranscript: ReviewerTranscript | undefined;
  let activeClaim: AuthorizationClaim | undefined; let legacyConfirmed = false;
  const stateConfirmation = currentEffect?.ok && confirmationService && "claim" in confirmationService ? confirmationService : undefined;
  const legacyConfirmation = !("currentCallID" in effect.effect) && confirmationService && "check" in confirmationService ? confirmationService : undefined;
  if (stateConfirmation && currentEffect?.ok) {
    const confirmation = await stateConfirmation.claim({ effect: currentEffect, deadline });
    switch (confirmation.kind) {
      case "none":
        claimedTranscript = confirmation.transcript;
        break;
      case "claimed":
        activeClaim = confirmation.claim;
        claimedAuthorizationCandidate = confirmation.claim.expiresAt > deadline.now()
          ? currentReviewAuthorizationCandidate(confirmation.claim, currentEffect)
          : undefined;
        claimedTranscript = confirmation.claim.transcript;
        break;
      case "awaiting":
        return verdictFromReview(failClosedOpenCodeReview("awaiting_explicit_confirmation"), { decision: "review", matchedRules: [], categories: [], reasons: [] });
      case "unavailable":
      case "rejected":
        return verdictFromReview(failClosedOpenCodeReview(confirmation.code), { decision: "review", matchedRules: [], categories: [], reasons: [] });
      default:
        break;
    }
  } else if (legacyConfirmation) {
    const confirmation = await legacyConfirmation.check({ effect, deadline });
    if (confirmation.kind === "confirmed") { legacyConfirmed = true; claimedTranscript = confirmation.transcript; }
    else if (confirmation.kind === "awaiting") return verdictFromReview(failClosedOpenCodeReview("awaiting_explicit_confirmation"), { decision: "review", matchedRules: [], categories: [], reasons: [] });
    else if (confirmation.kind === "unavailable" || confirmation.kind === "rejected") return verdictFromReview(failClosedOpenCodeReview(confirmation.code), { decision: "review", matchedRules: [], categories: [], reasons: [] });
  }
  try {
    const forcedReview = forceReview || activeClaim !== undefined || legacyConfirmed;
    if (activeClaim && !stateConfirmation?.observe(activeClaim, "user_rule")) {
      return verdictFromReview(failClosedOpenCodeReview("authorization_claim_inactive"), {
        decision: "review", matchedRules: [], categories: [], reasons: [],
      });
    }
    const userRules = policy.rules.filter((rule) => rule.origin === "user");
    const builtinRules = policy.rules.filter((rule) => rule.origin === "builtin");
    const userEvaluation = evaluateRulesFromAnalysis(userRules, context.command, analysis);
    const userVerdict = terminalRuleVerdict(userEvaluation);
    if (userVerdict && (userVerdict.decision === "block" || !forcedReview)) return userVerdict;

    let claimedBuiltinEvaluation: RuleEvaluation | undefined;
    if (activeClaim) {
      if (!stateConfirmation?.observe(activeClaim, "builtin_rule")) {
        return verdictFromReview(failClosedOpenCodeReview("authorization_claim_inactive"), userEvaluation);
      }
      claimedBuiltinEvaluation = evaluateRulesFromAnalysis(builtinRules, context.command, analysis);
      const builtinVerdict = terminalRuleVerdict(claimedBuiltinEvaluation);
      if (builtinVerdict?.decision === "block") return builtinVerdict;
    }

    let evaluation: RuleEvaluation = forcedReview
      ? {
          decision: "review",
          matchedRules: [...userEvaluation.matchedRules, ...(claimedBuiltinEvaluation?.matchedRules ?? [])],
          categories: [
            ...userEvaluation.categories,
            ...(claimedBuiltinEvaluation?.categories ?? []),
            { id: forceReview
              ? "security.config_self_protection_ambiguous_mutation"
              : "security.explicit_authorization_claimed", score: 0.8 },
          ],
          reasons: [...userEvaluation.reasons, ...(claimedBuiltinEvaluation?.reasons ?? []), forceReview
            ? "approval configuration mutation cannot be ruled out"
            : "one-shot authorization evidence is claimed for this command effect"],
        }
      : userEvaluation;
    if (!forcedReview && userEvaluation.matchedRules.length === 0 && userEvaluation.reasons.length === 0) {
      if (activeClaim && !stateConfirmation?.observe(activeClaim, "builtin_rule")) {
        return verdictFromReview(failClosedOpenCodeReview("authorization_claim_inactive"), userEvaluation);
      }
      const builtinEvaluation = evaluateRulesFromAnalysis(builtinRules, context.command, analysis);
      const builtinVerdict = terminalRuleVerdict(builtinEvaluation);
      if (builtinVerdict) return builtinVerdict;
      evaluation = builtinEvaluation;
    }

    if (activeClaim && !stateConfirmation?.observe(activeClaim, "tirith")) {
      return verdictFromReview(failClosedOpenCodeReview("authorization_claim_inactive"), evaluation);
    }
    const tirithScan = await scanWithTirith(policy, context);
    const tirithVerdict = verdictFromTirithScan(tirithScan);
    if (tirithVerdict) return tirithVerdict;

    const reviewEvaluation = evaluationWithTirithScan(evaluation, tirithScan);
    const modelReview = await reviewDecisionWithContext({
      deadline,
      timeoutMs: TRANSCRIPT_CALL_TIMEOUT_MS,
      reviewerRuntime,
      context,
      currentCall: currentCallID === undefined ? undefined : {
        callID: currentCallID, tool: context.tool, effectSha256: effect.sha256,
      },
      shellAnalysis: analysis,
      evaluation: reviewEvaluation,
      tirith: tirithScan,
      contextMessages: policy.review.contextMessages,
      claimedTranscript,
      authorizationCandidate: claimedAuthorizationCandidate,
      cleanupEnabled: policy.review.cleanupSession,
    });
    if (activeClaim && !stateConfirmation?.observe(activeClaim, "reviewer")) {
      return verdictFromReview(failClosedOpenCodeReview("authorization_claim_inactive"), reviewEvaluation);
    }
    const currentAuthorizationCandidate = currentEffect?.ok
      ? currentReviewAuthorizationCandidate(
          activeClaim !== undefined && activeClaim.expiresAt > deadline.now() && stateConfirmation?.observe(activeClaim, "reviewer") ? activeClaim : undefined,
          currentEffect,
        )
      : undefined;
    const review = applyReviewAuthorizationConsistency({
      review: modelReview,
      authorizationCandidate: currentAuthorizationCandidate,
    });
    if (review.outcome !== "needs_confirmation") return verdictFromReview(review, reviewEvaluation);
    if (activeClaim?.source.kind === "prompt" && confirmationService && stateConfirmation) {
      stateConfirmation.finish(activeClaim);
      activeClaim = undefined;
      if (!currentEffect?.ok) return verdictFromReview(failClosedOpenCodeReview("confirmation_not_accepted"), reviewEvaluation);
      const issued = await stateConfirmation.issue({ effect: currentEffect, review, tool: context.tool, deadline });
      if (issued.kind === "error") throw issued.error;
      return verdictFromReview(failClosedOpenCodeReview(issued.code), reviewEvaluation);
    }
    if (claimedAuthorizationCandidate !== undefined || legacyConfirmed || !confirmationService) {
      return verdictFromReview(failClosedOpenCodeReview("confirmation_not_accepted"), reviewEvaluation);
    }
    if (stateConfirmation) {
      if (!currentEffect?.ok) return verdictFromReview(failClosedOpenCodeReview("confirmation_not_accepted"), reviewEvaluation);
      const issued = await stateConfirmation.issue({ effect: currentEffect, review, tool: context.tool, deadline });
      if (issued.kind === "error") throw issued.error;
      return verdictFromReview(failClosedOpenCodeReview(issued.code), reviewEvaluation);
    }
    if (!legacyConfirmation) return verdictFromReview(failClosedOpenCodeReview("confirmation_not_accepted"), reviewEvaluation);
    const issued = await legacyConfirmation.issue({ effect, review, tool: context.tool, deadline }); if (issued.kind === "error") throw issued.error;
    return verdictFromReview(failClosedOpenCodeReview(issued.code), reviewEvaluation);
  } finally {
    if (activeClaim) stateConfirmation?.finish(activeClaim);
  }
};
