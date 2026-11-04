/**
 * DEVELOPMENT/TEST ONLY — in-memory imitation of the Shopify GraphQL Admin API
 * operations used by the adapter (dispatched by operationName, not a full GraphQL
 * engine) and of the storefront article pages. Publishing to it is simulated.
 */
import { json, MockCms, notFoundPage, page, type MockResponse } from "./common";

type Article = {
  id: string; handle: string; title: string; body: string; summary: string | null; author: string;
  isPublished: boolean; publishedAt: string | null; blogId: string; titleTag: string | null; descriptionTag: string | null;
};

export type MockShopifyOptions = {
  /** Storefront + admin origin of the mock, e.g. http://localhost:8789 */
  baseUrl: string;
  accessToken: string;
  scopes?: string[];
};

const BLOGS = [
  { id: "gid://shopify/Blog/1001", handle: "news", title: "News" },
  { id: "gid://shopify/Blog/1002", handle: "guides", title: "Guides" },
];

export class MockShopify extends MockCms {
  articles = new Map<string, Article>();
  private next = 5001;

  constructor(public opts: MockShopifyOptions) {
    super();
  }

  get origin() {
    return new URL(this.opts.baseUrl).origin;
  }

  protected faultKey(url: URL, body?: string) {
    if (!url.pathname.includes("/graphql.json")) return url.pathname;
    try {
      return String((JSON.parse(body ?? "{}") as { operationName?: string }).operationName ?? "");
    } catch {
      return "";
    }
  }

  private toJson(a: Article) {
    const blog = BLOGS.find((b) => b.id === a.blogId)!;
    return {
      id: a.id, handle: a.handle, title: a.title, isPublished: a.isPublished, publishedAt: a.publishedAt,
      blog: { id: blog.id, handle: blog.handle },
      titleTag: a.titleTag === null ? null : { value: a.titleTag },
      descriptionTag: a.descriptionTag === null ? null : { value: a.descriptionTag },
    };
  }

  protected route(method: string, url: URL, headers: Record<string, string>, body?: string): MockResponse {
    if (!/^\/admin\/api\/[\d-]+\/graphql\.json$/.test(url.pathname)) return this.render(url.pathname);
    if (method !== "POST") return json(405, { errors: "Method not allowed" });
    if (headers["x-shopify-access-token"] !== this.opts.accessToken) {
      return json(401, { errors: "[API] Invalid API key or access token (unrecognized login or wrong password)" });
    }
    const { operationName, variables = {} } = JSON.parse(body ?? "{}") as { operationName?: string; variables?: Record<string, unknown> };
    const scopes = this.opts.scopes ?? ["read_content", "write_content"];
    const needsWrite = operationName === "ArticleCreate" || operationName === "ArticleUpdate";
    if (needsWrite && !scopes.includes("write_content")) {
      return json(200, { errors: [{ message: "Access denied for articleCreate field.", extensions: { code: "ACCESS_DENIED" } }] });
    }

    switch (operationName) {
      case "ShopInfo":
        return json(200, {
          data: {
            shop: { name: "Mock Shopify store (development)", myshopifyDomain: "mock-store.myshopify.com", primaryDomain: { url: this.opts.baseUrl } },
            currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) },
            blogs: { nodes: BLOGS },
          },
        });
      case "ArticleList": {
        const q = String(variables.query ?? "");
        const blogId = q.match(/blog_id:(\d+)/)?.[1];
        const handle = q.match(/handle:([a-z0-9-]+)/)?.[1];
        const list = [...this.articles.values()].filter((a) => (!blogId || a.blogId.endsWith(`/${blogId}`)) && (!handle || a.handle.includes(handle)));
        return json(200, { data: { articles: { nodes: list.slice(0, Number(variables.first ?? 10)).map((a) => this.toJson(a)) } } });
      }
      case "ArticleById": {
        const a = this.articles.get(String(variables.id));
        return json(200, { data: { article: a ? this.toJson(a) : null } });
      }
      case "ArticleCreate": {
        const input = (variables.article ?? {}) as Record<string, unknown>;
        const errors = [];
        if (!input.title) errors.push({ field: ["article", "title"], message: "Title can't be blank", code: "BLANK" });
        if (!BLOGS.some((b) => b.id === input.blogId)) errors.push({ field: ["article", "blogId"], message: "Blog does not exist", code: "NOT_FOUND" });
        if ([...this.articles.values()].some((a) => a.blogId === input.blogId && a.handle === input.handle)) {
          errors.push({ field: ["article", "handle"], message: "Handle has already been taken", code: "TAKEN" });
        }
        if (errors.length) return json(200, { data: { articleCreate: { article: null, userErrors: errors } } });
        const a: Article = {
          id: `gid://shopify/Article/${this.next++}`, handle: String(input.handle), title: String(input.title), body: String(input.body ?? ""),
          summary: (input.summary as string) ?? null, author: String((input.author as { name?: string })?.name ?? ""), blogId: String(input.blogId),
          isPublished: !!input.isPublished, publishedAt: input.isPublished ? new Date().toISOString() : null, titleTag: null, descriptionTag: null,
        };
        this.applyMetafields(a, input.metafields);
        this.articles.set(a.id, a);
        return json(200, { data: { articleCreate: { article: this.toJson(a), userErrors: [] } } });
      }
      case "ArticleUpdate": {
        const a = this.articles.get(String(variables.id));
        if (!a) return json(200, { data: { articleUpdate: { article: null, userErrors: [{ field: ["id"], message: "Article does not exist", code: "NOT_FOUND" }] } } });
        const input = (variables.article ?? {}) as Record<string, unknown>;
        for (const k of ["title", "handle", "body", "summary"] as const) if (input[k] !== undefined) (a as Record<string, unknown>)[k] = input[k];
        if (typeof input.isPublished === "boolean") {
          if (input.isPublished && !a.isPublished) a.publishedAt = new Date().toISOString();
          a.isPublished = input.isPublished;
        }
        this.applyMetafields(a, input.metafields);
        return json(200, { data: { articleUpdate: { article: this.toJson(a), userErrors: [] } } });
      }
      default:
        return json(200, { errors: [{ message: `Unknown operation ${operationName}`, extensions: { code: "GRAPHQL_PARSE_FAILED" } }] });
    }
  }

  private applyMetafields(a: Article, metafields: unknown) {
    if (!Array.isArray(metafields)) return;
    for (const m of metafields as { namespace: string; key: string; value: string }[]) {
      if (m.namespace === "global" && m.key === "title_tag") a.titleTag = m.value;
      if (m.namespace === "global" && m.key === "description_tag") a.descriptionTag = m.value;
    }
  }

  private render(pathname: string): MockResponse {
    const m = pathname.replace(/\/$/, "").match(/^\/blogs\/([a-z0-9-]+)\/([a-z0-9-]+)$/);
    if (!m) return notFoundPage();
    const blog = BLOGS.find((b) => b.handle === m[1]);
    const a = [...this.articles.values()].find((x) => x.blogId === blog?.id && x.handle === m[2] && x.isPublished);
    if (!a) return notFoundPage();
    const override = this.renderOverride?.({ title: a.title });
    if (override) return { status: 200, headers: { "content-type": "text/html" }, text: override };
    return page({
      title: a.titleTag || a.title, description: a.descriptionTag ?? undefined, canonical: `${this.opts.baseUrl}/blogs/${m[1]}/${a.handle}`,
      h1: a.title, body: a.body, site: "Mock Shopify store (development)",
    });
  }
}
