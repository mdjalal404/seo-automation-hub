import { createSign } from "node:crypto";
import { z } from "zod";
import { appEnvironment } from "@/lib/env";
import { AppError } from "@/lib/errors";
import type { HttpClient, HttpResponse } from "@/lib/security/safe-fetch";

/**
 * Analytics/SEO data connectors. Each provider is a thin, typed client over the vendor's
 * documented REST API with errors mapped to AppError (401/403 → auth, 429 → rate limited).
 * Credentials are passed in already decrypted and never logged or returned.
 */
export const PROVIDERS = ["google_search_console", "google_analytics_4", "microsoft_clarity", "dataforseo", "similarweb", "pagespeed", "mixpanel", "databricks", "slack", "webhook", "indexnow"] as const;
export type ProviderId = (typeof PROVIDERS)[number];
/** Integrations that deliver alerts or submit URLs rather than pull data. */
export const OUTBOUND_PROVIDERS: readonly ProviderId[] = ["slack", "webhook", "indexnow"];

export const PROVIDER_INFO: Record<ProviderId, { label: string; secretLabel: string; help: string; docs: string }> = {
  google_search_console: {
    label: "Google Search Console", secretLabel: "Service account key (JSON)",
    help: "Create a Google Cloud service account, enable the Search Console API, download a JSON key, and add the service account's email as a user (Restricted is enough) on the Search Console property.",
    docs: "https://developers.google.com/webmaster-tools/v1/how-tos/authorizing",
  },
  google_analytics_4: {
    label: "Google Analytics 4", secretLabel: "Service account key (JSON)",
    help: "Enable the Google Analytics Data API for the service account's project and add its email as a Viewer on the GA4 property. Enter the numeric property ID.",
    docs: "https://developers.google.com/analytics/devguides/reporting/data/v1",
  },
  microsoft_clarity: {
    label: "Microsoft Clarity", secretLabel: "Data export API token",
    help: "In Clarity → Settings → Data Export, generate an API token. Clarity's API returns the last 1–3 days and allows 10 requests per project per day, so sync daily.",
    docs: "https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api",
  },
  dataforseo: {
    label: "DataForSEO", secretLabel: "API password",
    help: "Use your DataForSEO API login and API password (from the dashboard, not your account password). Used for search volume, rank tracking and Google AI Overview citations. Calls are billed by DataForSEO.",
    docs: "https://docs.dataforseo.com/v3/",
  },
  similarweb: {
    label: "Similarweb", secretLabel: "API key",
    help: "Requires a Similarweb plan with API access. Monthly traffic and engagement estimates for the domain.",
    docs: "https://developers.similarweb.com/docs/similarweb-web-traffic-api",
  },
  pagespeed: {
    label: "PageSpeed Insights", secretLabel: "API key (optional but recommended)",
    help: "Google PageSpeed Insights API key for Core Web Vitals (field data from CrUX and Lighthouse lab data). Create it in Google Cloud → APIs & Services → Credentials.",
    docs: "https://developers.google.com/speed/docs/insights/v5/get-started",
  },
  mixpanel: {
    label: "Mixpanel", secretLabel: "Service account secret",
    help: "Create a Mixpanel service account (Organization settings → Service accounts) with access to the project. Choose the conversion event and the property that holds the landing page; optionally filter to organic traffic.",
    docs: "https://developer.mixpanel.com/reference/segmentation-query",
  },
  databricks: {
    label: "Databricks (warehouse export)", secretLabel: "Personal access or service principal token",
    help: "Exports modeled SEO data (Search Console, traffic, keywords, audits) to Delta tables in your catalog/schema through a SQL warehouse. The token needs CAN USE on the warehouse and CREATE TABLE/MODIFY on the schema.",
    docs: "https://docs.databricks.com/api/workspace/statementexecution",
  },
  slack: {
    label: "Slack alerts", secretLabel: "Incoming webhook URL",
    help: "Create a Slack app with an incoming webhook for the channel that should receive SEO alerts, then paste the webhook URL. Saving sends a short test message to that channel.",
    docs: "https://api.slack.com/messaging/webhooks",
  },
  webhook: {
    label: "Webhook alerts", secretLabel: "Endpoint URL and signing secret",
    help: "Alerts are POSTed as JSON to your endpoint (PagerDuty, Opsgenie, Zapier, your own service). Each request carries X-SEOHub-Timestamp and X-SEOHub-Signature: sha256=HMAC(secret, timestamp + \".\" + body). Saving sends a test event.",
    docs: "https://en.wikipedia.org/wiki/HMAC",
  },
  indexnow: {
    label: "IndexNow", secretLabel: "IndexNow key",
    help: "Notifies Bing, Yandex, Seznam, Naver and other IndexNow engines when pages are published or change. Google does not use IndexNow. Host a text file named <key>.txt containing the key at the site root; saving checks that the file is there.",
    docs: "https://www.indexnow.org/documentation",
  },
};

