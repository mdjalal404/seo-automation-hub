"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import { createContentAction, previewAction, updateContentAction } from "@/app/actions/content";
import { Field, FormError } from "@/components/common/field";
import { NativeSelect } from "@/components/common/native-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { contentSchema, slugify } from "@/lib/validation/schemas";

type Values = z.input<typeof contentSchema>;

export function ContentEditor({ websites, initial, contentId, readOnly, lockedReason }: {
  websites: { id: string; name: string; client: string; cmsType?: string }[];
  initial?: Partial<Values>;
  contentId?: string;
  readOnly?: boolean;
  lockedReason?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [preview, setPreview] = useState<string>("");
  const [pending, start] = useTransition();
  const form = useForm<Values>({
    resolver: zodResolver(contentSchema),
    defaultValues: {
      websiteId: websites[0]?.id ?? "", title: "", slug: "", body: "", bodyFormat: "markdown", excerpt: "", metaTitle: "",
      metaDescription: "", canonicalUrl: "", targetKeyword: "", categories: "", tags: "", featuredMediaId: "", assignedTo: "",
      ...initial,
    },
  });
  const { errors } = form.formState;
  const metaTitle = useWatch({ control: form.control, name: "metaTitle" }) ?? "";
  const metaDesc = useWatch({ control: form.control, name: "metaDescription" }) ?? "";
  const selectedWebsite = useWatch({ control: form.control, name: "websiteId" });
  const platform = websites.find((w) => w.id === selectedWebsite)?.cmsType;

  const onSubmit = form.handleSubmit((values) =>
    start(async () => {
      setError(null);
      const res = contentId ? await updateContentAction(contentId, values) : await createContentAction(values);
      if (!res.ok) {
        setError(res.error);
        Object.entries(res.fieldErrors ?? {}).forEach(([k, m]) => form.setError(k as keyof Values, { message: m }));
        return;
      }
      toast.success(res.message ?? "Saved");
      if (!contentId && typeof res.data === "string") router.push(`/content/${res.data}`);
      else router.refresh();
    }),
  );

  const showPreview = () =>
    start(async () => {
      setTab("preview");
      const res = await previewAction(form.getValues("body") ?? "", (form.getValues("bodyFormat") as "markdown" | "html") ?? "markdown");
      setPreview(res.ok ? (res.data ?? "") : `<p>${res.error}</p>`);
    });

  return (
    <form onSubmit={onSubmit} className="grid gap-5" noValidate>
      <FormError message={error} />
      {lockedReason ? <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">{lockedReason}</p> : null}
      <fieldset disabled={readOnly || pending} className="grid gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Website" htmlFor="c-website" error={errors.websiteId?.message}>
            <NativeSelect id="c-website" {...form.register("websiteId")}>
              {websites.map((w) => <option key={w.id} value={w.id}>{w.client} — {w.name}</option>)}
            </NativeSelect>
          </Field>
          <Field label="Target keyword" htmlFor="c-kw" error={errors.targetKeyword?.message}>
            <Input id="c-kw" {...form.register("targetKeyword")} />
          </Field>
        </div>
        <Field label="Title" htmlFor="c-title" error={errors.title?.message}>
          <Input id="c-title" {...form.register("title", { onChange: (e) => { if (!contentId && !form.formState.dirtyFields.slug) form.setValue("slug", slugify(e.target.value)); } })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Slug" htmlFor="c-slug" error={errors.slug?.message} hint="Leave empty to generate from the title.">
            <Input id="c-slug" {...form.register("slug")} />
          </Field>
          <Field label="Body format" htmlFor="c-format">
            <NativeSelect id="c-format" {...form.register("bodyFormat")}>
              <option value="markdown">Markdown</option>
              <option value="html">HTML</option>
            </NativeSelect>
          </Field>
        </div>

        <div className="grid gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Body</span>
            <div className="flex gap-1 rounded-md bg-muted p-0.5 text-xs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === "write"} className={`rounded px-2 py-1 ${tab === "write" ? "bg-background shadow-xs" : ""}`} onClick={() => setTab("write")}>Write</button>
              <button type="button" role="tab" aria-selected={tab === "preview"} className={`rounded px-2 py-1 ${tab === "preview" ? "bg-background shadow-xs" : ""}`} onClick={showPreview}>Preview</button>
            </div>
          </div>
          {tab === "write" ? (
            <Textarea id="c-body" aria-label="Body" rows={18} className="h-[28rem] resize-y font-mono text-[13px] field-sizing-fixed" {...form.register("body")} />
          ) : (
            <div className="prose-preview h-[28rem] overflow-y-auto rounded-lg border bg-background p-4 text-sm" dangerouslySetInnerHTML={{ __html: preview }} />
          )}
          {errors.body?.message ? <p className="text-xs text-destructive">{errors.body.message}</p> : null}
        </div>

        <Field label="Excerpt" htmlFor="c-excerpt" error={errors.excerpt?.message}>
          <Textarea id="c-excerpt" rows={2} {...form.register("excerpt")} />
        </Field>

        <div className="rounded-lg border p-4">
          <p className="mb-3 text-sm font-medium">SEO metadata</p>
          <div className="grid gap-4">
            <Field label="Meta title" htmlFor="c-mt" error={errors.metaTitle?.message} hint={`${[...metaTitle].length} characters`}>
              <Input id="c-mt" {...form.register("metaTitle")} />
            </Field>
            <Field label="Meta description" htmlFor="c-md" error={errors.metaDescription?.message} hint={`${[...metaDesc].length} characters`}>
              <Textarea id="c-md" rows={2} {...form.register("metaDescription")} />
            </Field>
            <Field label="Canonical URL" htmlFor="c-canon" error={errors.canonicalUrl?.message} hint="Optional. Leave empty to use the CMS default.">
              <Input id="c-canon" {...form.register("canonicalUrl")} />
            </Field>
          </div>
        </div>

        {/* WordPress-only fields: hidden (still registered) for other platforms. */}
        <div className={cn("grid gap-4 sm:grid-cols-3", platform && platform !== "wordpress" && "hidden")}>
          <Field label="Category IDs" htmlFor="c-cats" error={errors.categories?.message} hint="WordPress term IDs, comma-separated.">
            <Input id="c-cats" {...form.register("categories")} />
          </Field>
          <Field label="Tag IDs" htmlFor="c-tags" error={errors.tags?.message}>
            <Input id="c-tags" {...form.register("tags")} />
          </Field>
          <Field label="Featured media ID" htmlFor="c-media" error={errors.featuredMediaId?.message} hint="An existing WordPress media ID.">
            <Input id="c-media" {...form.register("featuredMediaId")} />
          </Field>
        </div>
      </fieldset>
      {!readOnly ? (
        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>{pending ? "Saving…" : contentId ? "Save changes" : "Save draft"}</Button>
        </div>
      ) : null}
    </form>
  );
}
