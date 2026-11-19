import { Radar } from "lucide-react";
import Link from "next/link";
import { startTaskAction } from "@/app/actions/seo";
import { ActionButton } from "@/components/common/action-button";
import { EmptyState, PageHeader } from "@/components/common/page-header";
import { TaskList } from "@/components/seo/task-list";
import { WebsitePicker } from "@/components/seo/website-picker";
import { can } from "@/lib/auth/permissions";
import { requireWorkspace } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { param } from "@/lib/pages";
import { listAudits, listTasks } from "@/lib/services/seo";
import { pickWebsite } from "@/lib/services/site-picker";
import { scoreTone } from "./score";

export const metadata = { title: "Site audits" };

export default async function AuditsPage({ searchParams }: PageProps<"/audits">) {
  const ctx = await requireWorkspace();
  const { websites, selected } = await pickWebsite(ctx, param((await searchParams).website));
  if (!selected) return (<><PageHeader title="Site audits" /><EmptyState icon={<Radar className="size-6" />} title="Add a website first" action={<Link className="underline" href="/websites">Websites</Link>} /></>);
  const [audits, tasks] = await Promise.all([listAudits(ctx, selected.id), listTasks(ctx, { websiteId: selected.id, type: "SITE_AUDIT", limit: 5 })]);
  const canRun = can(ctx.role, "seo.run");
  return (
    <>
      <PageHeader
        title="Site audits"
        description="Technical crawl: status codes, redirects, titles, canonicals, indexability, structured data, internal links, sitemaps, robots.txt, llms.txt and AI crawler access."
        actions={<>
          <WebsitePicker websites={websites} value={selected.id} />
          {canRun ? <ActionButton size="sm" action={startTaskAction.bind(null, selected.id, "SITE_AUDIT", { maxPages: 100 })}>Run audit (100 pages)</ActionButton> : null}
          {canRun ? <ActionButton size="sm" variant="outline" action={startTaskAction.bind(null, selected.id, "SITE_AUDIT", { maxPages: 500 })}>Deep audit (500)</ActionButton> : null}
        </>}
      />
      <section className="mb-6 rounded-xl border bg-card">
        <h2 className="border-b px-4 py-3 text-sm font-semibold">Recent runs</h2>
        <TaskList tasks={tasks} canCancel={canRun} />
      </section>
      {audits.length ? (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground"><tr className="border-b"><th className="px-4 py-2">Date</th><th className="py-2 pr-3">Score</th><th className="py-2 pr-3">Pages</th><th className="py-2 pr-3">Errors</th><th className="py-2 pr-4" /></tr></thead>
            <tbody className="divide-y">
              {audits.map((a) => (
                <tr key={a.id}>
                  <td className="px-4 py-2">{formatDateTime(a.created_at)}</td>
                  <td className="py-2 pr-3"><span className={`font-semibold tabular-nums ${scoreTone(a.score)}`}>{a.score ?? "—"}</span>{a.site_checks?.partial ? <span className="ml-2 text-xs text-muted-foreground">partial</span> : null}</td>
                  <td className="py-2 pr-3 tabular-nums">{a.pages_crawled}</td>
                  <td className="py-2 pr-3 tabular-nums">{Object.entries(a.summary).filter(([k]) => ["http_4xx", "http_5xx", "fetch_failed", "broken_internal_link", "missing_title", "invalid_jsonld", "blocked_by_robots"].includes(k)).reduce((n, [, v]) => n + v, 0)}</td>
                  <td className="py-2 pr-4 text-right"><Link className="underline" href={`/audits/${a.id}`}>View report</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <EmptyState icon={<Radar className="size-6" />} title="No audits yet" description="Run an audit to crawl the site. Schedule weekly audits under Integrations & autopilot." />}
    </>
  );
}
