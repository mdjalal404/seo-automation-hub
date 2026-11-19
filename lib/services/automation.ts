import "server-only";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { z } from "zod";
import { unwrap } from "@/lib/actions/result";
import { llmStatus } from "@/lib/ai/llm";
import { measureImpact, type Change } from "@/lib/analytics/impact";
import type { PerfRow } from "@/lib/analytics/insights";
import { LogAnalyzer, uncrawledPages, type LogSummary } from "@/lib/audit/logs";
import { assertCan, type SessionContext } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import { insertLink } from "@/lib/seo/internal-links";
import { audit } from "@/lib/services/audit";
import { enqueueTask } from "@/lib/services/seo";
import { getWebsite } from "@/lib/services/websites";
import { createAdminClient } from "@/lib/supabase/admin";
import { uuid } from "@/lib/validation/schemas";

// ---------------------------------------------------------------------------
// SEO agent
// ---------------------------------------------------------------------------
export type AgentRunRow = {
  id: string; website_id: string; task_id: string | null; goal: string; status: string; steps: { tool: string; input: Record<string, unknown>; output: string; ms: number; error?: boolean }[];
  report: string | null; provider: string | null; model: string | null; input_tokens: number; output_tokens: number; created_at: string; completed_at: string | null;
};
export type ProposalRow = {
  id: string; run_id: string; website_id: string; kind: string; title: string; rationale: string; evidence: string[]; target_url: string | null;
  payload: Record<string, string>; priority: string; status: string; decided_at: string | null; result: Record<string, unknown>; created_at: string;
};

export async function startAgent(ctx: SessionContext, websiteId: string, goal: string) {
  if (!llmStatus().configured) throw new AppError("CONFIG_MISSING", "The SEO agent needs ANTHROPIC_API_KEY on the server.");
  const g = z.string().trim().min(5, "Describe what the agent should investigate.").max(2000).parse(goal);
  return enqueueTask(ctx, websiteId, "AGENT_RUN", { goal: g });
}

export async function listAgentRuns(ctx: SessionContext, websiteId: string) {
  return (unwrap(await ctx.supabase.from("agent_runs").select("id, website_id, task_id, goal, status, report, provider, model, input_tokens, output_tokens, created_at, completed_at, steps")
    .eq("website_id", websiteId).eq("organization_id", ctx.org.id).order("created_at", { ascending: false }).limit(20)) ?? []) as AgentRunRow[];
}

export async function getAgentRun(ctx: SessionContext, id: string) {
  const run = unwrap(await ctx.supabase.from("agent_runs").select("*").eq("id", uuid.parse(id)).eq("organization_id", ctx.org.id).maybeSingle()) as AgentRunRow | null;
  if (!run) throw new AppError("NOT_FOUND", "Agent run not found.");
  const proposals = (unwrap(await ctx.supabase.from("agent_proposals").select("*").eq("run_id", run.id).order("created_at")) ?? []) as ProposalRow[];
  return { run, proposals };
}

export async function listProposals(ctx: SessionContext, websiteId: string, status = "proposed") {
  return (unwrap(await ctx.supabase.from("agent_proposals").select("*").eq("website_id", websiteId).eq("organization_id", ctx.org.id).eq("status", status).order("created_at", { ascending: false }).limit(100)) ?? []) as ProposalRow[];
}

/**
 * Human gate for agent output. Approving executes what can be executed safely
 * (queue an AI draft, rewrite meta tags or add a link on a tracked article — both of
 * which reset that article's approval), otherwise the proposal stays approved as a to-do.
 */
