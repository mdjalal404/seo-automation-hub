import type { ShopifyCredentials } from "@/lib/cms/credentials";
import { joinUrl, JsonTransport, SLUG_RE, seoSyncFromEcho, validateCorePayload } from "@/lib/cms/http";
import type { CmsAdapter, ConnectionInfo, PostPayload, RemotePost, SeoWriteResult } from "@/lib/cms/types";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import type { HttpClient } from "@/lib/security/safe-fetch";

/**
 * Shopify GraphQL Admin API adapter for blog articles
 * (https://shopify.dev/docs/api/admin-graphql). Authenticates with a custom app's Admin
 * API access token (X-Shopify-Access-Token) that has the read_content and write_content
 * scopes. SEO title/description use Shopify's built-in article SEO metafields
 * global.title_tag and global.description_tag.
 */
export const SHOPIFY_API_VERSION = "2025-10";
export const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const ARTICLE_GID_RE = /^gid:\/\/shopify\/Article\/\d{1,20}$/;

const ARTICLE_FIELDS = `fragment ArticleFields on Article {
  id handle title isPublished publishedAt
  blog { id handle }
  titleTag: metafield(namespace: "global", key: "title_tag") { value }
  descriptionTag: metafield(namespace: "global", key: "description_tag") { value }
}`;

const Q = {
  ShopInfo: `query ShopInfo { shop { name myshopifyDomain primaryDomain { url } } currentAppInstallation { accessScopes { handle } } blogs(first: 50) { nodes { id handle title } } }`,
  ArticleList: `query ArticleList($query: String!, $first: Int!) { articles(first: $first, sortKey: UPDATED_AT, reverse: true, query: $query) { nodes { ...ArticleFields } } }\n${ARTICLE_FIELDS}`,
  ArticleById: `query ArticleById($id: ID!) { article(id: $id) { ...ArticleFields } }\n${ARTICLE_FIELDS}`,
  ArticleCreate: `mutation ArticleCreate($article: ArticleCreateInput!) { articleCreate(article: $article) { article { ...ArticleFields } userErrors { field message code } } }\n${ARTICLE_FIELDS}`,
  ArticleUpdate: `mutation ArticleUpdate($id: ID!, $article: ArticleUpdateInput!) { articleUpdate(id: $id, article: $article) { article { ...ArticleFields } userErrors { field message code } } }\n${ARTICLE_FIELDS}`,
} as const;
type Operation = keyof typeof Q;

type ShopifyArticle = {
  id: string; handle: string; title: string; isPublished: boolean; publishedAt: string | null;
  blog: { id: string; handle: string } | null;
  titleTag: { value: string } | null; descriptionTag: { value: string } | null;
};
type UserError = { field?: string[] | null; message: string; code?: string | null };
type GqlResponse<T> = { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };

export type ShopifyAdapterOptions = {
  /** Public storefront address used to build article URLs. */
  storefrontUrl: string;
  credentials: ShopifyCredentials;
  http: HttpClient;
  /** Development only: replaces https://<shop>.myshopify.com (e.g. a local mock). */
  adminBaseOverride?: string;
  minIntervalMs?: number;
};

export class ShopifyAdapter implements CmsAdapter {
  readonly label = "Shopify";
  private readonly endpoint: string;
  private readonly t: JsonTransport;
  private blog: { id: string; handle: string; title: string } | null = null;

