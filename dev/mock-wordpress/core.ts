/**
 * DEVELOPMENT/TEST ONLY — an in-memory imitation of the WordPress REST API and of
 * rendered post pages. It is never imported by application code. Used by unit/
 * integration tests (as an HttpClient) and by `npm run mock:wp` (as an HTTP server).
 */
import { AppError } from "../../lib/errors";

export type MockFault = {
  method?: string;
  path?: RegExp;
  status?: number;
  body?: string;
  /** Simulate a timeout. If `applied` is true the write is applied before timing out (ambiguous). */
  timeout?: { applied: boolean };
  times?: number;
};

type Post = {
  id: number; status: string; slug: string; title: string; content: string; excerpt: string;
  categories: number[]; tags: number[]; featured_media: number; date_gmt: string; meta: Record<string, string>;
};

export type MockWordPressOptions = {
  baseUrl: string;
  username: string;
  applicationPassword: string;
  seoPlugin?: "yoast" | "rankmath" | null;
  /** Whether the plugin's meta keys are registered with show_in_rest (writable). */
  exposeSeoMeta?: boolean;
  /** Override the rendered page (e.g. to simulate a theme that drops content). */
  renderOverride?: (post: Post) => string | null;
  siteName?: string;
};

const META_KEYS = {
  yoast: { title: "_yoast_wpseo_title", desc: "_yoast_wpseo_metadesc", canonical: "_yoast_wpseo_canonical" },
  rankmath: { title: "rank_math_title", desc: "rank_math_description", canonical: "rank_math_canonical_url" },
};

export class MockWordPress {
  posts = new Map<number, Post>();
  faults: MockFault[] = [];
  requests: { method: string; path: string }[] = [];
  private nextId = 100;

  constructor(public opts: MockWordPressOptions) {}

  get origin() {
    return new URL(this.opts.baseUrl).origin;
  }

  addFault(f: MockFault) {
    this.faults.push({ times: 1, ...f });
  }

  private takeFault(method: string, path: string) {
    const i = this.faults.findIndex((f) => (!f.method || f.method === method) && (!f.path || f.path.test(path)) && (f.times ?? 1) > 0);
    if (i < 0) return null;
    const f = this.faults[i];
    f.times = (f.times ?? 1) - 1;
    return f;
  }

  private exposedKeys(): Record<string, string> {
    const plugin = this.opts.seoPlugin;
    if (!plugin || !this.opts.exposeSeoMeta) return {};
    return Object.fromEntries(Object.values(META_KEYS[plugin]).map((k) => [k, ""]));
  }

  private toJson(p: Post) {
    return {
      id: p.id, status: p.status, slug: p.slug, link: `${this.opts.baseUrl}/${p.slug}/`,
      title: { raw: p.title, rendered: p.title }, content: { raw: p.content, rendered: p.content },
      excerpt: { raw: p.excerpt, rendered: p.excerpt }, categories: p.categories, tags: p.tags,
      featured_media: p.featured_media, date_gmt: p.date_gmt, meta: { ...this.exposedKeys(), ...p.meta },
    };
  }

  /** Handles a request; returns status/headers/body like a real server would. */
  async handle(method: string, rawUrl: string, headers: Record<string, string> = {}, body?: string) {
    const url = new URL(rawUrl);
    const path = url.searchParams.get("rest_route") ?? url.pathname.replace(/^\/wp-json/, "");
    const isRest = url.pathname.startsWith("/wp-json") || url.searchParams.has("rest_route");
    this.requests.push({ method, path });

    const fault = this.takeFault(method, path);
    if (fault?.timeout) {
      if (fault.timeout.applied) await this.route(method, url, path, isRest, headers, body);
      throw new AppError("TIMEOUT", "The website did not respond in time.", { retryable: true, ambiguous: method !== "GET" });
    }
    if (fault?.status) return json(fault.status, fault.body ? JSON.parse(fault.body) : { code: "mock_fault", message: "Injected fault" });
    return this.route(method, url, path, isRest, headers, body);
  }

