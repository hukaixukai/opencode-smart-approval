import type { ApprovalLeaseHandle } from "./approval-reader";
import type { ExpectedApprovalAgent } from "./approval-plugin-agent";
import { APPROVAL_AGENT_NAME, APPROVAL_AGENT_PROMPT_TOOLS, validateResolvedApprovalAgent } from "./approval-agent";
import { createMonotonicDeadline, runBoundedCall, type LateSettlement, type MonotonicDeadline } from "./bounded-race";
import type { ExpectedModel } from "./expected-model";
import type { OpenCodeCallResult } from "./opencode-client-adapter";
import type { OpenCodeReviewInput, OpenCodeReviewerRuntime } from "./opencode-reviewer";
import { failClosedOpenCodeReview, withReviewLifecycleResult } from "./opencode-review-result";
import { createReviewHandle, type ReviewCleanupResult, type ReviewHandle } from "./review-handle";
import { parseReviewPromptResponse } from "./review-response";
import { validateCreatedReviewSession, type CreatedSessionExpectation } from "./review-session-schema";
import { ownedCreatedReviewSessionID } from "./review-session-ownership";
import type { ReviewResponse } from "./types";

export const REVIEW_CHILD_TITLE = "opencode-smart-approval review";

export type ReviewAttemptResult =
  | { readonly kind: "complete"; readonly response: ReviewResponse }
  | { readonly kind: "invalid_verdict" };

type ReviewAttemptIdentity = {
  readonly expectedAgent: ExpectedApprovalAgent;
  readonly expectedModel: ExpectedModel;
  readonly usedChildIDs: Set<string>;
};

export type ReviewAttemptInput = {
  readonly runtime: OpenCodeReviewerRuntime;
  readonly review: OpenCodeReviewInput;
  readonly serializedRequest: string;
  readonly identity: ReviewAttemptIdentity;
};

type DataCallResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false };

const remaining = (deadline: MonotonicDeadline): number => Math.max(0, deadline.expiresAt - deadline.now());

const dataCall = async (
  deadline: MonotonicDeadline,
  operation: (signal: AbortSignal) => Promise<OpenCodeCallResult>,
): Promise<DataCallResult> => {
  const result = await runBoundedCall({ deadline, timeoutMs: remaining(deadline), operation });
  return result.ok && result.value.ok
    ? { ok: true, data: result.value.data }
    : { ok: false };
};

const agentMatches = (data: unknown, expected: ExpectedApprovalAgent): boolean => {
  try {
    validateResolvedApprovalAgent(data, expected.config, expected.runtime);
    return true;
  } catch (error) {
    if (error instanceof Error) return false;
    return false;
  }
};

export const validateReviewerAgent = async (
  runtime: OpenCodeReviewerRuntime,
  deadline: MonotonicDeadline,
  expected: ExpectedApprovalAgent,
): Promise<boolean> => {
  const agents = await dataCall(deadline, (signal) => runtime.adapter.agents({
    directory: runtime.directory,
    signal,
  }));
  return agents.ok && agentMatches(agents.data, expected);
};

const handleFor = (
  runtime: OpenCodeReviewerRuntime,
  childID: string,
  cleanupEnabled: boolean,
): ReviewHandle => createReviewHandle({
  childID,
  directory: runtime.directory,
  cleanupEnabled,
  revoke: runtime.revoke,
  abort: (signal) => runtime.adapter.abort({ sessionID: childID, directory: runtime.directory, signal }),
  delete: (signal) => runtime.adapter.delete({ sessionID: childID, directory: runtime.directory, signal }),
});

const registerHandle = (
  runtime: OpenCodeReviewerRuntime,
  childID: string,
  cleanupEnabled: boolean,
): ReviewHandle | undefined => {
  const handle = handleFor(runtime, childID, cleanupEnabled);
  return runtime.registry.add(handle) ? handle : undefined;
};

const logLateCleanup = async (
  runtime: OpenCodeReviewerRuntime,
  childID: string,
  cleanup: ReviewCleanupResult,
): Promise<void> => {
  const deadline = createMonotonicDeadline(1_000);
  await runBoundedCall({
    deadline,
    timeoutMs: 1_000,
    operation: (signal) => runtime.adapter.log({
      directory: runtime.directory,
      service: "opencode-smart-approval",
      level: "warn",
      message: "review.late_create_cleanup",
      extra: { event: "late_create", child_id: childID, result: cleanup.ok ? "success" : cleanup.failure },
      signal,
    }),
  });
};

