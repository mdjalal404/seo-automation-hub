import Link from "next/link";
import { PageHeader, StatCard } from "@/components/common/page-header";
import { ToneBadge } from "@/components/common/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { ISSUE_INFO, type SiteChecks } from "@/lib/audit/crawler";
import type { WebVitals, UrlInspection } from "@/lib/analytics/providers";
import { requireWorkspace } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { orNotFound, param } from "@/lib/pages";
import { getAudit } from "@/lib/services/seo";
import { scoreTone } from "../score";

export const metadata = { title: "Audit report" };
const SEV_TONE = { error: "danger", warning: "warning", notice: "neutral" } as const;
const SEV_ORDER = { error: 0, warning: 1, notice: 2 } as const;

function Check({ ok, label, detail, optional }: { ok: boolean; label: string; detail?: React.ReactNode; optional?: boolean }) {
  return <li className="flex items-start gap-2 px-4 py-2"><ToneBadge tone={ok ? "success" : optional ? "neutral" : "danger"}>{ok ? "OK" : optional ? "Optional" : "Issue"}</ToneBadge><span><span className="font-medium">{label}</span>{detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}</span></li>;
}

/** Evidence line with any URLs turned into links. */
function Evidence({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s,()]+)/g);
  return <>{parts.map((part, i) => (/^https?:\/\//.test(part) ? <a key={i} className="text-foreground underline" href={part} target="_blank" rel="noopener noreferrer">{part}</a> : part))}</>;
}

export default async function AuditPage({ params, searchParams }: PageProps<"/audits/[id]">) {
  const { id } = await params;
  const issue = param((await searchParams).issue);
  const ctx = await requireWorkspace();
  const { audit, pages } = await orNotFound(getAudit(ctx, id));
  const site = audit.site_checks as unknown as SiteChecks & { webVitals?: WebVitals[] | { error: string }; indexation?: (UrlInspection | { url: string; error: string })[]; partial?: boolean };
  const issues = Object.entries(audit.summary).filter(([k]) => ISSUE_INFO[k]).sort((a, b) => SEV_ORDER[ISSUE_INFO[a[0]].severity] - SEV_ORDER[ISSUE_INFO[b[0]].severity] || b[1] - a[1]);
  const shown = issue ? pages.filter((p) => p.issues.includes(issue)) : pages;
  const blockedAi = site.aiCrawlers?.filter((c) => !c.allowed) ?? [];

  return (
    <>
      <PageHeader title="Audit report" description={<>{formatDateTime(audit.created_at)} · {audit.pages_crawled} pages crawled{site.partial ? " · partial (time budget reached — run the worker for full crawls)" : ""} · <Link className="underline" href="/audits">All audits</Link></>} actions={
        <div className="flex flex-wrap gap-2" data-testid="audit-export">
          <a className={buttonVariants({ size: "sm" })} href={`/api/audits/${audit.id}/export?format=pdf`} download>Download PDF report</a>
          <a className={buttonVariants({ size: "sm", variant: "outline" })} href={`/api/audits/${audit.id}/export?format=pages`} download>Export pages (CSV)</a>
          <a className={buttonVariants({ size: "sm", variant: "outline" })} href={`/api/audits/${audit.id}/export?format=issues`} download>Export issues (CSV)</a>
          <a className={buttonVariants({ size: "sm", variant: "ghost" })} href={`/api/audits/${audit.id}/export?format=json`} download>Full report (JSON)</a>
        </div>
      } />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Health score" value={<span className={scoreTone(audit.score)} data-testid="audit-score">{audit.score ?? "—"}</span>} hint="100 = no issues found" />
        <StatCard label="Pages crawled" value={audit.pages_crawled} />
        <StatCard label="Errors" value={issues.filter(([k]) => ISSUE_INFO[k].severity === "error").reduce((n, [, v]) => n + v, 0)} hint="pages affected" />
        <StatCard label="Warnings" value={issues.filter(([k]) => ISSUE_INFO[k].severity === "warning").reduce((n, [, v]) => n + v, 0)} hint="pages affected" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border bg-card">
          <h2 className="border-b px-4 py-3 text-sm font-semibold">Site checks</h2>
          <ul className="divide-y text-sm">
            <Check ok={!!site.https} label="HTTPS" />
            <Check ok={!!site.robots?.found && !site.robots.blocksAll} label="robots.txt" detail={!site.robots?.found ? "Not found" : site.robots.blocksAll ? "Blocks crawlers from the whole site" : `${site.robots.sitemaps.length} sitemap(s) declared`} />
            <Check ok={!!site.sitemap?.found} label="XML sitemap" detail={site.sitemap?.found ? `${site.sitemap.urls} URLs in ${site.sitemap.sources.length} file(s)` : "No sitemap at /sitemap.xml or in robots.txt"} />
            <Check ok={!!site.llmsTxt?.found} optional label="llms.txt" detail={site.llmsTxt?.found ? "Present" : "Not found. A /llms.txt summary can help AI assistants find your key pages (emerging convention, not a ranking factor)."} />
            <Check ok={blockedAi.length === 0} label="AI crawler access" detail={blockedAi.length ? `Blocked: ${blockedAi.map((c) => c.agent).join(", ")}` : "No AI crawlers are blocked in robots.txt"} />
          </ul>
        </section>
        <section className="rounded-xl border bg-card">
          <h2 className="border-b px-4 py-3 text-sm font-semibold">AI crawlers (robots.txt)</h2>
          <ul className="divide-y text-sm">
            {(site.aiCrawlers ?? []).map((c) => (
              <li key={c.agent} className="flex items-center gap-2 px-4 py-1.5"><ToneBadge tone={c.allowed ? "success" : "warning"}>{c.allowed ? "allowed" : "blocked"}</ToneBadge><span className="font-medium">{c.agent}</span><span className="text-xs text-muted-foreground">{c.owner} — {c.purpose}</span></li>
            ))}
          </ul>
          <p className="px-4 py-2 text-xs text-muted-foreground">Blocking search/user agents (OAI-SearchBot, Claude-SearchBot, PerplexityBot…) keeps pages out of those AI answers. Blocking training-only agents does not.</p>
        </section>
      </div>

      {site.webVitals ? (
        <section className="mt-6 rounded-xl border bg-card">
          <h2 className="border-b px-4 py-3 text-sm font-semibold">Core Web Vitals (homepage, PageSpeed Insights)</h2>
          {"error" in site.webVitals ? <p className="px-4 py-3 text-sm text-destructive">{site.webVitals.error}</p> : (
            <div className="grid gap-px sm:grid-cols-2">
              {site.webVitals.map((v) => (
                <div key={v.strategy} className="px-4 py-3 text-sm">
                  <p className="font-medium capitalize">{v.strategy} · performance {v.performanceScore ?? "—"}</p>
                  <p className="text-muted-foreground">Field (real users): LCP {v.field.lcpMs != null ? `${(v.field.lcpMs / 1000).toFixed(1)} s` : "no data"} · INP {v.field.inpMs ?? "—"} ms · CLS {v.field.cls ?? "—"} {v.field.category ? `(${v.field.category.toLowerCase()})` : ""}</p>
                  <p className="text-muted-foreground">Lab: LCP {v.lab.lcpMs != null ? `${(v.lab.lcpMs / 1000).toFixed(1)} s` : "—"} · TBT {v.lab.tbtMs != null ? Math.round(v.lab.tbtMs) : "—"} ms · CLS {v.lab.cls != null ? v.lab.cls.toFixed(2) : "—"}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {site.indexation?.length ? (
        <section className="mt-6 rounded-xl border bg-card">
          <h2 className="border-b px-4 py-3 text-sm font-semibold">Indexation (Search Console URL Inspection)</h2>
          <ul className="divide-y text-sm">
            {site.indexation.map((i) => (
              <li key={i.url} className="flex flex-wrap items-center gap-2 px-4 py-2">
                {"error" in i ? <ToneBadge tone="neutral">error</ToneBadge> : <ToneBadge tone={i.verdict === "PASS" ? "success" : "warning"}>{i.verdict === "PASS" ? "indexed" : i.verdict.toLowerCase()}</ToneBadge>}
                <span className="min-w-0 flex-1 truncate">{i.url}</span>
                <span className="text-xs text-muted-foreground">{"error" in i ? i.error : i.coverageState}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-6 rounded-xl border bg-card">
        <h2 className="border-b px-4 py-3 text-sm font-semibold">Issues</h2>
        {issues.length ? (
          <ul className="divide-y text-sm" data-testid="audit-issues">
            {issues.map(([code, n]) => (
              <li key={code} className="flex flex-wrap items-center gap-2 px-4 py-2">
                <ToneBadge tone={SEV_TONE[ISSUE_INFO[code].severity]}>{ISSUE_INFO[code].severity}</ToneBadge>
                <Link href={`/audits/${audit.id}?issue=${code}`} className={`font-medium hover:underline ${issue === code ? "underline" : ""}`}>{ISSUE_INFO[code].label}</Link>
                <span className="tabular-nums text-muted-foreground">{n} page{n === 1 ? "" : "s"}</span>
                <span className="w-full text-xs text-muted-foreground sm:ml-auto sm:w-auto">{ISSUE_INFO[code].fix}</span>
              </li>
            ))}
          </ul>
        ) : <p className="px-4 py-6 text-sm text-muted-foreground">No issues found.</p>}
      </section>

      <section className="mt-6 rounded-xl border bg-card">
        <h2 className="flex items-center justify-between border-b px-4 py-3 text-sm font-semibold">
          <span>Pages {issue ? `with “${ISSUE_INFO[issue]?.label ?? issue}”` : ""} ({shown.length})</span>
          {issue ? <Link className="text-xs font-normal underline" href={`/audits/${audit.id}`}>Show all</Link> : null}
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground"><tr className="border-b"><th className="px-4 py-2">URL</th><th className="py-2 pr-3">Status</th><th className="py-2 pr-3">Words</th><th className="py-2 pr-3">Inlinks</th><th className="py-2 pr-3">Time</th><th className="py-2 pr-4">Issues</th></tr></thead>
            <tbody className="divide-y">
              {shown.slice(0, 500).map((p) => (
                <tr key={p.id}>
                  <td className="max-w-xs px-4 py-2"><a className="block truncate hover:underline" href={p.url} target="_blank" rel="noopener noreferrer">{p.url}</a><span className="block truncate text-xs text-muted-foreground">{p.title ?? (p.details.error as string | undefined) ?? ""}</span></td>
                  <td className="py-2 pr-3 tabular-nums">{p.status_code ?? "—"}</td>
                  <td className="py-2 pr-3 tabular-nums">{p.word_count ?? "—"}</td>
                  <td className="py-2 pr-3 tabular-nums">{p.inlinks}</td>
                  <td className="py-2 pr-3 tabular-nums">{p.load_ms != null ? `${p.load_ms} ms` : "—"}</td>
                  <td className="min-w-72 py-2 pr-4 text-xs text-muted-foreground" data-testid="page-issues">
                    {p.issues.length ? (
                      <ul className="space-y-1">
                        {[...p.issues].sort((x, y) => (x === issue ? -1 : y === issue ? 1 : 0)).map((code) => {
                          const ev = (p.details.evidence as Record<string, string[]> | undefined)?.[code] ?? [];
                          const name = ISSUE_INFO[code]?.label ?? code;
                          return (
                            <li key={code}>
                              {ev.length ? (
                                <details open={code === issue} className="group">
                                  <summary className={`cursor-pointer select-none ${code === issue ? "font-medium text-foreground" : ""}`}>{name}</summary>
                                  <ul className="mt-1 space-y-0.5 border-l pl-2" data-testid="evidence">
                                    {ev.map((e) => <li key={e} className="break-all"><Evidence text={e} /></li>)}
                                  </ul>
                                </details>
                              ) : <span className={code === issue ? "font-medium text-foreground" : ""}>{name}</span>}
                            </li>
                          );
                        })}
                      </ul>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
