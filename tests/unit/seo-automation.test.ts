import { describe, expect, it } from "vitest";
import { runContentPipeline } from "@/lib/ai/content-pipeline";
import { getLlm, llmProvider, llmStatus } from "@/lib/ai/llm";
import { detectInsights, type PerfRow } from "@/lib/analytics/insights";
import { auditIssuesCsv, auditJson, auditPagesCsv } from "@/lib/audit/export";
import { auditPdf } from "@/lib/audit/pdf";
import { blocksSite, isAllowed, parseRobots } from "@/lib/audit/robots";
import { parseFeed, placeholders, renderPages, renderTemplate } from "@/lib/programmatic/templates";
import { aiReadiness } from "@/lib/seo/ai-visibility";
import { runValidation } from "@/lib/seo/engine";
import { parseHtml, renderBody } from "@/lib/seo/html";
import { insertLink, suggestInternalLinks } from "@/lib/seo/internal-links";
import { classifyIntent, clusterKeywords, parseKeywordList } from "@/lib/seo/keywords";
import { resolveRules } from "@/lib/seo/rules";
import { extractFaqs, generateSchema, validateSchema } from "@/lib/seo/schema-generator";

const READY_ARTICLE = `Dental implants are titanium posts that replace missing tooth roots and support a crown. Most patients pay $3,000 to $5,000 per implant, and treatment takes 3 to 6 months.

## How much do dental implants cost?

Prices depend on the number of implants, bone grafting (about $600) and the crown. See the [ADA guide](https://www.ada.org/implants) and [NIH data](https://www.nidcr.nih.gov/implants).

- Single implant: $3,000–$5,000
- Bone graft: $300–$800

## How long does recovery take?

Healing usually takes 3 to 6 months while the implant fuses with the bone.

## FAQ

### Are dental implants painful?

Most patients report mild soreness for 2 to 3 days after surgery.

### How long do implants last?

With good care, implants often last 25 years or more.
${"\n\nImplants restore chewing and appearance. Careful planning with a specialist matters for long-term success.".repeat(40)}`;

describe("keyword intent & clustering", () => {
  it("classifies intent", () => {
    expect(classifyIntent("dental implants cost")).toBe("transactional");
    expect(classifyIntent("best dental implants brand")).toBe("commercial");
    expect(classifyIntent("dentist near me")).toBe("local");
    expect(classifyIntent("how do dental implants work")).toBe("informational");
    expect(classifyIntent("acme dental login")).toBe("navigational");
  });

  it("groups similar keywords and makes the biggest one the head", () => {
    const clusters = clusterKeywords([
      { keyword: "dental implants cost", volume: 900 },
      { keyword: "cost of dental implants", volume: 300 },
      { keyword: "dental implant costs", volume: 200 },
      { keyword: "teeth whitening", volume: 1200 },
      { keyword: "teeth whitening at home", volume: 400 },
    ]);
    const implants = clusters.find((c) => c.head === "dental implants cost")!;
    expect(implants.keywords.map((k) => k.keyword).sort()).toEqual(["cost of dental implants", "dental implant costs", "dental implants cost"]);
    expect(implants.totalVolume).toBe(1400);
    expect(clusters.find((c) => c.head === "teeth whitening")!.keywords).toHaveLength(2);
  });

  it("uses SERP overlap when available, even for differently worded keywords", () => {
    const serp = ["a", "b", "c", "d", "e"].map((x) => `https://${x}.example/`);
    const clusters = clusterKeywords([
      { keyword: "tooth replacement options", volume: 500, serpUrls: serp },
      { keyword: "dental implants", volume: 800, serpUrls: [...serp.slice(0, 4), "https://z.example/"] },
      { keyword: "tooth replacement", volume: 100, serpUrls: ["https://q.example/", "https://r.example/"] },
    ]);
    expect(clusters[0].head).toBe("dental implants");
    expect(clusters[0].keywords.map((k) => k.keyword)).toContain("tooth replacement options");
    expect(clusters.some((c) => c.head === "tooth replacement")).toBe(true);
  });

  it("parses pasted keyword lists with optional volumes", () => {
    expect(parseKeywordList("keyword,volume\nDental Implants, 1,200\ndental implants\n\nteeth whitening\t880")).toEqual([
      { keyword: "dental implants", volume: 1 }, { keyword: "teeth whitening", volume: 880 },
    ]);
  });
});

