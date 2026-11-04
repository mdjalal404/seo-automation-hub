import { can, type Role } from "@/lib/auth/permissions";
import { formatDateTime } from "@/lib/format";
import { isManuallyRetryable, PENDING_JOB_STATUSES } from "@/lib/jobs/state-machine";
import type { JobListItem } from "@/lib/services/jobs";
import type { JobView } from "@/components/jobs/jobs-table";

export function toJobView(j: JobListItem, role: Role, userId: string): JobView {
  const pending = PENDING_JOB_STATUSES.includes(j.status);
  return {
    id: j.id, job_type: j.job_type, status: j.status, website: j.website?.name ?? "—", content: j.content,
    attempts: `${j.attempts}/${j.max_attempts}`, runAt: formatDateTime(j.run_at), started: formatDateTime(j.started_at), completed: formatDateTime(j.completed_at),
    error: j.error_message, errorCode: j.error_code,
    canCancel: pending && (can(role, "jobs.cancel") || ((j.job_type === "VALIDATE" || j.job_type === "CREATE_DRAFT") && j.created_by === userId)),
    canRetry: can(role, "jobs.retry") && isManuallyRetryable(j),
  };
}
