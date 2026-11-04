import { result, rule } from "@/lib/seo/checks/helpers";
import type { CheckResult, SeoCheck } from "@/lib/seo/types";

export const contentPresent: SeoCheck = {
  name: "content_present",
  label: "Content is not empty",
  kind: "technical",
  defaultSeverity: "error",
  run(ctx) {
    return ctx.parsed.wordCount > 0
      ? [result(this, ctx, "pass", `Content has ${ctx.parsed.wordCount} words.`, { field: "body" })]
      : [result(this, ctx, "fail", "The article body is empty.", { field: "body", remediation: "Add the article content." })];
  },
};

export const contentLength: SeoCheck = {
  name: "content_length",
  label: "Minimum word count",
  kind: "recommendation",
  defaultSeverity: "warning",
  run(ctx) {
    const minWords = Number(rule(ctx, this.name).minWords ?? 0);
    const wc = ctx.parsed.wordCount;
    if (wc === 0) return [result(this, ctx, "skipped", "No content to measure.", { field: "body", severity: "info" })];
    return wc >= minWords
      ? [result(this, ctx, "pass", `Word count ${wc} meets your minimum of ${minWords}.`, { field: "body" })]
      : [result(this, ctx, "fail", `Word count ${wc} is below your preferred minimum of ${minWords}.`, { field: "body", details: { wordCount: wc, minWords } })];
  },
};

export const h1Policy: SeoCheck = {
  name: "h1_policy",
  label: "H1 presence and count",
  kind: "recommendation",
  defaultSeverity: "warning",
  run(ctx) {
    const policy = String(rule(ctx, this.name).policy ?? "none_in_body");
    const count = ctx.parsed.headings.filter((h) => h.level === 1).length;
    if (policy === "any") return [result(this, ctx, "pass", `Body contains ${count} H1 heading(s).`, { field: "body" })];
    if (policy === "none_in_body") {
      return count === 0
        ? [result(this, ctx, "pass", "No H1 in the body (most WordPress themes render the post title as the H1).", { field: "body" })]
        : [result(this, ctx, "fail", `Body contains ${count} H1 heading(s); the theme usually adds the title as H1, producing multiple H1s.`, {
            field: "body", details: { count }, remediation: "Change body H1s to H2, or set the H1 policy to 'exactly one' if your theme does not output the title as H1.",
          })];
    }
    return count === 1
      ? [result(this, ctx, "pass", "Body contains exactly one H1.", { field: "body" })]
      : [result(this, ctx, "fail", `Expected exactly one H1 in the body, found ${count}.`, { field: "body", details: { count } })];
  },
};

export const headingStructure: SeoCheck = {
  name: "heading_structure",
  label: "Heading structure",
  kind: "recommendation",
  defaultSeverity: "warning",
  run(ctx) {
    const cfg = rule(ctx, this.name);
    const minH2 = Number(cfg.minH2 ?? 0);
    const out: CheckResult[] = [];
    const h2 = ctx.parsed.headings.filter((h) => h.level === 2).length;
    if (h2 < minH2) {
      out.push(result(this, ctx, "fail", `Found ${h2} H2 subheading(s); your rules require at least ${minH2}.`, {
        field: "body", remediation: "Break the article into sections with H2 subheadings.",
      }));
    }
    if (cfg.noSkippedLevels) {
      let prev = 1;
      for (const h of ctx.parsed.headings) {
        if (h.level > prev + 1) {
          out.push(result(this, ctx, "fail", `Heading level skipped: H${prev} followed by H${h.level} ("${h.text.slice(0, 60)}").`, {
            field: "body", details: { from: prev, to: h.level },
          }));
        }
        prev = h.level;
      }
    }
    const empty = ctx.parsed.headings.filter((h) => !h.text);
    if (empty.length) out.push(result(this, ctx, "fail", `${empty.length} heading(s) are empty.`, { field: "body", severity: "warning", kind: "technical" }));
    return out.length ? out : [result(this, ctx, "pass", "Heading structure is consistent.", { field: "body" })];
  },
};

export const imageAlt: SeoCheck = {
  name: "image_alt",
  label: "Image alt attributes",
  kind: "technical",
  defaultSeverity: "warning",
  run(ctx) {
    const images = ctx.parsed.images;
    if (!images.length) return [result(this, ctx, "skipped", "No images in the content.", { field: "body", severity: "info" })];
    const missing = images.filter((i) => i.alt === undefined);
    if (!missing.length) return [result(this, ctx, "pass", `All ${images.length} image(s) have alt attributes.`, { field: "body" })];
    return missing.map((img) =>
      result(this, ctx, "fail", "Image is missing an alt attribute.", {
        field: "body", url: img.src, remediation: 'Add descriptive alt text, or alt="" if the image is purely decorative.',
      }),
    );
  },
};
