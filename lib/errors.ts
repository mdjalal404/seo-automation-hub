/**
 * Application error with a stable code, a user-safe message, and retryability.
 * Never put secrets, credentials, or raw upstream bodies into `message`.
 */
export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "CONFIG_MISSING"
  | "UNSAFE_URL"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "RESPONSE_TOO_LARGE"
  | "WP_AUTH_FAILED"
  | "WP_FORBIDDEN"
  | "WP_NOT_FOUND"
  | "WP_BAD_REQUEST"
  | "WP_RATE_LIMITED"
  | "WP_SERVER_ERROR"
  | "WP_UNEXPECTED_RESPONSE"
  | "CMS_AUTH_FAILED"
  | "CMS_FORBIDDEN"
  | "CMS_NOT_FOUND"
  | "CMS_BAD_REQUEST"
  | "CMS_RATE_LIMITED"
  | "CMS_SERVER_ERROR"
  | "CMS_UNEXPECTED_RESPONSE"
  | "VALIDATION_FAILED"
  | "APPROVAL_INVALID"
  | "VERIFICATION_FAILED"
  | "MAX_ATTEMPTS_EXCEEDED"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  /** True when a mutating request may or may not have been applied upstream. */
  readonly ambiguous: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { retryable?: boolean; ambiguous?: boolean; status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "AppError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.ambiguous = opts.ambiguous ?? false;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** Converts any thrown value into a user-safe message without leaking internals. */
export function toUserMessage(err: unknown): string {
  if (isAppError(err)) return err.message;
  const pg = postgresMessage(err);
  if (pg) return pg;
  return "Something went wrong. The error has been logged.";
}

/**
 * Postgres errors raised deliberately by our RPCs (check_violation / insufficient_privilege /
 * no_data_found) carry user-safe messages. Other database errors are not shown verbatim.
 */
export function postgresMessage(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { code?: string; message?: string };
  if (!e.message) return null;
  if (e.code === "23514" || e.code === "P0002") return e.message;
  if (e.code === "42501") return "You do not have permission to perform this action.";
  if (e.code === "23505") return "This would create a duplicate (an equivalent record or active job already exists).";
  if (e.code === "23503") return "A related record does not exist or belongs to another workspace.";
  return null;
}
