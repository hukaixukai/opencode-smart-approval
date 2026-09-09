import type { ReviewCleanupResult } from "./review-handle";
import type { ReviewResponse } from "./types";

export const failClosedOpenCodeReview = (code: string): ReviewResponse => ({
  outcome: "deny",
  riskLevel: "high",
  userAuthorization: "unknown",
  categories: [{ id: "security.reviewer_unavailable", score: 1 }],
  reasons: [`reviewer_failure:${code}`],
});

export const withReviewLifecycleResult = (
  response: ReviewResponse,
  cleanup: ReviewCleanupResult,
): ReviewResponse => cleanup.ok ? response : {
  outcome: "deny",
  riskLevel: response.riskLevel === "critical" ? "critical" : "high",
  userAuthorization: response.userAuthorization,
  categories: [
    ...response.categories,
    ...response.categories.some((category) => category.id === "security.reviewer_lifecycle")
      ? []
      : [{ id: "security.reviewer_lifecycle", score: 1 }],
  ],
  reasons: [...response.reasons, `reviewer_lifecycle:${cleanup.code}`],
};
