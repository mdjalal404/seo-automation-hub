import { beforeEach, describe, expect, it } from "vitest";
import { MockWordPress } from "../../dev/mock-wordpress/core";
import { credentialsFor } from "@/lib/cms/credentials";
import type { ContentRow, JobRow } from "@/lib/database/types";
import { runWorkerBatch, type ProcessorDeps } from "@/lib/publishing/processor";
import { credentialAad, decryptSecret, encryptSecret } from "@/lib/security/crypto";
import { WordPressAdapter } from "@/lib/wordpress/adapter";
import { asService, asUser, createTestDb, createUser, type TestDb } from "../db/harness";
import { createPgliteRepo } from "../support/pglite-repo";

const BASE = "https://client-site.example.com";
const APP_PASSWORD = "abcdEFGHijklMNOPqrstUVWX";
const words = (n: number) => Array.from({ length: n }, (_, i) => `term${i}`).join(" ");

let db: TestDb;
let owner: string;
let org: string;
let website: string;
let wp: MockWordPress;
let deps: ProcessorDeps;

async function setup(opts: { seoPlugin?: "yoast" | null; exposeSeoMeta?: boolean; password?: string } = {}) {
  db = await createTestDb();
  owner = await createUser(db, "owner@example.test");
  org = (await asUser(db, owner, (tx) => tx.query<{ id: string }>("select public.create_organization('Agency','agency') as id"))).rows[0].id;
  website = await asUser(db, owner, async (tx) => {
    const client = (await tx.query<{ id: string }>("insert into clients (organization_id, name) values ($1, 'Client') returning id", [org])).rows[0].id;
    return (await tx.query<{ id: string }>(
      "insert into websites (organization_id, client_id, name, base_url) values ($1, $2, 'Site', $3) returning id", [org, client, BASE],
    )).rows[0].id;
  });
  const envelope = encryptSecret(JSON.stringify({ username: "editor", applicationPassword: opts.password ?? APP_PASSWORD }), credentialAad(org, website));
  await asService(db, async (tx) => {
    await tx.query("insert into cms_connections (organization_id, website_id, encrypted_credentials, connection_status) values ($1, $2, $3, 'connected')", [org, website, envelope]);
    await tx.query("update websites set connection_status = 'connected' where id = $1", [website]);
  });
  wp = new MockWordPress({ baseUrl: BASE, username: "editor", applicationPassword: APP_PASSWORD, seoPlugin: opts.seoPlugin ?? null, exposeSeoMeta: opts.exposeSeoMeta });
  const http = wp.asHttpClient();
  deps = {
    repo: createPgliteRepo(db),
    http,
    workerId: "test-worker",
    random: () => 0.5,
    decryptCredentials: (ctx) => JSON.parse(decryptSecret(ctx.encryptedCredentials!, credentialAad(ctx.website.organization_id, ctx.website.id))),
    createAdapter: (_ctx, credentials) => new WordPressAdapter({ baseUrl: BASE, credentials: credentialsFor(credentials, "wordpress"), http, minIntervalMs: 0 }),
  };
}

