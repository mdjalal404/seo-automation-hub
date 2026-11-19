import { z } from "zod";
import type { LlmClient, LlmUsage } from "@/lib/ai/llm";
import { aiReadiness } from "@/lib/seo/ai-visibility";
import { estimateAiShare } from "@/lib/seo/ai-detection";
import { blockText, parseHtml, renderBody } from "@/lib/seo/html";

/**
 * Content QA at scale: an LLM rubric (helpfulness, expertise, accuracy risk, originality,
 * readability, on-page SEO) combined with deterministic signals (AI-share estimate, AI-search
 * readiness, length). The verdict is decided by fixed thresholds in code, not by the model, so
 * results are comparable across thousands of pages and model versions.
 */
const rubricSchema = z.object({
  scores: z.object({ helpfulness: z.number(), expertise: z.number(), accuracy: z.number(), originality: z.number(), readability: z.number(), seo: z.number() }),
  claimsToVerify: z.array(z.string()),
  issues: z.array(z.object({ severity: z.enum(["high", "medium", "low"]), message: z.string() })),
});
export type QaRubric = z.infer<typeof rubricSchema>;

export type QaResult = {
  verdict: "pass" | "needs_revision" | "fail";
  scores: Record<string, number>;
  issues: { severity: "high" | "medium" | "low"; message: string; source: "llm" | "rule" }[];
  claimsToVerify: string[];
  model: string;
  provider: LlmClient["provider"];
  usage: LlmUsage;
};

export const QA_THRESHOLDS = { failBelow: 4, reviseBelow: 6.5, maxAiPercent: 60, minReadiness: 50, minWords: 300 };

export function decideVerdict(scores: Record<string, number>, issues: QaResult["issues"]): QaResult["verdict"] {
  const llm = ["helpfulness", "expertise", "accuracy", "originality", "readability", "seo"].map((k) => scores[k]).filter((n) => typeof n === "number");
  const min = Math.min(...llm);
  const avg = llm.reduce((a, b) => a + b, 0) / (llm.length || 1);
  if (min < QA_THRESHOLDS.failBelow || issues.some((i) => i.severity === "high" && i.source === "llm" && /fabricat|false|incorrect|dangerous|plagiar/i.test(i.message))) return "fail";
  if (avg < QA_THRESHOLDS.reviseBelow || issues.some((i) => i.severity === "high")) return "needs_revision";
  return "pass";
}

export async function reviewContent(llm: LlmClient, item: { title: string; body: string; body_format: "markdown" | "html"; target_keyword: string }): Promise<QaResult> {
  const html = renderBody(item.body, item.body_format);
  const parsed = parseHtml(html);
  const issues: QaResult["issues"] = [];
  const ai = await estimateAiShare(blockText(parsed.doc));
  const readiness = aiReadiness(parsed, { keyword: item.target_keyword });
  if (parsed.wordCount < QA_THRESHOLDS.minWords) issues.push({ severity: "medium", message: `Only ${parsed.wordCount} words.`, source: "rule" });
  if (ai.aiPercent >= QA_THRESHOLDS.maxAiPercent) issues.push({ severity: "medium", message: `About ${ai.aiPercent}% reads as AI-generated; add first-hand detail and brand voice.`, source: "rule" });
  if (readiness.score < QA_THRESHOLDS.minReadiness) issues.push({ severity: "low", message: `AI search readiness ${readiness.score}/100.`, source: "rule" });

  const res = await llm.structured({
    system: "You are a strict editorial QA reviewer for SEO content. Score 0-10 honestly; most drafts score 5-7. Flag factual claims that need a source, and anything inaccurate, unsafe or misleading as high severity.",
    prompt: `Target query: "${item.target_keyword || "(none)"}"\nTitle: ${item.title}\n\n${parsed.text.slice(0, 60_000)}`,
    schema: rubricSchema,
    maxTokens: 4_000,
    effort: "low",
    mock: () => ({
      scores: { helpfulness: 6, expertise: 5, accuracy: 7, originality: 5, readability: 7, seo: parsed.wordCount > 600 ? 7 : 5 },
      claimsToVerify: [],
      issues: [{ severity: "low", message: "Development mock review (no model was called).", source: "llm" }] as never,
    }),
  });
  issues.push(...res.data.issues.map((i) => ({ ...i, source: "llm" as const })));
  const scores = { ...res.data.scores, ai_percent: ai.aiPercent, ai_readiness: readiness.score, words: parsed.wordCount };
  return { verdict: decideVerdict(scores, issues), scores, issues, claimsToVerify: res.data.claimsToVerify, model: res.model, provider: res.provider, usage: res.usage };
}
