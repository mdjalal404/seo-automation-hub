import { describe, expect, it } from "vitest";
import { sameHostUrls, submitIndexNow, verifyKeyFile } from "@/lib/indexing/indexnow";
import { detectTrafficAnomalies } from "@/lib/monitoring/anomalies";
import { diffAudits, stillPresent, type Snapshot, type SnapshotPage } from "@/lib/monitoring/diff";
import { compareSignals, gatePaths, knownGoodBaseline, runGate, type PageSignals } from "@/lib/monitoring/gate";
import { meetsSeverity, signWebhook, slackPayload, verifyWebhookSignature } from "@/lib/monitoring/notify";
import type { HttpClient } from "@/lib/security/safe-fetch";

const S = "https://s.example";
const page = (path: string, over: Partial<SnapshotPage> = {}): SnapshotPage => ({
  url: `${S}${path}`, status_code: 200, title: `Title ${path}`, meta_description: `Desc ${path}`, canonical: `${S}${path}`, indexable: true, word_count: 800, inlinks: 3,
  issues: [], details: { h1Count: 1, jsonLd: 1 }, ...over,
});
const snap = (id: string, pages: SnapshotPage[], over: Partial<Snapshot> = {}): Snapshot => ({
  id, created_at: id === "a" ? "2026-11-01T00:00:00Z" : "2026-11-08T00:00:00Z", score: 90, pages,
  site: { robots: { found: true, blocksAll: false }, sitemap: { found: true, urls: 10 }, aiCrawlers: [{ agent: "GPTBot", allowed: true }, { agent: "ClaudeBot", allowed: true }] }, ...over,
});

describe("audit-to-audit regressions", () => {
  const prev = snap("a", [page("/"), page("/pricing"), page("/blog"), page("/guide"), page("/about")]);
  const curr = snap("b", [
    page("/", { title: "New home title" }),
    page("/pricing", { indexable: false, issues: ["noindex"], details: { h1Count: 1, jsonLd: 1, evidence: { noindex: ['<meta name="robots" content="noindex">'] } } }),
    page("/blog", { status_code: 500, issues: ["http_5xx"], details: { evidence: { http_5xx: ["HTTP 500", `Linked from ${S}/`] } } }),
    page("/guide", { canonical: `${S}/`, word_count: 200, details: { h1Count: 0, jsonLd: 0 }, meta_description: null }),
    page("/new-page"),
  ], { score: 70, site: { robots: { found: true, blocksAll: false }, sitemap: { found: true, urls: 10 }, aiCrawlers: [{ agent: "GPTBot", allowed: false }, { agent: "ClaudeBot", allowed: true }] } });
  const f = diffAudits(prev, curr);
  const byKind = (k: string) => f.filter((x) => x.kind === k);

  it("finds breaking changes with before/after evidence", () => {
    expect(byKind("noindex_added")[0]).toMatchObject({ severity: "critical", url: `${S}/pricing`, evidence: ["Indexable in the audit of 2026-11-01", '<meta name="robots" content="noindex">'] });
    expect(byKind("page_broken")[0]).toMatchObject({ severity: "critical", url: `${S}/blog`, evidence: ["HTTP 200 in the audit of 2026-11-01", "HTTP 500 now", `Linked from ${S}/`] });
    expect(byKind("canonical_changed")[0].evidence).toEqual([`Before: ${S}/guide`, `Now: ${S}/`]);
    expect(byKind("title_changed")[0]).toMatchObject({ severity: "info", evidence: ["Before: “Title /”", "Now: “New home title”"] });
    expect(byKind("ai_crawler_blocked")[0].title).toBe("robots.txt now blocks GPTBot");
    expect(byKind("score_drop")[0].title).toBe("Health score fell from 90 to 70");
    expect(byKind("content_shrunk")[0].title).toBe("Content shrank by 75%");
    for (const k of ["structured_data_removed", "h1_removed", "description_removed"]) expect(byKind(k)).toHaveLength(1);
    expect(f.map((x) => x.severity)).toEqual([...f.map((x) => x.severity)].sort((a, b) => ["critical", "warning", "info"].indexOf(a) - ["critical", "warning", "info"].indexOf(b)));
  });

  it("ignores pages only one audit crawled and pages that were already broken", () => {
    expect(f.some((x) => x.url === `${S}/new-page` || x.url === `${S}/about`)).toBe(false);
    const again = diffAudits(curr, curr);
    expect(again).toEqual([]);
  });

  it("uses stable fingerprints so repeats de-duplicate", () => {
    expect(byKind("noindex_added")[0].fingerprint).toBe(`audit:noindex_added:${S}/pricing`);
    expect(diffAudits(prev, curr).map((x) => x.fingerprint)).toEqual(f.map((x) => x.fingerprint));
  });

  it("auto-resolves alerts once the latest audit shows the fix", () => {
    const fixed = snap("c", [page("/pricing"), page("/blog")]);
    expect(stillPresent("noindex_added", `${S}/pricing`, curr)).toBe(true);
    expect(stillPresent("noindex_added", `${S}/pricing`, fixed)).toBe(false);
    expect(stillPresent("page_broken", `${S}/blog`, fixed)).toBe(false);
    expect(stillPresent("noindex_added", `${S}/not-crawled`, fixed)).toBeNull();
    expect(stillPresent("title_changed", `${S}/`, fixed)).toBeNull();
  });
});

