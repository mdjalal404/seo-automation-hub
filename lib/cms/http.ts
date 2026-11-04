import type { PostPayload, SeoFieldName, SeoSyncState } from "@/lib/cms/types";
import { AppError } from "@/lib/errors";
import { logger, metric } from "@/lib/observability/logger";
import type { HttpClient, HttpRequest } from "@/lib/security/safe-fetch";

type Method = NonNullable<HttpRequest["method"]>;

/**
 * Shared JSON transport for the Webflow, Shopify and custom adapters: request spacing,
 * timeouts, metrics (route labels only, never URLs with secrets or headers) and a
 * uniform mapping of HTTP failures to CMS_* error codes.
 */
export class JsonTransport {
  private lastRequestAt = 0;

  constructor(
    private readonly opts: {
      platform: string;
      metricPrefix: string;
      http: HttpClient;
      headers: () => Record<string, string>;
      minIntervalMs?: number;
      timeoutMs?: number;
    },
  ) {}

  async request<T>(method: Method, url: string, body?: unknown, route = "request"): Promise<T> {
    const gap = this.opts.minIntervalMs ?? 250;
    const wait = this.lastRequestAt + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();

    const mutating = method !== "GET" && method !== "HEAD";
    const started = Date.now();
    let res;
    try {
      res = await this.opts.http(url, {
        method,
        timeoutMs: this.opts.timeoutMs ?? 20_000,
        headers: { accept: "application/json", ...this.opts.headers(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      metric(`${this.opts.metricPrefix}.request_failed`, 1, { method, route, reason: err instanceof AppError ? err.code : "unknown" });
      throw err;
    }
    metric(`${this.opts.metricPrefix}.request_ms`, Date.now() - started, { method, route, status: res.status });
    if (res.status >= 200 && res.status < 300) {
      if (res.status === 204 || !res.text) return {} as T;
      try {
        return JSON.parse(res.text) as T;
      } catch {
        throw new AppError("CMS_UNEXPECTED_RESPONSE", `${this.opts.platform} returned a non-JSON response.`, { retryable: mutating, ambiguous: mutating });
      }
    }
    throw mapCmsHttpError(this.opts.platform, res.status, res.text, res.headers, mutating);
  }
}

export function mapCmsHttpError(platform: string, status: number, text: string, headers: Record<string, string>, mutating: boolean): AppError {
  let message = "";
  try {
    const parsed = JSON.parse(text) as { message?: unknown; msg?: unknown; error?: unknown; errors?: unknown };
    const m = parsed.message ?? parsed.msg ?? parsed.error ?? (typeof parsed.errors === "string" ? parsed.errors : "");
    message = typeof m === "string" ? m.replace(/<[^>]+>/g, "").slice(0, 300) : "";
  } catch {
    /* non-JSON error body */
  }
  logger.warn("cms.error", { platform, status });
  if (status === 401) {
    return new AppError("CMS_AUTH_FAILED", `${platform} rejected the API token. It may be wrong, revoked or expired — reconnect the website.`, { status });
  }
  if (status === 403) {
    return new AppError("CMS_FORBIDDEN", `The ${platform} token is not allowed to do this${message ? `: ${message}` : ""}. Check the token's permissions/scopes.`, { status });
  }
  if (status === 404) return new AppError("CMS_NOT_FOUND", `${platform} could not find the requested resource${message ? `: ${message}` : ""}.`, { status });
  if (status === 429) {
    const ra = Number(headers["retry-after"]);
    return new AppError("CMS_RATE_LIMITED", `${platform} is rate limiting requests; will retry later.`, { status, retryable: true, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60_000 });
  }
  if (status >= 500) {
    return new AppError("CMS_SERVER_ERROR", `${platform} returned a server error (HTTP ${status}).`, { status, retryable: true, ambiguous: mutating });
  }
  return new AppError("CMS_BAD_REQUEST", `${platform} rejected the request${message ? `: ${message}` : ` (HTTP ${status})`}.`, { status });
}

/**
 * Builds SEO sync state by comparing what was sent with what the API echoed back.
 * `fields` maps each SEO field to the value echoed by the CMS, or to a note when the
 * platform cannot store it.
 */
export function seoSyncFromEcho(
  platform: string,
  payload: PostPayload,
  fields: Record<SeoFieldName, { sent: true; echoed: unknown } | { sent: false; note: string }>,
) {
  const values: Record<SeoFieldName, string> = {
    meta_title: payload.seo.metaTitle,
    meta_description: payload.seo.metaDescription,
    canonical_url: payload.seo.canonicalUrl,
  };
  const sync: SeoSyncState = {};
  const meta: Record<string, string> = {};
  for (const field of Object.keys(values) as SeoFieldName[]) {
    const value = values[field];
    if (!value) continue;
    const f = fields[field];
    if (!f.sent) {
      sync[field] = { stored: true, sent: false, confirmed: false, verified: null, note: f.note };
      continue;
    }
    meta[field] = value;
    const confirmed = String(f.echoed ?? "") === value;
    sync[field] = { stored: true, sent: true, confirmed, verified: null, note: confirmed ? undefined : `${platform} did not echo back the value that was sent.` };
  }
  const unsent = Object.entries(sync).filter(([, s]) => s && !s.sent).map(([f]) => f);
  const warnings = unsent.length ? [`SEO fields not saved to ${platform}: ${unsent.join(", ")}.`] : [];
  return { meta, sync, warnings };
}

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateCorePayload(p: PostPayload) {
  if (!p.title.trim()) throw new AppError("INVALID_INPUT", "A post title is required.");
  if (!SLUG_RE.test(p.slug)) throw new AppError("INVALID_INPUT", "The slug is invalid.");
  if (!p.contentHtml.trim()) throw new AppError("INVALID_INPUT", "The post body is empty.");
}

export function joinUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
