import { Sparkles } from "lucide-react";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/common/page-header";
import { TaskList } from "@/components/seo/task-list";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { llmStatus } from "@/lib/ai/llm";
import { can } from "@/lib/auth/permissions";
import { requireWorkspace } from "@/lib/auth/session";
import { param } from "@/lib/pages";
import { listTasks } from "@/lib/services/seo";
import { pickWebsite } from "@/lib/services/site-picker";
import { GenerateForm } from "./generate-form";

export const metadata = { title: "AI studio" };

export default async function AiStudioPage({ searchParams }: PageProps<"/ai-studio">) {
  const sp = await searchParams;
  const ctx = await requireWorkspace();
  const { websites, selected } = await pickWebsite(ctx, param(sp.website));
  const status = llmStatus();
  const tasks = await listTasks(ctx, { type: "GENERATE_CONTENT", limit: 20 });
  const clusterId = param(sp.cluster);
  const cluster = clusterId
    ? (await ctx.supabase.from("keyword_clusters").select("id, head_keyword, name").eq("id", clusterId).eq("organization_id", ctx.org.id).maybeSingle()).data
    : null;
  const clusterKeywords = cluster
    ? ((await ctx.supabase.from("keywords").select("keyword").eq("cluster_id", cluster.id).order("search_volume", { ascending: false, nullsFirst: false }).limit(20)).data ?? []).map((k) => k.keyword).filter((k) => k !== cluster.head_keyword)
    : [];

  return (
    <>
      <PageHeader title="AI studio" description="Brief → draft → quality review pipeline. Every article is saved as a draft and goes through SEO validation and human approval before it can be published." />
      {!websites.length ? <EmptyState icon={<Sparkles className="size-6" />} title="Add a website first" action={<Link className="underline" href="/websites">Websites</Link>} /> : (
        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
          <section className="rounded-xl border bg-card p-5">
            {status.provider === "mock" ? (
              <Alert className="mb-4"><AlertTitle>Development mock</AlertTitle><AlertDescription>LLM_PROVIDER=mock returns sample text, not real AI output. Set ANTHROPIC_API_KEY for real generation.</AlertDescription></Alert>
            ) : !status.configured ? (
              <Alert className="mb-4" variant="destructive"><AlertTitle>AI is not configured</AlertTitle><AlertDescription>Set ANTHROPIC_API_KEY on the server (and on the worker) to enable generation.</AlertDescription></Alert>
            ) : null}
            <GenerateForm
              websites={websites}
              disabled={!status.configured || !can(ctx.role, "ai.generate")}
              defaults={{ websiteId: selected!.id, clusterId: cluster?.id, targetKeyword: param(sp.keyword) ?? cluster?.head_keyword, topic: cluster?.name, secondaryKeywords: clusterKeywords.join(", ") }}
            />
          </section>
          <aside className="grid content-start gap-4">
            <div className="rounded-xl border bg-card p-4 text-sm">
              <p className="font-medium">Model</p>
              <p className="mt-1 text-muted-foreground" data-testid="llm-status">{status.label}</p>
              <ol className="mt-3 list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>Brief: intent, outline, questions, entities</li>
                <li>Draft: answer-first structure, FAQ, meta tags, internal links to your published pages</li>
                <li>Review: quality scores and claims a human must verify</li>
              </ol>
              <p className="mt-3 text-xs text-muted-foreground">Generation runs in the background worker and usually takes 1–3 minutes. AI-written drafts are flagged and scored by the AI-content and AI-readiness checks.</p>
            </div>
            <section className="rounded-xl border bg-card">
              <h2 className="border-b px-4 py-3 text-sm font-semibold">Recent generations</h2>
              <TaskList tasks={tasks} canCancel={can(ctx.role, "seo.run")} />
            </section>
          </aside>
        </div>
      )}
    </>
  );
}
