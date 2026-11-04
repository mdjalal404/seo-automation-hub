import { describe, expect, it } from "vitest";
import { MockWordPress } from "../../dev/mock-wordpress/core";
import { AppError } from "@/lib/errors";
import type { HttpClient } from "@/lib/security/safe-fetch";
import { mapWordPressError, WordPressAdapter } from "@/lib/wordpress/adapter";

const BASE = "https://wp.example.com";
const creds = { username: "editor", applicationPassword: "abcdEFGHijklMNOPqrstUVWX" };
const payload = {
  title: "Hello", slug: "hello", contentHtml: "<p>Hi there</p>", excerpt: "", categories: [3], tags: [], featuredMediaId: null,
  seo: { metaTitle: "Hello SEO", metaDescription: "Desc", canonicalUrl: "" },
};

function setup(opts: Partial<ConstructorParameters<typeof MockWordPress>[0]> = {}) {
  const wp = new MockWordPress({ baseUrl: BASE, ...creds, ...opts });
  const calls: { url: string; auth?: string }[] = [];
  const inner = wp.asHttpClient();
  const http: HttpClient = async (url, req) => {
    calls.push({ url, auth: req?.headers?.authorization });
    return inner(url, req);
  };
  return { wp, calls, adapter: new WordPressAdapter({ baseUrl: BASE, credentials: creds, http, minIntervalMs: 0 }) };
}

describe("WordPressAdapter", () => {
  it("tests the connection and detects SEO plugins", async () => {
    const { adapter, calls } = setup({ seoPlugin: "rankmath" });
    const info = await adapter.testConnection();
    expect(info).toMatchObject({ canPublish: true, seoPlugins: ["rankmath"], user: { slug: "editor" } });
    expect(calls[0].url).toBe(`${BASE}/wp-json/`);
    expect(calls[1].auth).toMatch(/^Basic /);
  });

  it("maps rejected credentials to a non-retryable auth error", async () => {
    const wp = new MockWordPress({ baseUrl: BASE, ...creds });
    const adapter = new WordPressAdapter({ baseUrl: BASE, credentials: { ...creds, applicationPassword: "x".repeat(24) }, http: wp.asHttpClient(), minIntervalMs: 0 });
    const err = await adapter.testConnection().catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: "WP_AUTH_FAILED", retryable: false });
    expect(err.message).not.toContain("x".repeat(24));
  });

  it("creates drafts and writes SEO meta only when exposed", async () => {
    const exposed = setup({ seoPlugin: "yoast", exposeSeoMeta: true });
    const a = await exposed.adapter.createDraft(payload);
    expect(a.post.status).toBe("draft");
    expect(a.seo.sync.meta_title).toMatchObject({ sent: true, confirmed: true });

    const hidden = setup({ seoPlugin: "yoast", exposeSeoMeta: false });
    const b = await hidden.adapter.createDraft(payload);
    expect(b.seo.sync.meta_title).toMatchObject({ stored: true, sent: false, confirmed: false });
    expect(b.seo.warnings[0]).toMatch(/show_in_rest/);
    expect(hidden.calls.filter((c) => c.url.endsWith(`/posts/${b.post.id}`))).toHaveLength(0); // no meta write attempted
  });

  it("publishes, schedules and fetches posts", async () => {
    const { adapter } = setup();
    const { post } = await adapter.createDraft(payload);
    const scheduled = await adapter.schedulePost(post.id, new Date(Date.now() + 3600_000));
    expect(scheduled.status).toBe("future");
    expect((await adapter.publishPost(post.id)).status).toBe("publish");
    expect((await adapter.findPostBySlug("hello"))?.id).toBe(post.id);
    expect(await adapter.getPost("99999")).toBeNull();
    await expect(adapter.schedulePost(post.id, new Date(Date.now() - 1000))).rejects.toThrow(/future/);
  });

  it("validates input before sending", async () => {
    const { adapter, calls } = setup();
    await expect(adapter.createDraft({ ...payload, slug: "Bad Slug" })).rejects.toThrow(/slug/);
    await expect(adapter.createDraft({ ...payload, contentHtml: " " })).rejects.toThrow(/empty/);
    await expect(adapter.getPost("../users")).rejects.toThrow(/Invalid/);
    expect(calls).toHaveLength(0);
  });

  it("supports sites without pretty permalinks (?rest_route=)", async () => {
    const seen: string[] = [];
    const wp = new MockWordPress({ baseUrl: BASE, ...creds });
    const adapter = new WordPressAdapter({
      baseUrl: BASE, credentials: creds, minIntervalMs: 0, restRoot: `${BASE}/?rest_route=/`,
      http: async (url, req) => (seen.push(url), wp.asHttpClient()(url, req)),
    });
    await adapter.getPosts({ perPage: 2 });
    expect(seen[0]).toMatch(/\?rest_route=%2Fwp%2Fv2%2Fposts&per_page=2/);
  });

  it("treats non-JSON success bodies on writes as ambiguous", async () => {
    const adapter = new WordPressAdapter({
      baseUrl: BASE, credentials: creds, minIntervalMs: 0,
      http: async (url) => ({ status: 200, url, headers: {}, text: "<html>Security check</html>" }),
    });
    const err = await adapter.createDraft(payload).catch((e) => e);
    expect(err).toMatchObject({ code: "WP_UNEXPECTED_RESPONSE", retryable: true, ambiguous: true });
  });

  it("maps HTTP errors by retryability", () => {
    expect(mapWordPressError(403, '{"code":"rest_cannot_create"}', {}, true)).toMatchObject({ code: "WP_FORBIDDEN", retryable: false });
    expect(mapWordPressError(400, '{"message":"Invalid <b>param</b>"}', {}, true).message).toContain("Invalid param");
    expect(mapWordPressError(502, "", {}, true)).toMatchObject({ code: "WP_SERVER_ERROR", retryable: true, ambiguous: true });
    expect(mapWordPressError(429, "", { "retry-after": "30" }, false)).toMatchObject({ retryable: true, retryAfterMs: 30_000 });
  });
});
