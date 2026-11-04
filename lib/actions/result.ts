import "server-only";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { isAppError, postgresMessage, toUserMessage } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { fieldErrors } from "@/lib/validation/schemas";

export type ActionResult<T = undefined> =
  | { ok: true; data?: T; message?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

/** Runs a server action body with consistent, secret-free error handling. */
export async function runAction<T = undefined>(name: string, fn: () => Promise<T | ActionResult<T> | void>): Promise<ActionResult<T>> {
  try {
    const out = await fn();
    if (out && typeof out === "object" && "ok" in out) return out as ActionResult<T>;
    return { ok: true, data: (out ?? undefined) as T };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof z.ZodError) return { ok: false, error: "Please correct the highlighted fields.", fieldErrors: fieldErrors(err) };
    if (isAppError(err) || postgresMessage(err)) {
      logger.info("action.rejected", { action: name, code: isAppError(err) ? err.code : (err as { code?: string }).code });
    } else {
      logger.error("action.failed", { action: name, error: err });
    }
    return { ok: false, error: toUserMessage(err) };
  }
}

/**
 * Throws the database error so runAction can map it to a safe message.
 * `.single()` results are non-null once error is null; `.maybeSingle()` callers must null-check.
 */
export function unwrap<T>(res: { data: T; error: unknown }): NonNullable<T> {
  if (res.error) throw res.error;
  return res.data as NonNullable<T>;
}
