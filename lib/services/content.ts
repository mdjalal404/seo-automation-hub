import "server-only";
import { unwrap } from "@/lib/actions/result";
import { canEditContent } from "@/lib/auth/permissions";
import { assertCan, type SessionContext } from "@/lib/auth/session";
import { isLocked, type ContentStatus } from "@/lib/content/state-machine";
import type { ContentRow, JobRow, QaResultRow, WebsiteRow } from "@/lib/database/types";
import { AppError, toUserMessage } from "@/lib/errors";
import { processJob } from "@/lib/publishing/processor";
import { createProcessorDeps } from "@/lib/publishing/worker";
import { zonedLocalToUtc } from "@/lib/scheduling/timezone";
import { audit } from "@/lib/services/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { contentSchema, scheduleSchema, slugify, type ContentInput } from "@/lib/validation/schemas";

export type ContentFilters = { q?: string; status?: string; websiteId?: string; clientId?: string; page?: number };
export const PAGE_SIZE = 25;

export type ContentListItem = ContentRow & { website: { id: string; name: string; timezone: string; client: { id: string; name: string } | null } | null };

export async function listContent(ctx: SessionContext, f: ContentFilters) {
  const page = Math.max(1, f.page ?? 1);
  let q = ctx.supabase
    .from("content_items")
    .select("id, title, slug, status, validation_status, scheduled_at, published_url, updated_at, website_id, created_by, assigned_to, websites!inner(id, name, timezone, client_id, clients(id, name))", { count: "exact" })
    .eq("organization_id", ctx.org.id)
    .order("updated_at", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (f.status) q = q.eq("status", f.status);
  if (f.websiteId) q = q.eq("website_id", f.websiteId);
  if (f.clientId) q = q.eq("websites.client_id", f.clientId);
  if (f.q) q = q.ilike("title", `%${f.q.replace(/[%_\\]/g, "\\$&")}%`);
  const res = await q;
  const rows = unwrap(res) ?? [];
  return {
    items: rows.map((r) => {
      const w = r.websites as unknown as { id: string; name: string; timezone: string; clients: { id: string; name: string } | null };
      return { ...(r as unknown as ContentRow), website: w ? { id: w.id, name: w.name, timezone: w.timezone, client: w.clients } : null };
    }) as ContentListItem[],
    total: res.count ?? 0,
    page,
    pageCount: Math.max(1, Math.ceil((res.count ?? 0) / PAGE_SIZE)),
  };
}

export async function getContent(ctx: SessionContext, id: string) {
  const item = unwrap(await ctx.supabase.from("content_items").select("*").eq("id", id).eq("organization_id", ctx.org.id).maybeSingle()) as ContentRow | null;
  if (!item) throw new AppError("NOT_FOUND", "Content not found.");
  const [website, qa, jobs] = await Promise.all([
    ctx.supabase.from("websites").select("*, clients(id, name)").eq("id", item.website_id).single(),
    ctx.supabase.from("qa_results").select("*").eq("content_item_id", id).order("created_at"),
    ctx.supabase.from("content_jobs").select("*").eq("content_item_id", id).order("created_at", { ascending: false }).limit(20),
  ]);
  return {
    item,
    website: unwrap(website) as WebsiteRow & { clients: { id: string; name: string } | null },
    qa: (unwrap(qa) ?? []) as QaResultRow[],
    jobs: (unwrap(jobs) ?? []) as JobRow[],
  };
}

function toColumns(v: ContentInput) {
  return {
    website_id: v.websiteId,
    title: v.title,
    slug: v.slug || slugify(v.title),
    body: v.body,
    body_format: v.bodyFormat,
    excerpt: v.excerpt,
    meta_title: v.metaTitle,
    meta_description: v.metaDescription,
    canonical_url: v.canonicalUrl,
    target_keyword: v.targetKeyword,
    categories: v.categories,
    tags: v.tags,
    featured_media_id: v.featuredMediaId,
    assigned_to: v.assignedTo,
  };
}

export async function createContent(ctx: SessionContext, input: unknown) {
  assertCan(ctx, "content.create");
  const v = contentSchema.parse(input);
  const row = unwrap(await ctx.supabase.from("content_items").insert({ ...toColumns(v), organization_id: ctx.org.id, created_by: ctx.user.id }).select("id").single());
  await audit(ctx, "content.created", "content_item", row.id);
  return row.id as string;
}

export async function updateContent(ctx: SessionContext, id: string, input: unknown) {
  const v = contentSchema.parse(input);
  const { item } = await getContent(ctx, id);
  if (!canEditContent(ctx.role, ctx.user.id, item)) throw new AppError("FORBIDDEN", "You can only edit content you created or are assigned to.");
  if (isLocked(item.status)) throw new AppError("CONFLICT", "This content is locked while a publishing job is active. Cancel the job to edit.");
  const before = item.content_hash;
  const updated = unwrap(await ctx.supabase.from("content_items").update(toColumns(v)).eq("id", id).eq("organization_id", ctx.org.id).select("content_hash, status").single());
  const invalidated = updated.content_hash !== before && !!item.approved_at;
  await audit(ctx, "content.updated", "content_item", id, invalidated ? { approval_invalidated: true } : {});
  return { invalidatedApproval: invalidated, status: updated.status as ContentStatus };
}

export async function deleteContent(ctx: SessionContext, id: string) {
  const { item } = await getContent(ctx, id);
  if (!canEditContent(ctx.role, ctx.user.id, item)) throw new AppError("FORBIDDEN", "Not allowed.");
  const rows = unwrap(await ctx.supabase.from("content_items").delete().eq("id", id).eq("organization_id", ctx.org.id).select("id"));
  if (!rows?.length) throw new AppError("CONFLICT", "Content with an active job cannot be deleted.");
  await audit(ctx, "content.deleted", "content_item", id);
}

/**
 * Runs validation now, through a persisted VALIDATE job (same record and code path
 * as background jobs). The RPC enforces the caller's role; the processor writes results.
 */
export async function validateNow(ctx: SessionContext, id: string, requestKey: string) {
  assertCan(ctx, "content.validate");
  const { item } = await getContent(ctx, id);
  if (!canEditContent(ctx.role, ctx.user.id, item)) throw new AppError("FORBIDDEN", "You can only validate content you created or are assigned to.");
  const jobId = unwrap(await ctx.supabase.rpc("enqueue_content_job", { p_content: id, p_job_type: "VALIDATE", p_request_key: requestKey })) as string;
  const deps = createProcessorDeps("inline");
  const claimed = unwrap(await createAdminClient().rpc("claim_job", { p_job: jobId, p_worker: deps.workerId, p_lease_seconds: 120 })) as JobRow[];
  if (claimed?.[0]) await processJob(claimed[0], deps);
  return jobId;
}

export async function enqueueValidation(ctx: SessionContext, id: string, requestKey: string) {
  assertCan(ctx, "content.validate");
  return unwrap(await ctx.supabase.rpc("enqueue_content_job", { p_content: id, p_job_type: "VALIDATE", p_request_key: requestKey })) as string;
}

export async function approveContent(ctx: SessionContext, id: string) {
  assertCan(ctx, "content.approve");
  unwrap(await ctx.supabase.rpc("approve_content", { p_content: id }));
}

export async function revokeApproval(ctx: SessionContext, id: string) {
  assertCan(ctx, "content.approve");
  unwrap(await ctx.supabase.rpc("revoke_approval", { p_content: id }));
}

export async function reopenContent(ctx: SessionContext, id: string) {
  unwrap(await ctx.supabase.rpc("reopen_content", { p_content: id }));
}

export async function cancelContent(ctx: SessionContext, id: string) {
  assertCan(ctx, "content.approve");
  unwrap(await ctx.supabase.rpc("cancel_content", { p_content: id }));
}

/** Queues publication now or at a website-local time (converted to UTC here, stored as UTC). */
export async function schedulePublish(ctx: SessionContext, input: unknown) {
  assertCan(ctx, "content.publish");
  const v = scheduleSchema.parse(input);
  const { item, website } = await getContent(ctx, v.contentId);
  let runAt: string | null = null;
  if (v.localDateTime) {
    const at = zonedLocalToUtc(v.localDateTime, website.timezone);
    if (at.getTime() < Date.now() - 60_000) throw new AppError("INVALID_INPUT", "The scheduled time is in the past for this website's timezone.");
    runAt = at.toISOString();
  }
  if (item.scheduled_at !== runAt) {
    unwrap(await ctx.supabase.from("content_items").update({ scheduled_at: runAt }).eq("id", item.id).eq("organization_id", ctx.org.id));
  }
  return unwrap(await ctx.supabase.rpc("enqueue_content_job", { p_content: item.id, p_job_type: "PUBLISH", p_request_key: v.requestKey, p_run_at: runAt })) as string;
}

export async function pushDraft(ctx: SessionContext, id: string, requestKey: string) {
  assertCan(ctx, "content.push_draft");
  return unwrap(await ctx.supabase.rpc("enqueue_content_job", { p_content: id, p_job_type: "CREATE_DRAFT", p_request_key: requestKey })) as string;
}

export async function reverify(ctx: SessionContext, id: string, requestKey: string) {
  assertCan(ctx, "content.publish");
  return unwrap(await ctx.supabase.rpc("enqueue_content_job", { p_content: id, p_job_type: "VERIFY", p_request_key: requestKey })) as string;
}

export type BulkOutcome = { id: string; ok: boolean; error?: string };

export async function bulk(ctx: SessionContext, ids: string[], op: (id: string) => Promise<unknown>): Promise<BulkOutcome[]> {
  if (ids.length > 100) throw new AppError("INVALID_INPUT", "Select at most 100 items at a time.");
  const out: BulkOutcome[] = [];
  for (const id of ids) {
    try {
      await op(id);
      out.push({ id, ok: true });
    } catch (err) {
      out.push({ id, ok: false, error: toUserMessage(err) });
    }
  }
  return out;
}
