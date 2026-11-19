import { findAll, getAttributeValue } from "domutils";
import { CRAWLER_AGENT } from "@/lib/audit/crawler";
import { blocksSite, parseRobots } from "@/lib/audit/robots";
import type { Snapshot, SnapshotPage } from "@/lib/monitoring/diff";
import type { HttpClient } from "@/lib/security/safe-fetch";
import { extractCanonical, extractMeta, extractTitleTag, parseHtml } from "@/lib/seo/html";

/**
 * SEO deploy gate. Run from CI after a deploy (or against a preview URL): fetches key pages
 * and compares their SEO-critical signals with the latest audit (the baseline). Errors fail
 * the gate; warnings fail it only with failOn = "warning".
 */
export type GateParams = { targetBaseUrl?: string; paths?: string[]; maxUrls?: number; failOn?: "error" | "warning"; allowNoindex?: boolean };
export type GateCheck = { path: string; url: string; severity: "error" | "warning" | "info"; code: string; message: string; before?: string | null; after?: string | null };
export type GateResult = { passed: boolean; target: string; baselineAuditId: string | null; checked: number; errors: number; warnings: number; checks: GateCheck[]; failOn: "error" | "warning" };

export type PageSignals = {
  status: number | null; finalUrl: string; title: string | null; description: string | null; canonical: string | null; indexable: boolean;
  noindexSource: string | null; h1Count: number; jsonLd: number; jsonLdInvalid: number; hreflang: number; wordCount: number; error?: string;
};

export async function fetchSignals(http: HttpClient, url: string): Promise<PageSignals> {
  const empty: PageSignals = { status: null, finalUrl: url, title: null, description: null, canonical: null, indexable: true, noindexSource: null, h1Count: 0, jsonLd: 0, jsonLdInvalid: 0, hreflang: 0, wordCount: 0 };
  let res;
  try {
    res = await http(url, { headers: { "user-agent": `${CRAWLER_AGENT}/1.0 (+deploy gate)`, accept: "text/html" }, timeoutMs: 20_000, maxBytes: 5_000_000, maxRedirects: 5 });
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : "Request failed" };
  }
  const s: PageSignals = { ...empty, status: res.status, finalUrl: res.url };
  if (res.status >= 400) return s;
  const doc = parseHtml(res.text);
  const metaRobots = extractMeta(doc.doc, "robots") ?? "";
  const header = res.headers["x-robots-tag"] ?? "";
  s.title = extractTitleTag(doc.doc);
  s.description = extractMeta(doc.doc, "description");
  s.canonical = extractCanonical(doc.doc);
  s.indexable = !/noindex/i.test(`${metaRobots} ${header}`);
  s.noindexSource = /noindex/i.test(metaRobots) ? `<meta name="robots" content="${metaRobots}">` : /noindex/i.test(header) ? `X-Robots-Tag: ${header}` : null;
  s.h1Count = doc.headings.filter((h) => h.level === 1).length;
  s.jsonLd = doc.jsonLd.length;
  s.jsonLdInvalid = doc.jsonLd.filter((j) => { try { JSON.parse(j); return false; } catch { return true; } }).length;
  s.hreflang = findAll((el) => el.name === "link" && (getAttributeValue(el, "rel") ?? "").toLowerCase() === "alternate" && !!getAttributeValue(el, "hreflang"), doc.doc.children).length;
  s.wordCount = doc.wordCount;
  return s;
}

const healthy = (p: SnapshotPage) => p.status_code === 200 && p.indexable !== false && !p.issues.includes("redirect");

/**
 * Baseline = each page's last known-good state across recent audits (newest first). Using only
 * the latest audit would accept a regression that an audit had already recorded (a page that
 * broke last week would be "normal" today); a page that was never healthy keeps its latest state.
 */
export function knownGoodBaseline(snapshots: Snapshot[]): Snapshot | null {
  if (!snapshots.length) return null;
  const pages = new Map<string, SnapshotPage>();
  for (const s of snapshots) {
    for (const p of s.pages) {
      const have = pages.get(p.url);
      if (!have || (!healthy(have) && healthy(p))) pages.set(p.url, have && !healthy(have) && healthy(p) ? { ...p, inlinks: Math.max(p.inlinks ?? 0, have.inlinks ?? 0) } : p);
    }
  }
  return { ...snapshots[0], pages: [...pages.values()] };
}

const pathOf = (u: string, base: string) => { try { const x = new URL(u, base); return x.pathname + x.search; } catch { return u; } };

