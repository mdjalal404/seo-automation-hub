/**
 * DEVELOPMENT ONLY: in-memory mocks of the Google (OAuth token, Search Console, GA4,
 * PageSpeed), Microsoft Clarity, DataForSEO and Similarweb APIs, plus a small demo website
 * with deliberate SEO issues for the crawler. Data is synthetic and deterministic and is
 * never presented as real analytics.
 *
 * API requests arrive as /<real-hostname>/<path> (see ANALYTICS_API_BASE_URL).
 */
import { createPublicKey, createVerify } from "node:crypto";

export type MockRequest = { method: string; path: string; query: URLSearchParams; headers: Record<string, string | undefined>; body: string };
export type MockResponse = { status: number; body: string; type?: string; headers?: Record<string, string> };

export type MockAnalyticsConfig = {
  siteUrl: string;               // demo website origin, e.g. http://localhost:8792
  serviceAccountEmail: string;
  serviceAccountPrivateKey: string;
  clarityToken: string;
  dataforseoLogin: string;
  dataforseoPassword: string;
  similarwebKey: string;
  mixpanelUsername: string;
  mixpanelSecret: string;
  databricksToken: string;
};

/**
 * Scenario switches for demos and tests (POST /__mock/scenario on the API mock):
 * - demo "regression": the demo site ships an SEO-breaking release (noindex, 500, changed title/canonical);
 * - trafficDrop: Search Console clicks for that page fall 80% over the last 7 days.
 */
export const scenario: { demo: "normal" | "regression"; trafficDrop: string | null } = { demo: "normal", trafficDrop: null };

const json = (status: number, data: unknown, headers?: Record<string, string>): MockResponse => ({ status, body: JSON.stringify(data), type: "application/json", headers });

/** Deterministic pseudo-random numbers (mulberry32) so the synthetic data is stable. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** hreflang: the English implants page lists a German alternate that does not link back (deliberate error). */
const HREFLANG: Record<string, string> = {
  "/dental-implants": '<link rel="alternate" hreflang="en" href="/dental-implants"><link rel="alternate" hreflang="de" href="/de/zahnimplantate">',
};

export const DEMO_PAGES: { path: string; title: string; description?: string; h1?: string; words: number; links: string[]; noindex?: boolean; jsonld?: boolean }[] = [
  { path: "/", title: "Acme Dental — Family & Cosmetic Dentistry", description: "Family, cosmetic and implant dentistry in Springfield.", h1: "Acme Dental", words: 320, links: ["/dental-implants", "/teeth-whitening", "/blog", "/contact", "/old-offer"], jsonld: true },
  { path: "/dental-implants", title: "Dental Implants Cost & Procedure | Acme Dental", description: "What dental implants cost, how the procedure works and recovery times.", h1: "Dental implants", words: 1400, links: ["/", "/blog/implant-recovery", "/teeth-whitening"], jsonld: true },
  { path: "/teeth-whitening", title: "Teeth Whitening | Acme Dental", h1: "Teeth whitening", words: 650, links: ["/", "/dental-implants"] },
  { path: "/blog", title: "Blog | Acme Dental", description: "Dental health guides.", h1: "Blog", words: 120, links: ["/blog/implant-recovery", "/blog/whitening-at-home"] },
  { path: "/blog/implant-recovery", title: "Dental Implants Cost & Procedure | Acme Dental", description: "How long implant recovery takes.", h1: "Implant recovery", words: 900, links: ["/dental-implants", "/blog"] },
  { path: "/blog/whitening-at-home", title: "Whitening at home: what works", description: "At-home whitening options compared.", words: 700, links: ["/teeth-whitening", "/blog"] },
  { path: "/contact", title: "Contact Acme Dental", description: "Book an appointment.", h1: "Contact", words: 90, links: ["/"], noindex: false },
  { path: "/thank-you", title: "Thanks", h1: "Thank you", words: 20, links: ["/"], noindex: true },
  { path: "/de/zahnimplantate", title: "Zahnimplantate | Acme Dental", description: "Kosten und Ablauf von Zahnimplantaten.", h1: "Zahnimplantate", words: 600, links: ["/dental-implants"] },
  { path: "/orphan-guide", title: "Dental Insurance Guide | Acme Dental", description: "How dental insurance works.", h1: "Dental insurance guide", words: 800, links: ["/"] },
];

