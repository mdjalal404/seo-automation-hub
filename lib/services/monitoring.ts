import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { unwrap } from "@/lib/actions/result";
import { assertCan, type SessionContext } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import { sameHostUrls } from "@/lib/indexing/indexnow";
import type { GateResult } from "@/lib/monitoring/gate";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { audit } from "@/lib/services/audit";
import { enqueueTask } from "@/lib/services/seo";
import { getWebsite } from "@/lib/services/websites";
import { createAdminClient } from "@/lib/supabase/admin";
import { uuid } from "@/lib/validation/schemas";

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
export type AlertRow = {
  id: string; website_id: string; source: string; kind: string; severity: "critical" | "warning" | "info"; title: string; url: string | null; evidence: string[];
  status: string; occurrences: number; first_seen_at: string; last_seen_at: string; resolved_at: string | null; resolved_reason: string | null; notified: Record<string, string>;
};

export async function listAlerts(ctx: SessionContext, websiteId: string, status: "open" | "resolved" = "open") {
  let q = ctx.supabase.from("seo_alerts").select("*").eq("website_id", websiteId).eq("organization_id", ctx.org.id);
  q = status === "open" ? q.neq("status", "resolved") : q.eq("status", "resolved");
  const rows = (unwrap(await q.order("last_seen_at", { ascending: false }).limit(200)) ?? []) as AlertRow[];
  const rank = { critical: 0, warning: 1, info: 2 };
  return status === "open" ? rows.sort((a, b) => rank[a.severity] - rank[b.severity] || b.last_seen_at.localeCompare(a.last_seen_at)) : rows;
}

export async function updateAlert(ctx: SessionContext, id: string, action: "acknowledge" | "resolve" | "reopen") {
  assertCan(ctx, "seo.run");
  const alert = unwrap(await ctx.supabase.from("seo_alerts").select("id, status").eq("id", uuid.parse(id)).eq("organization_id", ctx.org.id).maybeSingle()) as { id: string; status: string } | null;
  if (!alert) throw new AppError("NOT_FOUND", "Alert not found.");
  const patch = action === "acknowledge" ? { status: "acknowledged", acknowledged_by: ctx.user.id }
    : action === "resolve" ? { status: "resolved", resolved_at: new Date().toISOString(), resolved_reason: "Resolved by a team member" }
    : { status: "open", resolved_at: null, resolved_reason: null };
  const { error } = await createAdminClient().from("seo_alerts").update(patch).eq("id", alert.id).eq("organization_id", ctx.org.id);
  if (error) {
    if ((error as { code?: string }).code === "23505") throw new AppError("CONFLICT", "The same problem already has an open alert.");
    throw error;
  }
  await audit(ctx, `alert.${action}`, "seo_alert", alert.id);
}

// ---------------------------------------------------------------------------
// IndexNow (manual submission; publishing and audits submit automatically)
// ---------------------------------------------------------------------------
export async function submitUrlsToIndexNow(ctx: SessionContext, websiteId: string, text: string) {
  const { website } = await getWebsite(ctx, uuid.parse(websiteId));
  const lines = text.split(/\s+/).filter(Boolean);
  if (!lines.length) throw new AppError("INVALID_INPUT", "Enter at least one URL.");
  const urls = sameHostUrls(website.base_url, lines);
  if (!urls.length) throw new AppError("INVALID_INPUT", `None of the URLs are on ${new URL(website.base_url).host}. IndexNow only accepts URLs on the key's host.`);
  const { data } = await ctx.supabase.from("integrations").select("id").eq("website_id", website.id).eq("provider", "indexnow").maybeSingle();
  if (!data) throw new AppError("CONFIG_MISSING", "Connect IndexNow for this website first (Integrations & autopilot).");
  await enqueueTask(ctx, website.id, "INDEXNOW_SUBMIT", { urls, reason: "Submitted manually" });
  return { queued: urls.length, skipped: lines.length - urls.length };
}

// ---------------------------------------------------------------------------
// SEO deploy gate
// ---------------------------------------------------------------------------
export const gateInputSchema = z.object({
  website_id: uuid,
  target_base_url: z.string().trim().max(500).regex(/^https?:\/\/[^\s/]+\/?$/i, "Use an origin such as https://preview.example.com").optional().or(z.literal("").transform(() => undefined)),
  paths: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  max_urls: z.coerce.number().int().min(1).max(50).default(20),
  fail_on: z.enum(["error", "warning"]).default("error"),
  allow_noindex: z.coerce.boolean().default(false),
});
const toParams = (v: z.infer<typeof gateInputSchema>, source: "app" | "api") => ({ targetBaseUrl: v.target_base_url, paths: v.paths, maxUrls: v.max_urls, failOn: v.fail_on, allowNoindex: v.allow_noindex, source });

export async function runGateFromApp(ctx: SessionContext, input: unknown) {
  const v = gateInputSchema.parse(input);
  return enqueueTask(ctx, v.website_id, "SEO_GATE", toParams(v, "app"));
}

