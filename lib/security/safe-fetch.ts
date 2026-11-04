import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import { allowPrivateNetworkTargets } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { assertSafeTarget, isPrivateAddress } from "@/lib/security/url";

export type HttpRequest = {
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
};

export type HttpResponse = {
  status: number;
  url: string;
  headers: Record<string, string>;
  text: string;
};

/** Minimal HTTP abstraction so adapters can be tested with deterministic fakes. */
export type HttpClient = (url: string, req?: HttpRequest) => Promise<HttpResponse>;

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * DNS lookup that refuses private addresses at connect time. Validating inside the
 * socket's lookup (not before fetch) closes the DNS-rebinding gap.
 */
function guardedLookup(allowPrivate: boolean) {
  return (
    hostname: string,
    options: { all?: boolean; family?: number } | number,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    const opts = typeof options === "number" ? { family: options } : options;
    dnsLookup(hostname, { all: true, family: opts.family ?? 0 }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const list = addresses as LookupAddress[];
      const allowed = allowPrivate ? list : list.filter((a) => !isPrivateAddress(a.address));
      if (allowed.length === 0) {
        const e = new Error("Destination resolves to a private or reserved address") as NodeJS.ErrnoException;
        e.code = "EUNSAFEADDR";
        return callback(e, "", 0);
      }
      if (opts.all) return callback(null, allowed);
      callback(null, allowed[0].address, allowed[0].family);
    });
  };
}

let agents: { strict?: Agent; dev?: Agent } = {};
function agentFor(allowPrivate: boolean): Agent {
  const key = allowPrivate ? "dev" : "strict";
  agents[key] ??= new Agent({
    connect: { lookup: guardedLookup(allowPrivate) as never, timeout: 10_000 },
    headersTimeout: 20_000,
    bodyTimeout: 20_000,
  });
  return agents[key]!;
}

export function resetAgentsForTests() {
  agents = {};
}

/**
 * SSRF-hardened fetch used for every request to a customer website:
 * scheme/host/port policy, connect-time IP checks, manual redirect validation
 * (Authorization dropped on cross-origin hops), timeouts and response size limits.
 */
export const safeFetch: HttpClient = async (rawUrl, req = {}) => {
  const allowPrivate = allowPrivateNetworkTargets();
  const method = req.method ?? "GET";
  const mutating = method !== "GET" && method !== "HEAD";
  const maxRedirects = mutating ? 0 : (req.maxRedirects ?? 3);
  let url = assertSafeTarget(rawUrl, { allowPrivate });
  const originalOrigin = url.origin;
  let headers: Record<string, string> = { "user-agent": "SEOAutomationHub/1.0 (+publishing verification)", ...(req.headers ?? {}) };

  for (let hop = 0; ; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT);
    try {
      const res = await undiciFetch(url, {
        method,
        headers,
        body: req.body,
        redirect: "manual",
        signal: controller.signal,
        dispatcher: agentFor(allowPrivate),
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel();
        if (hop >= maxRedirects) {
          throw new AppError(
            "WP_UNEXPECTED_RESPONSE",
            mutating ? "The site redirected a write request; check the website URL (http vs https, www)." : "Too many redirects.",
          );
        }
        const next = assertSafeTarget(new URL(res.headers.get("location")!, url), { allowPrivate });
        if (url.protocol === "https:" && next.protocol === "http:") throw new AppError("UNSAFE_URL", "Refusing to follow a redirect from HTTPS to HTTP.");
        if (next.origin !== originalOrigin) {
          headers = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== "authorization"));
        }
        url = next;
        continue;
      }
      const text = await readLimited(res, req.maxBytes ?? DEFAULT_MAX_BYTES);
      const outHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => (outHeaders[k] = v));
      return { status: res.status, url: url.toString(), headers: outHeaders, text };
    } catch (err) {
      throw normalizeFetchError(err, mutating);
    } finally {
      clearTimeout(timer);
    }
  }
};

async function readLimited(res: Awaited<ReturnType<typeof undiciFetch>>, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new AppError("RESPONSE_TOO_LARGE", "The response was larger than allowed.");
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AppError("RESPONSE_TOO_LARGE", "The response was larger than allowed.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizeFetchError(err: unknown, mutating: boolean): AppError {
  if (err instanceof AppError) return err;
  const e = err as { name?: string; code?: string; cause?: { code?: string } };
  const code = e.cause?.code ?? e.code;
  if (e.name === "AbortError" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
    return new AppError("TIMEOUT", "The website did not respond in time.", { retryable: true, ambiguous: mutating, cause: err });
  }
  if (code === "EUNSAFEADDR") return new AppError("UNSAFE_URL", "The website resolves to a private or reserved network address.");
  // These fail before any request bytes are sent, so they are never ambiguous.
  const preSend = ["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID"];
  if (code === "ENOTFOUND") return new AppError("NETWORK_ERROR", "The website's domain could not be found.", { retryable: false, cause: err });
  if (code && code.startsWith("CERT") || code === "ERR_TLS_CERT_ALTNAME_INVALID" || code === "DEPTH_ZERO_SELF_SIGNED_CERT") {
    return new AppError("NETWORK_ERROR", "The website's TLS certificate is invalid.", { retryable: false, cause: err });
  }
  return new AppError("NETWORK_ERROR", "Could not reach the website.", {
    retryable: true,
    ambiguous: mutating && !preSend.includes(code ?? ""),
    cause: err,
  });
}
