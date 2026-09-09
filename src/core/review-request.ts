import type { TirithScan } from "./risk-tool";
import type { AuthorizationClaimSource } from "./confirmation-ledger";
import type { NormalizedQuestion, ReviewerTranscript } from "./transcript-types";
import type { CommandContext, RuleEvaluation, ShellAnalysis } from "./types";
import { projectReviewShellAnalysis, type ReviewShellAnalysis } from "./review-shell-dto";
import { stableJsonStringify, toStableJsonValue, type JsonValue } from "./stable-json";

export const MAX_REVIEW_REQUEST_UTF8_BYTES = 131_072;
export const MAX_REVIEW_AUTHORIZATION_CANDIDATE_UTF8_BYTES = 32_768;

class ReviewRequestInvariantError extends Error {
  readonly name = "ReviewRequestInvariantError";
}

const assertNever = (value: never): never => {
  void value;
  throw new ReviewRequestInvariantError("unreachable authorization source");
};

type ReviewAuthorizationSourceIdentity = {
  readonly session_id: string;
  readonly message_id: string;
  readonly created: number;
  readonly response_position: number;
  readonly part_id: string;
  readonly part_position: number;
};

type ReviewAuthorizationCurrentIdentity = ReviewAuthorizationSourceIdentity & {
  readonly call_id: string;
  readonly tool: string;
  readonly effect_sha256: string;
};

type ReviewAuthorizationHostValidation = {
  readonly status: "claimed";
  readonly review_attempt_id: string;
  readonly parent_session_id: string;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly freshness: "current_turn";
  readonly lifecycle: "active_one_shot_claim";
  readonly effect: "current_effect_equal";
  readonly semantic_judgment: "configured_reviewer_model";
};

type NaturalLanguageAuthorizationCandidate = {
  readonly source: "prompt" | "fallback";
  readonly provenance: "ordinary_parent_user";
  readonly host_validation: ReviewAuthorizationHostValidation;
  readonly source_identity: ReviewAuthorizationSourceIdentity;
  readonly current_identity: ReviewAuthorizationCurrentIdentity;
  readonly evidence: { readonly kind: "natural_language"; readonly text: string };
};

type QuestionAuthorizationCandidate = {
  readonly source: "question";
  readonly provenance: "server_issued_parent_question";
  readonly host_validation: ReviewAuthorizationHostValidation;
  readonly source_identity: ReviewAuthorizationSourceIdentity & { readonly call_id: string };
  readonly current_identity: ReviewAuthorizationCurrentIdentity;
  readonly question_request_id: string;
  readonly disclosure_sha256: string;
  readonly question_payload_sha256: string;
  readonly question_integrity: "issued_payload_equal" | "issued_payload_and_answer_equal";
  readonly evidence: {
    readonly kind: "issued_question_answer";
    readonly questions: readonly NormalizedQuestion[];
    readonly answers: readonly (readonly string[])[];
    readonly selected_answer: string;
  };
};

export type ReviewAuthorizationCandidate = NaturalLanguageAuthorizationCandidate | QuestionAuthorizationCandidate;

export type SerializeReviewRequestInput = {
  readonly context: CommandContext;
  readonly shellAnalysis: ShellAnalysis;
  readonly evaluation: RuleEvaluation;
  readonly tirith: TirithScan;
  readonly transcript: ReviewerTranscript;
  readonly authorizationCandidate?: ReviewAuthorizationCandidate;
};

export type CreateReviewAuthorizationCandidateInput = {
  readonly reviewAttemptID: string;
  readonly parentSessionID: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly source: AuthorizationClaimSource;
};

const sourceIdentity = (source: AuthorizationClaimSource["candidate"]["source"]): ReviewAuthorizationSourceIdentity => ({
  session_id: source.sessionID,
  message_id: source.messageID,
  created: source.created,
  response_position: source.responsePosition,
  part_id: source.partID,
  part_position: source.partPosition,
});

const currentIdentity = (source: AuthorizationClaimSource): ReviewAuthorizationCurrentIdentity => ({
  ...sourceIdentity(source.candidate.current),
  call_id: source.candidate.current.callID,
  tool: source.candidate.current.tool,
  effect_sha256: source.candidate.current.effectSha256,
});

