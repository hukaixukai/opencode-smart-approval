import type { ReviewAuthorizationCandidate } from "./review-request";
import type {
  AuthorizationCandidate,
  QuestionAuthorizationScope,
  ReviewerTranscript,
} from "./transcript-types";
import type { CommandApprovalError } from "./user-facing";

export type ConfirmationBoundary = {
  readonly challengeMessageID: string;
  readonly challengeCreated: number;
  readonly challengeResponsePosition: number;
  readonly blockedPartID: string;
  readonly blockedPartPosition: number;
  readonly blockedCallID: string;
};

export type ConfirmationTerminalCode =
  | "claim_denied"
  | "claim_payload_mismatch"
  | "claim_question_mismatch";

export type PendingQuestionState =
  | { readonly kind: "waiting" }
  | {
      readonly kind: "asked";
      readonly questionRequestID: string;
      readonly questionMessageID: string;
      readonly questionCallID: string;
    }
  | {
      readonly kind: "replied";
      readonly questionRequestID: string;
      readonly questionMessageID: string;
      readonly questionCallID: string;
      readonly answers: readonly (readonly string[])[];
    }
  | {
      readonly kind: "fallback";
      readonly questionRequestID: string;
      readonly questionMessageID: string;
      readonly questionCallID: string;
      readonly reason: "rejected" | "error";
    }
  | { readonly kind: "terminal"; readonly code: ConfirmationTerminalCode };

export type PendingAuthorization = {
  readonly kind: "pending";
  readonly parentSessionID: string;
  readonly canonicalCwd: string;
  readonly effectSha256: string;
  readonly disclosureSha256: string;
  readonly questionPayloadDigest: string;
  readonly generation: number;
  readonly boundary: ConfirmationBoundary;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly question: PendingQuestionState;
  readonly error: CommandApprovalError;
};

type DirectCandidate = Extract<AuthorizationCandidate, { readonly kind: "direct_user" }>;
type QuestionCandidate = Extract<AuthorizationCandidate, { readonly kind: "question_answer" }>;

export type AuthorizationClaimSource =
  | {
      readonly kind: "prompt";
      readonly candidate: DirectCandidate;
      readonly deterministicAuthorization: false;
    }
  | {
      readonly kind: "fallback";
      readonly candidate: DirectCandidate;
      readonly deterministicAuthorization: false;
    }
  | {
      readonly kind: "question";
      readonly candidate: QuestionCandidate;
      readonly scope: QuestionAuthorizationScope;
      readonly questionRequestID: string;
      readonly answer: string;
      readonly deterministicAuthorization: boolean;
    };

export type AvailableAuthorization = {
  readonly kind: "available";
  readonly parentSessionID: string;
  readonly callID: string;
  readonly effectSha256: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly source: AuthorizationClaimSource;
  readonly transcript: ReviewerTranscript;
};

export type AuthorizationClaim = {
  readonly reviewAttemptID: string;
  readonly parentSessionID: string;
  readonly callID: string;
  readonly effectSha256: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly source: AuthorizationClaimSource;
  readonly transcript: ReviewerTranscript;
  readonly authorizationCandidate: ReviewAuthorizationCandidate;
};

export type ClaimedAuthorization = {
  readonly kind: "claimed";
  readonly available: AvailableAuthorization;
  readonly claim: AuthorizationClaim;
  readonly observed: boolean;
};

export type AuthorizationSlot = PendingAuthorization | AvailableAuthorization | ClaimedAuthorization;

type SourceOrder = { readonly created: number; readonly messageID: string };

const laterOrder = (left: SourceOrder | undefined, right: SourceOrder): SourceOrder => {
  if (!left || right.created > left.created) return right;
  if (right.created === left.created && right.messageID > left.messageID) return right;
  return left;
};

export const sourceOrderAtOrBefore = (left: SourceOrder, right: SourceOrder): boolean => (
  left.created < right.created || (left.created === right.created && left.messageID <= right.messageID)
);

export const createConfirmationLedger = () => {
  const slots = new Map<string, AuthorizationSlot>();
  const generations = new Map<string, number>();
  const attempts = new Map<string, number>();
  const consumedSourceThrough = new Map<string, SourceOrder>();
  const consumedCurrentThrough = new Map<string, SourceOrder>();
  const revisions = new Map<string, number>();
  const locks = new Map<string, Promise<void>>();
  let revisionCounter = 0;

  const advanceRevision = (sessionID: string): void => {
    revisionCounter += 1;
    revisions.set(sessionID, revisionCounter);
  };

  const runLocked = async <T>(sessionID: string, operation: () => Promise<T>): Promise<T> => {
    const previous = locks.get(sessionID) ?? Promise.resolve();
    let unlock = (): void => undefined;
    const current = new Promise<void>((resolve) => { unlock = resolve; });
    locks.set(sessionID, current);
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
      if (locks.get(sessionID) === current) locks.delete(sessionID);
    }
  };

  const consumeCandidate = (sessionID: string, candidate: AuthorizationCandidate): void => {
    const source = candidate.source;
    const current = candidate.current;
    consumedSourceThrough.set(sessionID, laterOrder(
      consumedSourceThrough.get(sessionID),
      { created: source.created, messageID: source.messageID },
    ));
    consumedCurrentThrough.set(sessionID, laterOrder(
      consumedCurrentThrough.get(sessionID),
      { created: current.created, messageID: current.messageID },
    ));
  };

  const consumeOrder = (claim: AuthorizationClaim): void => {
    consumeCandidate(claim.parentSessionID, claim.source.candidate);
  };

  const clearSession = (sessionID: string): void => {
    slots.delete(sessionID);
    generations.delete(sessionID);
    attempts.delete(sessionID);
    consumedSourceThrough.delete(sessionID);
    consumedCurrentThrough.delete(sessionID);
    advanceRevision(sessionID);
  };

  return Object.freeze({
    runLocked,
    slot: (sessionID: string) => slots.get(sessionID),
    revision: (sessionID: string) => revisions.get(sessionID) ?? 0,
    setSlot: (sessionID: string, slot: AuthorizationSlot) => {
      slots.set(sessionID, slot);
      advanceRevision(sessionID);
    },
    deleteSlot: (sessionID: string) => {
      slots.delete(sessionID);
      advanceRevision(sessionID);
    },
    nextGeneration: (sessionID: string) => {
      const generation = (generations.get(sessionID) ?? 0) + 1;
      generations.set(sessionID, generation);
      return generation;
    },
    nextReviewAttemptID: (sessionID: string) => {
      const attempt = (attempts.get(sessionID) ?? 0) + 1;
      attempts.set(sessionID, attempt);
      return `review-attempt-${String(attempt)}`;
    },
    consumedSourceOrder: (sessionID: string) => consumedSourceThrough.get(sessionID),
    consumedCurrentOrder: (sessionID: string) => consumedCurrentThrough.get(sessionID),
    consumeCandidate,
    consumeOrder,
    clearSession,
    dispose: async () => {
      await Promise.all([...locks.values()]);
      slots.clear();
      generations.clear();
      attempts.clear();
      consumedSourceThrough.clear();
      consumedCurrentThrough.clear();
      revisions.clear();
      locks.clear();
    },
  });
};

export type ConfirmationLedger = ReturnType<typeof createConfirmationLedger>;
