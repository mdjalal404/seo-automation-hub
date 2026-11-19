import type { SupabaseClient } from "@supabase/supabase-js";
import { openSecret } from "@/lib/analytics/credentials";
import type { PerfRow } from "@/lib/analytics/insights";
import type { AuditResult } from "@/lib/audit/crawler";
import { AppError } from "@/lib/errors";
import { submitIndexNow } from "@/lib/indexing/indexnow";
import { recordFindings } from "@/lib/monitoring/alerts";
import { detectTrafficAnomalies } from "@/lib/monitoring/anomalies";
import { diffAudits, stillPresent, type Finding, type Snapshot, type SnapshotPage } from "@/lib/monitoring/diff";
import { knownGoodBaseline, runGate, type GateParams } from "@/lib/monitoring/gate";
import type { TaskDeps, TaskRow } from "@/lib/tasks/runner";

/** Monitoring, IndexNow and deploy-gate task handlers (wired into lib/tasks/runner.ts). */
type Website = { id: string; organization_id: string; name: string; base_url: string };

const PAGE_COLS = "url, status_code, title, meta_description, canonical, indexable, word_count, inlinks, issues, details";

export async function loadSnapshot(db: SupabaseClient, websiteId: string, opts: { auditId?: string; before?: string } = {}): Promise<Snapshot | null> {
  let q = db.from("site_audits").select("id, created_at, score, site_checks").eq("website_id", websiteId).order("created_at", { ascending: false }).limit(1);
  if (opts.auditId) q = q.eq("id", opts.auditId);
  if (opts.before) q = q.lt("created_at", opts.before);
  const { data, error } = await q;
  if (error) throw error;
  const a = data?.[0] as { id: string; created_at: string; score: number | null; site_checks: Snapshot["site"] & { partial?: boolean } } | undefined;
  if (!a) return null;
  const { data: pages, error: pErr } = await db.from("site_audit_pages").select(PAGE_COLS).eq("audit_id", a.id).limit(5000);
  if (pErr) throw pErr;
  return { id: a.id, created_at: a.created_at, score: a.score, site: a.site_checks, pages: (pages ?? []) as SnapshotPage[] };
}

/** The website's most recent audits, newest first. */
export async function loadSnapshots(db: SupabaseClient, websiteId: string, n: number): Promise<Snapshot[]> {
  const { data, error } = await db.from("site_audits").select("id").eq("website_id", websiteId).order("created_at", { ascending: false }).limit(n);
  if (error) throw error;
  const out: Snapshot[] = [];
  for (const a of data ?? []) {
    const s = await loadSnapshot(db, websiteId, { auditId: a.id as string });
    if (s) out.push(s);
  }
  return out;
}

export function snapshotFromAudit(id: string, audit: AuditResult): Snapshot {
  return {
    id, created_at: new Date().toISOString(), score: audit.score, site: audit.site,
    pages: audit.pages.map((p) => ({ url: p.url, status_code: p.statusCode, title: p.title, meta_description: p.metaDescription, canonical: p.canonical, indexable: p.indexable, word_count: p.wordCount, inlinks: p.inlinks, issues: [...new Set(p.issues)], details: p.details })),
  };
}

async function indexNowFor(db: SupabaseClient, w: Website) {
  const { data } = await db.from("integrations").select("encrypted_credentials, metadata").eq("website_id", w.id).eq("organization_id", w.organization_id).eq("provider", "indexnow").maybeSingle();
  if (!data) return null;
  return { key: openSecret(data.encrypted_credentials as string, w.organization_id, w.id, "indexnow").key, autoSubmit: (data.metadata as Record<string, unknown>).auto_submit !== false };
}

/** Queues an IndexNow submission when the website has IndexNow connected with auto-submit on. */
export async function queueIndexNow(db: SupabaseClient, w: { id: string; organization_id: string }, urls: string[], reason: string, idempotencyKey: string) {
  if (!urls.length) return null;
  const { data: integ } = await db.from("integrations").select("metadata").eq("website_id", w.id).eq("organization_id", w.organization_id).eq("provider", "indexnow").maybeSingle();
  if (!integ || (integ.metadata as Record<string, unknown>).auto_submit === false) return null;
  const { data, error } = await db.from("automation_tasks").insert({
    organization_id: w.organization_id, website_id: w.id, task_type: "INDEXNOW_SUBMIT", params: { urls: urls.slice(0, 10_000), reason },
    idempotency_key: idempotencyKey.slice(0, 300), max_attempts: 3,
  }).select("id").single();
  if (error) {
    if ((error as { code?: string }).code === "23505") return null; // already queued for this event
    throw error;
  }
  return data.id as string;
}