describe("internal links", () => {
  const targets = [
    { id: "t1", url: "https://site.example/implant-recovery", title: "Implant recovery timeline", keyword: "implant recovery", text: "recovery healing implant weeks" },
    { id: "t2", url: "https://site.example/whitening", title: "Teeth whitening guide", keyword: "teeth whitening", text: "whitening bleaching enamel" },
  ];

  it("suggests unlinked phrases that match other pages", () => {
    const s = suggestInternalLinks({ title: "Dental implants", body: "Dental implants need care. Implant recovery takes months, and teeth whitening is separate.", bodyFormat: "markdown" }, targets);
    expect(s.map((x) => x.anchor)).toEqual(expect.arrayContaining(["Implant recovery", "teeth whitening"]));
  });

  it("skips pages that are already linked", () => {
    const s = suggestInternalLinks({ title: "x", body: "See [our guide](https://site.example/whitening). Implant recovery takes months.", bodyFormat: "markdown" }, targets);
    expect(s.map((x) => x.url)).not.toContain("https://site.example/whitening");
  });

  it("inserts a markdown link outside headings and existing links", () => {
    const body = "## Implant recovery\n\nRead [implant recovery](https://a.example) notes. Implant recovery is slow.";
    expect(insertLink(body, "markdown", "implant recovery", "https://site.example/r")).toBe("## Implant recovery\n\nRead [implant recovery](https://a.example) notes. [Implant recovery](https://site.example/r) is slow.");
    expect(insertLink("## Implant recovery", "markdown", "implant recovery", "https://site.example/r")).toBeNull();
  });

  it("inserts an HTML link only in plain text", () => {
    expect(insertLink('<h2>Teeth whitening</h2><p>Try <a href="/x">teeth whitening</a> or teeth whitening kits.</p>', "html", "teeth whitening", "https://s.example/w"))
      .toBe('<h2>Teeth whitening</h2><p>Try <a href="/x">teeth whitening</a> or <a href="https://s.example/w">teeth whitening</a> kits.</p>');
  });
});

describe("AI search readiness", () => {
  it("scores an answer-first, structured, cited article highly", () => {
    const r = aiReadiness(parseHtml(renderBody(READY_ARTICLE, "markdown")), { keyword: "dental implants", siteHost: "site.example" });
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.signals.find((s) => s.key === "citations")!.passed).toBe(true);
  });

  it("flags a wall of text", () => {
    const r = aiReadiness(parseHtml(renderBody("Our company has many years of history and we love what we do every single day for our clients. ".repeat(40), "markdown")), { keyword: "dental implants" });
    expect(r.score).toBeLessThan(40);
  });

  it("runs as a validation warning alongside the other checks", async () => {
    const rules = resolveRules({});
    const res = await runValidation({ id: "c", websiteId: "w", title: "T", slug: "t", body: "Words without structure. ".repeat(60), bodyFormat: "markdown", excerpt: "", metaTitle: "", metaDescription: "", canonicalUrl: "", targetKeyword: "x" },
      { rules, siblings: { findBySlug: async () => [], findByTitle: async () => [] }, website: { baseUrl: "https://site.example" } });
    const r = res.find((x) => x.checkName === "ai_visibility")!;
    expect(r.status).toBe("fail");
    expect(r.severity).toBe("warning");
    expect(r.message).toMatch(/AI search readiness \d+\/100/);
  });
});

describe("schema generator", () => {
  it("builds Article + FAQPage from the article's own questions", () => {
    const html = renderBody(READY_ARTICLE, "markdown");
    expect(extractFaqs(html).map((f) => f.question)).toEqual(["How much do dental implants cost?", "How long does recovery take?", "Are dental implants painful?", "How long do implants last?"]);
    const { jsonld, warnings } = generateSchema(
      { title: "Dental implants guide", metaDescription: "d", excerpt: "", body: READY_ARTICLE, bodyFormat: "markdown", url: "https://site.example/implants" },
      { name: "Acme Dental", baseUrl: "https://site.example" },
      { types: ["BlogPosting", "FAQPage", "BreadcrumbList"], authorName: "Dr. Lee", publisherName: "", logoUrl: "", imageUrl: "", business: {}, product: {} },
    );
    const graph = (jsonld as { "@graph": { "@type": string }[] })["@graph"];
    expect(graph.map((g) => g["@type"])).toEqual(["BlogPosting", "FAQPage", "BreadcrumbList", "Organization"]);
    expect(warnings.some((w) => /image/.test(w))).toBe(true);
    expect(validateSchema(jsonld)).toEqual([]);
  });

  it("reports missing required properties", () => {
    expect(validateSchema({ "@context": "https://schema.org", "@type": "Product" })).toEqual(['Product at root is missing "name".']);
    expect(validateSchema({ "@type": "FAQPage", mainEntity: [] })).toContain('Missing "@context": "https://schema.org".');
  });
});

