import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/layout/auth-card";
import { configurationProblems } from "@/lib/env";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if (configurationProblems().length) redirect("/setup");
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : undefined;
  return (
    <AuthCard
      title="Sign in"
      subtitle={sp.error === "confirmation" ? "That confirmation link is invalid or expired. Sign in or request a new link." : "Welcome back."}
      footer={<>No account? <Link className="font-medium text-foreground underline-offset-4 hover:underline" href="/signup">Create one</Link></>}
    >
      <LoginForm next={next} />
    </AuthCard>
  );
}
