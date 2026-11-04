import { describe, expect, it } from "vitest";
import { MockCustomCms } from "../../dev/mock-cms/custom";
import { MockShopify } from "../../dev/mock-cms/shopify";
import { MOCK_WEBFLOW_COLLECTION_ID, MockWebflow } from "../../dev/mock-cms/webflow";
import { CustomCmsAdapter } from "@/lib/cms/adapters/custom";
import { ShopifyAdapter } from "@/lib/cms/adapters/shopify";
import { WebflowAdapter } from "@/lib/cms/adapters/webflow";
import { parseCredentials } from "@/lib/cms/credentials";
import { mapCmsHttpError } from "@/lib/cms/http";
import type { PostPayload } from "@/lib/cms/types";
import { connectionSchema } from "@/lib/validation/schemas";

const payload = (over: Partial<PostPayload> = {}): PostPayload => ({
  title: "Local SEO for multi-location brands", slug: "local-seo-multi-location", contentHtml: "<p>Body text for the article.</p>",
  excerpt: "Short summary.", categories: [], tags: [], featuredMediaId: null,
  seo: { metaTitle: "Local SEO for multi-location brands", metaDescription: "How multi-location brands rank locally.", canonicalUrl: "" },
  ...over,
});

const WF_TOKEN = "a".repeat(64);
function webflow(opts: { seoFields?: boolean; token?: string; fieldMap?: Record<string, string> } = {}) {
  const mock = new MockWebflow({ baseUrl: "https://www.example.com", apiToken: WF_TOKEN, seoFields: opts.seoFields });
  const adapter = new WebflowAdapter({
    siteUrl: "https://www.example.com", http: mock.asHttpClient(), apiBase: "https://api.webflow.test/v2", minIntervalMs: 0,
    credentials: { kind: "webflow", apiToken: opts.token ?? WF_TOKEN, collectionId: MOCK_WEBFLOW_COLLECTION_ID, fieldMap: opts.fieldMap },
  });
  return { mock, adapter };
}

const SHOP_TOKEN = "shpat_" + "b".repeat(32);
function shopify(opts: { scopes?: string[]; token?: string; blogHandle?: string } = {}) {
  const mock = new MockShopify({ baseUrl: "https://shop.example.com", accessToken: SHOP_TOKEN, scopes: opts.scopes });
  const adapter = new ShopifyAdapter({
    storefrontUrl: "https://shop.example.com", http: mock.asHttpClient(), adminBaseOverride: "https://shop.example.com", minIntervalMs: 0,
    credentials: { kind: "shopify", shopDomain: "example.myshopify.com", accessToken: opts.token ?? SHOP_TOKEN, blogHandle: opts.blogHandle ?? "news", authorName: "Editorial Team" },
  });
  return { mock, adapter };
}

const CUSTOM_TOKEN = "custom-token-0123456789abcdef";
function custom(opts: { seoFields?: string[]; canPublish?: boolean; token?: string } = {}) {
  const mock = new MockCustomCms({ baseUrl: "https://cms.example.com", apiToken: CUSTOM_TOKEN, ...opts });
  const adapter = new CustomCmsAdapter({
    siteUrl: "https://cms.example.com", http: mock.asHttpClient(), minIntervalMs: 0,
    credentials: { kind: "custom", apiBaseUrl: mock.apiBase, apiToken: opts.token ?? CUSTOM_TOKEN },
  });
  return { mock, adapter };
}

