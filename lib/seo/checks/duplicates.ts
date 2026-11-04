import { result } from "@/lib/seo/checks/helpers";
import type { SeoCheck } from "@/lib/seo/types";

export const duplicateSlug: SeoCheck = {
  name: "duplicate_slug",
  label: "Duplicate slug on this website",
  kind: "technical",
  defaultSeverity: "error",
  async run(ctx) {
    if (!ctx.content.slug) return [result(this, ctx, "skipped", "No slug to compare.", { field: "slug", severity: "info" })];
    const dupes = await ctx.siblings.findBySlug(ctx.content.websiteId, ctx.content.slug, ctx.content.id);
    return dupes.length
      ? [result(this, ctx, "fail", `Slug "${ctx.content.slug}" is already used by ${dupes.length} other article(s) on this website.`, {
          field: "slug", details: { conflicts: dupes.slice(0, 5) },
          remediation: "Choose a unique slug; WordPress would otherwise append -2 and change the URL.",
        })]
      : [result(this, ctx, "pass", "Slug is unique on this website.", { field: "slug" })];
  },
};

export const duplicateTitle: SeoCheck = {
  name: "duplicate_title",
  label: "Duplicate title on this website",
  kind: "recommendation",
  defaultSeverity: "warning",
  async run(ctx) {
    const title = ctx.content.title.trim();
    if (!title) return [result(this, ctx, "skipped", "No title to compare.", { field: "title", severity: "info" })];
    const dupes = await ctx.siblings.findByTitle(ctx.content.websiteId, title, ctx.content.id);
    return dupes.length
      ? [result(this, ctx, "fail", `${dupes.length} other article(s) on this website have the same title.`, {
          field: "title", details: { conflicts: dupes.slice(0, 5) }, remediation: "Differentiate titles to avoid competing pages.",
        })]
      : [result(this, ctx, "pass", "Title is unique among articles tracked in this workspace.", { field: "title" })];
  },
};
