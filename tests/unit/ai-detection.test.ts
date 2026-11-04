import { describe, expect, it } from "vitest";
import { documentProfile, estimateAiShare, heuristicEstimate, splitSentences } from "@/lib/seo/ai-detection";
import { DEFAULT_RULES, resolveRules } from "@/lib/seo/rules";
import { runValidation } from "@/lib/seo/engine";
import type { HttpClient } from "@/lib/security/safe-fetch";
import { AI_TEXT, CHATGPT_ARTICLE, CHATGPT_SERVICE_PAGE, HUMAN_TEXT } from "../support/ai-samples";


describe("AI-written content estimate", () => {
  it("splits text into sentences and lines", () => {
    expect(splitSentences("First sentence here. Second one is here!\nA heading line\nok")).toEqual(["First sentence here.", "Second one is here!"]);
  });

  it("rates formulaic LLM-style copy high and personal, varied writing low", () => {
    const ai = heuristicEstimate(AI_TEXT);
    const human = heuristicEstimate(HUMAN_TEXT);
    expect(ai.aiPercent).toBeGreaterThanOrEqual(70);
    expect(ai.flagged.length).toBeGreaterThan(0);
    expect(human.aiPercent).toBeLessThanOrEqual(15);
    expect(ai.method).toBe("heuristic");
  });

  it("detects modern ChatGPT articles that avoid stock phrases, from their overall style", () => {
    for (const text of [CHATGPT_ARTICLE, CHATGPT_SERVICE_PAGE]) {
      const est = heuristicEstimate(text);
      expect(est.aiPercent).toBeGreaterThanOrEqual(80);
    }
    expect(documentProfile(CHATGPT_ARTICLE).features).toMatchObject({ formal: 1, conclusion: 1 });
    expect(documentProfile(HUMAN_TEXT).score).toBeLessThan(0.3);
  });

  it("does not count headings as sentences", () => {
    expect(splitSentences("Why Choose Us?\nWe fixed 140 redirects in a weekend.\nConclusion")).toEqual(["We fixed 140 redirects in a weekend."]);
  });

  it("reports the share of a mixed article", () => {
    const mixed = heuristicEstimate(`${HUMAN_TEXT}\n${AI_TEXT}`);
    expect(mixed.aiPercent).toBeGreaterThan(25);
    expect(mixed.aiPercent).toBeLessThan(75);
  });

  it("uses Sapling only when configured, and falls back to the heuristic on failure", async () => {
    const calls: string[] = [];
    const http: HttpClient = async (url, req) => {
      calls.push(url);
      const body = JSON.parse(req?.body ?? "{}") as { key: string };
      if (body.key !== "test-key") return { status: 401, headers: {}, text: "{}", url };
      return { status: 200, headers: {}, url, text: JSON.stringify({ score: 0.9, sentence_scores: [{ score: 0.95, sentence: "one two three four" }, { score: 0.1, sentence: "five six seven eight" }] }) };
    };
    expect((await estimateAiShare(AI_TEXT, http)).method).toBe("heuristic");
    expect(calls).toHaveLength(0);

    process.env.AI_DETECTION_PROVIDER = "sapling";
    process.env.SAPLING_API_KEY = "test-key";
    try {
      expect(await estimateAiShare(AI_TEXT, http)).toMatchObject({ method: "sapling", aiPercent: 50, flagged: ["one two three four"] });
      expect(await estimateAiShare(AI_TEXT)).toMatchObject({ method: "heuristic" }); // offline: no network call
      process.env.SAPLING_API_KEY = "wrong";
      expect(await estimateAiShare(AI_TEXT, http)).toMatchObject({ method: "heuristic", note: expect.stringMatching(/unavailable/) });
    } finally {
      delete process.env.AI_DETECTION_PROVIDER;
      delete process.env.SAPLING_API_KEY;
    }
  });

  it("appears as a warning with the percentage in validation results, with a configurable threshold", async () => {
    const siblings = { findBySlug: async () => [], findByTitle: async () => [] };
    const content = { id: "c", websiteId: "w", title: "Local SEO", slug: "local-seo", body: AI_TEXT, bodyFormat: "markdown" as const, excerpt: "", metaTitle: "", metaDescription: "", canonicalUrl: "", targetKeyword: "" };
    const results = await runValidation(content, { rules: DEFAULT_RULES, siblings, website: { baseUrl: "https://example.com" }, offline: true });
    const ai = results.find((r) => r.checkName === "ai_content")!;
    expect(ai).toMatchObject({ status: "fail", severity: "warning" });
    expect(ai.message).toMatch(/AI-written content: about \d+% of the text/);
    expect(ai.details).toMatchObject({ method: "heuristic", threshold: 40 });

    const lenient = resolveRules({ checks: { ai_content: { maxAiPercent: 80 } } });
    const pass = (await runValidation({ ...content, body: `${HUMAN_TEXT}\n\n${AI_TEXT}` }, { rules: lenient, siblings, website: { baseUrl: "https://example.com" }, offline: true })).find((r) => r.checkName === "ai_content")!;
    expect(pass.status).toBe("pass");

    const short = (await runValidation({ ...content, body: "Too short." }, { rules: DEFAULT_RULES, siblings, website: { baseUrl: "https://example.com" }, offline: true })).find((r) => r.checkName === "ai_content")!;
    expect(short.status).toBe("skipped");
  });
});
