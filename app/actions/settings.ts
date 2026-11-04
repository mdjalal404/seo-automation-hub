"use server";

import { runAction } from "@/lib/actions/result";
import type { Role } from "@/lib/auth/permissions";
import { requireActionContext } from "@/lib/auth/session";
import * as rules from "@/lib/services/rules";
import * as workspace from "@/lib/services/workspace";

export async function saveRulesAction(websiteId: string | null, rulesJson: unknown, enabled: boolean) {
  return runAction("rules.save", async () => (await rules.saveRuleSet(await requireActionContext(), websiteId, rulesJson, enabled), { ok: true as const, message: "Rules saved" }));
}
export async function updateWorkspaceAction(input: unknown) {
  return runAction("workspace.update", async () => (await workspace.updateWorkspaceSettings(await requireActionContext(), input), { ok: true as const, message: "Workspace settings saved" }));
}
export async function addMemberAction(input: unknown) {
  return runAction("member.add", async () => (await workspace.addMember(await requireActionContext(), input), { ok: true as const, message: "Member added" }));
}
export async function setMemberRoleAction(id: string, role: Role) {
  return runAction("member.role", async () => (await workspace.setMemberRole(await requireActionContext(), id, role), { ok: true as const, message: "Role updated" }));
}
export async function removeMemberAction(id: string) {
  return runAction("member.remove", async () => (await workspace.removeMember(await requireActionContext(), id), { ok: true as const, message: "Member removed" }));
}
export async function updateProfileAction(input: { fullName: string }) {
  return runAction("profile.update", async () => {
    const ctx = await requireActionContext();
    const name = String(input.fullName ?? "").trim().slice(0, 120);
    const { error } = await ctx.supabase.from("profiles").update({ full_name: name }).eq("id", ctx.user.id);
    if (error) throw error;
    return { ok: true as const, message: "Profile saved" };
  });
}
