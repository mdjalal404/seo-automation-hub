import "server-only";
import { unwrap } from "@/lib/actions/result";
import { assertCan, type SessionContext } from "@/lib/auth/session";
import type { ClientRow } from "@/lib/database/types";
import { AppError } from "@/lib/errors";
import { audit } from "@/lib/services/audit";
import { clientSchema } from "@/lib/validation/schemas";

export type ClientWithCounts = ClientRow & { website_count: number };

export async function listClients(ctx: SessionContext): Promise<ClientWithCounts[]> {
  const rows = unwrap(await ctx.supabase.from("clients").select("*, websites(count)").eq("organization_id", ctx.org.id).order("name"));
  return (rows ?? []).map((r) => ({ ...r, website_count: (r.websites as { count: number }[])[0]?.count ?? 0 }));
}

export async function getClient(ctx: SessionContext, id: string): Promise<ClientRow> {
  const row = unwrap(await ctx.supabase.from("clients").select("*").eq("id", id).eq("organization_id", ctx.org.id).maybeSingle());
  if (!row) throw new AppError("NOT_FOUND", "Client not found.");
  return row;
}

export async function createClient(ctx: SessionContext, input: unknown) {
  assertCan(ctx, "clients.manage");
  const v = clientSchema.parse(input);
  const row = unwrap(await ctx.supabase.from("clients").insert({ organization_id: ctx.org.id, name: v.name, notes: v.notes || null }).select("id").single());
  await audit(ctx, "client.created", "client", row.id, { name: v.name });
  return row.id as string;
}

export async function updateClient(ctx: SessionContext, id: string, input: unknown) {
  assertCan(ctx, "clients.manage");
  const v = clientSchema.parse(input);
  const rows = unwrap(await ctx.supabase.from("clients").update({ name: v.name, notes: v.notes || null }).eq("id", id).eq("organization_id", ctx.org.id).select("id"));
  if (!rows?.length) throw new AppError("NOT_FOUND", "Client not found.");
  await audit(ctx, "client.updated", "client", id);
}

export async function deleteClient(ctx: SessionContext, id: string) {
  assertCan(ctx, "clients.manage");
  const active = unwrap(await ctx.supabase.from("content_jobs").select("id, websites!inner(client_id)", { count: "exact", head: false })
    .eq("organization_id", ctx.org.id).eq("websites.client_id", id).in("status", ["VALIDATING", "PUBLISHING", "VERIFYING"]).limit(1));
  if (active?.length) throw new AppError("CONFLICT", "This client has jobs in progress. Wait for them to finish first.");
  const rows = unwrap(await ctx.supabase.from("clients").delete().eq("id", id).eq("organization_id", ctx.org.id).select("id"));
  if (!rows?.length) throw new AppError("NOT_FOUND", "Client not found.");
  await audit(ctx, "client.deleted", "client", id);
}
