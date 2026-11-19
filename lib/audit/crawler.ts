import { getAttributeValue, findAll } from "domutils";
import { isAppError } from "@/lib/errors";
import { blocksSite, isAllowed, parseRobots, type RobotsRules } from "@/lib/audit/robots";
import type { HttpClient } from "@/lib/security/safe-fetch";
import { AI_CRAWLERS } from "@/lib/seo/ai-visibility";
import { extractCanonical, extractMeta, extractTitleTag, parseHtml } from "@/lib/seo/html";

/**
 * Technical SEO crawler. Fetches robots.txt, sitemaps and llms.txt, then crawls the site
 * breadth-first (same host, robots.txt respected, polite spacing) and records per-page
 * issues plus site-wide checks (duplicates, orphans, broken internal links, AI crawler access).
 */
export const CRAWLER_AGENT = "SEOAutomationHub";

export type AuditPage = {
  url: string; statusCode: number | null; depth: number; title: string | null; metaDescription: string | null; canonical: string | null;
  indexable: boolean | null; wordCount: number | null; loadMs: number | null; inlinks: number; issues: string[];
  details: { redirectedTo?: string; h1Count?: number; imagesMissingAlt?: number; bytes?: number; jsonLd?: number; error?: string; outlinks?: number; hreflang?: { lang: string; href: string }[];
    /** Proof per issue code: the concrete values/URLs that triggered it (shown in the report and exports). */
    evidence?: Record<string, string[]> };
};
export type SiteChecks = {
  https: boolean;
  robots: { found: boolean; sitemaps: string[]; blocksAll: boolean };
  sitemap: { found: boolean; urls: number; sources: string[] };
  llmsTxt: { found: boolean };
  aiCrawlers: { agent: string; owner: string; purpose: string; allowed: boolean }[];
  /** Crawl budget: discovered URLs with query strings and the parameter names behind them. */
  crawlBudget?: { parameterUrls: number; parameters: { name: string; urls: number }[]; sitemapNonIndexable: number };
  /** International: pages with hreflang annotations and the languages/regions used. */
  hreflang?: { pages: number; languages: string[] };
};
/** `partial` = the time budget ran out before maxPages were crawled. */
export type AuditResult = { pages: AuditPage[]; site: SiteChecks; summary: Record<string, number>; score: number; partial: boolean };