const QUERIES: { q: string; page: string; base: number; pos: number; trend: number }[] = [
  { q: "dental implants cost", page: "/dental-implants", base: 420, pos: 6.2, trend: 0 },
  { q: "dental implants", page: "/dental-implants", base: 900, pos: 11.4, trend: 0 },
  { q: "implant recovery time", page: "/blog/implant-recovery", base: 260, pos: 9.8, trend: 0 },
  { q: "dental implants cost", page: "/blog/implant-recovery", base: 180, pos: 14.1, trend: 0 },
  { q: "teeth whitening near me", page: "/teeth-whitening", base: 380, pos: 3.1, trend: 0 },
  { q: "acme dental", page: "/", base: 150, pos: 1.1, trend: 0 },
  { q: "whitening at home", page: "/blog/whitening-at-home", base: 300, pos: 4.4, trend: -0.7 },
  { q: "does teeth whitening hurt", page: "/teeth-whitening", base: 120, pos: 16.5, trend: 0 },
];
const EXPECTED = [0, 0.3, 0.16, 0.11, 0.08, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02];

export class MockAnalytics {
  private tokens = new Set<string>();
  constructor(private cfg: MockAnalyticsConfig) {}

  handle(req: MockRequest): MockResponse {
    const [, host, ...rest] = req.path.split("/");
    const path = "/" + rest.join("/");
    switch (host) {
      case "oauth2.googleapis.com": return this.googleToken(req);
      case "searchconsole.googleapis.com": return this.requireGoogle(req) ?? this.gsc(req, path);
      case "analyticsdata.googleapis.com": return this.requireGoogle(req) ?? this.ga4(path);
      case "www.googleapis.com": return this.pagespeed(req, path);
      case "www.clarity.ms": return this.clarity(req, path);
      case "api.dataforseo.com": return this.dataforseo(req, path);
      case "api.similarweb.com": return this.similarweb(req, path);
      case "mixpanel.com": return this.mixpanel(req, path);
      case "databricks": return this.databricks(req, path);
      case "hooks.slack.com": return this.slack(req, path);
      case "api.indexnow.org": return this.indexnow(req, path);
      case "__mock": return this.control(req, path);
      default: return json(404, { error: "unknown mock host" });
    }
  }

  // --- Google OAuth (verifies the JWT signature with the service account's public key) ---
  private googleToken(req: MockRequest): MockResponse {
    const assertion = new URLSearchParams(req.body).get("assertion") ?? "";
    const [h, c, s] = assertion.split(".");
    try {
      const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(createPublicKey(this.cfg.serviceAccountPrivateKey), Buffer.from(s ?? "", "base64url"));
      const claims = JSON.parse(Buffer.from(c, "base64url").toString()) as { iss: string; exp: number };
      if (!ok || claims.iss !== this.cfg.serviceAccountEmail || claims.exp * 1000 < Date.now()) return json(400, { error: "invalid_grant" });
    } catch {
      return json(400, { error: "invalid_grant" });
    }
    const token = `mock-google-${Math.random().toString(36).slice(2)}`;
    this.tokens.add(token);
    return json(200, { access_token: token, expires_in: 3600, token_type: "Bearer" });
  }

  private requireGoogle(req: MockRequest): MockResponse | null {
    const t = req.headers.authorization?.replace(/^Bearer /, "");
    return t && this.tokens.has(t) ? null : json(401, { error: { code: 401, message: "Request had invalid authentication credentials." } });
  }

  private property() {
    return `${this.cfg.siteUrl.replace(/\/$/, "")}/`;
  }

