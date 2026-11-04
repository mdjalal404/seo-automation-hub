"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  approveContentAction, cancelContentAction, deleteContentAction, pushDraftAction, reopenContentAction,
  reverifyAction, revokeApprovalAction, schedulePublishAction, validateContentAction,
} from "@/app/actions/content";
import { cancelJobAction } from "@/app/actions/jobs";
import { ActionButton } from "@/components/common/action-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ContentStatus } from "@/lib/content/state-machine";

const key = () => crypto.randomUUID();

export type WorkflowPermissions = { canEdit: boolean; canValidate: boolean; canApprove: boolean; canPublish: boolean; canPushDraft: boolean };

export function WorkflowPanel({ id, status, validationStatus, connected, timezone, activePublishJobId, perms, hasPublishedUrl }: {
  id: string; status: ContentStatus; validationStatus: string; connected: boolean; timezone: string;
  activePublishJobId: string | null; perms: WorkflowPermissions; hasPublishedUrl: boolean;
}) {
  const locked = status === "QUEUED" || status === "PUBLISHING" || status === "VERIFYING";
  return (
    <div className="grid gap-2">
      {perms.canValidate && !locked && !["CANCELLED", "PUBLISHED", "VERIFICATION_FAILED", "PUBLISH_FAILED"].includes(status) ? (
        <ActionButton variant={status === "DRAFT" || validationStatus === "STALE" ? "default" : "outline"} action={() => validateContentAction(id, key())}>
          Run SEO validation
        </ActionButton>
      ) : null}
      {perms.canApprove && status === "READY_FOR_REVIEW" ? (
        <ActionButton action={() => approveContentAction(id)}
          confirm={{ title: "Approve this article?", description: "Approval is recorded in the audit log. Any material edit afterwards withdraws it automatically.", confirmLabel: "Approve" }}>
          Approve for publishing
        </ActionButton>
      ) : null}
      {perms.canPublish && status === "APPROVED" ? (
        connected ? <PublishDialog id={id} timezone={timezone} /> : <p className="text-xs text-muted-foreground">Connect the website to publish.</p>
      ) : null}
      {perms.canApprove && status === "APPROVED" ? (
        <ActionButton variant="outline" action={() => revokeApprovalAction(id)}>Withdraw approval</ActionButton>
      ) : null}
      {perms.canPushDraft && connected && !locked && !["PUBLISHED", "CANCELLED", "VERIFICATION_FAILED"].includes(status) ? (
        <ActionButton variant="outline" action={() => pushDraftAction(id, key())}>Save as CMS draft</ActionButton>
      ) : null}
      {perms.canPublish && activePublishJobId && status === "QUEUED" ? (
        <ActionButton variant="outline" action={() => cancelJobAction(activePublishJobId)}
          confirm={{ title: "Cancel publishing?", description: "The queued job is cancelled before it runs. The article stays approved.", confirmLabel: "Cancel job" }}>
          Cancel scheduled publish
        </ActionButton>
      ) : null}
      {perms.canPublish && hasPublishedUrl && (status === "PUBLISHED" || status === "VERIFICATION_FAILED") && connected ? (
        <ActionButton variant="outline" action={() => reverifyAction(id, key())}>Re-verify live page</ActionButton>
      ) : null}
      {perms.canEdit && ["CANCELLED", "VALIDATION_FAILED", "PUBLISH_FAILED", "VERIFICATION_FAILED", "PUBLISHED", "READY_FOR_REVIEW", "APPROVED"].includes(status) ? (
        <ActionButton variant="ghost" action={() => reopenContentAction(id)}>Return to draft</ActionButton>
      ) : null}
      {perms.canApprove && !locked && !["CANCELLED", "PUBLISHED"].includes(status) ? (
        <ActionButton variant="ghost" action={() => cancelContentAction(id)}>Cancel article</ActionButton>
      ) : null}
      {perms.canEdit && !locked ? (
        <ActionButton variant="ghost" className="text-destructive" action={() => deleteContentAction(id)} redirectTo="/content"
          confirm={{ title: "Delete this article?", description: "It is removed from this app with its validation and job history. Any post in the CMS is left unchanged.", destructive: true, confirmLabel: "Delete" }}>
          Delete
        </ActionButton>
      ) : null}
    </div>
  );
}

function PublishDialog({ id, timezone }: { id: string; timezone: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState("");
  const [requestKey] = useState(key); // stable across double-submits of this dialog
  const [pending, start] = useTransition();

  const submit = () =>
    start(async () => {
      const res = await schedulePublishAction({ contentId: id, localDateTime: when, requestKey });
      if (!res.ok) return void toast.error(res.error);
      toast.success(res.message ?? "Queued");
      setOpen(false);
      router.refresh();
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button>Publish…</Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish to the CMS</DialogTitle>
          <DialogDescription>The background worker publishes the approved version, then fetches the live page to verify it.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="publish-at">Publish at (website time: {timezone})</Label>
          <Input id="publish-at" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          <p className="text-xs text-muted-foreground">Leave empty to publish as soon as the worker picks it up.</p>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={pending}>{pending ? "Queuing…" : when ? "Schedule" : "Publish now"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
