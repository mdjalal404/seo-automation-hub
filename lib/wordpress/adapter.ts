import type { CmsAdapter, ConnectionInfo, PostPayload, RemotePost, SeoWriteResult } from "@/lib/cms/types";
import { AppError } from "@/lib/errors";
import { logger, metric } from "@/lib/observability/logger";
import type { WordPressCredentials } from "@/lib/security/crypto";
import type { HttpClient, HttpRequest } from "@/lib/security/safe-fetch";
import { buildSeoMeta, seoSyncFromResponse } from "@/lib/wordpress/seo-meta";

/**
 * WordPress REST API adapter (https://developer.wordpress.org/rest-api/).
 * Authenticates with an Application Password over HTTPS (Basic auth), never a login password.
 */
export type WordPressAdapterOptions = {
  baseUrl: string;
  credentials: WordPressCredentials;
  http: HttpClient;
  /** Discovered REST root; defaults to `${baseUrl}/wp-json`. Supports `?rest_route=` sites. */
  restRoot?: string;
  /** Minimum spacing between requests to the same site (basic rate limiting). */
  minIntervalMs?: number;
  timeoutMs?: number;
};

type WpPost = {
  id: number;
  status: string;
  link: string;
  slug: string;
  title: { raw?: string; rendered?: string };
  meta?: Record<string, unknown> | unknown[];
};

const POST_STATUSES = "publish,future,draft,pending,private";

export class WordPressAdapter implements CmsAdapter {
  readonly label = "WordPress";
  private readonly restRoot: string;
  private lastRequestAt = 0;

  constructor(private readonly opts: WordPressAdapterOptions) {
    this.restRoot = (opts.restRoot ?? `${opts.baseUrl.replace(/\/+$/, "")}/wp-json`).replace(/\/+$/, "");
  }

  // ---- public API --------------------------------------------------------

  async testConnection(): Promise<ConnectionInfo> {
    const index = await this.request<{ name?: string; url?: string; namespaces?: string[] }>("GET", "/");
    if (!index || !Array.isArray(index.namespaces) || !index.namespaces.includes("wp/v2")) {
      throw new AppError("WP_UNEXPECTED_RESPONSE", "This URL does not expose the WordPress REST API (wp/v2). Check the site address and that the REST API is enabled.");
    }
    const me = await this.request<{ id: number; name: string; slug: string; capabilities?: Record<string, boolean> }>("GET", "/wp/v2/users/me", { context: "edit" });
    const posts = await this.request<WpPost[]>("GET", "/wp/v2/posts", { per_page: "5", context: "edit", status: POST_STATUSES, _fields: "id,title,status,link,slug" });
    const seoPlugins = [
      index.namespaces.includes("yoast/v1") && "yoast",
      index.namespaces.includes("rankmath/v1") && "rankmath",
    ].filter(Boolean) as string[];
    return {
      siteName: index.name ?? "",
      siteUrl: index.url ?? this.opts.baseUrl,
      user: { id: String(me.id), name: me.name, slug: me.slug },
      canPublish: !!me.capabilities?.publish_posts,
      seoPlugins,
      settings: { rest_root: this.restRoot },
      details: { "WordPress user": me.name },
      recentPosts: (Array.isArray(posts) ? posts : []).map((p) => ({ id: String(p.id), title: p.title?.raw ?? p.title?.rendered ?? "", status: p.status, link: p.link })),
    };
  }

  async getPosts(opts: { perPage?: number } = {}): Promise<RemotePost[]> {
    const posts = await this.request<WpPost[]>("GET", "/wp/v2/posts", { per_page: String(Math.min(100, opts.perPage ?? 10)), context: "edit", status: POST_STATUSES });
    return posts.map(toRemote);
  }

  async getPost(id: string): Promise<RemotePost | null> {
    assertPostId(id);
    try {
      return toRemote(await this.request<WpPost>("GET", `/wp/v2/posts/${id}`, { context: "edit" }));
    } catch (err) {
      if (err instanceof AppError && err.code === "WP_NOT_FOUND") return null;
      throw err;
    }
  }

