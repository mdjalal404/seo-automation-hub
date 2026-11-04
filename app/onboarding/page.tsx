import { redirect } from "next/navigation";
import { AuthCard } from "@/components/layout/auth-card";
import { getCurrentUser, getWorkspaces } from "@/lib/auth/session";
import { WorkspaceForm } from "./workspace-form";

export const metadata = { title: "Create workspace" };

export default async function OnboardingPage() {
  const { user } = await getCurrentUser();
  if (!user) redirect("/login");
  if ((await getWorkspaces()).length) redirect("/dashboard");
  return (
    <AuthCard title="Create your agency workspace" subtitle="Clients, websites and content live inside a workspace. You'll be its owner.">
      <WorkspaceForm />
    </AuthCard>
  );
}
