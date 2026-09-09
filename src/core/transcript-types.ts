export const MAX_TRANSCRIPT_ENVELOPE_UTF8_BYTES = 262_144;
export const MAX_TRANSCRIPT_TEXT_CHARS_PER_PART = 2_000;
export const MAX_TRANSCRIPT_TOTAL_CHARS = 20_000;
export const MAX_TRANSCRIPT_PARTS_PER_MESSAGE = 32;
export const MAX_TRANSCRIPT_TOTAL_PARTS = 256;
export const MAX_TRANSCRIPT_TOOL_NAME_CHARS = 128;
export const MAX_AUTHORIZATION_CANDIDATES = 16;
export const MAX_AUTHORIZATION_CANDIDATES_UTF8_BYTES = 32_768;
export const MAX_QUESTION_COUNT = 8;
export const MAX_QUESTION_OPTIONS_PER_QUESTION = 16;
export const MAX_QUESTION_ANSWERS_PER_QUESTION = 16;
export const MAX_QUESTION_HEADER_CHARS = 128;
export const MAX_QUESTION_TEXT_CHARS = 2_000;
export const MAX_QUESTION_OPTION_LABEL_CHARS = 256;
export const MAX_QUESTION_OPTION_DESCRIPTION_CHARS = 1_000;
export const MAX_QUESTION_ANSWER_CHARS = 1_000;
export const MAX_QUESTION_PAYLOAD_UTF8_BYTES = 16_384;

export type TranscriptUnavailableReason =
  | "timeout"
  | "sdk_error"
  | "identity_mismatch"
  | "order_mismatch"
  | "malformed"
  | "limit_exceeded";

export type ReviewerTranscriptPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool";
      readonly name: string;
      readonly status: "completed" | "error" | "pending" | "running";
    };

export type ReviewerTranscriptMessage = {
  readonly role: "user" | "assistant";
  readonly parts: readonly ReviewerTranscriptPart[];
};

export type ReviewerTranscript =
  | { readonly status: "available"; readonly messages: readonly ReviewerTranscriptMessage[] }
  | { readonly status: "disabled" }
  | { readonly status: "unavailable"; readonly reason: TranscriptUnavailableReason };

export type AuthorizationMessage = {
  readonly messageID: string;
  readonly sessionID: string;
  readonly created: number;
  readonly responsePosition: number;
  readonly text: string;
};

export type AuthorizationSourceIdentity = {
  readonly sessionID: string;
  readonly messageID: string;
  readonly created: number;
  readonly responsePosition: number;
  readonly partID: string;
  readonly partPosition: number;
};

// Todo 4's trusted confirmation ledger is the sole production producer; transcript payloads never construct this scope.
export type QuestionAuthorizationScopeInput = {
  readonly parentSessionID: string;
  readonly generation: number;
  readonly blockedCallID: string;
  readonly blockedPartID: string;
  readonly blockedPartPosition: number;
  readonly retryCallID: string;
  readonly currentEffectSha256: string;
  readonly disclosureSha256: string;
  readonly questionPayloadDigest: string;
  readonly challengeMessageID: string;
  readonly challengeCreated: number;
  readonly challengeResponsePosition: number;
  readonly questionMessageID: string;
  readonly questionCreated: number;
  readonly questionResponsePosition: number;
  readonly questionPartID: string;
  readonly questionPartPosition: number;
  readonly questionCallID: string;
};

const questionAuthorizationScopeBrand: unique symbol = Symbol("QuestionAuthorizationScope");
export type QuestionAuthorizationScope = QuestionAuthorizationScopeInput & {
  readonly [questionAuthorizationScopeBrand]: true;
};

const SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const issuedScopes = new WeakSet<QuestionAuthorizationScope>();
const SCOPE_KEYS: ReadonlySet<string> = new Set([
  "parentSessionID", "generation", "blockedCallID", "blockedPartID", "blockedPartPosition",
  "retryCallID", "currentEffectSha256", "disclosureSha256", "questionPayloadDigest",
  "challengeMessageID", "challengeCreated", "challengeResponsePosition", "questionMessageID",
  "questionCreated", "questionResponsePosition", "questionPartID", "questionPartPosition", "questionCallID",
] as const);
const isPosition = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