export function isProvider(v: unknown): v is ProviderId {
  return typeof v === "string" && (PROVIDERS as readonly string[]).includes(v);
}

/**
 * Endpoint overrides for the local mock (npm run mock:analytics). Ignored in production so a
 * stray variable can never send real credentials to another host.
 */
export function base(real: string): string {
  const mock = appEnvironment() === "production" ? undefined : process.env.ANALYTICS_API_BASE_URL;
  return mock ? `${mock.replace(/\/$/, "")}/${new URL(real).hostname}` : real;
}

export const ENDPOINTS = {
  googleToken: () => base("https://oauth2.googleapis.com") + "/token",
  gsc: () => base("https://searchconsole.googleapis.com"),
  ga4: () => base("https://analyticsdata.googleapis.com"),
  clarity: () => base("https://www.clarity.ms"),
  dataforseo: () => base("https://api.dataforseo.com"),
  similarweb: () => base("https://api.similarweb.com"),
  pagespeed: () => base("https://www.googleapis.com"),
  slack: () => base("https://hooks.slack.com"),
  indexnow: () => base("https://api.indexnow.org"),
};

export function mapProviderError(label: string, res: HttpResponse): AppError {
  const retryAfter = Number(res.headers["retry-after"]);
  if (res.status === 401) return new AppError("CMS_AUTH_FAILED", `${label} rejected the credentials.`, { status: 401 });
  if (res.status === 403) return new AppError("CMS_FORBIDDEN", `${label} denied access. Check that the account has permission for this property.`, { status: 403 });
  if (res.status === 404) return new AppError("NOT_FOUND", `${label} could not find this property/site. Check the ID or URL.`, { status: 404 });
  if (res.status === 429) return new AppError("RATE_LIMITED", `${label} rate limit reached. The next scheduled sync will try again.`, { status: 429, retryable: true, retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : 60_000 });
  if (res.status >= 500) return new AppError("NETWORK_ERROR", `${label} is temporarily unavailable (${res.status}).`, { status: res.status, retryable: true });
  return new AppError("INVALID_INPUT", `${label} rejected the request (${res.status}).`, { status: res.status });
}

function json<T>(label: string, res: HttpResponse): T {
  if (res.status < 200 || res.status >= 300) throw mapProviderError(label, res);
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new AppError("CMS_UNEXPECTED_RESPONSE", `${label} returned an unexpected response.`);
  }
}

// ---------------------------------------------------------------------------
// Google service-account auth (OAuth 2.0 JWT bearer grant, RFC 7523)
// ---------------------------------------------------------------------------
export const serviceAccountSchema = z.object({
  type: z.literal("service_account", { message: "This is not a service account key (type must be service_account)." }),
  client_email: z.email(),
  private_key: z.string().includes("PRIVATE KEY", { message: "The key file has no private key." }),
  private_key_id: z.string().optional(),
});
export type ServiceAccount = z.infer<typeof serviceAccountSchema>;

