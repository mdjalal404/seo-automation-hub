import { canonicalUrl, keywordUsage, metaDescriptionLength, metaDescriptionPresent, slugPresent, titleLength, titlePresent } from "@/lib/seo/checks/metadata";
import { contentLength, contentPresent, h1Policy, headingStructure, imageAlt } from "@/lib/seo/checks/structure";
import { internalLinks, urlSyntax } from "@/lib/seo/checks/links";
import { duplicateSlug, duplicateTitle } from "@/lib/seo/checks/duplicates";
import { schemaJsonLd } from "@/lib/seo/checks/schema";
import { aiContent } from "@/lib/seo/checks/ai-content";
import { parseHtml, renderBody } from "@/lib/seo/html";
import type { ResolvedRules } from "@/lib/seo/rules";
import type { CheckContext, CheckResult, ContentForCheck, SeoCheck, SiblingLookup } from "@/lib/seo/types";
import type { HttpClient } from "@/lib/security/safe-fetch";

/** Registry of pre-publication checks. Add a check by implementing SeoCheck and registering it here. */
const registry = new Map<string, SeoCheck>();
export function registerCheck(check: SeoCheck) {
  registry.set(check.name, check);
}
[
  titlePresent, metaDescriptionPresent, titleLength, metaDescriptionLength, slugPresent, h1Policy, headingStructure,
  contentPresent, contentLength, imageAlt, urlSyntax, duplicateSlug, duplicateTitle, internalLinks, schemaJsonLd,
  canonicalUrl, keywordUsage, aiContent,
].forEach(registerCheck);

export function listChecks(): SeoCheck[] {
  return [...registry.values()];
}

export type ValidationOptions = {
  rules: ResolvedRules;
  siblings: SiblingLookup;
  website: { baseUrl: string };
  http?: HttpClient;
  /** Skip network checks (used for the quick re-check right before publishing). */
  offline?: boolean;
};

export async function runValidation(content: ContentForCheck, opts: ValidationOptions): Promise<CheckResult[]> {
  const html = renderBody(content.body, content.bodyFormat);
  const ctx: CheckContext = {
    content,
    html,
    parsed: parseHtml(html),
    website: opts.website,
    rules: opts.rules,
    siblings: opts.siblings,
    http: opts.offline ? undefined : opts.http,
  };
  const checks = listChecks().filter((c) => opts.rules.checks[c.name]?.enabled !== false);
  const settled = await Promise.allSettled(checks.map(async (c) => c.run(ctx)));
  return settled.flatMap((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : [{
          checkName: checks[i].name,
          status: "skipped" as const,
          severity: "warning" as const,
          kind: checks[i].kind,
          message: "This check could not run. Try validation again.",
        }],
  );
}

export type ValidationSummary = {
  status: "PASSED" | "PASSED_WITH_WARNINGS" | "FAILED";
  errors: number;
  warnings: number;
  blocking: CheckResult[];
};

/** Errors always block; warnings block only when the workspace/website opts in. */
export function summarize(results: CheckResult[], rules: ResolvedRules): ValidationSummary {
  const failed = results.filter((r) => r.status === "fail");
  const errors = failed.filter((r) => r.severity === "error");
  const warnings = failed.filter((r) => r.severity === "warning");
  const blocking = rules.publishing.blockOnWarnings ? [...errors, ...warnings] : errors;
  return {
    status: blocking.length ? "FAILED" : warnings.length ? "PASSED_WITH_WARNINGS" : "PASSED",
    errors: errors.length,
    warnings: warnings.length,
    blocking,
  };
}