/** After an audit: regressions vs the previous audit → alerts; changed pages → IndexNow. */
export async function monitorAudit(deps: TaskDeps, w: Website, auditId: string, audit: AuditResult) {
  const curr = snapshotFromAudit(auditId, audit);
  const prev = await loadSnapshot(deps.db, w.id, { before: (await deps.db.from("site_audits").select("created_at").eq("id", auditId).single()).data?.created_at as string });
  const findings: Finding[] = prev ? diffAudits(prev, curr) : [];
  const res = await recordFindings(deps.db, deps.http, w, "audit", findings, {
    // Partial crawls cannot prove a page is fixed; only resolve against complete audits.
    stillPresent: (a) => (audit.partial ? null : stillPresent(a.kind, a.url, curr)),
  });
  const changed = findings.filter((f) => f.url && ["title_changed", "description_changed", "canonical_changed", "content_shrunk", "structured_data_removed", "noindex_added", "page_broken"].includes(f.kind)).map((f) => f.url!);
  const indexNowTask = await queueIndexNow(deps.db, w, [...new Set(changed)], "Changed since the previous audit", `audit:${auditId}`);
  return { comparedWith: prev?.id ?? null, regressions: findings.filter((f) => f.severity !== "info").length, changes: findings.filter((f) => f.severity === "info").length, ...res, indexNowTask };
}

/** After a Search Console sync: traffic / ranking anomalies → alerts (auto-resolve when they clear). */
export async function monitorTraffic(deps: TaskDeps, w: Website) {
  const since = new Date(Date.now() - 50 * 86_400_000).toISOString().slice(0, 10);
  const rows: PerfRow[] = [];
  for (let from = 0; from < 200_000; from += 1000) {
    const { data, error } = await deps.db.from("search_performance_daily").select("date, query, page, clicks, impressions, position").eq("website_id", w.id).gte("date", since).order("date").range(from, from + 999);
    if (error) throw error;
    rows.push(...((data ?? []) as PerfRow[]));
    if (!data || data.length < 1000) break;
  }
  const findings = detectTrafficAnomalies(rows);
  const res = await recordFindings(deps.db, deps.http, w, "traffic", findings, { stillPresent: () => false });
  return { anomalies: findings.length, ...res };
}

export async function runIndexNowTask(deps: TaskDeps, task: TaskRow, w: Website) {
  const integ = await indexNowFor(deps.db, w);
  if (!integ) throw new AppError("CONFIG_MISSING", "IndexNow is not connected for this website.");
  const urls = Array.isArray(task.params.urls) ? (task.params.urls as unknown[]).filter((u): u is string => typeof u === "string") : [];
  const r = await submitIndexNow(deps.http, w.base_url, integ.key, urls);
  return { ...r, requested: urls.length, reason: task.params.reason ?? null };
}

export async function runGateTask(deps: TaskDeps, task: TaskRow, w: Website) {
  const params = task.params as GateParams & { source?: string };
  const baseline = knownGoodBaseline(await loadSnapshots(deps.db, w.id, 5));
  const result = await runGate(deps.http, w.base_url, baseline, params, async (n, total) => {
    await deps.db.from("automation_tasks").update({ progress: `Checked ${n}/${total} pages`, lease_expires_at: new Date(Date.now() + 600_000).toISOString() }).eq("id", task.id).eq("locked_by", deps.workerId);
  });
  const failing = result.checks.filter((c) => c.severity === "error" || (result.failOn === "warning" && c.severity === "warning"));
  const findings: Finding[] = result.passed ? [] : [{
    kind: "deploy_gate_failed", severity: "critical", title: `SEO deploy gate failed on ${result.target} (${result.errors} errors, ${result.warnings} warnings)`, url: result.target,
    fingerprint: `gate:deploy_gate_failed:${result.target}`, evidence: failing.slice(0, 15).map((c) => `${c.path}: ${c.message}${c.after ? ` (now: ${c.after})` : ""}`),
  }];
  const alerts = await recordFindings(deps.db, deps.http, w, "gate", findings, { stillPresent: (a) => (a.url === result.target ? !result.passed : null) });
  return { ...result, alerts: alerts.created + alerts.updated, source: params.source ?? "app" };
}
