import type { CmsCredentials } from "@/lib/cms/credentials";
import { isAuthFailureCode } from "@/lib/cms/platforms";
import type { CmsAdapter, SeoSyncState } from "@/lib/cms/types";
import { canTransition, type ContentStatus } from "@/lib/content/state-machine";
import type { ContentRow, JobRow, ValidationStatus } from "@/lib/database/types";
import { AppError, isAppError } from "@/lib/errors";
import { decideOnFailure } from "@/lib/jobs/state-machine";
import { logger, metric } from "@/lib/observability/logger";
import { toCheckInput, toPostPayload } from "@/lib/publishing/payload";
import type { JobContext, JobRepository } from "@/lib/publishing/repository";
import type { HttpClient } from "@/lib/security/safe-fetch";
import { runValidation, summarize } from "@/lib/seo/engine";
import { normalizeText } from "@/lib/seo/html";
import { verifyLivePage } from "@/lib/seo/verification";

export type ProcessorDeps = {
  repo: JobRepository;
  http: HttpClient;
  workerId: string;
  leaseSeconds?: number;
  decryptCredentials(ctx: JobContext): CmsCredentials;
  createAdapter(ctx: JobContext, credentials: CmsCredentials): CmsAdapter;
  random?: () => number;
};

class LeaseLost extends Error {}

/**
 * Executes one claimed job. Job states: QUEUED → VALIDATING → PUBLISHING → VERIFYING → COMPLETED,
 * with FAILED / RETRY_SCHEDULED on errors. Every state is persisted before the next external call,
 * so a crash at any point leaves enough information to reconcile on the next attempt.
 */
export async function processJob(job: JobRow, deps: ProcessorDeps): Promise<JobRow["status"]> {
  const started = Date.now();
  metric("job.queue_delay_ms", Math.max(0, started - new Date(job.run_at).getTime()), { job_type: job.job_type });
  let ctx: JobContext | null = null;
  try {
    ctx = await deps.repo.loadContext(job);
    const status = await dispatch(ctx, deps);
    metric("job.duration_ms", Date.now() - started, { job_type: job.job_type, outcome: status });
    return status;
  } catch (err) {
    if (err instanceof LeaseLost) {
      logger.warn("job.lease_lost", { jobId: job.id });
      return job.status;
    }
    const outcome = await handleFailure(job, ctx, err, deps);
    metric("job.duration_ms", Date.now() - started, { job_type: job.job_type, outcome });
    return outcome;
  }
}