export function parseServiceAccount(raw: string): ServiceAccount {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new AppError("INVALID_INPUT", "The service account key must be the JSON file downloaded from Google Cloud.");
  }
  const r = serviceAccountSchema.safeParse(data);
  if (!r.success) throw new AppError("INVALID_INPUT", r.error.issues[0]?.message ?? "Invalid service account key.");
  return r.data;
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export async function googleAccessToken(http: HttpClient, sa: ServiceAccount, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  let signature: string;
  try {
    signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(sa.private_key, "base64url");
  } catch {
    throw new AppError("INVALID_INPUT", "The service account private key could not be read.");
  }
  const res = await http(ENDPOINTS.googleToken(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${signature}` }).toString(),
  });
  if (res.status === 400 || res.status === 401) throw new AppError("CMS_AUTH_FAILED", "Google rejected the service account key (it may have been deleted or disabled).");
  const body = json<{ access_token?: string }>("Google", res);
  if (!body.access_token) throw new AppError("CMS_UNEXPECTED_RESPONSE", "Google did not return an access token.");
  return body.access_token;
}

const SCOPES = {
  gsc: "https://www.googleapis.com/auth/webmasters.readonly",
  ga4: "https://www.googleapis.com/auth/analytics.readonly",
};

// ---------------------------------------------------------------------------
// Google Search Console
// ---------------------------------------------------------------------------
export type GscRow = { date: string; query: string; page: string; clicks: number; impressions: number; ctr: number; position: number };

export async function gscListSites(http: HttpClient, sa: ServiceAccount): Promise<string[]> {
  const token = await googleAccessToken(http, sa, SCOPES.gsc);
  const res = await http(`${ENDPOINTS.gsc()}/webmasters/v3/sites`, { headers: { authorization: `Bearer ${token}` } });
  const body = json<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>("Search Console", res);
  return (body.siteEntry ?? []).filter((s) => s.permissionLevel !== "siteUnverifiedUser").map((s) => s.siteUrl);
}

export async function gscQuery(http: HttpClient, sa: ServiceAccount, siteUrl: string, startDate: string, endDate: string, maxRows = 25_000): Promise<GscRow[]> {
  const token = await googleAccessToken(http, sa, SCOPES.gsc);
  const rows: GscRow[] = [];
  for (let startRow = 0; startRow < maxRows; startRow += 25_000) {
    const res = await http(`${ENDPOINTS.gsc()}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ startDate, endDate, dimensions: ["date", "query", "page"], rowLimit: Math.min(25_000, maxRows - startRow), startRow, dataState: "final" }),
      maxBytes: 50 * 1024 * 1024,
      timeoutMs: 60_000,
    });
    const body = json<{ rows?: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[] }>("Search Console", res);
    const page = body.rows ?? [];
    rows.push(...page.map((r) => ({ date: r.keys[0], query: r.keys[1], page: r.keys[2], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })));
    if (page.length < 25_000) break;
  }
  return rows;
}

export type UrlInspection = { url: string; verdict: string; coverageState: string; indexingState?: string; lastCrawlTime?: string; googleCanonical?: string; robotsTxtState?: string };

export async function gscInspectUrl(http: HttpClient, sa: ServiceAccount, siteUrl: string, url: string): Promise<UrlInspection> {
  const token = await googleAccessToken(http, sa, SCOPES.gsc);
  const res = await http(`${ENDPOINTS.gsc()}/v1/urlInspection/index:inspect`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ inspectionUrl: url, siteUrl }),
  });
  const body = json<{ inspectionResult?: { indexStatusResult?: Record<string, string> } }>("Search Console URL Inspection", res);
  const r = body.inspectionResult?.indexStatusResult ?? {};
  return { url, verdict: r.verdict ?? "VERDICT_UNSPECIFIED", coverageState: r.coverageState ?? "Unknown", indexingState: r.indexingState, lastCrawlTime: r.lastCrawlTime, googleCanonical: r.googleCanonical, robotsTxtState: r.robotsTxtState };
}

// ---------------------------------------------------------------------------
// Google Analytics 4 (Data API)
// ---------------------------------------------------------------------------
export type Ga4Row = { date: string; page: string; sessions: number; users: number; engagedSessions: number; conversions: number; bounceRate: number };

