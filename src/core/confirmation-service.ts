import {
  AUTHORIZATION_CALL_TIMEOUT_MS,
  fetchAuthorizationContext,
  type AuthorizationContext,
} from "./session-context";
import { runBoundedCall } from "./bounded-race";
import {
  CONFIRMATION_TTL_MS,
  createConfirmationIssue,
  type ConfirmationContextFetch,
  type ConfirmationEffect,
  type AuthorizationStage,
  type ConfirmationService,
  type ConfirmationStateService,
} from "./confirmation-disclosure";
import {
  classifyClaimFailure,
  pendingAuthorizationEvidence,
  promptAuthorizationSource,
  type ConfirmationClaimResult,
} from "./confirmation-failure";
import { createConfirmationEventHandler } from "./confirmation-renderer";
import {
  createConfirmationLedger,
  sourceOrderAtOrBefore,
  type AuthorizationClaim,
  type AuthorizationClaimSource,
  type AvailableAuthorization,
  type ConfirmationLedger,
  type PendingAuthorization,
} from "./confirmation-ledger";
import type { OpenCodeClientAdapter } from "./opencode-client-adapter";
import { createReviewAuthorizationCandidate } from "./review-request";

export { CONFIRMATION_TTL_MS } from "./confirmation-disclosure";
export type {
  AuthorizationStage,
  ConfirmationQuestionEvent,
  ConfirmationService,
} from "./confirmation-disclosure";
export type { ConfirmationClaimResult, ConfirmationIssueResult } from "./confirmation-failure";
export type { AuthorizationClaim } from "./confirmation-ledger";

type ClaimPreparation = ConfirmationClaimResult | {
  readonly kind: "fetch";
  readonly revision: number;
  readonly slot: PendingAuthorization | undefined;
};

type AvailabilityEvidence = {
  readonly currentCallID: string;
  readonly source: AuthorizationClaimSource;
  readonly transcript: AuthorizationContext["snapshot"]["reviewer"];
  readonly now: number;
};
const availableFor = (effect: ConfirmationEffect, evidence: AvailabilityEvidence): AvailableAuthorization => Object.freeze({
  kind: "available", parentSessionID: effect.effect.parentSessionID, callID: evidence.currentCallID,
  effectSha256: effect.sha256, issuedAt: evidence.now, expiresAt: evidence.now + CONFIRMATION_TTL_MS,
  source: evidence.source, transcript: evidence.transcript,
});

const createClaimedAuthorization = (ledger: ConfirmationLedger, available: AvailableAuthorization): ConfirmationClaimResult => {
  const reviewAttemptID = ledger.nextReviewAttemptID(available.parentSessionID);
  const claim: AuthorizationClaim = Object.freeze({
    reviewAttemptID,
    parentSessionID: available.parentSessionID,
    callID: available.callID,
    effectSha256: available.effectSha256,
    issuedAt: available.issuedAt,
    expiresAt: available.expiresAt,
    source: available.source,
    transcript: available.transcript,
    authorizationCandidate: createReviewAuthorizationCandidate({
      reviewAttemptID,
      parentSessionID: available.parentSessionID,
      issuedAt: available.issuedAt,
      expiresAt: available.expiresAt,
      source: available.source,
    }),
  });
  ledger.setSlot(available.parentSessionID, Object.freeze({ kind: "claimed", available, claim, observed: false }));
  return { kind: "claimed", claim };
};

