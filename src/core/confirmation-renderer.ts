import {
  CanonicalQuestionPayloadSchema,
  canonicalQuestionPayloadJson,
  normalizeQuestionPrompts,
  questionPayloadDigest,
} from "./confirmation-disclosure";
import { escapeUserFacingScalar } from "./user-facing-scalar";
import { z } from "zod";
import type { ConfirmationQuestionEvent, ConfirmationStateService } from "./confirmation-disclosure";
import type {
  ConfirmationLedger,
  ConfirmationTerminalCode,
  PendingQuestionState,
} from "./confirmation-ledger";
import type { ConfirmationQuestionEventResult } from "./confirmation-failure";

export const MAX_ESCAPED_CONFIRMATION_COMMAND_UTF8_BYTES = 8_192;
export const MAX_CONFIRMATION_BODY_UTF8_BYTES = 16_384;
export const CONFIRMATION_HANDOFF_MARKER = "opencode-smart-approval.question-handoff.v1" as const;
export const CONFIRMATION_NEXT_ACTION = "primary_agent_call_question_once" as const;

const MAX_CONFIRMATION_BODY_UTF16_CODE_UNITS = 16_384;
const MAX_CONFIRMATION_CWD_UTF8_BYTES = 4_096;
const MAX_CONFIRMATION_CWD_UTF16_CODE_UNITS = 4_096;
const MAX_CONFIRMATION_FIELD_UTF8_BYTES = 1_024;
const MAX_CONFIRMATION_FIELD_UTF16_CODE_UNITS = 1_024;
const PRIMARY_AGENT_INSTRUCTION = "Primary agent: call the built-in question tool exactly once with question_payload. If this same pending handoff is rendered again, do not create a duplicate question. Retry the identical command exactly once only after the user selects Authorize once. If the user selects Deny, gives no affirmative answer, or the question call fails, do not retry." as const;
const SHA256_HEX = /^[a-f0-9]{64}$/u;

const confirmationQuestionPayload = (): { readonly json: string; readonly sha256: string } | undefined => {
  const parsed = CanonicalQuestionPayloadSchema.safeParse({
    questions: [{
      custom: true, header: "Command authorization", multiple: false,
      options: [
        { label: "Authorize once", description: "Authorize one retry of the identical disclosed command." },
        { label: "Deny", description: "Do not authorize or retry the disclosed command." },
      ],
      question: "Authorize this disclosed command once?",
    }],
  });
  if (!parsed.success) return undefined;
  const questions = Object.freeze(parsed.data.questions);
  const json = canonicalQuestionPayloadJson(questions);
  const sha256 = questionPayloadDigest(questions);
  return json === undefined || sha256 === undefined ? undefined : Object.freeze({ json, sha256 });
};

export const confirmationQuestionPayloadDigest = (): string | undefined => confirmationQuestionPayload()?.sha256;

const Identity = z.string().min(1);
const QuestionEvent = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("question.asked"), properties: z.looseObject({
    id: Identity, sessionID: Identity, questions: z.array(z.unknown()),
    tool: z.looseObject({ messageID: z.string(), callID: z.string() }).optional(),
  }) }),
  z.looseObject({ type: z.literal("question.replied"), properties: z.looseObject({
    sessionID: Identity, requestID: Identity, answers: z.array(z.array(z.string())),
  }) }),
  z.looseObject({ type: z.literal("question.rejected"), properties: z.looseObject({ sessionID: Identity, requestID: Identity }) }),
]);

export const parseConfirmationQuestionEvent = (input: unknown): ConfirmationQuestionEvent | undefined => {
  const parsed = QuestionEvent.safeParse(input);
  if (!parsed.success) return undefined;
  switch (parsed.data.type) {
    case "question.asked": return Object.freeze({ type: parsed.data.type,
      parentSessionID: parsed.data.properties.sessionID, questionRequestID: parsed.data.properties.id,
      questionMessageID: parsed.data.properties.tool?.messageID ?? "", questionCallID: parsed.data.properties.tool?.callID ?? "",
      questions: Object.freeze(parsed.data.properties.questions) });
    case "question.replied": return Object.freeze({ type: parsed.data.type,
      parentSessionID: parsed.data.properties.sessionID, questionRequestID: parsed.data.properties.requestID,
      answers: Object.freeze(parsed.data.properties.answers.map((answer) => Object.freeze(answer))) });
    case "question.rejected": return Object.freeze({ type: parsed.data.type,
      parentSessionID: parsed.data.properties.sessionID, questionRequestID: parsed.data.properties.requestID });
  }
};

const SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const eventAnswersValid = (answers: readonly (readonly string[])[]): boolean => (
  answers.length === 1 && answers[0]?.length === 1 && (answers[0]?.[0]?.length ?? 1_001) <= 1_000
);
export const createConfirmationEventHandler = (input: {
  readonly ledger: ConfirmationLedger;
  readonly closed: () => boolean;
}): ConfirmationStateService["handleQuestionEvent"] => async (event: ConfirmationQuestionEvent) => input.ledger.runLocked(
  event.parentSessionID,
  async () => {
    if (input.closed()) return { kind: "ignored" };
    const current = input.ledger.slot(event.parentSessionID);
    if (current?.kind !== "pending") return { kind: "ignored" };
    const reject = (
      code: "event_order_mismatch" | "event_identity_mismatch" | "event_payload_mismatch",
      claimCode: ConfirmationTerminalCode,
    ): ConfirmationQuestionEventResult => {
      input.ledger.setSlot(event.parentSessionID, Object.freeze({
        ...current,
        question: Object.freeze({ kind: "terminal", code: claimCode }),
      }));
      return { kind: "rejected", code };
    };
    switch (event.type) {
      case "question.asked": {
        if (current.question.kind !== "waiting") return reject("event_order_mismatch", "claim_question_mismatch");
        if (!SOURCE_ID.test(event.questionRequestID) || !SOURCE_ID.test(event.questionMessageID)
          || !SOURCE_ID.test(event.questionCallID) || event.questionCallID === current.boundary.blockedCallID) {
          return reject("event_identity_mismatch", "claim_question_mismatch");
        }
        const questions = normalizeQuestionPrompts(event.questions);
        const digest = questions ? questionPayloadDigest(questions) : undefined;
        if (digest !== current.questionPayloadDigest) return reject("event_payload_mismatch", "claim_payload_mismatch");
        input.ledger.setSlot(event.parentSessionID, Object.freeze({ ...current, question: Object.freeze({
          kind: "asked", questionRequestID: event.questionRequestID,
          questionMessageID: event.questionMessageID, questionCallID: event.questionCallID,
        }) }));
        return { kind: "recorded" };
      }
      case "question.replied": {
        if (current.question.kind !== "asked") return reject("event_order_mismatch", "claim_question_mismatch");
        if (event.questionRequestID !== current.question.questionRequestID) return reject("event_identity_mismatch", "claim_question_mismatch");
        if (!eventAnswersValid(event.answers)) return reject("event_payload_mismatch", "claim_payload_mismatch");
        const question: PendingQuestionState = event.answers[0]?.[0] === "Deny"
          ? Object.freeze({ kind: "terminal", code: "claim_denied" })
          : Object.freeze({ ...current.question, kind: "replied", answers: Object.freeze(event.answers.map((values) => Object.freeze([...values]))) });
        input.ledger.setSlot(event.parentSessionID, Object.freeze({ ...current, question }));
        return { kind: "recorded" };
      }
      case "question.rejected":
        if (current.question.kind !== "asked") return reject("event_order_mismatch", "claim_question_mismatch");
        if (event.questionRequestID !== current.question.questionRequestID) return reject("event_identity_mismatch", "claim_question_mismatch");
        input.ledger.setSlot(event.parentSessionID, Object.freeze({
          ...current,
          question: Object.freeze({ ...current.question, kind: "fallback", reason: "rejected" }),
        }));
        return { kind: "recorded" };
    }
  },
);

export type ConfirmationValues = {
  readonly command: string;
  readonly cwd: string;
  readonly action: string;
  readonly data: string;
  readonly destination: string;
  readonly risk: string;
};

