import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { generationInputSchema, runContentPipeline, type LinkCandidate } from "@/lib/ai/content-pipeline";
import { getLlm, type LlmClient } from "@/lib/ai/llm";
import { openSecret } from "@/lib/analytics/credentials";
import {
  clarityInsights, mixpanelSegmentation, validateDatabricks, dfsSearchVolume, dfsSerp, ga4OrganicReport, gscInspectUrl, gscQuery, pagespeed, parseServiceAccount, similarwebTraffic,
  type ProviderId,
} from "@/lib/analytics/providers";
import { reviewContent } from "@/lib/ai/content-qa";
import { runSeoAgent, type AgentStep } from "@/lib/agents/seo-agent";
import { exportToDatabricks } from "@/lib/analytics/warehouse";
import { auditSite, flag, scoreAudit } from "@/lib/audit/crawler";
import { AppError, isAppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import type { HttpClient } from "@/lib/security/safe-fetch";
import { classifyIntent } from "@/lib/seo/keywords";
import { monitorAudit, monitorTraffic, runGateTask, runIndexNowTask } from "@/lib/tasks/monitoring";

/**
 * Background SEO tasks (separate from the publishing queue): site audits, analytics sync,
 * rank checks, AI visibility checks and AI content generation. Tasks are claimed with
 * SKIP LOCKED + leases. Every handler is read-only towards external services except
 * generation, which is idempotent (content_items.generation_task_id is unique), so a task
 * may be retried safely after a transient failure.
 */
export type TaskType = "SITE_AUDIT" | "ANALYTICS_SYNC" | "GENERATE_CONTENT" | "AI_VISIBILITY_CHECK" | "RANK_CHECK" | "AGENT_RUN" | "CONTENT_QA" | "WAREHOUSE_EXPORT" | "INDEXNOW_SUBMIT" | "SEO_GATE";
export type TaskRow = {
  id: string; organization_id: string; website_id: string; task_type: TaskType; status: string; params: Record<string, unknown>;
  result: Record<string, unknown>; attempts: number; max_attempts: number; created_by: string | null; run_at: string;
};
type Website = { id: string; organization_id: string; name: string; base_url: string };

/** `crawlBudgetMs` bounds long crawls (serverless cron invocations have ~60 s). */
export type TaskDeps = { db: SupabaseClient; http: HttpClient; llm: () => LlmClient; workerId: string; crawlBudgetMs?: number };

export function createTaskDeps(db: SupabaseClient, http: HttpClient, label = "worker", crawlBudgetMs?: number): TaskDeps {
  return { db, http, llm: getLlm, workerId: `${label}:${hostname()}:${randomUUID().slice(0, 8)}`, crawlBudgetMs };
}

const isoDay = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/** Throws database errors; `.single()` data is non-null once error is null. */
async function check<T>(p: PromiseLike<{ data: T; error: unknown }>): Promise<NonNullable<T>> {
  const { data, error } = await p;
  if (error) throw error;
  return data as NonNullable<T>;
}

async function progress(deps: TaskDeps, task: TaskRow, text: string) {
  await deps.db.from("automation_tasks").update({ progress: text, lease_expires_at: new Date(Date.now() + 600_000).toISOString() }).eq("id", task.id).eq("locked_by", deps.workerId);
}

async function integrationsFor(deps: TaskDeps, w: Website) {
  const rows = await check(deps.db.from("integrations").select("id, provider, encrypted_credentials, metadata, status").eq("website_id", w.id).eq("organization_id", w.organization_id));
  return (rows ?? []) as { id: string; provider: ProviderId; encrypted_credentials: string; metadata: Record<string, unknown>; status: string }[];
}

async function markIntegration(deps: TaskDeps, id: string, err: unknown | null) {
  const authFailed = isAppError(err) && (err.code === "CMS_AUTH_FAILED" || err.code === "CMS_FORBIDDEN");
  await deps.db.from("integrations").update(err
    ? { status: authFailed ? "auth_failed" : "error", last_error: isAppError(err) ? err.message : "Sync failed." }
    : { status: "connected", last_error: null, last_synced_at: new Date().toISOString() }).eq("id", id);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
async function runSiteAudit(deps: TaskDeps, task: TaskRow, w: Website) {
  const maxPages = Math.min(500, Math.max(1, Number(task.params.maxPages ?? 100)));
  const audit = await auditSite(deps.http, w.base_url, { maxPages, deadline: deps.crawlBudgetMs ? Date.now() + deps.crawlBudgetMs : undefined, onProgress: (n, q) => progress(deps, task, `Crawled ${n} pages (${q} queued)`) });
  const integrations = await integrationsFor(deps, w);
  const siteChecks: Record<string, unknown> = { ...audit.site, partial: audit.partial };

  const psi = integrations.find((i) => i.provider === "pagespeed");
  if (psi) {
    await progress(deps, task, "Measuring Core Web Vitals");
    const key = openSecret(psi.encrypted_credentials, w.organization_id, w.id, "pagespeed").apiKey;
    try {
      siteChecks.webVitals = await Promise.all((["mobile", "desktop"] as const).map((s) => pagespeed(deps.http, key, w.base_url, s)));
      await markIntegration(deps, psi.id, null);
    } catch (err) {
      siteChecks.webVitals = { error: isAppError(err) ? err.message : "PageSpeed Insights failed." };
      await markIntegration(deps, psi.id, err);
    }
  }
  const gsc = integrations.find((i) => i.provider === "google_search_console");
  const siteUrl = gsc?.metadata.site_url;
  if (gsc && typeof siteUrl === "string") {
    await progress(deps, task, "Checking indexation in Search Console");
    const sa = parseServiceAccount(openSecret(gsc.encrypted_credentials, w.organization_id, w.id, "google_search_console").serviceAccount);
    const candidates = audit.pages.filter((p) => p.statusCode === 200 && p.indexable).sort((a, b) => b.inlinks - a.inlinks).slice(0, Number(task.params.inspectUrls ?? 10));
    const inspections = [];
    for (const p of candidates) {
      try {
        inspections.push(await gscInspectUrl(deps.http, sa, siteUrl, p.url));
      } catch (err) {
        inspections.push({ url: p.url, error: isAppError(err) ? err.message : "Inspection failed" });
        if (isAppError(err) && (err.code === "RATE_LIMITED" || err.code === "CMS_AUTH_FAILED")) break;
      }
    }
    siteChecks.indexation = inspections;
    for (const insp of inspections) {
      const page = audit.pages.find((p) => p.url === insp.url);
      if (page && "verdict" in insp && insp.verdict !== "PASS") {
        flag(page, "not_indexed", `Search Console: ${insp.coverageState} (verdict ${insp.verdict})`, insp.lastCrawlTime ? `Last crawled ${insp.lastCrawlTime.slice(0, 10)}` : null,
          insp.googleCanonical && insp.googleCanonical !== insp.url ? `Google-selected canonical: ${insp.googleCanonical}` : null);
      }
    }
    // Re-count issues so indexation findings are part of the summary and score.
    audit.summary = {};
    for (const p of audit.pages) for (const i of new Set(p.issues)) audit.summary[i] = (audit.summary[i] ?? 0) + 1;
    audit.score = scoreAudit(audit.pages.length, audit.summary, audit.site);
  }

  const row = await check(deps.db.from("site_audits").upsert({
    organization_id: w.organization_id, website_id: w.id, task_id: task.id, score: audit.score, pages_crawled: audit.pages.length,
    summary: audit.summary, site_checks: siteChecks,
  }, { onConflict: "task_id" }).select("id").single());
  await deps.db.from("site_audit_pages").delete().eq("audit_id", row.id);
  for (const part of chunk(audit.pages, 200)) {
    await check(deps.db.from("site_audit_pages").insert(part.map((p) => ({
      organization_id: w.organization_id, audit_id: row.id, url: p.url.slice(0, 2048), status_code: p.statusCode, depth: p.depth,
      title: p.title?.slice(0, 1000) ?? null, meta_description: p.metaDescription?.slice(0, 2000) ?? null, canonical: p.canonical?.slice(0, 2048) ?? null,
      indexable: p.indexable, word_count: p.wordCount, load_ms: p.loadMs, inlinks: p.inlinks, issues: [...new Set(p.issues)], details: p.details,
    }))));
  }
  await progress(deps, task, "Comparing with the previous audit");
  let monitoring: Record<string, unknown>;
  try {
    monitoring = await monitorAudit(deps, w, row.id, audit);
  } catch (err) {
    // The audit itself succeeded; a monitoring problem must not discard it.
    logger.error("monitoring.audit_failed", { taskId: task.id, error: err });
    monitoring = { error: isAppError(err) ? err.message : "Regression check failed" };
  }
  return { auditId: row.id, score: audit.score, pages: audit.pages.length, partial: audit.partial, monitoring };
}

async function runAnalyticsSync(deps: TaskDeps, task: TaskRow, w: Website) {
  const integrations = await integrationsFor(deps, w);
  const results: Record<string, unknown> = {};
  if (!integrations.some((i) => ["google_search_console", "google_analytics_4", "microsoft_clarity", "similarweb", "mixpanel"].includes(i.provider))) {
    throw new AppError("CONFIG_MISSING", "No analytics integrations are connected for this website.");
  }
  for (const integ of integrations) {
    try {
      switch (integ.provider) {
        case "google_search_console": {
          await progress(deps, task, "Syncing Search Console");
          const sa = parseServiceAccount(openSecret(integ.encrypted_credentials, w.organization_id, w.id, integ.provider).serviceAccount);
          const days = integ.metadata.backfilled ? 10 : 90; // GSC data lands ~2–3 days late; re-pull recent days to capture final numbers
          const rows = await gscQuery(deps.http, sa, String(integ.metadata.site_url), isoDay(days), isoDay(1), Number(task.params.maxRows ?? 100_000));
          for (const part of chunk(rows, 1000)) {
            await check(deps.db.from("search_performance_daily").upsert(part.map((r) => ({
              organization_id: w.organization_id, website_id: w.id, date: r.date, query: r.query.slice(0, 1000), page: r.page.slice(0, 2048),
              clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position,
            })), { onConflict: "website_id,date,query,page" }));
          }
          await importGscKeywords(deps, w);
          await deps.db.from("integrations").update({ metadata: { ...integ.metadata, backfilled: true } }).eq("id", integ.id);
          results.google_search_console = { rows: rows.length };
          break;
        }
        case "google_analytics_4": {
          await progress(deps, task, "Syncing Google Analytics 4");
          const sa = parseServiceAccount(openSecret(integ.encrypted_credentials, w.organization_id, w.id, integ.provider).serviceAccount);
          const rows = await ga4OrganicReport(deps.http, sa, String(integ.metadata.property_id), isoDay(integ.metadata.backfilled ? 7 : 90), isoDay(0));
          for (const part of chunk(rows, 1000)) {
            await check(deps.db.from("traffic_daily").upsert(part.map((r) => ({
              organization_id: w.organization_id, website_id: w.id, source: "ga4", date: r.date, page: r.page.slice(0, 2048),
              metrics: { sessions: r.sessions, users: r.users, engaged_sessions: r.engagedSessions, conversions: r.conversions, bounce_rate: r.bounceRate },
            })), { onConflict: "website_id,source,date,page" }));
          }
          await deps.db.from("integrations").update({ metadata: { ...integ.metadata, backfilled: true } }).eq("id", integ.id);
          results.google_analytics_4 = { rows: rows.length };
          break;
        }
        case "microsoft_clarity": {
          await progress(deps, task, "Syncing Microsoft Clarity");
          const token = openSecret(integ.encrypted_credentials, w.organization_id, w.id, integ.provider).apiToken;
          const rows = await clarityInsights(deps.http, token, 1);
          const byPage = new Map<string, Record<string, number>>();
          for (const r of rows) {
            const m = byPage.get(r.page) ?? {};
            for (const [k, v] of Object.entries(r.values)) m[`${r.metric}.${k}`.toLowerCase().replace(/\s+/g, "_")] = v;
            byPage.set(r.page, m);
          }
          const date = isoDay(1);
          if (byPage.size) {
            await check(deps.db.from("traffic_daily").upsert([...byPage.entries()].slice(0, 5000).map(([page, metrics]) => ({
              organization_id: w.organization_id, website_id: w.id, source: "clarity", date, page: page.slice(0, 2048), metrics,
            })), { onConflict: "website_id,source,date,page" }));
          }
          results.microsoft_clarity = { pages: byPage.size };
          break;
        }
        case "mixpanel": {
          await progress(deps, task, "Syncing Mixpanel");
          const sec = openSecret(integ.encrypted_credentials, w.organization_id, w.id, integ.provider);
          const md = integ.metadata as { project_id: string; region: "us" | "eu" | "in"; event: string; segment_property: string; where?: string };
          const rows = await mixpanelSegmentation(deps.http, { username: sec.username, secret: sec.secret, projectId: md.project_id, region: md.region }, { event: md.event, on: md.segment_property, where: md.where || undefined, from: isoDay(integ.metadata.backfilled ? 7 : 90), to: isoDay(0) });
          for (const part of chunk(rows, 1000)) {
            await check(deps.db.from("traffic_daily").upsert(part.map((r) => ({
              organization_id: w.organization_id, website_id: w.id, source: "mixpanel", date: r.date, page: r.segment.slice(0, 2048), metrics: { [md.event]: r.count },
            })), { onConflict: "website_id,source,date,page" }));
          }
          await deps.db.from("integrations").update({ metadata: { ...integ.metadata, backfilled: true } }).eq("id", integ.id);
          results.mixpanel = { rows: rows.length };
          break;
        }
        case "similarweb": {
          await progress(deps, task, "Syncing Similarweb");
          const key = openSecret(integ.encrypted_credentials, w.organization_id, w.id, integ.provider).apiKey;
          const end = new Date(); end.setUTCDate(1); end.setUTCMonth(end.getUTCMonth() - 1);
          const start = new Date(end); start.setUTCMonth(start.getUTCMonth() - 5);
          const ym = (d: Date) => d.toISOString().slice(0, 7);
          const months = await similarwebTraffic(deps.http, key, new URL(w.base_url).hostname, ym(start), ym(end));
          if (months.length) {
            await check(deps.db.from("traffic_daily").upsert(months.map((m) => ({
              organization_id: w.organization_id, website_id: w.id, source: "similarweb", date: m.date, page: "", metrics: { visits: m.visits },
            })), { onConflict: "website_id,source,date,page" }));
          }
          results.similarweb = { months: months.length };
          break;
        }
        default:
          continue;
      }
      await markIntegration(deps, integ.id, null);
    } catch (err) {
      await markIntegration(deps, integ.id, err);
      results[integ.provider] = { error: isAppError(err) ? err.message : "Sync failed" };
      logger.warn("task.analytics_provider_failed", { taskId: task.id, provider: integ.provider, code: isAppError(err) ? err.code : "unknown" });
    }
  }
  if (results.google_search_console && !("error" in (results.google_search_console as object))) {
    await progress(deps, task, "Checking for traffic anomalies");
    try {
      const m = await monitorTraffic(deps, w);
      results.monitoring = { anomalies: m.anomalies, "alerts opened": m.created, "alerts resolved": m.resolved };
    } catch (err) {
      logger.error("monitoring.traffic_failed", { taskId: task.id, error: err });
      results.monitoring = { error: isAppError(err) ? err.message : "Anomaly check failed" };
    }
  }
  return results;
}

/** Adds the site's top Search Console queries to its keyword list with current positions. */
async function importGscKeywords(deps: TaskDeps, w: Website) {
  const since = isoDay(28);
  const rows = await check(deps.db.from("search_performance_daily").select("query, page, clicks, impressions, position")
    .eq("website_id", w.id).gte("date", since).order("impressions", { ascending: false }).limit(20_000));
  const agg = new Map<string, { imp: number; clicks: number; pw: number; pages: Map<string, number> }>();
  for (const r of (rows ?? []) as { query: string; page: string; clicks: number; impressions: number; position: number }[]) {
    const k = r.query.toLowerCase().trim().slice(0, 200);
    if (!k) continue;
    const a = agg.get(k) ?? { imp: 0, clicks: 0, pw: 0, pages: new Map() };
    a.imp += r.impressions; a.clicks += r.clicks; a.pw += Number(r.position) * r.impressions;
    a.pages.set(r.page, (a.pages.get(r.page) ?? 0) + r.impressions);
    agg.set(k, a);
  }
  const top = [...agg.entries()].sort((a, b) => b[1].imp - a[1].imp).slice(0, 500);
  const existing = new Set(((await check(deps.db.from("keywords").select("keyword").eq("website_id", w.id))) ?? []).map((k: { keyword: string }) => k.keyword));
  const now = new Date().toISOString();
  const toInsert = top.filter(([k]) => !existing.has(k)).map(([keyword, a]) => ({
    organization_id: w.organization_id, website_id: w.id, keyword, source: "gsc", intent: classifyIntent(keyword),
    position: a.imp ? Math.round((a.pw / a.imp) * 10) / 10 : null, ranking_url: [...a.pages.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null,
    position_checked_at: now, metrics: { gsc_impressions_28d: a.imp, gsc_clicks_28d: a.clicks },
  }));
  for (const part of chunk(toInsert, 500)) await check(deps.db.from("keywords").insert(part));
  // Refresh positions of keywords that are already known (GSC average position, last 28 days).
  for (const [keyword, a] of top.filter(([k]) => existing.has(k)).slice(0, 300)) {
    await deps.db.from("keywords").update({
      position: a.imp ? Math.round((a.pw / a.imp) * 10) / 10 : null, position_checked_at: now,
      ranking_url: [...a.pages.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null,
    }).eq("website_id", w.id).eq("keyword", keyword).neq("source", "dataforseo");
  }
}

async function runRankCheck(deps: TaskDeps, task: TaskRow, w: Website) {
  const integ = (await integrationsFor(deps, w)).find((i) => i.provider === "dataforseo");
  if (!integ) throw new AppError("CONFIG_MISSING", "Connect DataForSEO to track rankings.");
  const creds = openSecret(integ.encrypted_credentials, w.organization_id, w.id, "dataforseo");
  const location = Number(integ.metadata.location_code ?? 2840);
  const language = String(integ.metadata.language_code ?? "en");
  const tracked = ((await check(deps.db.from("keywords").select("id, keyword, search_volume, metrics").eq("website_id", w.id).eq("tracked", true).limit(Number(task.params.limit ?? 100)))) ?? []) as
    { id: string; keyword: string; search_volume: number | null; metrics: Record<string, unknown> }[];
  if (!tracked.length) throw new AppError("INVALID_INPUT", "No tracked keywords. Mark keywords as tracked on the Keywords page.");
  const domain = new URL(w.base_url).hostname;
  try {
    const missing = tracked.filter((k) => k.search_volume == null).map((k) => k.keyword);
    if (missing.length) {
      await progress(deps, task, "Fetching search volumes");
      for (const v of await dfsSearchVolume(deps.http, creds, missing, location, language)) {
        await deps.db.from("keywords").update({ search_volume: v.searchVolume, cpc: v.cpc, difficulty: v.competition }).eq("website_id", w.id).eq("keyword", v.keyword);
      }
    }
    // Additional markets (multi-market / international): positions stored per market in metrics.markets.
    const markets = (Array.isArray(integ.metadata.markets) ? integ.metadata.markets : []) as { label: string; location_code: number; language_code: string }[];
    let ranked = 0, inOverview = 0;
    for (const [i, k] of tracked.entries()) {
      await progress(deps, task, `Checking rankings ${i + 1}/${tracked.length}${markets.length ? ` in ${markets.length + 1} markets` : ""}`);
      const serp = await dfsSerp(deps.http, creds, k.keyword, domain, location, language);
      if (serp.position) ranked++;
      if (serp.aiOverview.cited) inOverview++;
      const perMarket: Record<string, { position: number | null; url: string | null }> = {};
      for (const m of markets.slice(0, 5)) {
        const ms = await dfsSerp(deps.http, creds, k.keyword, domain, m.location_code, m.language_code);
        perMarket[m.label] = { position: ms.position, url: ms.url };
      }
      await deps.db.from("keywords").update({
        position: serp.position, ranking_url: serp.url, position_checked_at: new Date().toISOString(),
        metrics: { ...k.metrics, serp_urls: serp.topUrls, ai_overview: serp.aiOverview.present, ai_overview_cited: serp.aiOverview.cited, ...(markets.length ? { markets: perMarket } : {}) },
      }).eq("id", k.id);
      if (serp.aiOverview.present) {
        await deps.db.from("ai_visibility_checks").insert({
          organization_id: w.organization_id, website_id: w.id, task_id: task.id, query: k.keyword, engine: "google_ai_overview",
          cited: serp.aiOverview.cited, mentioned: serp.aiOverview.cited, cited_urls: serp.aiOverview.references,
        });
      }
    }
    await markIntegration(deps, integ.id, null);
    return { checked: tracked.length, ranked, aiOverviewCitations: inOverview };
  } catch (err) {
    await markIntegration(deps, integ.id, err);
    throw err;
  }
}

async function runVisibilityCheck(deps: TaskDeps, task: TaskRow, w: Website) {
  const llm = deps.llm();
  let queries = Array.isArray(task.params.queries) ? (task.params.queries as unknown[]).filter((q): q is string => typeof q === "string" && q.trim().length > 1).slice(0, 25) : [];
  if (!queries.length) {
    const rows = ((await check(deps.db.from("keywords").select("keyword").eq("website_id", w.id).eq("tracked", true).order("search_volume", { ascending: false, nullsFirst: false }).limit(10))) ?? []) as { keyword: string }[];
    queries = rows.map((r) => r.keyword);
  }
  if (!queries.length) throw new AppError("INVALID_INPUT", "Add queries or mark keywords as tracked to check AI visibility.");
  const host = new URL(w.base_url).hostname.replace(/^www\./, "").toLowerCase();
  const brand = w.name.toLowerCase();
  let cited = 0;
  for (const [i, query] of queries.entries()) {
    await progress(deps, task, `Asking the AI engine ${i + 1}/${queries.length}`);
    const res = await llm.webAnswer(query, () => ({
      answer: `Sample answer for “${query}” from the development mock (no real AI engine was queried).`,
      citedUrls: i % 2 === 0 ? [`${w.base_url.replace(/\/$/, "")}/`, "https://en.wikipedia.org/wiki/Search_engine_optimization"] : ["https://en.wikipedia.org/wiki/Search_engine_optimization"],
    }));
    const isCited = res.data.citedUrls.some((u) => {
      try {
        const h = new URL(u).hostname.replace(/^www\./, "").toLowerCase();
        return h === host || h.endsWith(`.${host}`);
      } catch {
        return false;
      }
    });
    const text = res.data.answer.toLowerCase();
    if (isCited) cited++;
    await check(deps.db.from("ai_visibility_checks").insert({
      organization_id: w.organization_id, website_id: w.id, task_id: task.id, query, engine: "claude_web_search",
      cited: isCited, mentioned: isCited || text.includes(host) || (brand.length > 3 && text.includes(brand)),
      cited_urls: res.data.citedUrls.slice(0, 30), answer_excerpt: res.data.answer.slice(0, 1500),
    }));
    await deps.db.from("ai_runs").insert({
      organization_id: w.organization_id, website_id: w.id, task_id: task.id, kind: "visibility", provider: res.provider, model: res.model,
      input_tokens: res.usage.inputTokens, output_tokens: res.usage.outputTokens, created_by: task.created_by,
    });
  }
  return { queries: queries.length, cited, provider: llm.provider };
}

async function runGenerateContent(deps: TaskDeps, task: TaskRow, w: Website) {
  const { data: existing, error: existingError } = await deps.db.from("content_items").select("id").eq("generation_task_id", task.id).maybeSingle();
  if (existingError) throw existingError;
  if (existing) return { contentId: (existing as { id: string }).id, reused: true };
  const input = generationInputSchema.parse({ ...task.params, websiteId: w.id });
  const llm = deps.llm();
  const pages = ((await check(deps.db.from("content_items").select("title, published_url, target_keyword").eq("website_id", w.id).not("published_url", "is", null).limit(200))) ?? []) as
    { title: string; published_url: string; target_keyword: string }[];
  const links: LinkCandidate[] = pages.map((p) => ({ title: p.title, url: p.published_url, keyword: p.target_keyword }));
  const result = await runContentPipeline(llm, input, links, (s) => progress(deps, task, s));
  const slugTaken = await check(deps.db.from("content_items").select("id").eq("website_id", w.id).eq("slug", result.draft.slug).limit(1));
  const slug = (slugTaken as unknown[]).length ? `${result.draft.slug}-${task.id.slice(0, 6)}` : result.draft.slug;
  const row = await check(deps.db.from("content_items").insert({
    organization_id: w.organization_id, website_id: w.id, title: result.draft.title.slice(0, 500), slug, body: result.draft.bodyMarkdown, body_format: "markdown",
    excerpt: result.draft.excerpt.slice(0, 2000), meta_title: result.draft.metaTitle.slice(0, 300), meta_description: result.draft.metaDescription.slice(0, 1000),
    target_keyword: input.targetKeyword.slice(0, 200), created_by: task.created_by, assigned_to: task.created_by, ai_generated: true, generation_task_id: task.id,
    brief: { brief: result.brief, review: result.review, faqs: result.draft.faqs, provider: result.provider, models: result.steps.map((s) => s.model), input },
  }).select("id").single());
  await deps.db.from("ai_runs").insert(result.steps.map((s) => ({
    organization_id: w.organization_id, website_id: w.id, content_item_id: row.id, task_id: task.id, kind: s.kind, provider: result.provider, model: s.model,
    input_tokens: s.usage.inputTokens, output_tokens: s.usage.outputTokens, created_by: task.created_by,
  })));
  if (input.clusterId) await deps.db.from("keyword_clusters").update({ content_item_id: row.id }).eq("id", input.clusterId).eq("website_id", w.id);
  return { contentId: row.id, provider: result.provider, verdict: result.review.verdict };
}

async function runAgentTask(deps: TaskDeps, task: TaskRow, w: Website) {
  const goal = String(task.params.goal ?? "").trim() || "Find the biggest organic growth opportunities for the next month and propose the top actions.";
  const existing = (await check(deps.db.from("agent_runs").select("id").eq("task_id", task.id).limit(1)))[0] as { id: string } | undefined;
  // A retried task starts a fresh run record; proposals from an interrupted attempt are discarded.
  if (existing) await deps.db.from("agent_runs").delete().eq("id", existing.id);
  const run = await check(deps.db.from("agent_runs").insert({ organization_id: w.organization_id, website_id: w.id, task_id: task.id, goal: goal.slice(0, 2000), created_by: task.created_by }).select("id").single()) as { id: string };
  const steps: AgentStep[] = [];
  try {
    const llm = deps.llm();
    const res = await runSeoAgent(llm, {
      db: deps.db, http: deps.http, orgId: w.organization_id, websiteId: w.id, baseUrl: w.base_url, runId: run.id,
      onStep: async (step) => {
        steps.push(step);
        await deps.db.from("agent_runs").update({ steps }).eq("id", run.id);
        await progress(deps, task, `Agent step ${steps.length}: ${step.tool}`);
      },
    }, goal);
    await check(deps.db.from("agent_runs").update({
      status: "completed", report: res.data.report.slice(0, 50_000), provider: res.provider, model: res.model, steps,
      input_tokens: res.usage.inputTokens, output_tokens: res.usage.outputTokens, completed_at: new Date().toISOString(),
    }).eq("id", run.id));
    await deps.db.from("ai_runs").insert({ organization_id: w.organization_id, website_id: w.id, task_id: task.id, kind: "agent", provider: res.provider, model: res.model, input_tokens: res.usage.inputTokens, output_tokens: res.usage.outputTokens, created_by: task.created_by });
    const proposals = (await check(deps.db.from("agent_proposals").select("id").eq("run_id", run.id))) as unknown[];
    return { runId: run.id, steps: steps.length, proposals: proposals.length, provider: res.provider };
  } catch (err) {
    await deps.db.from("agent_runs").update({ status: "failed", steps, report: isAppError(err) ? err.message : "The agent failed.", completed_at: new Date().toISOString() }).eq("id", run.id);
    throw err;
  }
}

async function runContentQa(deps: TaskDeps, task: TaskRow, w: Website) {
  const llm = deps.llm();
  const ids = Array.isArray(task.params.contentIds) ? (task.params.contentIds as string[]).slice(0, 200) : null;
  let q = deps.db.from("content_items").select("id, title, body, body_format, target_keyword, content_hash").eq("website_id", w.id).eq("organization_id", w.organization_id).neq("status", "CANCELLED").limit(Number(task.params.limit ?? 50));
  if (ids?.length) q = q.in("id", ids);
  const items = (await check(q)) as { id: string; title: string; body: string; body_format: "markdown" | "html"; target_keyword: string; content_hash: string }[];
  const counts = { pass: 0, needs_revision: 0, fail: 0, skipped: 0 };
  for (const [i, item] of items.entries()) {
    // Unchanged content already reviewed: skip (idempotent and cheaper on retries/reruns).
    const prior = (await check(deps.db.from("content_reviews").select("id").eq("content_item_id", item.id).eq("content_hash", item.content_hash).limit(1))) as unknown[];
    if (prior.length || !item.body.trim()) { counts.skipped++; continue; }
    await progress(deps, task, `Reviewing ${i + 1}/${items.length}`);
    const r = await reviewContent(llm, item);
    counts[r.verdict]++;
    await check(deps.db.from("content_reviews").insert({
      organization_id: w.organization_id, content_item_id: item.id, task_id: task.id, content_hash: item.content_hash, scores: r.scores, verdict: r.verdict,
      issues: r.issues, claims_to_verify: r.claimsToVerify, provider: r.provider, model: r.model,
    }));
    await deps.db.from("ai_runs").insert({ organization_id: w.organization_id, website_id: w.id, content_item_id: item.id, task_id: task.id, kind: "qa", provider: r.provider, model: r.model, input_tokens: r.usage.inputTokens, output_tokens: r.usage.outputTokens, created_by: task.created_by });
  }
  return { reviewed: items.length - counts.skipped, ...counts, provider: llm.provider };
}

async function runWarehouseExport(deps: TaskDeps, task: TaskRow, w: Website) {
  const integ = (await integrationsFor(deps, w)).find((i) => i.provider === "databricks");
  if (!integ) throw new AppError("CONFIG_MISSING", "Connect Databricks to export data.");
  const md = integ.metadata as { host: string; warehouse_id: string; catalog: string; schema: string };
  const creds = validateDatabricks({ host: md.host, warehouseId: md.warehouse_id, catalog: md.catalog, schema: md.schema, token: openSecret(integ.encrypted_credentials, w.organization_id, w.id, "databricks").token });
  try {
    const counts = await exportToDatabricks(deps.db, deps.http, creds, w, Number(task.params.days ?? 30), (s) => progress(deps, task, s));
    await markIntegration(deps, integ.id, null);
    return { ...counts, target: `${md.catalog}.${md.schema}` };
  } catch (err) {
    await markIntegration(deps, integ.id, err);
    throw err;
  }
}

const HANDLERS: Record<TaskType, (deps: TaskDeps, task: TaskRow, w: Website) => Promise<Record<string, unknown>>> = {
  SITE_AUDIT: runSiteAudit,
  ANALYTICS_SYNC: runAnalyticsSync,
  RANK_CHECK: runRankCheck,
  AI_VISIBILITY_CHECK: runVisibilityCheck,
  GENERATE_CONTENT: runGenerateContent,
  AGENT_RUN: runAgentTask,
  CONTENT_QA: runContentQa,
  WAREHOUSE_EXPORT: runWarehouseExport,
  INDEXNOW_SUBMIT: runIndexNowTask,
  SEO_GATE: runGateTask,
};

export async function processTask(deps: TaskDeps, task: TaskRow): Promise<"COMPLETED" | "FAILED" | "QUEUED"> {
  try {
    const w = (await check(deps.db.from("websites").select("id, organization_id, name, base_url").eq("id", task.website_id).eq("organization_id", task.organization_id).single())) as Website;
    const result = await HANDLERS[task.task_type](deps, task, w);
    await check(deps.db.from("automation_tasks").update({ status: "COMPLETED", result, progress: null, completed_at: new Date().toISOString(), lease_expires_at: null, locked_by: null }).eq("id", task.id));
    if (task.task_type === "SITE_AUDIT" || task.task_type === "ANALYTICS_SYNC") logger.info("task.completed", { taskId: task.id, type: task.task_type });
    return "COMPLETED";
  } catch (err) {
    const retry = isAppError(err) && err.retryable && task.attempts < task.max_attempts;
    const message = isAppError(err) ? err.message : "The task failed unexpectedly. The error has been logged.";
    if (!isAppError(err)) logger.error("task.failed", { taskId: task.id, type: task.task_type, error: err });
    const delay = isAppError(err) && err.retryAfterMs ? err.retryAfterMs : 2 ** task.attempts * 60_000;
    await deps.db.from("automation_tasks").update(retry
      ? { status: "QUEUED", run_at: new Date(Date.now() + delay).toISOString(), error_code: err.code, error_message: message, lease_expires_at: null, locked_by: null, progress: null }
      : { status: "FAILED", completed_at: new Date().toISOString(), error_code: isAppError(err) ? err.code : "INTERNAL", error_message: message, lease_expires_at: null, locked_by: null, progress: null }).eq("id", task.id);
    return retry ? "QUEUED" : "FAILED";
  }
}

export async function runTaskBatch(deps: TaskDeps, opts: { maxTasks?: number; timeBudgetMs?: number } = {}) {
  const deadline = Date.now() + (opts.timeBudgetMs ?? 50_000);
  const { data: reaped } = await deps.db.rpc("reap_expired_tasks");
  const { data: scheduled } = await deps.db.rpc("enqueue_due_schedules");
  let processed = 0;
  const outcomes: Record<string, number> = {};
  while (processed < (opts.maxTasks ?? 3) && Date.now() < deadline) {
    const { data, error } = await deps.db.rpc("claim_next_task", { p_worker: deps.workerId, p_lease_seconds: 600 });
    if (error) throw error;
    const task = (Array.isArray(data) ? data[0] : data) as TaskRow | undefined;
    if (!task) break;
    const status = await processTask(deps, task);
    outcomes[status] = (outcomes[status] ?? 0) + 1;
    processed++;
  }
  return { processed, reaped: reaped ?? 0, scheduled: scheduled ?? 0, outcomes };
}
