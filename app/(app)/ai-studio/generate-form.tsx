"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { generateArticleAction } from "@/app/actions/seo";
import { Field, FormError } from "@/components/common/field";
import { NativeSelect } from "@/components/common/native-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Defaults = { websiteId: string; topic?: string; targetKeyword?: string; secondaryKeywords?: string; clusterId?: string };

export function GenerateForm({ websites, defaults, disabled }: { websites: { id: string; name: string }[]; defaults: Defaults; disabled?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const requestKey = useRef(crypto.randomUUID());

  const submit = (fd: FormData) =>
    start(async () => {
      setError(null);
      const input = {
        websiteId: fd.get("websiteId"), topic: fd.get("topic"), targetKeyword: fd.get("targetKeyword"),
        secondaryKeywords: String(fd.get("secondaryKeywords") ?? "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
        audience: fd.get("audience"), tone: fd.get("tone"), wordCount: fd.get("wordCount"), brandNotes: fd.get("brandNotes"), clusterId: fd.get("clusterId") ?? "",
      };
      const res = await generateArticleAction(input, requestKey.current);
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        return setError(res.error);
      }
      setErrors({});
      requestKey.current = crypto.randomUUID();
      toast.success(res.message ?? "Queued");
      router.refresh();
    });

  return (
    <form action={submit} className="grid gap-4" noValidate>
      <FormError message={error} />
      <input type="hidden" name="clusterId" value={defaults.clusterId ?? ""} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Website" htmlFor="g-website">
          <NativeSelect id="g-website" name="websiteId" defaultValue={defaults.websiteId}>{websites.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</NativeSelect>
        </Field>
        <Field label="Primary keyword" htmlFor="g-keyword" error={errors.targetKeyword}>
          <Input id="g-keyword" name="targetKeyword" defaultValue={defaults.targetKeyword} placeholder="e.g. dental implants cost" />
        </Field>
      </div>
      <Field label="Topic / working title" htmlFor="g-topic" error={errors.topic}>
        <Input id="g-topic" name="topic" defaultValue={defaults.topic} placeholder="What should the article cover?" />
      </Field>
      <Field label="Secondary keywords" htmlFor="g-secondary" hint="Comma-separated. Filled in from the keyword cluster when you start from Keywords.">
        <Textarea id="g-secondary" name="secondaryKeywords" rows={2} defaultValue={defaults.secondaryKeywords} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Audience" htmlFor="g-audience"><Input id="g-audience" name="audience" placeholder="e.g. first-time buyers" /></Field>
        <Field label="Tone" htmlFor="g-tone">
          <NativeSelect id="g-tone" name="tone" defaultValue="professional">
            <option value="professional">Professional</option><option value="friendly">Friendly</option><option value="expert">Expert</option><option value="conversational">Conversational</option>
          </NativeSelect>
        </Field>
        <Field label="Length (words)" htmlFor="g-length" error={errors.wordCount}><Input id="g-length" name="wordCount" type="number" min={300} max={4000} step={100} defaultValue={1200} /></Field>
      </div>
      <Field label="Brand voice & facts to include" htmlFor="g-brand" hint="Products, first-hand experience, prices, locations — anything the model should not guess.">
        <Textarea id="g-brand" name="brandNotes" rows={3} />
      </Field>
      <div><Button type="submit" disabled={pending || disabled}>{pending ? "Queuing…" : "Generate draft"}</Button></div>
    </form>
  );
}
