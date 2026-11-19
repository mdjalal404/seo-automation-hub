"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FormError } from "@/components/common/field";
import { Button } from "@/components/ui/button";

export function LogUpload({ websiteId }: { websiteId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="grid gap-3" onSubmit={(e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      fd.set("websiteId", websiteId);
      start(async () => {
        setError(null);
        const res = await fetch("/api/logs", { method: "POST", body: fd });
        const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
        if (!res.ok) return setError(body.error ?? "Upload failed.");
        toast.success("Log analyzed");
        router.refresh();
      });
    }}>
      <FormError message={error} />
      <label htmlFor="log-file" className="text-sm font-medium">Access log (Apache/Nginx combined format, .log or .gz, up to 200 MB)</label>
      <input id="log-file" name="file" type="file" accept=".log,.txt,.gz,text/plain,application/gzip" required className="text-sm file:mr-3 file:rounded-md file:border file:bg-muted file:px-3 file:py-1" />
      <div><Button type="submit" size="sm" disabled={pending}>{pending ? "Analyzing…" : "Analyze log"}</Button></div>
      <p className="text-xs text-muted-foreground">Bots are identified by user agent. For larger files or reverse-DNS Googlebot verification use <code>python -m seo_toolkit logs</code>.</p>
    </form>
  );
}
