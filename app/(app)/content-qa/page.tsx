import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { queueContentQaAction } from "@/app/actions/seo";
import { ActionButton } from "@/components/common/action-button";
import { EmptyState, PageHeader, StatCard } from "@/components/common/page-header";
import { ToneBadge } from "@/components/common/status-badge";
import { TaskList } from "@/components/seo/task-list";
import { WebsitePicker } from "@/components/seo/website-picker";
import { QA_THRESHOLDS } from "@/lib/ai/content-qa";
import { llmStatus } from "@/lib/ai/llm";
import { can } from "@/lib/auth/permissions";
import { requireWorkspace } from "@/lib/auth/session";
import { param } from "@/lib/pages";
import { latestReviews } from "@/lib/services/automation";
import { listTasks } from "@/lib/services/seo";
import { pickWebsite } from "@/lib/services/site-picker";

export const metadata = { title: "Content QA" };
const TONE = { pass: "success", needs_revision: "warning", fail: "danger" } as const;

export default async function ContentQaPage({ searchParams }: PageProps<"/content-qa">) {
  const ctx = await requireWorkspace();
  const { websites, selected } = await pickWebsite(ctx, param((await searchParams).website));
  if (!selected) return (<><PageHeader title="Content QA" /><EmptyState icon={<ShieldCheck className="size-6" />} title="Add a website first" action={<Link className="underline" href="/websites">Websites</Link>} /></>);
  const [items, tasks] = await Promise.all([latestReviews(ctx, selected.id), listTasks(ctx, { websiteId: selected.id, type: "CONTENT_QA", limit: 5 })]);
  const reviewed = items.filter((i) => i.review);
  const count = (v: string) => reviewed.filter((i) => i.review!.verdict === v).length;
  return (
    <>
      <PageHeader
        title="Content QA"
        description={<>LLM rubric (helpfulness, expertise, accuracy, originality, readability, SEO) plus deterministic checks (AI-share, AI-search readiness, length). Verdicts use fixed thresholds in code — fail if any score &lt; {QA_THRESHOLDS.failBelow}, revise if the average &lt; {QA_THRESHOLDS.reviseBelow} — so results stay comparable at scale. Unchanged articles are not re-reviewed.</>}
        actions={<>
          <WebsitePicker websites={websites} value={selected.id} />
          {can(ctx.role, "ai.generate") && llmStatus().configured ? <ActionButton size="sm" action={queueContentQaAction.bind(null, selected.id)}>Review all content</ActionButton> : null}
        </>}
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="qa-kpis">
        <StatCard label="Reviewed" value={`${reviewed.length}/${items.length}`} hint={`${items.filter((i) => i.stale).length} changed since review`} />
        <StatCard label="Pass" value={count("pass")} />
        <StatCard label="Needs revision" value={count("needs_revision")} />
        <StatCard label="Fail" value={count("fail")} />
      </div>
      <section className="mt-6 rounded-xl border bg-card">
        <h2 className="border-b px-4 py-3 text-sm font-semibold">Articles</h2>
        {items.length ? (
          <ul className="divide-y text-sm" data-testid="qa-items">
            {items.map((i) => (
              <li key={i.id} className="grid gap-1 px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  {i.review ? <ToneBadge tone={TONE[i.review.verdict as keyof typeof TONE] ?? "neutral"}>{i.review.verdict.replace("_", " ")}</ToneBadge> : <ToneBadge tone="neutral">not reviewed</ToneBadge>}
                  {i.stale ? <ToneBadge tone="warning">changed since review</ToneBadge> : null}
                  <Link className="font-medium hover:underline" href={`/content/${i.id}`}>{i.title || "Untitled"}</Link>
                  {i.review?.provider === "mock" ? <span className="text-xs text-muted-foreground">mock</span> : null}
                </div>
                {i.review ? (
                  <>
                    <p className="text-xs text-muted-foreground">{Object.entries(i.review.scores).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(" · ")}</p>
                    {i.review.issues.length ? <ul className="list-disc pl-5 text-xs text-muted-foreground">{i.review.issues.slice(0, 4).map((x, n) => <li key={n}>[{x.severity}] {x.message}</li>)}</ul> : null}
                    {i.review.claims_to_verify.length ? <p className="text-xs text-amber-700">Verify: {i.review.claims_to_verify.slice(0, 3).join("; ")}</p> : null}
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        ) : <p className="px-4 py-6 text-sm text-muted-foreground">No content for this website.</p>}
      </section>
      <section className="mt-6 rounded-xl border bg-card">
        <h2 className="border-b px-4 py-3 text-sm font-semibold">Runs</h2>
        <TaskList tasks={tasks} canCancel={can(ctx.role, "seo.run")} />
      </section>
    </>
  );
}
