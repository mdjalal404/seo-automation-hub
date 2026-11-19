"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { submitIndexNowAction, updateAlertAction } from "@/app/actions/seo";
import { ToneBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { AlertRow } from "@/lib/services/monitoring";

const TONE = { critical: "danger", warning: "warning", info: "info" } as const;
const SOURCE = { audit: "Audit vs previous audit", traffic: "Search Console", gate: "Deploy gate" } as const;

/** Evidence line with any URLs turned into links. */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s,()]+)/g);
  return <>{parts.map((p, i) => (/^https?:\/\//.test(p) ? <a key={i} className="underline" href={p} target="_blank" rel="noopener noreferrer">{p}</a> : p))}</>;
}

/** `when` is formatted on the server so the relative time cannot differ between server and client render. */
export type AlertView = AlertRow & { when: string };

export function AlertList({ alerts, canUpdate, resolved }: { alerts: AlertView[]; canUpdate: boolean; resolved?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const act = (id: string, action: "acknowledge" | "resolve" | "reopen") => start(async () => {
    const r = await updateAlertAction(id, action);
    if (r.ok) { toast.success(r.message ?? "Saved"); router.refresh(); } else toast.error(r.error);
  });
  if (!alerts.length) return <p className="px-4 py-6 text-sm text-muted-foreground">{resolved ? "Nothing resolved yet." : "No open alerts. Monitoring checks every audit and every Search Console sync."}</p>;
  return (
    <ul className="divide-y text-sm" data-testid={resolved ? "resolved-alerts" : "alerts"}>
      {alerts.map((a) => (
        <li key={a.id} className="grid gap-1.5 px-4 py-3" data-testid="alert">
          <div className="flex flex-wrap items-center gap-2">
            <ToneBadge tone={resolved ? "neutral" : TONE[a.severity]}>{a.severity}</ToneBadge>
            <span className="font-medium">{a.title}</span>
            {a.status === "acknowledged" ? <ToneBadge tone="neutral">acknowledged</ToneBadge> : null}
            {a.occurrences > 1 ? <span className="text-xs text-muted-foreground">seen {a.occurrences}×</span> : null}
            <span className="ml-auto text-xs text-muted-foreground">{SOURCE[a.source as keyof typeof SOURCE] ?? a.source} · {a.when}</span>
          </div>
          {a.url ? <a className="w-fit max-w-full truncate text-xs underline" href={a.url} target="_blank" rel="noopener noreferrer">{a.url}</a> : null}
          <ul className="grid gap-0.5 border-l pl-2 text-xs text-muted-foreground" data-testid="alert-evidence">
            {a.evidence.map((e) => <li key={e} className="break-words"><Linkified text={e} /></li>)}
          </ul>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {resolved ? <span>{a.resolved_reason}</span> : null}
            {Object.entries(a.notified ?? {}).filter(([k]) => k !== "at").map(([k, v]) => <span key={k} className={v.startsWith("failed") ? "text-destructive" : ""}>{k}: {v}</span>)}
            {canUpdate && !resolved ? (
              <span className="ml-auto flex gap-1">
                {a.status === "open" ? <Button size="xs" variant="outline" disabled={pending} onClick={() => act(a.id, "acknowledge")}>Acknowledge</Button> : null}
                <Button size="xs" variant="outline" disabled={pending} onClick={() => act(a.id, "resolve")}>Resolve</Button>
              </span>
            ) : null}
            {canUpdate && resolved ? <Button className="ml-auto" size="xs" variant="ghost" disabled={pending} onClick={() => act(a.id, "reopen")}>Reopen</Button> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function IndexNowForm({ websiteId, disabled }: { websiteId: string; disabled: boolean }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  return (
    <div className="grid gap-2">
      <label htmlFor="indexnow-urls" className="text-sm font-medium">Submit URLs now</label>
      <Textarea id="indexnow-urls" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="One URL per line" disabled={disabled} className="font-mono text-xs field-sizing-fixed" />
      <div>
        <Button size="sm" disabled={disabled || pending || !text.trim()} onClick={() => start(async () => {
          const r = await submitIndexNowAction(websiteId, text);
          if (r.ok) { toast.success(r.message ?? "Queued"); setText(""); router.refresh(); } else toast.error(r.error);
        })}>{pending ? "Queuing…" : "Submit to IndexNow"}</Button>
      </div>
    </div>
  );
}
