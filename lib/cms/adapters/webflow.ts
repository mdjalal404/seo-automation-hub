import type { WebflowCredentials, WebflowFieldMap } from "@/lib/cms/credentials";
import { joinUrl, JsonTransport, SLUG_RE, seoSyncFromEcho, validateCorePayload } from "@/lib/cms/http";
import type { CmsAdapter, ConnectionInfo, PostPayload, RemotePost, SeoWriteResult } from "@/lib/cms/types";
import { AppError } from "@/lib/errors";
import type { HttpClient } from "@/lib/security/safe-fetch";

/**
 * Webflow Data API v2 adapter (https://developers.webflow.com/data/reference).
 * Publishes items of one CMS collection with a site API token (Bearer) that needs
 * the cms:read and cms:write scopes. Items are created as drafts, then published with
 * POST /collections/{id}/items/publish. Webflow has no per-item SEO API: meta fields are
 * written to mapped collection fields and only reach the page if the template binds them.
 */
export const WEBFLOW_API_BASE = "https://api.webflow.com/v2";
const ID_RE = /^[a-f0-9]{24}$/;

type WfField = { slug: string; type: string; displayName?: string; isRequired?: boolean };
type WfCollection = { id: string; displayName?: string; slug: string; fields: WfField[] };
type WfItem = {
  id: string; isDraft?: boolean; isArchived?: boolean; lastPublished?: string | null; lastUpdated?: string;
  fieldData: Record<string, unknown> & { name?: string; slug?: string };
};

export type WebflowAdapterOptions = {
  /** Public site address; collection pages are served at /<collection-slug>/<item-slug>. */
  siteUrl: string;
  credentials: WebflowCredentials;
  http: HttpClient;
  apiBase?: string;
  minIntervalMs?: number;
};

export class WebflowAdapter implements CmsAdapter {
  readonly label = "Webflow";
  private readonly api: string;
  private readonly t: JsonTransport;
  private collection: WfCollection | null = null;

  constructor(private readonly opts: WebflowAdapterOptions) {
    if (!ID_RE.test(opts.credentials.collectionId)) throw new AppError("INVALID_INPUT", "Invalid Webflow collection ID.");
    this.api = (opts.apiBase ?? WEBFLOW_API_BASE).replace(/\/+$/, "");
    this.t = new JsonTransport({
      platform: "Webflow", metricPrefix: "webflow", http: opts.http, minIntervalMs: opts.minIntervalMs ?? 1100, // Webflow allows ~60 req/min
      headers: () => ({ authorization: `Bearer ${opts.credentials.apiToken}` }),
    });
  }

  async testConnection(): Promise<ConnectionInfo> {
    const col = await this.loadCollection(true);
    const map = this.fieldMap(col);
    const items = await this.listItems({ limit: 5 });
    return {
      siteName: col.displayName ?? col.slug,
      siteUrl: this.opts.siteUrl,
      user: { id: "api-token", name: "Webflow API token", slug: "api-token" },
      canPublish: null, // token scopes are only enforced on write
      seoPlugins: [map.metaTitle && "meta title field", map.metaDescription && "meta description field", map.canonical && "canonical field"].filter(Boolean) as string[],
      settings: { webflow_collection_slug: col.slug },
      details: {
        Collection: `${col.displayName ?? col.slug} (/${col.slug})`,
        "Body field": map.body,
        "Summary field": map.summary ?? "—",
        "Meta title field": map.metaTitle ?? "not mapped",
        "Meta description field": map.metaDescription ?? "not mapped",
      },
      recentPosts: items.map((i) => ({ id: i.id, title: i.title, status: i.status, link: i.link })),
    };
  }

  async getPosts(opts: { perPage?: number } = {}) {
    return this.listItems({ limit: Math.min(100, opts.perPage ?? 10) });
  }

  async getPost(id: string): Promise<RemotePost | null> {
    if (!ID_RE.test(id)) throw new AppError("INVALID_INPUT", "Invalid Webflow item ID.");
    await this.loadCollection(); // needed to build the public link
    try {
      return this.toRemote(await this.t.request<WfItem>("GET", this.url(`/items/${id}`), undefined, "item"));
    } catch (err) {
      if (err instanceof AppError && err.code === "CMS_NOT_FOUND") return null;
      throw err;
    }
  }

  async findPostBySlug(slug: string): Promise<RemotePost | null> {
    if (!SLUG_RE.test(slug)) return null;
    const items = await this.listItems({ slug, limit: 10 });
    return items.find((i) => i.slug === slug) ?? null;
  }

  async createDraft(payload: PostPayload) {
    validateCorePayload(payload);
    const fieldData = await this.fieldData(payload);
    const item = await this.t.request<WfItem>("POST", this.url("/items"), { isArchived: false, isDraft: true, fieldData }, "items");
    return this.result(item, payload);
  }

  async updateDraft(id: string, payload: PostPayload) {
    validateCorePayload(payload);
    const existing = await this.getPost(id);
    if (!existing) throw new AppError("CMS_NOT_FOUND", "The Webflow item no longer exists. It may have been deleted in Webflow.");
    const fieldData = await this.fieldData(payload);
    const item = await this.t.request<WfItem>("PATCH", this.url(`/items/${id}`), { fieldData }, "item");
    return this.result(item, payload);
  }

