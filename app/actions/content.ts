"use server";

import { runAction } from "@/lib/actions/result";
import { requireActionContext } from "@/lib/auth/session";
import { CONTENT_STATUS_LABEL } from "@/lib/content/state-machine";
import * as content from "@/lib/services/content";

export async function createContentAction(input: unknown) {
  return runAction("content.create", async () => ({ ok: true as const, data: await content.createContent(await requireActionContext(), input), message: "Draft saved" }));
}
export async function updateContentAction(id: string, input: unknown) {
  return runAction("content.update", async () => {
    const r = await content.updateContent(await requireActionContext(), id, input);
    return { ok: true as const, data: r, message: r.invalidatedApproval ? "Saved. The previous approval no longer applies — validate and approve again." : `Saved (${CONTENT_STATUS_LABEL[r.status]})` };
  });
}
export async function deleteContentAction(id: string) {
  return runAction("content.delete", async () => (await content.deleteContent(await requireActionContext(), id), { ok: true as const, message: "Content deleted" }));
}
export async function validateContentAction(id: string, requestKey: string) {
  return runAction("content.validate", async () => (await content.validateNow(await requireActionContext(), id, requestKey), { ok: true as const, message: "Validation finished" }));
}
export async function approveContentAction(id: string) {
  return runAction("content.approve", async () => (await content.approveContent(await requireActionContext(), id), { ok: true as const, message: "Approved for publishing" }));
}
export async function revokeApprovalAction(id: string) {
  return runAction("content.revoke", async () => (await content.revokeApproval(await requireActionContext(), id), { ok: true as const, message: "Approval withdrawn" }));
}
export async function reopenContentAction(id: string) {
  return runAction("content.reopen", async () => (await content.reopenContent(await requireActionContext(), id), { ok: true as const, message: "Moved back to draft" }));
}
export async function cancelContentAction(id: string) {
  return runAction("content.cancel", async () => (await content.cancelContent(await requireActionContext(), id), { ok: true as const, message: "Content cancelled" }));
}
export async function schedulePublishAction(input: { contentId: string; localDateTime: string; requestKey: string }) {
  return runAction("content.publish", async () => {
    await content.schedulePublish(await requireActionContext(), input);
    return { ok: true as const, message: input.localDateTime ? "Publication scheduled" : "Queued for publishing" };
  });
}
export async function pushDraftAction(id: string, requestKey: string) {
  return runAction("content.push_draft", async () => (await content.pushDraft(await requireActionContext(), id, requestKey), { ok: true as const, message: "CMS draft job queued" }));
}
export async function reverifyAction(id: string, requestKey: string) {
  return runAction("content.reverify", async () => (await content.reverify(await requireActionContext(), id, requestKey), { ok: true as const, message: "Verification queued" }));
}

type BulkOp = "validate" | "approve" | "draft" | "publish";

/** Bulk operations. Publishing requires `confirmPublish: true` from an explicit confirmation dialog. */
export async function bulkContentAction(input: { ids: string[]; op: BulkOp; batchKey: string; confirmPublish?: boolean }) {
  return runAction("content.bulk", async () => {
    const ctx = await requireActionContext();
    if (input.op === "publish" && input.confirmPublish !== true) {
      return { ok: false as const, error: "Bulk publishing requires explicit confirmation." };
    }
    const ops: Record<BulkOp, (id: string) => Promise<unknown>> = {
      validate: (id) => content.enqueueValidation(ctx, id, `${input.batchKey}:${id}`),
      approve: (id) => content.approveContent(ctx, id),
      draft: (id) => content.pushDraft(ctx, id, `${input.batchKey}:${id}`),
      publish: (id) => content.schedulePublish(ctx, { contentId: id, localDateTime: "", requestKey: `${input.batchKey}:${id}` }),
    };
    const results = await content.bulk(ctx, input.ids, ops[input.op]);
    const okCount = results.filter((r) => r.ok).length;
    const failures = results.filter((r) => !r.ok);
    return {
      ok: true as const,
      data: results,
      message: failures.length ? `${okCount} succeeded, ${failures.length} skipped: ${failures[0].error}` : `${okCount} item(s) processed`,
    };
  });
}

export async function previewAction(body: string, format: "markdown" | "html") {
  return runAction("content.preview", async () => {
    await requireActionContext();
    const { renderBody, sanitizeForPreview } = await import("@/lib/seo/html");
    return sanitizeForPreview(renderBody(String(body).slice(0, 500_000), format === "html" ? "html" : "markdown"));
  });
}
