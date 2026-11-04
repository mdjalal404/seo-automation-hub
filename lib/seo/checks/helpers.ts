import type { CheckContext, CheckKind, CheckResult, SeoCheck, Severity } from "@/lib/seo/types";

export function rule(ctx: CheckContext, name: string) {
  return ctx.rules.checks[name];
}

export function result(
  check: Pick<SeoCheck, "name" | "kind">,
  ctx: CheckContext,
  status: CheckResult["status"],
  message: string,
  extra: Partial<Omit<CheckResult, "checkName" | "status" | "message">> = {},
): CheckResult {
  const sev: Severity = extra.severity ?? (status === "pass" ? "info" : rule(ctx, check.name)?.severity ?? "warning");
  const kind: CheckKind = extra.kind ?? check.kind;
  return { checkName: check.name, status, message, ...extra, severity: sev, kind };
}

/** The title search engines are most likely to use: SEO meta title, else post title. */
export function effectiveTitle(ctx: CheckContext) {
  return (ctx.content.metaTitle || ctx.content.title).trim();
}
