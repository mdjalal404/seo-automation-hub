import Link from "next/link";
import { cancelTaskAction } from "@/app/actions/seo";
import { ActionButton } from "@/components/common/action-button";
import { ToneBadge } from "@/components/common/status-badge";
import { formatRelative } from "@/lib/format";
import type { TaskListItem } from "@/lib/services/seo";

const LABEL: Record<string, string> = {
  SITE_AUDIT: "Site audit", ANALYTICS_SYNC: "Analytics sync", RANK_CHECK: "Rank check", AI_VISIBILITY_CHECK: "AI visibility check", GENERATE_CONTENT: "AI article",
  AGENT_RUN: "SEO agent run", CONTENT_QA: "Content QA", WAREHOUSE_EXPORT: "Databricks export", INDEXNOW_SUBMIT: "IndexNow submission", SEO_GATE: "SEO deploy gate",
};
const TONE = { QUEUED: "neutral", RUNNING: "progress", COMPLETED: "success", FAILED: "danger", CANCELLED: "neutral" } as const;

function outcome(t: TaskListItem) {
  const r = t.result;
  if (t.status === "FAILED") return t.error_message;
  if (t.status === "RUNNING") return t.progress;
  if (t.status === "QUEUED" && t.error_message) return `Retrying: ${t.error_message}`;
  if (t.status !== "COMPLETED") return null;
  if (t.task_type === "SITE_AUDIT" && r.auditId) {
    const m = r.monitoring as { comparedWith?: string | null; regressions?: number; changes?: number; created?: number } | undefined;
    return <><Link className="underline" href={`/audits/${r.auditId}`}>Score {String(r.score)} · {String(r.pages)} pages{r.partial ? " (partial)" : ""}</Link>{m?.comparedWith ? <> · <Link className="underline" href={`/monitoring?website=${t.website_id}`}>{m.regressions} regression{m.regressions === 1 ? "" : "s"}, {m.changes} change{m.changes === 1 ? "" : "s"} vs previous audit</Link></> : null}</>;
  }
  if (t.task_type === "INDEXNOW_SUBMIT") return `${r.submitted} URL${r.submitted === 1 ? "" : "s"} submitted to IndexNow (HTTP ${r.status})${r.reason ? ` · ${r.reason}` : ""}`;
  if (t.task_type === "SEO_GATE") return <span className={r.passed ? "" : "text-destructive"}>{r.passed ? "Passed" : "Failed"}: {String(r.checked)} pages on {String(r.target)}, {String(r.errors)} errors, {String(r.warnings)} warnings{r.source === "api" ? " · from CI" : ""}</span>;
  if (t.task_type === "GENERATE_CONTENT" && r.contentId) return <Link className="underline" href={`/content/${r.contentId}`}>Open draft{r.provider === "mock" ? " (mock output)" : ""}</Link>;
  if (t.task_type === "RANK_CHECK") return `${r.ranked}/${r.checked} ranking · ${r.aiOverviewCitations} AI Overview citations`;
  if (t.task_type === "AI_VISIBILITY_CHECK") return `Cited in ${r.cited}/${r.queries} answers${r.provider === "mock" ? " (mock)" : ""}`;
  if (t.task_type === "AGENT_RUN" && r.runId) return <Link className="underline" href={`/agent/${r.runId}`}>{String(r.proposals)} proposals from {String(r.steps)} tool calls{r.provider === "mock" ? " (mock)" : ""}</Link>;
  if (t.task_type === "CONTENT_QA") return `${r.reviewed} reviewed: ${r.pass} pass, ${r.needs_revision} need revision, ${r.fail} fail${r.skipped ? `, ${r.skipped} unchanged` : ""}${r.provider === "mock" ? " (mock)" : ""}`;
  if (t.task_type === "WAREHOUSE_EXPORT") return `Exported to ${r.target}: ${["search", "traffic", "keywords", "audit_pages"].filter((k) => k in r).map((k) => `${r[k]} ${k.replace("_", " ")}`).join(", ")}`;
  if (t.task_type === "ANALYTICS_SYNC") return Object.entries(r).map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "object" && v && "error" in v ? `error — ${(v as { error: string }).error}` : Object.entries(v as object).map(([a, b]) => `${b} ${a}`).join(", ")}`).join(" · ");
  return null;
}

export function TaskList({ tasks, canCancel }: { tasks: TaskListItem[]; canCancel: boolean }) {
  if (!tasks.length) return <p className="px-4 py-6 text-sm text-muted-foreground">No tasks yet.</p>;
  return (
    <ul className="divide-y text-sm" data-testid="task-list">
      {tasks.map((t) => (
        <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
          <ToneBadge tone={TONE[t.status as keyof typeof TONE] ?? "neutral"}>{t.status.toLowerCase()}</ToneBadge>
          <span className="font-medium">{LABEL[t.task_type] ?? t.task_type}</span>
          {t.schedule_id ? <span className="text-xs text-muted-foreground">scheduled</span> : null}
          <span className="min-w-[12rem] flex-1 break-words text-muted-foreground">{outcome(t)}</span>
          <span className="text-xs text-muted-foreground">{formatRelative(t.created_at)}</span>
          {canCancel && t.status === "QUEUED" ? <ActionButton size="xs" variant="ghost" action={cancelTaskAction.bind(null, t.id)}>Cancel</ActionButton> : null}
        </li>
      ))}
    </ul>
  );
}
