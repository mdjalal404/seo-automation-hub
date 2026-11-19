import { ISSUE_INFO } from "@/lib/audit/crawler";
import { toCsv } from "@/lib/csv/write";

/** Export formats for a stored site audit: PDF report (lib/audit/pdf.ts), page list, one row per issue, or JSON. */
export const AUDIT_EXPORT_FORMATS = ["pdf", "pages", "issues", "json"] as const;
export type AuditExportFormat = (typeof AUDIT_EXPORT_FORMATS)[number];

type Audit = { id: string; created_at: string; score: number | null; pages_crawled: number; summary: Record<string, number>; site_checks: Record<string, unknown> };
type Page = {
  url: string; status_code: number | null; depth: number; title: string | null; meta_description: string | null; canonical: string | null;
  indexable: boolean | null; word_count: number | null; load_ms: number | null; inlinks: number; issues: string[]; details?: Record<string, unknown>;
};

/** Evidence recorded by the crawler for one issue on one page (e.g. the other URLs sharing a title). */
export const evidenceFor = (p: { details?: Record<string, unknown> }, code: string): string[] => ((p.details?.evidence as Record<string, string[]> | undefined)?.[code] ?? []);

const label = (code: string) => ISSUE_INFO[code]?.label ?? code;
const severity = (code: string) => ISSUE_INFO[code]?.severity ?? "notice";
const ORDER = { error: 0, warning: 1, notice: 2 } as const;

export function auditPagesCsv(pages: Page[]): string {
  return toCsv(
    ["url", "status_code", "title", "meta_description", "canonical", "indexable", "word_count", "load_ms", "inlinks", "click_depth", "errors", "warnings", "notices", "issues"],
    pages.map((p) => {
      const issues = [...new Set(p.issues)];
      const count = (s: string) => issues.filter((i) => severity(i) === s).length;
      return [p.url, p.status_code, p.title, p.meta_description, p.canonical, p.indexable, p.word_count, p.load_ms, p.inlinks, p.depth < 0 ? "sitemap only" : p.depth,
        count("error"), count("warning"), count("notice"), issues.map(label).join("; ")];
    }),
  );
}

/** One row per page × issue, sorted by severity — ready to use as a fix list. */
export function auditIssuesCsv(pages: Page[]): string {
  const rows = pages.flatMap((p) => [...new Set(p.issues)].map((code) => ({ p, code })))
    .sort((a, b) => ORDER[severity(a.code)] - ORDER[severity(b.code)] || label(a.code).localeCompare(label(b.code)) || a.p.url.localeCompare(b.p.url));
  return toCsv(["severity", "issue", "issue_code", "url", "status_code", "evidence", "how_to_fix"],
    rows.map(({ p, code }) => [severity(code), label(code), code, p.url, p.status_code, evidenceFor(p, code).join(" | "), ISSUE_INFO[code]?.fix ?? ""]));
}

export function auditJson(audit: Audit, website: { name: string; base_url: string }, pages: Page[]) {
  return {
    website: { name: website.name, url: website.base_url },
    audit: { id: audit.id, created_at: audit.created_at, score: audit.score, pages_crawled: audit.pages_crawled },
    issues: Object.entries(audit.summary).map(([code, pagesAffected]) => ({ code, label: label(code), severity: severity(code), pages: pagesAffected, fix: ISSUE_INFO[code]?.fix ?? null }))
      .sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || b.pages - a.pages),
    site_checks: audit.site_checks,
    pages,
  };
}