  async publishPost(id: string): Promise<RemotePost> {
    if (!ID_RE.test(id)) throw new AppError("INVALID_INPUT", "Invalid Webflow item ID.");
    await this.t.request<WfItem>("PATCH", this.url(`/items/${id}`), { isDraft: false }, "item");
    const res = await this.t.request<{ publishedItemIds?: string[]; errors?: unknown[] }>("POST", this.url("/items/publish"), { itemIds: [id] }, "publish");
    if (!res.publishedItemIds?.includes(id)) {
      throw new AppError("CMS_UNEXPECTED_RESPONSE", "Webflow did not confirm that the item was published. The site may need to be published once from the Designer first.", {
        retryable: true, ambiguous: true,
      });
    }
    const post = await this.getPost(id);
    if (!post) throw new AppError("CMS_UNEXPECTED_RESPONSE", "The Webflow item disappeared after publishing.", { retryable: true, ambiguous: true });
    return { ...post, status: "publish" };
  }

  // ---- internals ------------------------------------------------------------

  private url(path: string) {
    return `${this.api}/collections/${this.opts.credentials.collectionId}${path}`;
  }

  private async loadCollection(force = false): Promise<WfCollection> {
    if (this.collection && !force) return this.collection;
    const col = await this.t.request<WfCollection>("GET", this.url(""), undefined, "collection");
    if (!col || typeof col.slug !== "string" || !Array.isArray(col.fields)) {
      throw new AppError("CMS_UNEXPECTED_RESPONSE", "Webflow returned an unexpected collection payload.");
    }
    this.collection = col;
    return col;
  }

  /** Resolves field slugs: explicit overrides first, then conventional names. */
  private fieldMap(col: WfCollection): WebflowFieldMap {
    const o = this.opts.credentials.fieldMap ?? {};
    const by = (slug?: string) => (slug ? col.fields.find((f) => f.slug === slug) : undefined);
    const pick = (override: string | undefined, types: string[], names: RegExp) => {
      if (override) {
        const f = by(override);
        if (!f) throw new AppError("INVALID_INPUT", `The Webflow collection has no field with slug "${override}".`);
        if (!types.includes(f.type)) throw new AppError("INVALID_INPUT", `Webflow field "${override}" is ${f.type}; expected ${types.join(" or ")}.`);
        return f.slug;
      }
      return col.fields.find((f) => types.includes(f.type) && names.test(f.slug))?.slug;
    };
    const body = pick(o.body, ["RichText"], /body|content|post/) ?? col.fields.find((f) => f.type === "RichText")?.slug;
    if (!body) throw new AppError("INVALID_INPUT", "This Webflow collection has no Rich Text field for the article body.");
    return {
      body,
      summary: pick(o.summary, ["PlainText", "RichText"], /^(post-)?(summary|excerpt)$/),
      metaTitle: pick(o.metaTitle, ["PlainText"], /^(seo|meta)-title$/),
      metaDescription: pick(o.metaDescription, ["PlainText"], /^(seo|meta)-description$/),
      canonical: pick(o.canonical, ["Link", "PlainText"], /^canonical(-url)?$/),
    };
  }

  private async fieldData(p: PostPayload) {
    const map = this.fieldMap(await this.loadCollection());
    return {
      name: p.title,
      slug: p.slug,
      [map.body]: p.contentHtml,
      ...(map.summary && p.excerpt ? { [map.summary]: p.excerpt } : {}),
      ...(map.metaTitle && p.seo.metaTitle ? { [map.metaTitle]: p.seo.metaTitle } : {}),
      ...(map.metaDescription && p.seo.metaDescription ? { [map.metaDescription]: p.seo.metaDescription } : {}),
      ...(map.canonical && p.seo.canonicalUrl ? { [map.canonical]: p.seo.canonicalUrl } : {}),
    };
  }

  private async result(item: WfItem, payload: PostPayload): Promise<{ post: RemotePost; seo: SeoWriteResult }> {
    const post = this.toRemote(item);
    const map = this.fieldMap(await this.loadCollection());
    const f = (slug: string | undefined, label: string) =>
      slug ? { sent: true as const, echoed: item.fieldData?.[slug] } : { sent: false as const, note: `No ${label} field is mapped in this Webflow collection. Stored in this app only.` };
    const seo = seoSyncFromEcho("Webflow", payload, {
      meta_title: f(map.metaTitle, "meta title"),
      meta_description: f(map.metaDescription, "meta description"),
      canonical_url: f(map.canonical, "canonical URL"),
    });
    if (seo.warnings.length) seo.warnings.push("Map the fields when connecting, and bind them in the collection template's SEO settings.");
    return { post, seo };
  }

  private async listItems(q: { slug?: string; limit: number }) {
    await this.loadCollection();
    const qs = new URLSearchParams({ limit: String(q.limit), ...(q.slug ? { slug: q.slug } : {}) });
    const res = await this.t.request<{ items?: WfItem[] }>("GET", `${this.url("/items")}?${qs}`, undefined, "items");
    return (res.items ?? []).map((i) => this.toRemote(i));
  }

  private toRemote(i: WfItem): RemotePost {
    if (!i || !ID_RE.test(i.id ?? "") || !i.fieldData) throw new AppError("CMS_UNEXPECTED_RESPONSE", "Webflow returned an unexpected item payload.");
    const slug = String(i.fieldData.slug ?? "");
    const live = !!i.lastPublished && !i.isDraft;
    const status = i.isArchived ? "archived" : i.isDraft ? "draft" : live ? "publish" : "pending";
    const collectionSlug = this.collection?.slug ?? "";
    return {
      id: i.id, status, slug, title: String(i.fieldData.name ?? ""),
      link: joinUrl(this.opts.siteUrl, `${collectionSlug}/${slug}`),
      meta: i.fieldData,
    };
  }
}
