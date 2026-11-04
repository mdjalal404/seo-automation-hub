import "server-only";
import { unwrap } from "@/lib/actions/result";
import { assertCan, type SessionContext } from "@/lib/auth/session";
import type { CmsConnectionRow, WebsiteRow } from "@/lib/database/types";
import { allowPrivateNetworkTargets } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { normalizeWebsiteUrl } from "@/lib/security/url";
import { audit } from "@/lib/services/audit";
import { websiteSchema } from "@/lib/validation/schemas";

const CONNECTION_COLUMNS = "id, organization_id, website_id, connection_type, metadata, connection_status, last_tested_at, last_error, created_at, updated_at";

export type WebsiteListItem = WebsiteRow & {
  client: { id: string; name: string } | null;
  connection: Pick<CmsConnectionRow, "connection_status" | "last_tested_at" | "metadata"> | null;
  pending_jobs: number;
};

export async function listWebsites(ctx: SessionContext, opts: { clientId?: string } = {}): Promise<WebsiteListItem[]> {
  let q = ctx.supabase.from("websites").select("*, clients(id, name)").eq("organization_id", ctx.org.id).order("name");
  if (opts.clientId) q = q.eq("client_id", opts.clientId);
  const sites = unwrap(await q) ?? [];
  if (!sites.length) return [];
  const ids = sites.map((s) => s.id);
  // Connections are visible to owners/admins only (RLS); others simply see none.
  const conns = unwrap(await ctx.supabase.from("cms_connections").select(CONNECTION_COLUMNS).in("website_id", ids)) ?? [];
  const jobs = unwrap(await ctx.supabase.from("content_jobs").select("website_id").eq("organization_id", ctx.org.id).in("website_id", ids).in("status", ["QUEUED", "RETRY_SCHEDULED", "VALIDATING", "PUBLISHING", "VERIFYING"])) ?? [];
  return sites.map((s) => ({
    ...(s as WebsiteRow),
    client: (s.clients as { id: string; name: string } | null) ?? null,
    connection: (conns.find((c) => c.website_id === s.id) as CmsConnectionRow | undefined) ?? null,
    pending_jobs: jobs.filter((j) => j.website_id === s.id).length,
  }));
}

export async function getWebsite(ctx: SessionContext, id: string) {
  const site = unwrap(await ctx.supabase.from("websites").select("*, clients(id, name)").eq("id", id).eq("organization_id", ctx.org.id).maybeSingle());
  if (!site) throw new AppError("NOT_FOUND", "Website not found.");
  const connection = unwrap(await ctx.supabase.from("cms_connections").select(CONNECTION_COLUMNS).eq("website_id", id).maybeSingle()) as CmsConnectionRow | null;
  return { website: site as WebsiteRow & { clients: { id: string; name: string } }, connection };
}

export async function createWebsite(ctx: SessionContext, input: unknown) {
  assertCan(ctx, "websites.manage");
  const v = websiteSchema.parse(input);
  const baseUrl = normalizeWebsiteUrl(v.baseUrl, { allowPrivate: allowPrivateNetworkTargets() });
  const row = unwrap(await ctx.supabase.from("websites").insert({
    organization_id: ctx.org.id, client_id: v.clientId, name: v.name, base_url: baseUrl, timezone: v.timezone, cms_type: v.cmsType,
    publishing_settings: { max_concurrency: v.maxConcurrency, min_request_interval_ms: 500 },
  }).select("id").single());
  await audit(ctx, "website.created", "website", row.id, { base_url: baseUrl, platform: v.cmsType });
  return row.id as string;
}

export async function updateWebsite(ctx: SessionContext, id: string, input: unknown) {
  assertCan(ctx, "websites.manage");
  const v = websiteSchema.parse(input);
  const { website, connection } = await getWebsite(ctx, id);
  const baseUrl = normalizeWebsiteUrl(v.baseUrl, { allowPrivate: allowPrivateNetworkTargets() });
  if (connection && baseUrl !== website.base_url) {
    throw new AppError("CONFLICT", "Disconnect the CMS before changing the website address, then reconnect with the new address.");
  }
  if (connection && v.cmsType !== website.cms_type) {
    throw new AppError("CONFLICT", "Disconnect the CMS before changing the platform, then reconnect with credentials for the new platform.");
  }
  unwrap(await ctx.supabase.from("websites").update({
    client_id: v.clientId, name: v.name, base_url: baseUrl, timezone: v.timezone, cms_type: v.cmsType,
    publishing_settings: { ...website.publishing_settings, max_concurrency: v.maxConcurrency },
  }).eq("id", id).eq("organization_id", ctx.org.id));
  await audit(ctx, "website.updated", "website", id);
}

export async function deleteWebsite(ctx: SessionContext, id: string) {
  assertCan(ctx, "websites.manage");
  const active = unwrap(await ctx.supabase.from("content_jobs").select("id").eq("website_id", id).in("status", ["VALIDATING", "PUBLISHING", "VERIFYING"]).limit(1));
  if (active?.length) throw new AppError("CONFLICT", "This website has jobs in progress. Wait for them to finish first.");
  const rows = unwrap(await ctx.supabase.from("websites").delete().eq("id", id).eq("organization_id", ctx.org.id).select("id"));
  if (!rows?.length) throw new AppError("NOT_FOUND", "Website not found.");
  await audit(ctx, "website.deleted", "website", id);
}
