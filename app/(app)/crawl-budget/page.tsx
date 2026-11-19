import { ScrollText } from "lucide-react";
import Link from "next/link";
import { EmptyState, PageHeader, StatCard } from "@/components/common/page-header";
import { ToneBadge } from "@/components/common/status-badge";
import { LineChart } from "@/components/seo/line-chart";
import { WebsitePicker } from "@/components/seo/website-picker";
import type { SiteChecks } from "@/lib/audit/crawler";
import { can } from "@/lib/auth/permissions";
import { requireWorkspace } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { param } from "@/lib/pages";
import { listLogAnalyses } from "@/lib/services/automation";
import { listAudits } from "@/lib/services/seo";
import { pickWebsite } from "@/lib/services/site-picker";
import { LogUpload } from "./log-upload";

export const metadata = { title: "Crawl budget & logs" };

export default async function CrawlBudgetPage({ searchParams }: PageProps<"/crawl-budget">) {
  const ctx = await requireWorkspace();
  const { websites, selected } = await pickWebsite(ctx, param((await searchParams).website));
  if (!selected) return (<><PageHeader title="Crawl budget & logs" /><EmptyState icon={<ScrollText className="size-6" />} title="Add a website first" action={<Link className="underline" href="/websites">Websites</Link>} /></>);
  const [analyses, audits] = await Promise.all([listLogAnalyses(ctx, selected.id), listAudits(ctx, selected.id)]);
  const a = analyses[0];
  const site = audits[0]?.site_checks as (SiteChecks & { partial?: boolean }) | undefined;
  const g = a?.summary.google;

  return (
    <>
      <PageHeader title="Crawl budget & logs" description="How search and AI bots actually crawl the site (server logs), where crawl budget is wasted, and parameter, sitemap and hreflang hygiene from the latest audit." actions={<WebsitePicker websites={websites} value={selected.id} />} />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="grid content-start gap-6">
          {a && g ? (
            <>
              <p className="text-sm text-muted-foreground">Latest log: <span className="font-medium text-foreground">{a.source_name}</span> · {a.summary.dateRange ? `${a.summary.dateRange[0]} → ${a.summary.dateRange[1]}` : ""} · {a.lines_parsed.toLocaleString()} of {a.lines_total.toLocaleString()} lines parsed · analyzed {formatDateTime(a.created_at)}</p>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="log-kpis">
                <StatCard label="Googlebot requests" value={g.hits.toLocaleString()} hint={`${g.uniqueUrls.toLocaleString()} unique URLs`} />
                <StatCard label="Crawl waste" value={`${g.waste.percent}%`} hint={`${g.waste.total.toLocaleString()} requests to redirects, errors or parameter URLs`} />
                <StatCard label="Errors served to Googlebot" value={(g.waste.clientErrors + g.waste.serverErrors).toLocaleString()} hint={`${g.waste.serverErrors} server errors`} />
                <StatCard label="Indexable pages not crawled" value={a.summary.uncrawled ? a.summary.uncrawled.count : "—"} hint={a.summary.uncrawled ? "From the latest audit, in this log window" : "Run a site audit to compare"} />
              </div>
              {g.byDay.length > 1 ? <section className="rounded-xl border bg-card p-4"><LineChart points={g.byDay} series={[{ key: "hits", label: "Googlebot requests", color: "#2563eb" }]} /></section> : null}
              <div className="grid gap-6 md:grid-cols-2">
                <section className="rounded-xl border bg-card">
                  <h2 className="border-b px-4 py-3 text-sm font-semibold">Googlebot by section</h2>
                  <ul className="divide-y text-sm">{g.bySection.slice(0, 12).map((s) => <li key={s.section} className="flex justify-between px-4 py-1.5"><code>{s.section}</code><span className="tabular-nums">{s.hits.toLocaleString()}</span></li>)}</ul>
                </section>
                <section className="rounded-xl border bg-card">
                  <h2 className="border-b px-4 py-3 text-sm font-semibold">Status codes & waste</h2>
                  <ul className="divide-y text-sm">
                    {Object.entries(g.byStatus).sort((x, y) => y[1] - x[1]).map(([code, n]) => <li key={code} className="flex justify-between px-4 py-1.5"><ToneBadge tone={Number(code) >= 500 ? "danger" : Number(code) >= 400 ? "warning" : Number(code) >= 300 ? "neutral" : "success"}>{code}</ToneBadge><span className="tabular-nums">{n.toLocaleString()}</span></li>)}
                    <li className="flex justify-between px-4 py-1.5"><span>Parameter URLs</span><span className="tabular-nums">{g.parameterHits.toLocaleString()}</span></li>
                    <li className="flex justify-between px-4 py-1.5"><span>Static assets</span><span className="tabular-nums">{g.assetHits.toLocaleString()}</span></li>
                  </ul>
                </section>
                <section className="rounded-xl border bg-card">
                  <h2 className="border-b px-4 py-3 text-sm font-semibold">Most-crawled parameters</h2>
                  {g.topParameters.length ? <ul className="divide-y text-sm">{g.topParameters.map((p) => <li key={p.name} className="flex justify-between px-4 py-1.5"><code>?{p.name}=</code><span className="tabular-nums">{p.hits.toLocaleString()}</span></li>)}</ul> : <p className="px-4 py-4 text-sm text-muted-foreground">None.</p>}
                </section>
                <section className="rounded-xl border bg-card">
                  <h2 className="border-b px-4 py-3 text-sm font-semibold">Error URLs crawled most</h2>
                  {g.errorUrls.length ? <ul className="divide-y text-xs">{g.errorUrls.slice(0, 12).map((u) => <li key={u.url} className="flex gap-2 px-4 py-1.5"><ToneBadge tone={u.status >= 500 ? "danger" : "warning"}>{u.status}</ToneBadge><span className="min-w-0 flex-1 truncate">{u.url}</span><span className="tabular-nums">{u.hits}</span></li>)}</ul> : <p className="px-4 py-4 text-sm text-muted-foreground">None.</p>}
                </section>
              </div>
              <section className="rounded-xl border bg-card">
                <h2 className="border-b px-4 py-3 text-sm font-semibold">All bots</h2>
                <ul className="divide-y text-sm" data-testid="log-bots">{a.summary.bots.map((b) => <li key={b.name} className="flex items-center gap-2 px-4 py-1.5"><ToneBadge tone={b.group === "ai" ? "progress" : b.group === "search" ? "info" : "neutral"}>{b.group}</ToneBadge><span>{b.name}</span><span className="ml-auto tabular-nums">{b.hits.toLocaleString()}</span></li>)}</ul>
              </section>
              {a.summary.uncrawled?.sample.length ? (
                <section className="rounded-xl border bg-card">
                  <h2 className="border-b px-4 py-3 text-sm font-semibold">Indexable pages Googlebot did not request</h2>
                  <ul className="divide-y text-xs">{a.summary.uncrawled.sample.map((u) => <li key={u} className="truncate px-4 py-1.5">{u}</li>)}</ul>
                </section>
              ) : null}
            </>
          ) : <EmptyState icon={<ScrollText className="size-6" />} title="No log analyzed yet" description="Upload a server access log to see how Googlebot and AI bots spend their crawl budget." />}
        </div>
        <aside className="grid content-start gap-4">
          {can(ctx.role, "seo.run") ? <section className="rounded-xl border bg-card p-4"><LogUpload websiteId={selected.id} /></section> : null}
          <section className="rounded-xl border bg-card p-4 text-sm" data-testid="crawl-hygiene">
            <h2 className="font-semibold">From the latest audit</h2>
            {site?.crawlBudget ? (
              <ul className="mt-2 grid gap-1.5 text-muted-foreground">
                <li>{site.crawlBudget.parameterUrls} parameter URLs discovered{site.crawlBudget.parameters.length ? `: ${site.crawlBudget.parameters.slice(0, 5).map((p) => `?${p.name}`).join(", ")}` : ""}</li>
                <li>{site.crawlBudget.sitemapNonIndexable} non-indexable URLs in the sitemap</li>
                <li>hreflang on {site.hreflang?.pages ?? 0} pages{site.hreflang?.languages.length ? ` (${site.hreflang.languages.join(", ")})` : ""}</li>
                <li><Link className="underline" href={`/audits/${audits[0].id}`}>Open audit report</Link></li>
              </ul>
            ) : <p className="mt-2 text-muted-foreground">Run a site audit to see parameter, sitemap and hreflang hygiene.</p>}
          </section>
          {analyses.length > 1 ? (
            <section className="rounded-xl border bg-card">
              <h2 className="border-b px-4 py-3 text-sm font-semibold">Earlier logs</h2>
              <ul className="divide-y text-xs">{analyses.slice(1).map((x) => <li key={x.id} className="px-4 py-1.5">{x.source_name} · {x.summary.google.hits.toLocaleString()} Googlebot · {x.summary.google.waste.percent}% waste</li>)}</ul>
            </section>
          ) : null}
        </aside>
      </div>
    </>
  );
}
