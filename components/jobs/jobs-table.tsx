"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { bulkCancelJobsAction, cancelJobAction, retryJobAction } from "@/app/actions/jobs";
import { ActionButton } from "@/components/common/action-button";
import { JobStatusBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { JOB_TYPE_LABEL, type JobStatus, type JobType } from "@/lib/jobs/state-machine";

export type JobView = {
  id: string; job_type: JobType; status: JobStatus; website: string; content: { id: string; title: string } | null;
  attempts: string; runAt: string; started: string; completed: string; error: string | null; errorCode: string | null;
  canCancel: boolean; canRetry: boolean;
};

export function JobsTable({ jobs, selectable }: { jobs: JobView[]; selectable?: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const cancellable = jobs.filter((j) => j.canCancel);

  const bulkCancel = () =>
    start(async () => {
      const res = await bulkCancelJobsAction([...selected]);
      if (res.ok) toast.success(res.message ?? "Cancelled");
      else toast.error(res.error);
      setSelected(new Set());
      router.refresh();
    });

  return (
    <>
      {selectable && selected.size ? (
        <div className="mb-3 flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <Button size="sm" variant="destructive" disabled={pending} onClick={bulkCancel}>Cancel selected</Button>
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table data-testid="jobs-table">
          <TableHeader>
            <TableRow>
              {selectable ? <TableHead className="w-8"><Checkbox aria-label="Select all pending" checked={cancellable.length > 0 && selected.size === cancellable.length} onCheckedChange={(v) => setSelected(v ? new Set(cancellable.map((j) => j.id)) : new Set())} /></TableHead> : null}
              <TableHead>Job</TableHead><TableHead>Website</TableHead><TableHead>Content</TableHead><TableHead>Status</TableHead>
              <TableHead>Attempts</TableHead><TableHead>Run at</TableHead><TableHead>Started</TableHead><TableHead>Completed</TableHead><TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((j) => (
              <TableRow key={j.id}>
                {selectable ? <TableCell>{j.canCancel ? <Checkbox aria-label="Select job" checked={selected.has(j.id)} onCheckedChange={() => setSelected((s) => { const n = new Set(s); if (n.has(j.id)) n.delete(j.id); else n.add(j.id); return n; })} /> : null}</TableCell> : null}
                <TableCell className="whitespace-nowrap">{JOB_TYPE_LABEL[j.job_type]}</TableCell>
                <TableCell>{j.website}</TableCell>
                <TableCell className="max-w-56 truncate">{j.content ? <Link className="hover:underline" href={`/content/${j.content.id}`}>{j.content.title}</Link> : "—"}</TableCell>
                <TableCell>
                  <JobStatusBadge status={j.status} />
                  {j.error ? <p className="mt-1 max-w-72 text-xs text-red-700" title={j.errorCode ?? undefined}>{j.errorCode ? `${j.errorCode}: ` : ""}{j.error}</p> : null}
                </TableCell>
                <TableCell className="tabular-nums">{j.attempts}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{j.runAt}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{j.started}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{j.completed}</TableCell>
                <TableCell className="text-right">
                  {j.canRetry ? <ActionButton size="xs" variant="outline" action={() => retryJobAction(j.id)}>Retry</ActionButton> : null}
                  {j.canCancel ? <ActionButton size="xs" variant="ghost" action={() => cancelJobAction(j.id)}>Cancel</ActionButton> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
