import Link from "next/link";
import { PageHeader } from "@/components/common/page-header";
import { ConnectionBadge } from "@/components/common/status-badge";
import { can } from "@/lib/auth/permissions";
import { requireWorkspace } from "@/lib/auth/session";
import { formatRelative } from "@/lib/format";
import { listWebsites } from "@/lib/services/websites";
import { getWorkspaceSettings, listMembers } from "@/lib/services/workspace";
import { MembersManager, ProfileForm, WorkspaceForm } from "./settings-forms";

export const metadata = { title: "Settings" };

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="font-semibold">{title}</h2>
      {description ? <p className="mb-4 mt-1 text-sm text-muted-foreground">{description}</p> : <div className="mb-4" />}
      {children}
    </section>
  );
}

export default async function SettingsPage() {
  const ctx = await requireWorkspace();
  const [ws, members, sites, profile] = await Promise.all([
    getWorkspaceSettings(ctx), listMembers(ctx), listWebsites(ctx),
    ctx.supabase.from("profiles").select("full_name").eq("id", ctx.user.id).maybeSingle(),
  ]);
  const lastWorker = await ctx.supabase.from("content_jobs").select("completed_at").eq("organization_id", ctx.org.id).not("completed_at", "is", null).order("completed_at", { ascending: false }).limit(1).maybeSingle();

  return (
    <>
      <PageHeader title="Settings" description={`Workspace: ${ws.name} · your role: ${ctx.role}`} />
      <div className="grid gap-6">
        <Section title="Workspace" description="Name and reporting assumptions."><WorkspaceForm initial={ws} readOnly={!can(ctx.role, "workspace.manage")} /></Section>
        <Section title="Members" description="Owners manage members. Admins manage clients, sites and publishing; members edit their own content; viewers are read-only.">
          <MembersManager members={members} canManage={can(ctx.role, "members.manage")} currentUserId={ctx.user.id} />
        </Section>
        <Section title="Your account"><ProfileForm fullName={profile.data?.full_name ?? ""} email={ctx.user.email} /></Section>
        <Section title="Integrations" description="Supported: WordPress (REST API + application passwords), Webflow (Data API v2 token), Shopify (GraphQL Admin API token) and any CMS implementing the Custom CMS API v1 contract (docs/CUSTOM_CMS.md).">
          <ul className="divide-y rounded-lg border text-sm">
            {sites.length ? sites.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 px-3 py-2">
                <Link className="hover:underline" href={`/websites/${s.id}`}>{s.name} <span className="text-muted-foreground">({s.base_url})</span></Link>
                <span className="flex items-center gap-3 text-xs text-muted-foreground">tested {formatRelative(s.connection?.last_tested_at)} <ConnectionBadge status={s.connection_status} /></span>
              </li>
            )) : <li className="px-3 py-2 text-muted-foreground">No websites yet.</li>}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">Last job completed by the background worker: {formatRelative(lastWorker.data?.completed_at)}. If jobs stay queued, make sure the worker or cron route is running (see README).</p>
        </Section>
      </div>
    </>
  );
}
