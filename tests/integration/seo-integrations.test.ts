import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationAad, openSecret, sealSecret, toSecret } from "@/lib/analytics/credentials";
import { exportToDatabricks } from "@/lib/analytics/warehouse";
import {
  databricksSql, mixpanelSegmentation, validateDatabricks,
  clarityInsights, dfsSearchVolume, dfsSerp, dfsUserData, ga4OrganicReport, gscInspectUrl, gscListSites, gscQuery, pagespeed, parseServiceAccount, similarwebTraffic,
} from "@/lib/analytics/providers";
import { auditSite } from "@/lib/audit/crawler";
import { isAppError } from "@/lib/errors";
import type { HttpClient } from "@/lib/security/safe-fetch";
import { demoSite, MockAnalytics, scenario } from "@/dev/mock-analytics/core";
import { submitIndexNow, verifyKeyFile } from "@/lib/indexing/indexnow";
import { diffAudits } from "@/lib/monitoring/diff";
import { runGate } from "@/lib/monitoring/gate";
import { sendSlack, sendWebhook, verifyWebhookSignature } from "@/lib/monitoring/notify";
import { snapshotFromAudit } from "@/lib/tasks/monitoring";

const SITE = "http://demo.test";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const SA_JSON = JSON.stringify({ type: "service_account", client_email: "hub@test.iam.gserviceaccount.com", private_key: privateKey, private_key_id: "k1" });
const mock = new MockAnalytics({ siteUrl: SITE, serviceAccountEmail: "hub@test.iam.gserviceaccount.com", serviceAccountPrivateKey: privateKey, clarityToken: "clarity-token-123456789", dataforseoLogin: "me@test", dataforseoPassword: "pw-123456", similarwebKey: "sw-key-123456", mixpanelUsername: "mp.sa", mixpanelSecret: "mp-secret-123", databricksToken: "dapi-test-token" });

/** Routes provider calls (via ANALYTICS_API_BASE_URL) to the mock and site URLs to the demo site. */
const http: HttpClient = async (url, req = {}) => {
  const u = new URL(url);
  const r = u.origin === "http://mock.test"
    ? mock.handle({ method: req.method ?? "GET", path: u.pathname, query: u.searchParams, headers: Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])), body: req.body ?? "" })
    : demoSite(u.pathname, SITE);
  return { status: r.status, url, headers: { "content-type": r.type ?? "application/json", ...(r.headers ?? {}) }, text: r.body };
};

let savedBase: string | undefined;
beforeAll(() => { savedBase = process.env.ANALYTICS_API_BASE_URL; process.env.ANALYTICS_API_BASE_URL = "http://mock.test"; });
afterAll(() => { process.env.ANALYTICS_API_BASE_URL = savedBase; });

const iso = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

describe("Google Search Console & GA4 (service account)", () => {
  const sa = parseServiceAccount(SA_JSON);

  it("authenticates with a signed JWT and reads Search Console data", async () => {
    expect(await gscListSites(http, sa)).toEqual([`${SITE}/`]);
    const rows = await gscQuery(http, sa, `${SITE}/`, iso(30), iso(1));
    expect(rows.length).toBeGreaterThan(100);
    expect(rows[0]).toMatchObject({ query: expect.any(String), page: expect.stringContaining(SITE), impressions: expect.any(Number) });
    const insp = await gscInspectUrl(http, sa, `${SITE}/`, `${SITE}/blog/whitening-at-home`);
    expect(insp.verdict).toBe("NEUTRAL");
  });

  it("rejects a key the provider does not trust", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
    const bad = parseServiceAccount(JSON.stringify({ type: "service_account", client_email: sa.client_email, private_key: other }));
    await expect(gscListSites(http, bad)).rejects.toMatchObject({ code: "CMS_AUTH_FAILED" });
  });

  it("reads GA4 organic landing-page metrics and maps permission errors", async () => {
    const rows = await ga4OrganicReport(http, sa, "123456789", iso(7), iso(0));
    expect(rows[0]).toMatchObject({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), sessions: expect.any(Number) });
    await expect(ga4OrganicReport(http, sa, "999999", iso(7), iso(0))).rejects.toMatchObject({ code: "CMS_FORBIDDEN" });
    await expect(ga4OrganicReport(http, sa, "abc", iso(7), iso(0))).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("validates service account JSON before use", () => {
    expect(() => parseServiceAccount("{")).toThrow(/JSON file/);
    expect(() => parseServiceAccount('{"type":"authorized_user"}')).toThrow(/not a service account/);
  });
});