export async function listGateRuns(ctx: SessionContext, limit = 20) {
  return (unwrap(await ctx.supabase.from("automation_tasks").select("id, website_id, status, progress, params, result, error_message, created_at, completed_at")
    .eq("organization_id", ctx.org.id).eq("task_type", "SEO_GATE").order("created_at", { ascending: false }).limit(limit)) ?? []) as {
    id: string; website_id: string; status: string; progress: string | null; params: Record<string, unknown>; result: Partial<GateResult> & { source?: string }; error_message: string | null; created_at: string; completed_at: string | null;
  }[];
}

// ---------------------------------------------------------------------------
// API keys: "seoh_<prefix>_<secret>". Only SHA-256(key) is stored.
// ---------------------------------------------------------------------------
export type ApiKeyRow = { id: string; name: string; prefix: string; scopes: string[]; created_at: string; last_used_at: string | null; revoked_at: string | null };
const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
const KEY_RE = /^seoh_([a-z0-9]{10})_([A-Za-z0-9_-]{43})$/;

export async function listApiKeys(ctx: SessionContext) {
  return (unwrap(await ctx.supabase.from("api_keys").select("id, name, prefix, scopes, created_at, last_used_at, revoked_at").eq("organization_id", ctx.org.id).order("created_at", { ascending: false })) ?? []) as ApiKeyRow[];
}

export async function createApiKey(ctx: SessionContext, name: string) {
  assertCan(ctx, "integrations.manage");
  const n = z.string().trim().min(1, "Name the key (e.g. GitHub Actions).").max(100).parse(name);
  await enforceRateLimit("api-key-create", ctx.user.id, 10, 3600);
  const prefix = randomBytes(8).toString("hex").slice(0, 10).replace(/[^a-z0-9]/g, "0");
  const key = `seoh_${prefix}_${randomBytes(32).toString("base64url")}`;
  const { data, error } = await createAdminClient().from("api_keys").insert({ organization_id: ctx.org.id, name: n, prefix, key_hash: hashKey(key), scopes: ["gate"], created_by: ctx.user.id }).select("id").single();
  if (error) throw error;
  await audit(ctx, "api_key.created", "api_key", data.id, { name: n, prefix });
  return { id: data.id as string, key };
}

export async function revokeApiKey(ctx: SessionContext, id: string) {
  assertCan(ctx, "integrations.manage");
  const { data, error } = await createAdminClient().from("api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", uuid.parse(id)).eq("organization_id", ctx.org.id).is("revoked_at", null).select("id");
  if (error) throw error;
  if (!data?.length) throw new AppError("NOT_FOUND", "API key not found or already revoked.");
  await audit(ctx, "api_key.revoked", "api_key", id);
}

export type ApiPrincipal = { keyId: string; organizationId: string; scopes: string[] };

/** Resolves `Authorization: Bearer seoh_…`. Lookup by prefix, constant-time hash comparison. */
export async function authenticateApiKey(header: string | null): Promise<ApiPrincipal> {
  const key = header?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
  const m = KEY_RE.exec(key);
  if (!m) throw new AppError("UNAUTHENTICATED", "Missing or malformed API key. Send Authorization: Bearer seoh_….");
  const db = createAdminClient();
  const { data } = await db.from("api_keys").select("id, organization_id, key_hash, scopes, revoked_at").eq("prefix", m[1]).maybeSingle();
  const expected = Buffer.from((data?.key_hash as string | undefined) ?? "0".repeat(64), "hex");
  const valid = timingSafeEqual(expected, Buffer.from(hashKey(key), "hex"));
  if (!data || !valid || data.revoked_at) throw new AppError("UNAUTHENTICATED", "Invalid or revoked API key.");
  await db.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
  return { keyId: data.id as string, organizationId: data.organization_id as string, scopes: data.scopes as string[] };
}

export async function createGateFromApi(p: ApiPrincipal, input: unknown) {
  if (!p.scopes.includes("gate")) throw new AppError("FORBIDDEN", "This API key cannot run the deploy gate.");
  const v = gateInputSchema.parse(input);
  await enforceRateLimit("api-gate", p.keyId, 60, 3600);
  const db = createAdminClient();
  const { data: site } = await db.from("websites").select("id").eq("id", v.website_id).eq("organization_id", p.organizationId).maybeSingle();
  if (!site) throw new AppError("NOT_FOUND", "Website not found for this API key's workspace.");
  const { data, error } = await db.from("automation_tasks").insert({
    organization_id: p.organizationId, website_id: v.website_id, task_type: "SEO_GATE", params: toParams(v, "api"), max_attempts: 2,
    idempotency_key: `api:${p.keyId}:${randomBytes(8).toString("hex")}`,
  }).select("id").single();
  if (error) throw error;
  await db.from("audit_logs").insert({ organization_id: p.organizationId, user_id: null, action: "gate.queued_via_api", resource_type: "automation_task", resource_id: data.id, metadata: { api_key_id: p.keyId, website_id: v.website_id } });
  return data.id as string;
}

export async function getGateFromApi(p: ApiPrincipal, id: string) {
  const { data } = await createAdminClient().from("automation_tasks").select("id, status, progress, result, error_message, created_at, completed_at")
    .eq("id", uuid.parse(id)).eq("organization_id", p.organizationId).eq("task_type", "SEO_GATE").maybeSingle();
  if (!data) throw new AppError("NOT_FOUND", "Gate run not found.");
  return data as { id: string; status: string; progress: string | null; result: Partial<GateResult>; error_message: string | null; created_at: string; completed_at: string | null };
}
