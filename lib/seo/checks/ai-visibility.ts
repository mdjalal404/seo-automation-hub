import { aiReadiness } from "@/lib/seo/ai-visibility";
import { result, rule } from "@/lib/seo/checks/helpers";
import type { SeoCheck } from "@/lib/seo/types";

/** Warns when an article lacks the on-page signals AI answer engines rely on to cite pages. */
export const aiVisibility: SeoCheck = {
  name: "ai_visibility",
  label: "AI search readiness",
  kind: "recommendation",
  defaultSeverity: "warning",
  run(ctx) {
    if (ctx.parsed.wordCount < 80) {
      return [result(this, ctx, "skipped", "Too little text to assess AI search readiness.", { field: "body", severity: "info" })];
    }
    const minScore = Number(rule(ctx, this.name)?.minScore ?? 60);
    let siteHost: string | undefined;
    try {
      siteHost = new URL(ctx.website.baseUrl).hostname;
    } catch {
      siteHost = undefined;
    }
    const report = aiReadiness(ctx.parsed, { keyword: ctx.content.targetKeyword, siteHost });
    const missing = report.signals.filter((s) => !s.passed);
    const details = { score: report.score, minScore, signals: report.signals };
    if (report.score < minScore) {
      return [result(this, ctx, "fail", `AI search readiness ${report.score}/100 — likely hard for AI answer engines to quote. Missing: ${missing.map((s) => s.label.toLowerCase()).join(", ")}.`, {
        field: "body", details, remediation: missing.slice(0, 3).map((s) => s.tip).join(" "),
      })];
    }
    return [result(this, ctx, "pass", `AI search readiness ${report.score}/100${missing.length ? ` (could improve: ${missing.map((s) => s.label.toLowerCase()).join(", ")})` : ""}.`, { field: "body", details })];
  },
};
