import "server-only";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { AppError } from "@/lib/errors";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Persistent fixed-window rate limiting backed by Postgres (works across serverless
 * instances). Keys are hashed so emails/IPs are not stored in clear text.
 */
export async function enforceRateLimit(scope: string, identifier: string, limit: number, windowSeconds: number) {
  const key = `${scope}:${createHash("sha256").update(identifier.toLowerCase()).digest("hex").slice(0, 32)}`;
  const { data, error } = await createAdminClient().rpc("check_rate_limit", { p_key: key, p_limit: limit, p_window_seconds: windowSeconds });
  if (error) throw new AppError("INTERNAL", "Rate limiter unavailable.", { cause: error });
  if (data === false) {
    throw new AppError("RATE_LIMITED", "Too many attempts. Please wait a few minutes and try again.");
  }
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}
