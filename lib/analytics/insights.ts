/**
 * Automated opportunity detection from Search Console data. Pure functions over
 * daily query×page rows so they are easy to test and to run in SQL-free contexts.
 */
export type PerfRow = { date: string; query: string; page: string; clicks: number; impressions: number; position: number };

export type Insight =
  | { type: "striking_distance"; query: string; page: string; impressions: number; clicks: number; position: number; action: string }
  | { type: "low_ctr"; query: string; page: string; impressions: number; ctr: number; expectedCtr: number; position: number; action: string }
  | { type: "content_decay"; page: string; clicksNow: number; clicksBefore: number; change: number; action: string }
  | { type: "cannibalization"; query: string; impressions: number; pages: { page: string; impressions: number; position: number }[]; action: string };

/** Approximate organic CTR by position (industry averages; used only to flag outliers). */
const EXPECTED_CTR = [0, 0.28, 0.15, 0.11, 0.08, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02];

type Agg = { clicks: number; impressions: number; posWeighted: number };
const add = (m: Map<string, Agg>, k: string, r: PerfRow) => {
  const a = m.get(k) ?? { clicks: 0, impressions: 0, posWeighted: 0 };
  a.clicks += r.clicks; a.impressions += r.impressions; a.posWeighted += r.position * r.impressions;
  m.set(k, a);
};
const pos = (a: Agg) => (a.impressions ? a.posWeighted / a.impressions : 0);
const r1 = (n: number) => Math.round(n * 10) / 10;

export function detectInsights(rows: PerfRow[], today = new Date(), opts: { minImpressions?: number } = {}): Insight[] {
  const minImp = opts.minImpressions ?? 50;
  const day = (offset: number) => new Date(today.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
  const recentStart = day(28), prevStart = day(56);
  const recent = rows.filter((r) => r.date >= recentStart);
  const previous = rows.filter((r) => r.date >= prevStart && r.date < recentStart);

  const pair = new Map<string, Agg>();
  const byQuery = new Map<string, Map<string, Agg>>();
  for (const r of recent) {
    add(pair, `${r.query}\u0000${r.page}`, r);
    if (!byQuery.has(r.query)) byQuery.set(r.query, new Map());
    add(byQuery.get(r.query)!, r.page, r);
  }
  const out: Insight[] = [];
  for (const [k, a] of pair) {
    const [query, page] = k.split("\u0000");
    const p = pos(a);
    if (a.impressions >= minImp && p >= 8 && p <= 20) {
      out.push({ type: "striking_distance", query, page, impressions: a.impressions, clicks: a.clicks, position: r1(p), action: `Improve this page for “${query}” (expand the section, add it to headings, add internal links) to move from position ${r1(p)} onto page one.` });
    }
    const rounded = Math.round(p);
    if (a.impressions >= minImp * 2 && rounded >= 1 && rounded <= 5) {
      const ctr = a.clicks / a.impressions;
      const expected = EXPECTED_CTR[rounded];
      if (ctr < expected * 0.5) {
        out.push({ type: "low_ctr", query, page, impressions: a.impressions, ctr: Math.round(ctr * 1000) / 10, expectedCtr: Math.round(expected * 1000) / 10, position: r1(p), action: "Rewrite the title and meta description to match the query's intent; consider FAQ/HowTo schema for richer results." });
      }
    }
  }
  for (const [query, pages] of byQuery) {
    const total = [...pages.values()].reduce((n, a) => n + a.impressions, 0);
    if (total < minImp) continue;
    const competing = [...pages.entries()].filter(([, a]) => a.impressions / total >= 0.15 && pos(a) <= 30);
    if (competing.length >= 2) {
      out.push({
        type: "cannibalization", query, impressions: total,
        pages: competing.map(([page, a]) => ({ page, impressions: a.impressions, position: r1(pos(a)) })).sort((a, b) => b.impressions - a.impressions),
        action: "Several pages compete for this query. Consolidate them (merge and 301-redirect) or differentiate their topics and internal anchor text.",
      });
    }
  }
  const pageNow = new Map<string, number>(), pageBefore = new Map<string, number>();
  for (const r of recent) pageNow.set(r.page, (pageNow.get(r.page) ?? 0) + r.clicks);
  for (const r of previous) pageBefore.set(r.page, (pageBefore.get(r.page) ?? 0) + r.clicks);
  for (const [page, before] of pageBefore) {
    const now = pageNow.get(page) ?? 0;
    if (before >= 20 && now <= before * 0.7) {
      out.push({ type: "content_decay", page, clicksNow: now, clicksBefore: before, change: Math.round(((now - before) / before) * 100), action: "Clicks dropped by 30%+ versus the previous 28 days. Refresh the content (update facts and dates, cover new subtopics) and check for lost rankings." });
    }
  }
  const rank = (i: Insight) => ("impressions" in i ? i.impressions : i.type === "content_decay" ? i.clicksBefore * 10 : 0);
  return out.sort((a, b) => rank(b) - rank(a)).slice(0, 200);
}