  private async route(method: string, url: URL, path: string, isRest: boolean, headers: Record<string, string>, body?: string) {
    if (!isRest) return this.renderPage(url.pathname);
    if (path === "/" || path === "") {
      const ns = ["oembed/1.0", "wp/v2", "wp-site-health/v1"];
      if (this.opts.seoPlugin === "yoast") ns.push("yoast/v1");
      if (this.opts.seoPlugin === "rankmath") ns.push("rankmath/v1");
      return json(200, { name: this.opts.siteName ?? "Mock WordPress (development)", url: this.opts.baseUrl, namespaces: ns });
    }
    const auth = headers.authorization ?? headers.Authorization ?? "";
    const expected = "Basic " + Buffer.from(`${this.opts.username}:${this.opts.applicationPassword}`).toString("base64");
    if (auth !== expected) return json(401, { code: "incorrect_password", message: "The provided password is an invalid application password." });

    if (path === "/wp/v2/users/me") {
      return json(200, { id: 1, name: this.opts.username, slug: this.opts.username, capabilities: { publish_posts: true, edit_posts: true } });
    }
    if (path === "/wp/v2/posts" && method === "GET") {
      const slug = url.searchParams.get("slug");
      const list = [...this.posts.values()].filter((p) => (slug ? p.slug === slug : true) && p.status !== "trash");
      return json(200, list.slice(0, Number(url.searchParams.get("per_page") ?? 10)).map((p) => this.toJson(p)));
    }
    if (path === "/wp/v2/posts" && method === "POST") {
      const data = JSON.parse(body ?? "{}");
      if (!data.title) return json(400, { code: "rest_invalid_param", message: "Invalid parameter(s): title" });
      let slug = data.slug || String(data.title).toLowerCase().replace(/[^a-z0-9]+/g, "-");
      while ([...this.posts.values()].some((p) => p.slug === slug)) slug = `${slug}-2`; // WP de-duplicates slugs
      const post: Post = {
        id: this.nextId++, status: data.status ?? "draft", slug, title: data.title, content: data.content ?? "",
        excerpt: data.excerpt ?? "", categories: data.categories ?? [], tags: data.tags ?? [], featured_media: data.featured_media ?? 0,
        date_gmt: new Date().toISOString().slice(0, 19), meta: {},
      };
      this.applyMeta(post, data.meta);
      this.posts.set(post.id, post);
      return json(201, this.toJson(post));
    }
    const m = path.match(/^\/wp\/v2\/posts\/(\d+)$/);
    if (m) {
      const post = this.posts.get(Number(m[1]));
      if (!post) return json(404, { code: "rest_post_invalid_id", message: "Invalid post ID." });
      if (method === "GET") return json(200, this.toJson(post));
      if (method === "POST") {
        const data = JSON.parse(body ?? "{}");
        for (const k of ["title", "content", "excerpt", "slug", "status", "categories", "tags", "featured_media", "date_gmt"] as const) {
          if (data[k] !== undefined) (post as Record<string, unknown>)[k] = data[k];
        }
        this.applyMeta(post, data.meta);
        return json(200, this.toJson(post));
      }
    }
    return json(404, { code: "rest_no_route", message: "No route was found matching the URL and request method." });
  }

  private applyMeta(post: Post, meta: Record<string, string> | undefined) {
    if (!meta) return;
    const allowed = this.exposedKeys();
    for (const [k, v] of Object.entries(meta)) if (k in allowed) post.meta[k] = String(v); // unregistered keys are silently ignored, like WP
  }

  private renderPage(pathname: string) {
    const slug = pathname.replace(/^\/|\/$/g, "");
    const post = [...this.posts.values()].find((p) => p.slug === slug && p.status === "publish");
    if (!post) return { status: 404, headers: { "content-type": "text/html" }, text: "<html><head><title>Page not found</title></head><body><h1>Not found</h1></body></html>" };
    const override = this.opts.renderOverride?.(post);
    if (override) return { status: 200, headers: { "content-type": "text/html" }, text: override };
    const keys = this.opts.seoPlugin ? META_KEYS[this.opts.seoPlugin] : null;
    const seoTitle = keys ? post.meta[keys.title] : "";
    const desc = keys ? post.meta[keys.desc] : "";
    const canonical = (keys && post.meta[keys.canonical]) || `${this.opts.baseUrl}/${post.slug}/`;
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const html = `<!doctype html><html><head><title>${esc(seoTitle || post.title)} – ${esc(this.opts.siteName ?? "Mock WordPress")}</title>
${desc ? `<meta name="description" content="${esc(desc)}">` : ""}<link rel="canonical" href="${esc(canonical)}"></head>
<body><header>Mock WordPress (development)</header><article><h1 class="entry-title">${esc(post.title)}</h1><div class="entry-content">${post.content}</div></article></body></html>`;
    return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, text: html };
  }

  /** Adapts the mock to the app's HttpClient signature. */
  asHttpClient() {
    return async (url: string, req: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
      const res = await this.handle(req.method ?? "GET", url, req.headers ?? {}, req.body);
      return { ...res, url };
    };
  }
}

function json(status: number, data: unknown) {
  return { status, headers: { "content-type": "application/json" } as Record<string, string>, text: JSON.stringify(data) };
}
