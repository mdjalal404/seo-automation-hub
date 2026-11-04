import { z } from "zod";
import type { Severity } from "@/lib/seo/types";

/**
 * Validation rule configuration. Defaults are layered: built-in → workspace → website.
 * Length targets are editorial recommendations (warnings), not search-engine requirements.
 */
const severity = z.enum(["error", "warning", "info"]);

const checkRule = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ enabled: z.boolean(), severity, ...shape }).partial();

export const rulesSchema = z.object({
  checks: z
    .object({
      title_present: checkRule({}),
      meta_description_present: checkRule({}),
      title_length: checkRule({ min: z.number().int().min(0).max(300), max: z.number().int().min(1).max(300) }),
      meta_description_length: checkRule({ min: z.number().int().min(0).max(1000), max: z.number().int().min(1).max(1000) }),
      slug_present: checkRule({}),
      h1_policy: checkRule({ policy: z.enum(["none_in_body", "exactly_one", "any"]) }),
      heading_structure: checkRule({ minH2: z.number().int().min(0).max(50), noSkippedLevels: z.boolean() }),
      content_present: checkRule({}),
      content_length: checkRule({ minWords: z.number().int().min(0).max(20000) }),
      image_alt: checkRule({}),
      url_syntax: checkRule({}),
      duplicate_slug: checkRule({}),
      duplicate_title: checkRule({}),
      internal_links: checkRule({ maxLinks: z.number().int().min(0).max(50) }),
      schema_jsonld: checkRule({}),
      canonical_url: checkRule({}),
      keyword_usage: checkRule({}),
      ai_content: checkRule({ maxAiPercent: z.number().int().min(1).max(100) }),
    })
    .partial(),
  publishing: z
    .object({
      blockOnWarnings: z.boolean(),
      verifyAfterPublish: z.boolean(),
    })
    .partial(),
}).partial();
export type RulesOverride = z.infer<typeof rulesSchema>;

export type ResolvedCheckRule = { enabled: boolean; severity: Severity } & Record<string, unknown>;
export type ResolvedRules = {
  checks: Record<string, ResolvedCheckRule>;
  publishing: { blockOnWarnings: boolean; verifyAfterPublish: boolean };
};

export const DEFAULT_RULES: ResolvedRules = {
  checks: {
    title_present: { enabled: true, severity: "error" },
    meta_description_present: { enabled: true, severity: "warning" },
    title_length: { enabled: true, severity: "warning", min: 30, max: 60 },
    meta_description_length: { enabled: true, severity: "warning", min: 70, max: 160 },
    slug_present: { enabled: true, severity: "error" },
    h1_policy: { enabled: true, severity: "warning", policy: "none_in_body" },
    heading_structure: { enabled: true, severity: "warning", minH2: 1, noSkippedLevels: true },
    content_present: { enabled: true, severity: "error" },
    content_length: { enabled: true, severity: "warning", minWords: 300 },
    image_alt: { enabled: true, severity: "warning" },
    url_syntax: { enabled: true, severity: "error" },
    duplicate_slug: { enabled: true, severity: "error" },
    duplicate_title: { enabled: true, severity: "warning" },
    internal_links: { enabled: true, severity: "warning", maxLinks: 20 },
    schema_jsonld: { enabled: true, severity: "error" },
    canonical_url: { enabled: true, severity: "error" },
    keyword_usage: { enabled: true, severity: "info" },
    ai_content: { enabled: true, severity: "warning", maxAiPercent: 40 },
  },
  publishing: { blockOnWarnings: false, verifyAfterPublish: true },
};

/** Merges overrides (invalid overrides are ignored, never trusted blindly). */
export function resolveRules(...overrides: unknown[]): ResolvedRules {
  const out: ResolvedRules = structuredClone(DEFAULT_RULES);
  for (const raw of overrides) {
    const parsed = rulesSchema.safeParse(raw ?? {});
    if (!parsed.success) continue;
    for (const [name, rule] of Object.entries(parsed.data.checks ?? {})) {
      if (out.checks[name] && rule) Object.assign(out.checks[name], stripUndefined(rule));
    }
    Object.assign(out.publishing, stripUndefined(parsed.data.publishing ?? {}));
  }
  return out;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
