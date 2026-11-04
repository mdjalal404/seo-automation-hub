import type { HttpClient } from "@/lib/security/safe-fetch";
import type { ParsedHtml } from "@/lib/seo/html";
import type { ResolvedRules } from "@/lib/seo/rules";

export type Severity = "error" | "warning" | "info";
export type CheckStatus = "pass" | "fail" | "skipped";
/** "technical" = definite defect; "recommendation" = configurable editorial guideline. */
export type CheckKind = "technical" | "recommendation";
export type CheckPhase = "pre_publish" | "post_publish";

export type CheckResult = {
  checkName: string;
  status: CheckStatus;
  severity: Severity;
  kind: CheckKind;
  message: string;
  field?: string;
  url?: string;
  remediation?: string;
  details?: Record<string, unknown>;
};

export type ContentForCheck = {
  id: string;
  websiteId: string;
  title: string;
  slug: string;
  body: string;
  bodyFormat: "markdown" | "html";
  excerpt: string;
  metaTitle: string;
  metaDescription: string;
  canonicalUrl: string;
  targetKeyword: string;
};

/** Looks up other content on the same website (for duplicate checks). */
export type SiblingLookup = {
  findBySlug(websiteId: string, slug: string, excludeId: string): Promise<{ id: string; title: string }[]>;
  findByTitle(websiteId: string, title: string, excludeId: string): Promise<{ id: string; slug: string }[]>;
};

export type CheckContext = {
  content: ContentForCheck;
  html: string;
  parsed: ParsedHtml;
  website: { baseUrl: string };
  rules: ResolvedRules;
  siblings: SiblingLookup;
  http?: HttpClient;
};

export interface SeoCheck {
  name: string;
  label: string;
  kind: CheckKind;
  defaultSeverity: Severity;
  run(ctx: CheckContext): Promise<CheckResult[]> | CheckResult[];
}
