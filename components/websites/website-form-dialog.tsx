"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import { createWebsiteAction, updateWebsiteAction } from "@/app/actions/websites";
import { Field, FormError } from "@/components/common/field";
import { NativeSelect } from "@/components/common/native-select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CMS_TYPES, PLATFORMS, type CmsType } from "@/lib/cms/platforms";
import { websiteSchema } from "@/lib/validation/schemas";

type Values = z.input<typeof websiteSchema>;

export function WebsiteFormDialog({ clients, website, defaultClientId, defaultOpen, trigger }: {
  clients: { id: string; name: string }[];
  website?: { id: string; client_id: string; name: string; base_url: string; cms_type: CmsType; timezone: string; max_concurrency: number; connected: boolean };
  defaultClientId?: string;
  defaultOpen?: boolean;
  trigger: React.ReactElement;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(!!defaultOpen);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const zones = useMemo(() => Intl.supportedValuesOf("timeZone"), []);
  const form = useForm<Values>({
    resolver: zodResolver(websiteSchema),
    defaultValues: {
      clientId: website?.client_id ?? defaultClientId ?? clients[0]?.id ?? "",
      name: website?.name ?? "",
      baseUrl: website?.base_url ?? "",
      cmsType: website?.cms_type ?? "wordpress",
      timezone: website?.timezone ?? (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC"),
      maxConcurrency: website?.max_concurrency ?? 1,
    },
  });
  const { errors } = form.formState;
  const cmsType = useWatch({ control: form.control, name: "cmsType" }) ?? "wordpress";

  const onSubmit = form.handleSubmit((values) =>
    start(async () => {
      setError(null);
      const res = website ? await updateWebsiteAction(website.id, values) : await createWebsiteAction(values);
      if (!res.ok) return setError(res.error);
      toast.success(res.message ?? "Saved");
      setOpen(false);
      if (!website && typeof res.data === "string") router.push(`/websites/${res.data}`);
      else router.refresh();
    }),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{website ? "Edit website" : "Add website"}</DialogTitle>
          <DialogDescription>You will connect the CMS on the next screen.</DialogDescription>
        </DialogHeader>
        {clients.length === 0 ? <p className="text-sm">Create a client first.</p> : (
          <form onSubmit={onSubmit} className="grid gap-4" noValidate>
            <FormError message={error} />
            <Field label="Client" htmlFor="ws-client" error={errors.clientId?.message}>
              <NativeSelect id="ws-client" {...form.register("clientId")}>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Website name" htmlFor="ws-name" error={errors.name?.message}>
              <Input id="ws-name" placeholder="Acme Blog" {...form.register("name")} />
            </Field>
            <Field label="Platform" htmlFor="ws-cms" error={errors.cmsType?.message}
              hint={website?.connected ? "Disconnect the CMS to change the platform." : undefined}>
              {/* Not `disabled`: disabled fields are dropped from the submitted values. */}
              <NativeSelect id="ws-cms" {...form.register("cmsType")}>
                {(website?.connected ? [website.cms_type] : CMS_TYPES).map((t) => <option key={t} value={t}>{PLATFORMS[t].label}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Website address" htmlFor="ws-url" error={errors.baseUrl?.message} hint={PLATFORMS[cmsType as CmsType]?.addressHint}>
              <Input id="ws-url" placeholder="https://" {...form.register("baseUrl")} />
            </Field>
            <Field label="Website timezone" htmlFor="ws-tz" error={errors.timezone?.message} hint="Scheduled publishing times are entered in this timezone.">
              <NativeSelect id="ws-tz" {...form.register("timezone")}>
                {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                <option value="UTC">UTC</option>
              </NativeSelect>
            </Field>
            <Field label="Max concurrent jobs" htmlFor="ws-conc" error={errors.maxConcurrency?.message} hint="1 is safest for shared hosting.">
              <Input id="ws-conc" type="number" min={1} max={5} {...form.register("maxConcurrency")} />
            </Field>
            <DialogFooter><Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save website"}</Button></DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
