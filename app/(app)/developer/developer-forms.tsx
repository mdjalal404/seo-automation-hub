"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createApiKeyAction, revokeApiKeyAction, runGateAction } from "@/app/actions/seo";
import { Field } from "@/components/common/field";
import { NativeSelect } from "@/components/common/native-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ApiKeyRow } from "@/lib/services/monitoring";

export function ApiKeyManager({ keys, canManage }: { keys: (ApiKeyRow & { usage: string })[]; canManage: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("GitHub Actions");
  const [created, setCreated] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="grid gap-3">
      {created ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-700 dark:bg-amber-950" data-testid="new-api-key">
          <p className="mb-1 font-medium">Copy this key now. It is stored only as a hash and cannot be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1">{created}</code>
            <Button size="xs" variant="outline" onClick={() => navigator.clipboard.writeText(created).then(() => toast.success("Copied"))}>Copy</Button>
          </div>
        </div>
      ) : null}
      {canManage ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Key name" htmlFor="api-key-name"><Input id="api-key-name" value={name} onChange={(e) => setName(e.target.value)} className="w-56" /></Field>
          <Button size="sm" disabled={pending || !name.trim()} onClick={() => start(async () => {
            const r = await createApiKeyAction(name);
            if (r.ok && r.data) { setCreated(r.data.key); toast.success(r.message ?? "Created"); router.refresh(); } else if (!r.ok) toast.error(r.error);
          })}>Create API key</Button>
        </div>
      ) : <p className="text-xs text-muted-foreground">Owners and admins create API keys.</p>}
      <ul className="divide-y rounded-md border text-sm" data-testid="api-keys">
        {keys.length ? keys.map((k) => (
          <li key={k.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="font-medium">{k.name}</span>
            <code className="text-xs text-muted-foreground">seoh_{k.prefix}_…</code>
            <span className="text-xs text-muted-foreground">{k.usage}</span>
            {k.revoked_at ? <span className="ml-auto text-xs text-destructive">revoked</span> : canManage ? (
              <Button className="ml-auto" size="xs" variant="ghost" disabled={pending} onClick={() => start(async () => {
                const r = await revokeApiKeyAction(k.id);
                if (r.ok) { toast.success(r.message ?? "Revoked"); router.refresh(); } else toast.error(r.error);
              })}>Revoke</Button>
            ) : null}
          </li>
        )) : <li className="px-3 py-3 text-xs text-muted-foreground">No API keys yet.</li>}
      </ul>
    </div>
  );
}

export function GateRunForm({ websites, canRun }: { websites: { id: string; name: string }[]; canRun: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const submit = (fd: FormData) => start(async () => {
    const paths = String(fd.get("paths") ?? "").split(/[\s,]+/).filter(Boolean);
    const r = await runGateAction({
      website_id: fd.get("website_id"), target_base_url: String(fd.get("target") ?? ""), paths: paths.length ? paths : undefined,
      fail_on: fd.get("fail_on"), allow_noindex: fd.get("allow_noindex") === "on",
    });
    if (r.ok) { toast.success(r.message ?? "Queued"); router.refresh(); } else toast.error(r.error);
  });
  return (
    <form action={submit} className="grid gap-3 sm:grid-cols-2">
      <Field label="Website" htmlFor="gate-website"><NativeSelect id="gate-website" name="website_id">{websites.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</NativeSelect></Field>
      <Field label="Target (optional)" htmlFor="gate-target" hint="A preview/staging origin. Empty = the live website."><Input id="gate-target" name="target" placeholder="https://preview.example.com" /></Field>
      <Field label="Paths (optional)" htmlFor="gate-paths" hint="Empty = homepage + the most-linked pages from the last audit."><Input id="gate-paths" name="paths" placeholder="/, /pricing, /blog" /></Field>
      <Field label="Fail on" htmlFor="gate-fail"><NativeSelect id="gate-fail" name="fail_on"><option value="error">Errors only</option><option value="warning">Errors and warnings</option></NativeSelect></Field>
      <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="allow_noindex" /> Allow noindex (preview environments are usually noindex)</label>
      <div className="sm:col-span-2"><Button type="submit" size="sm" disabled={!canRun || pending || !websites.length}>{pending ? "Queuing…" : "Run deploy gate now"}</Button></div>
    </form>
  );
}