async function dispatch(ctx: JobContext, deps: ProcessorDeps) {
  switch (ctx.job.job_type) {
    case "VALIDATE":
      return runValidateJob(ctx, deps);
    case "CREATE_DRAFT":
      return runCreateDraftJob(ctx, deps);
    case "PUBLISH":
      return runPublishJob(ctx, deps);
    case "VERIFY":
      return runVerifyJob(ctx, deps);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function setJob(ctx: JobContext, deps: ProcessorDeps, patch: Parameters<JobRepository["updateJob"]>[2]) {
  const renew = patch.status && !["COMPLETED", "FAILED", "CANCELLED", "RETRY_SCHEDULED"].includes(patch.status);
  const ok = await deps.repo.updateJob(ctx.job, deps.workerId, {
    ...(renew ? { lease_expires_at: new Date(Date.now() + (deps.leaseSeconds ?? 300) * 1000).toISOString() } : {}),
    ...patch,
  });
  if (!ok) throw new LeaseLost();
  Object.assign(ctx.job, patch);
}

async function setContent(ctx: JobContext, deps: ProcessorDeps, patch: Parameters<JobRepository["updateContent"]>[1]) {
  if (!ctx.content) return;
  if (patch.status && !canTransition(ctx.content.status, patch.status)) {
    throw new AppError("CONFLICT", `Content cannot move from ${ctx.content.status} to ${patch.status}.`);
  }
  ctx.content = await deps.repo.updateContent(ctx.content, patch);
}

function requireContent(ctx: JobContext): ContentRow {
  if (!ctx.content) throw new AppError("NOT_FOUND", "The content item for this job no longer exists.");
  return ctx.content;
}

function adapterFor(ctx: JobContext, deps: ProcessorDeps): CmsAdapter {
  if (!ctx.encryptedCredentials) {
    throw new AppError("CMS_AUTH_FAILED", "This website has no stored CMS connection. Connect it first.");
  }
  return deps.createAdapter(ctx, deps.decryptCredentials(ctx));
}

async function complete(ctx: JobContext, deps: ProcessorDeps, result: Record<string, unknown>) {
  await setJob(ctx, deps, {
    status: "COMPLETED", completed_at: new Date().toISOString(), lease_expires_at: null,
    error_code: null, error_message: null, retryable: null, result: { ...ctx.job.result, ...result },
  });
  return "COMPLETED" as const;
}

async function validate(ctx: JobContext, deps: ProcessorDeps, offline: boolean) {
  const content = requireContent(ctx);
  const results = await runValidation(toCheckInput(content), {
    rules: ctx.rules, siblings: deps.repo.siblings, website: { baseUrl: ctx.website.base_url }, http: deps.http, offline,
  });
  await deps.repo.saveQaResults({ job: ctx.job, contentId: content.id, phase: "pre_publish", results });
  return { results, summary: summarize(results, ctx.rules) };
}

// ---------------------------------------------------------------------------
// VALIDATE
// ---------------------------------------------------------------------------

async function runValidateJob(ctx: JobContext, deps: ProcessorDeps) {
  const content = requireContent(ctx);
  const hashAtStart = content.content_hash;
  const movesStatus = canTransition(content.status, "VALIDATING") && content.status !== "VALIDATING";
  if (movesStatus) await setContent(ctx, deps, { status: "VALIDATING" });
  const { summary } = await validate(ctx, deps, false);
  const next: ContentStatus = summary.status === "FAILED" ? "VALIDATION_FAILED" : "READY_FOR_REVIEW";
  await setContent(ctx, deps, {
    validation_status: summary.status as ValidationStatus,
    validated_hash: hashAtStart,
    ...(movesStatus || ctx.content?.status === "VALIDATING" ? { status: next } : {}),
  });
  metric("validation.completed", 1, { outcome: summary.status });
  return complete(ctx, deps, { validation: { status: summary.status, errors: summary.errors, warnings: summary.warnings } });
}

// ---------------------------------------------------------------------------
// CREATE_DRAFT — never touches a live post
// ---------------------------------------------------------------------------

async function runCreateDraftJob(ctx: JobContext, deps: ProcessorDeps) {
  const content = requireContent(ctx);
  await setJob(ctx, deps, { status: "PUBLISHING" });
  const adapter = adapterFor(ctx, deps);
  const payload = toPostPayload(content);
  const existing = await findExisting(ctx, adapter, content);
  if (existing && existing.status !== "draft" && existing.status !== "pending") {
    throw new AppError("CONFLICT", `The ${adapter.label} ${existing.status === "publish" ? "item is already live" : `item is "${existing.status}"`}. Use the approval and publish workflow to update it.`);
  }
  const { post, seo } = existing ? await adapter.updateDraft(existing.id, payload) : await adapter.createDraft(payload);
  await setContent(ctx, deps, { external_post_id: post.id, seo_sync: seo.sync });
  await deps.repo.audit(ctx.job, "cms.draft_saved", { post_id: post.id, created: !existing });
  return complete(ctx, deps, { post_id: post.id, post_status: post.status, warnings: seo.warnings });
}

/**
 * Reconciliation: find the CMS post this content already corresponds to,
 * by stored external ID first, then by slug (adopted only if the title matches,
 * so an unrelated post with the same slug is never overwritten).
 */
async function findExisting(ctx: JobContext, adapter: CmsAdapter, content: ContentRow) {
  if (content.external_post_id) {
    const post = await adapter.getPost(content.external_post_id);
    if (post) return post;
  }
  const bySlug = await adapter.findPostBySlug(content.slug);
  if (!bySlug) return null;
  if (normalizeText(bySlug.title).toLowerCase() !== normalizeText(content.title).toLowerCase()) {
    throw new AppError("CONFLICT", `${adapter.label} already has a different item using the slug "${content.slug}". Choose another slug.`);
  }
  if (!content.external_post_id) {
    logger.info("job.reconciled_by_slug", { jobId: ctx.job.id, postId: bySlug.id });
  }
  return bySlug;
}

// ---------------------------------------------------------------------------
// PUBLISH
// ---------------------------------------------------------------------------

async function runPublishJob(ctx: JobContext, deps: ProcessorDeps) {
  const content = requireContent(ctx);
  const verifyOnly = ctx.job.result?.phase === "verify" && !!content.published_url;

  if (!verifyOnly) {
    // 1. VALIDATING: approval must still match the exact content being published.
    if (content.approved_hash !== content.content_hash || !content.approved_at) {
      throw new AppError("APPROVAL_INVALID", "Content changed after approval or approval was revoked. Re-validate and approve again.");
    }
    const { summary } = await validate(ctx, deps, true);
    if (summary.status === "FAILED") {
      await setContent(ctx, deps, { status: "VALIDATION_FAILED", validation_status: "FAILED", validated_hash: content.content_hash });
      throw new AppError("VALIDATION_FAILED", `Pre-publish validation failed: ${summary.blocking.map((b) => b.message).slice(0, 3).join(" ")}`);
    }

    // 2. PUBLISHING
    await setJob(ctx, deps, { status: "PUBLISHING" });
    if (ctx.content!.status !== "PUBLISHING") await setContent(ctx, deps, { status: "PUBLISHING" });
    const adapter = adapterFor(ctx, deps);
    const payload = toPostPayload(ctx.content!);
    const existing = await findExisting(ctx, adapter, ctx.content!);
    let postId: string;
    let seo;
    if (existing) {
      ({ seo } = await adapter.updateDraft(existing.id, payload));
      postId = existing.id;
    } else {
      const created = await adapter.createDraft(payload);
      postId = created.post.id;
      seo = created.seo;
      // Persist the remote ID before going live so a retry can never create a second post.
      await setContent(ctx, deps, { external_post_id: postId });
    }
    // Always publish, even if the item was already live: some platforms (Webflow) stage
    // edits to live items until they are published again.
    const live = await adapter.publishPost(postId);
    if (!live || live.status !== "publish" || !live.link) {
      throw new AppError("CMS_UNEXPECTED_RESPONSE", `${adapter.label} did not report the item as published with a public URL.`, { retryable: true, ambiguous: true });
    }
    await setContent(ctx, deps, { external_post_id: postId, published_url: live.link, seo_sync: seo.sync });
    await deps.repo.audit(ctx.job, "content.published", { post_id: postId, url: live.link, reconciled: !!existing });
    await setJob(ctx, deps, { result: { ...ctx.job.result, phase: "verify", post_id: postId, published_url: live.link, warnings: seo.warnings } });
  }

  // 3. VERIFYING
  return verifyPhase(ctx, deps);
}

async function runVerifyJob(ctx: JobContext, deps: ProcessorDeps) {
  requireContent(ctx);
  return verifyPhase(ctx, deps);
}

async function verifyPhase(ctx: JobContext, deps: ProcessorDeps) {
  const content = requireContent(ctx);
  if (!content.published_url) throw new AppError("VERIFICATION_FAILED", "No published URL is recorded for this content.");
  await setJob(ctx, deps, { status: "VERIFYING" });
  if (content.status !== "VERIFYING") await setContent(ctx, deps, { status: "VERIFYING" });

  if (!ctx.rules.publishing.verifyAfterPublish && ctx.job.job_type === "PUBLISH") {
    await setContent(ctx, deps, { status: "PUBLISHED" });
    return complete(ctx, deps, { verification: "disabled_by_rules" });
  }

  const sync = (content.seo_sync ?? {}) as SeoSyncState;
  const confirmed = (f: keyof SeoSyncState) => (sync[f]?.confirmed ? true : false);
  const outcome = await verifyLivePage(content.published_url, {
    title: content.title,
    bodyHtml: toPostPayload(content).contentHtml,
    metaTitle: confirmed("meta_title") ? content.meta_title : undefined,
    metaDescription: confirmed("meta_description") ? content.meta_description : undefined,
    canonicalUrl: confirmed("canonical_url") ? content.canonical_url : undefined,
  }, deps.http);
  await deps.repo.saveQaResults({ job: ctx.job, contentId: content.id, phase: "post_publish", results: outcome.results });

  const newSync: SeoSyncState = structuredClone(sync);
  for (const [field, ok] of Object.entries(outcome.verifiedFields)) {
    const f = field as keyof SeoSyncState;
    if (newSync[f]) newSync[f]!.verified = ok ?? null;
  }

  if (outcome.passed) {
    await setContent(ctx, deps, { status: "PUBLISHED", seo_sync: newSync });
    metric("verification.passed", 1, {});
    return complete(ctx, deps, { verification: "passed", http_status: outcome.httpStatus });
  }
  if (outcome.transient && ctx.job.attempts < ctx.job.max_attempts) {
    throw new AppError("VERIFICATION_FAILED", outcome.results[0]?.message ?? "Live page not yet available.", { retryable: true });
  }
  await setContent(ctx, deps, { status: "VERIFICATION_FAILED", seo_sync: newSync });
  metric("verification.failed", 1, {});
  await setJob(ctx, deps, {
    status: "FAILED", completed_at: new Date().toISOString(), lease_expires_at: null, retryable: false,
    error_code: "VERIFICATION_FAILED",
    error_message: outcome.results.filter((r) => r.status === "fail").map((r) => r.message).slice(0, 3).join(" "),
  });
  return "FAILED" as const;
}

// ---------------------------------------------------------------------------
// failures
// ---------------------------------------------------------------------------

async function handleFailure(job: JobRow, ctx: JobContext | null, err: unknown, deps: ProcessorDeps): Promise<JobRow["status"]> {
  const appErr = isAppError(err) ? err : new AppError("INTERNAL", "Unexpected internal error while processing the job.", { cause: err });
  if (!isAppError(err)) logger.error("job.unexpected_error", { jobId: job.id, error: err });
  const decision = decideOnFailure(appErr, job.attempts, job.max_attempts, deps.random);
  const target = ctx ?? ({ job } as JobContext);

  if (isAuthFailureCode(appErr.code) && ctx?.encryptedCredentials) {
    await deps.repo.setConnectionStatus(job, "auth_failed", appErr.message).catch(() => undefined);
  }

  try {
    if (decision.kind === "retry") {
      metric("job.retry_scheduled", 1, { job_type: job.job_type, code: appErr.code });
      await setJob(target, deps, {
        status: "RETRY_SCHEDULED",
        run_at: new Date(Date.now() + decision.delayMs).toISOString(),
        needs_reconciliation: job.needs_reconciliation || decision.reconcile,
        lease_expires_at: null, locked_by: null,
        error_code: appErr.code, error_message: appErr.message, retryable: true,
      });
      if (ctx?.content && job.job_type === "PUBLISH" && ctx.content.status === "PUBLISHING") {
        await setContent(ctx, deps, { status: "QUEUED" });
      }
      return "RETRY_SCHEDULED";
    }

    metric("job.failed", 1, { job_type: job.job_type, code: decision.code });
    await setJob(target, deps, {
      status: "FAILED", completed_at: new Date().toISOString(), lease_expires_at: null,
      error_code: decision.code, error_message: appErr.message, retryable: decision.retryable,
    });
    if (ctx?.content) {
      const s = ctx.content.status;
      const next: ContentStatus | null =
        job.job_type === "VALIDATE" ? (s === "VALIDATING" ? "DRAFT" : null)
        : job.job_type === "PUBLISH" ? (s === "VERIFYING" ? "VERIFICATION_FAILED" : s === "PUBLISHING" || s === "QUEUED" ? "PUBLISH_FAILED" : null)
        : job.job_type === "VERIFY" ? (s === "VERIFYING" ? "VERIFICATION_FAILED" : null)
        : null;
      if (next) await setContent(ctx, deps, { status: next });
    }
    await deps.repo.audit(job, "job.failed", { code: decision.code, job_type: job.job_type }).catch(() => undefined);
    return "FAILED";
  } catch (inner) {
    if (inner instanceof LeaseLost) return job.status;
    logger.error("job.failure_handling_error", { jobId: job.id, error: inner });
    return job.status;
  }
}

// ---------------------------------------------------------------------------
// batch runner (used by the worker process and the cron route)
// ---------------------------------------------------------------------------

export async function runWorkerBatch(deps: ProcessorDeps, opts: { maxJobs?: number; timeBudgetMs?: number; organizationId?: string } = {}) {
  const deadline = Date.now() + (opts.timeBudgetMs ?? 50_000);
  const reaped = opts.organizationId ? 0 : await deps.repo.reapExpiredLeases();
  let processed = 0;
  const outcomes: Record<string, number> = {};
  while (processed < (opts.maxJobs ?? 10) && Date.now() < deadline) {
    const job = await deps.repo.claimNext(deps.workerId, deps.leaseSeconds ?? 300, opts.organizationId);
    if (!job) break;
    const status = await processJob(job, deps);
    outcomes[status] = (outcomes[status] ?? 0) + 1;
    processed++;
  }
  return { processed, reaped, outcomes };
}
