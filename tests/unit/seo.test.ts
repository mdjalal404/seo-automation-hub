import { describe, expect, it } from "vitest";
import { runValidation, summarize } from "@/lib/seo/engine";
import { resolveRules } from "@/lib/seo/rules";
import type { ContentForCheck, SiblingLookup } from "@/lib/seo/types";
import type { HttpClient } from "@/lib/security/safe-fetch";

const noSiblings: SiblingLookup = { findBySlug: async () => [], findByTitle: async () => [] };
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

function article(over: Partial<ContentForCheck> = {}): ContentForCheck {
  return {
    id: "c1", websiteId: "w1",
    title: "A complete guide to technical SEO audits",
    slug: "technical-seo-audits",
    body: `Technical SEO audits matter. ${words(320)}\n\n## Crawling\n\nText about crawling.\n\n### Logs\n\nMore.`,
    bodyFormat: "markdown", excerpt: "",
    metaTitle: "", metaDescription: "Learn how to run a technical SEO audit step by step, from crawling to logs and indexing checks.",
    canonicalUrl: "", targetKeyword: "technical seo",
    ...over,
  };
}

async function run(content: ContentForCheck, opts: { rules?: unknown; siblings?: SiblingLookup; http?: HttpClient } = {}) {
  const rules = resolveRules(opts.rules);
  const results = await runValidation(content, { rules, siblings: opts.siblings ?? noSiblings, website: { baseUrl: "https://client.example.com" }, http: opts.http });
  return { results, summary: summarize(results, rules), failed: (name: string) => results.filter((r) => r.checkName === name && r.status === "fail") };
}

describe("SEO validation engine", () => {
  it("passes a well-formed article", async () => {
    // The filler body is not AI-search friendly; that recommendation is covered in seo-automation.test.ts.
    const { summary, results } = await run(article(), { rules: { checks: { ai_visibility: { enabled: false } } } });
    expect(summary.status).toBe("PASSED");
    expect(results.every((r) => r.checkName && r.status && r.severity && r.message)).toBe(true);
  });

  it("treats missing title and empty content as blocking errors", async () => {
    const { summary, failed } = await run(article({ title: "", body: "" }));
    expect(summary.status).toBe("FAILED");
    expect(failed("title_present")[0].severity).toBe("error");
    expect(failed("content_present")[0].severity).toBe("error");
  });

  it("reports title/description length as warnings, not blockers", async () => {
    const { summary, failed } = await run(article({ title: "Short", metaDescription: "Too short" }));
    expect(failed("title_length")[0]).toMatchObject({ severity: "warning", kind: "recommendation" });
    expect(failed("meta_description_length")[0].severity).toBe("warning");
    expect(summary.status).toBe("PASSED_WITH_WARNINGS");
  });

  it("honours configurable thresholds and blockOnWarnings", async () => {
    const rules = { checks: { title_length: { min: 5, max: 10 } }, publishing: { blockOnWarnings: true } };
    const { failed, summary } = await run(article(), { rules });
    expect(failed("title_length")[0].details).toMatchObject({ min: 5, max: 10 });
    expect(summary.status).toBe("FAILED");
  });

  it("can disable checks per website", async () => {
    const { results } = await run(article({ metaDescription: "" }), { rules: { checks: { meta_description_present: { enabled: false } } } });
    expect(results.find((r) => r.checkName === "meta_description_present")).toBeUndefined();
  });

  it("checks H1 count and heading structure", async () => {
    const { failed } = await run(article({ body: `# Title again\n\n${words(320)}\n\n#### Skipped` }));
    expect(failed("h1_policy")).toHaveLength(1);
    expect(failed("heading_structure").some((r) => /skipped/.test(r.message))).toBe(true);
    const exactlyOne = await run(article({ body: `# Only\n\n${words(320)}\n\n## Section` }), { rules: { checks: { h1_policy: { policy: "exactly_one" } } } });
    expect(exactlyOne.failed("h1_policy")).toHaveLength(0);
  });

  it("flags images missing alt but accepts decorative empty alt", async () => {
    const body = `${words(320)}\n\n## S\n\n<img src="https://x.example.com/a.png">\n<img src="https://x.example.com/b.png" alt="">`;
    const { failed } = await run(article({ body, bodyFormat: "markdown" }));
    expect(failed("image_alt")).toHaveLength(1);
    expect(failed("image_alt")[0].url).toBe("https://x.example.com/a.png");
  });

  it("detects malformed and unsafe URLs", async () => {
    const body = `<p>${words(320)}</p><h2>S</h2><a href="javascript:alert(1)">x</a><a href="https://bad host/">y</a><a href="https://ok.example.com/">z</a>`;
    const { failed } = await run(article({ body, bodyFormat: "html" }));
    expect(failed("url_syntax")).toHaveLength(2);
  });

  it("detects duplicate slugs and titles on the same website", async () => {
    const siblings: SiblingLookup = {
      findBySlug: async () => [{ id: "c2", title: "Other" }],
      findByTitle: async () => [{ id: "c3", slug: "other" }],
    };
    const { failed, summary } = await run(article(), { siblings });
    expect(failed("duplicate_slug")[0].severity).toBe("error");
    expect(failed("duplicate_title")[0].severity).toBe("warning");
    expect(summary.status).toBe("FAILED");
  });

  it("checks internal link destinations with the injected HTTP client", async () => {
    const seen: string[] = [];
    const http: HttpClient = async (url, req) => {
      seen.push(`${req?.method} ${url}`);
      return { status: url.includes("missing") ? 404 : 200, url, headers: {}, text: "" };
    };
    const body = `<p>${words(320)}</p><h2>S</h2><a href="/ok/">a</a><a href="https://client.example.com/missing/">b</a><a href="https://external.example.org/">c</a>`;
    const { failed } = await run(article({ body, bodyFormat: "html" }), { http });
    expect(failed("internal_links")).toHaveLength(1);
    expect(failed("internal_links")[0].url).toContain("missing");
    expect(seen.some((s) => s.includes("external"))).toBe(false);
  });

  it("validates JSON-LD syntax", async () => {
    const good = `<p>${words(320)}</p><h2>S</h2><script type="application/ld+json">{"@context":"https://schema.org","@type":"Article"}</script>`;
    const bad = `<p>${words(320)}</p><h2>S</h2><script type="application/ld+json">{"@context": "https://schema.org",}</script>`;
    expect((await run(article({ body: good, bodyFormat: "html" }))).failed("schema_jsonld")).toHaveLength(0);
    expect((await run(article({ body: bad, bodyFormat: "html" }))).failed("schema_jsonld")[0].severity).toBe("error");
  });

  it("validates canonical syntax and host consistency", async () => {
    expect((await run(article({ canonicalUrl: "not-a-url" }))).failed("canonical_url")[0].severity).toBe("error");
    expect((await run(article({ canonicalUrl: "https://other.example.net/x" }))).failed("canonical_url")[0].severity).toBe("warning");
    expect((await run(article({ canonicalUrl: "https://client.example.com/technical-seo-audits/" }))).failed("canonical_url")).toHaveLength(0);
  });

  it("isolates a crashing check", async () => {
    const siblings: SiblingLookup = { findBySlug: async () => { throw new Error("db down"); }, findByTitle: async () => [] };
    const { results } = await run(article(), { siblings });
    expect(results.find((r) => r.checkName === "duplicate_slug")).toMatchObject({ status: "skipped", severity: "warning" });
  });
});
