import Link from "next/link";
import { NativeSelect } from "@/components/common/native-select";
import { EmptyState, PageHeader } from "@/components/common/page-header";
import { JobsTable } from "@/components/jobs/jobs-table";
import { toJobView } from "@/components/jobs/to-view";
import { Button, buttonVariants } from "@/components/ui/button";
import { requireWorkspace } from "@/lib/auth/session";
import { JOB_STATUSES, JOB_STATUS_LABEL, JOB_TYPE_LABEL, type JobType } from "@/lib/jobs/state-machine";
import { param } from "@/lib/pages";
import { listJobs } from "@/lib/services/jobs";

export const metadata = { title: "Job history" };

export default async function JobHistoryPage({ searchParams }: PageProps<"/job-history">) {
  const sp = await searchParams;
  const status = param(sp.status);
  const type = param(sp.type);
  const websiteId = param(sp.website);
  const page = Number(param(sp.page) ?? 1) || 1;
  const ctx = await requireWorkspace();
  const jobs = await listJobs(ctx, { status: status ? [status] : undefined, type, websiteId, page });
  const link = (p: number) => `/job-history?${new URLSearchParams(Object.entries({ status, type, website: websiteId, page: String(p) }).filter(([, v]) => v) as [string, string][])}`;

  return (
    <>
      <PageHeader title="Job history" description={`${jobs.total} job${jobs.total === 1 ? "" : "s"}. Failed jobs show the reason; retry is offered only where it is safe.`} />
      <form className="mb-4 flex flex-wrap gap-2">
        <NativeSelect name="status" defaultValue={status ?? ""} className="w-44" aria-label="Status">
          <option value="">All statuses</option>
          {JOB_STATUSES.map((s) => <option key={s} value={s}>{JOB_STATUS_LABEL[s]}</option>)}
        </NativeSelect>
        <NativeSelect name="type" defaultValue={type ?? ""} className="w-48" aria-label="Job type">
          <option value="">All job types</option>
          {(Object.keys(JOB_TYPE_LABEL) as JobType[]).map((t) => <option key={t} value={t}>{JOB_TYPE_LABEL[t]}</option>)}
        </NativeSelect>
        {websiteId ? <input type="hidden" name="website" value={websiteId} /> : null}
        <Button type="submit" variant="outline">Filter</Button>
      </form>
      {jobs.items.length === 0 ? <EmptyState title="No jobs match" /> : <JobsTable jobs={jobs.items.map((j) => toJobView(j, ctx.role, ctx.user.id))} />}
      {jobs.pageCount > 1 ? (
        <nav className="mt-4 flex justify-end gap-2" aria-label="Pagination">
          {jobs.page > 1 ? <Link className={buttonVariants({ size: "sm", variant: "outline" })} href={link(jobs.page - 1)}>Previous</Link> : null}
          {jobs.page < jobs.pageCount ? <Link className={buttonVariants({ size: "sm", variant: "outline" })} href={link(jobs.page + 1)}>Next</Link> : null}
        </nav>
      ) : null}
    </>
  );
}