describe("Clarity, DataForSEO, Similarweb, PageSpeed", () => {
  it("reads Clarity insights with the bearer token", async () => {
    const rows = await clarityInsights(http, "clarity-token-123456789", 1);
    expect(rows.some((r) => r.metric === "RageClickCount")).toBe(true);
    await expect(clarityInsights(http, "wrong-token-xxxxxxxxxxxx", 1)).rejects.toMatchObject({ code: "CMS_AUTH_FAILED" });
  });

  it("uses DataForSEO for volumes, rankings and AI Overview citations", async () => {
    const c = { login: "me@test", password: "pw-123456" };
    expect((await dfsUserData(http, c)).balance).toBe(42.5);
    const vols = await dfsSearchVolume(http, c, ["dental implants cost"]);
    expect(vols[0].searchVolume).toBeGreaterThan(0);
    const serp = await dfsSerp(http, c, "dental implants cost", "demo.test");
    expect(serp.topUrls).toHaveLength(10);
    expect(serp.aiOverview.present).toBe(true);
    expect(serp.aiOverview.cited).toBe(serp.position !== null && serp.position <= 5);
    await expect(dfsUserData(http, { login: "me@test", password: "nope" })).rejects.toSatisfy((e) => isAppError(e));
  });

  it("reads Similarweb visits and PageSpeed Core Web Vitals", async () => {
    const months = await similarwebTraffic(http, "sw-key-123456", "www.demo.test", "2026-05", "2026-07");
    expect(months.map((m) => m.date)).toEqual(["2026-05-01", "2026-06-01", "2026-07-01"]);
    const v = await pagespeed(http, null, `${SITE}/`, "mobile");
    expect(v).toMatchObject({ performanceScore: 71, field: { lcpMs: 2900, inpMs: 240, cls: 0.08 } });
  });
});

describe("Mixpanel and Databricks", () => {
  it("reads Mixpanel conversions by landing page", async () => {
    const rows = await mixpanelSegmentation(http, { username: "mp.sa", secret: "mp-secret-123", projectId: "1234567", region: "us" }, { event: "Purchase", on: "landing_page", from: iso(2), to: iso(0) });
    expect(rows.filter((r) => r.segment === "/dental-implants")).toHaveLength(3);
    await expect(mixpanelSegmentation(http, { username: "mp.sa", secret: "wrong", projectId: "1234567", region: "us" }, { event: "Purchase", on: "landing_page", from: iso(1), to: iso(0) })).rejects.toMatchObject({ code: "CMS_AUTH_FAILED" });
  });

  it("validates the Databricks target and exports idempotently with parameters", async () => {
    expect(() => validateDatabricks({ host: "dbc-1.cloud.databricks.com", token: "t", warehouseId: "abcdef1234567890", catalog: "main; DROP", schema: "seo" })).toThrow(/identifiers/);
    const c = validateDatabricks({ host: "https://dbc-1.cloud.databricks.com/", token: "dapi-test-token", warehouseId: "abcdef1234567890", catalog: "main", schema: "seo" });
    expect(c.host).toBe("dbc-1.cloud.databricks.com");
    expect((await databricksSql(http, c, "SELECT 1")).rows).toEqual([["1"]]);
    await expect(databricksSql(http, { ...c, token: "nope" }, "SELECT 1")).rejects.toMatchObject({ code: "CMS_AUTH_FAILED" });
    // Minimal Supabase stand-in returning a few Search Console rows; other tables empty.
    const data: Record<string, unknown[]> = { search_performance_daily: Array.from({ length: 150 }, (_, i) => ({ date: iso(i % 10), query: `q${i}`, page: "/p", clicks: 1, impressions: 10, ctr: 0.1, position: 4 })) };
    const chain = (table: string) => { const q: Record<string, unknown> = {}; for (const m of ["select", "eq", "gte", "order", "limit"]) q[m] = () => q; q.then = (r: (v: unknown) => unknown) => r({ data: data[table] ?? [], error: null }); return q; };
    const before = mock.statements.length;
    const counts = await exportToDatabricks({ from: chain } as never, http, c, { id: "w1", organization_id: "o1" }, 30);
    expect(counts).toMatchObject({ search: 150, traffic: 0, keywords: 0 });
    const sent = mock.statements.slice(before);
    expect(sent.filter((x) => x.statement.startsWith("INSERT INTO main.seo.seo_search_performance"))).toHaveLength(2); // 100 + 50 rows
    expect(sent.some((x) => x.statement.startsWith("DELETE FROM main.seo.seo_search_performance WHERE website_id = :website AND date >= :filter"))).toBe(true);
    expect(sent.every((x) => !x.statement.includes("q149"))).toBe(true); // values never inlined
  });
});

