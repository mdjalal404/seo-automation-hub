import type { PerfRow } from "@/lib/analytics/insights";

/**
 * Impact of shipped changes: Search Console clicks, impressions and average position for a
 * page in equal windows before and after a change date (publish, refresh, applied proposal).
 * The days right after the change are skipped while Google re-crawls; windows still inside the
 * Search Console delay are reported as incomplete rather than as a drop.
 */
export type Change = { id: string; url: string; date: string; label: string };
export type Window = { clicks: number; impressions: number; position: number | null; days: number };
export type ImpactRow = Change & { before: Window; after: Window; clicksChange: number | null; positionChange: number | null; complete: boolean };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, n: number) => iso(new Date(new Date(`${date}T00:00:00Z`).getTime() + n * 86_400_000));
const norm = (u: string) => u.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();

function window(rows: PerfRow[], from: string, to: string): Window {
  const r = rows.filter((x) => x.date >= from && x.date <= to);
  const impressions = r.reduce((n, x) => n + x.impressions, 0);
  return {
    clicks: r.reduce((n, x) => n + x.clicks, 0), impressions,
    position: impressions ? Math.round((r.reduce((n, x) => n + x.position * x.impressions, 0) / impressions) * 10) / 10 : null,
    days: new Set(r.map((x) => x.date)).size,
  };
}

export function measureImpact(changes: Change[], rows: PerfRow[], opts: { windowDays?: number; settleDays?: number; today?: string } = {}): ImpactRow[] {
  const days = opts.windowDays ?? 28, settle = opts.settleDays ?? 3;
  const lastData = rows.reduce((m, r) => (r.date > m ? r.date : m), "");
  const byPage = new Map<string, PerfRow[]>();
  for (const r of rows) byPage.set(norm(r.page), [...(byPage.get(norm(r.page)) ?? []), r]);
  return changes.map((c) => {
    const pageRows = byPage.get(norm(c.url)) ?? [];
    const before = window(pageRows, addDays(c.date, -days), addDays(c.date, -1));
    const afterStart = addDays(c.date, settle);
    const afterEnd = addDays(afterStart, days - 1);
    const after = window(pageRows, afterStart, afterEnd);
    const complete = !!lastData && lastData >= afterEnd;
    // Normalise to per-day rates so an incomplete "after" window is still comparable.
    const rate = (w: Window, len: number) => (len ? w.clicks / len : 0);
    const afterLen = complete ? days : Math.max(0, Math.min(days, Math.round((new Date(`${lastData || afterStart}T00:00:00Z`).getTime() - new Date(`${afterStart}T00:00:00Z`).getTime()) / 86_400_000) + 1));
    const b = rate(before, days), a = rate(after, afterLen);
    return {
      ...c, before, after, complete,
      clicksChange: b > 0 && afterLen > 0 ? Math.round(((a - b) / b) * 100) : null,
      positionChange: before.position != null && after.position != null ? Math.round((before.position - after.position) * 10) / 10 : null,
    };
  });
}