export const ISSUE_INFO: Record<string, { label: string; severity: "error" | "warning" | "notice"; fix: string }> = {
  http_4xx: { label: "Page returns 4xx", severity: "error", fix: "Restore the page, or redirect it and update links." },
  http_5xx: { label: "Server error (5xx)", severity: "error", fix: "Investigate the server error; search engines drop pages that keep failing." },
  fetch_failed: { label: "Page could not be fetched", severity: "error", fix: "Check DNS, TLS and firewall rules for this URL." },
  redirect: { label: "Redirects", severity: "notice", fix: "Link directly to the final URL." },
  broken_internal_link: { label: "Links to a broken internal page", severity: "error", fix: "Fix or remove links that point to 4xx/5xx pages." },
  missing_title: { label: "Missing <title>", severity: "error", fix: "Add a unique, descriptive title." },
  duplicate_title: { label: "Duplicate title", severity: "warning", fix: "Give each indexable page a unique title." },
  title_too_long: { label: "Title over 60 characters", severity: "notice", fix: "Shorten the title so it is not truncated." },
  missing_meta_description: { label: "Missing meta description", severity: "warning", fix: "Write a 120–155 character description." },
  duplicate_meta_description: { label: "Duplicate meta description", severity: "warning", fix: "Write unique descriptions." },
  missing_h1: { label: "Missing H1", severity: "warning", fix: "Add one H1 describing the page." },
  multiple_h1: { label: "Multiple H1s", severity: "notice", fix: "Use a single H1 per page." },
  thin_content: { label: "Thin content (<200 words)", severity: "warning", fix: "Expand the page or noindex it if it has no search value." },
  noindex: { label: "Noindex", severity: "notice", fix: "Confirm the page should be excluded from search." },
  canonicalized: { label: "Canonical points elsewhere", severity: "notice", fix: "Confirm the canonical target is intended." },
  missing_canonical: { label: "No canonical tag", severity: "notice", fix: "Add a self-referencing canonical." },
  img_missing_alt: { label: "Images missing alt text", severity: "warning", fix: "Describe images with alt text." },
  slow_response: { label: "Slow response (>1.5 s)", severity: "warning", fix: "Improve server response time (caching, hosting)." },
  large_page: { label: "Large HTML (>1 MB)", severity: "notice", fix: "Reduce inline scripts/styles and page weight." },
  mixed_content: { label: "Mixed content (http on https)", severity: "warning", fix: "Load all resources over HTTPS." },
  invalid_jsonld: { label: "Invalid JSON-LD", severity: "error", fix: "Fix the structured data syntax." },
  no_structured_data: { label: "No structured data", severity: "notice", fix: "Add relevant schema.org JSON-LD." },
  orphan_page: { label: "Orphan page (in sitemap, no internal links)", severity: "warning", fix: "Link to the page from related content." },
  not_in_sitemap: { label: "Indexable page missing from sitemap", severity: "notice", fix: "Add the page to the XML sitemap." },
  blocked_by_robots: { label: "Sitemap URL blocked by robots.txt", severity: "error", fix: "Remove the URL from the sitemap or allow it in robots.txt." },
  deep_page: { label: "More than 3 clicks from the homepage", severity: "notice", fix: "Link to important pages from higher-level pages." },
  parameter_url: { label: "Indexable parameter URL", severity: "notice", fix: "Canonicalize parameter/facet URLs to the clean URL, or block crawl-wasting parameters in robots.txt." },
  sitemap_non_indexable: { label: "Sitemap lists a non-indexable URL", severity: "warning", fix: "Keep only 200, indexable, self-canonical URLs in the sitemap so crawl budget goes to real pages." },
  hreflang_invalid: { label: "Invalid hreflang code", severity: "error", fix: "Use ISO 639-1 language (and optional ISO 3166-1 region) codes, e.g. en-GB, or x-default." },
  hreflang_missing_self: { label: "hreflang set without a self-reference", severity: "warning", fix: "Each page in an hreflang set must list itself." },
  hreflang_no_return: { label: "hreflang target does not link back", severity: "error", fix: "Alternate pages must reference each other (return links), or Google ignores the pair." },
  hreflang_broken_target: { label: "hreflang points to a non-200 page", severity: "error", fix: "Point hreflang only at live, indexable, canonical URLs." },
  hreflang_no_x_default: { label: "hreflang set without x-default", severity: "notice", fix: "Add an x-default alternate for users whose language/region is not covered." },
  not_indexed: { label: "Not indexed by Google (Search Console)", severity: "warning", fix: "Open URL Inspection in Search Console for the reason (crawled not indexed, duplicate, blocked…)." },
};

const WEIGHT = { error: 3, warning: 1.5, notice: 0.4 } as const;

const MAX_EVIDENCE = 10;
/** Records an issue on a page together with the evidence that triggered it. */
export function flag(page: AuditPage, code: string, ...evidence: (string | null | undefined)[]) {
  if (!page.issues.includes(code)) page.issues.push(code);
  const items = evidence.filter((e): e is string => !!e).map((e) => (e.length > 300 ? `${e.slice(0, 297)}…` : e));
  if (!items.length) return;
  const ev = (page.details.evidence ??= {});
  const list = (ev[code] ??= []);
  for (const e of items) if (list.length < MAX_EVIDENCE && !list.includes(e)) list.push(e);
}
const q = (s: string) => `“${s}”`;

export type CrawlOptions = { maxPages?: number; delayMs?: number; concurrency?: number; deadline?: number; onProgress?: (crawled: number, queued: number) => Promise<void> | void };

function normalize(u: string, base: string): string | null {
  try {
    const url = new URL(u, base);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = "";
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
    return url.toString();
  } catch {
    return null;
  }
}

const sameSite = (a: URL, b: URL) => a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "") && a.port === b.port;
const SKIP_EXT = /\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|mp4|mp3|css|js|ico|woff2?|xml|json)$/i;

async function getText(http: HttpClient, url: string, maxBytes = 2_000_000) {
  try {
    const res = await http(url, { headers: { "user-agent": `${CRAWLER_AGENT}/1.0 (+site audit)` }, maxBytes, timeoutMs: 15_000 });
    return res;
  } catch {
    return null;
  }
}

