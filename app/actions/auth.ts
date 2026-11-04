"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { ACTIVE_ORG_COOKIE, getCurrentUser, getWorkspaces } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import { createUserClient } from "@/lib/supabase/server";
import { signInSchema, signUpSchema, workspaceSchema } from "@/lib/validation/schemas";

function safeNext(next: unknown) {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/dashboard";
}

async function setOrgCookie(orgId: string) {
  (await cookies()).set(ACTIVE_ORG_COOKIE, orgId, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 365,
  });
}

export async function signInAction(input: { email: string; password: string; next?: string }): Promise<ActionResult> {
  const res = await runAction("auth.signIn", async () => {
    const v = signInSchema.parse(input);
    await enforceRateLimit("login-ip", await clientIp(), 30, 600);
    await enforceRateLimit("login-email", v.email, 10, 600);
    const supabase = await createUserClient();
    const { error } = await supabase.auth.signInWithPassword({ email: v.email, password: v.password });
    if (error) {
      // Same message for unknown email and wrong password (no account enumeration).
      throw new AppError("UNAUTHENTICATED", error.code === "email_not_confirmed" ? "Please confirm your email address first." : "Incorrect email or password.");
    }
  });
  if (res.ok) redirect(safeNext(input.next));
  return res;
}

export async function signUpAction(input: { email: string; password: string; fullName: string }): Promise<ActionResult<{ needsConfirmation: boolean }>> {
  const res = await runAction("auth.signUp", async () => {
    const v = signUpSchema.parse(input);
    await enforceRateLimit("signup-ip", await clientIp(), 10, 3600);
    const supabase = await createUserClient();
    const { data, error } = await supabase.auth.signUp({
      email: v.email,
      password: v.password,
      options: { data: { full_name: v.fullName }, emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/confirm` },
    });
    if (error) throw new AppError("INVALID_INPUT", error.code === "weak_password" ? "Choose a stronger password." : "Could not create the account. If you already have one, sign in instead.");
    return { needsConfirmation: !data.session };
  });
  if (res.ok && res.data && !res.data.needsConfirmation) redirect("/onboarding");
  return res;
}

export async function signOutAction() {
  const supabase = await createUserClient();
  await supabase.auth.signOut();
  (await cookies()).delete(ACTIVE_ORG_COOKIE);
  redirect("/login");
}

export async function createWorkspaceAction(input: { name: string; slug: string }): Promise<ActionResult> {
  const res = await runAction("workspace.create", async () => {
    const v = workspaceSchema.parse(input);
    const { supabase, user } = await getCurrentUser();
    if (!user) throw new AppError("UNAUTHENTICATED", "Your session has expired. Please sign in again.");
    const { data, error } = await supabase.rpc("create_organization", { p_name: v.name, p_slug: v.slug });
    if (error) {
      if (error.code === "23505") return { ok: false as const, error: "That workspace URL is taken.", fieldErrors: { slug: "Already in use." } };
      throw error;
    }
    await setOrgCookie(data as string);
  });
  if (res.ok) redirect("/dashboard");
  return res;
}

export async function switchWorkspaceAction(orgId: string): Promise<ActionResult> {
  return runAction<undefined>("workspace.switch", async () => {
    const workspaces = await getWorkspaces();
    if (!workspaces.some((w) => w.id === orgId)) throw new AppError("FORBIDDEN", "You are not a member of that workspace.");
    await setOrgCookie(orgId);
  });
}
