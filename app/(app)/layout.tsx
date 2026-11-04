import { Activity, AlertTriangle, Workflow } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SideNav } from "@/components/layout/nav";
import { UserMenu } from "@/components/layout/user-menu";
import { WorkspaceSwitcher } from "@/components/layout/workspace-switcher";
import { requireWorkspace } from "@/lib/auth/session";
import { appEnvironment, configurationProblems } from "@/lib/env";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  if (configurationProblems().length) redirect("/setup");
  const ctx = await requireWorkspace();
  const [active, failed] = await Promise.all([
    ctx.supabase.from("content_jobs").select("id", { count: "exact", head: true }).eq("organization_id", ctx.org.id)
      .in("status", ["QUEUED", "RETRY_SCHEDULED", "VALIDATING", "PUBLISHING", "VERIFYING"]),
    ctx.supabase.from("content_jobs").select("id", { count: "exact", head: true }).eq("organization_id", ctx.org.id).eq("status", "FAILED"),
  ]);
  const env = appEnvironment();

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-5 border-r bg-sidebar p-3 md:flex">
        <Link href="/dashboard" className="flex items-center gap-2 px-1 pt-1 text-sm font-semibold">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground"><Workflow className="size-4" /></span>
          SEO Automation Hub
        </Link>
        <WorkspaceSwitcher workspaces={ctx.workspaces} currentId={ctx.org.id} />
        <SideNav />
        {env !== "production" ? (
          <p className="mt-auto rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 ring-1 ring-amber-200">
            {env} environment — development features (mock CMS servers, seed data) may be active.
          </p>
        ) : null}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-12 items-center justify-between gap-3 border-b bg-background/90 px-4 backdrop-blur">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="truncate font-medium md:hidden">{ctx.org.name}</span>
          </div>
          <div className="flex items-center gap-1">
            <Link href="/content-queue" className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted" title="Active jobs">
              <Activity className="size-3.5" /> <span className="tabular-nums">{active.count ?? 0}</span> active
            </Link>
            <Link href="/job-history?status=FAILED" className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-muted ${failed.count ? "text-red-700" : "text-muted-foreground"}`} title="Failed jobs">
              <AlertTriangle className="size-3.5" /> <span className="tabular-nums">{failed.count ?? 0}</span> failed
            </Link>
            <UserMenu email={ctx.user.email} role={ctx.role} />
          </div>
        </header>
        <div className="border-b px-2 py-1.5 md:hidden"><SideNav horizontal /></div>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}
