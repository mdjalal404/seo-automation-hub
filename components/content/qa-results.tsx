import { ToneBadge } from "@/components/common/status-badge";
import type { QaResultRow } from "@/lib/database/types";

type AiDetails = { aiPercent?: number; threshold?: number; method?: string; flagged?: string[]; note?: string };

/** Estimated AI-written share, shown alongside the other warnings. */
function AiShare({ details }: { details: AiDetails }) {
  if (typeof details.aiPercent !== "number") return null;
  const over = details.aiPercent >= (details.threshold ?? 40);
  return (
    <div className="mt-2 grid gap-1.5" data-testid="ai-share">
      <div className="flex items-center gap-2 text-xs">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted" role="meter" aria-label="Estimated AI-written share" aria-valuenow={details.aiPercent} aria-valuemin={0} aria-valuemax={100}>
          <div className={over ? "h-full bg-amber-500" : "h-full bg-emerald-500"} style={{ width: `${details.aiPercent}%` }} />
        </div>
        <span className="w-24 text-right font-medium tabular-nums">{details.aiPercent}% AI</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Limit {details.threshold ?? 40}% · {details.method === "sapling" ? "Sapling AI detector" : "built-in heuristic"} · an estimate, not proof of authorship.{details.note ? ` ${details.note}` : ""}
      </p>
      {details.flagged?.length ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Most AI-like passages</summary>
          <ul className="mt-1 grid gap-1">{details.flagged.map((f, i) => <li key={i} className="rounded bg-muted/60 px-2 py-1 italic">“{f}”</li>)}</ul>
        </details>
      ) : null}
    </div>
  );
}

const ORDER = { error: 0, warning: 1, info: 2 } as const;

export function QaResults({ results, emptyText }: { results: QaResultRow[]; emptyText: string }) {
  if (!results.length) return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  const failed = results.filter((r) => r.status === "fail").sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const passed = results.filter((r) => r.status === "pass");
  const skipped = results.filter((r) => r.status === "skipped");
  return (
    <div className="grid gap-3" data-testid="qa-results">
      <p className="text-xs text-muted-foreground">
        {failed.filter((r) => r.severity === "error").length} errors · {failed.filter((r) => r.severity === "warning").length} warnings · {passed.length} passed · {skipped.length} skipped
      </p>
      <ul className="grid gap-2">
        {failed.map((r) => (
          <li key={r.id} className="rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <ToneBadge tone={r.severity === "error" ? "danger" : r.severity === "warning" ? "warning" : "info"}>{r.severity === "error" ? "Error" : r.severity === "warning" ? "Warning" : "Info"}</ToneBadge>
              <span className="text-xs text-muted-foreground">{r.kind === "recommendation" ? "Configurable recommendation" : "Technical check"} · {r.check_name}</span>
            </div>
            <p className="mt-1.5">{r.message}</p>
            {r.check_name === "ai_content" ? <AiShare details={r.details as AiDetails} /> : null}
            {r.url ? <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{r.url}</p> : null}
            {r.remediation ? <p className="mt-1 text-xs text-muted-foreground">Fix: {r.remediation}</p> : null}
          </li>
        ))}
      </ul>
      {passed.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{passed.length} passed checks</summary>
          <ul className="mt-2 grid gap-1">{passed.map((r) => <li key={r.id} className="text-muted-foreground">✓ {r.message}</li>)}</ul>
        </details>
      ) : null}
      {skipped.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{skipped.length} skipped / informational</summary>
          <ul className="mt-2 grid gap-1">{skipped.map((r) => <li key={r.id} className="text-muted-foreground">– {r.message}</li>)}</ul>
        </details>
      ) : null}
    </div>
  );
}
