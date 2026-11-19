import Papa from "papaparse";
import { z } from "zod";
import { slugify } from "@/lib/validation/schemas";

/**
 * Feed-driven page templates. Placeholders: {{column}}, filters {{column|lower}},
 * {{column|upper}}, {{column|title}}, {{column|slug}}, and conditional blocks
 * {{#if column}}…{{/if}}. Every generated page is a normal DRAFT that must pass
 * validation and approval before it can be published.
 */
export const MAX_FEED_ROWS = 500;

export const templateSchema = z.object({
  websiteId: z.uuid(),
  name: z.string().trim().min(1, "Name the template.").max(200),
  titleTemplate: z.string().trim().min(1, "Enter a title template.").max(500),
  slugTemplate: z.string().trim().min(1, "Enter a slug template.").max(300),
  metaTitleTemplate: z.string().trim().max(300).default(""),
  metaDescriptionTemplate: z.string().trim().max(1000).default(""),
  excerptTemplate: z.string().trim().max(2000).default(""),
  keywordTemplate: z.string().trim().max(200).default(""),
  bodyTemplate: z.string().min(1, "Enter the body template.").max(200_000),
});
export type TemplateInput = z.infer<typeof templateSchema>;

export type FeedRow = Record<string, string>;
export type RenderedPage = {
  row: number; title: string; slug: string; metaTitle: string; metaDescription: string; excerpt: string; keyword: string; body: string;
  errors: string[]; warnings: string[]; uniqueness: number;
};

const FILTERS: Record<string, (v: string) => string> = {
  lower: (v) => v.toLowerCase(),
  upper: (v) => v.toUpperCase(),
  title: (v) => v.toLowerCase().replace(/\b\p{L}/gu, (m) => m.toUpperCase()),
  slug: (v) => slugify(v),
  trim: (v) => v.trim(),
};

export function placeholders(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(/\{\{\s*(?:#if\s+)?([\w.-]+)(?:\|[\w|]+)?\s*\}\}/g)) out.add(m[1]);
  return [...out];
}

export function renderTemplate(template: string, row: FeedRow, missing?: Set<string>): string {
  const withBlocks = template.replace(/\{\{\s*#if\s+([\w.-]+)\s*\}\}([\s\S]*?)\{\{\s*\/if\s*\}\}/g, (_m, key: string, inner: string) => (row[key]?.trim() ? inner : ""));
  return withBlocks.replace(/\{\{\s*([\w.-]+)((?:\|[\w]+)*)\s*\}\}/g, (_m, key: string, filters: string) => {
    if (!(key in row)) missing?.add(key);
    let v = row[key] ?? "";
    for (const f of filters.split("|").filter(Boolean)) v = FILTERS[f]?.(v) ?? v;
    return v;
  });
}

export function parseFeed(text: string): { rows: FeedRow[]; columns: string[]; error: string | null } {
  const trimmed = text.trim();
  if (!trimmed) return { rows: [], columns: [], error: "The feed is empty." };
  if (trimmed.startsWith("[")) {
    try {
      const data = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(data)) return { rows: [], columns: [], error: "JSON feeds must be an array of objects." };
      const rows = data.filter((r) => r && typeof r === "object" && !Array.isArray(r)).map((r) =>
        Object.fromEntries(Object.entries(r as Record<string, unknown>).map(([k, v]) => [k, v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)])));
      return limit(rows);
    } catch {
      return { rows: [], columns: [], error: "The JSON feed could not be parsed." };
    }
  }
  const parsed = Papa.parse<FeedRow>(trimmed, { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() });
  if (parsed.errors.length && !parsed.data.length) return { rows: [], columns: [], error: `CSV error: ${parsed.errors[0].message}` };
  return limit(parsed.data);
}

function limit(rows: FeedRow[]) {
  if (rows.length > MAX_FEED_ROWS) return { rows: [], columns: [], error: `The feed has ${rows.length} rows; the limit is ${MAX_FEED_ROWS} per run.` };
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return { rows, columns, error: null };
}

const words = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, " ").match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Share of a page's words that come from the feed rather than the fixed template text.
 * Pages where almost everything is boilerplate risk being treated as doorway/thin pages.
 */
function uniquenessOf(body: string, staticWords: Map<string, number>): number {
  const w = words(body);
  if (!w.length) return 0;
  const budget = new Map(staticWords);
  let unique = 0;
  for (const t of w) {
    const n = budget.get(t) ?? 0;
    if (n > 0) budget.set(t, n - 1);
    else unique++;
  }
  return Math.round((unique / w.length) * 100);
}

export function renderPages(t: Omit<TemplateInput, "websiteId" | "name">, rows: FeedRow[], existingSlugs: Set<string>): RenderedPage[] {
  const staticWords = new Map<string, number>();
  for (const w of words(t.bodyTemplate.replace(/\{\{[^}]+\}\}/g, " "))) staticWords.set(w, (staticWords.get(w) ?? 0) + 1);
  const seen = new Set<string>();
  return rows.map((row, i) => {
    const missing = new Set<string>();
    const r = (tpl: string) => renderTemplate(tpl, row, missing).trim();
    const page = {
      row: i + 1, title: r(t.titleTemplate), slug: slugify(r(t.slugTemplate)), metaTitle: r(t.metaTitleTemplate),
      metaDescription: r(t.metaDescriptionTemplate), excerpt: r(t.excerptTemplate), keyword: r(t.keywordTemplate).toLowerCase(), body: renderTemplate(t.bodyTemplate, row, missing),
      errors: [] as string[], warnings: [] as string[], uniqueness: 0,
    };
    if (missing.size) page.errors.push(`Missing column(s): ${[...missing].join(", ")}`);
    if (!page.title) page.errors.push("The title is empty for this row.");
    if (!page.slug) page.errors.push("The slug is empty for this row.");
    else if (seen.has(page.slug)) page.errors.push(`Duplicate slug "${page.slug}" in this feed.`);
    else if (existingSlugs.has(page.slug)) page.errors.push(`Slug "${page.slug}" already exists on this website.`);
    seen.add(page.slug);
    page.uniqueness = uniquenessOf(page.body, staticWords);
    if (page.uniqueness < 25) page.warnings.push(`Only ${page.uniqueness}% of the body is unique to this row — add more row-specific data to avoid thin/doorway pages.`);
    if (words(page.body).length < 150) page.warnings.push("The body is under 150 words.");
    return page;
  });
}
