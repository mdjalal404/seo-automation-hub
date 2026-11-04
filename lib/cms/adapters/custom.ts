import type { CustomCmsCredentials } from "@/lib/cms/credentials";
import { joinUrl, JsonTransport, SLUG_RE, seoSyncFromEcho, validateCorePayload } from "@/lib/cms/http";
import type { CmsAdapter, ConnectionInfo, PostPayload, RemotePost, SeoFieldName, SeoWriteResult } from "@/lib/cms/types";
import { AppError } from "@/lib/errors";
import type { HttpClient } from "@/lib/security/safe-fetch";

/**
 * Adapter for any CMS that implements the "SEO Automation Hub Custom CMS API v1"
 * contract documented in docs/CUSTOM_CMS.md (Bearer token, JSON, six endpoints).
 * Requests go through the SSRF-guarded HTTP client like every other adapter.
 */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SEO_FIELDS: SeoFieldName[] = ["meta_title", "meta_description", "canonical_url"];

type CustomPost = {
  id: string | number; status: string; slug: string; title: string; url?: string | null;
  seo?: Partial<Record<SeoFieldName, string | null>>;
};
type SiteInfo = { name?: string; url?: string; user?: { id?: string | number; name?: string }; capabilities?: { publish?: boolean; seo_fields?: string[] } };

const STATUS: Record<string, string> = { published: "publish", publish: "publish", live: "publish", scheduled: "future", draft: "draft", pending: "pending", review: "pending" };

export type CustomCmsAdapterOptions = { siteUrl: string; credentials: CustomCmsCredentials; http: HttpClient; minIntervalMs?: number };

export class CustomCmsAdapter implements CmsAdapter {
  readonly label = "Custom CMS";
  private readonly t: JsonTransport;
  private site: SiteInfo | null = null;

  constructor(private readonly opts: CustomCmsAdapterOptions) {
    const u = new URL(opts.credentials.apiBaseUrl);
    if (u.username || u.password || u.search || u.hash) throw new AppError("INVALID_INPUT", "The API base URL must not contain credentials, a query string or a fragment.");
    this.t = new JsonTransport({
      platform: "Custom CMS", metricPrefix: "custom_cms", http: opts.http, minIntervalMs: opts.minIntervalMs ?? 250,
      headers: () => ({ authorization: `Bearer ${opts.credentials.apiToken}` }),
    });
  }

  async testConnection(): Promise<ConnectionInfo> {
    const site = await this.loadSite(true);
    const recent = await this.list({ limit: 5 });
    const seoFields = this.seoFields();
    return {
      siteName: site.name ?? "",
      siteUrl: site.url ?? this.opts.siteUrl,
      user: { id: String(site.user?.id ?? "api-token"), name: site.user?.name ?? "API token", slug: String(site.user?.id ?? "api-token") },
      canPublish: site.capabilities?.publish ?? null,
      seoPlugins: seoFields,
      settings: {},
      details: { "API base": this.opts.credentials.apiBaseUrl, "SEO fields": seoFields.join(", ") || "none" },
      recentPosts: recent.map((p) => ({ id: p.id, title: p.title, status: p.status, link: p.link })),
    };
  }

  getPosts(opts: { perPage?: number } = {}) {
    return this.list({ limit: Math.min(100, opts.perPage ?? 10) });
  }

  async getPost(id: string): Promise<RemotePost | null> {
    if (!ID_RE.test(id)) throw new AppError("INVALID_INPUT", "Invalid post ID.");
    try {
      return this.toRemote(await this.t.request<CustomPost>("GET", this.url(`posts/${encodeURIComponent(id)}`), undefined, "post"));
    } catch (err) {
      if (err instanceof AppError && err.code === "CMS_NOT_FOUND") return null;
      throw err;
    }
  }

  async findPostBySlug(slug: string): Promise<RemotePost | null> {
    if (!SLUG_RE.test(slug)) return null;
    const list = await this.list({ slug, limit: 10 });
    return list.find((p) => p.slug === slug) ?? null;
  }

  async createDraft(payload: PostPayload) {
    validateCorePayload(payload);
    const post = await this.t.request<CustomPost>("POST", this.url("posts"), { ...(await this.body(payload)), status: "draft" }, "posts");
    return this.result(post, payload);
  }

