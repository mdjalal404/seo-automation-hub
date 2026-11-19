/**
 * Server access-log analysis for crawl budget: which bots crawl what, how often, and how
 * much of that crawling is wasted on redirects, errors and parameter URLs. Parses the
 * Apache/Nginx "combined" and "common" formats line by line (streaming, constant memory
 * apart from the per-URL counters, which are capped).
 *
 * Bots are identified by user agent. Spoofed user agents are not excluded here; the Python
 * toolkit (python/seo_toolkit/logs.py --verify-dns) can verify Googlebot by reverse DNS.
 */
export const BOTS: { name: string; pattern: RegExp; group: "search" | "ai" | "other" }[] = [
  { name: "Googlebot Smartphone", pattern: /Googlebot\/[\d.]+.*Mobile|Mobile.*Googlebot\//i, group: "search" },
  { name: "Googlebot Desktop", pattern: /Googlebot\//i, group: "search" },
  { name: "Googlebot Image", pattern: /Googlebot-Image/i, group: "search" },
  { name: "Bingbot", pattern: /bingbot/i, group: "search" },
  { name: "YandexBot", pattern: /YandexBot/i, group: "search" },
  { name: "Applebot", pattern: /Applebot\//i, group: "search" },
  { name: "GPTBot", pattern: /GPTBot/i, group: "ai" },
  { name: "OAI-SearchBot", pattern: /OAI-SearchBot/i, group: "ai" },
  { name: "ChatGPT-User", pattern: /ChatGPT-User/i, group: "ai" },
  { name: "ClaudeBot", pattern: /ClaudeBot/i, group: "ai" },
  { name: "Claude-SearchBot", pattern: /Claude-SearchBot/i, group: "ai" },
  { name: "Claude-User", pattern: /Claude-User/i, group: "ai" },
  { name: "PerplexityBot", pattern: /PerplexityBot|Perplexity-User/i, group: "ai" },
  { name: "CCBot", pattern: /CCBot/i, group: "ai" },
  { name: "AhrefsBot", pattern: /AhrefsBot/i, group: "other" },
  { name: "SemrushBot", pattern: /SemrushBot/i, group: "other" },
];

const LINE = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)(?: [^"]*)?" (\d{3}) (\S+)(?: "([^"]*)" "([^"]*)")?/;
const MONTHS: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
const ASSET = /\.(css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|map|mp4|webm|pdf|zip)$/i;
const MAX_URLS = 50_000;

export type LogHit = { ip: string; date: string; method: string; path: string; status: number; bytes: number; ua: string };

export function parseLogLine(line: string): LogHit | null {
  const m = LINE.exec(line);
  if (!m) return null;
  const [, ip, ts, method, path, status, bytes, , ua] = m;
  const d = /^(\d{2})\/(\w{3})\/(\d{4})/.exec(ts);
  return { ip, date: d ? `${d[3]}-${MONTHS[d[2]] ?? "01"}-${d[1]}` : "", method, path, status: Number(status), bytes: bytes === "-" ? 0 : Number(bytes), ua: ua ?? "" };
}

export function botOf(ua: string): (typeof BOTS)[number] | null {
  return BOTS.find((b) => b.pattern.test(ua)) ?? null;
}

type Counter = Record<string, number>;
const inc = (c: Counter, k: string, n = 1) => { c[k] = (c[k] ?? 0) + n; };

export type LogSummary = {
  dateRange: [string, string] | null;
  bots: { name: string; group: string; hits: number }[];
  google: {
    hits: number; uniqueUrls: number; byStatus: Counter; bySection: { section: string; hits: number }[]; byDay: { date: string; hits: number }[];
    parameterHits: number; assetHits: number; topUrls: { url: string; hits: number; status: number }[]; topParameters: { name: string; hits: number }[];
    waste: { redirects: number; clientErrors: number; serverErrors: number; parameterUrls: number; total: number; percent: number };
    errorUrls: { url: string; status: number; hits: number }[];
  };
  aiBots: { name: string; hits: number; uniqueUrls: number }[];
};

export class LogAnalyzer {
  linesTotal = 0;
  linesParsed = 0;
  botHits = 0;
  private bots: Counter = {};
  private groups: Record<string, string> = {};
  private aiUrls: Record<string, Set<string>> = {};
  private g = { hits: 0, status: {} as Counter, section: {} as Counter, day: {} as Counter, params: 0, assets: 0, paramNames: {} as Counter, urls: new Map<string, { hits: number; status: number }>() };
  private minDate = "";
  private maxDate = "";

  add(line: string) {
    if (!line.trim()) return;
    this.linesTotal++;
    const hit = parseLogLine(line);
    if (!hit) return;
    this.linesParsed++;
    const bot = botOf(hit.ua);
    if (!bot) return;
    this.botHits++;
    inc(this.bots, bot.name);
    this.groups[bot.name] = bot.group;
    if (hit.date) {
      if (!this.minDate || hit.date < this.minDate) this.minDate = hit.date;
      if (hit.date > this.maxDate) this.maxDate = hit.date;
    }
    if (bot.group === "ai") {
      const set = (this.aiUrls[bot.name] ??= new Set());
      if (set.size < MAX_URLS) set.add(hit.path);
    }
    if (!bot.name.startsWith("Googlebot")) return;
    const g = this.g;
    g.hits++;
    inc(g.status, String(hit.status));
    if (hit.date) inc(g.day, hit.date);
    const [pathname, query] = hit.path.split("?", 2);
    inc(g.section, "/" + (pathname.split("/")[1] ?? ""));
    if (query) {
      g.params++;
      for (const pair of query.split("&")) inc(g.paramNames, pair.split("=")[0] || "(empty)");
    }
    if (ASSET.test(pathname)) g.assets++;
    const u = g.urls.get(hit.path);
    if (u) { u.hits++; u.status = hit.status; } else if (g.urls.size < MAX_URLS) g.urls.set(hit.path, { hits: 1, status: hit.status });
  }

  /** Paths (with query) requested by Googlebot. */
  googlePaths(): Set<string> {
    return new Set(this.g.urls.keys());
  }

  summary(): LogSummary {
    const g = this.g;
    const st = (from: number, to: number) => Object.entries(g.status).filter(([s]) => Number(s) >= from && Number(s) < to).reduce((n, [, v]) => n + v, 0);
    const redirects = st(300, 400), clientErrors = st(400, 500), serverErrors = st(500, 600);
    const total = redirects + clientErrors + serverErrors + g.params;
    const urls = [...g.urls.entries()];
    return {
      dateRange: this.minDate ? [this.minDate, this.maxDate] : null,
      bots: Object.entries(this.bots).map(([name, hits]) => ({ name, group: this.groups[name], hits })).sort((a, b) => b.hits - a.hits),
      google: {
        hits: g.hits, uniqueUrls: g.urls.size, byStatus: g.status,
        bySection: Object.entries(g.section).map(([section, hits]) => ({ section, hits })).sort((a, b) => b.hits - a.hits).slice(0, 25),
        byDay: Object.entries(g.day).map(([date, hits]) => ({ date, hits })).sort((a, b) => a.date.localeCompare(b.date)),
        parameterHits: g.params, assetHits: g.assets,
        topUrls: urls.sort((a, b) => b[1].hits - a[1].hits).slice(0, 25).map(([url, v]) => ({ url, ...v })),
        topParameters: Object.entries(g.paramNames).map(([name, hits]) => ({ name, hits })).sort((a, b) => b.hits - a.hits).slice(0, 15),
        // Overlap (e.g. a redirecting parameter URL) can count twice; the percentage is capped at 100.
        waste: { redirects, clientErrors, serverErrors, parameterUrls: g.params, total, percent: g.hits ? Math.min(100, Math.round((total / g.hits) * 100)) : 0 },
        errorUrls: urls.filter(([, v]) => v.status >= 400).sort((a, b) => b[1].hits - a[1].hits).slice(0, 25).map(([url, v]) => ({ url, status: v.status, hits: v.hits })),
      },
      aiBots: Object.entries(this.aiUrls).map(([name, set]) => ({ name, hits: this.bots[name] ?? 0, uniqueUrls: set.size })).sort((a, b) => b.hits - a.hits),
    };
  }
}

/** Indexable audited pages Googlebot never requested in the log window (crawl-coverage gap). */
export function uncrawledPages(auditUrls: string[], crawledPaths: Set<string>): string[] {
  return auditUrls.filter((u) => {
    try {
      const p = new URL(u);
      return !crawledPaths.has(p.pathname + p.search) && !crawledPaths.has(p.pathname);
    } catch {
      return false;
    }
  });
}
