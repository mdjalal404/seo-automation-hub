"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { saveRulesAction } from "@/app/actions/settings";
import { NativeSelect } from "@/components/common/native-select";
import { ToneBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { ResolvedRules } from "@/lib/seo/rules";

type CheckMeta = { name: string; label: string; kind: "technical" | "recommendation" };
const NUMERIC: Record<string, { key: string; label: string }[]> = {
  title_length: [{ key: "min", label: "Min chars" }, { key: "max", label: "Max chars" }],
  meta_description_length: [{ key: "min", label: "Min chars" }, { key: "max", label: "Max chars" }],
  content_length: [{ key: "minWords", label: "Min words" }],
  heading_structure: [{ key: "minH2", label: "Min H2" }],
  internal_links: [{ key: "maxLinks", label: "Max links checked" }],
  ai_content: [{ key: "maxAiPercent", label: "Warn at AI %" }],
  ai_visibility: [{ key: "minScore", label: "Warn below score" }],
};

export function RulesForm({ websiteId, initial, checks, readOnly, overrideEnabled }: {
  websiteId: string | null; initial: ResolvedRules; checks: CheckMeta[]; readOnly: boolean; overrideEnabled: boolean;
}) {
  const router = useRouter();
  const [rules, setRules] = useState<ResolvedRules>(initial);
  const [enabled, setEnabled] = useState(overrideEnabled);
  const [pending, start] = useTransition();

  const setCheck = (name: string, patch: Record<string, unknown>) =>
    setRules((r) => ({ ...r, checks: { ...r.checks, [name]: { ...r.checks[name], ...patch } } }));

  const save = () =>
    start(async () => {
      const res = await saveRulesAction(websiteId, rules, enabled);
      if (res.ok) toast.success(res.message ?? "Saved");
      else toast.error(res.error);
      router.refresh();
    });

  return (
    <div className="grid gap-5">
      {websiteId ? (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={enabled} disabled={readOnly} onCheckedChange={(v) => setEnabled(!!v)} />
          Use these website-specific rules (otherwise workspace defaults apply)
        </label>
      ) : null}
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b text-left text-xs text-muted-foreground">
            <tr><th className="px-4 py-2 font-medium">Check</th><th className="font-medium">Enabled</th><th className="font-medium">Severity</th><th className="px-4 font-medium">Settings</th></tr>
          </thead>
          <tbody>
            {checks.map((c) => {
              const rule = rules.checks[c.name];
              return (
                <tr key={c.name} className="border-b last:border-0">
                  <td className="px-4 py-2.5">
                    <p className="font-medium">{c.label}</p>
                    <ToneBadge tone={c.kind === "technical" ? "info" : "neutral"}>{c.kind === "technical" ? "Technical check" : "Recommendation"}</ToneBadge>
                  </td>
                  <td><Checkbox aria-label={`Enable ${c.label}`} checked={rule.enabled} disabled={readOnly} onCheckedChange={(v) => setCheck(c.name, { enabled: !!v })} /></td>
                  <td>
                    <NativeSelect aria-label={`${c.label} severity`} className="w-36" value={rule.severity} disabled={readOnly} onChange={(e) => setCheck(c.name, { severity: e.target.value })}>
                      <option value="error">Error (blocks)</option><option value="warning">Warning</option><option value="info">Info</option>
                    </NativeSelect>
                  </td>
                  <td className="px-4">
                    <div className="flex flex-wrap items-center gap-2">
                      {(NUMERIC[c.name] ?? []).map((f) => (
                        <label key={f.key} className="flex items-center gap-1 text-xs text-muted-foreground">{f.label}
                          <Input type="number" min={0} className="h-7 w-20" disabled={readOnly} value={Number(rule[f.key] ?? 0)} onChange={(e) => setCheck(c.name, { [f.key]: Number(e.target.value) })} />
                        </label>
                      ))}
                      {c.name === "h1_policy" ? (
                        <NativeSelect aria-label="H1 policy" className="w-72" disabled={readOnly} value={String(rule.policy)} onChange={(e) => setCheck(c.name, { policy: e.target.value })}>
                          <option value="none_in_body">No H1 in body (theme adds title)</option>
                          <option value="exactly_one">Exactly one H1 in body</option>
                          <option value="any">Don&apos;t check count</option>
                        </NativeSelect>
                      ) : null}
                      {c.name === "heading_structure" ? (
                        <label className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Checkbox checked={!!rule.noSkippedLevels} disabled={readOnly} onCheckedChange={(v) => setCheck(c.name, { noSkippedLevels: !!v })} /> No skipped levels
                        </label>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="rounded-xl border bg-card p-4">
        <p className="mb-3 text-sm font-semibold">Publishing behaviour</p>
        <div className="grid gap-2 text-sm">
          <label className="flex items-center gap-2"><Checkbox checked={rules.publishing.blockOnWarnings} disabled={readOnly} onCheckedChange={(v) => setRules((r) => ({ ...r, publishing: { ...r.publishing, blockOnWarnings: !!v } }))} /> Block approval when warnings are present (errors always block)</label>
          <label className="flex items-center gap-2"><Checkbox checked={rules.publishing.verifyAfterPublish} disabled={readOnly} onCheckedChange={(v) => setRules((r) => ({ ...r, publishing: { ...r.publishing, verifyAfterPublish: !!v } }))} /> Verify the live page after publishing (recommended)</label>
          <p className="text-xs text-muted-foreground">Publishing always requires a passing validation and explicit approval. Imported or edited content is never published automatically.</p>
        </div>
      </div>
      {!readOnly ? <div><Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save rules"}</Button></div> : <p className="text-sm text-muted-foreground">Only owners and admins can change rules.</p>}
    </div>
  );
}
