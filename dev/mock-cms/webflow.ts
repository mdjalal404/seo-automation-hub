/**
 * DEVELOPMENT/TEST ONLY — in-memory imitation of the Webflow Data API v2 (one CMS
 * collection) and of the published collection pages. Publishing to it is simulated.
 */
import { hexId, json, MockCms, notFoundPage, page, type MockResponse } from "./common";

export const MOCK_WEBFLOW_COLLECTION_ID = "65f0c0ffee0000000000b10b";

type Item = {
  id: string; isDraft: boolean; isArchived: boolean; lastPublished: string | null; lastUpdated: string;
  fieldData: Record<string, string>;
  /** Snapshot that is live on the site (Webflow serves the last published version). */
  live: Record<string, string> | null;
};

export type MockWebflowOptions = {
  baseUrl: string;
  apiToken: string;
  /** Whether the collection has seo-title / seo-description fields. */
  seoFields?: boolean;
  collectionSlug?: string;
};

export class MockWebflow extends MockCms {
  items = new Map<string, Item>();
  private next = 0xa000;

  constructor(public opts: MockWebflowOptions) {
    super();
  }

  get origin() {
    return new URL(this.opts.baseUrl).origin;
  }

  private get slug() {
    return this.opts.collectionSlug ?? "blog";
  }

  private fields() {
    const f = [
      { slug: "name", type: "PlainText", displayName: "Name", isRequired: true },
      { slug: "slug", type: "PlainText", displayName: "Slug", isRequired: true },
      { slug: "post-body", type: "RichText", displayName: "Post body", isRequired: false },
      { slug: "post-summary", type: "PlainText", displayName: "Post summary", isRequired: false },
    ];
    if (this.opts.seoFields !== false) {
      f.push({ slug: "seo-title", type: "PlainText", displayName: "SEO title", isRequired: false });
      f.push({ slug: "seo-description", type: "PlainText", displayName: "SEO description", isRequired: false });
    }
    return f;
  }

  private toJson(i: Item) {
    const { live: _live, ...rest } = i;
    void _live;
    return rest;
  }

  protected route(method: string, url: URL, headers: Record<string, string>, body?: string): MockResponse {
    if (!url.pathname.startsWith("/v2/")) return this.render(url.pathname);
    if (headers.authorization !== `Bearer ${this.opts.apiToken}`) return json(401, { message: "Request not authorized", code: "not_authorized" });

    const base = `/v2/collections/${MOCK_WEBFLOW_COLLECTION_ID}`;
    if (!url.pathname.startsWith(base)) return json(404, { message: "Requested resource not found", code: "resource_not_found" });
    const path = url.pathname.slice(base.length);
    const known = new Set(this.fields().map((f) => f.slug));
    const pickFields = (data: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(data).filter(([k]) => known.has(k)).map(([k, v]) => [k, String(v)]));

    if (path === "" && method === "GET") {
      return json(200, { id: MOCK_WEBFLOW_COLLECTION_ID, displayName: "Blog Posts", singularName: "Blog Post", slug: this.slug, fields: this.fields() });
    }
    if (path === "/items" && method === "GET") {
      const slug = url.searchParams.get("slug");
      const list = [...this.items.values()].filter((i) => !slug || i.fieldData.slug === slug);
      return json(200, { items: list.slice(0, Number(url.searchParams.get("limit") ?? 100)).map((i) => this.toJson(i)), pagination: { total: list.length } });
    }
    if (path === "/items" && method === "POST") {
      const data = JSON.parse(body ?? "{}") as { isDraft?: boolean; fieldData?: Record<string, unknown> };
      const fd = pickFields(data.fieldData ?? {});
      if (!fd.name || !fd.slug) return json(400, { message: "Validation Error: name and slug are required", code: "validation_error" });
      if ([...this.items.values()].some((i) => i.fieldData.slug === fd.slug)) {
        return json(409, { message: "Unique value is already in database: slug", code: "conflict" });
      }
      const now = new Date().toISOString();
      const item: Item = { id: hexId(this.next++), isDraft: data.isDraft ?? true, isArchived: false, lastPublished: null, lastUpdated: now, fieldData: fd, live: null };
      this.items.set(item.id, item);
      return json(202, this.toJson(item));
    }
    if (path === "/items/publish" && method === "POST") {
      const { itemIds = [] } = JSON.parse(body ?? "{}") as { itemIds?: string[] };
      const published: string[] = [];
      const errors: string[] = [];
      for (const id of itemIds) {
        const item = this.items.get(id);
        if (!item || item.isDraft) {
          errors.push(id);
          continue;
        }
        item.lastPublished = new Date().toISOString();
        item.live = { ...item.fieldData };
        published.push(id);
      }
      return json(202, { publishedItemIds: published, errors });
    }
    const m = path.match(/^\/items\/([a-f0-9]{24})$/);
    if (m) {
      const item = this.items.get(m[1]);
      if (!item) return json(404, { message: "Item not found", code: "resource_not_found" });
      if (method === "GET") return json(200, this.toJson(item));
      if (method === "PATCH") {
        const data = JSON.parse(body ?? "{}") as { isDraft?: boolean; fieldData?: Record<string, unknown> };
        const fd = pickFields(data.fieldData ?? {});
        if (fd.slug && [...this.items.values()].some((i) => i.id !== item.id && i.fieldData.slug === fd.slug)) {
          return json(409, { message: "Unique value is already in database: slug", code: "conflict" });
        }
        Object.assign(item.fieldData, fd);
        if (typeof data.isDraft === "boolean") item.isDraft = data.isDraft;
        item.lastUpdated = new Date().toISOString();
        return json(200, this.toJson(item));
      }
    }
    return json(404, { message: "Route not found", code: "route_not_found" });
  }

  private render(pathname: string): MockResponse {
    const [, col, slug] = pathname.replace(/\/$/, "").split("/");
    if (col !== this.slug) return notFoundPage();
    const item = [...this.items.values()].find((i) => i.live?.slug === slug);
    if (!item?.live) return notFoundPage();
    const live = item.live;
    const override = this.renderOverride?.({ title: live.name });
    if (override) return { status: 200, headers: { "content-type": "text/html" }, text: override };
    return page({
      title: live["seo-title"] || live.name, description: live["seo-description"], canonical: `${this.opts.baseUrl}/${this.slug}/${live.slug}`,
      h1: live.name, body: live["post-body"] ?? "", site: "Mock Webflow site (development)",
    });
  }
}
