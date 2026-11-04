import { result } from "@/lib/seo/checks/helpers";
import type { CheckResult, SeoCheck } from "@/lib/seo/types";

export const schemaJsonLd: SeoCheck = {
  name: "schema_jsonld",
  label: "JSON-LD structured data syntax",
  kind: "technical",
  defaultSeverity: "error",
  run(ctx) {
    const blocks = ctx.parsed.jsonLd;
    if (!blocks.length) return [result(this, ctx, "skipped", "No JSON-LD blocks in the content.", { field: "body", severity: "info" })];
    const out: CheckResult[] = [];
    blocks.forEach((raw, i) => {
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch (err) {
        out.push(result(this, ctx, "fail", `JSON-LD block ${i + 1} is not valid JSON: ${(err as Error).message.slice(0, 120)}`, {
          field: "body", remediation: "Fix the JSON syntax (quotes, commas, brackets).",
        }));
        return;
      }
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (!item || typeof item !== "object") {
          out.push(result(this, ctx, "fail", `JSON-LD block ${i + 1} must be an object or array of objects.`, { field: "body" }));
        } else if (!("@context" in item) && !("@graph" in item)) {
          out.push(result(this, ctx, "fail", `JSON-LD block ${i + 1} has no @context.`, { field: "body", severity: "warning", remediation: 'Add "@context": "https://schema.org".' }));
        } else if (!("@type" in item) && !("@graph" in item)) {
          out.push(result(this, ctx, "fail", `JSON-LD block ${i + 1} has no @type.`, { field: "body", severity: "warning" }));
        }
      }
    });
    if (!out.length) out.push(result(this, ctx, "pass", `${blocks.length} JSON-LD block(s) parsed successfully.`, { field: "body" }));
    out.push(result(this, ctx, "skipped", "WordPress may strip <script> tags for users without the unfiltered_html capability; verify after publishing.", {
      field: "body", severity: "info", kind: "recommendation",
    }));
    return out;
  },
};
