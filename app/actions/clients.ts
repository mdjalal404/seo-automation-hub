"use server";

import { runAction } from "@/lib/actions/result";
import { requireActionContext } from "@/lib/auth/session";
import * as clients from "@/lib/services/clients";

export async function createClientAction(input: { name: string; notes?: string }) {
  return runAction("client.create", async () => ({ ok: true as const, data: await clients.createClient(await requireActionContext(), input), message: "Client created" }));
}
export async function updateClientAction(id: string, input: { name: string; notes?: string }) {
  return runAction("client.update", async () => (await clients.updateClient(await requireActionContext(), id, input), { ok: true as const, message: "Client saved" }));
}
export async function deleteClientAction(id: string) {
  return runAction("client.delete", async () => (await clients.deleteClient(await requireActionContext(), id), { ok: true as const, message: "Client deleted" }));
}