const createConfirmationClaim = (input: {
  readonly ledger: ConfirmationLedger;
  readonly fetchContext: ConfirmationContextFetch;
  readonly closed: () => boolean;
}): ConfirmationStateService["claim"] => async ({ effect, deadline }) => {
  const sessionID = effect.effect.parentSessionID;
  const currentCallID = "currentCallID" in effect.effect ? effect.effect.currentCallID : undefined;
  if (currentCallID === undefined) return { kind: "rejected", code: "claim_call_mismatch" };
  const prepared = await input.ledger.runLocked<ClaimPreparation>(sessionID, async () => {
    if (input.closed()) return { kind: "rejected", code: "claim_confirmation_disposed" };
    const current = input.ledger.slot(sessionID);
    if (current?.kind === "claimed") return { kind: "rejected", code: "claim_in_use" };
    if (current?.kind === "available") {
      if (current.expiresAt <= deadline.now()) { input.ledger.deleteSlot(sessionID); return { kind: "rejected", code: "claim_expired" }; }
      if (current.callID !== currentCallID) return { kind: "rejected", code: "claim_call_mismatch" };
      if (current.effectSha256 !== effect.sha256) return { kind: "rejected", code: "claim_effect_mismatch" };
      return createClaimedAuthorization(input.ledger, current);
    }
    if (current?.kind === "pending") {
      if (current.question.kind !== "terminal" && current.expiresAt <= deadline.now()) { input.ledger.deleteSlot(sessionID); return { kind: "rejected", code: "claim_expired" }; }
      if (current.effectSha256 !== effect.sha256) { input.ledger.deleteSlot(sessionID); return { kind: "rejected", code: "claim_effect_mismatch" }; }
      if (current.boundary.blockedCallID === currentCallID) { input.ledger.deleteSlot(sessionID); return { kind: "rejected", code: "claim_call_mismatch" }; }
    }
    return { kind: "fetch", revision: input.ledger.revision(sessionID), slot: current };
  });
  if (prepared.kind !== "fetch") return prepared;
  const fetched = await input.fetchContext(effect, deadline);
  const fetchedTranscript = fetched.ok
    ? fetched.context.snapshot.reviewer
    : Object.freeze({ status: "unavailable" as const, reason: fetched.reason });
  return input.ledger.runLocked(sessionID, async () => {
    if (input.closed()) return { kind: "rejected", code: "claim_confirmation_disposed" };
    const current = input.ledger.slot(sessionID);
    if (input.ledger.revision(sessionID) !== prepared.revision || current !== prepared.slot) {
      return current?.kind === "claimed" ? { kind: "rejected", code: "claim_in_use" } : { kind: "awaiting" };
    }
    if (current?.kind === "pending" && current.question.kind !== "terminal" && current.expiresAt <= deadline.now()) {
      input.ledger.deleteSlot(sessionID); return { kind: "rejected", code: "claim_expired" };
    }
    if (!fetched.ok || fetched.context.snapshot.reviewer.status !== "available") {
      if (current?.kind === "pending" && current.question.kind === "terminal") return { kind: "rejected", code: current.question.code };
      if (current?.kind !== "pending") return { kind: "none", transcript: fetchedTranscript };
      const reason = !fetched.ok ? fetched.reason : fetched.context.snapshot.reviewer.status === "unavailable" ? fetched.context.snapshot.reviewer.reason : "malformed";
      return classifyClaimFailure(reason);
    }
    if (current?.kind === "pending") {
      if (current.question.kind === "terminal") {
        const source = promptAuthorizationSource(fetched.context);
        if (source) { input.ledger.consumeCandidate(sessionID, source.candidate); input.ledger.deleteSlot(sessionID); }
        return { kind: "rejected", code: current.question.code };
      }
      const evidence = pendingAuthorizationEvidence(current, fetched.context, {
        callID: currentCallID, tool: effect.effect.handledTool, effectSha256: effect.sha256,
      });
      if (evidence.question) input.ledger.setSlot(sessionID, Object.freeze({ ...current, question: evidence.question }));
      if (evidence.kind === "awaiting") return { kind: "awaiting" };
      if (evidence.kind === "rejected") { input.ledger.deleteSlot(sessionID); return evidence; }
      const available = availableFor(effect, {
        currentCallID, source: evidence.source, transcript: fetched.context.snapshot.reviewer, now: current.issuedAt,
      });
      input.ledger.setSlot(sessionID, available);
      return createClaimedAuthorization(input.ledger, available);
    }
    const source = promptAuthorizationSource(fetched.context);
    if (!source || source.candidate.text.trim().length === 0) return { kind: "none", transcript: fetchedTranscript };
    const consumedSource = input.ledger.consumedSourceOrder(sessionID);
    const consumedCurrent = input.ledger.consumedCurrentOrder(sessionID);
    const sourceOrder = { created: source.candidate.source.created, messageID: source.candidate.source.messageID };
    const currentOrder = { created: source.candidate.current.created, messageID: source.candidate.current.messageID };
    if ((consumedSource && sourceOrderAtOrBefore(sourceOrder, consumedSource)) || (consumedCurrent && sourceOrderAtOrBefore(currentOrder, consumedCurrent))) {
      return { kind: "rejected", code: "claim_replayed" };
    }
    const available = availableFor(effect, {
      currentCallID, source, transcript: fetched.context.snapshot.reviewer, now: deadline.now(),
    });
    input.ledger.setSlot(sessionID, available);
    return createClaimedAuthorization(input.ledger, available);
  });
};

