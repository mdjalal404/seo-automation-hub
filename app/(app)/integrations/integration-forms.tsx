"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { connectIntegrationAction, saveScheduleAction } from "@/app/actions/seo";
import { Field, FormError } from "@/components/common/field";
import { NativeSelect } from "@/components/common/native-select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ProviderId } from "@/lib/analytics/providers";

type FieldDef = { name: string; label: string; type?: "textarea" | "password" | "select"; placeholder?: string; hint?: string; options?: [string, string][]; generate?: () => string };
const randomToken = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
const SEVERITY: [string, string][] = [["warning", "Critical and warnings"], ["critical", "Critical only"], ["info", "Everything, including changes"]];

const FIELDS: Record<ProviderId, FieldDef[]> = {
  google_search_console: [
    { name: "serviceAccount", label: "Service account key (JSON)", type: "textarea", placeholder: '{"type": "service_account", …}' },
    { name: "siteUrl", label: "Property (optional)", placeholder: "sc-domain:example.com or https://www.example.com/", hint: "Leave empty to pick the property that matches the website automatically." },
  ],
  google_analytics_4: [
    { name: "serviceAccount", label: "Service account key (JSON)", type: "textarea", placeholder: '{"type": "service_account", …}' },
    { name: "propertyId", label: "GA4 property ID", placeholder: "123456789" },
  ],
  microsoft_clarity: [{ name: "apiToken", label: "Data export API token", type: "password" }],
  dataforseo: [
    { name: "login", label: "API login" }, { name: "password", label: "API password", type: "password" },
    { name: "locationCode", label: "Location code", placeholder: "2840", hint: "2840 = United States, 2826 = United Kingdom, 2356 = India." },
    { name: "languageCode", label: "Language code", placeholder: "en" },
    { name: "markets", label: "Extra markets (optional)", placeholder: "UK:2826:en, DE:2276:de", hint: "Track the same keywords in up to 5 more countries: label:location code:language." },
  ],
  similarweb: [{ name: "apiKey", label: "API key", type: "password" }],
  pagespeed: [{ name: "apiKey", label: "API key (optional)", type: "password", hint: "Without a key Google applies a very low shared quota." }],
  mixpanel: [
    { name: "username", label: "Service account username" }, { name: "secret", label: "Service account secret", type: "password" },
    { name: "projectId", label: "Project ID", placeholder: "1234567" }, { name: "region", label: "Data residency", placeholder: "us", hint: "us, eu or in." },
    { name: "event", label: "Conversion event", placeholder: "Purchase" },
    { name: "segmentProperty", label: "Landing page property", placeholder: "landing_page" },
    { name: "where", label: "Filter (optional)", placeholder: 'properties["utm_medium"] == "organic"', hint: "Mixpanel expression to keep only organic traffic." },
  ],
  databricks: [
    { name: "host", label: "Workspace host", placeholder: "dbc-1234abcd.cloud.databricks.com" }, { name: "token", label: "Access token", type: "password" },
    { name: "warehouseId", label: "SQL warehouse ID" }, { name: "catalog", label: "Catalog", placeholder: "main" }, { name: "schema", label: "Schema", placeholder: "seo" },
  ],
  slack: [
    { name: "webhookUrl", label: "Incoming webhook URL", type: "password", placeholder: "https://hooks.slack.com/services/…" },
    { name: "minSeverity", label: "Send", type: "select", options: SEVERITY },
  ],
  webhook: [
    { name: "url", label: "Endpoint URL", placeholder: "https://ops.example.com/hooks/seo" },
    { name: "signingSecret", label: "Signing secret", type: "password", generate: () => randomToken(24), hint: "Pre-filled with a random secret. Copy it to your receiver to verify X-SEOHub-Signature." },
    { name: "minSeverity", label: "Send", type: "select", options: SEVERITY },
  ],
  indexnow: [
    { name: "key", label: "IndexNow key", generate: () => randomToken(16), hint: "Pre-filled with a new key. Upload <key>.txt containing exactly this key to the site root before saving." },
    { name: "autoSubmit", label: "Submit automatically", type: "select", options: [["on", "After publishing and when an audit finds changed pages"], ["off", "Only when I submit URLs"]] },
  ],
};