  async updateDraft(id: string, payload: PostPayload) {
    if (!ID_RE.test(id)) throw new AppError("INVALID_INPUT", "Invalid post ID.");
    validateCorePayload(payload);
    const post = await this.t.request<CustomPost>("PATCH", this.url(`posts/${encodeURIComponent(id)}`), await this.body(payload), "post");
    return this.result(post, payload);
  }

  async publishPost(id: string): Promise<RemotePost> {
    if (!ID_RE.test(id)) throw new AppError("INVALID_INPUT", "Invalid post ID.");
    const post = this.toRemote(await this.t.request<CustomPost>("POST", this.url(`posts/${encodeURIComponent(id)}/publish`), {}, "publish"));
    if (post.status !== "publish") throw new AppError("CMS_UNEXPECTED_RESPONSE", `The CMS accepted the request but reports status "${post.status}".`, { retryable: true, ambiguous: true });
    if (!post.link) throw new AppError("CMS_UNEXPECTED_RESPONSE", "The CMS did not return the public URL of the published post.");
    return post;
  }

  // ---- internals ------------------------------------------------------------

  private url(path: string) {
    return joinUrl(this.opts.credentials.apiBaseUrl, path);
  }

  private async loadSite(force = false) {
    if (this.site && !force) return this.site;
    const site = await this.t.request<SiteInfo>("GET", this.url("site"), undefined, "site");
    if (!site || typeof site !== "object" || Array.isArray(site)) throw new AppError("CMS_UNEXPECTED_RESPONSE", "GET /site did not return a JSON object (see docs/CUSTOM_CMS.md).");
    this.site = site;
    return site;
  }

  private seoFields(): SeoFieldName[] {
    const declared = this.site?.capabilities?.seo_fields ?? [];
    return SEO_FIELDS.filter((f) => declared.includes(f));
  }

  private async body(p: PostPayload) {
    await this.loadSite();
    const values: Record<SeoFieldName, string> = { meta_title: p.seo.metaTitle, meta_description: p.seo.metaDescription, canonical_url: p.seo.canonicalUrl };
    const seo = Object.fromEntries(this.seoFields().filter((f) => values[f]).map((f) => [f, values[f]]));
    return { title: p.title, slug: p.slug, content_html: p.contentHtml, excerpt: p.excerpt, ...(Object.keys(seo).length ? { seo } : {}) };
  }

  private result(raw: CustomPost, payload: PostPayload): { post: RemotePost; seo: SeoWriteResult } {
    const supported = new Set(this.seoFields());
    const field = (f: SeoFieldName) =>
      supported.has(f) ? { sent: true as const, echoed: raw.seo?.[f] } : { sent: false as const, note: `The CMS does not list ${f} in capabilities.seo_fields. Stored in this app only.` };
    return {
      post: this.toRemote(raw),
      seo: seoSyncFromEcho("the custom CMS", payload, { meta_title: field("meta_title"), meta_description: field("meta_description"), canonical_url: field("canonical_url") }),
    };
  }

  private async list(q: { slug?: string; limit: number }) {
    const qs = new URLSearchParams({ limit: String(q.limit), ...(q.slug ? { slug: q.slug } : {}) });
    const res = await this.t.request<{ items?: CustomPost[] }>("GET", `${this.url("posts")}?${qs}`, undefined, "posts");
    if (!Array.isArray(res.items)) throw new AppError("CMS_UNEXPECTED_RESPONSE", "GET /posts must return { items: [...] } (see docs/CUSTOM_CMS.md).");
    return res.items.map((p) => this.toRemote(p));
  }

  private toRemote(p: CustomPost): RemotePost {
    if (!p || (typeof p.id !== "string" && typeof p.id !== "number") || !ID_RE.test(String(p.id)) || typeof p.slug !== "string") {
      throw new AppError("CMS_UNEXPECTED_RESPONSE", "The CMS returned a post that does not match the API contract (see docs/CUSTOM_CMS.md).");
    }
    let link = "";
    if (p.url) {
      try {
        const u = new URL(p.url);
        if (u.protocol === "https:" || u.protocol === "http:") link = u.toString();
      } catch {
        /* ignore invalid URL */
      }
    }
    return {
      id: String(p.id), status: STATUS[String(p.status).toLowerCase()] ?? String(p.status), slug: p.slug, title: String(p.title ?? ""),
      link, meta: { ...(p.seo ?? {}) },
    };
  }
}
