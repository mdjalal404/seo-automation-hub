"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { addKeywordsAction, clusterKeywordsAction, startTaskAction, updateKeywordsAction, visibilityCheckAction } from "@/app/actions/seo";
import { NativeSelect } from "@/components/common/native-select";
import { ToneBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/actions/result";
import type { ClusterRow, KeywordRow } from "@/lib/services/seo";

const INTENT_TONE = { informational: "info", commercial: "progress", transactional: "success", navigational: "neutral", local: "warning" } as const;

export function KeywordsManager({ websiteId, keywords, clusters, canEdit, canRun }: { websiteId: string; keywords: KeywordRow[]; clusters: ClusterRow[]; canEdit: boolean; canRun: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [similarity, setSimilarity] = useState("0.5");
  const [filter, setFilter] = useState<string>("");
  const clusterName = useMemo(() => new Map(clusters.map((c) => [c.id, c.name])), [clusters]);
  const shown = keywords.filter((k) => !filter || (filter === "tracked" ? k.tracked : k.cluster_id === filter));

  const run = (fn: () => Promise<ActionResult<unknown>>, after?: () => void) =>
    start(async () => {
      const res = await fn();
      if (res.ok) {
        toast.success(res.message ?? "Done");
        after?.();
        router.refresh();
      } else toast.error(res.error);
    });
  const ids = [...selected];
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
      <div className="grid content-start gap-4">
        {canEdit ? (
          <section className="rounded-xl border bg-card p-4">
            <label htmlFor="kw-paste" className="text-sm font-medium">Add keywords</label>
            <p className="text-xs text-muted-foreground">One per line, optionally with volume: <code>keyword,1200</code>. Search Console queries are added automatically on each analytics sync.</p>
            <Textarea id="kw-paste" rows={4} className="mt-2" value={text} onChange={(e) => setText(e.target.value)} placeholder={"dental implants cost\nare dental implants worth it,880"} />
            <Button size="sm" className="mt-2" disabled={pending || !text.trim()} onClick={() => run(() => addKeywordsAction(websiteId, text), () => setText(""))}>Add keywords</Button>
          </section>
        ) : null}
        <section className="rounded-xl border bg-card">
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <h2 className="mr-auto text-sm font-semibold">Keywords ({keywords.length})</h2>
            <NativeSelect aria-label="Filter" className="w-44" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">All keywords</option><option value="tracked">Tracked only</option>
              {clusters.map((c) => <option key={c.id} value={c.id}>Cluster: {c.name}</option>)}
            </NativeSelect>
            {canEdit && ids.length ? (
              <>
                <Button size="xs" variant="outline" disabled={pending} onClick={() => run(() => updateKeywordsAction(websiteId, ids, { tracked: true }))}>Track</Button>
                <Button size="xs" variant="outline" disabled={pending} onClick={() => run(() => updateKeywordsAction(websiteId, ids, { tracked: false }))}>Untrack</Button>
                {canRun ? <Button size="xs" variant="outline" disabled={pending || ids.length > 25} onClick={() => run(() => visibilityCheckAction(websiteId, keywords.filter((k) => selected.has(k.id)).map((k) => k.keyword)))}>Check AI visibility</Button> : null}
                <Button size="xs" variant="ghost" className="text-destructive" disabled={pending} onClick={() => run(() => updateKeywordsAction(websiteId, ids, { delete: true }), () => setSelected(new Set()))}>Delete</Button>
              </>
            ) : null}
          </div>
          {shown.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="w-8 px-4 py-2">{canEdit ? <Checkbox aria-label="Select all" checked={shown.length > 0 && shown.every((k) => selected.has(k.id))} onCheckedChange={(v) => setSelected(v ? new Set(shown.map((k) => k.id)) : new Set())} /> : null}</th>
                    <th className="py-2 pr-3">Keyword</th><th className="py-2 pr-3">Intent</th><th className="py-2 pr-3 text-right">Volume</th>
                    <th className="py-2 pr-3 text-right">Position</th><th className="py-2 pr-3">Cluster</th><th className="py-2 pr-4">Source</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {shown.map((k) => (
                    <tr key={k.id} data-testid="keyword-row">
                      <td className="px-4 py-2">{canEdit ? <Checkbox aria-label={`Select ${k.keyword}`} checked={selected.has(k.id)} onCheckedChange={() => toggle(k.id)} /> : null}</td>
                      <td className="py-2 pr-3"><span className="font-medium">{k.keyword}</span>{k.tracked ? <ToneBadge tone="info" className="ml-2">tracked</ToneBadge> : null}
                        {k.metrics?.ai_overview_cited ? <ToneBadge tone="success" className="ml-1">in AI Overview</ToneBadge> : k.metrics?.ai_overview ? <ToneBadge tone="neutral" className="ml-1">AI Overview shown</ToneBadge> : null}
                        {k.ranking_url ? <div className="max-w-md truncate text-xs text-muted-foreground">{k.ranking_url}</div> : null}</td>
                      <td className="py-2 pr-3">{k.intent ? <ToneBadge tone={INTENT_TONE[k.intent as keyof typeof INTENT_TONE] ?? "neutral"}>{k.intent}</ToneBadge> : "—"}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{k.search_volume?.toLocaleString("en-US") ?? "—"}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{k.position ?? "—"}</td>
                      <td className="py-2 pr-3 text-muted-foreground">{k.cluster_id ? clusterName.get(k.cluster_id) : "—"}</td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">{k.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="px-4 py-6 text-sm text-muted-foreground">No keywords yet. Paste a list above or connect Search Console.</p>}
        </section>
      </div>
      <aside className="grid content-start gap-4">
        <section className="rounded-xl border bg-card p-4 text-sm">
          <h2 className="font-semibold">Clustering</h2>
          <p className="mt-1 text-xs text-muted-foreground">Groups keywords that can be served by one page. Uses shared Google top-10 results when rank checks have run (most accurate), otherwise word similarity.</p>
          {canEdit ? (
            <div className="mt-3 flex items-center gap-2">
              <NativeSelect aria-label="Similarity" value={similarity} onChange={(e) => setSimilarity(e.target.value)} className="w-36">
                <option value="0.35">Broad groups</option><option value="0.5">Balanced</option><option value="0.7">Tight groups</option>
              </NativeSelect>
              <Button size="sm" disabled={pending || keywords.length < 2} onClick={() => run(() => clusterKeywordsAction(websiteId, Number(similarity)))}>Cluster keywords</Button>
            </div>
          ) : null}
          {canRun ? (
            <div className="mt-4 border-t pt-3">
              <p className="text-xs text-muted-foreground">Rank tracking checks tracked keywords’ Google positions, top results and AI Overview citations via DataForSEO.</p>
              <Button size="sm" variant="outline" className="mt-2" disabled={pending} onClick={() => run(() => startTaskAction(websiteId, "RANK_CHECK"))}>Check rankings now</Button>
            </div>
          ) : null}
        </section>
        <section className="rounded-xl border bg-card">
          <h2 className="border-b px-4 py-3 text-sm font-semibold">Clusters ({clusters.length})</h2>
          {clusters.length ? (
            <ul className="divide-y text-sm" data-testid="cluster-list">
              {clusters.map((c) => (
                <li key={c.id} className="px-4 py-2.5">
                  <div className="flex items-center gap-2"><span className="font-medium">{c.name}</span><ToneBadge tone={INTENT_TONE[c.intent as keyof typeof INTENT_TONE] ?? "neutral"}>{c.intent}</ToneBadge></div>
                  <p className="text-xs text-muted-foreground">{c.keyword_count} keywords · {c.total_volume.toLocaleString("en-US")} searches/mo</p>
                  <div className="mt-1 flex gap-3 text-xs">
                    {c.content_item_id ? <Link className="underline" href={`/content/${c.content_item_id}`}>Mapped article</Link> : <Link className="underline" href={`/ai-studio?website=${websiteId}&cluster=${c.id}`}>Write article with AI</Link>}
                    {c.target_url ? <a className="truncate text-muted-foreground underline" href={c.target_url} target="_blank" rel="noopener noreferrer">Ranking page</a> : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : <p className="px-4 py-6 text-sm text-muted-foreground">Run clustering to group keywords into topics.</p>}
        </section>
      </aside>
    </div>
  );
}