  private gscRows(start: string, end: string) {
    const rows: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[] = [];
    const s = new Date(start), e = new Date(end), today = Date.now();
    for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
      const date = d.toISOString().slice(0, 10);
      const age = (today - d.getTime()) / 86_400_000; // days ago
      QUERIES.forEach((q, i) => {
        const r = rng(Number(date.replace(/-/g, "")) * 31 + i);
        // trend < 0: traffic fell in the last 28 days (content decay)
        const factor = (q.trend < 0 && age < 28 ? 1 + q.trend : 1) * (scenario.trafficDrop === q.page && age < 7 ? 0.2 : 1);
        const impressions = Math.max(0, Math.round((q.base / 28) * (0.7 + r() * 0.6)));
        const position = Math.max(1, q.pos + (r() - 0.5));
        let ctr = EXPECTED[Math.min(10, Math.round(position))] ?? 0.01;
        if (q.q === "teeth whitening near me") ctr *= 0.3; // under-performing snippet (low CTR)
        const clicks = Math.round(impressions * ctr * factor);
        if (impressions) rows.push({ keys: [date, q.q, `${this.cfg.siteUrl}${q.page}`], clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: Math.round(position * 10) / 10 });
      });
    }
    return rows;
  }

  private gsc(req: MockRequest, path: string): MockResponse {
    if (path === "/webmasters/v3/sites") return json(200, { siteEntry: [{ siteUrl: this.property(), permissionLevel: "siteRestrictedUser" }] });
    const m = /^\/webmasters\/v3\/sites\/([^/]+)\/searchAnalytics\/query$/.exec(path);
    if (m && req.method === "POST") {
      if (decodeURIComponent(m[1]) !== this.property()) return json(403, { error: { code: 403, message: "User does not have sufficient permission for site." } });
      const b = JSON.parse(req.body || "{}") as { startDate: string; endDate: string; startRow?: number; rowLimit?: number };
      const rows = this.gscRows(b.startDate, b.endDate);
      return json(200, { rows: rows.slice(b.startRow ?? 0, (b.startRow ?? 0) + (b.rowLimit ?? 1000)), responseAggregationType: "byPage" });
    }
    if (path === "/v1/urlInspection/index:inspect" && req.method === "POST") {
      const b = JSON.parse(req.body || "{}") as { inspectionUrl: string };
      const indexed = !/whitening-at-home|orphan/.test(b.inspectionUrl);
      return json(200, { inspectionResult: { indexStatusResult: { verdict: indexed ? "PASS" : "NEUTRAL", coverageState: indexed ? "Submitted and indexed" : "Crawled - currently not indexed", robotsTxtState: "ALLOWED", lastCrawlTime: new Date(Date.now() - 3 * 86_400_000).toISOString() } } });
    }
    return json(404, { error: { code: 404, message: "Not found" } });
  }

  private ga4(path: string): MockResponse {
    if (!/^\/v1beta\/properties\/\d+:runReport$/.test(path)) return json(404, { error: { code: 404 } });
    if (!path.includes("/123456789:")) return json(403, { error: { code: 403, message: "User does not have sufficient permissions for this property." } });
    const rows = [];
    for (let i = 0; i < 90; i++) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");
      for (const [j, p] of ["/", "/dental-implants", "/teeth-whitening", "/blog/implant-recovery"].entries()) {
        const r = rng(Number(d) + j);
        const sessions = Math.round((j === 1 ? 40 : 15) * (0.7 + r() * 0.6));
        rows.push({ dimensionValues: [{ value: d }, { value: p }], metricValues: [{ value: String(sessions) }, { value: String(Math.round(sessions * 0.85)) }, { value: String(Math.round(sessions * 0.6)) }, { value: String(Math.round(sessions * 0.04)) }, { value: (0.35 + r() * 0.2).toFixed(3) }] });
      }
    }
    return json(200, { rows, rowCount: rows.length });
  }

  private pagespeed(req: MockRequest, path: string): MockResponse {
    if (path !== "/pagespeedonline/v5/runPagespeed") return json(404, {});
    const mobile = req.query.get("strategy") !== "desktop";
    return json(200, {
      loadingExperience: { overall_category: mobile ? "AVERAGE" : "FAST", metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: mobile ? 2900 : 1700 }, INTERACTION_TO_NEXT_PAINT: { percentile: mobile ? 240 : 90 }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 8 } } },
      lighthouseResult: { categories: { performance: { score: mobile ? 0.71 : 0.93 } }, audits: { "largest-contentful-paint": { numericValue: mobile ? 3400 : 1500 }, "cumulative-layout-shift": { numericValue: 0.06 }, "total-blocking-time": { numericValue: mobile ? 310 : 40 } } },
    });
  }

  private clarity(req: MockRequest, path: string): MockResponse {
    if (path !== "/export-data/api/v1/project-live-insights") return json(404, {});
    if (req.headers.authorization !== `Bearer ${this.cfg.clarityToken}`) return json(401, { message: "Unauthorized" });
    const urls = ["/", "/dental-implants", "/teeth-whitening"].map((p) => `${this.cfg.siteUrl}${p}`);
    return json(200, [
      { metricName: "Traffic", information: urls.map((Url, i) => ({ Url, totalSessionCount: String(120 - i * 30), distinctUserCount: String(100 - i * 25) })) },
      { metricName: "ScrollDepth", information: urls.map((Url, i) => ({ Url, averageScrollDepth: String(62 - i * 9) })) },
      { metricName: "RageClickCount", information: urls.map((Url, i) => ({ Url, sessionsWithMetricPercentage: String(i === 1 ? 7.5 : 1.2) })) },
      { metricName: "DeadClickCount", information: urls.map((Url, i) => ({ Url, sessionsWithMetricPercentage: String(i === 2 ? 9.1 : 2.4) })) },
    ]);
  }

  private dataforseo(req: MockRequest, path: string): MockResponse {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Basic ${Buffer.from(`${this.cfg.dataforseoLogin}:${this.cfg.dataforseoPassword}`).toString("base64")}`) {
      return json(401, { status_code: 40100, status_message: "You are not authorized to access this resource." });
    }
    const ok = (result: unknown[]) => json(200, { status_code: 20000, status_message: "Ok.", tasks: [{ status_code: 20000, status_message: "Ok.", result }] });
    if (path === "/v3/appendix/user_data") return ok([{ login: this.cfg.dataforseoLogin, money: { balance: 42.5 } }]);
    const payload = (JSON.parse(req.body || "[]") as Record<string, unknown>[])[0] ?? {};
    if (path === "/v3/keywords_data/google_ads/search_volume/live") {
      return ok((payload.keywords as string[] ?? []).map((k, i) => ({ keyword: k, search_volume: 100 + ((k.length * 137 + i * 53) % 4900), cpc: Math.round(((k.length % 7) + 0.5) * 100) / 100, competition_index: (k.length * 11) % 100 })));
    }
    if (path === "/v3/serp/google/organic/live/advanced") {
      const kw = String(payload.keyword ?? "");
      const r = rng([...kw].reduce((n, ch) => n * 31 + ch.charCodeAt(0), 7));
      const ours = r() > 0.3 ? 1 + Math.floor(r() * 15) : null;
      const items: unknown[] = [];
      for (let pos = 1; pos <= 20; pos++) {
        items.push(pos === ours
          ? { type: "organic", rank_group: pos, domain: new URL(this.cfg.siteUrl).hostname, url: `${this.cfg.siteUrl}/dental-implants` }
          : { type: "organic", rank_group: pos, domain: `competitor${pos}.example`, url: `https://competitor${pos}.example/${kw.replace(/\s+/g, "-")}` });
      }
      const cited = ours !== null && ours <= 5;
      items.unshift({ type: "ai_overview", references: [{ url: "https://competitor1.example/guide", domain: "competitor1.example" }, ...(cited ? [{ url: `${this.cfg.siteUrl}/dental-implants`, domain: new URL(this.cfg.siteUrl).hostname }] : [])] });
      return ok([{ keyword: kw, items }]);
    }
    return json(404, { status_code: 40400, status_message: "Not Found." });
  }

  private mixpanel(req: MockRequest, path: string): MockResponse {
    if (req.headers.authorization !== `Basic ${Buffer.from(`${this.cfg.mixpanelUsername}:${this.cfg.mixpanelSecret}`).toString("base64")}`) return json(401, { error: "Unauthorized" });
    if (path !== "/api/query/segmentation") return json(404, {});
    if (req.query.get("project_id") !== "1234567") return json(403, { error: "Project not accessible" });
    const from = new Date(`${req.query.get("from_date")}T00:00:00Z`), to = new Date(`${req.query.get("to_date")}T00:00:00Z`);
    const values: Record<string, Record<string, number>> = {};
    for (const [i, page] of ["/dental-implants", "/teeth-whitening", "/"].entries()) {
      values[page] = {};
      for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) values[page][d.toISOString().slice(0, 10)] = 3 - i + (d.getUTCDate() % 3);
    }
    return json(200, { data: { series: Object.keys(values["/"]), values }, legend_size: 3 });
  }

  /** Records executed statements so tests can check what an export wrote. */
  readonly statements: { statement: string; parameters: { name: string; value: string | null }[] }[] = [];
  private databricks(req: MockRequest, path: string): MockResponse {
    if (req.headers.authorization !== `Bearer ${this.cfg.databricksToken}`) return json(401, { error_code: "UNAUTHENTICATED", message: "Invalid access token." });
    if (path === "/__mock/statements") return json(200, { count: this.statements.length, inserts: this.statements.filter((x) => x.statement.startsWith("INSERT")).length, tables: [...new Set(this.statements.map((x) => /(?:INTO|EXISTS|FROM) \S+\.\S+\.(\w+)/.exec(x.statement)?.[1]).filter(Boolean))] });
    if (path !== "/api/2.0/sql/statements" || req.method !== "POST") return json(404, {});
    const b = JSON.parse(req.body || "{}") as { statement: string; parameters?: { name: string; value: string | null }[]; warehouse_id: string };
    if (b.warehouse_id !== "abcdef1234567890") return json(200, { status: { state: "FAILED", error: { message: "Warehouse not found" } } });
    this.statements.push({ statement: b.statement, parameters: b.parameters ?? [] });
    if (this.statements.length > 5000) this.statements.splice(0, 1000);
    return json(200, { statement_id: `stmt-${this.statements.length}`, status: { state: "SUCCEEDED" }, result: { data_array: /^SELECT 1/.test(b.statement) ? [["1"]] : [] } });
  }

  /** Messages received by the Slack, webhook and IndexNow mocks (inspect at /__mock/inbox). */
  readonly inbox: { slack: unknown[]; webhooks: { headers: Record<string, string | undefined>; body: string }[]; indexnow: unknown[] } = { slack: [], webhooks: [], indexnow: [] };

  private slack(req: MockRequest, path: string): MockResponse {
    if (req.method !== "POST" || !/^\/services\/[A-Za-z0-9_/-]+$/.test(path)) return { status: 404, body: "no_service", type: "text/plain" };
    if (path.includes("REVOKED")) return { status: 404, body: "no_active_hooks", type: "text/plain" };
    this.inbox.slack.push(JSON.parse(req.body || "{}"));
    return { status: 200, body: "ok", type: "text/plain" };
  }

  private indexnow(req: MockRequest, path: string): MockResponse {
    if (req.method !== "POST" || path !== "/indexnow") return json(404, {});
    const b = JSON.parse(req.body || "{}") as { host?: string; key?: string; keyLocation?: string; urlList?: string[] };
    if (!b.key || !/^[a-zA-Z0-9-]{8,128}$/.test(b.key)) return json(403, { message: "Key not valid" });
    if (!b.urlList?.length || b.urlList.some((u) => new URL(u).host !== b.host)) return json(422, { message: "URLs don't belong to the host" });
    this.inbox.indexnow.push(b);
    return { status: 202, body: "", type: "text/plain" };
  }

  private control(req: MockRequest, path: string): MockResponse {
    if (path === "/inbox") return json(200, this.inbox);
    if (path === "/webhook" && req.method === "POST") {
      this.inbox.webhooks.push({ headers: { "x-seohub-signature": req.headers["x-seohub-signature"], "x-seohub-timestamp": req.headers["x-seohub-timestamp"] }, body: req.body });
      return json(200, { received: true });
    }
    if (path === "/scenario" && req.method === "POST") {
      const b = JSON.parse(req.body || "{}") as Partial<typeof scenario>;
      if (b.demo === "normal" || b.demo === "regression") scenario.demo = b.demo;
      if ("trafficDrop" in b) scenario.trafficDrop = b.trafficDrop ?? null;
      return json(200, scenario);
    }
    return json(404, {});
  }

  private similarweb(req: MockRequest, path: string): MockResponse {
    if (req.headers["api-key"] !== this.cfg.similarwebKey) return json(401, { meta: { status: "Error", error_code: 401, error_message: "Invalid API key" } });
    const m = /^\/v1\/website\/([^/]+)\/total-traffic-and-engagement\/visits$/.exec(path);
    if (!m) return json(404, {});
    const start = new Date(`${req.query.get("start_date")}-01T00:00:00Z`), end = new Date(`${req.query.get("end_date")}-01T00:00:00Z`);
    const visits = [];
    for (let d = new Date(start), i = 0; d <= end; d.setUTCMonth(d.getUTCMonth() + 1), i++) visits.push({ date: d.toISOString().slice(0, 10), visits: 8000 + i * 650 });
    return json(200, { meta: { request: { domain: m[1] }, status: "Success" }, visits });
  }
}

