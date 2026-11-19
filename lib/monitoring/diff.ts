import { ISSUE_INFO } from "@/lib/audit/crawler";

/**
 * SEO regression detection between two audits of the same website. Compares the pages both
 * audits crawled (so a smaller crawl never reads as "pages removed") plus site-wide checks.
 * Every finding carries before/after evidence and a stable fingerprint for de-duplication.
 */
export type Severity = "critical" | "warning" | "info";
export type Finding = { kind: string; severity: Severity; title: string; url: string | null; evidence: string[]; fingerprint: string };

export type SnapshotPage = {
  url: string; status_code: number | null; title: string | null; meta_description: string | null; canonical: string | null;
  indexable: boolean | null; word_count: number | null; inlinks?: number; issues: string[]; details: Record<string, unknown>;
};
export type SnapshotSite = {
  robots?: { found: boolean; blocksAll: boolean }; sitemap?: { found: boolean; urls: number };
  aiCrawlers?: { agent: string; allowed: boolean }[];
};
export type Snapshot = { id: string; created_at: string; score: number | null; site: SnapshotSite; pages: SnapshotPage[] };

export const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

const day = (iso: string) => iso.slice(0, 10);
const q = (s: string | null | undefined) => (s ? `“${s}”` : "(none)");
const norm = (u: string | null) => (u ? u.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase() : null);
const ok = (p: SnapshotPage) => p.status_code === 200 && !p.issues.includes("redirect");
const ev = (p: SnapshotPage, code: string) => ((p.details.evidence as Record<string, string[]> | undefined)?.[code] ?? []);