export async function ga4OrganicReport(http: HttpClient, sa: ServiceAccount, propertyId: string, startDate: string, endDate: string): Promise<Ga4Row[]> {
  if (!/^\d{4,15}$/.test(propertyId)) throw new AppError("INVALID_INPUT", "The GA4 property ID is the number shown in Admin → Property details.");
  const token = await googleAccessToken(http, sa, SCOPES.ga4);
  const res = await http(`${ENDPOINTS.ga4()}/v1beta/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "date" }, { name: "landingPagePlusQueryString" }],
      metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "engagedSessions" }, { name: "keyEvents" }, { name: "bounceRate" }],
      dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { value: "Organic Search" } } },
      limit: 100_000,
    }),
    maxBytes: 50 * 1024 * 1024,
    timeoutMs: 60_000,
  });
  const body = json<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>("Google Analytics", res);
  return (body.rows ?? []).map((r) => {
    const d = r.dimensionValues[0].value;
    const m = r.metricValues.map((v) => Number(v.value) || 0);
    return { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, page: r.dimensionValues[1].value, sessions: m[0], users: m[1], engagedSessions: m[2], conversions: m[3], bounceRate: m[4] };
  });
}

// ---------------------------------------------------------------------------
// Microsoft Clarity (Data Export API)
// ---------------------------------------------------------------------------
export type ClarityRow = { page: string; metric: string; values: Record<string, number> };

export async function clarityInsights(http: HttpClient, token: string, days: 1 | 2 | 3 = 1): Promise<ClarityRow[]> {
  const res = await http(`${ENDPOINTS.clarity()}/export-data/api/v1/project-live-insights?numOfDays=${days}&dimension1=URL`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const body = json<{ metricName: string; information: Record<string, string | number>[] }[]>("Microsoft Clarity", res);
  const out: ClarityRow[] = [];
  for (const metric of Array.isArray(body) ? body : []) {
    for (const info of metric.information ?? []) {
      const page = String(info.Url ?? info.URL ?? "");
      const values = Object.fromEntries(Object.entries(info).filter(([k]) => k !== "Url" && k !== "URL").map(([k, v]) => [k, Number(v) || 0]));
      out.push({ page, metric: metric.metricName, values });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// DataForSEO
// ---------------------------------------------------------------------------
export type DfsCredentials = { login: string; password: string };
type DfsEnvelope<T> = { status_code: number; status_message: string; tasks?: { status_code: number; status_message: string; result: T[] | null }[] };

async function dfs<T>(http: HttpClient, c: DfsCredentials, path: string, payload: unknown[]): Promise<T[]> {
  const res = await http(`${ENDPOINTS.dataforseo()}/v3/${path}`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${c.login}:${c.password}`).toString("base64")}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
    timeoutMs: 120_000,
    maxBytes: 50 * 1024 * 1024,
  });
  const body = json<DfsEnvelope<T>>("DataForSEO", res);
  if (body.status_code === 40100 || body.status_code === 40101) throw new AppError("CMS_AUTH_FAILED", "DataForSEO rejected the login or API password.");
  if (body.status_code === 40200 || body.status_code === 40210) throw new AppError("CMS_FORBIDDEN", "DataForSEO: insufficient account balance.");
  if (body.status_code !== 20000) throw new AppError("INVALID_INPUT", `DataForSEO: ${body.status_message.slice(0, 200)}`);
  const task = body.tasks?.[0];
  if (!task || task.status_code !== 20000) throw new AppError("INVALID_INPUT", `DataForSEO: ${(task?.status_message ?? "task failed").slice(0, 200)}`);
  return task.result ?? [];
}

export async function dfsUserData(http: HttpClient, c: DfsCredentials): Promise<{ login: string; balance: number | null }> {
  const res = await http(`${ENDPOINTS.dataforseo()}/v3/appendix/user_data`, { headers: { authorization: `Basic ${Buffer.from(`${c.login}:${c.password}`).toString("base64")}` } });
  const body = json<DfsEnvelope<{ login: string; money?: { balance?: number } }>>("DataForSEO", res);
  if (body.status_code !== 20000) throw new AppError("CMS_AUTH_FAILED", "DataForSEO rejected the login or API password.");
  const r = body.tasks?.[0]?.result?.[0];
  return { login: r?.login ?? c.login, balance: r?.money?.balance ?? null };
}

export type KeywordVolume = { keyword: string; searchVolume: number | null; cpc: number | null; competition: number | null };

export async function dfsSearchVolume(http: HttpClient, c: DfsCredentials, keywords: string[], locationCode = 2840, languageCode = "en"): Promise<KeywordVolume[]> {
  const result = await dfs<{ keyword: string; search_volume: number | null; cpc: number | null; competition_index: number | null }>(http, c, "keywords_data/google_ads/search_volume/live", [
    { keywords: keywords.slice(0, 1000), location_code: locationCode, language_code: languageCode },
  ]);
  return result.map((r) => ({ keyword: r.keyword.toLowerCase(), searchVolume: r.search_volume, cpc: r.cpc, competition: r.competition_index }));
}

export type SerpResult = { keyword: string; position: number | null; url: string | null; topUrls: string[]; aiOverview: { present: boolean; cited: boolean; references: string[] } };

