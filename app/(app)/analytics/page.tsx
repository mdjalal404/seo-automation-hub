import { LineChart as LineIcon } from "lucide-react";
import Link from "next/link";
import { startTaskAction } from "@/app/actions/seo";
import { ActionButton } from "@/components/common/action-button";
import { EmptyState, PageHeader, StatCard } from "@/components/common/page-header";
import { ToneBadge } from "@/components/common/status-badge";
import { LineChart } from "@/components/seo/line-chart";
import { WebsitePicker } from "@/components/seo/website-picker";
import type { Insight } from "@/lib/analytics/insights";
import { can } from "@/lib/auth/permissions";
import { requireWorkspace } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { param } from "@/lib/pages";
import { analyticsDashboard } from "@/lib/services/analytics";
import { impactReport } from "@/lib/services/automation";
import { listIntegrations } from "@/lib/services/seo";
import { pickWebsite } from "@/lib/services/site-picker";
import { cn } from "@/lib/utils";

export const metadata = { title: "Analytics" };
const RANGES = [7, 28, 90];
const INSIGHT_LABEL: Record<Insight["type"], [string, "info" | "warning" | "danger" | "progress"]> = {
  striking_distance: ["Striking distance", "info"], low_ctr: ["Low CTR", "warning"], content_decay: ["Content decay", "danger"], cannibalization: ["Cannibalization", "progress"],
};

function delta(now: number, before: number, invert = false) {
  if (!before) return null;
  const pct = Math.round(((now - before) / before) * 100);
  const good = invert ? pct < 0 : pct > 0;
  return <span className={good ? "text-emerald-600" : pct === 0 ? "" : "text-red-600"}>{pct > 0 ? "+" : ""}{pct}% vs previous period</span>;
}
const CLARITY_LABEL: Record<string, string> = {
  "traffic.totalsessioncount": "sessions", "scrolldepth.averagescrolldepth": "avg scroll", "rageclickcount.sessionswithmetricpercentage": "rage clicks",
  "deadclickcount.sessionswithmetricpercentage": "dead clicks", "quickbackclick.sessionswithmetricpercentage": "quick backs",
};
const path = (u: string) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };

export default async function AnalyticsPage({ searchParams }: PageProps<"/analytics">) {
  const sp = await searchParams;
  const days = RANGES.includes(Number(param(sp.days))) ? Number(param(sp.days)) : 28;
  const ctx = await requireWorkspace();
  const { websites, selected } = await pickWebsite(ctx, param(sp.website));
  if (!selected) return (<><PageHeader title="Analytics" /><EmptyState icon={<LineIcon className="size-6" />} title="Add a website first" action={<Link className="underline" href="/websites">Websites</Link>} /></>);
  const [d, integrations, impact] = await Promise.all([analyticsDashboard(ctx, selected.id, days), can(ctx.role, "integrations.manage") ? listIntegrations(ctx, selected.id) : Promise.resolve([]), impactReport(ctx, selected.id)]);
  const lastSync = integrations.map((i) => i.last_synced_at).filter(Boolean).sort().pop();

  return (
    <>
      <PageHeader
        title="Analytics"
        description={<>Organic search data from Search Console, GA4, Clarity, Similarweb and AI-engine checks. {lastSync ? `Last sync ${formatDateTime(lastSync)}.` : ""}</>}
        actions={<>
          <WebsitePicker websites={websites} value={selected.id} />
          <div className="flex gap-1 text-sm">{RANGES.map((r) => <Link key={r} href={`/analytics?website=${selected.id}&days=${r}`} className={cn("rounded-md px-2.5 py-1", r === days ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted")}>{r}d</Link>)}</div>
          {can(ctx.role, "seo.run") ? <ActionButton size="sm" variant="outline" action={startTaskAction.bind(null, selected.id, "ANALYTICS_SYNC", {})}>Sync now</ActionButton> : null}
          {d.hasSearchData ? <a className="text-sm underline" href={`/api/analytics/export?website=${selected.id}&days=${Math.max(days, 90)}`}>Export CSV</a> : null}
        </>}
      />
      {!d.hasSearchData && !d.ga4.connected && !d.aiVisibility.checked ? (
        <EmptyState icon={<LineIcon className="size-6" />} title="No analytics data yet" description="Connect Google Search Console (and optionally GA4, Clarity, Similarweb, DataForSEO) and run a sync." action={<Link className="underline" href={`/integrations?website=${selected.id}`}>Connect integrations</Link>} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" data-testid="analytics-kpis">
            <StatCard label="Clicks" value={d.totals.clicks.toLocaleString()} hint={delta(d.totals.clicks, d.previous.clicks)} />
            <StatCard label="Impressions" value={d.totals.impressions.toLocaleString()} hint={delta(d.totals.impressions, d.previous.impressions)} />
            <StatCard label="CTR" value={`${d.totals.ctr}%`} hint={delta(d.totals.ctr, d.previous.ctr)} />
            <StatCard label="Avg. position" value={d.totals.position || "—"} hint={delta(d.totals.position, d.previous.position, true)} />
            <StatCard label="Organic sessions (GA4)" value={d.ga4.connected ? d.ga4.sessions.toLocaleString() : "—"} hint={d.ga4.connected ? `${d.ga4.conversions.toLocaleString()} key events` : "Connect GA4"} />
          </div>
          {d.hasSearchData ? (
            <section className="mt-6 rounded-xl border bg-card p-4">
              <LineChart points={d.series} series={[{ key: "clicks", label: "Clicks", color: "#2563eb" }, { key: "impressions", label: "Impressions", color: "#a855f7" }, ...(d.ga4.connected ? [{ key: "sessions", label: "GA4 sessions", color: "#10b981" }] : [])]} />
            </section>
          ) : null}

          <section className="mt-6 rounded-xl border bg-card">
            <h2 className="border-b px-4 py-3 text-sm font-semibold">Opportunities (automatically detected, last 28 days)</h2>
            {d.insights.length ? (
              <ul className="divide-y text-sm" data-testid="insights">
                {d.insights.slice(0, 30).map((i, n) => (
                  <li key={n} className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <ToneBadge tone={INSIGHT_LABEL[i.type][1]}>{INSIGHT_LABEL[i.type][0]}</ToneBadge>
                      {"query" in i ? <span className="font-medium">“{i.query}”</span> : null}
                      {"page" in i ? <span className="truncate text-muted-foreground">{path(i.page)}</span> : null}
                      <span className="text-xs text-muted-foreground">
                        {i.type === "striking_distance" ? `pos ${i.position} · ${i.impressions.toLocaleString()} impressions` : i.type === "low_ctr" ? `pos ${i.position} · CTR ${i.ctr}% (typical ${i.expectedCtr}%)` : i.type === "content_decay" ? `${i.clicksBefore} → ${i.clicksNow} clicks (${i.change}%)` : `${i.pages.length} pages · ${i.impressions.toLocaleString()} impressions`}
                      </span>
                    </div>
                    {i.type === "cannibalization" ? <ul className="mt-1 text-xs text-muted-foreground">{i.pages.map((p) => <li key={p.page}>{path(p.page)} — {p.impressions} impr., pos {p.position}</li>)}</ul> : null}
                    <p className="mt-1 text-xs text-muted-foreground">{i.action}</p>
                  </li>
                ))}
              </ul>
            ) : <p className="px-4 py-6 text-sm text-muted-foreground">No opportunities detected yet — they appear once Search Console data covers a few weeks.</p>}
          </section>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            {([["Top queries", d.topQueries], ["Top pages", d.topPages]] as const).map(([title, rows]) => (
              <section key={title} className="rounded-xl border bg-card">
                <h2 className="border-b px-4 py-3 text-sm font-semibold">{title}</h2>
                {rows.length ? (
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs text-muted-foreground"><tr className="border-b"><th className="px-4 py-2" /><th className="py-2 pr-3 text-right">Clicks</th><th className="py-2 pr-3 text-right">Impr.</th><th className="py-2 pr-3 text-right">CTR</th><th className="py-2 pr-4 text-right">Pos.</th></tr></thead>
                    <tbody className="divide-y">{rows.slice(0, 15).map((r) => (
                      <tr key={r.key}><td className="max-w-[16rem] truncate px-4 py-1.5">{title === "Top pages" ? path(r.key) : r.key}</td><td className="py-1.5 pr-3 text-right tabular-nums">{r.clicks}</td><td className="py-1.5 pr-3 text-right tabular-nums">{r.impressions}</td><td className="py-1.5 pr-3 text-right tabular-nums">{r.ctr}%</td><td className="py-1.5 pr-4 text-right tabular-nums">{r.position}</td></tr>
                    ))}</tbody>
                  </table>
                ) : <p className="px-4 py-6 text-sm text-muted-foreground">No Search Console data.</p>}
              </section>
            ))}
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-3">
            <section className="rounded-xl border bg-card" data-testid="ai-visibility-summary">
              <h2 className="border-b px-4 py-3 text-sm font-semibold">AI search visibility</h2>
              <div className="px-4 py-3 text-sm">
                {d.aiVisibility.checked ? (
                  <>
                    <p className="text-2xl font-semibold tabular-nums">{d.aiVisibility.cited}/{d.aiVisibility.checked}</p>
                    <p className="text-xs text-muted-foreground">queries where an AI answer cites this site (latest check per query)</p>
                    <ul className="mt-2 text-xs text-muted-foreground">{d.aiVisibility.byEngine.filter((e) => e.checked).map((e) => <li key={e.engine}>{e.engine === "claude_web_search" ? "Claude with web search" : "Google AI Overviews (DataForSEO)"}: {e.cited}/{e.checked}</li>)}</ul>
                    <ul className="mt-3 divide-y border-t">{d.aiVisibility.recent.slice(0, 8).map((v) => <li key={`${v.engine}${v.query}`} className="flex items-center gap-2 py-1.5"><ToneBadge tone={v.cited ? "success" : "neutral"}>{v.cited ? "cited" : "not cited"}</ToneBadge><span className="truncate">{v.query}</span></li>)}</ul>
                  </>
                ) : <p className="text-muted-foreground">Run an AI visibility check from Keywords (select queries) or schedule one under autopilot.</p>}
              </div>
            </section>
            <section className="rounded-xl border bg-card">
              <h2 className="border-b px-4 py-3 text-sm font-semibold">Behaviour (Microsoft Clarity)</h2>
              {d.clarity.pages.length ? (
                <ul className="divide-y text-xs">{d.clarity.pages.slice(0, 10).map((p) => (
                  <li key={p.page} className="px-4 py-1.5"><span className="block truncate font-medium">{path(p.page)}</span><span className="text-muted-foreground">{Object.entries(p.metrics).filter(([k]) => CLARITY_LABEL[k]).map(([k, v]) => `${CLARITY_LABEL[k]} ${v}${k.includes("percentage") || k.includes("depth") ? "%" : ""}`).join(" · ")}</span></li>
                ))}</ul>
              ) : <p className="px-4 py-6 text-sm text-muted-foreground">Connect Clarity to see rage clicks, dead clicks and scroll depth per page.</p>}
            </section>
            <section className="rounded-xl border bg-card">
              <h2 className="border-b px-4 py-3 text-sm font-semibold">Traffic estimate (Similarweb)</h2>
              {d.similarweb.length ? (
                <ul className="divide-y text-sm">{d.similarweb.map((m) => <li key={m.month} className="flex justify-between px-4 py-1.5"><span>{m.month}</span><span className="tabular-nums">{m.visits.toLocaleString()} visits</span></li>)}</ul>
              ) : <p className="px-4 py-6 text-sm text-muted-foreground">Connect Similarweb for monthly visit estimates (all channels).</p>}
            </section>
          </div>
          <section className="mt-6 rounded-xl border bg-card" data-testid="impact">
            <h2 className="border-b px-4 py-3 text-sm font-semibold">Impact of changes (Search Console, 28 days before vs after)</h2>
            {impact.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground"><tr className="border-b"><th className="px-4 py-2">Change</th><th className="py-2 pr-3">Date</th><th className="py-2 pr-3 text-right">Clicks before → after</th><th className="py-2 pr-3 text-right">Clicks/day</th><th className="py-2 pr-4 text-right">Position</th></tr></thead>
                  <tbody className="divide-y">{impact.map((r) => (
                    <tr key={r.id + r.date}>
                      <td className="max-w-sm px-4 py-1.5"><span className="block truncate">{r.label}</span><span className="block truncate text-xs text-muted-foreground">{path(r.url)}</span></td>
                      <td className="py-1.5 pr-3 tabular-nums">{r.date}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{r.before.clicks} → {r.after.clicks}{r.complete ? "" : " (so far)"}</td>
                      <td className={cn("py-1.5 pr-3 text-right tabular-nums", r.clicksChange == null ? "" : r.clicksChange >= 0 ? "text-emerald-600" : "text-red-600")}>{r.clicksChange == null ? "—" : `${r.clicksChange > 0 ? "+" : ""}${r.clicksChange}%`}</td>
                      <td className="py-1.5 pr-4 text-right tabular-nums">{r.before.position ?? "—"} → {r.after.position ?? "—"}</td>
                    </tr>
                  ))}</tbody>
                </table>
                <p className="px-4 py-2 text-xs text-muted-foreground">Before/after windows skip 3 days after the change. Seasonality and algorithm updates are not controlled for — treat as directional.</p>
              </div>
            ) : <p className="px-4 py-6 text-sm text-muted-foreground">Published articles and completed agent proposals appear here once Search Console data covers them.</p>}
          </section>
          <p className="mt-6 text-xs text-muted-foreground">SQL access: the <code>v_page_performance</code> view and the <code>search_performance_daily</code> / <code>traffic_daily</code> tables hold the modeled data (RLS applies). See README → Analytics.</p>
        </>
      )}
    </>
  );
}
