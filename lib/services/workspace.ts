import "server-only";
import { unwrap } from "@/lib/actions/result";
import { assertCan, type SessionContext } from "@/lib/auth/session";
import type { Role } from "@/lib/auth/permissions";
import { audit } from "@/lib/services/audit";
import { memberSchema, workspaceSettingsSchema } from "@/lib/validation/schemas";

export type MemberItem = { id: string; user_id: string; role: Role; email: string; full_name: string | null; created_at: string };

export async function listMembers(ctx: SessionContext): Promise<MemberItem[]> {
  const members = unwrap(await ctx.supabase.from("memberships").select("id, user_id, role, created_at").eq("organization_id", ctx.org.id).order("created_at")) ?? [];
  const profiles = unwrap(await ctx.supabase.from("profiles").select("id, email, full_name").in("id", members.map((m) => m.user_id))) ?? [];
  return members.map((m) => {
    const p = profiles.find((x) => x.id === m.user_id);
    return { ...m, role: m.role as Role, email: p?.email ?? "", full_name: p?.full_name ?? null };
  });
}

export async function getWorkspaceSettings(ctx: SessionContext) {
  const org = unwrap(await ctx.supabase.from("organizations").select("id, name, slug, settings").eq("id", ctx.org.id).single());
  const s = (org.settings ?? {}) as Record<string, unknown>;
  return {
    name: org.name as string, slug: org.slug as string,
    minutesSavedPerPublish: Number(s.minutes_saved_per_publish ?? 20),
    minutesSavedPerValidation: Number(s.minutes_saved_per_validation ?? 5),
  };
}

export async function updateWorkspaceSettings(ctx: SessionContext, input: unknown) {
  assertCan(ctx, "workspace.manage");
  const v = workspaceSettingsSchema.parse(input);
  const current = unwrap(await ctx.supabase.from("organizations").select("settings").eq("id", ctx.org.id).single());
  unwrap(await ctx.supabase.from("organizations").update({
    name: v.name,
    settings: { ...(current.settings ?? {}), minutes_saved_per_publish: v.minutesSavedPerPublish, minutes_saved_per_validation: v.minutesSavedPerValidation },
  }).eq("id", ctx.org.id));
  await audit(ctx, "workspace.updated", "organization", ctx.org.id);
}

export async function addMember(ctx: SessionContext, input: unknown) {
  assertCan(ctx, "members.manage");
  const v = memberSchema.parse(input);
  unwrap(await ctx.supabase.rpc("add_member_by_email", { p_org: ctx.org.id, p_email: v.email, p_role: v.role }));
}

export async function setMemberRole(ctx: SessionContext, membershipId: string, role: Role) {
  assertCan(ctx, "members.manage");
  unwrap(await ctx.supabase.rpc("set_member_role", { p_membership: membershipId, p_role: role }));
}

export async function removeMember(ctx: SessionContext, membershipId: string) {
  assertCan(ctx, "members.manage");
  unwrap(await ctx.supabase.rpc("remove_member", { p_membership: membershipId }));
}
