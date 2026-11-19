import "server-only";
import { unwrap } from "@/lib/actions/result";
import { toCsv } from "@/lib/csv/write";
import { detectInsights, type PerfRow } from "@/lib/analytics/insights";
import type { SessionContext } from "@/lib/auth/session";

export type Totals = { clicks: number; impressions: number; ctr: number; position: number };
export type DailyPoint = { date: string; clicks: number; impressions: number; sessions: number };

const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

function totals(rows: PerfRow[]): Totals {
  const clicks = rows.reduce((n, r) => n + r.clicks, 0);
  const impressions = rows.reduce((n, r) => n + r.impressions, 0);
  const pw = rows.reduce((n, r) => n + r.position * r.impressions, 0);
  return { clicks, impressions, ctr: impressions ? Math.round((clicks / impressions) * 1000) / 10 : 0, position: impressions ? Math.round((pw / impressions) * 10) / 10 : 0 };
}

async function perfRows(ctx: SessionContext, websiteId: string, since: string): Promise<PerfRow[]> {
  const out: PerfRow[] = [];
  // Page through rows (PostgREST caps responses); bounded for dashboard use.
  for (let from = 0; from < 200_000; from += 10_000) {
    const page = (unwrap(await ctx.supabase.from("search_performance_daily").select("date, query, page, clicks, impressions, position")
      .eq("website_id", websiteId).eq("organization_id", ctx.org.id).gte("date", since).order("date").range(from, from + 9_999)) ?? []) as PerfRow[];
    out.push(...page.map((r) => ({ ...r, position: Number(r.position) })));
    if (page.length < 10_000) break;
  }
  return out;
}

export async function analyticsDashboard(ctx: SessionContext, websiteId: string, days: number) {
  const since = day(days), prevSince = day(days * 2);
  const all = await perfRows(ctx, websiteId, day(Math.max(56, days * 2)));
  const current = all.filter((r) => r.date >= since);
  const previous = all.filter((r) => r.date >= prevSince && r.date < since);

  const traffic = (unwrap(await ctx.supabase.from("traffic_daily").select("source, date, page, metrics").eq("website_id", websiteId).eq("organization_id", ctx.org.id)
    .gte("date", day(Math.max(days, 186))).order("date").limit(50_000)) ?? []) as { source: string; date: string; page: string; metrics: Record<string, number> }[];

  const series = new Map<string, DailyPoint>();
  for (let i = days - 1; i >= 0; i--) series.set(day(i), { date: day(i), clicks: 0, impressions: 0, sessions: 0 });
  for (const r of current) {
    const p = series.get(r.date);
    if (p) { p.clicks += r.clicks; p.impressions += r.impressions; }
  }
  for (const t of traffic) if (t.source === "ga4" && series.has(t.date)) series.get(t.date)!.sessions += Number(t.metrics.sessions ?? 0);

  const group = (key: "query" | "page") => {
    const m = new Map<string, PerfRow[]>();
    for (const r of current) m.set(r[key], [...(m.get(r[key]) ?? []), r]);
    return [...m.entries()].map(([k, rows]) => ({ key: k, ...totals(rows) })).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, 50);
  };

  const ga4 = traffic.filter((t) => t.source === "ga4" && t.date >= since);
  const ga4Pages = new Map<string, { sessions: number; conversions: number; engaged: number }>();
  for (const t of ga4) {
    const a = ga4Pages.get(t.page) ?? { sessions: 0, conversions: 0, engaged: 0 };
    a.sessions += Number(t.metrics.sessions ?? 0); a.conversions += Number(t.metrics.conversions ?? 0); a.engaged += Number(t.metrics.engaged_sessions ?? 0);
    ga4Pages.set(t.page, a);
  }
  const clarity = traffic.filter((t) => t.source === "clarity");
  const latestClarity = clarity.length ? clarity[clarity.length - 1].date : null;

  const visibility = (unwrap(await ctx.supabase.from("ai_visibility_checks").select("query, engine, cited, mentioned, checked_at").eq("website_id", websiteId)
    .eq("organization_id", ctx.org.id).order("checked_at", { ascending: false }).limit(500)) ?? []) as { query: string; engine: string; cited: boolean; mentioned: boolean; checked_at: string }[];
  const latestByQuery = new Map<string, (typeof visibility)[number]>();
  for (const v of visibility) if (!latestByQuery.has(`${v.engine}:${v.query}`)) latestByQuery.set(`${v.engine}:${v.query}`, v);
  const latest = [...latestByQuery.values()];

  return {
    hasSearchData: all.length > 0,
    totals: totals(current),
    previous: totals(previous),
    // Search Console reports with a 2–3 day delay; end the chart at the last day with data.
    series: (() => { const pts = [...series.values()]; while (pts.length > 1 && !pts[pts.length - 1].clicks && !pts[pts.length - 1].impressions && !pts[pts.length - 1].sessions) pts.pop(); return pts; })(),
    topQueries: group("query"),
    topPages: group("page"),
    insights: detectInsights(all),
    ga4: {
      connected: traffic.some((t) => t.source === "ga4"),
      sessions: ga4.reduce((n, t) => n + Number(t.metrics.sessions ?? 0), 0),
      conversions: ga4.reduce((n, t) => n + Number(t.metrics.conversions ?? 0), 0),
      topPages: [...ga4Pages.entries()].map(([page, a]) => ({ page, ...a })).sort((a, b) => b.sessions - a.sessions).slice(0, 20),
    },
    clarity: {
      date: latestClarity,
      pages: clarity.filter((t) => t.date === latestClarity).map((t) => ({ page: t.page, metrics: t.metrics })).slice(0, 50),
    },
    similarweb: traffic.filter((t) => t.source === "similarweb").map((t) => ({ month: t.date.slice(0, 7), visits: Number(t.metrics.visits ?? 0) })),
    aiVisibility: {
      checked: latest.length,
      cited: latest.filter((v) => v.cited).length,
      byEngine: ["claude_web_search", "google_ai_overview"].map((engine) => {
        const rows = latest.filter((v) => v.engine === engine);
        return { engine, checked: rows.length, cited: rows.filter((v) => v.cited).length };
      }),
      recent: latest.slice(0, 20),
    },
  };
}

export async function searchCsv(ctx: SessionContext, websiteId: string, days: number): Promise<string> {
  const rows = await perfRows(ctx, websiteId, day(days));
  return toCsv(["date", "query", "page", "clicks", "impressions", "position"], rows.map((r) => [r.date, r.query, r.page, r.clicks, r.impressions, r.position]));
}
