import type { SupabaseClient } from "@supabase/supabase-js";
import { databricksSql, type DatabricksCredentials } from "@/lib/analytics/providers";
import type { HttpClient } from "@/lib/security/safe-fetch";

/**
 * ETL: exports the modeled SEO tables for one website to Databricks Delta tables.
 * Idempotent per run: rows for the exported window are deleted and re-inserted, so a
 * retried export never duplicates data. All values travel as statement parameters
 * (never interpolated into SQL); identifiers are validated by validateDatabricks().
 */
type Column = { name: string; type: "STRING" | "INT" | "DOUBLE" | "DATE" };
type TableSpec = { table: string; columns: Column[]; dateColumn?: string };

export const TABLES: Record<"search" | "traffic" | "keywords" | "audits", TableSpec> = {
  search: { table: "seo_search_performance", dateColumn: "date", columns: [
    { name: "website_id", type: "STRING" }, { name: "date", type: "DATE" }, { name: "query", type: "STRING" }, { name: "page", type: "STRING" },
    { name: "clicks", type: "INT" }, { name: "impressions", type: "INT" }, { name: "ctr", type: "DOUBLE" }, { name: "position", type: "DOUBLE" },
  ] },
  traffic: { table: "seo_traffic_daily", dateColumn: "date", columns: [
    { name: "website_id", type: "STRING" }, { name: "source", type: "STRING" }, { name: "date", type: "DATE" }, { name: "page", type: "STRING" }, { name: "metrics_json", type: "STRING" },
  ] },
  keywords: { table: "seo_keywords_snapshot", columns: [
    { name: "website_id", type: "STRING" }, { name: "snapshot_date", type: "DATE" }, { name: "keyword", type: "STRING" }, { name: "search_volume", type: "INT" },
    { name: "intent", type: "STRING" }, { name: "position", type: "DOUBLE" }, { name: "ranking_url", type: "STRING" }, { name: "tracked", type: "STRING" },
  ] },
  audits: { table: "seo_audit_pages", columns: [
    { name: "website_id", type: "STRING" }, { name: "audit_date", type: "DATE" }, { name: "url", type: "STRING" }, { name: "status_code", type: "INT" },
    { name: "indexable", type: "STRING" }, { name: "word_count", type: "INT" }, { name: "inlinks", type: "INT" }, { name: "issues", type: "STRING" },
  ] },
};

const SQL_TYPE = { STRING: "STRING", INT: "BIGINT", DOUBLE: "DOUBLE", DATE: "DATE" } as const;
const ROWS_PER_STATEMENT = 100;

export function createTableSql(c: Pick<DatabricksCredentials, "catalog" | "schema">, spec: TableSpec) {
  return `CREATE TABLE IF NOT EXISTS ${c.catalog}.${c.schema}.${spec.table} (${spec.columns.map((col) => `${col.name} ${SQL_TYPE[col.type]}`).join(", ")}) USING DELTA`;
}

/** INSERT with one named parameter per cell (p<row>_<col>), typed. */
export function insertSql(c: Pick<DatabricksCredentials, "catalog" | "schema">, spec: TableSpec, rows: (string | number | null)[][]) {
  const values = rows.map((_, r) => `(${spec.columns.map((col, i) => `:p${r}_${i}`).join(", ")})`).join(", ");
  const parameters = rows.flatMap((row, r) => spec.columns.map((col, i) => ({ name: `p${r}_${i}`, value: row[i] == null ? null : String(row[i]), type: col.type })));
  return { statement: `INSERT INTO ${c.catalog}.${c.schema}.${spec.table} (${spec.columns.map((col) => col.name).join(", ")}) VALUES ${values}`, parameters };
}

/** Replaces this website's rows (optionally only where `column >= value` / `= value`) and inserts the new ones. */
async function load(http: HttpClient, c: DatabricksCredentials, spec: TableSpec, websiteId: string, rows: (string | number | null)[][], filter?: { column: string; op: ">=" | "="; value: string }) {
  await databricksSql(http, c, createTableSql(c, spec));
  await databricksSql(http, c, `DELETE FROM ${c.catalog}.${c.schema}.${spec.table} WHERE website_id = :website${filter ? ` AND ${filter.column} ${filter.op} :filter` : ""}`,
    [{ name: "website", value: websiteId, type: "STRING" }, ...(filter ? [{ name: "filter", value: filter.value, type: "DATE" as const }] : [])]);
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const { statement, parameters } = insertSql(c, spec, rows.slice(i, i + ROWS_PER_STATEMENT));
    await databricksSql(http, c, statement, parameters);
  }
  return rows.length;
}

async function read<T>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await p;
  if (error) throw error;
  return (data ?? []) as T[];
}

export async function exportToDatabricks(db: SupabaseClient, http: HttpClient, c: DatabricksCredentials, website: { id: string; organization_id: string }, days = 30, onProgress?: (s: string) => Promise<void>) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const counts: Record<string, number> = {};
  const scoped = (table: string, cols: string) => db.from(table).select(cols).eq("website_id", website.id).eq("organization_id", website.organization_id);

  await onProgress?.("Exporting Search Console rows");
  const search = await read<{ date: string; query: string; page: string; clicks: number; impressions: number; ctr: number; position: number }>(scoped("search_performance_daily", "date, query, page, clicks, impressions, ctr, position").gte("date", since).limit(500_000));
  counts.search = await load(http, c, TABLES.search, website.id, search.map((r) => [website.id, r.date, r.query, r.page, r.clicks, r.impressions, Number(r.ctr), Number(r.position)]), { column: "date", op: ">=", value: since });

  await onProgress?.("Exporting traffic rows");
  const traffic = await read<{ source: string; date: string; page: string; metrics: unknown }>(scoped("traffic_daily", "source, date, page, metrics").gte("date", since).limit(200_000));
  counts.traffic = await load(http, c, TABLES.traffic, website.id, traffic.map((r) => [website.id, r.source, r.date, r.page, JSON.stringify(r.metrics)]), { column: "date", op: ">=", value: since });

  await onProgress?.("Exporting keyword snapshot");
  const keywords = await read<{ keyword: string; search_volume: number | null; intent: string | null; position: number | null; ranking_url: string | null; tracked: boolean }>(scoped("keywords", "keyword, search_volume, intent, position, ranking_url, tracked").limit(20_000));
  counts.keywords = await load(http, c, TABLES.keywords, website.id, keywords.map((k) => [website.id, today, k.keyword, k.search_volume, k.intent, k.position == null ? null : Number(k.position), k.ranking_url, String(k.tracked)]), { column: "snapshot_date", op: "=", value: today });

  await onProgress?.("Exporting latest audit");
  const audit = (await read<{ id: string; created_at: string }>(scoped("site_audits", "id, created_at").order("created_at", { ascending: false }).limit(1)))[0];
  if (audit) {
    const pages = await read<{ url: string; status_code: number | null; indexable: boolean | null; word_count: number | null; inlinks: number; issues: string[] }>(db.from("site_audit_pages").select("url, status_code, indexable, word_count, inlinks, issues").eq("audit_id", audit.id).limit(5000));
    // The audit table holds the latest audit only.
    counts.audit_pages = await load(http, c, TABLES.audits, website.id, pages.map((p) => [website.id, audit.created_at.slice(0, 10), p.url, p.status_code, String(p.indexable), p.word_count, p.inlinks, p.issues.join(";")]));
  }
  return counts;
}