  constructor(private readonly opts: ShopifyAdapterOptions) {
    if (!SHOP_DOMAIN_RE.test(opts.credentials.shopDomain)) throw new AppError("INVALID_INPUT", "The shop domain must look like your-store.myshopify.com.");
    const base = opts.adminBaseOverride ?? `https://${opts.credentials.shopDomain}`;
    this.endpoint = `${base.replace(/\/+$/, "")}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    this.t = new JsonTransport({
      platform: "Shopify", metricPrefix: "shopify", http: opts.http, minIntervalMs: opts.minIntervalMs ?? 500,
      headers: () => ({ "x-shopify-access-token": opts.credentials.accessToken }),
    });
  }

  async testConnection(): Promise<ConnectionInfo> {
    const info = await this.gql<{
      shop: { name: string; myshopifyDomain: string; primaryDomain?: { url: string } };
      currentAppInstallation?: { accessScopes: { handle: string }[] };
      blogs: { nodes: { id: string; handle: string; title: string }[] };
    }>("ShopInfo", {});
    const scopes = new Set(info.currentAppInstallation?.accessScopes.map((s) => s.handle) ?? []);
    const blog = this.pickBlog(info.blogs.nodes);
    const recent = await this.articles(`blog_id:${numericId(blog.id)}`, 5);
    return {
      siteName: info.shop.name,
      siteUrl: info.shop.primaryDomain?.url ?? this.opts.storefrontUrl,
      user: { id: "admin-api", name: "Custom app (Admin API)", slug: "admin-api" },
      canPublish: scopes.has("write_content"),
      seoPlugins: ["shopify seo title", "shopify seo description"],
      settings: { shopify_blog_handle: blog.handle },
      details: { Store: info.shop.myshopifyDomain, Blog: `${blog.title} (/blogs/${blog.handle})`, Scopes: [...scopes].filter((s) => s.endsWith("_content")).join(", ") || "—" },
      recentPosts: recent.map((a) => ({ id: a.id, title: a.title, status: a.status, link: a.link })),
    };
  }

  async getPosts(opts: { perPage?: number } = {}) {
    const blog = await this.resolveBlog();
    return this.articles(`blog_id:${numericId(blog.id)}`, Math.min(100, opts.perPage ?? 10));
  }

  async getPost(id: string): Promise<RemotePost | null> {
    if (!ARTICLE_GID_RE.test(id)) throw new AppError("INVALID_INPUT", "Invalid Shopify article ID.");
    const res = await this.gql<{ article: ShopifyArticle | null }>("ArticleById", { id });
    return res.article ? this.toRemote(res.article) : null;
  }

  async findPostBySlug(slug: string): Promise<RemotePost | null> {
    if (!SLUG_RE.test(slug)) return null;
    const blog = await this.resolveBlog();
    // The search syntax is fuzzy; filter for an exact handle match ourselves.
    const list = await this.articles(`blog_id:${numericId(blog.id)} AND handle:${slug}`, 10);
    return list.find((a) => a.slug === slug) ?? null;
  }

  async createDraft(payload: PostPayload) {
    validateCorePayload(payload);
    const blog = await this.resolveBlog();
    const res = await this.gql<{ articleCreate: { article: ShopifyArticle | null; userErrors: UserError[] } }>("ArticleCreate", {
      article: { blogId: blog.id, ...this.articleInput(payload), isPublished: false, author: { name: this.opts.credentials.authorName } },
    });
    const article = this.mutationResult(res.articleCreate);
    return this.result(article, payload);
  }

  async updateDraft(id: string, payload: PostPayload) {
    if (!ARTICLE_GID_RE.test(id)) throw new AppError("INVALID_INPUT", "Invalid Shopify article ID.");
    validateCorePayload(payload);
    const res = await this.gql<{ articleUpdate: { article: ShopifyArticle | null; userErrors: UserError[] } }>("ArticleUpdate", { id, article: this.articleInput(payload) });
    return this.result(this.mutationResult(res.articleUpdate), payload);
  }

  async publishPost(id: string): Promise<RemotePost> {
    if (!ARTICLE_GID_RE.test(id)) throw new AppError("INVALID_INPUT", "Invalid Shopify article ID.");
    const res = await this.gql<{ articleUpdate: { article: ShopifyArticle | null; userErrors: UserError[] } }>("ArticleUpdate", { id, article: { isPublished: true } });
    const post = this.toRemote(this.mutationResult(res.articleUpdate));
    if (post.status !== "publish") throw new AppError("CMS_UNEXPECTED_RESPONSE", "Shopify accepted the request but the article is not published.", { retryable: true, ambiguous: true });
    return post;
  }

  // ---- internals ------------------------------------------------------------

  private articleInput(p: PostPayload) {
    const metafields = [
      p.seo.metaTitle && { namespace: "global", key: "title_tag", type: "single_line_text_field", value: p.seo.metaTitle },
      p.seo.metaDescription && { namespace: "global", key: "description_tag", type: "multi_line_text_field", value: p.seo.metaDescription },
    ].filter(Boolean);
    return { title: p.title, handle: p.slug, body: p.contentHtml, summary: p.excerpt || null, ...(metafields.length ? { metafields } : {}) };
  }

  private result(article: ShopifyArticle, payload: PostPayload): { post: RemotePost; seo: SeoWriteResult } {
    const seo = seoSyncFromEcho("Shopify", payload, {
      meta_title: { sent: true, echoed: article.titleTag?.value },
      meta_description: { sent: true, echoed: article.descriptionTag?.value },
      canonical_url: { sent: false, note: "Shopify generates canonical URLs itself; custom canonicals are not supported. Stored in this app only." },
    });
    return { post: this.toRemote(article), seo };
  }

  private mutationResult(r: { article: ShopifyArticle | null; userErrors: UserError[] } | undefined): ShopifyArticle {
    if (!r) throw new AppError("CMS_UNEXPECTED_RESPONSE", "Shopify returned an unexpected mutation payload.", { retryable: true, ambiguous: true });
    if (r.userErrors?.length) {
      const msg = r.userErrors.map((e) => e.message).join(" ").slice(0, 300);
      if (r.userErrors.some((e) => /handle/i.test(e.field?.join(".") ?? "") && /taken/i.test(e.message))) {
        throw new AppError("CONFLICT", `Shopify already has an article with this handle in the blog: ${msg}`);
      }
      throw new AppError("CMS_BAD_REQUEST", `Shopify rejected the article: ${msg}`);
    }
    if (!r.article) throw new AppError("CMS_UNEXPECTED_RESPONSE", "Shopify did not return the article.", { retryable: true, ambiguous: true });
    return r.article;
  }

  private async articles(query: string, first: number) {
    const res = await this.gql<{ articles: { nodes: ShopifyArticle[] } }>("ArticleList", { query, first });
    return res.articles.nodes.map((a) => this.toRemote(a));
  }

  private pickBlog(blogs: { id: string; handle: string; title: string }[]) {
    const blog = blogs.find((b) => b.handle === this.opts.credentials.blogHandle);
    if (!blog) {
      throw new AppError("INVALID_INPUT", `The store has no blog with handle "${this.opts.credentials.blogHandle}". Available: ${blogs.map((b) => b.handle).join(", ") || "none"}.`);
    }
    this.blog = blog;
    return blog;
  }

  private async resolveBlog() {
    if (this.blog) return this.blog;
    const info = await this.gql<{ blogs: { nodes: { id: string; handle: string; title: string }[] } }>("ShopInfo", {});
    return this.pickBlog(info.blogs.nodes);
  }

  private async gql<T>(operationName: Operation, variables: Record<string, unknown>): Promise<T> {
    const mutating = operationName.startsWith("ArticleCreate") || operationName.startsWith("ArticleUpdate");
    const res = await this.t.request<GqlResponse<T>>("POST", this.endpoint, { query: Q[operationName], variables, operationName }, operationName);
    if (res.errors?.length) {
      const codes = res.errors.map((e) => e.extensions?.code ?? "");
      logger.warn("shopify.graphql_error", { operation: operationName, codes });
      if (codes.includes("THROTTLED")) throw new AppError("CMS_RATE_LIMITED", "Shopify is throttling API requests; will retry later.", { retryable: true, retryAfterMs: 10_000 });
      if (codes.includes("ACCESS_DENIED")) throw new AppError("CMS_FORBIDDEN", "The Shopify app token lacks a required scope (read_content / write_content).");
      if (codes.includes("INTERNAL_SERVER_ERROR")) throw new AppError("CMS_SERVER_ERROR", "Shopify reported an internal error.", { retryable: true, ambiguous: mutating });
      throw new AppError("CMS_BAD_REQUEST", `Shopify rejected the request: ${res.errors[0].message.slice(0, 200)}`);
    }
    if (!res.data) throw new AppError("CMS_UNEXPECTED_RESPONSE", "Shopify returned no data.", { retryable: mutating, ambiguous: mutating });
    return res.data;
  }

  private toRemote(a: ShopifyArticle): RemotePost {
    if (!a || !ARTICLE_GID_RE.test(a.id ?? "")) throw new AppError("CMS_UNEXPECTED_RESPONSE", "Shopify returned an unexpected article payload.");
    const blogHandle = a.blog?.handle ?? this.opts.credentials.blogHandle;
    return {
      id: a.id, slug: a.handle, title: a.title,
      status: a.isPublished ? (a.publishedAt && new Date(a.publishedAt).getTime() > Date.now() ? "future" : "publish") : "draft",
      link: joinUrl(this.opts.storefrontUrl, `blogs/${blogHandle}/${a.handle}`),
      meta: { title_tag: a.titleTag?.value ?? null, description_tag: a.descriptionTag?.value ?? null },
    };
  }
}

function numericId(gid: string) {
  const id = gid.split("/").pop() ?? "";
  if (!/^\d+$/.test(id)) throw new AppError("CMS_UNEXPECTED_RESPONSE", "Unexpected Shopify ID format.");
  return id;
}