export function diffAudits(prev: Snapshot, curr: Snapshot): Finding[] {
  const out: Finding[] = [];
  const add = (f: Omit<Finding, "fingerprint">, key = f.url ?? "site") => out.push({ ...f, fingerprint: `audit:${f.kind}:${key}` });
  const was = `audit of ${day(prev.created_at)}`;

  // --- Site-wide ---
  if (prev.site.robots && curr.site.robots && !prev.site.robots.blocksAll && curr.site.robots.blocksAll) {
    add({ kind: "robots_blocks_all", severity: "critical", title: "robots.txt now blocks the whole site", url: null, evidence: [`robots.txt disallows / for all crawlers (it did not in the ${was})`] });
  }
  if (prev.site.sitemap?.found && curr.site.sitemap && !curr.site.sitemap.found) {
    add({ kind: "sitemap_missing", severity: "critical", title: "XML sitemap is no longer reachable", url: null, evidence: [`The ${was} found ${prev.site.sitemap.urls} sitemap URLs; none were found now`] });
  }
  const blockedBefore = new Set((prev.site.aiCrawlers ?? []).filter((c) => !c.allowed).map((c) => c.agent));
  const newlyBlocked = (curr.site.aiCrawlers ?? []).filter((c) => !c.allowed && !blockedBefore.has(c.agent)).map((c) => c.agent);
  if (newlyBlocked.length && prev.site.aiCrawlers?.length) {
    add({ kind: "ai_crawler_blocked", severity: "warning", title: `robots.txt now blocks ${newlyBlocked.join(", ")}`, url: null, evidence: newlyBlocked.map((a) => `${a} was allowed in the ${was}`) }, newlyBlocked.sort().join(","));
  }
  if (prev.score != null && curr.score != null && prev.score - curr.score >= 5) {
    add({ kind: "score_drop", severity: "warning", title: `Health score fell from ${prev.score} to ${curr.score}`, url: null, evidence: [`${prev.score} in the ${was}, ${curr.score} now`] }, String(curr.score));
  }

  // --- Per page (URLs crawled by both audits) ---
  const before = new Map(prev.pages.map((p) => [p.url, p]));
  for (const c of curr.pages) {
    const p = before.get(c.url);
    if (!p || !ok(p)) continue;
    const url = c.url;
    if (c.status_code == null || c.status_code >= 400) {
      add({ kind: "page_broken", severity: "critical", title: `Page now returns ${c.status_code ?? "no response"}`, url, evidence: [`HTTP 200 in the ${was}`, c.status_code ? `HTTP ${c.status_code} now` : `Not reachable now: ${String(c.details.error ?? "request failed")}`, ...[...ev(c, "http_4xx"), ...ev(c, "http_5xx")].filter((e) => e.startsWith("Linked from"))] });
      continue;
    }
    if (c.issues.includes("redirect")) {
      add({ kind: "redirect_added", severity: "warning", title: "Page now redirects", url, evidence: [`Served directly (HTTP 200) in the ${was}`, ...ev(c, "redirect")] });
      continue;
    }
    if (p.indexable !== false && c.indexable === false) {
      add({ kind: "noindex_added", severity: "critical", title: "Page became noindex", url, evidence: [`Indexable in the ${was}`, ...ev(c, "noindex")] });
    }
    if (norm(p.canonical) !== norm(c.canonical) && c.canonical && norm(c.canonical) !== norm(c.url)) {
      add({ kind: "canonical_changed", severity: "warning", title: "Canonical now points to another URL", url, evidence: [`Before: ${p.canonical ?? "(none)"}`, `Now: ${c.canonical}`] });
    }
    if (p.title !== c.title) {
      add({ kind: c.title ? "title_changed" : "title_removed", severity: c.title ? "info" : "warning", title: c.title ? "Title changed" : "Title removed", url, evidence: [`Before: ${q(p.title)}`, `Now: ${q(c.title)}`] }, `${url}:${c.title ?? ""}`);
    }
    if (p.meta_description && !c.meta_description) {
      add({ kind: "description_removed", severity: "warning", title: "Meta description removed", url, evidence: [`Before: ${q(p.meta_description)}`, "Now: (none)"] });
    } else if (p.meta_description !== c.meta_description && c.meta_description) {
      add({ kind: "description_changed", severity: "info", title: "Meta description changed", url, evidence: [`Before: ${q(p.meta_description)}`, `Now: ${q(c.meta_description)}`] }, `${url}:${c.meta_description}`);
    }
    if ((p.word_count ?? 0) >= 300 && c.word_count != null && c.word_count <= (p.word_count ?? 0) * 0.5) {
      add({ kind: "content_shrunk", severity: "warning", title: `Content shrank by ${Math.round((1 - c.word_count / p.word_count!) * 100)}%`, url, evidence: [`${p.word_count} words in the ${was}`, `${c.word_count} words now`] });
    }
    if (Number(p.details.jsonLd ?? 0) > 0 && Number(c.details.jsonLd ?? 0) === 0) {
      add({ kind: "structured_data_removed", severity: "warning", title: "Structured data removed", url, evidence: [`${p.details.jsonLd} JSON-LD block(s) in the ${was}`, "0 now"] });
    }
    if (Number(p.details.h1Count ?? 0) > 0 && Number(c.details.h1Count ?? 0) === 0) {
      add({ kind: "h1_removed", severity: "warning", title: "H1 removed", url, evidence: [`${p.details.h1Count} H1 in the ${was}`, ...ev(c, "missing_h1")] });
    }
    for (const code of c.issues) {
      if (p.issues.includes(code) || ISSUE_INFO[code]?.severity !== "error") continue;
      add({ kind: "new_error", severity: "warning", title: `New error: ${ISSUE_INFO[code].label}`, url, evidence: ev(c, code).length ? ev(c, code) : [ISSUE_INFO[code].fix] }, `${url}:${code}`);
    }
  }
  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/**
 * Whether an open audit alert still applies to the latest audit. Alerts whose condition is
 * gone (page fixed, noindex removed…) are resolved automatically. Change events
 * (title/description changed, score drop) stay until someone resolves them.
 */
export function stillPresent(kind: string, url: string | null, curr: Snapshot): boolean | null {
  const p = url ? curr.pages.find((x) => x.url === url) : null;
  switch (kind) {
    case "robots_blocks_all": return !!curr.site.robots?.blocksAll;
    case "sitemap_missing": return !curr.site.sitemap?.found;
    case "page_broken": return p ? p.status_code == null || p.status_code >= 400 : null;
    case "redirect_added": return p ? p.issues.includes("redirect") : null;
    case "noindex_added": return p ? p.indexable === false : null;
    case "title_removed": return p ? !p.title : null;
    case "description_removed": return p ? !p.meta_description : null;
    case "structured_data_removed": return p ? Number(p.details.jsonLd ?? 0) === 0 : null;
    case "h1_removed": return p ? Number(p.details.h1Count ?? 0) === 0 : null;
    default: return null; // cannot tell; leave it to a person
  }
}
