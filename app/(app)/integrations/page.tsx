import { Plug } from "lucide-react";
import Link from "next/link";
import { removeIntegrationAction } from "@/app/actions/seo";
import { ActionButton } from "@/components/common/action-button";
import { EmptyState, PageHeader } from "@/components/common/page-header";
import { ConnectionBadge } from "@/components/common/status-badge";
import { TaskList } from "@/components/seo/task-list";
import { WebsitePicker } from "@/components/seo/website-picker";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { llmStatus } from "@/lib/ai/llm";
import { OUTBOUND_PROVIDERS, PROVIDER_INFO, PROVIDERS, type ProviderId } from "@/lib/analytics/providers";
import { can } from "@/lib/auth/permissions";
import { requireWorkspace } from "@/lib/auth/session";
import { formatRelative } from "@/lib/format";
import type { ConnectionStatus } from "@/lib/database/types";
import { param } from "@/lib/pages";
import { listIntegrations, listSchedules, listTasks } from "@/lib/services/seo";
import { pickWebsite } from "@/lib/services/site-picker";
import { ConnectIntegrationDialog, ScheduleEditor } from "./integration-forms";

export const metadata = { title: "Integrations & autopilot" };

export default async function IntegrationsPage({ searchParams }: PageProps<"/integrations">) {
  const ctx = await requireWorkspace();
  const { websites, selected } = await pickWebsite(ctx, param((await searchParams).website));
  if (!selected) return (<><PageHeader title="Integrations & autopilot" /><EmptyState icon={<Plug className="size-6" />} title="Add a website first" action={<Link className="underline" href="/websites">Websites</Link>} /></>);
  const canManage = can(ctx.role, "integrations.manage");
  const [integrations, schedules, tasks] = await Promise.all([canManage ? listIntegrations(ctx, selected.id) : Promise.resolve([]), listSchedules(ctx, selected.id), listTasks(ctx, { websiteId: selected.id, limit: 15 })]);
  const ai = llmStatus();
  const row = (p: ProviderId) => {
    const i = integrations.find((x) => x.provider === p);
    const info = PROVIDER_INFO[p];
    return (
      <li key={p} className="flex flex-wrap items-center gap-2 px-4 py-3" data-testid={`integration-${p}`}>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{info.label}</p>
          <p className="text-xs text-muted-foreground">
            {i ? <>{Object.entries(i.metadata).filter(([k]) => ["site_url", "property_id", "service_account", "login", "domain", "endpoint_host", "key_location", "min_severity"].includes(k)).map(([k, v]) => (k === "min_severity" ? `alerts: ${v}+` : String(v))).join(" · ")}{i.last_synced_at ? ` · ${OUTBOUND_PROVIDERS.includes(p) ? "last used" : "synced"} ${formatRelative(i.last_synced_at)}` : ""}</> : info.secretLabel}
          </p>
          {i?.last_error ? <p className="text-xs text-destructive">{i.last_error}</p> : null}
        </div>
        {i ? <ConnectionBadge status={i.status as ConnectionStatus} /> : null}
        {canManage ? <ConnectIntegrationDialog websiteId={selected.id} provider={p} label={info.label} help={info.help} docs={info.docs} connected={!!i} /> : null}
        {canManage && i ? <ActionButton size="xs" variant="ghost" action={removeIntegrationAction.bind(null, selected.id, p)} confirm={{ title: `Disconnect ${info.label}?`, description: "Stored credentials are deleted. Synced data is kept.", confirmLabel: "Disconnect", destructive: true }}>Remove</ActionButton> : null}
      </li>
    );
  };

  return (
    <>
      <PageHeader title="Integrations & autopilot" description="Connect data sources and schedule recurring SEO work. Scheduled tasks run in the background worker." actions={<WebsitePicker websites={websites} value={selected.id} />} />
      {!canManage ? <Alert className="mb-6"><AlertTitle>Owners and admins manage integrations</AlertTitle><AlertDescription>You can still see schedules and task results.</AlertDescription></Alert> : null}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border bg-card">
          <h2 className="border-b px-4 py-3 text-sm font-semibold">Data sources</h2>
          <ul className="divide-y text-sm" data-testid="integrations">
            <li className="flex flex-wrap items-center gap-2 px-4 py-3">
              <div className="min-w-0 flex-1"><p className="font-medium">AI model (content, AI visibility)</p><p className="text-xs text-muted-foreground">{ai.label}. Configured with server environment variables.</p></div>
              <ConnectionBadge status={ai.configured ? "connected" : "not_connected"} />
            </li>
            {PROVIDERS.filter((p) => !OUTBOUND_PROVIDERS.includes(p)).map(row)}
          </ul>
        </section>
        <div className="grid content-start gap-6">
          <section className="rounded-xl border bg-card">
            <h2 className="border-b px-4 py-3 text-sm font-semibold">Alerts &amp; indexing</h2>
            <ul className="divide-y text-sm" data-testid="outbound-integrations">{OUTBOUND_PROVIDERS.map(row)}</ul>
            <p className="px-4 pb-3 text-xs text-muted-foreground">Alerts come from <Link className="underline" href={`/monitoring?website=${selected.id}`}>monitoring</Link>: regressions between audits, traffic anomalies after each sync, and failed deploy gates.</p>
          </section>
          <section className="rounded-xl border bg-card">
            <h2 className="border-b px-4 py-3 text-sm font-semibold">Autopilot schedules</h2>
            <ScheduleEditor websiteId={selected.id} schedules={schedules} canEdit={can(ctx.role, "automation.manage")} />
            <p className="px-4 pb-3 text-xs text-muted-foreground">Publishing stays manual: generated and template pages are drafts until someone approves them.</p>
          </section>
          <section className="rounded-xl border bg-card">
            <h2 className="border-b px-4 py-3 text-sm font-semibold">Recent tasks</h2>
            <TaskList tasks={tasks} canCancel={can(ctx.role, "seo.run")} />
          </section>
        </div>
      </div>
    </>
  );
}
