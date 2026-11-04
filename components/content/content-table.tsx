"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { bulkContentAction } from "@/app/actions/content";
import { ContentStatusBadge, ValidationBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ContentStatus } from "@/lib/content/state-machine";

export type ContentRowView = {
  id: string; title: string; status: ContentStatus; validation_status: string; scheduled: string; client: string; website: string; published_url: string | null;
};

const publishingLabel = (r: ContentRowView) =>
  r.status === "PUBLISHED" ? "Live, verified" : r.status === "VERIFICATION_FAILED" ? "Live, needs review" : r.status === "PUBLISH_FAILED" ? "Failed"
  : ["QUEUED", "PUBLISHING", "VERIFYING"].includes(r.status) ? "In progress" : "Not published";

export function ContentTable({ rows, canApprove, canPublish, canValidate }: { rows: ContentRowView[]; canApprove: boolean; canPublish: boolean; canValidate: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, start] = useTransition();
  const ids = [...selected];

  const run = (op: "validate" | "approve" | "draft" | "publish", confirmPublish = false) =>
    start(async () => {
      const res = await bulkContentAction({ ids, op, batchKey: crypto.randomUUID(), confirmPublish });
      if (res.ok) toast.success(res.message ?? "Done");
      else toast.error(res.error);
      setSelected(new Set());
      setConfirmOpen(false);
      setAcknowledged(false);
      router.refresh();
    });

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <>
      {selected.size ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm" role="toolbar" aria-label="Bulk actions">
          <span className="mr-2 font-medium">{selected.size} selected</span>
          {canValidate ? <Button size="sm" variant="outline" disabled={pending} onClick={() => run("validate")}>Queue validation</Button> : null}
          {canValidate ? <Button size="sm" variant="outline" disabled={pending} onClick={() => run("draft")}>Create CMS drafts</Button> : null}
          {canApprove ? <Button size="sm" variant="outline" disabled={pending} onClick={() => run("approve")}>Approve ready items</Button> : null}
          {canPublish ? <Button size="sm" disabled={pending} onClick={() => setConfirmOpen(true)}>Publish approved…</Button> : null}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <Checkbox aria-label="Select all" checked={rows.length > 0 && selected.size === rows.length} onCheckedChange={(v) => setSelected(v ? new Set(rows.map((r) => r.id)) : new Set())} />
              </TableHead>
              <TableHead>Title</TableHead><TableHead>Client</TableHead><TableHead>Website</TableHead><TableHead>Status</TableHead>
              <TableHead>Scheduled</TableHead><TableHead>Validation</TableHead><TableHead>Publishing</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id} data-state={selected.has(r.id) ? "selected" : undefined}>
                <TableCell><Checkbox aria-label={`Select ${r.title}`} checked={selected.has(r.id)} onCheckedChange={() => toggle(r.id)} /></TableCell>
                <TableCell className="max-w-xs truncate font-medium"><Link className="hover:underline" href={`/content/${r.id}`}>{r.title || "Untitled"}</Link></TableCell>
                <TableCell>{r.client}</TableCell>
                <TableCell>{r.website}</TableCell>
                <TableCell><ContentStatusBadge status={r.status} /></TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{r.scheduled}</TableCell>
                <TableCell><ValidationBadge status={r.validation_status} /></TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{r.published_url ? <a className="underline" href={r.published_url} target="_blank" rel="noopener noreferrer">{publishingLabel(r)}</a> : publishingLabel(r)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish {selected.size} item(s)?</DialogTitle>
            <DialogDescription>Only items that are approved and unchanged since approval will be queued; others are skipped with a reason. Publishing makes posts live on client websites.</DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={acknowledged} onCheckedChange={(v) => setAcknowledged(!!v)} aria-label="Confirm bulk publishing" />
            I confirm these articles should be published to their live websites.
          </label>
          <DialogFooter>
            <Button disabled={!acknowledged || pending} onClick={() => run("publish", true)}>{pending ? "Queuing…" : "Queue for publishing"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