  async findPostBySlug(slug: string): Promise<RemotePost | null> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
    const posts = await this.request<WpPost[]>("GET", "/wp/v2/posts", { slug, status: POST_STATUSES, context: "edit" });
    return Array.isArray(posts) && posts.length ? toRemote(posts[0]) : null;
  }

  async createDraft(payload: PostPayload): Promise<{ post: RemotePost; seo: SeoWriteResult }> {
    validatePayload(payload);
    const created = toRemote(await this.request<WpPost>("POST", "/wp/v2/posts", undefined, { ...corePayload(payload), status: "draft" }));
    // The create response reveals which meta keys this site exposes; write SEO fields only if supported.
    const { adapter, meta } = buildSeoMeta(payload, created.meta);
    if (!Object.keys(meta).length) return { post: created, seo: seoSyncFromResponse(payload, meta, adapter, created) };
    const updated = toRemote(await this.request<WpPost>("POST", `/wp/v2/posts/${created.id}`, undefined, { meta }));
    return { post: updated, seo: seoSyncFromResponse(payload, meta, adapter, updated) };
  }

  async updateDraft(id: string, payload: PostPayload): Promise<{ post: RemotePost; seo: SeoWriteResult }> {
    assertPostId(id);
    validatePayload(payload);
    const existing = await this.getPost(id);
    if (!existing) throw new AppError("WP_NOT_FOUND", "The WordPress post no longer exists. It may have been deleted in WordPress.");
    const { adapter, meta } = buildSeoMeta(payload, existing.meta);
    const body = { ...corePayload(payload), ...(Object.keys(meta).length ? { meta } : {}) };
    const updated = toRemote(await this.request<WpPost>("POST", `/wp/v2/posts/${id}`, undefined, body));
    return { post: updated, seo: seoSyncFromResponse(payload, meta, adapter, updated) };
  }

  async publishPost(id: string): Promise<RemotePost> {
    assertPostId(id);
    const post = toRemote(await this.request<WpPost>("POST", `/wp/v2/posts/${id}`, undefined, { status: "publish" }));
    if (post.status !== "publish") {
      throw new AppError("WP_UNEXPECTED_RESPONSE", `WordPress accepted the request but the post status is "${post.status}", not "publish".`);
    }
    return post;
  }

  async schedulePost(id: string, at: Date): Promise<RemotePost> {
    assertPostId(id);
    if (at.getTime() <= Date.now()) throw new AppError("INVALID_INPUT", "Scheduled time must be in the future.");
    const dateGmt = at.toISOString().slice(0, 19);
    const post = toRemote(await this.request<WpPost>("POST", `/wp/v2/posts/${id}`, undefined, { status: "future", date_gmt: dateGmt }));
    if (post.status !== "future") throw new AppError("WP_UNEXPECTED_RESPONSE", `WordPress did not schedule the post (status "${post.status}").`);
    return post;
  }

  // ---- transport -----------------------------------------------------------

  private buildUrl(path: string, query?: Record<string, string>): string {
    const qs = new URLSearchParams(query ?? {});
    if (this.restRoot.includes("?rest_route=")) {
      const url = new URL(this.restRoot.replace(/\?rest_route=.*$/, ""));
      url.search = new URLSearchParams({ rest_route: path, ...Object.fromEntries(qs) }).toString();
      return url.toString();
    }
    const q = qs.toString();
    return `${this.restRoot}${path === "/" ? "/" : path}${q ? `?${q}` : ""}`;
  }

  private async throttle() {
    const gap = this.opts.minIntervalMs ?? 250;
    const wait = this.lastRequestAt + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  private async request<T>(method: "GET" | "POST" | "DELETE", path: string, query?: Record<string, string>, body?: unknown): Promise<T> {
    await this.throttle();
    const { username, applicationPassword } = this.opts.credentials;
    const req: HttpRequest = {
      method,
      timeoutMs: this.opts.timeoutMs ?? 20_000,
      headers: {
        accept: "application/json",
        authorization: `Basic ${Buffer.from(`${username}:${applicationPassword}`).toString("base64")}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    };
    const started = Date.now();
    const url = this.buildUrl(path, query);
    let res;
    try {
      res = await this.opts.http(url, req);
    } catch (err) {
      metric("wordpress.request_failed", 1, { method, path: routeLabel(path), reason: err instanceof AppError ? err.code : "unknown" });
      throw err;
    }
    metric("wordpress.request_ms", Date.now() - started, { method, path: routeLabel(path), status: res.status });
    if (res.status >= 200 && res.status < 300) {
      try {
        return JSON.parse(res.text) as T;
      } catch {
        throw new AppError("WP_UNEXPECTED_RESPONSE", "WordPress returned a non-JSON response (a security or caching plugin may be intercepting the REST API).", {
          retryable: method !== "GET", ambiguous: method !== "GET",
        });
      }
    }
    throw mapWordPressError(res.status, res.text, res.headers, method !== "GET");
  }
}

export function mapWordPressError(status: number, text: string, headers: Record<string, string>, mutating: boolean): AppError {
  let code = "";
  let message = "";
  try {
    const parsed = JSON.parse(text) as { code?: string; message?: string };
    code = parsed.code ?? "";
    message = (parsed.message ?? "").replace(/<[^>]+>/g, "").slice(0, 300);
  } catch {
    /* non-JSON error body */
  }
  logger.warn("wordpress.error", { status, wpCode: code });
  if (status === 401) {
    return new AppError("WP_AUTH_FAILED", "WordPress rejected the credentials. The application password may be wrong, revoked or expired — reconnect the website.", { status });
  }
  if (status === 403) {
    return new AppError("WP_FORBIDDEN", `The WordPress user is not allowed to do this${message ? `: ${message}` : ""}. Publishing requires an Author, Editor or Administrator account.`, { status });
  }
  if (status === 404) {
    return new AppError("WP_NOT_FOUND", code === "rest_no_route" ? "The WordPress REST API route was not found at this address." : "The requested WordPress post was not found.", { status });
  }
  if (status === 429) {
    const ra = Number(headers["retry-after"]);
    return new AppError("WP_RATE_LIMITED", "WordPress is rate limiting requests; will retry later.", { status, retryable: true, retryAfterMs: Number.isFinite(ra) ? ra * 1000 : 60_000 });
  }
  if (status >= 500) {
    return new AppError("WP_SERVER_ERROR", `WordPress returned a server error (HTTP ${status}).`, { status, retryable: true, ambiguous: mutating });
  }
  return new AppError("WP_BAD_REQUEST", `WordPress rejected the request${message ? `: ${message}` : ` (HTTP ${status})`}.`, { status });
}

function toRemote(p: WpPost): RemotePost {
  if (!p || typeof p.id !== "number") throw new AppError("WP_UNEXPECTED_RESPONSE", "WordPress returned an unexpected post payload.", { retryable: false });
  return {
    id: String(p.id),
    status: p.status,
    link: p.link,
    slug: p.slug,
    title: p.title?.raw ?? p.title?.rendered ?? "",
    meta: p.meta && !Array.isArray(p.meta) ? p.meta : {},
  };
}

function corePayload(p: PostPayload) {
  return {
    title: p.title,
    content: p.contentHtml,
    excerpt: p.excerpt,
    slug: p.slug,
    ...(p.categories.length ? { categories: p.categories } : {}),
    ...(p.tags.length ? { tags: p.tags } : {}),
    ...(p.featuredMediaId ? { featured_media: p.featuredMediaId } : {}),
  };
}

function validatePayload(p: PostPayload) {
  if (!p.title.trim()) throw new AppError("INVALID_INPUT", "A post title is required.");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.slug)) throw new AppError("INVALID_INPUT", "The slug is invalid.");
  if (!p.contentHtml.trim()) throw new AppError("INVALID_INPUT", "The post body is empty.");
  if ([...p.categories, ...p.tags].some((n) => !Number.isInteger(n) || n <= 0)) throw new AppError("INVALID_INPUT", "Category and tag IDs must be positive integers.");
}

function assertPostId(id: string) {
  if (!/^\d{1,12}$/.test(id)) throw new AppError("INVALID_INPUT", "Invalid WordPress post ID.");
}

function routeLabel(path: string) {
  return path.replace(/\/\d+/g, "/:id");
}
