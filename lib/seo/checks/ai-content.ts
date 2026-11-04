import { estimateAiShare, MIN_WORDS_FOR_ESTIMATE } from "@/lib/seo/ai-detection";
import { blockText } from "@/lib/seo/html";
import { result, rule } from "@/lib/seo/checks/helpers";
import type { SeoCheck } from "@/lib/seo/types";

const METHOD_LABEL = { heuristic: "built-in estimate", sapling: "Sapling AI detector" } as const;

/** Flags articles whose text largely reads as AI-generated, with the estimated share. */
export const aiContent: SeoCheck = {
  name: "ai_content",
  label: "AI-written content",
  kind: "recommendation",
  defaultSeverity: "warning",
  async run(ctx) {
    const wc = ctx.parsed.wordCount;
    if (wc < MIN_WORDS_FOR_ESTIMATE) {
      return [result(this, ctx, "skipped", `Too little text (${wc} words) to estimate AI-written content.`, { field: "body", severity: "info" })];
    }
    const threshold = Number(rule(ctx, this.name).maxAiPercent ?? 40);
    const est = await estimateAiShare(blockText(ctx.parsed.doc), ctx.http);
    const details = { aiPercent: est.aiPercent, threshold, method: est.method, sentencesAnalyzed: est.sentencesAnalyzed, flagged: est.flagged, ...(est.note ? { note: est.note } : {}) };
    const how = METHOD_LABEL[est.method];
    if (est.aiPercent >= threshold) {
      return [result(this, ctx, "fail", `AI-written content: about ${est.aiPercent}% of the text reads as AI-generated (${how}).`, {
        field: "body",
        details,
        remediation: `Rewrite the flagged passages with first-hand detail, specific examples and the brand's own voice until the estimate is below ${threshold}%.`,
      })];
    }
    return [result(this, ctx, "pass", `About ${est.aiPercent}% of the text reads as AI-generated (${how}); below your ${threshold}% limit.`, { field: "body", details })];
  },
};
