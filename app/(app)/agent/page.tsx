import { Bot } from "lucide-react";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/common/page-header";
import { ToneBadge } from "@/components/common/status-badge";
import { TaskList } from "@/components/seo/task-list";
import { WebsitePicker } from "@/components/seo/website-picker";
import { DEFAULT_GOALS, MAX_PROPOSALS } from "@/lib/agents/seo-agent";
import { llmStatus } from "@/lib/ai/llm";
import { can } from "@/lib/auth/permissions";
import { requireWorkspace } from "@/lib/auth/session";
import { formatRelative } from "@/lib/format";
import { param } from "@/lib/pages";
import { listAgentRuns, listProposals } from "@/lib/services/automation";
import { listTasks } from "@/lib/services/seo";
import { pickWebsite } from "@/lib/services/site-picker";
import { ProposalList, StartAgentForm } from "./agent-forms";

export const metadata = { title: "SEO agent" };

export default async function AgentPage({ searchParams }: PageProps<"/agent">) {
  const ctx = await requireWorkspace();
  const { websites, selected } = await pickWebsite(ctx, param((await searchParams).website));
  if (!selected) return (<><PageHeader title="SEO agent" /><EmptyState icon={<Bot className="size-6" />} title="Add a website first" action={<Link className="underline" href="/websites">Websites</Link>} /></>);
  const [runs, proposals, tasks] = await Promise.all([listAgentRuns(ctx, selected.id), listProposals(ctx, selected.id), listTasks(ctx, { websiteId: selected.id, type: "AGENT_RUN", limit: 5 })]);
  const status = llmStatus();
  return (
    <>
      <PageHeader title="SEO agent" description="Claude investigates a goal with read-only tools over your Search Console data, audits, keywords, content and live pages, then files proposals. Nothing changes until someone approves a proposal." actions={<WebsitePicker websites={websites} value={selected.id} />} />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="grid content-start gap-6">
          <section className="rounded-xl border bg-card p-5">
            <StartAgentForm websiteId={selected.id} goals={DEFAULT_GOALS} disabled={!status.configured || !can(ctx.role, "ai.generate")} />
            <p className="mt-3 text-xs text-muted-foreground" data-testid="agent-model">Model: {status.label}. Tools: site overview, Search Console performance, opportunity detection, audit issues, keywords, content list, live page inspection, propose action (max {MAX_PROPOSALS} per run, 20 steps).</p>
          </section>
          <section className="rounded-xl border bg-card">
            <h2 className="border-b px-4 py-3 text-sm font-semibold">Waiting for review ({proposals.length})</h2>
            <ProposalList proposals={proposals} canDecide={can(ctx.role, "automation.manage")} />
          </section>
        </div>
        <aside className="grid content-start gap-4">
          <section className="rounded-xl border bg-card">
            <h2 className="border-b px-4 py-3 text-sm font-semibold">Runs</h2>
            {runs.length ? (
              <ul className="divide-y text-sm">{runs.map((r) => (
                <li key={r.id} className="px-4 py-2.5">
                  <div className="flex items-center gap-2"><ToneBadge tone={r.status === "completed" ? "success" : r.status === "failed" ? "danger" : "progress"}>{r.status}</ToneBadge><span className="text-xs text-muted-foreground">{formatRelative(r.created_at)}</span></div>
                  <Link className="mt-1 line-clamp-2 underline" href={`/agent/${r.id}`}>{r.goal}</Link>
                  <p className="text-xs text-muted-foreground">{r.steps.length} tool calls{r.provider === "mock" ? " · mock" : r.model ? ` · ${r.model}` : ""}</p>
                </li>
              ))}</ul>
            ) : <p className="px-4 py-6 text-sm text-muted-foreground">No runs yet.</p>}
          </section>
          <section className="rounded-xl border bg-card">
            <h2 className="border-b px-4 py-3 text-sm font-semibold">Queue</h2>
            <TaskList tasks={tasks} canCancel={can(ctx.role, "seo.run")} />
          </section>
        </aside>
      </div>
    </>
  );
}
