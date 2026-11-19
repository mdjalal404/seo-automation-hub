import Link from "next/link";
import { ContentEditor } from "@/components/content/content-editor";
import { QaResults } from "@/components/content/qa-results";
import { SeoSyncTable } from "@/components/content/seo-sync";
import { WorkflowPanel } from "@/components/content/workflow-panel";
import { PageHeader } from "@/components/common/page-header";
import { AiBriefCard, InternalLinksCard, ReadinessCard, SchemaCard } from "@/components/seo/article-tools";
import { AiShareBadge, ContentStatusBadge, DevTargetBadge, JobStatusBadge, ValidationBadge } from "@/components/common/status-badge";
import { can, canEditContent } from "@/lib/auth/permissions";
import { requireWorkspace } from "@/lib/auth/session";
import { isLocked } from "@/lib/content/state-machine";
import { formatDateTime } from "@/lib/format";
import { ACTIVE_JOB_STATUSES, JOB_TYPE_LABEL } from "@/lib/jobs/state-machine";
import { orNotFound } from "@/lib/pages";
import { isDevelopmentTarget } from "@/lib/security/url";
import { getContent } from "@/lib/services/content";
import { articleInsights } from "@/lib/services/seo";
import { listWebsites } from "@/lib/services/websites";

export default async function ContentPage({ params }: PageProps<"/content/[id]">) {
  const { id } = await params;
  const ctx = await requireWorkspace();
  const { item, website, qa, jobs } = await orNotFound(getContent(ctx, id));
  const [sites, insights] = await Promise.all([listWebsites(ctx), articleInsights(ctx, id)]);
  const editable = canEditContent(ctx.role, ctx.user.id, item);
  const locked = isLocked(item.status);
  const activePublish = jobs.find((j) => j.job_type === "PUBLISH" && ACTIVE_JOB_STATUSES.includes(j.status));
  const pre = qa.filter((r) => r.phase === "pre_publish");
  const post = qa.filter((r) => r.phase === "post_publish");
  const ai = pre.find((r) => r.check_name === "ai_content" && typeof r.details?.aiPercent === "number")?.details as { aiPercent: number; threshold?: number } | undefined;
  const dev = isDevelopmentTarget(website.base_url);

  return (
    <>
      <PageHeader
        title={item.title || "Untitled"}
        description={<span className="flex flex-wrap items-center gap-2"><Link className="hover:underline" href={`/websites/${website.id}`}>{website.clients?.name} — {website.name}</Link><span data-testid="content-status"><ContentStatusBadge status={item.status} /></span><span data-testid="validation-status"><ValidationBadge status={item.validation_status} /></span>{item.ai_generated ? <span className="rounded-md bg-violet-50 px-1.5 py-0.5 text-xs font-medium text-violet-700 ring-1 ring-violet-200">AI draft</span> : null}{ai ? <span data-testid="ai-badge"><AiShareBadge percent={ai.aiPercent} threshold={ai.threshold ?? 40} /></span> : null}{dev ? <DevTargetBadge /> : null}</span>}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="rounded-xl border bg-card p-5">
          <ContentEditor
            contentId={id}
            readOnly={!editable || locked}
            lockedReason={locked ? "Locked while a publishing job is active. Cancel the job to edit." : !editable ? "You can view but not edit this article." : item.approved_at ? "Editing title, body, slug, SEO fields, terms or website will withdraw the current approval." : undefined}
            websites={sites.map((s) => ({ id: s.id, name: s.name, client: s.client?.name ?? "", cmsType: s.cms_type }))}
            initial={{
              websiteId: item.website_id, title: item.title, slug: item.slug, body: item.body, bodyFormat: item.body_format, excerpt: item.excerpt,
              metaTitle: item.meta_title, metaDescription: item.meta_description, canonicalUrl: item.canonical_url, targetKeyword: item.target_keyword,
              categories: item.categories.join(", "), tags: item.tags.join(", "), featuredMediaId: item.featured_media_id ? String(item.featured_media_id) : "",
              assignedTo: item.assigned_to ?? "",
            }}
          />
        </section>
        <aside className="grid content-start gap-4">
          <div className="rounded-xl border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">Workflow</h2>
            <WorkflowPanel
              id={id} status={item.status} validationStatus={item.validation_status} connected={website.connection_status === "connected"}
              timezone={website.timezone} activePublishJobId={activePublish?.id ?? null} hasPublishedUrl={!!item.published_url}
              perms={{
                canEdit: editable, canValidate: can(ctx.role, "content.validate") && editable, canApprove: can(ctx.role, "content.approve"),
                canPublish: can(ctx.role, "content.publish"), canPushDraft: can(ctx.role, "content.push_draft") && editable,
              }}
            />
            <dl className="mt-4 grid gap-1.5 border-t pt-3 text-xs">
              <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Approved</dt><dd>{item.approved_at ? formatDateTime(item.approved_at) : "—"}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Scheduled</dt><dd>{item.scheduled_at ? formatDateTime(item.scheduled_at, website.timezone) + ` (${website.timezone})` : "—"}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted-foreground">CMS item ID</dt><dd className="min-w-0 break-all text-right">{item.external_post_id ?? "—"}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Live URL</dt><dd className="truncate">{item.published_url ? <a className="underline" href={item.published_url} target="_blank" rel="noopener noreferrer">{item.published_url}</a> : "—"}</dd></div>
            </dl>
          </div>
          {item.ai_generated && item.brief ? <AiBriefCard brief={item.brief} /> : null}
          <div className="rounded-xl border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">Pre-publish validation</h2>
            <QaResults results={pre} emptyText="Not validated yet." />
          </div>
          <div className="rounded-xl border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">Live page verification</h2>
            <QaResults results={post} emptyText="Runs automatically after publishing." />
          </div>
          <div className="rounded-xl border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">SEO metadata status</h2>
            <SeoSyncTable sync={item.seo_sync ?? {}} values={{ meta_title: item.meta_title, meta_description: item.meta_description, canonical_url: item.canonical_url }} />
          </div>
          <div className="rounded-xl border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">Jobs</h2>
            {jobs.length ? (
              <ul className="grid gap-2 text-sm">
                {jobs.map((j) => (
                  <li key={j.id} className="flex items-start justify-between gap-2">
                    <div>
                      <p>{JOB_TYPE_LABEL[j.job_type]}</p>
                      <p className="text-xs text-muted-foreground">{formatDateTime(j.created_at)} · attempt {j.attempts}/{j.max_attempts}</p>
                      {j.error_message ? <p className="text-xs text-red-700">{j.error_message}</p> : null}
                    </div>
                    <JobStatusBadge status={j.status} />
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted-foreground">No jobs yet.</p>}
          </div>
        </aside>
      </div>
      <h2 className="mb-3 mt-8 text-base font-semibold">SEO tools</h2>
      <div className="grid gap-4 lg:grid-cols-3">
        <ReadinessCard report={insights.readiness} visibility={insights.visibility} websiteId={item.website_id} keyword={item.target_keyword} canCheck={can(ctx.role, "ai.generate")} />
        <InternalLinksCard contentId={id} links={insights.links} canEdit={editable && !locked} />
        <SchemaCard contentId={id} saved={item.schema_jsonld ?? null} canEdit={editable} />
      </div>
    </>
  );
}
