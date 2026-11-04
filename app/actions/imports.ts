"use server";

import { runAction } from "@/lib/actions/result";
import { requireActionContext } from "@/lib/auth/session";
import * as imports from "@/lib/services/imports";

export async function previewCsvAction(text: string) {
  return runAction("csv.preview", async () => imports.previewCsv(await requireActionContext(), String(text)));
}
export async function importCsvAction(text: string) {
  return runAction("csv.import", async () => {
    const n = await imports.importCsv(await requireActionContext(), String(text));
    return { ok: true as const, data: n, message: `Imported ${n} draft article(s). Validate and approve them before publishing.` };
  });
}
