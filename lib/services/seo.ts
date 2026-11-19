import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { unwrap } from "@/lib/actions/result";
import { generationInputSchema } from "@/lib/ai/content-pipeline";
import { llmStatus } from "@/lib/ai/llm";
import { integrationInputSchema, parseMarkets, sealSecret, toSecret } from "@/lib/analytics/credentials";
import {
  clarityInsights, databricksSql, dfsUserData, mixpanelSegmentation, validateDatabricks, ga4OrganicReport, gscListSites, isProvider, pagespeed, parseServiceAccount, PROVIDER_INFO, similarwebTraffic,
  type ProviderId,
} from "@/lib/analytics/providers";
import { assertCan, type SessionContext } from "@/lib/auth/session";
import type { ContentRow } from "@/lib/database/types";
import { AppError } from "@/lib/errors";
import { parseFeed, renderPages, templateSchema } from "@/lib/programmatic/templates";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { safeFetch } from "@/lib/security/safe-fetch";
import { aiReadiness } from "@/lib/seo/ai-visibility";
import { parseHtml, renderBody } from "@/lib/seo/html";
import { insertLink, suggestInternalLinks, type LinkTarget } from "@/lib/seo/internal-links";
import { classifyIntent, clusterKeywords, parseKeywordList } from "@/lib/seo/keywords";
import { generateSchema, schemaOptionsSchema, validateSchema } from "@/lib/seo/schema-generator";
import { keyLocation, verifyKeyFile } from "@/lib/indexing/indexnow";
import { appLink } from "@/lib/monitoring/alerts";
import { sendSlack, sendWebhook } from "@/lib/monitoring/notify";
import { audit } from "@/lib/services/audit";
import { getContent } from "@/lib/services/content";
import { getWebsite } from "@/lib/services/websites";
import { createAdminClient } from "@/lib/supabase/admin";
import type { TaskType } from "@/lib/tasks/runner";
import { uuid } from "@/lib/validation/schemas";

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
export type TaskListItem = {
  id: string; website_id: string; task_type: TaskType; status: string; progress: string | null; params: Record<string, unknown>; result: Record<string, unknown>;
  error_message: string | null; attempts: number; created_at: string; started_at: string | null; completed_at: string | null; schedule_id: string | null;
};

const TASK_CAPABILITY: Record<TaskType, Parameters<typeof assertCan>[1]> = {
  SITE_AUDIT: "seo.run", ANALYTICS_SYNC: "seo.run", RANK_CHECK: "seo.run", AI_VISIBILITY_CHECK: "ai.generate", GENERATE_CONTENT: "ai.generate",
  AGENT_RUN: "ai.generate", CONTENT_QA: "ai.generate", WAREHOUSE_EXPORT: "integrations.manage", INDEXNOW_SUBMIT: "seo.run", SEO_GATE: "seo.run",
};

export async function enqueueTask(ctx: SessionContext, websiteId: string, type: TaskType, params: Record<string, unknown>, requestKey: string = randomUUID()) {
  assertCan(ctx, TASK_CAPABILITY[type]);
  await getWebsite(ctx, uuid.parse(websiteId)); // RLS-scoped: proves the website belongs to this workspace
  await enforceRateLimit(`task:${type}`, ctx.user.id, type === "GENERATE_CONTENT" ? 30 : 20, 3600);
  const { data, error } = await createAdminClient().from("automation_tasks").insert({
    organization_id: ctx.org.id, website_id: websiteId, task_type: type, params, created_by: ctx.user.id,
    idempotency_key: `user:${requestKey}`.slice(0, 300), max_attempts: type === "GENERATE_CONTENT" ? 2 : 3,
  }).select("id").single();
  if (error) {
    if ((error as { code?: string }).code === "23505") throw new AppError("CONFLICT", "This task is already queued or running for this website.");
    throw error;
  }
  await audit(ctx, "task.queued", "automation_task", data.id, { type, website_id: websiteId });
  return data.id as string;
}

export async function listTasks(ctx: SessionContext, f: { websiteId?: string; type?: TaskType; limit?: number } = {}): Promise<TaskListItem[]> {
  let q = ctx.supabase.from("automation_tasks").select("id, website_id, task_type, status, progress, params, result, error_message, attempts, created_at, started_at, completed_at, schedule_id")
    .eq("organization_id", ctx.org.id).order("created_at", { ascending: false }).limit(f.limit ?? 50);
  if (f.websiteId) q = q.eq("website_id", f.websiteId);
  if (f.type) q = q.eq("task_type", f.type);
  return (unwrap(await q) ?? []) as TaskListItem[];
}

