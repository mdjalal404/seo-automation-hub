/**
 * DEVELOPMENT/TEST ONLY — shared plumbing for the in-memory CMS mocks (Webflow,
 * Shopify, custom CMS). Never imported by application code.
 */
import { AppError } from "../../lib/errors";
import type { MockFault } from "../mock-wordpress/core";

export type { MockFault };
export type MockResponse = { status: number; headers: Record<string, string>; text: string };

export function json(status: number, data: unknown): MockResponse {
  return { status, headers: { "content-type": "application/json" }, text: JSON.stringify(data) };
}

export function html(status: number, body: string): MockResponse {
  return { status, headers: { "content-type": "text/html; charset=utf-8" }, text: body };
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function page(opts: { title: string; description?: string; canonical: string; h1: string; body: string; site: string }) {
  return html(200, `<!doctype html><html><head><title>${esc(opts.title)}</title>
${opts.description ? `<meta name="description" content="${esc(opts.description)}">` : ""}<link rel="canonical" href="${esc(opts.canonical)}"></head>
<body><header>${esc(opts.site)}</header><article><h1>${esc(opts.h1)}</h1><div class="content">${opts.body}</div></article></body></html>`);
}

export const notFoundPage = () => html(404, "<html><head><title>Page not found</title></head><body><h1>Not found</h1></body></html>");

/** Base class: fault injection, request log and HttpClient adapter. */
export abstract class MockCms {
  faults: MockFault[] = [];
  requests: { method: string; path: string }[] = [];
  /** Override the rendered page (e.g. to simulate a template that drops content). */
  renderOverride?: (item: { title: string }) => string | null;

  abstract readonly origin: string;
  protected abstract route(method: string, url: URL, headers: Record<string, string>, body?: string): Promise<MockResponse> | MockResponse;
  /** The string fault paths are matched against (defaults to the URL path). */
  protected faultKey(url: URL, body?: string): string {
    void body;
    return url.pathname;
  }

  addFault(f: MockFault) {
    this.faults.push({ times: 1, ...f });
  }

  async handle(method: string, rawUrl: string, headers: Record<string, string> = {}, body?: string): Promise<MockResponse> {
    const url = new URL(rawUrl);
    const key = this.faultKey(url, body);
    this.requests.push({ method, path: key });
    const i = this.faults.findIndex((f) => (!f.method || f.method === method) && (!f.path || f.path.test(key)) && (f.times ?? 1) > 0);
    const fault = i >= 0 ? this.faults[i] : null;
    if (fault) fault.times = (fault.times ?? 1) - 1;
    if (fault?.timeout) {
      if (fault.timeout.applied) await this.route(method, url, lower(headers), body);
      throw new AppError("TIMEOUT", "The website did not respond in time.", { retryable: true, ambiguous: method !== "GET" });
    }
    if (fault?.status) return json(fault.status, fault.body ? JSON.parse(fault.body) : { message: "Injected fault" });
    return this.route(method, url, lower(headers), body);
  }

  asHttpClient() {
    return async (url: string, req: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
      const res = await this.handle(req.method ?? "GET", url, req.headers ?? {}, req.body);
      return { ...res, url };
    };
  }
}

function lower(h: Record<string, string>) {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

export function hexId(n: number) {
  return n.toString(16).padStart(24, "0");
}
