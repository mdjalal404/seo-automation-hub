"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { deleteTemplateAction, generateFromTemplateAction, previewTemplateAction, saveTemplateAction } from "@/app/actions/seo";
import { Field, FormError } from "@/components/common/field";
import { NativeSelect } from "@/components/common/native-select";
import { ToneBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { RenderedPage } from "@/lib/programmatic/templates";
import type { TemplateRow } from "@/lib/services/seo";

const SAMPLE = {
  name: "City service pages",
  titleTemplate: "{{service|title}} in {{city}} — {{brand}}",
  slugTemplate: "{{service}}-{{city}}",
  metaTitleTemplate: "{{service|title}} in {{city}} | {{brand}}",
  metaDescriptionTemplate: "Book {{service}} in {{city}}. {{usp}} Serving {{neighborhoods}}.",
  excerptTemplate: "{{service|title}} in {{city}}.",
  keywordTemplate: "{{service}} {{city}}",
  bodyTemplate: `{{brand}} provides {{service}} in {{city}}. {{usp}}

## {{service|title}} prices in {{city}}

Typical jobs cost {{price_range}}. {{pricing_note}}

## Areas we cover

We work across {{neighborhoods}}.

{{#if testimonial}}> “{{testimonial}}”{{/if}}

## How long does {{service}} take in {{city}}?

{{timeline}}`,
};
const SAMPLE_FEED = `service,city,brand,usp,neighborhoods,price_range,pricing_note,testimonial,timeline
boiler repair,Leeds,Acme Heating,Gas Safe engineers with same-day slots.,"Headingley, Roundhay and Chapel Allerton",£90–£250,Most repairs are fixed on the first visit.,They fixed our boiler in an hour.,Most repairs take 1–2 hours.
boiler repair,York,Acme Heating,Gas Safe engineers with same-day slots.,"Acomb, Clifton and Fulford",£95–£260,Parts for common brands are carried in the van.,,Most repairs take 1–2 hours.`;

/** Marketplace / e-commerce example: one page per game × platform from a product feed. */
const GAME_SAMPLE = {
  name: "Game key product pages",
  titleTemplate: "{{game}} {{platform}} Key – Buy {{edition}} Cheaper",
  slugTemplate: "{{game|slug}}-{{platform|slug}}-key",
  metaTitleTemplate: "{{game}} ({{platform}}) Key | From {{min_price}}",
  metaDescriptionTemplate: "Buy a {{game}} {{platform}} key from {{offers}} verified sellers, from {{min_price}}. Region: {{region}}. Instant delivery.",
  excerptTemplate: "{{game}} for {{platform}}, {{region}} activation.",
  keywordTemplate: "{{game|lower}} {{platform|lower}} key",
  bodyTemplate: `{{game}} ({{edition}}) for {{platform}} is available from {{offers}} sellers, starting at {{min_price}}. The key activates in {{region}}.

## What you get

- Platform: {{platform}}
- Edition: {{edition}}
- Activation region: {{region}}
- Genre: {{genre}}

## About {{game}}

{{description}}

{{#if dlc}}## Included DLC

{{dlc}}{{/if}}

## How do I activate a {{game}} {{platform}} key?

{{activation_steps}}`,
};
const GAME_FEED = `game,platform,edition,region,min_price,offers,genre,description,dlc,activation_steps
Elden Ring,Steam,Standard,Global,€29.99,48,Action RPG,"An open-world action RPG from FromSoftware set in the Lands Between, with tough boss fights and deep build variety.",,"Open Steam, choose Games > Activate a Product on Steam, and enter the key."
Elden Ring,Xbox Series X|S,Deluxe,EU,€39.49,17,Action RPG,"An open-world action RPG from FromSoftware; the Deluxe edition adds the digital artbook and soundtrack.",Digital artbook and soundtrack,"Sign in at microsoft.com/redeem with your Xbox account and enter the 25-character code."`;
const EXAMPLES = { service: { ...SAMPLE, feed: SAMPLE_FEED }, game: { ...GAME_SAMPLE, feed: GAME_FEED } };

type Form = typeof SAMPLE & { websiteId: string };
const FIELDS: [keyof typeof SAMPLE, string, boolean?][] = [
  ["name", "Template name"], ["titleTemplate", "Title"], ["slugTemplate", "Slug"], ["metaTitleTemplate", "Meta title"],
  ["metaDescriptionTemplate", "Meta description"], ["excerptTemplate", "Excerpt"], ["keywordTemplate", "Target keyword"], ["bodyTemplate", "Body (Markdown)", true],
];

function toForm(t: TemplateRow): Form {
  return { websiteId: t.website_id, name: t.name, titleTemplate: t.title_template, slugTemplate: t.slug_template, metaTitleTemplate: t.meta_title_template, metaDescriptionTemplate: t.meta_description_template, excerptTemplate: t.excerpt_template, keywordTemplate: t.keyword_template, bodyTemplate: t.body_template };
}

export function TemplateWorkbench({ websites, templates, canEdit }: { websites: { id: string; name: string }[]; templates: TemplateRow[]; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [id, setId] = useState<string | null>(templates[0]?.id ?? null);
  const [form, setForm] = useState<Form>(templates[0] ? toForm(templates[0]) : { ...SAMPLE, websiteId: websites[0]?.id ?? "" });
  const [feed, setFeed] = useState(templates.length ? "" : SAMPLE_FEED);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ columns: string[]; pages: RenderedPage[] } | null>(null);

  const select = (tid: string) => {
    const t = templates.find((x) => x.id === tid);
    setId(t?.id ?? null);
    setForm(t ? toForm(t) : { ...SAMPLE, websiteId: websites[0]?.id ?? "" });
    setPreview(null);
  };
  const save = () => start(async () => {
    setError(null);
    const res = await saveTemplateAction(id, form);
    if (!res.ok) return setError(res.error);
    setId(res.data as string);
    toast.success(res.message ?? "Saved");
    router.refresh();
  });
  const doPreview = () => start(async () => {
    if (!id) return setError("Save the template first.");
    setError(null);
    const res = await previewTemplateAction(id, feed);
    if (!res.ok) return setError(res.error);
    setPreview(res.data as { columns: string[]; pages: RenderedPage[] });
  });
  const generate = () => start(async () => {
    if (!id) return;
    const res = await generateFromTemplateAction(id, feed);
    if (!res.ok) return setError(res.error);
    toast.success(res.message ?? "Created");
    setPreview(null);
    router.push("/content");
  });
  const valid = preview?.pages.filter((p) => !p.errors.length).length ?? 0;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect aria-label="Template" className="w-64" value={id ?? ""} onChange={(e) => select(e.target.value)}>
          <option value="">New template…</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </NativeSelect>
        {!id ? (
          <NativeSelect aria-label="Start from example" className="w-64" defaultValue="service" onChange={(e) => {
            const ex = EXAMPLES[e.target.value as keyof typeof EXAMPLES];
            const { feed: exFeed, ...fields } = ex;
            setForm({ ...fields, websiteId: form.websiteId });
            setFeed(exFeed);
            setPreview(null);
          }}>
            <option value="service">Example: local service pages</option>
            <option value="game">Example: game key product pages (marketplace)</option>
          </NativeSelect>
        ) : null}
        {id && canEdit ? <Button size="sm" variant="ghost" className="text-destructive" disabled={pending} onClick={() => start(async () => { const r = await deleteTemplateAction(id); if (r.ok) { toast.success("Deleted"); select(""); router.refresh(); } else toast.error(r.error); })}>Delete template</Button> : null}
      </div>
      <FormError message={error} />
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="grid content-start gap-3 rounded-xl border bg-card p-4">
          <h2 className="text-sm font-semibold">Template</h2>
          <Field label="Website" htmlFor="t-website">
            <NativeSelect id="t-website" value={form.websiteId} onChange={(e) => setForm({ ...form, websiteId: e.target.value })}>{websites.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</NativeSelect>
          </Field>
          {FIELDS.map(([k, label, big]) => (
            <Field key={k} label={label} htmlFor={`t-${k}`}>
              {big ? <Textarea id={`t-${k}`} rows={12} className="font-mono text-xs" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                : <Input id={`t-${k}`} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />}
            </Field>
          ))}
          <p className="text-xs text-muted-foreground">Placeholders: <code>{"{{column}}"}</code>, filters <code>{"{{column|title}}"}</code> (lower, upper, title, slug), and <code>{"{{#if column}}…{{/if}}"}</code>.</p>
          {canEdit ? <div><Button size="sm" disabled={pending} onClick={save}>{pending ? "Saving…" : "Save template"}</Button></div> : null}
        </section>
        <section className="grid content-start gap-3 rounded-xl border bg-card p-4">
          <h2 className="text-sm font-semibold">Data feed</h2>
          <Field label="CSV (header row) or JSON array" htmlFor="t-feed" hint="Up to 500 rows per run. Each row becomes one draft.">
            <Textarea id="t-feed" rows={12} className="font-mono text-xs" value={feed} onChange={(e) => setFeed(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={pending || !feed.trim()} onClick={doPreview}>Preview pages</Button>
            {preview && canEdit ? <Button size="sm" disabled={pending || !valid} onClick={generate}>Create {valid} draft{valid === 1 ? "" : "s"}</Button> : null}
          </div>
        </section>
      </div>
      {preview ? (
        <section className="rounded-xl border bg-card" data-testid="template-preview">
          <h2 className="border-b px-4 py-3 text-sm font-semibold">Preview — {valid} of {preview.pages.length} rows valid · columns: {preview.columns.join(", ")}</h2>
          <ul className="divide-y text-sm">
            {preview.pages.slice(0, 100).map((p) => (
              <li key={p.row} className="px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">#{p.row}</span><span className="font-medium">{p.title || "(no title)"}</span><code className="text-xs text-muted-foreground">/{p.slug}</code>
                  <ToneBadge tone={p.uniqueness >= 25 ? "success" : "warning"}>{p.uniqueness}% unique</ToneBadge>
                </div>
                {p.errors.map((e) => <p key={e} className="text-xs text-destructive">{e}</p>)}
                {p.warnings.map((w) => <p key={w} className="text-xs text-amber-700">{w}</p>)}
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{p.metaDescription}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
