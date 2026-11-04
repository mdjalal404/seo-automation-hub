import { AppError, type ErrorCode } from "@/lib/errors";

export const JOB_STATUSES = [
  "QUEUED", "VALIDATING", "PUBLISHING", "VERIFYING", "COMPLETED", "FAILED", "CANCELLED", "RETRY_SCHEDULED",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobType = "VALIDATE" | "CREATE_DRAFT" | "PUBLISH" | "VERIFY";

export const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  QUEUED: ["VALIDATING", "VERIFYING", "CANCELLED"],
  RETRY_SCHEDULED: ["VALIDATING", "VERIFYING", "CANCELLED"],
  VALIDATING: ["PUBLISHING", "COMPLETED", "FAILED", "RETRY_SCHEDULED"],
  PUBLISHING: ["VERIFYING", "COMPLETED", "FAILED", "RETRY_SCHEDULED"],
  VERIFYING: ["COMPLETED", "FAILED", "RETRY_SCHEDULED"],
  COMPLETED: [],
  FAILED: ["QUEUED"], // manual retry only
  CANCELLED: [],
};

export function canJobTransition(from: JobStatus, to: JobStatus) {
  return JOB_TRANSITIONS[from].includes(to);
}

export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ["QUEUED", "VALIDATING", "PUBLISHING", "VERIFYING", "RETRY_SCHEDULED"];
export const PENDING_JOB_STATUSES: readonly JobStatus[] = ["QUEUED", "RETRY_SCHEDULED"];

export type FailureDecision =
  | { kind: "retry"; delayMs: number; reconcile: boolean }
  | { kind: "fail"; code: ErrorCode; retryable: boolean };

const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 30 * 60_000;

/** Bounded exponential backoff with jitter: 30s, 60s, 120s ... capped at 30 minutes. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.8 + random() * 0.4));
}

/**
 * Decides what to do after a failed attempt. Permanent errors (validation, bad
 * request, auth) never retry automatically; ambiguous write failures retry only
 * with reconciliation against the CMS first.
 */
export function decideOnFailure(err: unknown, attempt: number, maxAttempts: number, random?: () => number): FailureDecision {
  const e = err instanceof AppError ? err : new AppError("INTERNAL", "Unexpected error", { retryable: false });
  if (!e.retryable) return { kind: "fail", code: e.code, retryable: false };
  if (attempt >= maxAttempts) return { kind: "fail", code: "MAX_ATTEMPTS_EXCEEDED", retryable: true };
  const delay = Math.max(backoffDelay(attempt, random), e.retryAfterMs ?? 0);
  return { kind: "retry", delayMs: Math.min(delay, MAX_DELAY_MS), reconcile: e.ambiguous };
}

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  QUEUED: "Queued",
  VALIDATING: "Validating",
  PUBLISHING: "Publishing",
  VERIFYING: "Verifying",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  RETRY_SCHEDULED: "Retry scheduled",
};

export const JOB_TYPE_LABEL: Record<JobType, string> = {
  VALIDATE: "SEO validation",
  CREATE_DRAFT: "Create CMS draft",
  PUBLISH: "Publish",
  VERIFY: "Verify live page",
};

/** Error codes the user may manually retry after fixing the cause (mirrors retry_job()). */
export function isManuallyRetryable(job: { status: string; retryable: boolean | null; error_code: string | null }) {
  if (job.status !== "FAILED") return false;
  return !!job.retryable || ["WP_AUTH_FAILED", "CMS_AUTH_FAILED", "VERIFICATION_FAILED", "MAX_ATTEMPTS_EXCEEDED", "LEASE_EXPIRED"].includes(job.error_code ?? "");
}
