import { ListOrdered } from "lucide-react";
import { processDueJobsAction } from "@/app/actions/jobs";
import { ActionButton } from "@/components/common/action-button";
import { EmptyState, PageHeader } from "@/components/common/page-header";
import { JobsTable } from "@/components/jobs/jobs-table";
import { toJobView } from "@/components/jobs/to-view";
import { can } from "@/lib/auth/permissions";
import { requireWorkspace } from "@/lib/auth/session";
import { ACTIVE_JOB_STATUSES } from "@/lib/jobs/state-machine";
import { listJobs } from "@/lib/services/jobs";

export const metadata = { title: "Content queue" };

export default async function QueuePage() {
  const ctx = await requireWorkspace();
  const jobs = await listJobs(ctx, { status: [...ACTIVE_JOB_STATUSES], pageSize: 200 });
  const ordered = [...jobs.items].sort((a, b) => a.run_at.localeCompare(b.run_at));
  return (
    <>
      <PageHeader
        title="Content queue"
        description="Pending, scheduled and running jobs, in execution order. Jobs are persisted and processed by the background worker."
        actions={can(ctx.role, "jobs.retry") ? (
          <ActionButton size="sm" variant="outline" action={processDueJobsAction}>Process due jobs now</ActionButton>
        ) : null}
      />
      {ordered.length === 0 ? (
        <EmptyState icon={<ListOrdered className="size-6" />} title="The queue is empty" description="Approved articles appear here once you publish or schedule them." />
      ) : (
        <JobsTable selectable jobs={ordered.map((j) => toJobView(j, ctx.role, ctx.user.id))} />
      )}
    </>
  );
}
