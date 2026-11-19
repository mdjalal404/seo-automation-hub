"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { decideProposalAction, startAgentAction } from "@/app/actions/seo";
import { ToneBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ProposalRow } from "@/lib/services/automation";

export function StartAgentForm({ websiteId, goals, disabled }: { websiteId: string; goals: string[]; disabled: boolean }) {
  const router = useRouter();
  const [goal, setGoal] = useState(goals[0]);
  const [pending, start] = useTransition();
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        {goals.map((g) => <Button key={g} size="xs" variant={g === goal ? "default" : "outline"} onClick={() => setGoal(g)}>{g.split(" ").slice(0, 5).join(" ")}…</Button>)}
      </div>
      <label htmlFor="agent-goal" className="text-sm font-medium">Goal</label>
      <Textarea id="agent-goal" rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} />
      <div>
        <Button disabled={disabled || pending || goal.trim().length < 5} onClick={() => start(async () => {
          const r = await startAgentAction(websiteId, goal);
          if (r.ok) { toast.success(r.message ?? "Queued"); router.refresh(); } else toast.error(r.error);
        })}>{pending ? "Queuing…" : "Run agent"}</Button>
      </div>
    </div>
  );
}

const PRIORITY = { high: "danger", medium: "warning", low: "neutral" } as const;
const STATUS = { proposed: "info", approved: "progress", rejected: "neutral", done: "success" } as const;

export function ProposalList({ proposals, canDecide }: { proposals: ProposalRow[]; canDecide: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const decide = (id: string, d: "approve" | "reject" | "done") => start(async () => {
    const r = await decideProposalAction(id, d);
    if (r.ok) { toast.success(r.message ?? "Saved"); router.refresh(); } else toast.error(r.error);
  });
  if (!proposals.length) return <p className="px-4 py-6 text-sm text-muted-foreground">No proposals.</p>;
  return (
    <ul className="divide-y text-sm" data-testid="proposals">
      {proposals.map((p) => (
        <li key={p.id} className="grid gap-1.5 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <ToneBadge tone={PRIORITY[p.priority as keyof typeof PRIORITY] ?? "neutral"}>{p.priority}</ToneBadge>
            <ToneBadge tone="neutral">{p.kind.replace(/_/g, " ")}</ToneBadge>
            <span className="font-medium">{p.title}</span>
            <ToneBadge tone={STATUS[p.status as keyof typeof STATUS] ?? "neutral"} className="ml-auto">{p.status}</ToneBadge>
          </div>
          {p.target_url ? <a className="truncate text-xs text-muted-foreground underline" href={p.target_url} target="_blank" rel="noopener noreferrer">{p.target_url}</a> : null}
          <p className="text-muted-foreground">{p.rationale}</p>
          {p.evidence.length ? <ul className="list-disc pl-5 text-xs text-muted-foreground">{p.evidence.map((e, i) => <li key={i} className="break-words">{e}</li>)}</ul> : null}
          {Object.keys(p.payload).length ? <p className="text-xs text-muted-foreground">{Object.entries(p.payload).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(" · ")}</p> : null}
          {canDecide && p.status === "proposed" ? (
            <div className="flex gap-2">
              <Button size="xs" disabled={pending} onClick={() => decide(p.id, "approve")}>Approve</Button>
              <Button size="xs" variant="ghost" disabled={pending} onClick={() => decide(p.id, "reject")}>Reject</Button>
            </div>
          ) : canDecide && p.status === "approved" ? <div><Button size="xs" variant="outline" disabled={pending} onClick={() => decide(p.id, "done")}>Mark done</Button></div> : null}
        </li>
      ))}
    </ul>
  );
}