describe("WebflowAdapter", () => {
  it("tests the connection and detects the field mapping", async () => {
    const info = await webflow().adapter.testConnection();
    expect(info.details).toMatchObject({ "Body field": "post-body", "Meta title field": "seo-title", "Meta description field": "seo-description" });
    expect(info.settings).toEqual({ webflow_collection_slug: "blog" });
  });

  it("rejects a bad token with CMS_AUTH_FAILED", async () => {
    await expect(webflow({ token: "z".repeat(64) }).adapter.testConnection()).rejects.toMatchObject({ code: "CMS_AUTH_FAILED", retryable: false });
  });

  it("creates a draft, publishes it, and confirms SEO fields", async () => {
    const { adapter, mock } = webflow();
    const { post, seo } = await adapter.createDraft(payload());
    expect(post.status).toBe("draft");
    expect(seo.sync.meta_title).toMatchObject({ sent: true, confirmed: true });
    expect(seo.sync.canonical_url).toBeUndefined(); // empty canonical is not tracked
    const live = await adapter.publishPost(post.id);
    expect(live).toMatchObject({ status: "publish", link: "https://www.example.com/blog/local-seo-multi-location" });
    const res = await mock.handle("GET", live.link);
    expect(res.text).toContain("<title>Local SEO for multi-location brands</title>");
    expect(await adapter.findPostBySlug("local-seo-multi-location")).toMatchObject({ id: post.id, status: "publish" });
  });

  it("stages edits to a live item until published again", async () => {
    const { adapter, mock } = webflow();
    const { post } = await adapter.createDraft(payload());
    await adapter.publishPost(post.id);
    await adapter.updateDraft(post.id, payload({ title: "Updated title" }));
    expect((await mock.handle("GET", "https://www.example.com/blog/local-seo-multi-location")).text).not.toContain("Updated title");
    await adapter.publishPost(post.id);
    expect((await mock.handle("GET", "https://www.example.com/blog/local-seo-multi-location")).text).toContain("Updated title");
  });

  it("reports SEO fields as not sent when the collection has no matching fields", async () => {
    const { seo } = await webflow({ seoFields: false }).adapter.createDraft(payload());
    expect(seo.sync.meta_description).toMatchObject({ sent: false, confirmed: false });
    expect(seo.warnings.join(" ")).toMatch(/not saved to Webflow/);
  });

  it("validates explicit field overrides against the collection schema", async () => {
    await expect(webflow({ fieldMap: { body: "missing-field" } }).adapter.testConnection()).rejects.toThrow(/no field with slug "missing-field"/);
    await expect(webflow({ fieldMap: { body: "post-summary" } }).adapter.testConnection()).rejects.toThrow(/expected RichText/);
  });

  it("maps a slug conflict to a non-retryable error and rejects malformed IDs", async () => {
    const { adapter } = webflow();
    await adapter.createDraft(payload());
    await expect(adapter.createDraft(payload())).rejects.toMatchObject({ code: "CMS_BAD_REQUEST", retryable: false });
    await expect(adapter.getPost("../../sites")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("ShopifyAdapter", () => {
  it("tests the connection, checks scopes and resolves the blog", async () => {
    const info = await shopify().adapter.testConnection();
    expect(info).toMatchObject({ canPublish: true, settings: { shopify_blog_handle: "news" } });
    expect((await shopify({ scopes: ["read_content"] }).adapter.testConnection()).canPublish).toBe(false);
    await expect(shopify({ blogHandle: "missing" }).adapter.testConnection()).rejects.toThrow(/no blog with handle "missing"/);
  });

  it("rejects a bad token with CMS_AUTH_FAILED", async () => {
    await expect(shopify({ token: "shpat_wrong" }).adapter.testConnection()).rejects.toMatchObject({ code: "CMS_AUTH_FAILED" });
  });

  it("creates an unpublished article with SEO metafields, then publishes it", async () => {
    const { adapter, mock } = shopify();
    const { post, seo } = await adapter.createDraft(payload({ seo: { ...payload().seo, canonicalUrl: "https://shop.example.com/x" } }));
    expect(post).toMatchObject({ status: "draft", slug: "local-seo-multi-location" });
    expect(seo.sync.meta_title).toMatchObject({ sent: true, confirmed: true });
    expect(seo.sync.meta_description).toMatchObject({ sent: true, confirmed: true });
    expect(seo.sync.canonical_url).toMatchObject({ sent: false });
    const live = await adapter.publishPost(post.id);
    expect(live).toMatchObject({ status: "publish", link: "https://shop.example.com/blogs/news/local-seo-multi-location" });
    expect((await mock.handle("GET", live.link)).text).toContain('content="How multi-location brands rank locally."');
    expect(await adapter.findPostBySlug("local-seo")).toBeNull(); // fuzzy search results are filtered to exact handles
    expect(await adapter.findPostBySlug("local-seo-multi-location")).toMatchObject({ id: post.id });
  });

  it("maps GraphQL throttling to a retryable rate limit and user errors to permanent failures", async () => {
    const { adapter, mock } = shopify();
    mock.addFault({ path: /^ArticleCreate$/, status: 200, body: JSON.stringify({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }) });
    await expect(adapter.createDraft(payload())).rejects.toMatchObject({ code: "CMS_RATE_LIMITED", retryable: true });
    await adapter.createDraft(payload());
    await expect(adapter.createDraft(payload())).rejects.toMatchObject({ code: "CONFLICT", retryable: false });
  });

  it("refuses non-myshopify domains", () => {
    expect(() => new ShopifyAdapter({
      storefrontUrl: "https://shop.example.com", http: async () => ({ status: 200, headers: {}, text: "{}", url: "" }),
      credentials: { kind: "shopify", shopDomain: "evil.example.com", accessToken: SHOP_TOKEN, blogHandle: "news", authorName: "x" },
    })).toThrow(/myshopify\.com/);
  });
});

describe("CustomCmsAdapter", () => {
  it("implements the documented contract end to end", async () => {
    const { adapter } = custom();
    const info = await adapter.testConnection();
    expect(info).toMatchObject({ canPublish: true, seoPlugins: ["meta_title", "meta_description", "canonical_url"] });
    const { post, seo } = await adapter.createDraft(payload());
    expect(seo.sync.meta_title).toMatchObject({ sent: true, confirmed: true });
    const live = await adapter.publishPost(post.id);
    expect(live).toMatchObject({ status: "publish", link: "https://cms.example.com/posts/local-seo-multi-location" });
  });

  it("only sends SEO fields the CMS declares", async () => {
    const { adapter } = custom({ seoFields: ["meta_title"] });
    const { seo } = await adapter.createDraft(payload());
    expect(seo.sync.meta_title?.sent).toBe(true);
    expect(seo.sync.meta_description).toMatchObject({ sent: false });
  });

  it("maps auth, permission and server errors", async () => {
    await expect(custom({ token: "nope-nope-nope-nope" }).adapter.testConnection()).rejects.toMatchObject({ code: "CMS_AUTH_FAILED" });
    const { adapter } = custom({ canPublish: false });
    const { post } = await adapter.createDraft(payload());
    await expect(adapter.publishPost(post.id)).rejects.toMatchObject({ code: "CMS_FORBIDDEN" });
    expect(mapCmsHttpError("X", 503, "", {}, true)).toMatchObject({ code: "CMS_SERVER_ERROR", retryable: true, ambiguous: true });
    expect(mapCmsHttpError("X", 429, "", { "retry-after": "20" }, false)).toMatchObject({ code: "CMS_RATE_LIMITED", retryAfterMs: 20_000 });
  });

  it("rejects API base URLs with embedded credentials or query strings", () => {
    const http = async () => ({ status: 200, headers: {}, text: "{}", url: "" });
    expect(() => new CustomCmsAdapter({ siteUrl: "https://x.example", http, credentials: { kind: "custom", apiBaseUrl: "https://u:p@x.example/api", apiToken: CUSTOM_TOKEN } })).toThrow();
    expect(() => new CustomCmsAdapter({ siteUrl: "https://x.example", http, credentials: { kind: "custom", apiBaseUrl: "https://x.example/api?x=1", apiToken: CUSTOM_TOKEN } })).toThrow();
  });
});

describe("credentials and connection input", () => {
  it("treats legacy envelopes without a kind as WordPress and refuses platform mismatches", () => {
    expect(parseCredentials(JSON.stringify({ username: "u", applicationPassword: "p" }), "wordpress")).toMatchObject({ kind: "wordpress" });
    expect(() => parseCredentials(JSON.stringify({ username: "u", applicationPassword: "p" }), "shopify")).toThrow(/different platform/);
  });

  it("validates per-platform connection input", () => {
    const websiteId = "8f8f1c2e-5b7a-4c1d-9f3e-2a6b7c8d9e0f";
    expect(connectionSchema.safeParse({ cmsType: "shopify", websiteId, shopDomain: "https://My-Store.myshopify.com/admin", accessToken: SHOP_TOKEN }).data)
      .toMatchObject({ shopDomain: "my-store.myshopify.com", blogHandle: "news" });
    expect(connectionSchema.safeParse({ cmsType: "shopify", websiteId, shopDomain: "shop.example.com", accessToken: SHOP_TOKEN }).success).toBe(false);
    expect(connectionSchema.safeParse({ cmsType: "webflow", websiteId, apiToken: WF_TOKEN, collectionId: "not-an-id" }).success).toBe(false);
    expect(connectionSchema.safeParse({ cmsType: "custom", websiteId, apiBaseUrl: "ftp://x", apiToken: CUSTOM_TOKEN }).success).toBe(false);
  });
});