describe("traffic anomalies", () => {
  const day = (i: number) => new Date(Date.UTC(2026, 9, 1) + i * 86_400_000).toISOString().slice(0, 10);
  const rows = (dropFrom: number | null) => Array.from({ length: 35 }, (_, i) => [
    { date: day(i), query: "q1", page: `${S}/a`, clicks: dropFrom !== null && i >= dropFrom ? 4 : 20 + (i % 3), impressions: 400, position: dropFrom !== null && i >= dropFrom ? 9 : 3 },
    { date: day(i), query: "q2", page: `${S}/b`, clicks: 10 + (i % 2), impressions: 200, position: 5 },
  ]).flat();

  it("stays quiet on normal variation", () => {
    expect(detectTrafficAnomalies(rows(null))).toEqual([]);
  });

  it("reports site, page and ranking drops with the numbers behind them", () => {
    const f = detectTrafficAnomalies(rows(28));
    const site = f.find((x) => x.kind === "traffic_drop")!;
    expect(site.title).toMatch(/^Organic clicks down -\d+%$/);
    expect(site.evidence[0]).toMatch(/^14\.4 clicks\/day in the last 7 days vs 31\.\d before \(2026-10-29 to 2026-11-04 vs 2026-10-01 to 2026-10-28\)$/);
    expect(f.find((x) => x.kind === "page_traffic_drop")).toMatchObject({ url: `${S}/a`, title: "Page clicks down -81%" });
    expect(f.find((x) => x.kind === "ranking_drop")).toMatchObject({ title: "“q1” fell from position 3 to 9", fingerprint: "traffic:ranking_drop:q1" });
    expect(f.some((x) => x.url === `${S}/b`)).toBe(false);
  });
});

describe("alert delivery", () => {
  it("signs webhooks with HMAC over timestamp and body and rejects tampering or replays", () => {
    const now = Date.UTC(2026, 10, 19) ;
    const ts = String(now / 1000);
    const sig = signWebhook("secret-secret-123", ts, '{"a":1}');
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(verifyWebhookSignature("secret-secret-123", ts, '{"a":1}', sig, 300, now)).toBe(true);
    expect(verifyWebhookSignature("secret-secret-123", ts, '{"a":2}', sig, 300, now)).toBe(false);
    expect(verifyWebhookSignature("secret-secret-123", ts, '{"a":1}', sig, 300, now + 600_000)).toBe(false);
  });

  it("filters by severity and escapes untrusted text for Slack", () => {
    expect(meetsSeverity("critical", "warning")).toBe(true);
    expect(meetsSeverity("info", "warning")).toBe(false);
    const p = slackPayload({ website: { id: "w", name: "Site", base_url: S }, link: "https://hub/x", alerts: [{ kind: "k", severity: "critical", title: "<!channel> & co", url: `${S}/a`, evidence: ["<b>x</b>"] }] }) as { text: string; blocks: { text?: { text: string } }[] };
    expect(p.text).toBe("1 SEO alert for Site (1 critical)");
    expect(p.blocks[1].text!.text).toContain("&lt;!channel&gt; &amp; co");
    expect(p.blocks[1].text!.text).toContain("• &lt;b&gt;x&lt;/b&gt;");
  });
});

describe("IndexNow", () => {
  const calls: { url: string; body?: string }[] = [];
  const http = (status: number, text = ""): HttpClient => async (url, req = {}) => { calls.push({ url, body: req.body }); return { status, url, headers: {}, text }; };

  it("keeps only same-host URLs and posts the documented payload", async () => {
    expect(sameHostUrls(S, [`${S}/a#x`, "https://other.example/b", "not a url", `${S}/a`])).toEqual([`${S}/a`]);
    const r = await submitIndexNow(http(202), S, "abcdef0123456789", [`${S}/a`, "https://evil.example/"]);
    expect(r).toEqual({ submitted: 1, status: 202 });
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ host: "s.example", key: "abcdef0123456789", keyLocation: `${S}/abcdef0123456789.txt`, urlList: [`${S}/a`] });
  });

  it("maps IndexNow errors and verifies the key file", async () => {
    await expect(submitIndexNow(http(403), S, "abcdef0123456789", [`${S}/a`])).rejects.toMatchObject({ code: "CMS_AUTH_FAILED" });
    await expect(submitIndexNow(http(429), S, "abcdef0123456789", [`${S}/a`])).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true });
    await expect(verifyKeyFile(http(200, "wrong"), S, "abcdef0123456789")).rejects.toThrow(/does not contain the key/);
    await expect(verifyKeyFile(http(404), S, "abcdef0123456789")).rejects.toThrow(/returned HTTP 404/);
    expect(await verifyKeyFile(http(200, "abcdef0123456789\n"), S, "abcdef0123456789")).toBe(`${S}/abcdef0123456789.txt`);
  });
});

