/** Pure aggregation helpers for dashboard and reports (inputs are real DB rows). */
export type JobAgg = { job_type: string; status: string; started_at: string | null; completed_at: string | null; run_at: string; attempts: number; error_code: string | null };

export function successRate(completed: number, failed: number): number | null {
  const total = completed + failed;
  return total === 0 ? null : Math.round((completed / total) * 1000) / 10;
}

export function summarizeJobs(jobs: JobAgg[]) {
  const by = (type: string, status: string) => jobs.filter((j) => j.job_type === type && j.status === status).length;
  const durations = jobs.filter((j) => j.status === "COMPLETED" && j.started_at && j.completed_at)
    .map((j) => new Date(j.completed_at!).getTime() - new Date(j.started_at!).getTime());
  const delays = jobs.filter((j) => j.started_at).map((j) => Math.max(0, new Date(j.started_at!).getTime() - new Date(j.run_at).getTime()));
  const errors = new Map<string, number>();
  for (const j of jobs) if (j.status === "FAILED" && j.error_code) errors.set(j.error_code, (errors.get(j.error_code) ?? 0) + 1);
  return {
    publishCompleted: by("PUBLISH", "COMPLETED"),
    publishFailed: by("PUBLISH", "FAILED"),
    validationsCompleted: by("VALIDATE", "COMPLETED"),
    draftsCompleted: by("CREATE_DRAFT", "COMPLETED"),
    failed: jobs.filter((j) => j.status === "FAILED").length,
    retries: jobs.reduce((n, j) => n + Math.max(0, j.attempts - 1), 0),
    medianDurationMs: median(durations),
    medianQueueDelayMs: median(delays),
    topErrors: [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}

export function estimateMinutesSaved(counts: { publishes: number; validations: number }, settings: { minutesPerPublish: number; minutesPerValidation: number }) {
  return counts.publishes * settings.minutesPerPublish + counts.validations * settings.minutesPerValidation;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
