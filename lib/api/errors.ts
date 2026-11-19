import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { isAppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";

/** JSON error responses for the public API (no stack traces or upstream details). */
export function apiError(err: unknown) {
  if (err instanceof ZodError) return NextResponse.json({ error: "Invalid request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, { status: 400 });
  if (isAppError(err)) {
    const status = { UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, RATE_LIMITED: 429, CONFLICT: 409 }[err.code as string] ?? 400;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  logger.error("api.v1.error", { error: err });
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}
