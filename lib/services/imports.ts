import "server-only";
import { unwrap } from "@/lib/actions/result";
import { assertCan, type SessionContext } from "@/lib/auth/session";
import { parseContentCsv } from "@/lib/csv/import";
import { AppError } from "@/lib/errors";
import { zonedLocalToUtc } from "@/lib/scheduling/timezone";
import { audit } from "@/lib/services/audit";

async function context(ctx: SessionContext) {
  const websites = unwrap(await ctx.supabase.from("websites").select("id, name, base_url, timezone").eq("organization_id", ctx.org.id)) ?? [];
  const existing = unwrap(await ctx.supabase.from("content_items").select("website_id, slug").eq("organization_id", ctx.org.id).neq("status", "CANCELLED").limit(50_000)) ?? [];
  return { websites, existingSlugs: new Set(existing.map((e) => `${e.website_id}:${e.slug}`)) };
}

export async function previewCsv(ctx: SessionContext, text: string) {
  assertCan(ctx, "content.create");
  const { websites, existingSlugs } = await context(ctx);
  return parseContentCsv(text, websites, existingSlugs);
}

/**
 * Imports only when every row is valid (all-or-nothing), creating DRAFT items.
 * Imported content is never approved or published automatically.
 */
export async function importCsv(ctx: SessionContext, text: string) {
  assertCan(ctx, "content.create");
  const { websites, existingSlugs } = await context(ctx);
  const { rows, fatal } = parseContentCsv(text, websites, existingSlugs);
  if (fatal) throw new AppError("INVALID_INPUT", fatal);
  const bad = rows.filter((r) => r.errors.length);
  if (bad.length) throw new AppError("INVALID_INPUT", `${bad.length} row(s) have errors. Fix them and preview again.`);
  if (!rows.length) throw new AppError("INVALID_INPUT", "The file has no data rows.");
  const records = rows.map((r) => {
    const d = r.data!;
    const site = websites.find((w) => w.id === r.websiteId)!;
    return {
      organization_id: ctx.org.id, website_id: site.id, created_by: ctx.user.id,
      title: d.title, slug: d.slug, body: d.body, body_format: d.body_format, excerpt: d.excerpt, meta_title: d.meta_title,
      meta_description: d.meta_description, canonical_url: d.canonical_url, target_keyword: d.target_keyword,
      categories: d.categories, tags: d.tags,
      scheduled_at: d.scheduled_at ? zonedLocalToUtc(d.scheduled_at.replace(" ", "T"), site.timezone).toISOString() : null,
    };
  });
  const inserted = unwrap(await ctx.supabase.from("content_items").insert(records).select("id")) ?? [];
  await audit(ctx, "content.imported", "content_item", null, { count: inserted.length });
  return inserted.length;
}
