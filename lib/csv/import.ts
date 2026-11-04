import Papa from "papaparse";
import { csvRowSchema, slugify, type CsvRow } from "@/lib/validation/schemas";

export const CSV_COLUMNS = [
  "website", "title", "slug", "body", "body_format", "excerpt", "meta_title", "meta_description",
  "canonical_url", "target_keyword", "categories", "tags", "scheduled_at",
] as const;
export const MAX_CSV_ROWS = 500;
export const MAX_CSV_BYTES = 2 * 1024 * 1024;

export type CsvWebsite = { id: string; name: string; base_url: string; timezone: string };
export type ParsedCsvRow = { line: number; data: CsvRow | null; websiteId: string | null; errors: string[]; warnings: string[] };

/**
 * Parses and validates a CSV upload without writing anything. Each row is checked
 * against the content schema, matched to a website (by name or base URL) and
 * checked for duplicate slugs within the file and against existing content.
 */
export function parseContentCsv(text: string, websites: CsvWebsite[], existingSlugs: Set<string>): { rows: ParsedCsvRow[]; fatal: string | null } {
  if (text.length > MAX_CSV_BYTES) return { rows: [], fatal: "The file is larger than 2 MB." };
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy", transformHeader: (h) => h.trim().toLowerCase() });
  const headers = parsed.meta.fields ?? [];
  const missing = ["website", "title"].filter((h) => !headers.includes(h));
  if (missing.length) return { rows: [], fatal: `Missing required column(s): ${missing.join(", ")}. Expected columns: ${CSV_COLUMNS.join(", ")}.` };
  const unknown = headers.filter((h) => !(CSV_COLUMNS as readonly string[]).includes(h));
  if (parsed.data.length > MAX_CSV_ROWS) return { rows: [], fatal: `Too many rows (${parsed.data.length}). The limit is ${MAX_CSV_ROWS} per import.` };

  const seen = new Map<string, number>();
  const rows = parsed.data.map((raw, i): ParsedCsvRow => {
    const line = i + 2; // header is line 1
    const errors: string[] = [];
    const warnings: string[] = i === 0 && unknown.length ? [`Ignored unknown column(s): ${unknown.join(", ")}`] : [];
    const result = csvRowSchema.safeParse(raw);
    if (!result.success) {
      return { line, data: null, websiteId: null, errors: result.error.issues.map((x) => `${x.path.join(".") || "row"}: ${x.message}`), warnings };
    }
    const data = { ...result.data, slug: result.data.slug || slugify(result.data.title) };
    const key = data.website.trim().toLowerCase().replace(/\/+$/, "");
    const site = websites.find((w) => w.name.toLowerCase() === key || w.base_url.toLowerCase() === key);
    if (!site) errors.push(`website: no website named or at "${data.website}" in this workspace.`);
    if (!data.slug) errors.push("slug: could not derive a slug from the title.");
    if (site && data.slug) {
      const k = `${site.id}:${data.slug}`;
      if (seen.has(k)) errors.push(`slug: duplicates row ${seen.get(k)} for the same website.`);
      else seen.set(k, line);
      if (existingSlugs.has(k)) errors.push(`slug: "${data.slug}" already exists on ${site.name}.`);
    }
    if (!data.body.trim()) warnings.push("body is empty; validation will fail until content is added.");
    return { line, data, websiteId: site?.id ?? null, errors, warnings };
  });
  return { rows, fatal: null };
}
