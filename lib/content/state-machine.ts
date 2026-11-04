/**
 * Content workflow. Mirrors public.content_transition_allowed() in the database,
 * which is authoritative; tests assert the two tables are identical.
 */
export const CONTENT_STATUSES = [
  "DRAFT", "VALIDATING", "READY_FOR_REVIEW", "APPROVED", "QUEUED", "PUBLISHING", "VERIFYING", "PUBLISHED",
  "VALIDATION_FAILED", "PUBLISH_FAILED", "VERIFICATION_FAILED", "CANCELLED",
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const CONTENT_TRANSITIONS: Record<ContentStatus, readonly ContentStatus[]> = {
  DRAFT: ["VALIDATING", "CANCELLED"],
  VALIDATING: ["READY_FOR_REVIEW", "VALIDATION_FAILED", "DRAFT"],
  VALIDATION_FAILED: ["DRAFT", "VALIDATING", "CANCELLED"],
  READY_FOR_REVIEW: ["APPROVED", "DRAFT", "VALIDATING", "CANCELLED"],
  APPROVED: ["QUEUED", "DRAFT", "VALIDATING", "CANCELLED"],
  QUEUED: ["PUBLISHING", "APPROVED", "VALIDATION_FAILED", "PUBLISH_FAILED", "VERIFYING", "CANCELLED"],
  PUBLISHING: ["VERIFYING", "PUBLISH_FAILED", "QUEUED"],
  PUBLISH_FAILED: ["QUEUED", "APPROVED", "DRAFT", "CANCELLED"],
  VERIFYING: ["PUBLISHED", "VERIFICATION_FAILED", "QUEUED"],
  VERIFICATION_FAILED: ["VERIFYING", "QUEUED", "DRAFT"],
  PUBLISHED: ["VERIFYING", "QUEUED", "DRAFT"],
  CANCELLED: ["DRAFT"],
};

export function canTransition(from: ContentStatus, to: ContentStatus): boolean {
  return from === to || CONTENT_TRANSITIONS[from].includes(to);
}

/** States in which content is locked because a publishing job owns it. */
export const LOCKED_STATUSES: readonly ContentStatus[] = ["QUEUED", "PUBLISHING", "VERIFYING"];

export function isLocked(status: ContentStatus) {
  return LOCKED_STATUSES.includes(status);
}

export const CONTENT_STATUS_LABEL: Record<ContentStatus, string> = {
  DRAFT: "Draft",
  VALIDATING: "Validating",
  READY_FOR_REVIEW: "Ready for review",
  APPROVED: "Approved",
  QUEUED: "Queued",
  PUBLISHING: "Publishing",
  VERIFYING: "Verifying",
  PUBLISHED: "Published",
  VALIDATION_FAILED: "Validation failed",
  PUBLISH_FAILED: "Publish failed",
  VERIFICATION_FAILED: "Verification failed",
  CANCELLED: "Cancelled",
};