export function ConnectIntegrationDialog({ websiteId, provider, label, help, docs, connected }: { websiteId: string; provider: ProviderId; label: string; help: string; docs: string; connected: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const [generated, setGenerated] = useState<Record<string, string> | null>(null);
  const onOpenChange = (next: boolean) => {
    if (next) setGenerated(Object.fromEntries(FIELDS[provider].filter((f) => f.generate).map((f) => [f.name, f.generate!()])));
    setOpen(next);
  };
  const submit = (fd: FormData) =>
    start(async () => {
      setError(null);
      const input: Record<string, unknown> = { provider, websiteId };
      for (const f of FIELDS[provider]) input[f.name] = fd.get(f.name) ?? "";
      for (const [k, v] of Object.entries({ region: "us", segmentProperty: "landing_page", catalog: "main", schema: "seo" })) if (k in input && !input[k]) input[k] = v;
      if (provider === "dataforseo") {
        input.locationCode = input.locationCode || 2840;
        input.languageCode = input.languageCode || "en";
      }
      const res = await connectIntegrationAction(input);
      if (!res.ok) {
        setFieldErrors(res.fieldErrors ?? {});
        return setError(res.error);
      }
      toast.success(res.message ?? "Connected");
      setOpen(false);
      router.refresh();
    });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button size="xs" variant={connected ? "outline" : "default"}>{connected ? "Replace credentials" : "Connect"}</Button>} />
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Connect {label}</DialogTitle>
          <DialogDescription>{help} <a className="underline" href={docs} target="_blank" rel="noopener noreferrer">Documentation</a></DialogDescription>
        </DialogHeader>
        <form action={submit} className="grid gap-3" noValidate autoComplete="off">
          <FormError message={error} />
          {FIELDS[provider].map((f) => (
            <Field key={f.name} label={f.label} htmlFor={`${provider}-${f.name}`} hint={f.hint} error={fieldErrors[f.name]}>
              {f.type === "textarea"
                ? <Textarea id={`${provider}-${f.name}`} name={f.name} rows={5} placeholder={f.placeholder} spellCheck={false} className="h-32 resize-y font-mono text-xs field-sizing-fixed" />
                : f.type === "select"
                  ? <NativeSelect id={`${provider}-${f.name}`} name={f.name}>{f.options!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</NativeSelect>
                  : <Input id={`${provider}-${f.name}`} name={f.name} type={f.generate ? "text" : (f.type ?? "text")} placeholder={f.placeholder} autoComplete="off" defaultValue={f.generate && generated ? generated[f.name] : undefined} className={f.generate ? "font-mono text-xs" : undefined} />}
            </Field>
          ))}
          <p className="text-xs text-muted-foreground">{provider === "slack" || provider === "webhook" ? `Saving sends one test message, then the ${provider === "slack" ? "webhook URL is" : "endpoint and secret are"} stored encrypted (AES-256-GCM).` : provider === "indexnow" ? "Saving checks that the key file is reachable on your site." : `Credentials are tested against ${label} first, then stored encrypted (AES-256-GCM). They are never shown again.`}</p>
          <div><Button type="submit" disabled={pending}>{pending ? "Testing…" : "Test & save"}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const TASKS = [
  { type: "ANALYTICS_SYNC", label: "Analytics sync", hint: "Search Console, GA4, Clarity, Similarweb", def: "daily" },
  { type: "SITE_AUDIT", label: "Technical site audit", hint: "Crawl up to 100 pages", def: "weekly" },
  { type: "RANK_CHECK", label: "Rank & AI Overview tracking", hint: "Tracked keywords via DataForSEO (billed per check)", def: "weekly" },
  { type: "AI_VISIBILITY_CHECK", label: "AI answer visibility", hint: "Top 10 tracked keywords via Claude web search", def: "weekly" },
  { type: "AGENT_RUN", label: "SEO agent review", hint: "Agent investigates and files proposals for approval", def: "weekly" },
  { type: "WAREHOUSE_EXPORT", label: "Databricks export", hint: "Modeled SEO tables to your warehouse", def: "daily" },
] as const;

export function ScheduleEditor({ websiteId, schedules, canEdit }: { websiteId: string; schedules: { task_type: string; cadence: string; enabled: boolean; next_run_at: string }[]; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const save = (taskType: string, cadence: string, enabled: boolean) =>
    start(async () => {
      const res = await saveScheduleAction({ websiteId, taskType, cadence, enabled, params: taskType === "SITE_AUDIT" ? { maxPages: 100 } : {} });
      if (res.ok) { toast.success(res.message ?? "Saved"); router.refresh(); } else toast.error(res.error);
    });
  return (
    <ul className="divide-y text-sm" data-testid="schedules">
      {TASKS.map((t) => {
        const s = schedules.find((x) => x.task_type === t.type);
        const cadence = s?.cadence ?? t.def;
        return (
          <li key={t.type} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1"><p className="font-medium">{t.label}</p><p className="text-xs text-muted-foreground" suppressHydrationWarning>{t.hint}{s?.enabled ? ` · next run ${new Date(s.next_run_at).toLocaleString()}` : ""}</p></div>
            <NativeSelect aria-label={`${t.label} cadence`} className="w-28" disabled={!canEdit || pending} value={cadence} onChange={(e) => save(t.type, e.target.value, s?.enabled ?? false)}>
              <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
            </NativeSelect>
            <Button size="xs" variant={s?.enabled ? "default" : "outline"} disabled={!canEdit || pending} onClick={() => save(t.type, cadence, !s?.enabled)} aria-pressed={!!s?.enabled}>
              {s?.enabled ? "On" : "Off"}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
