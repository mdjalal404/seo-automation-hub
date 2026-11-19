import { describe, expect, it } from "vitest";
import { decideVerdict } from "@/lib/ai/content-qa";
import { parseMarkets } from "@/lib/analytics/credentials";
import { measureImpact } from "@/lib/analytics/impact";
import type { PerfRow } from "@/lib/analytics/insights";
import { createTableSql, insertSql, TABLES } from "@/lib/analytics/warehouse";
import { checkHreflang, type AuditPage } from "@/lib/audit/crawler";
import { botOf, LogAnalyzer, parseLogLine, uncrawledPages } from "@/lib/audit/logs";
import { sampleAccessLog } from "@/dev/mock-analytics/core";

describe("access log analysis", () => {
  it("parses combined log lines and identifies bots", () => {
    const hit = parseLogLine('66.249.66.1 - - [10/Nov/2026:13:55:36 +0000] "GET /a?b=1 HTTP/1.1" 301 512 "-" "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"');
    expect(hit).toMatchObject({ date: "2026-11-10", method: "GET", path: "/a?b=1", status: 301, bytes: 512 });
    expect(botOf(hit!.ua)?.name).toBe("Googlebot Desktop");
    expect(botOf("Mozilla/5.0 (Linux; Android) Mobile Safari (compatible; Googlebot/2.1)")?.name).toBe("Googlebot Smartphone");
    expect(botOf("Mozilla/5.0 (compatible; GPTBot/1.2)")?.group).toBe("ai");
    expect(parseLogLine("garbage")).toBeNull();
  });

  it("summarizes crawl budget waste, sections, parameters and AI bots", () => {
    const a = new LogAnalyzer();
    for (const line of sampleAccessLog(7, new Date("2026-11-10T00:00:00Z")).split("\n")) a.add(line);
    const s = a.summary();
    expect(a.linesTotal).toBe(421);
    expect(a.linesParsed).toBe(420);
    expect(s.dateRange).toEqual(["2026-11-04", "2026-11-10"]);
    expect(s.google.hits).toBeGreaterThan(150);
    expect(s.google.byStatus["404"]).toBeGreaterThan(0);
    expect(s.google.waste.total).toBe(s.google.waste.redirects + s.google.waste.clientErrors + s.google.waste.serverErrors + s.google.waste.parameterUrls);
    expect(s.google.topParameters.map((p) => p.name)).toEqual(expect.arrayContaining(["page", "ref", "sort", "color"]));
    expect(s.aiBots.map((b) => b.name)).toEqual(expect.arrayContaining(["GPTBot", "ClaudeBot"]));
    expect(s.bots.find((b) => b.name === "Bingbot")?.group).toBe("search");
    expect(uncrawledPages(["https://s.example/dental-implants", "https://s.example/never-crawled"], a.googlePaths())).toEqual(["https://s.example/never-crawled"]);
  });
});

describe("hreflang validation", () => {
  const page = (url: string, hreflang?: { lang: string; href: string }[], extra: Partial<AuditPage> = {}): AuditPage => ({
    url, statusCode: 200, depth: 0, title: "t", metaDescription: null, canonical: url, indexable: true, wordCount: 500, loadMs: 10, inlinks: 1, issues: [], details: { hreflang }, ...extra,
  });
  it("flags invalid codes, missing self-reference, missing return links and x-default", () => {
    const en = page("https://s.example/en", [{ lang: "en", href: "https://s.example/en" }, { lang: "de", href: "https://s.example/de" }, { lang: "english", href: "https://s.example/en" }]);
    const de = page("https://s.example/de", [{ lang: "de", href: "https://s.example/de" }, { lang: "x-default", href: "https://s.example/en" }]);
    const fr = page("https://s.example/fr", [{ lang: "en", href: "https://s.example/en" }, { lang: "fr", href: "https://s.example/gone" }]);
    const gone = page("https://s.example/gone", undefined, { statusCode: 404 });
    checkHreflang([en, de, fr, gone]);
    expect(en.issues).toEqual(expect.arrayContaining(["hreflang_invalid", "hreflang_no_x_default"]));
    expect(en.issues).not.toContain("hreflang_no_return"); // de links back to en via x-default
    expect(de.issues).toEqual([]); // en lists de, so the pair is reciprocal
    // fr points at en, but en does not list fr: no return link.
    expect(fr.issues).toEqual(expect.arrayContaining(["hreflang_missing_self", "hreflang_broken_target", "hreflang_no_return"]));
  });
});