export async function cancelTask(ctx: SessionContext, id: string) {
  assertCan(ctx, "seo.run");
  const rows = unwrap(await createAdminClient().from("automation_tasks").update({ status: "CANCELLED", completed_at: new Date().toISOString() })
    .eq("id", uuid.parse(id)).eq("organization_id", ctx.org.id).eq("status", "QUEUED").select("id"));
  if (!rows?.length) throw new AppError("CONFLICT", "Only queued tasks can be cancelled; running tasks finish on their own.");
}

// ---------------------------------------------------------------------------
// AI content generation
// ---------------------------------------------------------------------------
export async function queueGeneration(ctx: SessionContext, input: unknown, requestKey: string) {
  const v = generationInputSchema.parse(input);
  if (!llmStatus().configured) throw new AppError("CONFIG_MISSING", "AI generation needs ANTHROPIC_API_KEY on the server.");
  return enqueueTask(ctx, v.websiteId, "GENERATE_CONTENT", v, `generate:${requestKey}`);
}

// ---------------------------------------------------------------------------
// Keywords & clustering
// ---------------------------------------------------------------------------
export type KeywordRow = {
  id: string; keyword: string; search_volume: number | null; difficulty: number | null; cpc: number | null; intent: string | null; position: number | null;
  ranking_url: string | null; source: string; tracked: boolean; cluster_id: string | null; metrics: Record<string, unknown>; position_checked_at: string | null;
};
export type ClusterRow = { id: string; name: string; head_keyword: string; intent: string; total_volume: number; keyword_count: number; content_item_id: string | null; target_url: string | null };

export async function listKeywords(ctx: SessionContext, websiteId: string) {
  const [kw, cl] = await Promise.all([
    ctx.supabase.from("keywords").select("*").eq("website_id", websiteId).eq("organization_id", ctx.org.id).order("search_volume", { ascending: false, nullsFirst: false }).limit(2000),
    ctx.supabase.from("keyword_clusters").select("*").eq("website_id", websiteId).eq("organization_id", ctx.org.id).order("total_volume", { ascending: false }).limit(500),
  ]);
  return { keywords: (unwrap(kw) ?? []) as KeywordRow[], clusters: (unwrap(cl) ?? []) as ClusterRow[] };
}

export async function addKeywords(ctx: SessionContext, websiteId: string, text: string) {
  assertCan(ctx, "keywords.manage");
  await getWebsite(ctx, websiteId);
  const parsed = parseKeywordList(z.string().max(500_000).parse(text));
  if (!parsed.length) throw new AppError("INVALID_INPUT", "Paste one keyword per line (optionally “keyword,volume”).");
  const rows = parsed.map((k) => ({ organization_id: ctx.org.id, website_id: websiteId, keyword: k.keyword, search_volume: k.volume, intent: classifyIntent(k.keyword), source: "manual" }));
  unwrap(await ctx.supabase.from("keywords").upsert(rows, { onConflict: "website_id,keyword", ignoreDuplicates: true }));
  return parsed.length;
}

export async function updateKeywords(ctx: SessionContext, websiteId: string, ids: string[], change: { tracked?: boolean; delete?: boolean }) {
  assertCan(ctx, "keywords.manage");
  const list = z.array(uuid).min(1).max(2000).parse(ids);
  const q = change.delete
    ? ctx.supabase.from("keywords").delete().in("id", list).eq("website_id", websiteId).eq("organization_id", ctx.org.id)
    : ctx.supabase.from("keywords").update({ tracked: !!change.tracked }).in("id", list).eq("website_id", websiteId).eq("organization_id", ctx.org.id);
  unwrap(await q);
}