describe("integration credentials", () => {
  it("encrypts per website and provider", () => {
    const secret = toSecret({ provider: "dataforseo", websiteId: "00000000-0000-4000-8000-000000000001", login: "me@test", password: "pw-123456", locationCode: 2840, languageCode: "en", markets: "" });
    const env = sealSecret(secret, "org1", "site1");
    expect(env).not.toContain("pw-123456");
    expect(openSecret(env, "org1", "site1", "dataforseo").password).toBe("pw-123456");
    expect(() => openSecret(env, "org1", "site2", "dataforseo")).toThrow();
    expect(integrationAad("o", "w", "similarweb")).toBe("integration:o:w:similarweb");
  });
});

describe("technical crawler", () => {
  it("audits the demo site and finds its known issues", async () => {
    const r = await auditSite(http, SITE, { maxPages: 50, delayMs: 0 });
    const page = (p: string) => r.pages.find((x) => x.url === `${SITE}${p}`)!;
    expect(r.site.robots.found).toBe(true);
    expect(r.site.sitemap.urls).toBe(9);
    expect(r.site.llmsTxt.found).toBe(false);
    expect(r.site.aiCrawlers.find((c) => c.agent === "GPTBot")!.allowed).toBe(false);
    expect(r.site.aiCrawlers.find((c) => c.agent === "ClaudeBot")!.allowed).toBe(true);
    expect(page("/old-offer").issues).toContain("http_4xx");
    expect(page("/").issues).toContain("broken_internal_link");
    expect(page("/dental-implants").issues).toContain("duplicate_title");
    expect(page("/teeth-whitening").issues).toContain("missing_meta_description");
    expect(page("/blog/whitening-at-home").issues).toContain("missing_h1");
    expect(page("/orphan-guide").issues).toContain("orphan_page");
    expect(page("/").issues).toContain("img_missing_alt");
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(100);
    expect(r.partial).toBe(false);
    expect(page("/dental-implants").issues).toContain("hreflang_no_return");
    expect(r.site.hreflang).toEqual({ pages: 1, languages: ["de", "en"] });
    expect(r.site.crawlBudget?.sitemapNonIndexable).toBe(0);
  });

  it("records concrete evidence for each finding", async () => {
    const r = await auditSite(http, SITE, { maxPages: 50, delayMs: 0 });
    const ev = (p: string, code: string) => r.pages.find((x) => x.url === `${SITE}${p}`)!.details.evidence?.[code] ?? [];
    // Duplicate titles name the other URL(s) with the same title.
    expect(ev("/dental-implants", "duplicate_title")).toEqual(["Title: “Dental Implants Cost & Procedure | Acme Dental”", `Same as ${SITE}/blog/implant-recovery`]);
    expect(ev("/blog/implant-recovery", "duplicate_title")).toContain(`Same as ${SITE}/dental-implants`);
    expect(ev("/", "broken_internal_link")).toEqual([`Links to ${SITE}/old-offer (HTTP 404)`]);
    expect(ev("/old-offer", "http_4xx")).toEqual(["HTTP 404", `Linked from ${SITE}/`]);
    expect(ev("/", "img_missing_alt")).toContain('<img src="/team.jpg">');
    expect(ev("/blog", "thin_content")[0]).toMatch(/^\d+ words of visible text$/);
    expect(ev("/dental-implants", "hreflang_no_return")[0]).toContain(`${SITE}/de/zahnimplantate`);
    // Every issue on every page carries at least one piece of evidence.
    for (const p of r.pages) for (const code of p.issues) expect(p.details.evidence?.[code]?.length, `${p.url} ${code}`).toBeGreaterThan(0);
  });

  it("stops at the deadline and reports a partial crawl", async () => {
    const r = await auditSite(http, SITE, { maxPages: 50, delayMs: 0, deadline: Date.now() - 1 });
    expect(r.partial).toBe(true);
    expect(r.pages).toHaveLength(0);
  });
});