describe("programmatic templates", () => {
  const tpl = {
    titleTemplate: "{{service|title}} in {{city}}", slugTemplate: "{{service}} {{city}}", metaTitleTemplate: "", metaDescriptionTemplate: "{{service}} in {{city}}",
    excerptTemplate: "", keywordTemplate: "{{service}} {{city}}", bodyTemplate: "We offer {{service}} in {{city}}.{{#if note}} Note: {{note}}{{/if}}",
  };

  it("renders placeholders, filters and conditionals", () => {
    expect(placeholders(tpl.bodyTemplate)).toEqual(["service", "city", "note"]);
    expect(renderTemplate(tpl.bodyTemplate, { service: "boiler repair", city: "Leeds", note: "" })).toBe("We offer boiler repair in Leeds.");
    expect(renderTemplate("{{city|upper}} {{city|slug}}", { city: "New York" })).toBe("NEW YORK new-york");
  });

  it("parses CSV and JSON feeds and flags duplicates, missing columns and thin pages", () => {
    const feed = parseFeed("service,city\nboiler repair,Leeds\nboiler repair,Leeds\nboiler repair,York");
    expect(feed.columns).toEqual(["service", "city"]);
    const pages = renderPages(tpl, feed.rows, new Set(["boiler-repair-york"]));
    expect(pages[0].slug).toBe("boiler-repair-leeds");
    expect(pages[0].title).toBe("Boiler Repair in Leeds");
    expect(pages[1].errors[0]).toMatch(/Duplicate slug/);
    expect(pages[2].errors[0]).toMatch(/already exists/);
    expect(pages[0].errors).toEqual([]); // columns used only inside {{#if}} are optional
    expect(renderPages({ ...tpl, titleTemplate: "{{service}} {{region}}" }, feed.rows.slice(0, 1), new Set())[0].errors[0]).toMatch(/Missing column\(s\): region/);
    expect(pages[0].warnings.some((w) => /words/.test(w))).toBe(true);
    expect(parseFeed('[{"service":"a","city":"b","n":1}]').rows[0]).toEqual({ service: "a", city: "b", n: "1" });
    expect(parseFeed("[1,2").error).toMatch(/could not be parsed/);
  });
});

describe("robots.txt", () => {
  const robots = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/ok$\n\nUser-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\n\nSitemap: https://s.example/sitemap.xml");
  it("applies longest-match rules per agent", () => {
    expect(isAllowed(robots, "SEOAutomationHub", "/private/page")).toBe(false);
    expect(isAllowed(robots, "SEOAutomationHub", "/private/ok")).toBe(true);
    expect(isAllowed(robots, "SEOAutomationHub", "/blog")).toBe(true);
    expect(blocksSite(robots, "GPTBot")).toBe(true);
    expect(blocksSite(robots, "CCBot")).toBe(true);
    expect(blocksSite(robots, "ClaudeBot")).toBe(false);
    expect(robots.sitemaps).toEqual(["https://s.example/sitemap.xml"]);
  });
});

describe("search insights", () => {
  const today = new Date("2026-11-05T00:00:00Z");
  const rows: PerfRow[] = [];
  for (let i = 1; i <= 56; i++) {
    const date = new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    rows.push({ date, query: "dental implants", page: "/implants", clicks: 1, impressions: 40, position: 11 });
    rows.push({ date, query: "whitening", page: "/whitening", clicks: 1, impressions: 50, position: 2 });
    rows.push({ date, query: "implant cost", page: "/implants", clicks: 1, impressions: 10, position: 9 });
    rows.push({ date, query: "implant cost", page: "/blog/cost", clicks: 1, impressions: 10, position: 12 });
    rows.push({ date, query: "recovery", page: "/recovery", clicks: i <= 28 ? 0 : 3, impressions: 30, position: 4 });
  }
  const insights = detectInsights(rows, today);
  it("finds striking-distance, low-CTR, cannibalization and decay opportunities", () => {
    expect(insights.find((i) => i.type === "striking_distance" && i.query === "dental implants")).toBeTruthy();
    expect(insights.find((i) => i.type === "low_ctr" && i.query === "whitening")).toBeTruthy();
    const cannibal = insights.find((i) => i.type === "cannibalization");
    expect(cannibal && "pages" in cannibal ? cannibal.pages.map((p) => p.page).sort() : []).toEqual(["/blog/cost", "/implants"]);
    expect(insights.find((i) => i.type === "content_decay" && i.page === "/recovery")).toBeTruthy();
  });
});

