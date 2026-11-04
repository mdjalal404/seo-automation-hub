import { effectiveTitle, result, rule } from "@/lib/seo/checks/helpers";
import type { SeoCheck } from "@/lib/seo/types";

export const titlePresent: SeoCheck = {
  name: "title_present",
  label: "Title is present",
  kind: "technical",
  defaultSeverity: "error",
  run(ctx) {
    return ctx.content.title.trim()
      ? [result(this, ctx, "pass", "Title is present.", { field: "title" })]
      : [result(this, ctx, "fail", "The article has no title.", { field: "title", remediation: "Add a descriptive title." })];
  },
};

export const metaDescriptionPresent: SeoCheck = {
  name: "meta_description_present",
  label: "Meta description is present",
  kind: "recommendation",
  defaultSeverity: "warning",
  run(ctx) {
    return ctx.content.metaDescription.trim()
      ? [result(this, ctx, "pass", "Meta description is present.", { field: "meta_description" })]
      : [result(this, ctx, "fail", "No meta description. Search engines will generate a snippet from the page.", {
          field: "meta_description",
          remediation: "Write a 1–2 sentence summary that includes the main topic.",
        })];
  },
};

export const titleLength: SeoCheck = {
  name: "title_length",
  label: "Title length",
  kind: "recommendation",
  defaultSeverity: "warning",
  run(ctx) {
    const { min, max } = rule(ctx, this.name) as unknown as { min: number; max: number };
    const title = effectiveTitle(ctx);
    if (!title) return [result(this, ctx, "skipped", "No title to measure.", { field: "meta_title", severity: "info" })];
    const len = [...title].length;
    const field = ctx.content.metaTitle ? "meta_title" : "title";
    if (len < min || len > max) {
      return [result(this, ctx, "fail", `SEO title is ${len} characters; your preferred range is ${min}–${max}.`, {
        field,
        details: { length: len, min, max },
        remediation: len > max ? "Shorten the title so it is less likely to be truncated in results." : "Make the title more descriptive.",
      })];
    }
    return [result(this, ctx, "pass", `SEO title length (${len}) is within ${min}–${max}.`, { field, details: { length: len } })];
  },
};

export const metaDescriptionLength: SeoCheck = {
  name: "meta_description_length",
  label: "Meta description length",
  kind: "recommendation",
  defaultSeverity: "warning",
  run(ctx) {
    const { min, max } = rule(ctx, this.name) as unknown as { min: number; max: number };
    const desc = ctx.content.metaDescription.trim();
    if (!desc) return [result(this, ctx, "skipped", "No meta description to measure.", { field: "meta_description", severity: "info" })];
    const len = [...desc].length;
    if (len < min || len > max) {
      return [result(this, ctx, "fail", `Meta description is ${len} characters; your preferred range is ${min}–${max}.`, {
        field: "meta_description",
        details: { length: len, min, max },
        remediation: len > max ? "Trim the description; long snippets are usually truncated." : "Add more detail to the description.",
      })];
    }
    return [result(this, ctx, "pass", `Meta description length (${len}) is within ${min}–${max}.`, { field: "meta_description" })];
  },
};

export const slugPresent: SeoCheck = {
  name: "slug_present",
  label: "Slug is present and well-formed",
  kind: "technical",
  defaultSeverity: "error",
  run(ctx) {
    const slug = ctx.content.slug;
    if (!slug) return [result(this, ctx, "fail", "The article has no slug.", { field: "slug", remediation: "Set a URL slug such as my-article-title." })];
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      return [result(this, ctx, "fail", "The slug contains invalid characters.", { field: "slug", remediation: "Use lowercase letters, numbers and hyphens." })];
    }
    return [result(this, ctx, "pass", "Slug is well-formed.", { field: "slug" })];
  },
};

export const canonicalUrl: SeoCheck = {
  name: "canonical_url",
  label: "Canonical URL syntax and consistency",
  kind: "technical",
  defaultSeverity: "error",
  run(ctx) {
    const raw = ctx.content.canonicalUrl.trim();
    if (!raw) return [result(this, ctx, "skipped", "No canonical URL set; the CMS default will apply.", { field: "canonical_url", severity: "info" })];
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return [result(this, ctx, "fail", "Canonical URL is not a valid absolute URL.", { field: "canonical_url", url: raw, remediation: "Use a full URL including https://." })];
    }
    const out = [];
    if (!/^https?:$/.test(url.protocol)) {
      out.push(result(this, ctx, "fail", "Canonical URL must use http or https.", { field: "canonical_url", url: raw }));
    }
    if (url.hash) {
      out.push(result(this, ctx, "fail", "Canonical URL should not contain a #fragment.", { field: "canonical_url", url: raw, remediation: "Remove the fragment." }));
    }
    const siteHost = safeHost(ctx.website.baseUrl);
    if (siteHost && url.hostname.toLowerCase() !== siteHost) {
      out.push(result(this, ctx, "fail", `Canonical points to another host (${url.hostname}). This is valid only for intentional cross-domain canonicals.`, {
        field: "canonical_url", url: raw, severity: "warning", kind: "recommendation",
      }));
    }
    if (out.length === 0) out.push(result(this, ctx, "pass", "Canonical URL is valid and on this website.", { field: "canonical_url", url: raw }));
    return out;
  },
};

export const keywordUsage: SeoCheck = {
  name: "keyword_usage",
  label: "Target keyword usage",
  kind: "recommendation",
  defaultSeverity: "info",
  run(ctx) {
    const kw = ctx.content.targetKeyword.trim().toLowerCase();
    if (!kw) return [result(this, ctx, "skipped", "No target keyword set.", { field: "target_keyword", severity: "info" })];
    const inTitle = effectiveTitle(ctx).toLowerCase().includes(kw);
    const firstWords = ctx.parsed.text.split(" ").slice(0, 150).join(" ").toLowerCase();
    const inIntro = firstWords.includes(kw);
    if (inTitle && inIntro) return [result(this, ctx, "pass", "Target keyword appears in the title and introduction.", { field: "target_keyword" })];
    return [result(this, ctx, "fail", `Target keyword not found in ${[!inTitle && "the title", !inIntro && "the first 150 words"].filter(Boolean).join(" or ")}.`, {
      field: "target_keyword",
      remediation: "Consider using the keyword naturally where it fits. This is guidance, not a requirement.",
    })];
  },
};

function safeHost(u: string) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}
