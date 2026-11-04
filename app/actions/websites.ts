"use server";

import { runAction } from "@/lib/actions/result";
import { requireActionContext } from "@/lib/auth/session";
import * as connections from "@/lib/services/connections";
import * as websites from "@/lib/services/websites";

export async function createWebsiteAction(input: unknown) {
  return runAction("website.create", async () => ({ ok: true as const, data: await websites.createWebsite(await requireActionContext(), input), message: "Website added" }));
}
export async function updateWebsiteAction(id: string, input: unknown) {
  return runAction("website.update", async () => (await websites.updateWebsite(await requireActionContext(), id, input), { ok: true as const, message: "Website saved" }));
}
export async function deleteWebsiteAction(id: string) {
  return runAction("website.delete", async () => (await websites.deleteWebsite(await requireActionContext(), id), { ok: true as const, message: "Website deleted" }));
}
export async function connectCmsAction(input: unknown) {
  return runAction("connection.create", async () => {
    const info = await connections.connectCms(await requireActionContext(), input);
    return { ok: true as const, data: { siteName: info.siteName, seoPlugins: info.seoPlugins, user: info.user.name }, message: `Connected to ${info.siteName || "the CMS"}` };
  });
}
export async function testConnectionAction(websiteId: string) {
  return runAction("connection.test", async () => {
    const info = await connections.testStoredConnection(await requireActionContext(), websiteId);
    return { ok: true as const, message: `Connection OK — ${info.user.name}` };
  });
}
export async function deleteConnectionAction(websiteId: string) {
  return runAction("connection.delete", async () => (await connections.deleteConnection(await requireActionContext(), websiteId), { ok: true as const, message: "Connection removed. Also revoke the credentials in the CMS." }));
}
