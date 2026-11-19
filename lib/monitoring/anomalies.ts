import type { PerfRow } from "@/lib/analytics/insights";
import type { Finding } from "@/lib/monitoring/diff";

/**
 * Search Console anomaly detection: the most recent 7 days of data against the 28 days
 * before them, as daily averages. A drop is reported only when it is both large (relative)
 * and statistically unusual (z-score of the 7-day mean against the baseline's daily spread),
 * so normal weekday noise on small sites does not page anyone.
 */
export type AnomalyOptions = { recentDays?: number; baselineDays?: number; siteDropPct?: number; pageDropPct?: number; minSiteClicksPerDay?: number; minPageClicksPerDay?: number; positionDrop?: number; minImpressions?: number };

const addDays = (date: string, n: number) => new Date(new Date(`${date}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const pct = (n: number) => `${n > 0 ? "+" : ""}${Math.round(n * 100)}%`;
const r1 = (n: number) => Math.round(n * 10) / 10;

export function detectTrafficAnomalies(rows: PerfRow[], opts: AnomalyOptions = {}): Finding[] {
  const recentDays = opts.recentDays ?? 7, baselineDays = opts.baselineDays ?? 28;
  if (!rows.length) return [];
  const last = rows.reduce((m, r) => (r.date > m ? r.date : m), "");
  const recentFrom = addDays(last, -(recentDays - 1));
  const baseFrom = addDays(recentFrom, -baselineDays), baseTo = addDays(recentFrom, -1);
  const period = `${recentFrom} to ${last} vs ${baseFrom} to ${baseTo}`;
  const inRecent = (d: string) => d >= recentFrom && d <= last;
  const inBase = (d: string) => d >= baseFrom && d <= baseTo;
  const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => addDays(from, i));
  const series = (filter: (r: PerfRow) => boolean, ds: string[]) => {
    const m = new Map(ds.map((d) => [d, 0]));
    for (const r of rows) if (filter(r) && m.has(r.date)) m.set(r.date, m.get(r.date)! + r.clicks);
    return [...m.values()];
  };
  const out: Finding[] = [];

  // Whole site.
  const base = series(() => true, days(baseFrom, baselineDays)), recent = series(() => true, days(recentFrom, recentDays));
  const bm = mean(base), rm = mean(recent);
  const change = bm ? (rm - bm) / bm : 0;
  const z = sd(base) ? (rm - bm) / (sd(base) / Math.sqrt(recentDays)) : 0;
  if (bm >= (opts.minSiteClicksPerDay ?? 5) && change <= -(opts.siteDropPct ?? 0.25) && z <= -2) {
    out.push({
      kind: "traffic_drop", severity: change <= -0.5 ? "critical" : "warning", title: `Organic clicks down ${pct(change)}`, url: null, fingerprint: "traffic:traffic_drop:site",
      evidence: [`${r1(rm)} clicks/day in the last ${recentDays} days vs ${r1(bm)} before (${period})`, `z-score ${r1(z)} against the baseline's daily variation`],
    });
  }

  // Pages.
  const pages = new Map<string, { b: number; r: number }>();
  for (const x of rows) {
    const e = pages.get(x.page) ?? { b: 0, r: 0 };
    if (inBase(x.date)) e.b += x.clicks; else if (inRecent(x.date)) e.r += x.clicks;
    pages.set(x.page, e);
  }
  const pageDrops = [...pages.entries()].map(([page, v]) => ({ page, b: v.b / baselineDays, r: v.r / recentDays }))
    .filter((p) => p.b >= (opts.minPageClicksPerDay ?? 2) && (p.r - p.b) / p.b <= -(opts.pageDropPct ?? 0.4))
    .sort((a, b) => (b.b - b.r) - (a.b - a.r)).slice(0, 10);
  for (const p of pageDrops) {
    out.push({
      kind: "page_traffic_drop", severity: "warning", title: `Page clicks down ${pct((p.r - p.b) / p.b)}`, url: p.page, fingerprint: `traffic:page_traffic_drop:${p.page}`,
      evidence: [`${r1(p.r)} clicks/day in the last ${recentDays} days vs ${r1(p.b)} before (${period})`],
    });
  }

  // Rankings: impression-weighted position per query.
  const qs = new Map<string, { bi: number; bp: number; ri: number; rp: number; page: string }>();
  for (const x of rows) {
    const e = qs.get(x.query) ?? { bi: 0, bp: 0, ri: 0, rp: 0, page: x.page };
    if (inBase(x.date)) { e.bi += x.impressions; e.bp += x.position * x.impressions; } else if (inRecent(x.date)) { e.ri += x.impressions; e.rp += x.position * x.impressions; e.page = x.page; }
    qs.set(x.query, e);
  }
  const rankDrops = [...qs.entries()].filter(([, v]) => v.bi >= (opts.minImpressions ?? 50) && v.ri > 0)
    .map(([query, v]) => ({ query, page: v.page, before: v.bp / v.bi, after: v.rp / v.ri }))
    .filter((x) => x.after - x.before >= (opts.positionDrop ?? 3))
    .sort((a, b) => (b.after - b.before) - (a.after - a.before)).slice(0, 10);
  for (const x of rankDrops) {
    out.push({
      kind: "ranking_drop", severity: x.before <= 10 && x.after > 10 ? "warning" : "info", title: `“${x.query}” fell from position ${r1(x.before)} to ${r1(x.after)}`, url: x.page,
      fingerprint: `traffic:ranking_drop:${x.query}`, evidence: [`Average position ${r1(x.before)} → ${r1(x.after)} (${period})`, `Ranking page: ${x.page}`],
    });
  }
  return out;
}
