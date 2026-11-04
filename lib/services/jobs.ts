import "server-only";
import { unwrap } from "@/lib/actions/result";
import { assertCan, type SessionContext } from "@/lib/auth/session";
import type { JobRow } from "@/lib/database/types";
import { runWorkerBatch } from "@/lib/publishing/processor";
import { createProcessorDeps } from "@/lib/publishing/worker";
import { audit } from "@/lib/services/audit";

export type JobListItem = JobRow & {
  website: { id: string; name: string } | null;
  content: { id: string; title: string } | null;
};

export type JobFilters = { status?: string[]; type?: string; websiteId?: string; page?: number; pageSize?: number };

export async function listJobs(ctx: SessionContext, f: JobFilters = {}) {
  const pageSize = f.pageSize ?? 50;
  const page = Math.max(1, f.page ?? 1);
  let q = ctx.supabase
    .from("content_jobs")
    .select("*, websites(id, name), content_items(id, title)", { count: "exact" })
    .eq("organization_id", ctx.org.id)
    .order("created_at", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (f.status?.length) q = q.in("status", f.status);
  if (f.type) q = q.eq("job_type", f.type);
  if (f.websiteId) q = q.eq("website_id", f.websiteId);
  const res = await q;
  const rows = unwrap(res) ?? [];
  return {
    items: rows.map((r) => ({ ...r, website: r.websites, content: r.content_items })) as JobListItem[],
    total: res.count ?? 0,
    page,
    pageCount: Math.max(1, Math.ceil((res.count ?? 0) / pageSize)),
  };
}

export async function cancelJob(ctx: SessionContext, id: string) {
  unwrap(await ctx.supabase.rpc("cancel_job", { p_job: id }));
}

export async function retryJob(ctx: SessionContext, id: string) {
  assertCan(ctx, "jobs.retry");
  unwrap(await ctx.supabase.rpc("retry_job", { p_job: id }));
}

/** Runs a small, time-boxed batch of due jobs in this request (for setups without a worker). */
export async function processDueJobsNow(ctx: SessionContext) {
  assertCan(ctx, "jobs.retry");
  const result = await runWorkerBatch(createProcessorDeps("manual"), { maxJobs: 5, timeBudgetMs: 25_000, organizationId: ctx.org.id });
  await audit(ctx, "jobs.processed_manually", "content_job", null, result);
  return result;
}