/** Live Google SERP for one keyword: our rank, top-10 URLs (for clustering) and AI Overview citations. */
export async function dfsSerp(http: HttpClient, c: DfsCredentials, keyword: string, domain: string, locationCode = 2840, languageCode = "en"): Promise<SerpResult> {
  type Item = { type: string; rank_group?: number; url?: string; domain?: string; references?: { url?: string; domain?: string }[]; items?: Item[] };
  const result = await dfs<{ items?: Item[] }>(http, c, "serp/google/organic/live/advanced", [
    { keyword, location_code: locationCode, language_code: languageCode, depth: 100, load_async_ai_overview: true },
  ]);
  const items = result[0]?.items ?? [];
  const host = domain.replace(/^www\./, "").toLowerCase();
  const isOurs = (d?: string, u?: string) => {
    const h = (d ?? (u ? safeHost(u) : "") ?? "").replace(/^www\./, "").toLowerCase();
    return !!h && (h === host || h.endsWith(`.${host}`));
  };
  const organic = items.filter((i) => i.type === "organic");
  const ours = organic.find((i) => isOurs(i.domain, i.url));
  const overview = items.find((i) => i.type === "ai_overview");
  const refs = [...(overview?.references ?? []), ...(overview?.items ?? []).flatMap((i) => i.references ?? [])];
  return {
    keyword,
    position: ours?.rank_group ?? null,
    url: ours?.url ?? null,
    topUrls: organic.slice(0, 10).map((i) => i.url!).filter(Boolean),
    aiOverview: { present: !!overview, cited: refs.some((r) => isOurs(r.domain, r.url)), references: refs.map((r) => r.url!).filter(Boolean).slice(0, 20) },
  };
}