describe("impact measurement", () => {
  const rows: PerfRow[] = [];
  for (let i = 0; i < 70; i++) {
    const date = new Date(Date.UTC(2026, 8, 1) + i * 86_400_000).toISOString().slice(0, 10);
    rows.push({ date, query: "q", page: "https://s.example/a/", clicks: date < "2026-10-01" ? 10 : 15, impressions: 100, position: date < "2026-10-01" ? 8 : 5 });
  }
  it("compares equal windows around the change and normalises trailing slashes", () => {
    const [r] = measureImpact([{ id: "1", url: "https://s.example/a", date: "2026-10-01", label: "x" }], rows);
    expect(r.before.clicks).toBe(280);
    expect(r.clicksChange).toBe(50);
    expect(r.positionChange).toBe(3);
    expect(r.complete).toBe(true);
  });
  it("marks windows still inside the data delay as incomplete", () => {
    const [r] = measureImpact([{ id: "1", url: "https://s.example/a", date: "2026-10-30", label: "x" }], rows);
    expect(r.complete).toBe(false);
  });
});

describe("content QA verdicts", () => {
  const scores = { helpfulness: 8, expertise: 7, accuracy: 8, originality: 7, readability: 8, seo: 7 };
  it("decides by fixed thresholds", () => {
    expect(decideVerdict(scores, [])).toBe("pass");
    expect(decideVerdict({ ...scores, originality: 3 }, [])).toBe("fail");
    expect(decideVerdict({ ...scores, helpfulness: 5, expertise: 5, seo: 5 }, [])).toBe("needs_revision");
    expect(decideVerdict(scores, [{ severity: "high", message: "States a fabricated statistic", source: "llm" }])).toBe("fail");
    expect(decideVerdict(scores, [{ severity: "high", message: "Missing pricing section", source: "llm" }])).toBe("needs_revision");
  });
});

describe("warehouse export SQL", () => {
  it("creates Delta tables and passes every value as a typed parameter", () => {
    const c = { catalog: "main", schema: "seo" };
    expect(createTableSql(c, TABLES.search)).toBe("CREATE TABLE IF NOT EXISTS main.seo.seo_search_performance (website_id STRING, date DATE, query STRING, page STRING, clicks BIGINT, impressions BIGINT, ctr DOUBLE, position DOUBLE) USING DELTA");
    const { statement, parameters } = insertSql(c, TABLES.search, [["w", "2026-11-01", "x'; DROP TABLE t; --", "/p", 1, 2, 0.5, 3.2]]);
    expect(statement).not.toContain("DROP");
    expect(statement).toContain("VALUES (:p0_0, :p0_1, :p0_2, :p0_3, :p0_4, :p0_5, :p0_6, :p0_7)");
    expect(parameters[2]).toEqual({ name: "p0_2", value: "x'; DROP TABLE t; --", type: "STRING" });
    expect(parameters[1].type).toBe("DATE");
  });
});

describe("multi-market config", () => {
  it("parses label:location:language entries", () => {
    expect(parseMarkets("UK:2826:en, DE:2276:de")).toEqual([{ label: "UK", location_code: 2826, language_code: "en" }, { label: "DE", location_code: 2276, language_code: "de" }]);
    expect(() => parseMarkets("Germany")).toThrow(/label:location code:language/);
    expect(parseMarkets("")).toEqual([]);
  });
});
