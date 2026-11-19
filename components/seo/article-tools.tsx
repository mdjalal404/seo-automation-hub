"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { applyInternalLinkAction, buildSchemaAction, visibilityCheckAction } from "@/app/actions/seo";
import { Field } from "@/components/common/field";
import { ToneBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { ReadinessReport } from "@/lib/seo/ai-visibility";
import type { LinkSuggestion } from "@/lib/seo/internal-links";
import { SCHEMA_TYPES, type SchemaType } from "@/lib/seo/schema-generator";

type Visibility = { id: string; query: string; engine: string; cited: boolean; mentioned: boolean; cited_urls: string[]; answer_excerpt: string | null; checked_at: string };

export function ReadinessCard({ report, visibility, websiteId, keyword, canCheck }: { report: ReadinessReport; visibility: Visibility[]; websiteId: string; keyword: string; canCheck: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const tone = report.score >= 75 ? "success" : report.score >= 50 ? "warning" : "danger";
  return (
    <section className="rounded-xl border bg-card p-4" data-testid="ai-readiness">
      <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">AI search readiness</h2><ToneBadge tone={tone}>{report.score}/100</ToneBadge></div>
      <p className="mt-1 text-xs text-muted-foreground">How easy this article is for AI answer engines (Google AI Overviews, ChatGPT, Perplexity, Claude) to quote and cite. Signals, not a ranking guarantee.</p>
      <ul className="mt-3 grid gap-1.5 text-sm">
        {report.signals.map((s) => (
          <li key={s.key} className="flex items-start gap-2">
            <span className={s.passed ? "text-emerald-600" : "text-amber-600"} aria-hidden>{s.passed ? "✓" : "○"}</span>
            <span><span className={s.passed ? "" : "font-medium"}>{s.label}</span>{s.detail ? <span className="text-xs text-muted-foreground"> — {s.detail}</span> : null}{!s.passed ? <span className="block text-xs text-muted-foreground">{s.tip}</span> : null}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 border-t pt-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">Cited by AI engines?</p>
          {canCheck && keyword ? (
            <Button size="xs" variant="outline" disabled={pending} onClick={() => start(async () => { const r = await visibilityCheckAction(websiteId, [keyword]); if (r.ok) { toast.success(r.message ?? "Queued"); router.refresh(); } else toast.error(r.error); })}>Check “{keyword.slice(0, 30)}”</Button>
          ) : null}
        </div>
        {visibility.length ? (
          <ul className="mt-2 grid gap-2 text-xs">
            {visibility.map((v) => (
              <li key={v.id}>
                <ToneBadge tone={v.cited ? "success" : "neutral"}>{v.cited ? "cited" : v.mentioned ? "mentioned" : "not cited"}</ToneBadge>{" "}
                <span className="text-muted-foreground">{v.engine === "claude_web_search" ? "Claude web search" : "Google AI Overview"} · {new Date(v.checked_at).toLocaleDateString()}</span>
                {v.answer_excerpt ? <p className="mt-1 line-clamp-3 text-muted-foreground">{v.answer_excerpt}</p> : null}
              </li>
            ))}
          </ul>
        ) : <p className="mt-1 text-xs text-muted-foreground">{keyword ? "Not checked yet." : "Set a target keyword to check AI citations."}</p>}
      </div>
    </section>
  );
}

export function InternalLinksCard({ contentId, links, canEdit }: { contentId: string; links: LinkSuggestion[]; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <section className="rounded-xl border bg-card p-4" data-testid="internal-links">
      <h2 className="text-sm font-semibold">Internal link suggestions</h2>
      <p className="mt-1 text-xs text-muted-foreground">From your published articles, keyword clusters and the latest site audit, ranked by topical similarity.</p>
      {links.length ? (
        <ul className="mt-3 grid gap-3 text-sm">
          {links.map((l) => (
            <li key={`${l.url}${l.anchor}`} className="grid gap-1">
              <div className="flex items-center justify-between gap-2">
                <a className="min-w-0 truncate font-medium hover:underline" href={l.url} target="_blank" rel="noopener noreferrer">{l.targetTitle}</a>
                {l.anchor && canEdit ? (
                  <Button size="xs" variant="outline" disabled={pending} onClick={() => start(async () => { const r = await applyInternalLinkAction(contentId, l.anchor, l.url); if (r.ok) { toast.success(r.message ?? "Added"); router.refresh(); } else toast.error(r.error); })}>Add link</Button>
                ) : null}
              </div>
              {l.anchor ? <p className="text-xs text-muted-foreground">Anchor “<span className="font-medium text-foreground">{l.anchor}</span>”: {l.context}</p> : <p className="text-xs text-muted-foreground">Closely related — add a link with your own anchor text.</p>}
            </li>
          ))}
        </ul>
      ) : <p className="mt-3 text-sm text-muted-foreground">No suggestions. Suggestions need published articles, keyword clusters mapped to URLs, or a site audit.</p>}
    </section>
  );
}

const DEFAULT_TYPES: SchemaType[] = ["BlogPosting", "FAQPage", "BreadcrumbList", "Organization"];

export function SchemaCard({ contentId, saved, canEdit }: { contentId: string; saved: Record<string, unknown> | null; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [types, setTypes] = useState<Set<SchemaType>>(new Set(DEFAULT_TYPES));
  const [opts, setOpts] = useState({ authorName: "", publisherName: "", imageUrl: "", logoUrl: "", telephone: "", streetAddress: "", addressLocality: "", postalCode: "", addressCountry: "", productName: "", price: "", currency: "" });
  const [out, setOut] = useState<{ jsonld: unknown; warnings: string[]; problems: string[] } | null>(saved ? { jsonld: saved, warnings: [], problems: [] } : null);
  const set = (k: keyof typeof opts) => (e: React.ChangeEvent<HTMLInputElement>) => setOpts({ ...opts, [k]: e.target.value });
  const run = (save: boolean) => start(async () => {
    const res = await buildSchemaAction(contentId, {
      types: [...types], authorName: opts.authorName, publisherName: opts.publisherName, imageUrl: opts.imageUrl, logoUrl: opts.logoUrl,
      business: { telephone: opts.telephone, streetAddress: opts.streetAddress, addressLocality: opts.addressLocality, postalCode: opts.postalCode, addressCountry: opts.addressCountry },
      product: { name: opts.productName, price: opts.price, currency: opts.currency },
    }, save);
    if (!res.ok) return void toast.error(res.error);
    setOut(res.data as typeof out);
    if (save) { toast.success(res.message ?? "Saved"); router.refresh(); }
  });
  const json = out ? JSON.stringify(out.jsonld, null, 2) : "";
  return (
    <section className="rounded-xl border bg-card p-4" data-testid="schema-generator">
      <h2 className="text-sm font-semibold">Structured data (JSON-LD)</h2>
      <p className="mt-1 text-xs text-muted-foreground">FAQ and HowTo items are taken from the article itself (question headings and numbered steps).</p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm">
        {SCHEMA_TYPES.map((t) => (
          <label key={t} className="flex items-center gap-1.5"><Checkbox checked={types.has(t)} onCheckedChange={(v) => setTypes((s) => { const n = new Set(s); if (v) n.add(t); else n.delete(t); return n; })} />{t}</label>
        ))}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Field label="Author" htmlFor="s-author"><Input id="s-author" value={opts.authorName} onChange={set("authorName")} /></Field>
        <Field label="Publisher / business name" htmlFor="s-pub"><Input id="s-pub" value={opts.publisherName} onChange={set("publisherName")} placeholder="Defaults to the website name" /></Field>
        <Field label="Image URL" htmlFor="s-img"><Input id="s-img" value={opts.imageUrl} onChange={set("imageUrl")} /></Field>
        <Field label="Logo URL" htmlFor="s-logo"><Input id="s-logo" value={opts.logoUrl} onChange={set("logoUrl")} /></Field>
        {types.has("LocalBusiness") ? (<>
          <Field label="Street address" htmlFor="s-street"><Input id="s-street" value={opts.streetAddress} onChange={set("streetAddress")} /></Field>
          <Field label="City" htmlFor="s-city"><Input id="s-city" value={opts.addressLocality} onChange={set("addressLocality")} /></Field>
          <Field label="Postal code" htmlFor="s-zip"><Input id="s-zip" value={opts.postalCode} onChange={set("postalCode")} /></Field>
          <Field label="Country (2 letters)" htmlFor="s-country"><Input id="s-country" value={opts.addressCountry} onChange={set("addressCountry")} maxLength={2} /></Field>
          <Field label="Telephone" htmlFor="s-tel"><Input id="s-tel" value={opts.telephone} onChange={set("telephone")} /></Field>
        </>) : null}
        {types.has("Product") ? (<>
          <Field label="Product name" htmlFor="s-pname"><Input id="s-pname" value={opts.productName} onChange={set("productName")} /></Field>
          <Field label="Price" htmlFor="s-price"><Input id="s-price" value={opts.price} onChange={set("price")} /></Field>
          <Field label="Currency" htmlFor="s-cur"><Input id="s-cur" value={opts.currency} onChange={set("currency")} placeholder="USD" maxLength={3} /></Field>
        </>) : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={pending || !types.size} onClick={() => run(false)}>Generate</Button>
        {canEdit ? <Button size="sm" disabled={pending || !types.size} onClick={() => run(true)}>Generate & save</Button> : null}
        {out ? <Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(`<script type="application/ld+json">\n${json}\n</script>`).then(() => toast.success("Copied"))}>Copy &lt;script&gt;</Button> : null}
      </div>
      {out ? (
        <div className="mt-3 grid gap-2">
          {[...out.problems, ...out.warnings].map((w) => <p key={w} className="text-xs text-amber-700">{w}</p>)}
          {!out.problems.length ? <p className="text-xs text-emerald-700">Required properties present. Confirm with Google’s Rich Results Test after publishing.</p> : null}
          <pre className="max-h-72 overflow-auto rounded-lg bg-muted p-3 text-xs" data-testid="schema-output">{json}</pre>
          <p className="text-xs text-muted-foreground">Saved markup is not added to the CMS automatically: paste it into your theme/SEO plugin, or into the article body (the validation checks JSON-LD in the body). Many CMSs strip &lt;script&gt; tags from post content.</p>
        </div>
      ) : null}
    </section>
  );
}

export function AiBriefCard({ brief }: { brief: Record<string, unknown> }) {
  const review = brief.review as { scores: Record<string, number>; claimsToVerify: string[]; issues: { severity: string; message: string }[]; verdict: string } | undefined;
  const b = brief.brief as { searchIntent: string; angle: string; questions: string[]; entities: string[] } | undefined;
  return (
    <section className="rounded-xl border bg-card p-4" data-testid="ai-brief">
      <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">AI generation report</h2>{brief.provider === "mock" ? <ToneBadge tone="warning">mock output</ToneBadge> : <ToneBadge tone="info">{String((brief.models as string[] | undefined)?.[0] ?? "AI")}</ToneBadge>}</div>
      {review ? (
        <>
          <p className="mt-2 text-sm">Reviewer verdict: <span className="font-medium">{review.verdict === "ready_for_editor" ? "ready for an editor" : "needs revision"}</span></p>
          <p className="text-xs text-muted-foreground">{Object.entries(review.scores).map(([k, v]) => `${k} ${v}/10`).join(" · ")}</p>
          {review.claimsToVerify.length ? <><p className="mt-2 text-xs font-medium">Verify before publishing</p><ul className="list-disc pl-5 text-xs text-muted-foreground">{review.claimsToVerify.map((c) => <li key={c}>{c}</li>)}</ul></> : null}
          {review.issues.length ? <><p className="mt-2 text-xs font-medium">Issues</p><ul className="list-disc pl-5 text-xs text-muted-foreground">{review.issues.map((i) => <li key={i.message}>[{i.severity}] {i.message}</li>)}</ul></> : null}
        </>
      ) : null}
      {b ? <p className="mt-2 text-xs text-muted-foreground">Intent: {b.searchIntent} · Angle: {b.angle}</p> : null}
    </section>
  );
}