const cleanupLateCreate = async (
  runtime: OpenCodeReviewerRuntime,
  settlement: LateSettlement<OpenCodeCallResult>,
  expectation: CreatedSessionExpectation,
): Promise<void> => {
  if (settlement.status !== "fulfilled" || !settlement.value.ok) return;
  const childID = ownedCreatedReviewSessionID(settlement.value.data, expectation);
  if (!childID) return;
  const handle = registerHandle(runtime, childID, true);
  if (!handle) return;
  const cleanup = await handle.cleanup(true);
  await logLateCleanup(runtime, childID, cleanup);
};

const cleanupFailure = async (handle: ReviewHandle, primary: ReviewResponse): Promise<ReviewResponse> =>
  withReviewLifecycleResult(primary, await handle.cleanup(true));

export const runOpenCodeReviewAttempt = async (input: ReviewAttemptInput): Promise<ReviewAttemptResult> => {
  const { runtime, review, identity } = input;
  const expectation = {
    projectID: runtime.projectID,
    directory: runtime.directory,
    parentID: review.parentSessionID,
    title: REVIEW_CHILD_TITLE,
  };
  const created = await runBoundedCall({
    deadline: review.deadline,
    timeoutMs: remaining(review.deadline),
    operation: (signal) => runtime.adapter.create({
      parentID: review.parentSessionID,
      title: REVIEW_CHILD_TITLE,
      directory: runtime.directory,
      signal,
    }),
    onLateSettlement: (settlement) => cleanupLateCreate(runtime, settlement, expectation),
  });
  if (!created.ok || !created.value.ok) {
    return { kind: "complete", response: failClosedOpenCodeReview("create_failed") };
  }
  const validated = validateCreatedReviewSession(created.value.data, expectation);
  const childID = ownedCreatedReviewSessionID(created.value.data, expectation);
  if (!childID) return { kind: "complete", response: failClosedOpenCodeReview("invalid_session") };
  const handle = registerHandle(runtime, childID, review.cleanupEnabled ?? true);
  if (!handle) return { kind: "complete", response: failClosedOpenCodeReview("ownership_failed") };
  if (identity.usedChildIDs.has(childID)) {
    return { kind: "complete", response: await cleanupFailure(handle, failClosedOpenCodeReview("ownership_failed")) };
  }
  identity.usedChildIDs.add(childID);
  if (!validated.ok) {
    return { kind: "complete", response: await cleanupFailure(handle, failClosedOpenCodeReview(validated.code)) };
  }

  const activation = runtime.activate({
    sessionID: childID,
    agent: APPROVAL_AGENT_NAME,
    directory: runtime.directory,
    references: review.request.shellAnalysis.staticFileReferences,
  });
  if (!activation.ok || !handle.activate(activation.value)) {
    if (activation.ok) runtime.revoke(activation.value);
    return { kind: "complete", response: await cleanupFailure(handle, failClosedOpenCodeReview("lease_failed")) };
  }
  if (!await validateReviewerAgent(runtime, review.deadline, identity.expectedAgent)) {
    return { kind: "complete", response: await cleanupFailure(handle, failClosedOpenCodeReview("agent_mismatch")) };
  }

  const prompt = await runBoundedCall({
    deadline: review.deadline,
    timeoutMs: remaining(review.deadline),
    operation: (signal) => {
      const settlement = runtime.adapter.prompt({
        sessionID: childID,
        directory: runtime.directory,
        agent: APPROVAL_AGENT_NAME,
        ...(identity.expectedModel.source === "v3_or_small_model" ? {
          model: {
            providerID: identity.expectedModel.providerID,
            modelID: identity.expectedModel.modelID,
          },
        } : {}),
        tools: APPROVAL_AGENT_PROMPT_TOOLS,
        text: input.serializedRequest,
        signal,
      });
      handle.setPromptSettlement(settlement);
      return settlement;
    },
  });
  if (!prompt.ok || !prompt.value.ok) {
    return { kind: "complete", response: await cleanupFailure(handle, failClosedOpenCodeReview("prompt_failed")) };
  }
  handle.settlePrompt();
  const parsed = parseReviewPromptResponse(prompt.value.data, {
    childSessionID: childID,
    directory: runtime.directory,
    worktree: runtime.worktree,
    agent: APPROVAL_AGENT_NAME,
    model: identity.expectedModel,
  });
  if (!parsed.ok) {
    const failed = failClosedOpenCodeReview(parsed.code);
    const cleanup = await handle.cleanup(true);
    if (parsed.code === "invalid_verdict" && cleanup.ok) return { kind: "invalid_verdict" };
    return { kind: "complete", response: withReviewLifecycleResult(failed, cleanup) };
  }
  return {
    kind: "complete",
    response: withReviewLifecycleResult(parsed.value, await handle.cleanup(false)),
  };
};
