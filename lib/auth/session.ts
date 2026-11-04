import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { can, isRole, type Capability, type Role } from "@/lib/auth/permissions";
import { AppError } from "@/lib/errors";
import { createUserClient } from "@/lib/supabase/server";

export const ACTIVE_ORG_COOKIE = "sah_org";

export type WorkspaceSummary = { id: string; name: string; slug: string; role: Role };

export type SessionContext = {
  supabase: SupabaseClient;
  user: { id: string; email: string };
  workspaces: WorkspaceSummary[];
  org: WorkspaceSummary;
  role: Role;
};

/** Validates the session with Supabase Auth (not just the cookie) once per request. */
export const getCurrentUser = cache(async (): Promise<{ supabase: SupabaseClient; user: User | null }> => {
  const supabase = await createUserClient();
  const { data, error } = await supabase.auth.getUser();
  return { supabase, user: error ? null : data.user };
});

export const getWorkspaces = cache(async (): Promise<WorkspaceSummary[]> => {
  const { supabase, user } = await getCurrentUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from("memberships")
    .select("role, organizations!inner(id, name, slug)")
    .eq("user_id", user.id)
    .order("created_at");
  if (error) throw new AppError("INTERNAL", "Could not load workspaces.", { cause: error });
  return (data ?? []).flatMap((m) => {
    const o = m.organizations as unknown as { id: string; name: string; slug: string };
    return isRole(m.role) ? [{ id: o.id, name: o.name, slug: o.slug, role: m.role }] : [];
  });
});

/** For pages: redirects to /login or /onboarding when appropriate. */
export const requireWorkspace = cache(async (): Promise<SessionContext> => {
  const { supabase, user } = await getCurrentUser();
  if (!user) redirect("/login");
  const workspaces = await getWorkspaces();
  if (!workspaces.length) redirect("/onboarding");
  const preferred = (await cookies()).get(ACTIVE_ORG_COOKIE)?.value;
  // The cookie is only a preference; membership is re-checked on every request.
  const org = workspaces.find((w) => w.id === preferred) ?? workspaces[0];
  return { supabase, user: { id: user.id, email: user.email ?? "" }, workspaces, org, role: org.role };
});

/** For server actions: throws instead of redirecting. */
export async function requireActionContext(capability?: Capability): Promise<SessionContext> {
  const { supabase, user } = await getCurrentUser();
  if (!user) throw new AppError("UNAUTHENTICATED", "Your session has expired. Please sign in again.");
  const workspaces = await getWorkspaces();
  const preferred = (await cookies()).get(ACTIVE_ORG_COOKIE)?.value;
  const org = workspaces.find((w) => w.id === preferred) ?? workspaces[0];
  if (!org) throw new AppError("FORBIDDEN", "You are not a member of any workspace.");
  const ctx = { supabase, user: { id: user.id, email: user.email ?? "" }, workspaces, org, role: org.role };
  if (capability) assertCan(ctx, capability);
  return ctx;
}

export function assertCan(ctx: Pick<SessionContext, "role">, capability: Capability) {
  if (!can(ctx.role, capability)) {
    throw new AppError("FORBIDDEN", "Your role does not allow this action.");
  }
}
