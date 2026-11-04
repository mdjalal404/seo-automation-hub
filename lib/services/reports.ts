import "server-only";
import { unwrap } from "@/lib/actions/result";
import { can } from "@/lib/auth/permissions";
import type { SessionContext } from "@/lib/auth/session";
import type { AuditLogRow } from "@/lib/database/types";
import { estimateMinutesSaved, successRate, summarizeJobs, type JobAgg } from "@/lib/reporting/metrics";

const ACTIVE = ["QUEUED", "RETRY_SCHEDULED", "VALIDATING", "PUBLISHING", "VERIFYING"];

function counter(ctx: SessionContext) {
  return (table: string) => ctx.supabase.from(table).select("id", { count: "exact", head: true }).eq("organization_id", ctx.org.id);
}

async function n(q: PromiseLike<{ count: number | null; error: unknown }>) {
  const res = await q;
  if (res.error) throw res.error;
  return res.count ?? 0;
}

/** All dashboard numbers are live counts of this workspace's records. */
export async function dashboardMetrics(ctx: SessionContext) {
  const c = counter(ctx);
  const [connectedSites, totalSites, clients, awaitingApproval, failedJobs, pendingJobs, completedJobs, publishCompleted, publishFailed] = await Promise.all([
    n(c("websites").eq("connection_status", "connected")),
    n(c("websites")),
    n(c("clients")),
    n(c("content_items").eq("status", "READY_FOR_REVIEW")),
    n(c("content_jobs").eq("status", "FAILED")),
    n(c("content_jobs").in("status", ACTIVE)),
    n(c("content_jobs").eq("status", "COMPLETED")),
    n(c("content_jobs").eq("job_type", "PUBLISH").eq("status", "COMPLETED")),
    n(c("content_jobs").eq("job_type", "PUBLISH").eq("status", "FAILED")),
  ]);
  const recent = can(ctx.role, "audit.view")
    ? ((unwrap(await ctx.supabase.from("audit_logs").select("*").eq("organization_id", ctx.org.id).order("created_at", { ascending: false }).limit(10)) ?? []) as AuditLogRow[])
    : [];
  const recentJobs = (unwrap(await ctx.supabase.from("content_jobs")
    .select("id, job_type, status, updated_at, error_code, content_items(id, title), websites(name)")
    .eq("organization_id", ctx.org.id).order("updated_at", { ascending: false }).limit(8)) ?? []) as unknown as {
    id: string; job_type: string; status: string; updated_at: string; error_code: string | null;
    content_items: { id: string; title: string } | null; websites: { name: string } | null;
  }[];
  return {
    connectedSites, totalSites, clients, awaitingApproval, failedJobs, pendingJobs, completedJobs,
    publishCompleted, publishFailed, publishSuccessRate: successRate(publishCompleted, publishFailed),
    recent, recentJobs,
  };
}

export async function reportData(ctx: SessionContext, sinceDays: number) {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const [jobsRes, qaRes, orgRes, vfCount] = await Promise.all([
    ctx.supabase.from("content_jobs").select("job_type, status, started_at, completed_at, run_at, attempts, error_code")
      .eq("organization_id", ctx.org.id).gte("created_at", since).limit(10_000),
    ctx.supabase.from("qa_results").select("check_name, severity")
      .eq("organization_id", ctx.org.id).gte("created_at", since).eq("status", "fail").limit(20_000),
    ctx.supabase.from("organizations").select("settings").eq("id", ctx.org.id).single(),
    n(counter(ctx)("content_items").eq("status", "VALIDATION_FAILED")),
  ]);
  const jobs = (unwrap(jobsRes) ?? []) as JobAgg[];
  const qa = (unwrap(qaRes) ?? []) as { check_name: string; severity: string }[];
  const settings = (unwrap(orgRes)?.settings ?? {}) as Record<string, unknown>;

  const tally = (severity: string) => {
    const m = new Map<string, number>();
    for (const r of qa) if (r.severity === severity) m.set(r.check_name, (m.get(r.check_name) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  };
  const summary = summarizeJobs(jobs);
  const minutesPerPublish = Number(settings.minutes_saved_per_publish ?? 20);
  const minutesPerValidation = Number(settings.minutes_saved_per_validation ?? 5);
  return {
    since, summary, validationFailuresNow: vfCount,
    commonWarnings: tally("warning"), commonErrors: tally("error"),
    successRate: successRate(summary.publishCompleted, summary.publishFailed),
    minutesSaved: estimateMinutesSaved({ publishes: summary.publishCompleted, validations: summary.validationsCompleted }, { minutesPerPublish, minutesPerValidation }),
    minutesPerPublish, minutesPerValidation,
  };
}