export function compareSignals(path: string, url: string, base: SnapshotPage | null, now: PageSignals, opts: { allowNoindex: boolean; targetBase: string }): GateCheck[] {
  const out: GateCheck[] = [];
  const add = (severity: GateCheck["severity"], code: string, message: string, before?: string | null, after?: string | null) => out.push({ path, url, severity, code, message, before, after });
  if (now.status == null) { add("error", "unreachable", `Page could not be fetched: ${now.error ?? "request failed"}`, base ? `HTTP ${base.status_code}` : null, null); return out; }
  if (now.status >= 400) { add("error", "http_error", `Page returns HTTP ${now.status}`, base ? `HTTP ${base.status_code}` : null, `HTTP ${now.status}`); return out; }
  if (pathOf(now.finalUrl, opts.targetBase) !== path) add("warning", "redirect", `Page redirects to ${now.finalUrl}`, path, pathOf(now.finalUrl, opts.targetBase));
  if (!now.indexable && !opts.allowNoindex && base?.indexable !== false) add("error", "noindex", "Page is noindex", "indexable", now.noindexSource);
  if (!now.title) add("error", "title_missing", "Title is missing or empty", base?.title, null);
  else if (base?.title && base.title !== now.title) add("info", "title_changed", "Title changed", base.title, now.title);
  if (!now.description && base?.meta_description) add("warning", "description_missing", "Meta description was removed", base.meta_description, null);
  if (now.canonical) {
    const canonPath = pathOf(now.canonical, opts.targetBase);
    if (canonPath !== path && (!base?.canonical || pathOf(base.canonical, opts.targetBase) === path)) add("error", "canonical_changed", "Canonical points to another page", base?.canonical ?? null, now.canonical);
  } else if (base?.canonical) add("warning", "canonical_missing", "Canonical tag was removed", base.canonical, null);
  if (now.h1Count === 0 && Number(base?.details.h1Count ?? 1) > 0) add("warning", "h1_missing", "H1 is missing", base ? `${base.details.h1Count ?? "?"} H1` : null, "0 H1");
  if (now.jsonLdInvalid) add("error", "jsonld_invalid", `${now.jsonLdInvalid} JSON-LD block(s) do not parse`, null, null);
  if (now.jsonLd === 0 && Number(base?.details.jsonLd ?? 0) > 0) add("warning", "jsonld_removed", "Structured data was removed", `${base!.details.jsonLd} block(s)`, "0");
  const baseHreflang = (base?.details.hreflang as unknown[] | undefined)?.length ?? 0;
  if (baseHreflang && !now.hreflang) add("warning", "hreflang_removed", "hreflang annotations were removed", `${baseHreflang} alternates`, "0");
  if ((base?.word_count ?? 0) >= 300 && now.wordCount <= (base!.word_count ?? 0) * 0.5) add("warning", "content_shrunk", "Visible content shrank by half or more", `${base!.word_count} words`, `${now.wordCount} words`);
  return out;
}

/** Paths to check: explicit list, else the baseline's most-linked indexable pages, else the homepage. */
export function gatePaths(baseUrl: string, baseline: Snapshot | null, params: GateParams): string[] {
  const max = Math.min(50, Math.max(1, params.maxUrls ?? 20));
  if (params.paths?.length) return [...new Set(params.paths.map((p) => pathOf(p.startsWith("/") || /^https?:/.test(p) ? p : `/${p}`, baseUrl)))].slice(0, 50);
  const top = (baseline?.pages ?? []).filter((p) => p.status_code === 200 && p.indexable && !p.issues.includes("redirect"))
    .sort((a, b) => (b.inlinks ?? 0) - (a.inlinks ?? 0))
    .map((p) => pathOf(p.url, baseUrl));
  return top.length ? [...new Set(["/", ...top])].slice(0, max) : ["/"];
}

export async function runGate(http: HttpClient, websiteBaseUrl: string, baseline: Snapshot | null, params: GateParams, onProgress?: (n: number, total: number) => Promise<void> | void): Promise<GateResult> {
  const target = new URL(params.targetBaseUrl || websiteBaseUrl).origin;
  const failOn = params.failOn ?? "error";
  const allowNoindex = !!params.allowNoindex;
  const byPath = new Map((baseline?.pages ?? []).map((p) => [pathOf(p.url, websiteBaseUrl), p]));
  const checks: GateCheck[] = [];

  try {
    const robots = await http(`${target}/robots.txt`, { timeoutMs: 10_000, maxBytes: 500_000 });
    if (robots.status === 200 && !/<html/i.test(robots.text.slice(0, 200)) && blocksSite(parseRobots(robots.text), "Googlebot") && !allowNoindex) {
      checks.push({ path: "/robots.txt", url: `${target}/robots.txt`, severity: "error", code: "robots_blocks_all", message: "robots.txt blocks Googlebot from the whole site", before: null, after: "Disallow: /" });
    }
  } catch { /* robots.txt unreachable: crawlers treat it as allow-all */ }

  const paths = gatePaths(websiteBaseUrl, baseline, params);
  let n = 0;
  for (const path of paths) {
    const url = `${target}${path}`;
    checks.push(...compareSignals(path, url, byPath.get(path) ?? null, await fetchSignals(http, url), { allowNoindex, targetBase: target }));
    await onProgress?.(++n, paths.length);
  }
  const errors = checks.filter((c) => c.severity === "error").length;
  const warnings = checks.filter((c) => c.severity === "warning").length;
  return { passed: errors === 0 && (failOn === "error" || warnings === 0), target, baselineAuditId: baseline?.id ?? null, checked: paths.length, errors, warnings, checks, failOn };
}