describe("LLM provider", () => {
  it("is not configured without a key, and refuses the mock in production", () => {
    const saved = { ...process.env };
    try {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.LLM_PROVIDER;
      expect(llmProvider()).toBeNull();
      expect(() => getLlm()).toThrow(/ANTHROPIC_API_KEY/);
      process.env.LLM_PROVIDER = "mock";
      process.env.APP_ENV = "production";
      expect(llmStatus().configured).toBe(false);
      expect(() => getLlm()).toThrow(/disabled in production/);
      process.env.APP_ENV = "development";
      expect(llmStatus().label).toMatch(/mock/i);
    } finally {
      process.env = saved;
    }
  });

  it("runs the brief → draft → review pipeline and labels mock output", async () => {
    const saved = { ...process.env };
    try {
      process.env.LLM_PROVIDER = "mock";
      process.env.APP_ENV = "development";
      const steps: string[] = [];
      const r = await runContentPipeline(getLlm(), {
        websiteId: "00000000-0000-4000-8000-000000000000", topic: "Implant costs", targetKeyword: "dental implants cost", secondaryKeywords: ["implant price"],
        audience: "", tone: "professional", wordCount: 1200, brandNotes: "", clusterId: null,
      }, [{ title: "Implant recovery", url: "https://s.example/recovery" }], async (s) => { steps.push(s); });
      expect(steps).toEqual(["Writing the content brief", "Drafting the article", "Reviewing quality"]);
      expect(r.provider).toBe("mock");
      expect(r.draft.slug).toBe("dental-implants-cost");
      expect(r.draft.bodyMarkdown).toMatch(/development mock/);
      expect(r.draft.bodyMarkdown).toContain("(https://s.example/recovery)");
      expect(r.review.verdict).toBe("needs_revision");
    } finally {
      process.env = saved;
    }
  });
});

describe("audit export", () => {
  const pages = [
    { url: "https://s.example/", status_code: 200, depth: 0, title: "Home, sweet \"home\"", meta_description: null, canonical: "https://s.example/", indexable: true, word_count: 300, load_ms: 120, inlinks: 3, issues: ["missing_meta_description", "img_missing_alt"], details: { evidence: { img_missing_alt: ["1 image(s) without alt", '<img src="/a.jpg">'] } } },
    { url: "https://s.example/old", status_code: 404, depth: 1, title: null, meta_description: null, canonical: null, indexable: null, word_count: null, load_ms: 40, inlinks: 1, issues: ["http_4xx"] },
    { url: "https://s.example/orphan", status_code: 200, depth: -1, title: "=HYPERLINK(\"x\")", meta_description: "d", canonical: null, indexable: true, word_count: 500, load_ms: 90, inlinks: 0, issues: ["orphan_page"] },
  ];

  it("exports one row per page with escaped cells and issue counts", () => {
    const lines = auditPagesCsv(pages).split("\n");
    expect(lines[0]).toBe("url,status_code,title,meta_description,canonical,indexable,word_count,load_ms,inlinks,click_depth,errors,warnings,notices,issues");
    expect(lines[1]).toBe('https://s.example/,200,"Home, sweet ""home""",,https://s.example/,true,300,120,3,0,0,2,0,Missing meta description; Images missing alt text');
    expect(lines[3]).toContain("'=HYPERLINK"); // formula neutralised
    expect(lines[3]).toContain(",sitemap only,");
  });

  it("exports issues sorted by severity with fixes", () => {
    const lines = auditIssuesCsv(pages).split("\n");
    expect(lines[0]).toBe("severity,issue,issue_code,url,status_code,evidence,how_to_fix");
    expect(lines.slice(1).map((l) => l.split(",")[0])).toEqual(["error", "warning", "warning", "warning"]);
    expect(lines.find((l) => l.includes("img_missing_alt"))).toContain('1 image(s) without alt | <img src=""/a.jpg"">');
    expect(lines[1]).toContain("https://s.example/old");
  });

  it("renders a multi-page PDF report", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...pages[i % 3], url: `https://s.example/p${i}`, title: `Página ${i} – “quoted” ✓` }));
    const pdf = await auditPdf({ id: "a1", created_at: "2026-11-11T00:00:00Z", score: 70, pages_crawled: 60, summary: { http_4xx: 20, orphan_page: 20 }, site_checks: { https: true } }, { name: "Café Site", base_url: "https://s.example" }, many);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const pageCount = (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;
    expect(pageCount).toBeGreaterThanOrEqual(2);
  });

  it("builds a JSON report", () => {
    const r = auditJson({ id: "a1", created_at: "2026-11-11T00:00:00Z", score: 70, pages_crawled: 3, summary: { http_4xx: 1, orphan_page: 1 }, site_checks: { https: true } }, { name: "S", base_url: "https://s.example" }, pages);
    expect(r.issues.map((i) => i.code)).toEqual(["http_4xx", "orphan_page"]);
    expect(r.pages).toHaveLength(3);
  });
});