describe("deploy gate", () => {
  const sig = (over: Partial<PageSignals> = {}): PageSignals => ({ status: 200, finalUrl: `${S}/pricing`, title: "Title /pricing", description: "Desc", canonical: `${S}/pricing`, indexable: true, noindexSource: null, h1Count: 1, jsonLd: 1, jsonLdInvalid: 0, hreflang: 0, wordCount: 800, ...over });
  const opts = { allowNoindex: false, targetBase: S };

  it("fails on noindex, broken canonical, errors and invalid JSON-LD", () => {
    const c = compareSignals("/pricing", `${S}/pricing`, page("/pricing"), sig({ indexable: false, noindexSource: "X-Robots-Tag: noindex", canonical: `${S}/`, jsonLdInvalid: 1, title: "Changed" }), opts);
    expect(c.filter((x) => x.severity === "error").map((x) => x.code)).toEqual(["noindex", "canonical_changed", "jsonld_invalid"]);
    expect(c.find((x) => x.code === "title_changed")).toMatchObject({ severity: "info", before: "Title /pricing", after: "Changed" });
    expect(compareSignals("/pricing", `${S}/pricing`, page("/pricing"), sig({ status: 503 }), opts)).toEqual([expect.objectContaining({ code: "http_error", severity: "error", after: "HTTP 503" })]);
  });

  it("accepts preview noindex when allowed and compares canonicals by path across hosts", () => {
    const c = compareSignals("/pricing", "https://preview.example/pricing", page("/pricing"), sig({ indexable: false, canonical: `${S}/pricing`, finalUrl: "https://preview.example/pricing" }), { allowNoindex: true, targetBase: "https://preview.example" });
    expect(c).toEqual([]);
  });

  it("uses each page's last known-good state, so an audited regression is not accepted as normal", () => {
    const good = snap("a", [page("/"), page("/pricing"), page("/blog"), page("/thanks", { indexable: false })]);
    const broken = snap("b", [page("/"), page("/pricing", { indexable: false }), page("/blog", { status_code: 500 }), page("/thanks", { indexable: false }), page("/new")]);
    const base = knownGoodBaseline([broken, good])!;
    expect(base.id).toBe("b");
    const by = (p: string) => base.pages.find((x) => x.url === `${S}${p}`)!;
    expect(by("/pricing").indexable).toBe(true);
    expect(by("/blog").status_code).toBe(200);
    expect(by("/thanks").indexable).toBe(false); // never healthy: latest state kept
    expect(by("/new")).toBeDefined();
    expect(gatePaths(S, base, {})).toEqual(expect.arrayContaining(["/pricing", "/blog"]));
    expect(knownGoodBaseline([])).toBeNull();
  });

  it("picks the most linked pages from the baseline and runs end to end", async () => {
    const base = snap("a", [page("/", { inlinks: 0 }), page("/pricing", { inlinks: 9 }), page("/blog", { inlinks: 5 }), page("/gone", { status_code: 404 })]);
    expect(gatePaths(S, base, { maxUrls: 3 })).toEqual(["/", "/pricing", "/blog"]);
    expect(gatePaths(S, base, { paths: ["pricing", `${S}/x?y=1`] })).toEqual(["/pricing", "/x?y=1"]);
    const html = (p: string, extra = "") => `<html><head><title>Title ${p}</title><meta name="description" content="Desc ${p}"><link rel="canonical" href="${S}${p}">${extra}<script type="application/ld+json">{}</script></head><body><h1>H</h1>${"<p>word </p>".repeat(900)}</body></html>`;
    const site: HttpClient = async (url) => {
      const p = new URL(url).pathname;
      if (p === "/robots.txt") return { status: 200, url, headers: {}, text: "User-agent: *\nDisallow:\n" };
      if (p === "/blog") return { status: 200, url, headers: {}, text: html(p, '<meta name="robots" content="noindex">') };
      return { status: 200, url, headers: {}, text: html(p) };
    };
    const r = await runGate(site, S, base, { maxUrls: 3 });
    expect(r).toMatchObject({ passed: false, checked: 3, errors: 1, target: S, baselineAuditId: "a" });
    expect(r.checks).toEqual([expect.objectContaining({ path: "/blog", code: "noindex", after: '<meta name="robots" content="noindex">' })]);
    expect((await runGate(site, S, base, { paths: ["/", "/pricing"] })).passed).toBe(true);
  });
});
