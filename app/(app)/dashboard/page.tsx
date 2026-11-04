import Link from "next/link";
import { JobStatusBadge } from "@/components/common/status-badge";
import { EmptyState, PageHeader, StatCard } from "@/components/common/page-header";
import { buttonVariants } from "@/components/ui/button";
import { requireWorkspace } from "@/lib/auth/session";
import { formatRelative, humanize } from "@/lib/format";
import { JOB_TYPE_LABEL, type JobStatus, type JobType } from "@/lib/jobs/state-machine";
import { dashboardMetrics } from "@/lib/services/reports";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const ctx = await requireWorkspace();
  const m = await dashboardMetrics(ctx);
  const empty = m.totalSites === 0 && m.clients === 0;

  return (
    <>
      <PageHeader title="Dashboard" description={`Live figures for ${ctx.org.name}.`} actions={
        <Link href="/content/new" className={buttonVariants({ size: "sm" })}>New article</Link>
      } />
      {empty ? (
        <EmptyState
          title="Start by adding a client and connecting their website (WordPress, Webflow, Shopify or a custom CMS)"
          description="Once a site is connected you can import or write content, validate it, approve it and publish."
          action={<Link href="/clients" className={buttonVariants({ size: "sm" })}>Add a client</Link>}
        />
      ) : null}
      <div className="mt-2 grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="dashboard-metrics">
        <StatCard label="Connected websites" value={<span data-testid="metric-connected">{m.connectedSites}</span>} hint={`${m.totalSites} total`} />
        <StatCard label="Active clients" value={m.clients} />
        <StatCard label="Jobs completed" value={<span data-testid="metric-completed">{m.completedJobs}</span>} hint={`${m.pendingJobs} pending or running`} />
        <StatCard label="Awaiting approval" value={<Link className="hover:underline" href="/content?status=READY_FOR_REVIEW">{m.awaitingApproval}</Link>} />
        <StatCard label="Failed jobs" value={<Link className={m.failedJobs ? "text-red-700 hover:underline" : "hover:underline"} href="/job-history?status=FAILED">{m.failedJobs}</Link>} />
        <StatCard
          label="Publishing success rate"
          value={<span data-testid="metric-success-rate">{m.publishSuccessRate === null ? "—" : `${m.publishSuccessRate}%`}</span>}
          hint={`${m.publishCompleted} published · ${m.publishFailed} failed`}
        />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border bg-card">
          <h2 className="border-b px-4 py-3 text-sm font-semibold">Latest jobs</h2>
          {m.recentJobs.length ? (
            <ul className="divide-y">
              {m.recentJobs.map((j) => (
                <li key={j.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{j.content_items ? <Link className="hover:underline" href={`/content/${j.content_items.id}`}>{j.content_items.title}</Link> : "—"}</p>
                    <p className="text-xs text-muted-foreground">{JOB_TYPE_LABEL[j.job_type as JobType]} · {j.websites?.name} · {formatRelative(j.updated_at)}</p>
                  </div>
                  <JobStatusBadge status={j.status as JobStatus} />
                </li>
              ))}
            </ul>
          ) : <p className="px-4 py-6 text-sm text-muted-foreground">No jobs yet.</p>}
        </section>
        <section className="rounded-xl border bg-card">
          <h2 className="border-b px-4 py-3 text-sm font-semibold">Recent activity</h2>
          {m.recent.length ? (
            <ul className="divide-y">
              {m.recent.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <span className="capitalize">{humanize(a.action)}</span>
                  <span className="text-xs text-muted-foreground">{formatRelative(a.created_at)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="px-4 py-6 text-sm text-muted-foreground">{ctx.role === "owner" || ctx.role === "admin" ? "No activity yet." : "The audit trail is visible to owners and admins."}</p>}
        </section>
      </div>
    </>
  );
}
