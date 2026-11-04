import { z } from "zod";
import { AppError } from "@/lib/errors";

/**
 * Environment configuration.
 * - NEXT_PUBLIC_* values are embedded in browser bundles: never put secrets there.
 * - Server-only secrets are read lazily and validated on first use so pages can
 *   render a helpful setup screen instead of crashing.
 */
const publicSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
});

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  CREDENTIAL_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 random bytes, base64-encoded"),
  CREDENTIAL_ENCRYPTION_KEY_ID: z.string().regex(/^[a-z0-9]{1,16}$/).default("k1"),
  CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS: z.string().optional(),
  CRON_SECRET: z.string().min(16).optional(),
});

export type AppEnvironment = "development" | "test" | "production";

export function appEnvironment(): AppEnvironment {
  const v = process.env.APP_ENV;
  if (v === "development" || v === "test" || v === "production") return v;
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

/** Private-network targets (e.g. the local mock WordPress) are never allowed in production. */
export function allowPrivateNetworkTargets(): boolean {
  return appEnvironment() !== "production" && process.env.ALLOW_PRIVATE_NETWORK_TARGETS === "true";
}

export function getPublicEnv() {
  const parsed = publicSchema.safeParse({
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  if (!parsed.success) {
    throw new AppError("CONFIG_MISSING", `Missing or invalid configuration: ${describe(parsed.error)}`);
  }
  return parsed.data;
}

export function getServerEnv() {
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new AppError("CONFIG_MISSING", `Missing or invalid server configuration: ${describe(parsed.error)}`);
  }
  return parsed.data;
}

/** Returns a list of configuration problems (names only — never values). */
export function configurationProblems(): string[] {
  const problems: string[] = [];
  const pub = publicSchema.safeParse({
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  if (!pub.success) problems.push(...pub.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const srv = serverSchema.safeParse(process.env);
  if (!srv.success) problems.push(...srv.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  return problems;
}

function describe(error: z.ZodError) {
  return error.issues.map((i) => i.path.join(".")).join(", ");
}
