import type { ApprovalLeaseActivation, ApprovalLeaseHandle } from "./approval-reader";
import type { ReaderResult } from "./anchored-fs";
import type { ExpectedApprovalAgent } from "./approval-plugin-agent";
import type { MonotonicDeadline } from "./bounded-race";
import { expectedModelFromConfigured } from "./expected-model";
import type { OpenCodeClientAdapter } from "./opencode-client-adapter";
import {
  REVIEW_CHILD_TITLE,
  runOpenCodeReviewAttempt,
  validateReviewerAgent,
} from "./opencode-review-attempt";
import { failClosedOpenCodeReview } from "./opencode-review-result";
import type { ReviewRegistry } from "./review-registry";
import { serializeReviewRequest, type SerializeReviewRequestInput } from "./review-request";
import type { ReviewResponse } from "./types";

export { failClosedOpenCodeReview, REVIEW_CHILD_TITLE };

export type OpenCodeReviewerRuntime = {
  readonly adapter: OpenCodeClientAdapter;
  readonly registry: ReviewRegistry;
  readonly projectID: string;
  readonly directory: string;
  readonly worktree: string;
  readonly expectedAgent: () => ExpectedApprovalAgent | undefined;
  readonly reviewModel: () => string | undefined;
  readonly activate: (request: ApprovalLeaseActivation) => ReaderResult<ApprovalLeaseHandle>;
  readonly revoke: (handle: ApprovalLeaseHandle) => boolean;
};

export type OpenCodeReviewInput = {
  readonly parentSessionID: string;
  readonly deadline: MonotonicDeadline;
  readonly request: SerializeReviewRequestInput;
  readonly cleanupEnabled?: boolean;
};

const MAX_REVIEW_ATTEMPTS = 3;

const remaining = (deadline: MonotonicDeadline): number => deadline.expiresAt - deadline.now();

export const reviewWithOpenCode = async (
  runtime: OpenCodeReviewerRuntime,
  input: OpenCodeReviewInput,
): Promise<ReviewResponse> => {
  const serialized = serializeReviewRequest(input.request);
  if (!serialized.ok) return failClosedOpenCodeReview(serialized.code);
  const expectedAgent = runtime.expectedAgent();
  if (!expectedAgent) return failClosedOpenCodeReview("agent_unavailable");
  let configuredModel: string | undefined;
  try {
    configuredModel = runtime.reviewModel();
  } catch {
    return failClosedOpenCodeReview("model_unavailable");
  }
  const expectedModel = expectedModelFromConfigured(configuredModel);
  if (!expectedModel.ok) return failClosedOpenCodeReview(expectedModel.code);
  if (!(remaining(input.deadline) > 0)) return failClosedOpenCodeReview("deadline_exhausted");
  if (!await validateReviewerAgent(runtime, input.deadline, expectedAgent)) {
    return failClosedOpenCodeReview("agent_mismatch");
  }

  const usedChildIDs = new Set<string>();
  for (let attempt = 0; attempt < MAX_REVIEW_ATTEMPTS; attempt += 1) {
    if (!(remaining(input.deadline) > 0)) return failClosedOpenCodeReview("deadline_exhausted");
    const result = await runOpenCodeReviewAttempt({
      runtime,
      review: input,
      serializedRequest: serialized.json,
      identity: { expectedAgent, expectedModel: expectedModel.value, usedChildIDs },
    });
    if (result.kind === "complete") return result.response;
  }
  return failClosedOpenCodeReview("invalid_verdict");
};