export type ConfirmationChallenge = {
  readonly values: ConfirmationValues;
  readonly effectSha256: string;
  readonly disclosureSha256: string;
  readonly replaced: boolean;
};

export type ConfirmationBodyResult =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly code: "confirmation_render_failed" };

type FieldLimit = {
  readonly utf8Bytes: number;
  readonly utf16CodeUnits: number;
};

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");
const failure = (): ConfirmationBodyResult => ({ ok: false, code: "confirmation_render_failed" });

const escapedValue = (value: string, limit: FieldLimit): string | undefined => {
  if (value.length > limit.utf16CodeUnits) return undefined;
  const escaped = escapeUserFacingScalar(value);
  if (!escaped.ok || byteLength(escaped.value) > limit.utf8Bytes) return undefined;
  return escaped.value;
};

export const renderConfirmationBody = (challenge: ConfirmationChallenge): ConfirmationBodyResult => {
  const questionPayload = confirmationQuestionPayload();
  if (
    !SHA256_HEX.test(challenge.effectSha256)
    || !SHA256_HEX.test(challenge.disclosureSha256)
    || questionPayload === undefined
  ) return failure();

  const ordered = [
    ["command", challenge.values.command, {
      utf8Bytes: MAX_ESCAPED_CONFIRMATION_COMMAND_UTF8_BYTES,
      utf16CodeUnits: MAX_ESCAPED_CONFIRMATION_COMMAND_UTF8_BYTES,
    }],
    ["canonical_cwd", challenge.values.cwd, {
      utf8Bytes: MAX_CONFIRMATION_CWD_UTF8_BYTES,
      utf16CodeUnits: MAX_CONFIRMATION_CWD_UTF16_CODE_UNITS,
    }],
    ["action", challenge.values.action, {
      utf8Bytes: MAX_CONFIRMATION_FIELD_UTF8_BYTES,
      utf16CodeUnits: MAX_CONFIRMATION_FIELD_UTF16_CODE_UNITS,
    }],
    ["data", challenge.values.data, {
      utf8Bytes: MAX_CONFIRMATION_FIELD_UTF8_BYTES,
      utf16CodeUnits: MAX_CONFIRMATION_FIELD_UTF16_CODE_UNITS,
    }],
    ["destination", challenge.values.destination, {
      utf8Bytes: MAX_CONFIRMATION_FIELD_UTF8_BYTES,
      utf16CodeUnits: MAX_CONFIRMATION_FIELD_UTF16_CODE_UNITS,
    }],
    ["risk", challenge.values.risk, {
      utf8Bytes: MAX_CONFIRMATION_FIELD_UTF8_BYTES,
      utf16CodeUnits: MAX_CONFIRMATION_FIELD_UTF16_CODE_UNITS,
    }],
  ] as const;
  const escaped: string[] = [];
  for (const [label, value, limit] of ordered) {
    const complete = escapedValue(value, limit);
    if (complete === undefined) return failure();
    escaped.push(`${label}="${complete}"`);
  }

  const body = [
    "[CommandApproval]",
    `confirmation_handoff=${CONFIRMATION_HANDOFF_MARKER}`,
    "decision=block",
    "category=security.explicit_confirmation_required;score=1",
    ...escaped,
    `effect_sha256=${challenge.effectSha256}`,
    `disclosure_sha256=${challenge.disclosureSha256}`,
    `question_payload_sha256=${questionPayload.sha256}`,
    "expires_in_seconds=300",
    `prior_handoff_replaced=${String(challenge.replaced)}`,
    `next_action=${CONFIRMATION_NEXT_ACTION}`,
    `question_payload=${questionPayload.json}`,
    `primary_agent_instruction=${PRIMARY_AGENT_INSTRUCTION}`,
  ].join("\n");
  return byteLength(body) <= MAX_CONFIRMATION_BODY_UTF8_BYTES
    && body.length <= MAX_CONFIRMATION_BODY_UTF16_CODE_UNITS
    ? { ok: true, body }
    : failure();
};