export async function decideProposal(ctx: SessionContext, id: string, decision: "approve" | "reject" | "done") {
  assertCan(ctx, "automation.manage");
  const p = unwrap(await ctx.supabase.from("agent_proposals").select("*").eq("id", uuid.parse(id)).eq("organization_id", ctx.org.id).maybeSingle()) as ProposalRow | null;
  if (!p) throw new AppError("NOT_FOUND", "Proposal not found.");
  const allowed = decision === "done" ? ["approved"] : ["proposed"];
  if (!allowed.includes(p.status)) throw new AppError("CONFLICT", `This proposal is already ${p.status}.`);
  const admin = createAdminClient();
  let status = decision === "reject" ? "rejected" : decision === "done" ? "done" : "approved";
  let result: Record<string, unknown> = {};

  if (decision === "approve") {
    const article = p.target_url
      ? (unwrap(await ctx.supabase.from("content_items").select("id, body, body_format").eq("website_id", p.website_id).eq("published_url", p.target_url).limit(1)) ?? [])[0] as { id: string; body: string; body_format: "markdown" | "html" } | undefined
      : undefined;
    if (p.kind === "new_article") {
      const keyword = (p.payload.keyword || p.title).slice(0, 200);
      result.taskId = await enqueueTask(ctx, p.website_id, "GENERATE_CONTENT", {
        websiteId: p.website_id, topic: (p.payload.topic || p.title).slice(0, 300), targetKeyword: keyword, secondaryKeywords: [], audience: "", tone: "professional", wordCount: 1200,
        brandNotes: `Agent rationale: ${p.rationale}`.slice(0, 2000), clusterId: null,
      }, `proposal:${p.id}`);
      status = "done";
    } else if (p.kind === "meta_rewrite" && article && (p.payload.meta_title || p.payload.meta_description)) {
      const patch = { ...(p.payload.meta_title ? { meta_title: p.payload.meta_title.slice(0, 300) } : {}), ...(p.payload.meta_description ? { meta_description: p.payload.meta_description.slice(0, 1000) } : {}) };
      const rows = unwrap(await ctx.supabase.from("content_items").update(patch).eq("id", article.id).select("id"));
      if (!rows?.length) throw new AppError("FORBIDDEN", "You cannot edit the target article.");
      result = { contentId: article.id, applied: Object.keys(patch) };
      status = "done";
    } else if (p.kind === "internal_link" && article && p.payload.anchor && p.payload.link_url) {
      const body = insertLink(article.body, article.body_format, p.payload.anchor, p.payload.link_url);
      if (body) {
        const rows = unwrap(await ctx.supabase.from("content_items").update({ body }).eq("id", article.id).select("id"));
        if (!rows?.length) throw new AppError("FORBIDDEN", "You cannot edit the target article.");
        result = { contentId: article.id, applied: ["internal_link"] };
        status = "done";
      }
    }
  }
  unwrap(await admin.from("agent_proposals").update({ status, decided_by: ctx.user.id, decided_at: new Date().toISOString(), result: { ...p.result, ...result } }).eq("id", p.id).eq("organization_id", ctx.org.id));
  await audit(ctx, `proposal.${decision}`, "agent_proposal", p.id, { kind: p.kind, status });
  return { status, result };
}

// ---------------------------------------------------------------------------
// Server log analysis
// ---------------------------------------------------------------------------
export const MAX_LOG_BYTES = 200 * 1024 * 1024;

export async function analyzeLogUpload(ctx: SessionContext, websiteId: string, file: File) {
  assertCan(ctx, "seo.run");
  await getWebsite(ctx, websiteId);
  if (!file.size) throw new AppError("INVALID_INPUT", "The file is empty.");
  if (file.size > MAX_LOG_BYTES) throw new AppError("INVALID_INPUT", "The log file is over 200 MB. Use the Python toolkit (python/seo_toolkit) for larger logs.");
  const gz = /\.gz$/i.test(file.name);
  let input = Readable.fromWeb(file.stream() as import("node:stream/web").ReadableStream);
  if (gz) input = input.pipe(createGunzip());
  const analyzer = new LogAnalyzer();
  for await (const line of createInterface({ input, crlfDelay: Infinity })) analyzer.add(line);
  if (!analyzer.linesParsed) throw new AppError("INVALID_INPUT", "No lines matched the Apache/Nginx combined log format.");
  const summary = analyzer.summary() as LogSummary & { uncrawled?: { count: number; sample: string[] } };
  // Coverage gap: indexable pages from the latest audit that Googlebot never requested in this window.
  const lastAudit = (unwrap(await ctx.supabase.from("site_audits").select("id").eq("website_id", websiteId).order("created_at", { ascending: false }).limit(1)) ?? [])[0];
  if (lastAudit) {
    const pages = (unwrap(await ctx.supabase.from("site_audit_pages").select("url").eq("audit_id", lastAudit.id).eq("status_code", 200).eq("indexable", true).limit(5000)) ?? []) as { url: string }[];
    const missing = uncrawledPages(pages.map((p) => p.url), analyzer.googlePaths());
    summary.uncrawled = { count: missing.length, sample: missing.slice(0, 25) };
  }
  const row = unwrap(await createAdminClient().from("log_analyses").insert({
    organization_id: ctx.org.id, website_id: websiteId, source_name: file.name.slice(0, 300), lines_total: analyzer.linesTotal, lines_parsed: analyzer.linesParsed,
    bot_hits: analyzer.botHits, summary, created_by: ctx.user.id,
  }).select("id").single());
  await audit(ctx, "logs.analyzed", "website", websiteId, { lines: analyzer.linesTotal, bot_hits: analyzer.botHits });
  return row.id as string;
}

