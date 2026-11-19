import Link from "next/link";
import { marked } from "marked";
import { PageHeader } from "@/components/common/page-header";
import { ToneBadge } from "@/components/common/status-badge";
import { can } from "@/lib/auth/permissions";
import { requireWorkspace } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { orNotFound } from "@/lib/pages";
import { sanitizeForPreview } from "@/lib/seo/html";
import { getAgentRun } from "@/lib/services/automation";
import { ProposalList } from "../agent-forms";

export const metadata = { title: "Agent run" };

export default async function AgentRunPage({ params }: PageProps<"/agent/[id]">) {
  const { id } = await params;
  const ctx = await requireWorkspace();
  const { run, proposals } = await orNotFound(getAgentRun(ctx, id));
  const report = run.report ? sanitizeForPreview(marked.parse(run.report, { async: false }) as string) : "";
  return (
    <>
      <PageHeader title="Agent run" description={<>{formatDateTime(run.created_at)} · {run.provider === "mock" ? "development mock (scripted, no model)" : run.model ?? "—"} · {run.input_tokens.toLocaleString()} in / {run.output_tokens.toLocaleString()} out tokens · <Link className="underline" href={`/agent?website=${run.website_id}`}>All runs</Link></>} />
      <section className="mb-6 rounded-xl border bg-card p-5">
        <p className="text-xs font-medium uppercase text-muted-foreground">Goal</p>
        <p className="mt-1">{run.goal}</p>
        {report ? <div className="prose-preview mt-4 border-t pt-4 text-sm" data-testid="agent-report" dangerouslySetInnerHTML={{ __html: report }} /> : <p className="mt-4 text-sm text-muted-foreground">{run.status === "running" ? "Running…" : "No report."}</p>}
      </section>
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border bg-card">
          <h2 className="border-b px-4 py-3 text-sm font-semibold">Proposals ({proposals.length})</h2>
          <ProposalList proposals={proposals} canDecide={can(ctx.role, "automation.manage")} />
        </section>
        <section className="rounded-xl border bg-card">
          <h2 className="border-b px-4 py-3 text-sm font-semibold">Tool calls ({run.steps.length})</h2>
          <ol className="divide-y text-xs" data-testid="agent-steps">
            {run.steps.map((s, i) => (
              <li key={i} className="px-4 py-2">
                <div className="flex items-center gap-2"><span className="text-muted-foreground">{i + 1}.</span><code className="font-semibold">{s.tool}</code>{s.error ? <ToneBadge tone="danger">error</ToneBadge> : null}<span className="ml-auto text-muted-foreground">{s.ms} ms</span></div>
                {Object.keys(s.input).length ? <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-muted-foreground">{JSON.stringify(s.input)}</pre> : null}
                <details className="mt-1"><summary className="cursor-pointer text-muted-foreground">Result</summary><pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all">{s.output}</pre></details>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}