/** Demo website with known issues: duplicate title, missing descriptions, noindex page, broken link, orphan page, blocked AI crawler. */
export function demoSite(path: string, origin: string): MockResponse {
  if (path === "/__mock/access.log") return { status: 200, type: "text/plain", body: sampleAccessLog() };
  if (path === "/robots.txt") return { status: 200, type: "text/plain", body: `User-agent: *\nDisallow: /wp-admin/\n\nUser-agent: GPTBot\nDisallow: /\n\nSitemap: ${origin}/sitemap.xml\n` };
  if (path === "/sitemap.xml") {
    const urls = DEMO_PAGES.filter((p) => !p.noindex).map((p) => `<url><loc>${origin}${p.path}</loc></url>`).join("");
    return { status: 200, type: "application/xml", body: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>` };
  }
  if (path === "/old-offer") return { status: 404, type: "text/html", body: "<html><head><title>Not found</title></head><body>Not found</body></html>" };
  // IndexNow key file: the demo site "hosts" any 32-hex-character key so it can be connected locally.
  const keyFile = /^\/([a-f0-9]{32})\.txt$/.exec(path);
  if (keyFile) return { status: 200, type: "text/plain", body: keyFile[1] };
  const broken = scenario.demo === "regression";
  if (broken && path === "/teeth-whitening") return { status: 500, type: "text/html", body: "<html><head><title>Error</title></head><body>Internal Server Error</body></html>" };
  const found = DEMO_PAGES.find((p) => p.path === path.replace(/(.)\/$/, "$1"));
  // "regression" release: implants page noindexed with its canonical pointing at the homepage, recovery post retitled.
  const page = found && broken && found.path === "/dental-implants" ? { ...found, noindex: true, canonical: "/" }
    : found && broken && found.path === "/blog/implant-recovery" ? { ...found, title: "Implant Recovery Timeline: Week by Week | Acme Dental" } : found;
  if (!page) return { status: 404, type: "text/html", body: "<html><head><title>Not found</title></head><body>Not found</body></html>" };
  const filler = Array.from({ length: Math.ceil(page.words / 20) }, (_, i) => `<p>Paragraph ${i + 1} about ${page.h1 ?? page.title} explaining treatment options, recovery, costs and what patients should ask before booking.</p>`).join("");
  const body = `<!doctype html><html><head><title>${page.title}</title>${page.description ? `<meta name="description" content="${page.description}">` : ""}${page.noindex ? '<meta name="robots" content="noindex">' : ""}<link rel="canonical" href="${origin}${"canonical" in page ? page.canonical : page.path}">${HREFLANG[page.path] ?? ""}${page.jsonld ? `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Dentist","name":"Acme Dental"}</script>` : ""}</head>
<body>${page.h1 ? `<h1>${page.h1}</h1>` : ""}<nav>${page.links.map((l) => `<a href="${l}">${l}</a>`).join(" ")}</nav>${filler}<img src="/team.jpg"></body></html>`;
  return { status: 200, type: "text/html", body };
}

/** Synthetic access log (combined format) with Googlebot, AI bots, users, redirects, 404s and parameter URLs. */
export function sampleAccessLog(days = 7, end = new Date()): string {
  const r = rng(42);
  const UA = {
    google: "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    gptbot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
    claude: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
    bing: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    user: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  };
  const paths: [string, number][] = [["/", 200], ["/dental-implants", 200], ["/teeth-whitening", 200], ["/blog", 200], ["/blog/implant-recovery", 200], ["/old-offer", 404],
    ["/blog?page=2", 200], ["/teeth-whitening?ref=nav", 200], ["/teeth-whitening?sort=price&color=white", 200], ["/promo", 301], ["/api/slots", 500], ["/main.css", 200]];
  const lines: string[] = [];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  for (let d = days - 1; d >= 0; d--) {
    const date = new Date(end.getTime() - d * 86_400_000);
    const stamp = `${String(date.getUTCDate()).padStart(2, "0")}/${mon[date.getUTCMonth()]}/${date.getUTCFullYear()}`;
    for (let i = 0; i < 60; i++) {
      const [path, status] = paths[Math.floor(r() * paths.length)];
      const who = r();
      const ua = who < 0.55 ? UA.google : who < 0.65 ? UA.gptbot : who < 0.72 ? UA.claude : who < 0.8 ? UA.bing : UA.user;
      const ip = ua === UA.google ? "66.249.66.1" : ua === UA.user ? "203.0.113.7" : "198.51.100.2";
      lines.push(`${ip} - - [${stamp}:${String(Math.floor(r() * 24)).padStart(2, "0")}:12:00 +0000] "GET ${path} HTTP/1.1" ${status} ${Math.floor(r() * 50000)} "-" "${ua}"`);
    }
  }
  return lines.join("\n") + "\nthis line is not a log line\n";
}
