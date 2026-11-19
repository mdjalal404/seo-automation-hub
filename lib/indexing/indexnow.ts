import { ENDPOINTS } from "@/lib/analytics/providers";
import { AppError } from "@/lib/errors";
import type { HttpClient } from "@/lib/security/safe-fetch";

/**
 * IndexNow (https://www.indexnow.org): tells participating search engines (Bing, Yandex,
 * Seznam, Naver…) that URLs changed. The key is public by design; ownership is proven by a
 * text file at https://<host>/<key>.txt containing the key. Google does not use IndexNow.
 * Re-submitting a URL is harmless, so a failed batch may be retried.
 */
export const INDEXNOW_MAX_URLS = 10_000;

export const keyLocation = (baseUrl: string, key: string) => `${new URL(baseUrl).origin}/${key}.txt`;

export async function verifyKeyFile(http: HttpClient, baseUrl: string, key: string) {
  const location = keyLocation(baseUrl, key);
  let res;
  try {
    res = await http(location, { timeoutMs: 10_000, maxBytes: 10_000 });
  } catch {
    throw new AppError("INVALID_INPUT", `Could not fetch ${location}. Upload a file named ${key}.txt containing the key to the site root.`);
  }
  if (res.status !== 200 || res.text.trim() !== key) {
    throw new AppError("INVALID_INPUT", `${location} ${res.status !== 200 ? `returned HTTP ${res.status}` : "does not contain the key"}. Upload a file named ${key}.txt whose only content is the key, then try again.`);
  }
  return location;
}

/** Keeps only absolute http(s) URLs on the website's host (IndexNow rejects other hosts with 422). */
export function sameHostUrls(baseUrl: string, urls: string[]) {
  const host = new URL(baseUrl).host;
  const out = new Set<string>();
  for (const u of urls) {
    try {
      const x = new URL(u.trim());
      if (/^https?:$/.test(x.protocol) && x.host === host) { x.hash = ""; out.add(x.toString()); }
    } catch { /* skip */ }
  }
  return [...out].slice(0, INDEXNOW_MAX_URLS);
}

export async function submitIndexNow(http: HttpClient, baseUrl: string, key: string, urls: string[]) {
  const list = sameHostUrls(baseUrl, urls);
  if (!list.length) return { submitted: 0, status: 0 };
  const res = await http(`${ENDPOINTS.indexnow()}/indexnow`, {
    method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, timeoutMs: 20_000, maxBytes: 20_000,
    body: JSON.stringify({ host: new URL(baseUrl).host, key, keyLocation: keyLocation(baseUrl, key), urlList: list }),
  });
  // 200 = accepted; 202 = accepted, key validation pending.
  if (res.status === 200 || res.status === 202) return { submitted: list.length, status: res.status };
  if (res.status === 403) throw new AppError("CMS_AUTH_FAILED", `IndexNow rejected the key: ${keyLocation(baseUrl, key)} must be reachable and contain the key.`, { status: 403 });
  if (res.status === 422) throw new AppError("INVALID_INPUT", "IndexNow rejected the URLs (they must belong to the key's host).", { status: 422 });
  if (res.status === 429) throw new AppError("RATE_LIMITED", "IndexNow is rate limiting submissions; the task will retry.", { status: 429, retryable: true, retryAfterMs: 15 * 60_000 });
  if (res.status >= 500) throw new AppError("NETWORK_ERROR", `IndexNow is temporarily unavailable (${res.status}).`, { status: res.status, retryable: true });
  throw new AppError("INVALID_INPUT", `IndexNow rejected the request (${res.status}).`, { status: res.status });
}