export type LogAnalysisRow = { id: string; website_id: string; source_name: string; lines_total: number; lines_parsed: number; bot_hits: number; summary: LogSummary & { uncrawled?: { count: number; sample: string[] } }; created_at: string };

export async function listLogAnalyses(ctx: SessionContext, websiteId: string) {
  return (unwrap(await ctx.supabase.from("log_analyses").select("*").eq("website_id", websiteId).eq("organization_id", ctx.org.id).order("created_at", { ascending: false }).limit(20)) ?? []) as LogAnalysisRow[];
}

// ---------------------------------------------------------------------------
// Content QA at scale
// ---------------------------------------------------------------------------
export async function queueContentQa(ctx: SessionContext, websiteId: string, contentIds: string[] = []) {
  if (!llmStatus().configured) throw new AppError("CONFIG_MISSING", "Content QA needs ANTHROPIC_API_KEY on the server.");
  return enqueueTask(ctx, websiteId, "CONTENT_QA", { contentIds: z.array(uuid).max(200).parse(contentIds), limit: 200 });
}

export type ReviewRow = { id: string; content_item_id: string; verdict: string; scores: Record<string, number>; issues: { severity: string; message: string; source: string }[]; claims_to_verify: string[]; provider: string; model: string; created_at: string; content_hash: string };

export async function latestReviews(ctx: SessionContext, websiteId: string) {
  const items = (unwrap(await ctx.supabase.from("content_items").select("id, title, content_hash, status").eq("website_id", websiteId).eq("organization_id", ctx.org.id).limit(1000)) ?? []) as { id: string; title: string; content_hash: string; status: string }[];
  if (!items.length) return [];
  const reviews = (unwrap(await ctx.supabase.from("content_reviews").select("*").in("content_item_id", items.map((i) => i.id)).order("created_at", { ascending: false }).limit(2000)) ?? []) as ReviewRow[];
  const latest = new Map<string, ReviewRow>();
  for (const r of reviews) if (!latest.has(r.content_item_id)) latest.set(r.content_item_id, r);
  return items.map((i) => ({ ...i, review: latest.get(i.id) ?? null, stale: !!latest.get(i.id) && latest.get(i.id)!.content_hash !== i.content_hash }));
}

// ---------------------------------------------------------------------------
// Impact measurement
// ---------------------------------------------------------------------------
export async function impactReport(ctx: SessionContext, websiteId: string) {
  const [jobs, proposals] = await Promise.all([
    ctx.supabase.from("content_jobs").select("content_item_id, completed_at, content_items(title, published_url)").eq("website_id", websiteId).eq("organization_id", ctx.org.id)
      .eq("job_type", "PUBLISH").eq("status", "COMPLETED").order("completed_at", { ascending: false }).limit(200),
    ctx.supabase.from("agent_proposals").select("id, title, target_url, decided_at").eq("website_id", websiteId).eq("organization_id", ctx.org.id).eq("status", "done").not("target_url", "is", null).limit(200),
  ]);
  const changes: Change[] = [];
  for (const j of (unwrap(jobs) ?? []) as unknown as { content_item_id: string; completed_at: string; content_items: { title: string; published_url: string | null } | null }[]) {
    if (j.content_items?.published_url && j.completed_at) changes.push({ id: j.content_item_id, url: j.content_items.published_url, date: j.completed_at.slice(0, 10), label: `Published: ${j.content_items.title}` });
  }
  for (const p of (unwrap(proposals) ?? []) as { id: string; title: string; target_url: string; decided_at: string }[]) {
    changes.push({ id: p.id, url: p.target_url, date: p.decided_at.slice(0, 10), label: `Agent proposal: ${p.title}` });
  }
  if (!changes.length) return [];
  const earliest = changes.reduce((m, c) => (c.date < m ? c.date : m), changes[0].date);
  const since = new Date(new Date(`${earliest}T00:00:00Z`).getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const rows = (unwrap(await ctx.supabase.from("search_performance_daily").select("date, query, page, clicks, impressions, position").eq("website_id", websiteId)
    .eq("organization_id", ctx.org.id).gte("date", since).in("page", [...new Set(changes.map((c) => c.url))]).limit(100_000)) ?? []) as PerfRow[];
  return measureImpact(changes, rows.map((r) => ({ ...r, position: Number(r.position) })));
}
