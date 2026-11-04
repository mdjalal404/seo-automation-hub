import { describe, expect, it } from "vitest";
import { MockCustomCms } from "../../dev/mock-cms/custom";
import { MockShopify } from "../../dev/mock-cms/shopify";
import { MOCK_WEBFLOW_COLLECTION_ID, MockWebflow } from "../../dev/mock-cms/webflow";
import { CustomCmsAdapter } from "@/lib/cms/adapters/custom";
import { ShopifyAdapter } from "@/lib/cms/adapters/shopify";
import { WebflowAdapter } from "@/lib/cms/adapters/webflow";
import { credentialsFor, parseCredentials, type CmsCredentials } from "@/lib/cms/credentials";
import type { CmsAdapter } from "@/lib/cms/types";
import type { ContentRow, JobRow } from "@/lib/database/types";
import { runWorkerBatch, type ProcessorDeps } from "@/lib/publishing/processor";
import { credentialAad, decryptSecret, encryptSecret } from "@/lib/security/crypto";
import type { HttpClient } from "@/lib/security/safe-fetch";
import { asService, asUser, createTestDb, createUser, type TestDb } from "../db/harness";
import { createPgliteRepo } from "../support/pglite-repo";

const words = (n: number) => Array.from({ length: n }, (_, i) => `term${i}`).join(" ");

type Platform = {
  cmsType: "webflow" | "shopify" | "custom";
  connectionType: string;
  baseUrl: string;
  credentials: CmsCredentials;
  mock: () => { http: HttpClient; mock: MockWebflow | MockShopify | MockCustomCms };
  adapter: (creds: CmsCredentials, http: HttpClient) => CmsAdapter;
  liveUrl: (slug: string) => string;
};

const PLATFORMS: Platform[] = [
  {
    cmsType: "webflow", connectionType: "webflow_api_token", baseUrl: "https://www.webflow-client.example",
    credentials: { kind: "webflow", apiToken: "w".repeat(64), collectionId: MOCK_WEBFLOW_COLLECTION_ID },
    mock: () => { const mock = new MockWebflow({ baseUrl: "https://www.webflow-client.example", apiToken: "w".repeat(64) }); return { mock, http: mock.asHttpClient() }; },
    adapter: (c, http) => new WebflowAdapter({ siteUrl: "https://www.webflow-client.example", credentials: credentialsFor(c, "webflow"), http, apiBase: "https://api.webflow.test/v2", minIntervalMs: 0 }),
    liveUrl: (slug) => `https://www.webflow-client.example/blog/${slug}`,
  },
  {
    cmsType: "shopify", connectionType: "shopify_admin_token", baseUrl: "https://shop.shopify-client.example",
    credentials: { kind: "shopify", shopDomain: "client.myshopify.com", accessToken: "shpat_" + "s".repeat(32), blogHandle: "news", authorName: "Editorial Team" },
    mock: () => { const mock = new MockShopify({ baseUrl: "https://shop.shopify-client.example", accessToken: "shpat_" + "s".repeat(32) }); return { mock, http: mock.asHttpClient() }; },
    adapter: (c, http) => new ShopifyAdapter({ storefrontUrl: "https://shop.shopify-client.example", credentials: credentialsFor(c, "shopify"), http, adminBaseOverride: "https://shop.shopify-client.example", minIntervalMs: 0 }),
    liveUrl: (slug) => `https://shop.shopify-client.example/blogs/news/${slug}`,
  },
  {
    cmsType: "custom", connectionType: "custom_bearer_token", baseUrl: "https://www.custom-client.example",
    credentials: { kind: "custom", apiBaseUrl: "https://www.custom-client.example/api/v1", apiToken: "custom-token-0123456789" },
    mock: () => { const mock = new MockCustomCms({ baseUrl: "https://www.custom-client.example", apiToken: "custom-token-0123456789" }); return { mock, http: mock.asHttpClient() }; },
    adapter: (c, http) => new CustomCmsAdapter({ siteUrl: "https://www.custom-client.example", credentials: credentialsFor(c, "custom"), http, minIntervalMs: 0 }),
    liveUrl: (slug) => `https://www.custom-client.example/posts/${slug}`,
  },
];

