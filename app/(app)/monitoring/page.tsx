import { BellRing } from "lucide-react";
import Link from "next/link";
import { startTaskAction } from "@/app/actions/seo";
import { ActionButton } from "@/components/common/action-button";
import { EmptyState, PageHeader, StatCard } from "@/components/common/page-header";
import { ConnectionBadge } from "@/components/common/status-badge";
import { TaskList } from "@/components/seo/task-list";
import { WebsitePicker } from "@/components/seo/website-picker";
import { can } from "@/lib/auth/permissions";
import { requireWorkspace } from "@/lib/auth/session";
import type { ConnectionStatus } from "@/lib/database/types";
import { formatRelative } from "@/lib/format";
import { param } from "@/lib/pages";
import { listAlerts } from "@/lib/services/monitoring";
import { listAudits, listIntegrations, listTasks } from "@/lib/services/seo";
import { pickWebsite } from "@/lib/services/site-picker";
import { AlertList, IndexNowForm } from "./monitoring-forms";

export const metadata = { title: "Monitoring & alerts" };

export default async function MonitoringPage({ searchParams }: PageProps<"/monitoring">) {
  const ctx = await requireWorkspace();
  const { websites, selected } = await pickWebsite(ctx, param((await searchParams).website));
  if (!selected) return (<><PageHeader title="Monitoring & alerts" /><EmptyState icon={<BellRing className="size-6" />} title="Add a website first" action={<Link className="underline" href="/websites">Websites</Link>} /></>);
  const canManage = can(ctx.role, "integrations.manage");
  const [open, resolved, audits, integrations, indexTasks] = await Promise.all([
    listAlerts(ctx, selected.id, "open"), listAlerts(ctx, selected.id, "resolved"), listAudits(ctx, selected.id),
    canManage ? listIntegrations(ctx, selected.id) : Promise.resolve([]), listTasks(ctx, { websiteId: selected.id, type: "INDEXNOW_SUBMIT", limit: 5 }),
  ]);
  const count = (s: string) => open.filter((a) => a.severity === s).length;
  const withWhen = (list: typeof open, resolvedList = false) => list.map((a) => ({ ...a, when: formatRelative(resolvedList && a.resolved_at ? a.resolved_at : a.last_seen_at) }));
  const channel = (p: string) => integrations.find((i) => i.provider === p);
  const indexNow = channel("indexnow");

  return (
    <>
      <PageHeader
        title="Monitoring & alerts"
        description="Every audit is compared with the previous one, every Search Console sync is checked for traffic and ranking drops, and CI deploy gates report here. Alerts close themselves when a later check finds the problem fixed."
        actions={<>
          <WebsitePicker websites={websites} value={selected.id} />
          {can(ctx.role, "seo.run") ? <ActionButton size="sm" action={startTaskAction.bind(null, selected.id, "SITE_AUDIT", { maxPages: 100 })}>Run audit now</ActionButton> : null}
        </>}
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="monitoring-kpis">
        <StatCard label="Critical" value={<span className={count("critical") ? "text-destructive" : ""}>{count("critical")}</span>} hint="open alerts" />
        <StatCard label="Warnings" value={count("warning")} hint="open alerts" />
        <StatCard label="Changes" value={count("info")} hint="titles, descriptions, rankings" />
        <StatCard label="Last audit" value={audits[0] ? formatRelative(audits[0].created_at) : "—"} hint={audits.length > 1 ? `compared with ${formatRelative(audits[1].created_at)}` : "two audits needed for comparisons"} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="grid content-start gap-6">
          <section className="rounded-xl border bg-card">
            <h2 className="border-b px-4 py-3 text-sm font-semibold">Open alerts ({open.length})</h2>
            <AlertList alerts={withWhen(open)} canUpdate={can(ctx.role, "seo.run")} />
          </section>
          <section className="rounded-xl border bg-card">
            <h2 className="border-b px-4 py-3 text-sm font-semibold">Recently resolved</h2>
            <AlertList alerts={withWhen(resolved.slice(0, 20), true)} canUpdate={can(ctx.role, "seo.run")} resolved />
          </section>
        </div>
        <div className="grid content-start gap-6">
          <section className="rounded-xl border bg-card">
            <h2 className="border-b px-4 py-3 text-sm font-semibold">Notifications</h2>
            <ul className="divide-y text-sm">
              {(["slack", "webhook"] as const).map((p) => (
                <li key={p} className="flex items-center gap-2 px-4 py-2.5">
                  <span className="flex-1 font-medium">{p === "slack" ? "Slack" : "Webhook"}</span>
                  {channel(p) ? <ConnectionBadge status={channel(p)!.status as ConnectionStatus} /> : <span className="text-xs text-muted-foreground">not connected</span>}
                </li>
              ))}
            </ul>
            <p className="px-4 pb-3 text-xs text-muted-foreground">New alerts are sent once, when they open. <Link className="underline" href={`/integrations?website=${selected.id}`}>Configure channels</Link></p>
          </section>
          <section className="rounded-xl border bg-card">
            <h2 className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">IndexNow {indexNow ? <ConnectionBadge status={indexNow.status as ConnectionStatus} /> : null}</h2>
            <div className="grid gap-3 px-4 py-3">
              <p className="text-xs text-muted-foreground">{indexNow
                ? <>Submits URLs to Bing, Yandex, Seznam and Naver {indexNow.metadata.auto_submit === false ? "when you ask" : "after every verified publish and when an audit finds changed pages"}. Google does not use IndexNow.</>
                : <>Not connected. <Link className="underline" href={`/integrations?website=${selected.id}`}>Connect IndexNow</Link> to notify Bing, Yandex and other engines about new and changed pages.</>}</p>
              <IndexNowForm websiteId={selected.id} disabled={!indexNow || !can(ctx.role, "seo.run")} />
            </div>
            <TaskList tasks={indexTasks} canCancel={false} />
          </section>
          <section className="rounded-xl border bg-card px-4 py-3 text-xs text-muted-foreground">
            <p className="mb-1 font-semibold text-foreground">What is monitored</p>
            <ul className="list-disc space-y-0.5 pl-4">
              <li>Pages that broke, started redirecting or became noindex</li>
              <li>Canonical, title, description, H1, structured data and content changes</li>
              <li>New error-level audit issues; robots.txt, sitemap and AI-crawler changes</li>
              <li>Organic clicks, page clicks and rankings vs the previous 28 days</li>
              <li>Failed CI deploy gates (<Link className="underline" href="/developer">API &amp; CI/CD</Link>)</li>
            </ul>
          </section>
        </div>
      </div>
    </>
  );
}