export const createQuestionAuthorizationScope = (
  input: QuestionAuthorizationScopeInput,
): QuestionAuthorizationScope | undefined => {
  const keys = Object.keys(input);
  if (
    keys.length !== SCOPE_KEYS.size || keys.some((key) => !SCOPE_KEYS.has(key))
    || !SOURCE_ID.test(input.parentSessionID) || !SOURCE_ID.test(input.blockedCallID)
    || !SOURCE_ID.test(input.blockedPartID) || !SOURCE_ID.test(input.retryCallID)
    || !SOURCE_ID.test(input.challengeMessageID) || !SOURCE_ID.test(input.questionMessageID)
    || !SOURCE_ID.test(input.questionPartID) || !SOURCE_ID.test(input.questionCallID)
    || !SHA256_HEX.test(input.currentEffectSha256) || !SHA256_HEX.test(input.disclosureSha256)
    || !SHA256_HEX.test(input.questionPayloadDigest) || !Number.isSafeInteger(input.generation)
    || input.generation < 1 || !isPosition(input.blockedPartPosition) || !isPosition(input.challengeCreated)
    || !isPosition(input.challengeResponsePosition) || !isPosition(input.questionCreated)
    || !isPosition(input.questionResponsePosition) || !isPosition(input.questionPartPosition)
    || input.blockedCallID === input.retryCallID || input.challengeResponsePosition >= input.questionResponsePosition
  ) return undefined;
  const scope: QuestionAuthorizationScope = Object.freeze({
    ...input,
    [questionAuthorizationScopeBrand]: true as const,
  });
  issuedScopes.add(scope);
  return scope;
};

export const isHostValidatedQuestionAuthorizationScope = (
  scope: QuestionAuthorizationScope,
): boolean => issuedScopes.has(scope);

export type CurrentCallIdentity = AuthorizationSourceIdentity & {
  readonly callID: string;
  readonly tool: string;
  readonly effectSha256: string;
};

export type NormalizedQuestionOption = {
  readonly label: string;
  readonly description: string;
};

export type NormalizedQuestion = {
  readonly header: string;
  readonly question: string;
  readonly options: readonly NormalizedQuestionOption[];
  readonly multiple: boolean;
  readonly custom: true;
};

export type AuthorizationCandidate =
  | {
      readonly kind: "direct_user";
      readonly source: AuthorizationSourceIdentity;
      readonly current: CurrentCallIdentity;
      readonly text: string;
    }
  | {
      readonly kind: "question_answer";
      readonly source: AuthorizationSourceIdentity & { readonly callID: string };
      readonly current: CurrentCallIdentity;
      readonly scope: QuestionAuthorizationScope;
      readonly questions: readonly NormalizedQuestion[];
      readonly answers: readonly (readonly string[])[];
      readonly payloadDigest: string;
    };

type AuthorizationEntryIdentity = {
  readonly messageID: string;
  readonly created: number;
  readonly responsePosition: number;
};

export type AuthorizationEntry = AuthorizationEntryIdentity & (
  | { readonly kind: "eligible_user"; readonly reviewerPosition: number; readonly text: string }
  | { readonly kind: "ineligible_user" }
  | { readonly kind: "assistant" }
);

export type AuthorizationSnapshot = {
  readonly reviewer: ReviewerTranscript;
  readonly entries: readonly AuthorizationEntry[];
};

export type TranscriptSnapshot = {
  readonly reviewer: ReviewerTranscript;
  readonly authorizationMessages: readonly AuthorizationMessage[];
};

export type AuthorizationTranscriptSnapshot = TranscriptSnapshot & {
  readonly authorizationCandidates: readonly AuthorizationCandidate[];
};

export type SessionMessagesRequest = {
  readonly path: { readonly id: string };
  readonly query: { readonly directory: string; readonly limit: number };
  readonly signal: AbortSignal;
};

export type SessionMessagesClient = {
  readonly session: {
    readonly messages: (options: SessionMessagesRequest) => Promise<unknown>;
  };
};

export type TranscriptFetchInput = {
  readonly client: SessionMessagesClient | undefined;
  readonly parentSessionID: string;
  readonly canonicalDirectory: string;
  readonly currentCall?: {
    readonly callID: string;
    readonly tool: string;
    readonly effectSha256: string;
  };
  readonly questionAuthorizationScope?: QuestionAuthorizationScope;
  readonly limit: number;
  readonly signal: AbortSignal;
};

export const emptyTranscriptSnapshot = (
  reviewer: Exclude<ReviewerTranscript, { readonly status: "available" }>,
): TranscriptSnapshot => Object.freeze({
  reviewer: Object.freeze(reviewer),
  authorizationMessages: Object.freeze([]),
});