async function setup(p: Platform) {
  const db: TestDb = await createTestDb();
  const owner = await createUser(db, "owner@example.test");
  const org = (await asUser(db, owner, (tx) => tx.query<{ id: string }>("select public.create_organization('Agency','agency') as id"))).rows[0].id;
  const website = await asUser(db, owner, async (tx) => {
    const client = (await tx.query<{ id: string }>("insert into clients (organization_id, name) values ($1, 'Client') returning id", [org])).rows[0].id;
    return (await tx.query<{ id: string }>(
      "insert into websites (organization_id, client_id, name, base_url, cms_type) values ($1, $2, 'Site', $3, $4) returning id", [org, client, p.baseUrl, p.cmsType],
    )).rows[0].id;
  });
  const envelope = encryptSecret(JSON.stringify(p.credentials), credentialAad(org, website));
  await asService(db, async (tx) => {
    await tx.query("insert into cms_connections (organization_id, website_id, connection_type, encrypted_credentials, connection_status) values ($1, $2, $3, $4, 'connected')",
      [org, website, p.connectionType, envelope]);
    await tx.query("update websites set connection_status = 'connected' where id = $1", [website]);
  });
  const { mock, http } = p.mock();
  const deps: ProcessorDeps = {
    repo: createPgliteRepo(db), http, workerId: "test-worker", random: () => 0.5,
    decryptCredentials: (ctx) => parseCredentials(decryptSecret(ctx.encryptedCredentials!, credentialAad(ctx.website.organization_id, ctx.website.id)), ctx.website.cms_type),
    createAdapter: (_ctx, credentials) => p.adapter(credentials, http),
  };

  const createArticle = async (slug: string) => (await asUser(db, owner, (tx) => tx.query<{ id: string }>(
    `insert into content_items (organization_id, website_id, title, slug, body, meta_title, meta_description, created_by)
     values ($1, $2, 'How to plan a site migration', $3, $4, 'Site migration planning checklist for agencies',
       'A practical checklist for planning a site migration: URL inventory, redirect mapping, launch checks and monitoring.', $5) returning id`,
    [org, website, slug, `Planning a site migration starts with an inventory of every URL you have today. ${words(320)}\n\n## Redirect mapping\n\nMap each old URL to its best new destination.`, owner],
  ))).rows[0].id;
  const enqueue = (id: string, type: string, key: string) =>
    asUser(db, owner, (tx) => tx.query<{ id: string }>("select public.enqueue_content_job($1, $2, $3) as id", [id, type, key])).then((r) => r.rows[0].id);
  const content = async (id: string) => (await db.query<ContentRow>("select * from content_items where id = $1", [id])).rows[0];
  const jobs = async (id: string) => (await db.query<JobRow>("select * from content_jobs where content_item_id = $1 order by created_at", [id])).rows;
  const approve = async (id: string) => {
    await enqueue(id, "VALIDATE", `validate-${id}`);
    await runWorkerBatch(deps);
    expect((await content(id)).status).toBe("READY_FOR_REVIEW");
    await asUser(db, owner, (tx) => tx.query("select public.approve_content($1)", [id]));
  };
  const makeDue = () => asService(db, (tx) => tx.query("update content_jobs set run_at = now() - interval '1 second' where status = 'RETRY_SCHEDULED'"));
  return { db, owner, org, website, mock, deps, createArticle, enqueue, content, jobs, approve, makeDue };
}

describe.each(PLATFORMS)("publishing pipeline on $cmsType", (p) => {
  it("validates, publishes, verifies the live page and confirms SEO fields", async () => {
    const t = await setup(p);
    const id = await t.createArticle("plan-site-migration");
    await t.approve(id);
    await t.enqueue(id, "PUBLISH", "publish-1");
    await runWorkerBatch(t.deps);
    const c = await t.content(id);
    expect(c).toMatchObject({ status: "PUBLISHED", published_url: p.liveUrl("plan-site-migration") });
    expect(c.external_post_id).toBeTruthy();
    expect(c.seo_sync.meta_description).toMatchObject({ stored: true, sent: true, confirmed: true, verified: true });
    expect((await t.jobs(id)).at(-1)).toMatchObject({ job_type: "PUBLISH", status: "COMPLETED" });
  });

  it("reconciles after an ambiguous create timeout instead of creating a duplicate", async () => {
    const t = await setup(p);
    const id = await t.createArticle("plan-site-migration");
    await t.approve(id);
    const createPath = p.cmsType === "shopify" ? /^ArticleCreate$/ : /\/(items|posts)$/;
    t.mock.addFault({ method: "POST", path: createPath, timeout: { applied: true } });
    await t.enqueue(id, "PUBLISH", "publish-1");
    await runWorkerBatch(t.deps);
    expect((await t.jobs(id)).at(-1)).toMatchObject({ status: "RETRY_SCHEDULED", needs_reconciliation: true });
    await t.makeDue();
    await runWorkerBatch(t.deps);
    expect((await t.content(id)).status).toBe("PUBLISHED");
    const count = t.mock instanceof MockWebflow ? t.mock.items.size : t.mock instanceof MockShopify ? t.mock.articles.size : t.mock.posts.size;
    expect(count).toBe(1);
  });

  it("marks the connection auth_failed when the token is revoked", async () => {
    const t = await setup(p);
    const id = await t.createArticle("plan-site-migration");
    await t.approve(id);
    if (t.mock instanceof MockWebflow) t.mock.opts.apiToken = "revoked";
    else if (t.mock instanceof MockShopify) t.mock.opts.accessToken = "revoked";
    else t.mock.opts.apiToken = "revoked";
    await t.enqueue(id, "PUBLISH", "publish-1");
    await runWorkerBatch(t.deps);
    expect((await t.jobs(id)).at(-1)).toMatchObject({ status: "FAILED", error_code: "CMS_AUTH_FAILED" });
    const site = await t.db.query<{ connection_status: string }>("select connection_status from websites where id = $1", [t.website]);
    expect(site.rows[0].connection_status).toBe("auth_failed");
    expect((await t.content(id)).status).toBe("PUBLISH_FAILED");
    // Credential failures are manually retryable after reconnecting.
    const failed = (await t.jobs(id)).at(-1)!;
    await asUser(t.db, t.owner, (tx) => tx.query("select public.retry_job($1)", [failed.id]));
    expect((await t.content(id)).status).toBe("QUEUED");
  });
});

describe("multi-CMS schema guards", () => {
  it("rejects unknown platforms, mismatched connection types and platform changes while connected", async () => {
    const t = await setup(PLATFORMS[0]);
    await expect(asUser(t.db, t.owner, (tx) => tx.query(
      "insert into websites (organization_id, client_id, name, base_url, cms_type) select organization_id, client_id, 'Other', 'https://other.example', 'drupal' from websites where id = $1",
      [t.website]))).rejects.toThrow(/websites_cms_type_check/);
    await expect(asUser(t.db, t.owner, (tx) => tx.query("update websites set cms_type = 'shopify' where id = $1", [t.website]))).rejects.toThrow(/Disconnect the CMS/);
    await expect(asService(t.db, (tx) => tx.query("update cms_connections set connection_type = 'shopify_admin_token' where website_id = $1", [t.website]))).rejects.toThrow(/does not match/);
  });
});