/** Re-clusters all keywords of a website (replaces previous clusters, keeps page mappings by head keyword). */
export async function runClustering(ctx: SessionContext, websiteId: string, similarity = 0.5) {
  assertCan(ctx, "keywords.manage");
  const { keywords, clusters: old } = await listKeywords(ctx, websiteId);
  if (keywords.length < 2) throw new AppError("INVALID_INPUT", "Add at least two keywords to cluster.");
  const clusters = clusterKeywords(keywords.map((k) => ({ id: k.id, keyword: k.keyword, volume: k.search_volume, serpUrls: Array.isArray(k.metrics?.serp_urls) ? (k.metrics.serp_urls as string[]) : undefined })), { similarity });
  const mapping = new Map(old.map((c) => [c.head_keyword, c]));
  unwrap(await ctx.supabase.from("keywords").update({ cluster_id: null }).eq("website_id", websiteId).eq("organization_id", ctx.org.id));
  unwrap(await ctx.supabase.from("keyword_clusters").delete().eq("website_id", websiteId).eq("organization_id", ctx.org.id));
  const inserted = unwrap(await ctx.supabase.from("keyword_clusters").insert(clusters.map((c) => ({
    organization_id: ctx.org.id, website_id: websiteId, name: c.name.slice(0, 200), head_keyword: c.head, intent: c.intent,
    total_volume: c.totalVolume, keyword_count: c.keywords.length,
    content_item_id: mapping.get(c.head)?.content_item_id ?? null, target_url: mapping.get(c.head)?.target_url ?? keywords.find((k) => k.keyword === c.head)?.ranking_url ?? null,
  }))).select("id, head_keyword")) as { id: string; head_keyword: string }[];
  const idByHead = new Map(inserted.map((r) => [r.head_keyword, r.id]));
  for (const c of clusters) {
    const ids = c.keywords.map((k) => k.id!).filter(Boolean);
    if (ids.length) unwrap(await ctx.supabase.from("keywords").update({ cluster_id: idByHead.get(c.head) }).in("id", ids));
  }
  return clusters.length;
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------
export type IntegrationRow = { id: string; website_id: string; provider: ProviderId; metadata: Record<string, unknown>; status: string; last_synced_at: string | null; last_error: string | null; updated_at: string };

export async function listIntegrations(ctx: SessionContext, websiteId: string): Promise<IntegrationRow[]> {
  const rows = unwrap(await ctx.supabase.from("integrations").select("id, website_id, provider, metadata, status, last_synced_at, last_error, updated_at")
    .eq("website_id", websiteId).eq("organization_id", ctx.org.id));
  return (rows ?? []) as IntegrationRow[];
}

const siteMatches = (prop: string, host: string) => {
  const h = host.replace(/^www\./, "");
  if (prop.startsWith("sc-domain:")) return h === prop.slice(10) || h.endsWith(`.${prop.slice(10)}`);
  try {
    return new URL(prop).hostname.replace(/^www\./, "") === h;
  } catch {
    return false;
  }
};

/** Verifies the credentials against the provider before storing them encrypted. */
export async function connectIntegration(ctx: SessionContext, input: unknown) {
  assertCan(ctx, "integrations.manage");
  const v = integrationInputSchema.parse(input);
  await enforceRateLimit("integration-connect", ctx.user.id, 15, 600);
  const { website } = await getWebsite(ctx, v.websiteId);
  const host = new URL(website.base_url).hostname;
  const secret = toSecret(v);
  let metadata: Record<string, unknown> = {};
  switch (v.provider) {
    case "google_search_console": {
      const sa = parseServiceAccount(v.serviceAccount);
      const sites = await gscListSites(safeFetch, sa);
      const siteUrl = v.siteUrl || sites.find((s) => siteMatches(s, host));
      if (!siteUrl || !sites.includes(siteUrl)) {
        throw new AppError("CMS_FORBIDDEN", sites.length
          ? `The service account can access ${sites.slice(0, 3).join(", ")}, but not a property for ${host}. Add ${sa.client_email} to the right property or enter its URL.`
          : `The service account has no Search Console properties. Add ${sa.client_email} as a user on the property for ${host}.`);
      }
      metadata = { site_url: siteUrl, service_account: sa.client_email };
      break;
    }
    case "google_analytics_4": {
      const sa = parseServiceAccount(v.serviceAccount);
      const today = new Date().toISOString().slice(0, 10);
      await ga4OrganicReport(safeFetch, sa, v.propertyId, today, today);
      metadata = { property_id: v.propertyId, service_account: sa.client_email };
      break;
    }
    case "microsoft_clarity":
      // Note: counts against Clarity's 10 requests/day project quota.
      await clarityInsights(safeFetch, v.apiToken, 1);
      break;
    case "dataforseo": {
      const user = await dfsUserData(safeFetch, { login: v.login, password: v.password });
      metadata = { login: user.login, balance: user.balance, location_code: v.locationCode, language_code: v.languageCode, markets: parseMarkets(v.markets) };
      break;
    }
    case "similarweb": {
      const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
      const ym = d.toISOString().slice(0, 7);
      await similarwebTraffic(safeFetch, v.apiKey, host, ym, ym);
      metadata = { domain: host.replace(/^www\./, "") };
      break;
    }
    case "pagespeed":
      await pagespeed(safeFetch, v.apiKey || null, website.base_url, "mobile");
      metadata = { has_key: !!v.apiKey };
      break;
    case "mixpanel": {
      const day = new Date().toISOString().slice(0, 10);
      await mixpanelSegmentation(safeFetch, { username: v.username, secret: v.secret, projectId: v.projectId, region: v.region }, { event: v.event, on: v.segmentProperty, where: v.where || undefined, from: day, to: day });
      metadata = { project_id: v.projectId, region: v.region, event: v.event, segment_property: v.segmentProperty, where: v.where, username: v.username };
      break;
    }
    case "databricks": {
      const c = validateDatabricks({ host: v.host, token: v.token, warehouseId: v.warehouseId, catalog: v.catalog, schema: v.schema });
      await databricksSql(safeFetch, c, "SELECT 1");
      metadata = { host: c.host, warehouse_id: c.warehouseId, catalog: c.catalog, schema: c.schema };
      break;
    }
    case "slack": {
      // Test message proves the webhook works before it is stored.
      await sendSlack(safeFetch, v.webhookUrl, { website, alerts: [], link: appLink(`/monitoring?website=${website.id}`), test: true });
      metadata = { min_severity: v.minSeverity, channel_hint: "Slack incoming webhook" };
      break;
    }
    case "webhook": {
      await sendWebhook(safeFetch, v.url, v.signingSecret, { website, alerts: [], link: appLink(`/monitoring?website=${website.id}`), test: true });
      metadata = { min_severity: v.minSeverity, endpoint_host: new URL(v.url).host };
      break;
    }
    case "indexnow": {
      await verifyKeyFile(safeFetch, website.base_url, v.key);
      metadata = { key_location: keyLocation(website.base_url, v.key), auto_submit: v.autoSubmit === "on" };
      break;
    }
  }
  unwrap(await createAdminClient().from("integrations").upsert({
    organization_id: ctx.org.id, website_id: website.id, provider: v.provider, encrypted_credentials: sealSecret(secret, ctx.org.id, website.id),
    metadata, status: "connected", last_error: null,
  }, { onConflict: "website_id,provider" }));
  await audit(ctx, "integration.connected", "website", website.id, { provider: v.provider });
  return PROVIDER_INFO[v.provider].label;
}

export async function removeIntegration(ctx: SessionContext, websiteId: string, provider: string) {
  assertCan(ctx, "integrations.manage");
  if (!isProvider(provider)) throw new AppError("INVALID_INPUT", "Unknown integration.");
  const rows = unwrap(await ctx.supabase.from("integrations").delete().eq("website_id", websiteId).eq("organization_id", ctx.org.id).eq("provider", provider).select("id"));
  if (!rows?.length) throw new AppError("NOT_FOUND", "Integration not found.");
  await audit(ctx, "integration.removed", "website", websiteId, { provider });
}

// ---------------------------------------------------------------------------
// Schedules (autopilot)
// ---------------------------------------------------------------------------
export const scheduleInputSchema = z.object({
  websiteId: uuid,
  taskType: z.enum(["SITE_AUDIT", "ANALYTICS_SYNC", "AI_VISIBILITY_CHECK", "RANK_CHECK", "AGENT_RUN", "WAREHOUSE_EXPORT"]),
  cadence: z.enum(["daily", "weekly", "monthly"]),
  enabled: z.boolean().default(true),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

export async function listSchedules(ctx: SessionContext, websiteId?: string) {
  let q = ctx.supabase.from("automation_schedules").select("*").eq("organization_id", ctx.org.id).order("task_type");
  if (websiteId) q = q.eq("website_id", websiteId);
  return (unwrap(await q) ?? []) as { id: string; website_id: string; task_type: string; cadence: string; enabled: boolean; next_run_at: string; last_run_at: string | null; params: Record<string, unknown> }[];
}

export async function saveSchedule(ctx: SessionContext, input: unknown) {
  assertCan(ctx, "automation.manage");
  const v = scheduleInputSchema.parse(input);
  await getWebsite(ctx, v.websiteId);
  unwrap(await ctx.supabase.from("automation_schedules").upsert({
    organization_id: ctx.org.id, website_id: v.websiteId, task_type: v.taskType, cadence: v.cadence, enabled: v.enabled, params: v.params, created_by: ctx.user.id,
    next_run_at: new Date(Date.now() + 60_000).toISOString(),
  }, { onConflict: "website_id,task_type" }));
  await audit(ctx, "schedule.saved", "website", v.websiteId, { task_type: v.taskType, cadence: v.cadence, enabled: v.enabled });
}

export async function deleteSchedule(ctx: SessionContext, id: string) {
  assertCan(ctx, "automation.manage");
  unwrap(await ctx.supabase.from("automation_schedules").delete().eq("id", uuid.parse(id)).eq("organization_id", ctx.org.id));
}

// ---------------------------------------------------------------------------
// Audits
// ---------------------------------------------------------------------------
export type AuditRow = { id: string; website_id: string; task_id: string | null; score: number | null; pages_crawled: number; summary: Record<string, number>; site_checks: Record<string, unknown>; created_at: string };
export type AuditPageRow = { id: number; url: string; status_code: number | null; depth: number; title: string | null; meta_description: string | null; canonical: string | null; indexable: boolean | null; word_count: number | null; load_ms: number | null; inlinks: number; issues: string[]; details: Record<string, unknown> };

export async function listAudits(ctx: SessionContext, websiteId?: string) {
  let q = ctx.supabase.from("site_audits").select("*").eq("organization_id", ctx.org.id).order("created_at", { ascending: false }).limit(50);
  if (websiteId) q = q.eq("website_id", websiteId);
  return (unwrap(await q) ?? []) as AuditRow[];
}

export async function getAudit(ctx: SessionContext, id: string) {
  const a = unwrap(await ctx.supabase.from("site_audits").select("*").eq("id", uuid.parse(id)).eq("organization_id", ctx.org.id).maybeSingle()) as AuditRow | null;
  if (!a) throw new AppError("NOT_FOUND", "Audit not found.");
  const pages = (unwrap(await ctx.supabase.from("site_audit_pages").select("*").eq("audit_id", a.id).order("id").limit(1000)) ?? []) as AuditPageRow[];
  return { audit: a, pages };
}

// ---------------------------------------------------------------------------
// Programmatic templates
// ---------------------------------------------------------------------------
export type TemplateRow = { id: string; website_id: string; name: string; title_template: string; slug_template: string; meta_title_template: string; meta_description_template: string; excerpt_template: string; keyword_template: string; body_template: string; updated_at: string };

export async function listTemplates(ctx: SessionContext) {
  return (unwrap(await ctx.supabase.from("page_templates").select("*").eq("organization_id", ctx.org.id).order("updated_at", { ascending: false })) ?? []) as TemplateRow[];
}

function templateColumns(v: z.infer<typeof templateSchema>) {
  return {
    website_id: v.websiteId, name: v.name, title_template: v.titleTemplate, slug_template: v.slugTemplate, meta_title_template: v.metaTitleTemplate,
    meta_description_template: v.metaDescriptionTemplate, excerpt_template: v.excerptTemplate, keyword_template: v.keywordTemplate, body_template: v.bodyTemplate,
  };
}

export async function saveTemplate(ctx: SessionContext, id: string | null, input: unknown) {
  assertCan(ctx, "templates.manage");
  const v = templateSchema.parse(input);
  await getWebsite(ctx, v.websiteId);
  if (id) {
    unwrap(await ctx.supabase.from("page_templates").update(templateColumns(v)).eq("id", uuid.parse(id)).eq("organization_id", ctx.org.id));
    return id;
  }
  const row = unwrap(await ctx.supabase.from("page_templates").insert({ ...templateColumns(v), organization_id: ctx.org.id, created_by: ctx.user.id }).select("id").single());
  return row.id as string;
}

export async function deleteTemplate(ctx: SessionContext, id: string) {
  assertCan(ctx, "templates.manage");
  unwrap(await ctx.supabase.from("page_templates").delete().eq("id", uuid.parse(id)).eq("organization_id", ctx.org.id));
}

async function existingSlugs(ctx: SessionContext, websiteId: string) {
  const rows = unwrap(await ctx.supabase.from("content_items").select("slug").eq("website_id", websiteId).eq("organization_id", ctx.org.id).limit(50_000)) ?? [];
  return new Set((rows as { slug: string }[]).map((r) => r.slug));
}

export async function previewTemplate(ctx: SessionContext, templateId: string, feed: string) {
  const t = unwrap(await ctx.supabase.from("page_templates").select("*").eq("id", uuid.parse(templateId)).eq("organization_id", ctx.org.id).maybeSingle()) as TemplateRow | null;
  if (!t) throw new AppError("NOT_FOUND", "Template not found.");
  const parsed = parseFeed(z.string().max(5_000_000).parse(feed));
  if (parsed.error) throw new AppError("INVALID_INPUT", parsed.error);
  const pages = renderPages({
    titleTemplate: t.title_template, slugTemplate: t.slug_template, metaTitleTemplate: t.meta_title_template, metaDescriptionTemplate: t.meta_description_template,
    excerptTemplate: t.excerpt_template, keywordTemplate: t.keyword_template, bodyTemplate: t.body_template,
  }, parsed.rows, await existingSlugs(ctx, t.website_id));
  return { template: t, columns: parsed.columns, pages };
}

/** Creates one DRAFT per valid feed row. Drafts still need validation and approval. */
export async function generateFromTemplate(ctx: SessionContext, templateId: string, feed: string) {
  assertCan(ctx, "content.create");
  const { template, pages } = await previewTemplate(ctx, templateId, feed);
  const valid = pages.filter((p) => !p.errors.length);
  if (!valid.length) throw new AppError("INVALID_INPUT", "No rows are valid. Fix the errors shown in the preview.");
  const rows = valid.map((p) => ({
    organization_id: ctx.org.id, website_id: template.website_id, title: p.title.slice(0, 500), slug: p.slug, body: p.body, body_format: "markdown",
    excerpt: p.excerpt.slice(0, 2000), meta_title: p.metaTitle.slice(0, 300), meta_description: p.metaDescription.slice(0, 1000), target_keyword: p.keyword.slice(0, 200),
    created_by: ctx.user.id, template_id: template.id,
  }));
  // Service role is needed only to set template_id (not a user-writable column); org/website were verified above.
  const admin = createAdminClient();
  for (let i = 0; i < rows.length; i += 100) unwrap(await admin.from("content_items").insert(rows.slice(i, i + 100)));
  await audit(ctx, "template.generated", "page_template", template.id, { created: rows.length, skipped: pages.length - valid.length });
  return { created: rows.length, skipped: pages.length - valid.length };
}

// ---------------------------------------------------------------------------
// Per-article tools: internal links, schema, AI readiness
// ---------------------------------------------------------------------------
async function linkTargets(ctx: SessionContext, item: ContentRow, baseUrl: string): Promise<LinkTarget[]> {
  const [content, audits] = await Promise.all([
    ctx.supabase.from("content_items").select("id, title, slug, target_keyword, published_url, body").eq("website_id", item.website_id).neq("id", item.id).limit(500),
    ctx.supabase.from("site_audits").select("id").eq("website_id", item.website_id).order("created_at", { ascending: false }).limit(1),
  ]);
  const base = baseUrl.replace(/\/$/, "");
  const targets: LinkTarget[] = ((unwrap(content) ?? []) as Pick<ContentRow, "id" | "title" | "slug" | "target_keyword" | "published_url" | "body">[])
    .filter((c) => c.published_url)
    .map((c) => ({ id: c.id, url: c.published_url!, title: c.title, keyword: c.target_keyword, text: c.body.slice(0, 5000) }));
  const auditId = (unwrap(audits) ?? [])[0]?.id;
  if (auditId) {
    const pages = (unwrap(await ctx.supabase.from("site_audit_pages").select("id, url, title").eq("audit_id", auditId).eq("status_code", 200).eq("indexable", true).limit(500)) ?? []) as { id: number; url: string; title: string | null }[];
    const known = new Set(targets.map((t) => t.url.replace(/\/$/, "")));
    for (const p of pages) if (p.title && !known.has(p.url.replace(/\/$/, "")) && p.url.replace(/\/$/, "") !== base) targets.push({ id: `page:${p.id}`, url: p.url, title: p.title.replace(/\s[|–-]\s.*$/, ""), keyword: "" });
  }
  // Keyword clusters mapped to a URL give extra anchor phrases.
  const clusters = (unwrap(await ctx.supabase.from("keyword_clusters").select("id, head_keyword, target_url").eq("website_id", item.website_id).not("target_url", "is", null).limit(300)) ?? []) as { id: string; head_keyword: string; target_url: string }[];
  for (const c of clusters) {
    const t = targets.find((x) => x.url.replace(/\/$/, "") === c.target_url.replace(/\/$/, ""));
    if (t && !t.keyword) t.keyword = c.head_keyword;
    else if (!t) targets.push({ id: `cluster:${c.id}`, url: c.target_url, title: c.head_keyword, keyword: c.head_keyword });
  }
  return targets;
}

export async function articleInsights(ctx: SessionContext, id: string) {
  const { item, website } = await getContent(ctx, id);
  const html = renderBody(item.body, item.body_format);
  const parsed = parseHtml(html);
  // Saved schema is not published with the article, so it does not count (same as the validation check).
  const readiness = aiReadiness(parsed, { keyword: item.target_keyword, siteHost: new URL(website.base_url).hostname });
  const links = suggestInternalLinks({ title: item.title, body: item.body, bodyFormat: item.body_format, url: item.published_url }, await linkTargets(ctx, item, website.base_url));
  const checks = (unwrap(await ctx.supabase.from("ai_visibility_checks").select("id, query, engine, cited, mentioned, cited_urls, answer_excerpt, checked_at")
    .eq("website_id", item.website_id).eq("organization_id", ctx.org.id).ilike("query", item.target_keyword || "\u0000").order("checked_at", { ascending: false }).limit(10)) ?? []) as
    { id: string; query: string; engine: string; cited: boolean; mentioned: boolean; cited_urls: string[]; answer_excerpt: string | null; checked_at: string }[];
  return { readiness, links, visibility: checks };
}

export async function applyInternalLink(ctx: SessionContext, id: string, anchor: string, url: string) {
  const { item } = await getContent(ctx, id);
  const body = insertLink(item.body, item.body_format, z.string().min(2).max(200).parse(anchor), z.url().parse(url));
  if (!body) throw new AppError("CONFLICT", "That phrase is no longer present as plain text in the article.");
  const rows = unwrap(await ctx.supabase.from("content_items").update({ body }).eq("id", item.id).eq("organization_id", ctx.org.id).select("id"));
  if (!rows?.length) throw new AppError("FORBIDDEN", "You cannot edit this article.");
  await audit(ctx, "content.internal_link_added", "content_item", item.id, { url });
}

export async function buildSchema(ctx: SessionContext, id: string, input: unknown, save: boolean) {
  const { item, website } = await getContent(ctx, id);
  const opts = schemaOptionsSchema.parse(input);
  const url = item.published_url || `${website.base_url.replace(/\/$/, "")}/${item.slug}`;
  const out = generateSchema({
    title: item.title, metaDescription: item.meta_description, excerpt: item.excerpt, body: item.body, bodyFormat: item.body_format, url,
    publishedAt: item.status === "PUBLISHED" ? item.updated_at : null, updatedAt: item.updated_at,
  }, { name: website.name, baseUrl: website.base_url }, opts);
  const problems = validateSchema(out.jsonld);
  if (save) {
    const rows = unwrap(await ctx.supabase.from("content_items").update({ schema_jsonld: out.jsonld }).eq("id", item.id).eq("organization_id", ctx.org.id).select("id"));
    if (!rows?.length) throw new AppError("FORBIDDEN", "You cannot edit this article.");
  }
  return { ...out, problems };
}

export async function queueVisibilityCheck(ctx: SessionContext, websiteId: string, queries: string[]) {
  if (!llmStatus().configured) throw new AppError("CONFIG_MISSING", "AI visibility checks need ANTHROPIC_API_KEY on the server.");
  const list = z.array(z.string().trim().min(2).max(200)).max(25).parse(queries.filter(Boolean));
  return enqueueTask(ctx, websiteId, "AI_VISIBILITY_CHECK", { queries: list });
}
