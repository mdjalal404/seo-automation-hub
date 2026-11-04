import Link from "next/link";
import { PageHeader, StatCard } from "@/components/common/page-header";
import { requireWorkspace } from "@/lib/auth/session";
import { formatDuration } from "@/lib/format";
import { param } from "@/lib/pages";
import { listChecks } from "@/lib/seo/engine";
import { reportData } from "@/lib/services/reports";
import { cn } from "@/lib/utils";

export const metadata = { title: "Reports" };
const RANGES = [7, 30, 90];

export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  const days = RANGES.includes(Number(param((await searchParams).days))) ? Number(param((await searchParams).days)) : 30;
  const ctx = await requireWorkspace();
  const r = await reportData(ctx, days);
  const labels = new Map(listChecks().map((c) => [c.name, c.label]));
  const label = (n: string) => labels.get(n) ?? n.replace(/_/g, " ");
  const hours = Math.round((r.minutesSaved / 60) * 10) / 10;

  return (
    <>
      <PageHeader title="Reports" description="Counts are computed from job and validation records in this workspace." actions={
        <div className="flex gap-1 text-sm">{RANGES.map((d) => <Link key={d} href={`/reports?days=${d}`} className={cn("rounded-md px-2.5 py-1", d === days ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted")}>{d} days</Link>)}</div>
      } />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Successful publishing jobs" value={r.summary.publishCompleted} hint={r.successRate === null ? "No publishing jobs yet" : `${r.successRate}% success rate`} />
        <StatCard label="Failed jobs" value={r.summary.failed} hint={`${r.summary.publishFailed} publishing`} />
        <StatCard label="Validation failures (current)" value={r.validationFailuresNow} hint="Articles currently blocked by errors" />
        <StatCard label="Estimated time saved" value={`${hours} h`} hint={<>Estimate: {r.minutesPerPublish} min/publish, {r.minutesPerValidation} min/validation — <Link className="underline" href="/settings">adjust</Link></>} />
        <StatCard label="Validations run" value={r.summary.validationsCompleted} />
        <StatCard label="CMS drafts created" value={r.summary.draftsCompleted} />
        <StatCard label="Automatic retries" value={r.summary.retries} />
        <StatCard label="Median job duration" value={formatDuration(r.summary.medianDurationMs)} hint={`Median queue delay ${formatDuration(r.summary.medianQueueDelayMs)}`} />
      </div>
      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        {[
          ["Most common warnings", r.commonWarnings],
          ["Most common errors", r.commonErrors],
          ["Job failure reasons", r.summary.topErrors],
        ].map(([title, rows]) => (
          <section key={title as string} className="rounded-xl border bg-card">
            <h2 className="border-b px-4 py-3 text-sm font-semibold">{title as string}</h2>
            {(rows as [string, number][]).length ? (
              <ul className="divide-y text-sm">{(rows as [string, number][]).map(([k, n]) => <li key={k} className="flex justify-between px-4 py-2"><span>{label(k)}</span><span className="tabular-nums text-muted-foreground">{n}</span></li>)}</ul>
            ) : <p className="px-4 py-6 text-sm text-muted-foreground">Nothing in this period.</p>}
          </section>
        ))}
      </div>
      <p className="mt-6 text-xs text-muted-foreground">Time saved is an estimate based on your configured minutes per task, not a measurement.</p>
    </>
  );
}