export const createConfirmationService = (input: {
  readonly adapter: Pick<OpenCodeClientAdapter, "messages">;
  readonly directory: string;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly now?: () => number;
}): ConfirmationStateService => {
  const ledger = createConfirmationLedger();
  let disposing = false;
  let disposed = false;
  const closed = (): boolean => disposed || disposing;

  const fetchContext: ConfirmationContextFetch = async (effect, deadline) => {
    const currentCallID = "currentCallID" in effect.effect ? effect.effect.currentCallID : undefined;
    if (currentCallID === undefined) return { ok: false, reason: "sdk_error" };
    const call = await runBoundedCall({
      deadline,
      timeoutMs: AUTHORIZATION_CALL_TIMEOUT_MS,
      operation: (signal) => fetchAuthorizationContext({
        adapter: input.adapter,
        parentSessionID: effect.effect.parentSessionID,
        canonicalDirectory: input.directory,
        currentCall: {
          callID: currentCallID,
          tool: effect.effect.handledTool,
          effectSha256: effect.sha256,
        },
        signal,
      }),
    });
    if (!call.ok) return { ok: false, reason: call.code === "rejected" ? "sdk_error" : "timeout" };
    return { ok: true, context: call.value };
  };

  const issue = createConfirmationIssue({ ledger, fetchContext, closed });
  const claim = createConfirmationClaim({ ledger, fetchContext, closed });
  const handleQuestionEvent = createConfirmationEventHandler({ ledger, closed });

  const observe = (claimValue: AuthorizationClaim, _stage: AuthorizationStage): boolean => {
    void _stage;
    if (closed()) return false;
    const current = ledger.slot(claimValue.parentSessionID);
    if (current?.kind !== "claimed" || current.claim !== claimValue) return false;
    if (!current.observed) ledger.setSlot(claimValue.parentSessionID, Object.freeze({ ...current, observed: true }));
    return true;
  };

  const release = (claimValue: AuthorizationClaim): boolean => {
    if (closed()) return false;
    const current = ledger.slot(claimValue.parentSessionID);
    if (current?.kind !== "claimed" || current.claim !== claimValue || current.observed) return false;
    ledger.setSlot(claimValue.parentSessionID, current.available);
    return true;
  };

  const finish = (claimValue: AuthorizationClaim): boolean => {
    if (closed()) return false;
    const current = ledger.slot(claimValue.parentSessionID);
    if (current?.kind !== "claimed" || current.claim !== claimValue) return false;
    ledger.consumeOrder(claimValue);
    ledger.deleteSlot(claimValue.parentSessionID);
    return true;
  };

  return Object.freeze({
    issue,
    claim,
    handleQuestionEvent,
    observe,
    release,
    finish,
    clearSession: async (parentSessionID) => {
      if (closed()) return;
      await ledger.runLocked(parentSessionID, async () => {
        if (!closed()) ledger.clearSession(parentSessionID);
      });
    },
    dispose: async () => {
      if (closed()) return;
      disposing = true;
      await ledger.dispose();
      disposed = true;
    },
  });
};
