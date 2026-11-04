"use server";

import { runAction } from "@/lib/actions/result";
import { requireActionContext } from "@/lib/auth/session";
import * as jobs from "@/lib/services/jobs";

export async function cancelJobAction(id: string) {
  return runAction("job.cancel", async () => (await jobs.cancelJob(await requireActionContext(), id), { ok: true as const, message: "Job cancelled" }));
}
export async function bulkCancelJobsAction(ids: string[]) {
  return runAction("job.bulk_cancel", async () => {
    const ctx = await requireActionContext();
    let ok = 0;
    const errors: string[] = [];
    for (const id of ids.slice(0, 100)) {
      try {
        await jobs.cancelJob(ctx, id);
        ok++;
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    return { ok: true as const, message: errors.length ? `${ok} cancelled, ${errors.length} could not be cancelled` : `${ok} job(s) cancelled` };
  });
}
export async function retryJobAction(id: string) {
  return runAction("job.retry", async () => (await jobs.retryJob(await requireActionContext(), id), { ok: true as const, message: "Job queued for retry" }));
}
export async function processDueJobsAction() {
  return runAction("job.process_now", async () => {
    const r = await jobs.processDueJobsNow(await requireActionContext());
    return { ok: true as const, message: r.processed ? `Processed ${r.processed} job(s): ${Object.entries(r.outcomes).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", ")}` : "No jobs were due" };
  });
}