describe("monitoring: a release that breaks SEO", () => {
  afterAll(() => { scenario.demo = "normal"; });

  it("is caught by the audit diff and by the deploy gate", async () => {
    scenario.demo = "normal";
    const before = snapshotFromAudit("a1", await auditSite(http, SITE, { maxPages: 50, delayMs: 0 }));
    const gateOk = await runGate(http, SITE, before, { maxUrls: 10 });
    expect(gateOk.passed).toBe(true);

    scenario.demo = "regression";
    const after = { ...snapshotFromAudit("a2", await auditSite(http, SITE, { maxPages: 50, delayMs: 0 })), created_at: new Date(Date.now() + 1000).toISOString() };
    const f = diffAudits(before, after);
    const kinds = f.map((x) => `${x.kind} ${x.url?.replace(SITE, "") ?? ""}`.trim());
    expect(kinds).toEqual(expect.arrayContaining(["page_broken /teeth-whitening", "noindex_added /dental-implants", "canonical_changed /dental-implants", "title_changed /blog/implant-recovery"]));
    expect(f.find((x) => x.kind === "noindex_added")!.evidence).toContain('<meta name="robots" content="noindex">');

    const gate = await runGate(http, SITE, before, { maxUrls: 10 });
    expect(gate.passed).toBe(false);
    expect(gate.checks.filter((c) => c.severity === "error").map((c) => `${c.code} ${c.path}`)).toEqual(expect.arrayContaining(["http_error /teeth-whitening", "noindex /dental-implants", "canonical_changed /dental-implants"]));
  });

  it("delivers alerts to Slack and signed webhooks, and submits IndexNow", async () => {
    const batch = { website: { id: "w1", name: "Acme", base_url: SITE }, link: "http://hub/monitoring", alerts: [{ kind: "noindex_added", severity: "critical" as const, title: "Page became noindex", url: `${SITE}/x`, evidence: ["e1"] }] };
    await sendSlack(http, "https://hooks.slack.com/services/T000/B000/abcdefghij", batch);
    expect(JSON.stringify(mock.inbox.slack.at(-1))).toContain("Page became noindex");
    await expect(sendSlack(http, "https://hooks.slack.com/services/T000/B000/REVOKED1234", batch)).rejects.toMatchObject({ code: "CMS_AUTH_FAILED" });

    await sendWebhook(http, "http://mock.test/__mock/webhook", "whsec-0123456789abcdef", batch);
    const hook = mock.inbox.webhooks.at(-1)!;
    expect(JSON.parse(hook.body)).toMatchObject({ type: "seo.alerts", alerts: [{ kind: "noindex_added", severity: "critical" }] });
    expect(verifyWebhookSignature("whsec-0123456789abcdef", hook.headers["x-seohub-timestamp"]!, hook.body, hook.headers["x-seohub-signature"]!)).toBe(true);

    const key = "0123456789abcdef0123456789abcdef";
    expect(await verifyKeyFile(http, SITE, key)).toBe(`${SITE}/${key}.txt`);
    expect(await submitIndexNow(http, SITE, key, [`${SITE}/dental-implants`])).toEqual({ submitted: 1, status: 202 });
    expect(mock.inbox.indexnow.at(-1)).toMatchObject({ host: "demo.test", urlList: [`${SITE}/dental-implants`] });
  });
});