function safeHost(u: string) {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Similarweb
// ---------------------------------------------------------------------------
export type SimilarwebMonth = { date: string; visits: number; bounceRate: number | null; pagesPerVisit: number | null; avgVisitDuration: number | null };

export async function similarwebTraffic(http: HttpClient, apiKey: string, domain: string, startMonth: string, endMonth: string): Promise<SimilarwebMonth[]> {
  const d = domain.replace(/^www\./, "");
  const q = new URLSearchParams({ start_date: startMonth, end_date: endMonth, country: "world", granularity: "monthly", main_domain_only: "false", format: "json" });
  const res = await http(`${ENDPOINTS.similarweb()}/v1/website/${encodeURIComponent(d)}/total-traffic-and-engagement/visits?${q}`, { headers: { "api-key": apiKey } });
  const body = json<{ visits?: { date: string; visits: number }[] }>("Similarweb", res);
  return (body.visits ?? []).map((v) => ({ date: v.date.slice(0, 10), visits: Math.round(v.visits), bounceRate: null, pagesPerVisit: null, avgVisitDuration: null }));
}

// ---------------------------------------------------------------------------
// PageSpeed Insights (Core Web Vitals)
// ---------------------------------------------------------------------------
export type WebVitals = {
  url: string; strategy: "mobile" | "desktop"; performanceScore: number | null;
  field: { lcpMs: number | null; inpMs: number | null; cls: number | null; category: string | null };
  lab: { lcpMs: number | null; cls: number | null; tbtMs: number | null };
};

export async function pagespeed(http: HttpClient, apiKey: string | null, url: string, strategy: "mobile" | "desktop" = "mobile"): Promise<WebVitals> {
  const q = new URLSearchParams({ url, strategy, category: "performance" });
  const res = await http(`${ENDPOINTS.pagespeed()}/pagespeedonline/v5/runPagespeed?${q}`, { headers: apiKey ? { "x-goog-api-key": apiKey } : {}, timeoutMs: 90_000, maxBytes: 20 * 1024 * 1024 });
  type Metric = { percentile?: number; category?: string };
  const body = json<{
    loadingExperience?: { overall_category?: string; metrics?: Record<string, Metric> };
    lighthouseResult?: { categories?: { performance?: { score?: number } }; audits?: Record<string, { numericValue?: number }> };
  }>("PageSpeed Insights", res);
  const m = body.loadingExperience?.metrics ?? {};
  const a = body.lighthouseResult?.audits ?? {};
  const score = body.lighthouseResult?.categories?.performance?.score;
  return {
    url, strategy,
    performanceScore: typeof score === "number" ? Math.round(score * 100) : null,
    field: {
      lcpMs: m.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? null,
      inpMs: m.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
      cls: m.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile != null ? m.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100 : null,
      category: body.loadingExperience?.overall_category ?? null,
    },
    lab: { lcpMs: a["largest-contentful-paint"]?.numericValue ?? null, cls: a["cumulative-layout-shift"]?.numericValue ?? null, tbtMs: a["total-blocking-time"]?.numericValue ?? null },
  };
}

// ---------------------------------------------------------------------------
// Mixpanel (Query API, service account)
// ---------------------------------------------------------------------------
export type MixpanelCredentials = { username: string; secret: string; projectId: string; region: "us" | "eu" | "in" };
export type MixpanelRow = { date: string; segment: string; count: number };

const mixpanelHost = (region: MixpanelCredentials["region"]) => (region === "eu" ? "https://eu.mixpanel.com" : region === "in" ? "https://in.mixpanel.com" : "https://mixpanel.com");

/**
 * Daily counts of one event segmented by a property (e.g. landing page), optionally filtered
 * with a Mixpanel `where` expression such as `properties["utm_medium"] == "organic"`.
 */
export async function mixpanelSegmentation(http: HttpClient, c: MixpanelCredentials, q: { event: string; on: string; where?: string; from: string; to: string }): Promise<MixpanelRow[]> {
  const params = new URLSearchParams({ project_id: c.projectId, event: q.event, from_date: q.from, to_date: q.to, unit: "day", on: `properties[${JSON.stringify(q.on)}]`, limit: "500" });
  if (q.where) params.set("where", q.where);
  const base = appEnvironment() === "production" || !process.env.ANALYTICS_API_BASE_URL ? mixpanelHost(c.region) : `${process.env.ANALYTICS_API_BASE_URL.replace(/\/$/, "")}/mixpanel.com`;
  const res = await http(`${base}/api/query/segmentation?${params}`, { headers: { authorization: `Basic ${Buffer.from(`${c.username}:${c.secret}`).toString("base64")}` }, timeoutMs: 60_000 });
  const body = json<{ data?: { series?: string[]; values?: Record<string, Record<string, number>> } }>("Mixpanel", res);
  const out: MixpanelRow[] = [];
  for (const [segment, byDate] of Object.entries(body.data?.values ?? {})) for (const [date, count] of Object.entries(byDate)) out.push({ date: date.slice(0, 10), segment, count });
  return out;
}

// ---------------------------------------------------------------------------
// Databricks (SQL Statement Execution API) — warehouse export
// ---------------------------------------------------------------------------
export type DatabricksCredentials = { host: string; token: string; warehouseId: string; catalog: string; schema: string };
const DBX_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(cloud\.databricks\.com|azuredatabricks\.net|gcp\.databricks\.com)$/i;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function validateDatabricks(c: DatabricksCredentials): DatabricksCredentials {
  const host = c.host.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  if (!DBX_HOST.test(host) && !(appEnvironment() !== "production" && process.env.ANALYTICS_API_BASE_URL)) {
    throw new AppError("INVALID_INPUT", "Enter your Databricks workspace host, e.g. dbc-1234.cloud.databricks.com.");
  }
  if (!IDENT.test(c.catalog) || !IDENT.test(c.schema)) throw new AppError("INVALID_INPUT", "Catalog and schema must be plain identifiers (letters, digits, underscore).");
  if (!/^[a-f0-9]{8,32}$/i.test(c.warehouseId)) throw new AppError("INVALID_INPUT", "Enter the SQL warehouse ID (Warehouse → Connection details).");
  return { ...c, host };
}

type DbxParam = { name: string; value: string | null; type?: "STRING" | "INT" | "DOUBLE" | "DATE" };

export async function databricksSql(http: HttpClient, c: DatabricksCredentials, statement: string, parameters: DbxParam[] = []): Promise<{ state: string; rows: unknown[][] }> {
  const base = appEnvironment() === "production" || !process.env.ANALYTICS_API_BASE_URL ? `https://${c.host}` : `${process.env.ANALYTICS_API_BASE_URL.replace(/\/$/, "")}/databricks`;
  const res = await http(`${base}/api/2.0/sql/statements`, {
    method: "POST",
    headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
    body: JSON.stringify({ warehouse_id: c.warehouseId, statement, parameters, wait_timeout: "50s", on_wait_timeout: "CANCEL", format: "JSON_ARRAY", disposition: "INLINE" }),
    timeoutMs: 60_000,
  });
  const body = json<{ status?: { state: string; error?: { message?: string } }; result?: { data_array?: unknown[][] } }>("Databricks", res);
  const state = body.status?.state ?? "UNKNOWN";
  if (state !== "SUCCEEDED") throw new AppError("INVALID_INPUT", `Databricks statement ${state.toLowerCase()}: ${(body.status?.error?.message ?? "").slice(0, 200)}`, { retryable: state === "CANCELED" });
  return { state, rows: body.result?.data_array ?? [] };
}