export const createReviewAuthorizationCandidate = (
  input: CreateReviewAuthorizationCandidateInput,
): ReviewAuthorizationCandidate => {
  const hostValidation = {
    status: "claimed",
    review_attempt_id: input.reviewAttemptID,
    parent_session_id: input.parentSessionID,
    issued_at: input.issuedAt,
    expires_at: input.expiresAt,
    freshness: "current_turn",
    lifecycle: "active_one_shot_claim",
    effect: "current_effect_equal",
    semantic_judgment: "configured_reviewer_model",
  } as const;
  switch (input.source.kind) {
    case "prompt":
    case "fallback":
      return Object.freeze({
        source: input.source.kind,
        provenance: "ordinary_parent_user",
        host_validation: Object.freeze(hostValidation),
        source_identity: Object.freeze(sourceIdentity(input.source.candidate.source)),
        current_identity: Object.freeze(currentIdentity(input.source)),
        evidence: Object.freeze({ kind: "natural_language", text: input.source.candidate.text }),
      });
    case "question":
      return Object.freeze({
        source: "question",
        provenance: "server_issued_parent_question",
        host_validation: Object.freeze(hostValidation),
        source_identity: Object.freeze({
          ...sourceIdentity(input.source.candidate.source),
          call_id: input.source.candidate.source.callID,
        }),
        current_identity: Object.freeze(currentIdentity(input.source)),
        question_request_id: input.source.questionRequestID,
        disclosure_sha256: input.source.scope.disclosureSha256,
        question_payload_sha256: input.source.scope.questionPayloadDigest,
        question_integrity: input.source.deterministicAuthorization
          ? "issued_payload_and_answer_equal"
          : "issued_payload_equal",
        evidence: Object.freeze({
          kind: "issued_question_answer",
          questions: input.source.candidate.questions,
          answers: input.source.candidate.answers,
          selected_answer: input.source.answer,
        }),
      });
    default:
      return assertNever(input.source);
  }
};

export type SerializedReviewRequest =
  | { readonly ok: true; readonly json: string }
  | { readonly ok: false; readonly code: "invalid_json" | "limit_exceeded" };

type ReviewRequestDto = {
  readonly schema_version: 1;
  readonly command: string;
  readonly cwd: string;
  readonly args: JsonValue;
  readonly shell_analysis: ReviewShellAnalysis;
  readonly rule_evaluation: {
    readonly categories: readonly { readonly id: string; readonly score: number }[];
    readonly reasons: readonly string[];
    readonly matched_labels: readonly string[];
  };
  readonly tirith: JsonValue;
  readonly transcript: JsonValue;
  readonly authorization_candidates: readonly ReviewAuthorizationCandidate[];
};

const tirithDto = (value: TirithScan): Record<string, unknown> => {
  const shared = {
    action: value.action,
    ...(value.freshness === undefined ? {} : { freshness: value.freshness }),
    ...(value.categories === undefined ? {} : { categories: value.categories }),
    ...(value.reasons === undefined ? {} : { reasons: value.reasons }),
  };
  return value.action === "allow"
    ? shared
    : {
        ...shared,
        risk_level: value.riskLevel,
        ...(value.action === "block" ? { source: value.source } : {}),
      };
};

export const serializeReviewRequest = (
  input: SerializeReviewRequestInput,
): SerializedReviewRequest => {
  const args = toStableJsonValue(input.context.args);
  const tirith = toStableJsonValue(tirithDto(input.tirith));
  const transcript = toStableJsonValue(input.transcript);
  if (!args.ok || !tirith.ok || !transcript.ok) return { ok: false, code: "invalid_json" };
  const authorizationCandidates = input.authorizationCandidate === undefined
    ? Object.freeze([])
    : Object.freeze([input.authorizationCandidate]);
  const serializedCandidates = stableJsonStringify(authorizationCandidates);
  if (!serializedCandidates.ok) return serializedCandidates;
  if (new TextEncoder().encode(serializedCandidates.value).byteLength > MAX_REVIEW_AUTHORIZATION_CANDIDATE_UTF8_BYTES) {
    return { ok: false, code: "limit_exceeded" };
  }
  let shellAnalysis: ReviewShellAnalysis;
  try {
    shellAnalysis = projectReviewShellAnalysis(input.shellAnalysis);
  } catch (error) {
    if (error instanceof Error) return { ok: false, code: "invalid_json" };
    return { ok: false, code: "invalid_json" };
  }
  const dto: ReviewRequestDto = {
    schema_version: 1,
    command: input.context.command,
    cwd: input.context.cwd,
    args: args.value,
    shell_analysis: shellAnalysis,
    rule_evaluation: {
      categories: input.evaluation.categories.map((category) => ({ id: category.id, score: category.score })),
      reasons: [...input.evaluation.reasons],
      matched_labels: input.evaluation.matchedRules.map((rule) => rule.label),
    },
    tirith: tirith.value,
    transcript: transcript.value,
    authorization_candidates: authorizationCandidates,
  };
  const serialized = stableJsonStringify(dto);
  if (!serialized.ok) return serialized;
  if (new TextEncoder().encode(serialized.value).byteLength > MAX_REVIEW_REQUEST_UTF8_BYTES) {
    return { ok: false, code: "limit_exceeded" };
  }
  return { ok: true, json: serialized.value };
};