export async function readSitemaps(http: HttpClient, origin: string, declared: string[], max = 2000): Promise<{ urls: Set<string>; sources: string[] }> {
  const queue = declared.length ? [...declared] : [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const urls = new Set<string>();
  const sources: string[] = [];
  const seen = new Set<string>();
  while (queue.length && seen.size < 10 && urls.size < max) {
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    const res = await getText(http, sm, 10_000_000);
    if (!res || res.status !== 200 || !/<(urlset|sitemapindex)\b/i.test(res.text)) continue;
    sources.push(sm);
    const locs = [...res.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
    if (/<sitemapindex\b/i.test(res.text)) queue.push(...locs);
    else for (const l of locs) if (urls.size < max) urls.add(normalize(l, origin) ?? l);
  }
  return { urls, sources };
}

export async function auditSite(http: HttpClient, baseUrl: string, opts: CrawlOptions = {}): Promise<AuditResult> {
  const maxPages = Math.min(Math.max(opts.maxPages ?? 100, 1), 500);
  const delay = opts.delayMs ?? 250;
  const concurrency = Math.min(Math.max(opts.concurrency ?? 2, 1), 4);
  const start = new URL(baseUrl);
  const origin = start.origin;

  const robotsRes = await getText(http, `${origin}/robots.txt`, 500_000);
  const robotsFound = !!robotsRes && robotsRes.status === 200 && !/<html/i.test(robotsRes.text.slice(0, 200));
  const robots: RobotsRules = robotsFound ? parseRobots(robotsRes!.text) : { groups: [], sitemaps: [] };
  const sitemap = await readSitemaps(http, origin, robots.sitemaps);
  const llms = await getText(http, `${origin}/llms.txt`, 500_000);
  const site: SiteChecks = {
    https: start.protocol === "https:",
    robots: { found: robotsFound, sitemaps: robots.sitemaps, blocksAll: blocksSite(robots, CRAWLER_AGENT) },
    sitemap: { found: sitemap.sources.length > 0, urls: sitemap.urls.size, sources: sitemap.sources },
    llmsTxt: { found: !!llms && llms.status === 200 && !/<html/i.test(llms.text.slice(0, 200)) && llms.text.trim().length > 0 },
    aiCrawlers: AI_CRAWLERS.map((c) => ({ ...c, allowed: !blocksSite(robots, c.agent) })),
  };

  const pages = new Map<string, AuditPage>();
  const inlinks = new Map<string, Set<string>>();
  const linksFrom = new Map<string, string[]>();
  const queue: { url: string; depth: number }[] = [{ url: normalize(start.toString(), origin)!, depth: 0 }];
  const queued = new Set(queue.map((q) => q.url));
  for (const u of sitemap.urls) {
    if (queued.size >= maxPages * 2) break;
    try {
      if (!sameSite(new URL(u), start)) continue;
    } catch {
      continue;
    }
    // Sitemap URLs are crawled after link discovery (depth unknown → 99 until linked).
    if (!queued.has(u)) { queued.add(u); queue.push({ url: u, depth: 99 }); }
  }

  const crawlOne = async ({ url, depth }: { url: string; depth: number }) => {
    const path = new URL(url).pathname + new URL(url).search;
    const page: AuditPage = { url, statusCode: null, depth, title: null, metaDescription: null, canonical: null, indexable: null, wordCount: null, loadMs: null, inlinks: 0, issues: [], details: {} };
    pages.set(url, page);
    if (!isAllowed(robots, CRAWLER_AGENT, path)) {
      page.details.error = "Blocked by robots.txt";
      if (sitemap.urls.has(url)) flag(page, "blocked_by_robots", `robots.txt disallows ${path} for ${CRAWLER_AGENT}, but the URL is listed in the sitemap`);
      return;
    }
    const t0 = Date.now();
    let res;
    try {
      res = await http(url, { headers: { "user-agent": `${CRAWLER_AGENT}/1.0 (+site audit)`, accept: "text/html,*/*;q=0.5" }, maxBytes: 5_000_000, timeoutMs: 20_000, maxRedirects: 5 });
    } catch (err) {
      page.details.error = isAppError(err) ? err.message : "Request failed";
      flag(page, "fetch_failed", page.details.error);
      return;
    }
    page.loadMs = Date.now() - t0;
    page.statusCode = res.status;
    const finalUrl = normalize(res.url, origin) ?? res.url;
    if (finalUrl !== url) { page.details.redirectedTo = finalUrl; flag(page, "redirect", `Redirects to ${finalUrl} (final status ${res.status})`); }
    if (res.status >= 500) { flag(page, "http_5xx", `HTTP ${res.status}`); return; }
    if (res.status >= 400) { flag(page, "http_4xx", `HTTP ${res.status}`); return; }
    if (!/text\/html|application\/xhtml/i.test(res.headers["content-type"] ?? "text/html")) return;
    if (page.loadMs > 1500) flag(page, "slow_response", `Responded in ${page.loadMs} ms`);
    page.details.bytes = Buffer.byteLength(res.text);
    if (page.details.bytes > 1_000_000) flag(page, "large_page", `HTML is ${(page.details.bytes / 1_048_576).toFixed(2)} MB`);

    const parsed = parseHtml(res.text);
    page.title = extractTitleTag(parsed.doc);
    page.metaDescription = extractMeta(parsed.doc, "description");
    page.canonical = extractCanonical(parsed.doc);
    const robotsMeta = `${extractMeta(parsed.doc, "robots") ?? ""} ${res.headers["x-robots-tag"] ?? ""}`.toLowerCase();
    page.indexable = !/noindex/.test(robotsMeta);
    page.wordCount = parsed.wordCount;
    const h1 = parsed.headings.filter((h) => h.level === 1).length;
    page.details.h1Count = h1;
    page.details.imagesMissingAlt = parsed.images.filter((i) => i.alt === undefined).length;
    page.details.jsonLd = parsed.jsonLd.length;
    const alternates = findAll((el) => el.name === "link" && (getAttributeValue(el, "rel") ?? "").toLowerCase() === "alternate" && !!getAttributeValue(el, "hreflang"), parsed.doc.children)
      .map((el) => ({ lang: getAttributeValue(el, "hreflang")!.trim(), href: normalize(getAttributeValue(el, "href") ?? "", finalUrl) ?? "" })).filter((a) => a.href);
    if (alternates.length) page.details.hreflang = alternates.slice(0, 100);

    const hasTag = (test: Parameters<typeof findAll>[0]) => findAll(test, parsed.doc.children).length > 0;
    if (!page.title) flag(page, "missing_title", hasTag((el) => el.name === "title") ? "The <title> element is empty" : "No <title> element");
    else if (page.title.length > 60) flag(page, "title_too_long", `${q(page.title)} (${page.title.length} characters)`);
    if (!page.metaDescription) {
      const tag = hasTag((el) => el.name === "meta" && (getAttributeValue(el, "name") ?? "").toLowerCase() === "description");
      flag(page, "missing_meta_description", tag ? '<meta name="description"> is present but empty' : 'No <meta name="description"> tag');
    }
    const h1s = parsed.headings.filter((h) => h.level === 1);
    if (h1 === 0) flag(page, "missing_h1", parsed.headings.length ? `First heading is H${parsed.headings[0].level}: ${q(parsed.headings[0].text)}` : "The page has no headings");
    if (h1 > 1) flag(page, "multiple_h1", ...h1s.map((h) => `H1: ${q(h.text)}`));
    if (parsed.wordCount < 200) flag(page, "thin_content", `${parsed.wordCount} words of visible text`);
    if (!page.indexable) {
      const meta = extractMeta(parsed.doc, "robots");
      flag(page, "noindex", meta && /noindex/i.test(meta) ? `<meta name="robots" content="${meta}">` : null, /noindex/i.test(res.headers["x-robots-tag"] ?? "") ? `X-Robots-Tag: ${res.headers["x-robots-tag"]}` : null);
    }
    const canon = page.canonical ? normalize(page.canonical, finalUrl) : null;
    if (!canon) flag(page, "missing_canonical", 'No <link rel="canonical"> found');
    else if (canon !== finalUrl) flag(page, "canonicalized", `Canonical points to ${canon}`);
    if (page.details.imagesMissingAlt) flag(page, "img_missing_alt", `${page.details.imagesMissingAlt} image(s) without alt`, ...parsed.images.filter((i) => i.alt === undefined).map((i) => i.src ? `<img src="${i.src}">` : "<img> without src"));
    if (!parsed.jsonLd.length) flag(page, "no_structured_data", 'No <script type="application/ld+json"> blocks');
    else for (const [n, j] of parsed.jsonLd.entries()) {
      try { JSON.parse(j); } catch (e) { flag(page, "invalid_jsonld", `JSON-LD block ${n + 1}: ${(e as Error).message}`); }
    }
    if (finalUrl.startsWith("https:")) {
      const insecure = findAll((el) => ["img", "script", "iframe", "link", "source", "video", "audio"].includes(el.name), parsed.doc.children)
        .map((el) => getAttributeValue(el, "src") ?? (el.name === "link" && /stylesheet/i.test(getAttributeValue(el, "rel") ?? "") ? getAttributeValue(el, "href") ?? "" : ""))
        .filter((src) => /^http:\/\//i.test(src));
      if (insecure.length) flag(page, "mixed_content", ...insecure.map((src) => `Insecure resource: ${src}`));
    }

    const outs: string[] = [];
    for (const l of parsed.links) {
      const target = normalize(l.href, finalUrl);
      if (!target) continue;
      const tu = new URL(target);
      if (!sameSite(tu, start) || SKIP_EXT.test(tu.pathname)) continue;
      outs.push(target);
      if (!inlinks.has(target)) inlinks.set(target, new Set());
      inlinks.get(target)!.add(url);
      const existing = queue.find((q) => q.url === target);
      if (existing && existing.depth > depth + 1) existing.depth = depth + 1;
      if (!queued.has(target) && queued.size < maxPages * 3) {
        queued.add(target);
        queue.push({ url: target, depth: depth + 1 });
      }
    }
    page.details.outlinks = outs.length;
    linksFrom.set(url, outs);
  };

  let crawled = 0;
  let partial = false;
  while (queue.length && crawled < maxPages) {
    if (opts.deadline && Date.now() > opts.deadline) { partial = true; break; }
    // Prefer pages discovered by links (lower depth) before sitemap-only URLs.
    queue.sort((a, b) => a.depth - b.depth);
    const batch = queue.splice(0, Math.min(concurrency, maxPages - crawled));
    await Promise.all(batch.map(crawlOne));
    crawled += batch.length;
    await opts.onProgress?.(crawled, queue.length);
    if (queue.length && delay) await new Promise((r) => setTimeout(r, delay));
  }

  // Site-wide analysis.
  const list = [...pages.values()];
  const ok = list.filter((p) => p.statusCode && p.statusCode < 400 && p.indexable !== false);
  const dup = (key: "title" | "metaDescription", code: string) => {
    const groups = new Map<string, AuditPage[]>();
    for (const p of ok) if (p[key]) groups.set(p[key]!.toLowerCase(), [...(groups.get(p[key]!.toLowerCase()) ?? []), p]);
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      for (const p of g) flag(p, code, `${key === "title" ? "Title" : "Description"}: ${q(p[key]!)}`, ...g.filter((o) => o !== p).map((o) => `Same as ${o.url}`));
    }
  };
  dup("title", "duplicate_title");
  dup("metaDescription", "duplicate_meta_description");
  const broken = new Map(list.filter((p) => p.statusCode && p.statusCode >= 400).map((p) => [p.url, p.statusCode!]));
  for (const p of list) {
    p.inlinks = inlinks.get(p.url)?.size ?? 0;
    const from = [...(inlinks.get(p.url) ?? [])];
    if (p.issues.includes("http_4xx") || p.issues.includes("http_5xx")) flag(p, p.issues.includes("http_4xx") ? "http_4xx" : "http_5xx", ...from.map((f) => `Linked from ${f}`));
    const brokenTargets = [...new Set((linksFrom.get(p.url) ?? []).filter((t) => broken.has(t)))];
    if (brokenTargets.length) flag(p, "broken_internal_link", ...brokenTargets.map((t) => `Links to ${t} (HTTP ${broken.get(t)})`));
    if (p.depth === 99 && p.inlinks === 0 && sitemap.urls.has(p.url)) flag(p, "orphan_page", `Listed in the sitemap, but none of the ${list.length} crawled pages link to it`);
    if (p.depth !== 99 && p.depth > 3) flag(p, "deep_page", `${p.depth} clicks from the homepage`);
    if (site.sitemap.found && p.indexable && p.statusCode === 200 && !p.issues.includes("redirect") && !sitemap.urls.has(p.url)) flag(p, "not_in_sitemap", `Not among the ${site.sitemap.urls} sitemap URLs`, from[0] ? `Found via a link from ${from[0]}` : null);
    if (sitemap.urls.has(p.url) && (p.statusCode !== 200 || p.indexable === false || p.issues.includes("redirect") || p.issues.includes("canonicalized"))) {
      flag(p, "sitemap_non_indexable", p.statusCode !== 200 ? `Sitemap URL returns ${p.statusCode ?? "no response"}` : p.issues.includes("redirect") ? `Sitemap URL redirects to ${p.details.redirectedTo}` : p.indexable === false ? "Sitemap URL is noindex" : `Sitemap URL is canonicalized to ${p.canonical}`);
    }
    if (p.statusCode === 200 && p.indexable && new URL(p.url).search && !p.issues.includes("canonicalized")) flag(p, "parameter_url", `Parameters: ${[...new URL(p.url).searchParams.keys()].join(", ")}`, p.canonical ? `Canonical: ${p.canonical}` : "No canonical tag");
    if (p.depth === 99) p.depth = -1; // reached only via the sitemap
  }
  checkHreflang(list);
  const paramNames = new Map<string, number>();
  for (const p of list) for (const k of new URL(p.url).searchParams.keys()) paramNames.set(k, (paramNames.get(k) ?? 0) + 1);
  site.crawlBudget = {
    parameterUrls: list.filter((p) => new URL(p.url).search).length,
    parameters: [...paramNames.entries()].map(([name, urls]) => ({ name, urls })).sort((a, b) => b.urls - a.urls).slice(0, 20),
    sitemapNonIndexable: list.filter((p) => p.issues.includes("sitemap_non_indexable")).length,
  };
  const langs = new Set(list.flatMap((p) => (p.details.hreflang ?? []).map((h) => h.lang)));
  site.hreflang = { pages: list.filter((p) => p.details.hreflang?.length).length, languages: [...langs].sort() };

  const summary: Record<string, number> = {};
  for (const p of list) for (const i of new Set(p.issues)) summary[i] = (summary[i] ?? 0) + 1;
  return { pages: list, site, summary, score: scoreAudit(list.length, summary, site), partial };
}

const HREFLANG = /^(x-default|[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?)$/i;

/** hreflang validation across the crawled set: codes, self-reference, return links, live targets, x-default. */
export function checkHreflang(pages: AuditPage[]) {
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  for (const p of pages) {
    const alts = p.details.hreflang;
    if (!alts?.length || p.statusCode !== 200) continue;
    const invalid = alts.filter((a) => !HREFLANG.test(a.lang));
    if (invalid.length) flag(p, "hreflang_invalid", ...invalid.map((a) => `hreflang="${a.lang}" → ${a.href}`));
    const target = p.details.redirectedTo ?? p.url;
    if (!alts.some((a) => a.href === target || a.href === p.url)) flag(p, "hreflang_missing_self", `Alternates listed: ${alts.map((a) => `${a.lang} → ${a.href}`).join(", ")}`);
    if (!alts.some((a) => a.lang.toLowerCase() === "x-default")) flag(p, "hreflang_no_x_default", `Languages: ${alts.map((a) => a.lang).join(", ")}`);
    for (const a of alts) {
      if (a.href === p.url || a.href === target) continue;
      const other = byUrl.get(a.href);
      if (!other) continue; // not crawled: cannot judge
      if (other.statusCode !== 200 || other.issues.includes("redirect") || other.indexable === false) {
        flag(p, "hreflang_broken_target", `hreflang="${a.lang}" → ${a.href} (${other.statusCode !== 200 ? `HTTP ${other.statusCode ?? "no response"}` : other.issues.includes("redirect") ? "redirects" : "noindex"})`);
        continue;
      }
      if (!(other.details.hreflang ?? []).some((b) => b.href === p.url || b.href === target)) flag(p, "hreflang_no_return", `hreflang="${a.lang}" → ${a.href}, which has no hreflang link back to this page`);
    }
  }
}

export function scoreAudit(pageCount: number, summary: Record<string, number>, site: SiteChecks): number {
  if (!pageCount) return 0;
  let penalty = 0;
  for (const [code, n] of Object.entries(summary)) {
    const info = ISSUE_INFO[code];
    if (info) penalty += WEIGHT[info.severity] * Math.min(1, n / pageCount) * 10;
  }
  if (!site.https) penalty += 10;
  if (!site.sitemap.found) penalty += 5;
  if (!site.robots.found) penalty += 2;
  if (site.robots.blocksAll) penalty += 30;
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}
