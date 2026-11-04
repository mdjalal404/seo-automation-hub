/**
 * DEVELOPMENT/TEST ONLY — reference implementation of the Custom CMS API v1 contract
 * (docs/CUSTOM_CMS.md), in memory, plus rendered pages. Publishing to it is simulated.
 */
import { json, MockCms, notFoundPage, page, type MockResponse } from "./common";

type Post = { id: string; status: "draft" | "published"; slug: string; title: string; content_html: string; excerpt: string; seo: Record<string, string> };

export type MockCustomCmsOptions = {
  /** Site origin, e.g. http://localhost:8790. The API lives at <baseUrl>/api/v1. */
  baseUrl: string;
  apiToken: string;
  seoFields?: string[];
  canPublish?: boolean;
};

export class MockCustomCms extends MockCms {
  posts = new Map<string, Post>();
  private next = 1;

  constructor(public opts: MockCustomCmsOptions) {
    super();
  }

  get origin() {
    return new URL(this.opts.baseUrl).origin;
  }

  get apiBase() {
    return `${this.opts.baseUrl}/api/v1`;
  }

  private seoFields() {
    return this.opts.seoFields ?? ["meta_title", "meta_description", "canonical_url"];
  }

  private toJson(p: Post) {
    return { id: p.id, status: p.status, slug: p.slug, title: p.title, url: p.status === "published" ? `${this.opts.baseUrl}/posts/${p.slug}` : null, seo: p.seo };
  }

  private applySeo(p: Post, seo: unknown) {
    if (!seo || typeof seo !== "object") return;
    for (const [k, v] of Object.entries(seo)) if (this.seoFields().includes(k)) p.seo[k] = String(v);
  }

  protected route(method: string, url: URL, headers: Record<string, string>, body?: string): MockResponse {
    if (!url.pathname.startsWith("/api/v1/")) return this.render(url.pathname);
    if (headers.authorization !== `Bearer ${this.opts.apiToken}`) return json(401, { error: "invalid_token", message: "Invalid or missing bearer token." });
    const path = url.pathname.slice("/api/v1".length);

    if (path === "/site" && method === "GET") {
      return json(200, {
        name: "Mock Custom CMS (development)", url: this.opts.baseUrl, user: { id: "svc-seo-hub", name: "SEO Hub service account" },
        capabilities: { publish: this.opts.canPublish ?? true, seo_fields: this.seoFields() },
      });
    }
    if (path === "/posts" && method === "GET") {
      const slug = url.searchParams.get("slug");
      const list = [...this.posts.values()].filter((p) => !slug || p.slug === slug);
      return json(200, { items: list.slice(0, Number(url.searchParams.get("limit") ?? 20)).map((p) => this.toJson(p)) });
    }
    if (path === "/posts" && method === "POST") {
      const d = JSON.parse(body ?? "{}") as Record<string, unknown>;
      if (!d.title || !d.slug) return json(422, { error: "validation_failed", message: "title and slug are required" });
      if ([...this.posts.values()].some((p) => p.slug === d.slug)) return json(409, { error: "slug_taken", message: "A post with this slug already exists." });
      const p: Post = { id: `p_${this.next++}`, status: "draft", slug: String(d.slug), title: String(d.title), content_html: String(d.content_html ?? ""), excerpt: String(d.excerpt ?? ""), seo: {} };
      this.applySeo(p, d.seo);
      this.posts.set(p.id, p);
      return json(201, this.toJson(p));
    }
    const m = path.match(/^\/posts\/([A-Za-z0-9_-]+)(\/publish)?$/);
    if (m) {
      const p = this.posts.get(m[1]);
      if (!p) return json(404, { error: "not_found", message: "Post not found." });
      if (m[2] && method === "POST") {
        if (this.opts.canPublish === false) return json(403, { error: "forbidden", message: "This token cannot publish." });
        p.status = "published";
        return json(200, this.toJson(p));
      }
      if (!m[2] && method === "GET") return json(200, this.toJson(p));
      if (!m[2] && method === "PATCH") {
        const d = JSON.parse(body ?? "{}") as Record<string, unknown>;
        for (const k of ["title", "slug", "content_html", "excerpt"] as const) if (d[k] !== undefined) (p as Record<string, unknown>)[k] = String(d[k]);
        this.applySeo(p, d.seo);
        return json(200, this.toJson(p));
      }
    }
    return json(404, { error: "not_found", message: "No such route." });
  }

  private render(pathname: string): MockResponse {
    const slug = pathname.replace(/\/$/, "").match(/^\/posts\/([a-z0-9-]+)$/)?.[1];
    const p = [...this.posts.values()].find((x) => x.slug === slug && x.status === "published");
    if (!p) return notFoundPage();
    const override = this.renderOverride?.({ title: p.title });
    if (override) return { status: 200, headers: { "content-type": "text/html" }, text: override };
    return page({
      title: p.seo.meta_title || p.title, description: p.seo.meta_description, canonical: p.seo.canonical_url || `${this.opts.baseUrl}/posts/${p.slug}`,
      h1: p.title, body: p.content_html, site: "Mock Custom CMS (development)",
    });
  }
}