async function createArticle(over: Record<string, string> = {}) {
  const v = {
    title: "How to plan a site migration", slug: "plan-site-migration",
    body: `Planning a site migration starts with an inventory of every URL you have today. ${words(320)}\n\n## Redirect mapping\n\nMap each old URL to its best new destination before launch day.`,
    meta_title: "Site migration planning checklist for agencies",
    meta_description: "A practical checklist for planning a site migration: URL inventory, redirect mapping, launch checks and monitoring.",
    ...over,
  };
  return (await asUser(db, owner, (tx) => tx.query<{ id: string }>(
    `insert into content_items (organization_id, website_id, title, slug, body, meta_title, meta_description, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [org, website, v.title, v.slug, v.body, v.meta_title, v.meta_description, owner],
  ))).rows[0].id;
}

const content = async (id: string) => (await db.query<ContentRow>("select * from content_items where id = $1", [id])).rows[0];
const jobs = async (id: string) => (await db.query<JobRow>("select * from content_jobs where content_item_id = $1 order by created_at", [id])).rows;
const makeDue = () => asService(db, (tx) => tx.query("update content_jobs set run_at = now() - interval '1 second' where status = 'RETRY_SCHEDULED'"));
const enqueue = (id: string, type: string, key: string) =>
  asUser(db, owner, (tx) => tx.query<{ id: string }>("select public.enqueue_content_job($1, $2, $3) as id", [id, type, key])).then((r) => r.rows[0].id);

async function validateAndApprove(id: string) {
  await enqueue(id, "VALIDATE", `validate-${id}`);
  await runWorkerBatch(deps);
  expect((await content(id)).status).toBe("READY_FOR_REVIEW");
  await asUser(db, owner, (tx) => tx.query("select public.approve_content($1)", [id]));
}

describe("publishing workflow", () => {
  beforeEach(() => setup({ seoPlugin: "yoast", exposeSeoMeta: true }));

  it("validates, publishes, verifies and records SEO sync state", async () => {
    const id = await createArticle();
    await validateAndApprove(id);
    const jobId = await enqueue(id, "PUBLISH", "publish-click-1");
    const batch = await runWorkerBatch(deps);
    expect(batch.outcomes).toEqual({ COMPLETED: 1 });

    const c = await content(id);
    expect(c.status).toBe("PUBLISHED");
    expect(c.published_url).toBe(`${BASE}/plan-site-migration/`);
    expect(c.external_post_id).toBeTruthy();
    expect(c.seo_sync.meta_description).toMatchObject({ stored: true, sent: true, confirmed: true, verified: true });
    expect(c.seo_sync.meta_title).toMatchObject({ sent: true, confirmed: true, verified: true });

    const job = (await db.query<JobRow>("select * from content_jobs where id = $1", [jobId])).rows[0];
    expect(job).toMatchObject({ status: "COMPLETED", attempts: 1 });
    expect([...wp.posts.values()]).toHaveLength(1);
    expect([...wp.posts.values()][0].status).toBe("publish");

    const post = await db.query("select check_name, status from qa_results where content_item_id = $1 and phase = 'post_publish'", [id]);
    expect(post.rows).toEqual(expect.arrayContaining([
      { check_name: "live_page_accessible", status: "pass" },
      { check_name: "published_title", status: "pass" },
      { check_name: "published_content", status: "pass" },
    ]));
  });

  it("does not create a duplicate post after an ambiguous timeout", async () => {
    const id = await createArticle();
    await validateAndApprove(id);
    await enqueue(id, "PUBLISH", "publish-click-2");
    // The create request reaches WordPress but the response is lost.
    wp.addFault({ method: "POST", path: /^\/wp\/v2\/posts$/, timeout: { applied: true } });
    const first = await runWorkerBatch(deps);
    expect(first.outcomes).toEqual({ RETRY_SCHEDULED: 1 });
    const [j1] = await jobs(id).then((js) => js.filter((j) => j.job_type === "PUBLISH"));
    expect(j1).toMatchObject({ status: "RETRY_SCHEDULED", needs_reconciliation: true, error_code: "TIMEOUT" });
    expect((await content(id)).status).toBe("QUEUED");

    await makeDue();
    const second = await runWorkerBatch(deps);
    expect(second.outcomes).toEqual({ COMPLETED: 1 });
    expect([...wp.posts.values()]).toHaveLength(1); // reconciled by slug, not re-created
    expect((await content(id)).status).toBe("PUBLISHED");
  });

  it("retries transient server errors and rate limits with backoff", async () => {
    const id = await createArticle();
    await validateAndApprove(id);
    await enqueue(id, "PUBLISH", "publish-click-3");
    wp.addFault({ method: "GET", path: /^\/wp\/v2\/posts$/, status: 503 });
    expect((await runWorkerBatch(deps)).outcomes).toEqual({ RETRY_SCHEDULED: 1 });
    await makeDue();
    wp.addFault({ method: "GET", path: /^\/wp\/v2\/posts$/, status: 429 });
    expect((await runWorkerBatch(deps)).outcomes).toEqual({ RETRY_SCHEDULED: 1 });
    const job = (await jobs(id)).find((j) => j.job_type === "PUBLISH")!;
    expect(job.error_code).toBe("WP_RATE_LIMITED");
    expect(new Date(job.run_at).getTime() - Date.now()).toBeGreaterThan(50_000); // Retry-After default 60s honoured
    await makeDue();
    expect((await runWorkerBatch(deps)).outcomes).toEqual({ COMPLETED: 1 });
    expect((await jobs(id)).find((j) => j.job_type === "PUBLISH")!.attempts).toBe(3);
  });

  it("flags a published page that fails verification as needing investigation", async () => {
    wp.opts.renderOverride = (p) => `<html><head><title>${p.title}</title></head><body><h1>${p.title}</h1><p>Placeholder theme content only.</p></body></html>`;
    const id = await createArticle();
    await validateAndApprove(id);
    const jobId = await enqueue(id, "PUBLISH", "publish-click-4");
    expect((await runWorkerBatch(deps)).outcomes).toEqual({ FAILED: 1 });
    expect((await content(id)).status).toBe("VERIFICATION_FAILED");
    const job = (await db.query<JobRow>("select * from content_jobs where id = $1", [jobId])).rows[0];
    expect(job.error_code).toBe("VERIFICATION_FAILED");

    // After fixing the theme, a manual retry re-verifies without re-publishing.
    wp.opts.renderOverride = undefined;
    const before = wp.requests.filter((r) => r.method === "POST").length;
    await asUser(db, owner, (tx) => tx.query("select public.retry_job($1)", [jobId]));
    expect((await runWorkerBatch(deps)).outcomes).toEqual({ COMPLETED: 1 });
    expect(wp.requests.filter((r) => r.method === "POST").length).toBe(before);
    expect((await content(id)).status).toBe("PUBLISHED");
  });

  it("blocks publication when pre-publish validation fails", async () => {
    const id = await createArticle();
    await validateAndApprove(id);
    await createArticle({ title: "Another post", slug: "plan-site-migration" }); // duplicate slug appears after approval
    await enqueue(id, "PUBLISH", "publish-click-5");
    expect((await runWorkerBatch(deps)).outcomes).toEqual({ FAILED: 1 });
    expect((await content(id)).status).toBe("VALIDATION_FAILED");
    expect(wp.posts.size).toBe(0);
    const job = (await jobs(id)).find((j) => j.job_type === "PUBLISH")!;
    expect(job).toMatchObject({ error_code: "VALIDATION_FAILED", retryable: false });
    await expect(asUser(db, owner, (tx) => tx.query("select public.retry_job($1)", [job.id]))).rejects.toThrow(/not retryable/);
  });

  it("refuses to overwrite an unrelated WordPress post with the same slug", async () => {
    wp.posts.set(5, { id: 5, status: "publish", slug: "plan-site-migration", title: "Someone else's post", content: "", excerpt: "", categories: [], tags: [], featured_media: 0, date_gmt: "", meta: {} });
    const id = await createArticle();
    await validateAndApprove(id);
    await enqueue(id, "PUBLISH", "publish-click-6");
    expect((await runWorkerBatch(deps)).outcomes).toEqual({ FAILED: 1 });
    expect(wp.posts.get(5)!.title).toBe("Someone else's post");
    expect((await content(id)).status).toBe("PUBLISH_FAILED");
  });

  it("creates a WordPress draft without publishing", async () => {
    const id = await createArticle();
    await enqueue(id, "CREATE_DRAFT", "draft-click-1");
    expect((await runWorkerBatch(deps)).outcomes).toEqual({ COMPLETED: 1 });
    const c = await content(id);
    expect(c.status).toBe("DRAFT");
    expect(wp.posts.get(Number(c.external_post_id))!.status).toBe("draft");
  });
});

describe("failure scenarios", () => {
  it("marks the connection as auth_failed on invalid credentials and does not retry", async () => {
    await setup({ password: "wrongPASSWORDwrongPASSWO" });
    const id = await createArticle();
    await validateAndApprove(id);
    const jobId = await enqueue(id, "PUBLISH", "publish-click-7");
    expect((await runWorkerBatch(deps)).outcomes).toEqual({ FAILED: 1 });
    const job = (await db.query<JobRow>("select * from content_jobs where id = $1", [jobId])).rows[0];
    expect(job).toMatchObject({ error_code: "WP_AUTH_FAILED", retryable: false, attempts: 1 });
    expect(job.error_message).not.toContain("wrongPASSWORD");
    expect((await content(id)).status).toBe("PUBLISH_FAILED");
    const site = (await db.query<{ connection_status: string }>("select connection_status from websites where id = $1", [website])).rows[0];
    expect(site.connection_status).toBe("auth_failed");
    // New publish jobs are refused until the site is reconnected.
    await expect(enqueue(id, "CREATE_DRAFT", "draft-click-2")).rejects.toThrow(/not healthy/);
  });

  it("warns when the SEO plugin does not expose meta fields over REST", async () => {
    await setup({ seoPlugin: "yoast", exposeSeoMeta: false });
    const id = await createArticle();
    await validateAndApprove(id);
    await enqueue(id, "PUBLISH", "publish-click-8");
    expect((await runWorkerBatch(deps)).outcomes).toEqual({ COMPLETED: 1 });
    const c = await content(id);
    expect(c.seo_sync.meta_description).toMatchObject({ stored: true, sent: false, confirmed: false, verified: null });
    const job = (await jobs(id)).find((j) => j.job_type === "PUBLISH")!;
    expect(JSON.stringify(job.result.warnings)).toMatch(/not saved to WordPress/);
  });

  it("gives up after max attempts on persistent timeouts", async () => {
    await setup();
    const id = await createArticle();
    await validateAndApprove(id);
    await enqueue(id, "PUBLISH", "publish-click-9");
    wp.addFault({ method: "GET", path: /^\/wp\/v2\/posts$/, timeout: { applied: false }, times: 10 });
    for (let i = 0; i < 5; i++) {
      await runWorkerBatch(deps);
      await makeDue();
    }
    const job = (await jobs(id)).find((j) => j.job_type === "PUBLISH")!;
    expect(job).toMatchObject({ status: "FAILED", error_code: "MAX_ATTEMPTS_EXCEEDED", attempts: 5 });
    expect((await content(id)).status).toBe("PUBLISH_FAILED");
    expect(wp.posts.size).toBe(0);
  });
});
