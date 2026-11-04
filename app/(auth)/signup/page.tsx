import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/layout/auth-card";
import { configurationProblems } from "@/lib/env";
import { SignupForm } from "./signup-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Create account" };

export default function SignupPage() {
  if (configurationProblems().length) redirect("/setup");
  return (
    <AuthCard
      title="Create your account"
      subtitle="You'll set up your agency workspace next."
      footer={<>Already have an account? <Link className="font-medium text-foreground underline-offset-4 hover:underline" href="/login">Sign in</Link></>}
    >
      <SignupForm />
    </AuthCard>
  );
}
