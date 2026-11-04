"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { importCsvAction, previewCsvAction } from "@/app/actions/imports";
import { FormError } from "@/components/common/field";
import { ToneBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ParsedCsvRow } from "@/lib/csv/import";

export function CsvImport() {
  const router = useRouter();
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ParsedCsvRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const invalid = rows?.filter((r) => r.errors.length).length ?? 0;

  const onFile = async (file: File | undefined) => {
    setRows(null); setError(null);
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return setError("The file is larger than 2 MB.");
    const t = await file.text();
    setText(t); setFileName(file.name);
    start(async () => {
      const res = await previewCsvAction(t);
      if (!res.ok) return setError(res.error);
      if (res.data?.fatal) return setError(res.data.fatal);
      setRows(res.data?.rows ?? []);
    });
  };

  const doImport = () =>
    start(async () => {
      const res = await importCsvAction(text ?? "");
      if (!res.ok) return setError(res.error);
      toast.success(res.message ?? "Imported");
      router.push("/content?status=DRAFT");
    });

  return (
    <div className="grid gap-4">
      <div className="rounded-xl border bg-card p-5">
        <label htmlFor="csv-file" className="text-sm font-medium">CSV file</label>
        <input id="csv-file" type="file" accept=".csv,text/csv" className="mt-2 block text-sm" onChange={(e) => onFile(e.target.files?.[0])} />
        <p className="mt-2 text-xs text-muted-foreground">
          Required columns: <code>website</code> (name or base URL) and <code>title</code>. Optional: slug, body, body_format (markdown|html), excerpt,
          meta_title, meta_description, canonical_url, target_keyword, categories, tags (comma-separated IDs), scheduled_at (YYYY-MM-DD HH:mm in the website&apos;s timezone).
          Up to 500 rows. <Link className="underline" href="/sample-import.csv">Download a sample</Link>.
        </p>
      </div>
      <FormError message={error} />
      {pending && !rows ? <p className="text-sm text-muted-foreground">Checking file…</p> : null}
      {rows ? (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm">{fileName}: <strong>{rows.length}</strong> rows, <strong className={invalid ? "text-red-700" : ""}>{invalid}</strong> with errors.</p>
            <Button onClick={doImport} disabled={pending || invalid > 0 || rows.length === 0}>{invalid ? "Fix errors to import" : pending ? "Importing…" : `Import ${rows.length} as drafts`}</Button>
          </div>
          <div className="overflow-x-auto rounded-xl border bg-card">
            <Table data-testid="csv-preview">
              <TableHeader><TableRow><TableHead>Line</TableHead><TableHead>Title</TableHead><TableHead>Slug</TableHead><TableHead>Website</TableHead><TableHead>Result</TableHead></TableRow></TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.line}>
                    <TableCell className="tabular-nums">{r.line}</TableCell>
                    <TableCell className="max-w-xs truncate">{r.data?.title ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{r.data?.slug ?? "—"}</TableCell>
                    <TableCell>{r.data?.website ?? "—"}</TableCell>
                    <TableCell>
                      {r.errors.length ? (
                        <ul className="grid gap-0.5 text-xs text-red-700">{r.errors.map((e) => <li key={e}>{e}</li>)}</ul>
                      ) : <ToneBadge tone="success">Valid</ToneBadge>}
                      {r.warnings.map((w) => <p key={w} className="text-xs text-amber-700">{w}</p>)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
