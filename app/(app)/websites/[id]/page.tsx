import Link from "next/link";
import { deleteConnectionAction, deleteWebsiteAction, testConnectionAction } from "@/app/actions/websites";
import { ActionButton } from "@/components/common/action-button";
import { PageHeader } from "@/components/common/page-header";
import { ConnectionBadge, DevTargetBadge, JobStatusBadge } from "@/components/common/status-badge";
import { ConnectForm } from "@/components/websites/connect-form";
import { WebsiteFormDialog } from "@/components/websites/website-form-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { can } from "@/lib/auth/permissions";
import { isCmsType, platformInfo } from "@/lib/cms/platforms";
import { requireWorkspace } from "@/lib/auth/session";
import { formatDateTime, formatRelative } from "@/lib/format";
import { JOB_TYPE_LABEL, type JobStatus } from "@/lib/jobs/state-machine";
import { orNotFound } from "@/lib/pages";
import { isDevelopmentTarget } from "@/lib/security/url";
import { listClients } from "@/lib/services/clients";
import { listJobs } from "@/lib/services/jobs";
import { getWebsite } from "@/lib/services/websites";

export default async function WebsitePage({ params }: PageProps<"/websites/[id]">) {
  const { id } = await params;
  const ctx = await requireWorkspace();
  const { website, connection } = await orNotFound(getWebsite(ctx, id));
  const [clients, jobs] = await Promise.all([listClients(ctx), listJobs(ctx, { websiteId: id, pageSize: 10 })]);
  const canManage = can(ctx.role, "websites.manage");
  const canConnect = can(ctx.role, "connections.manage");
  const meta = (connection?.metadata ?? {}) as { username?: string; site_name?: string; wp_user?: string; seo_plugins?: string[]; details?: Record<string, string>; recent_posts?: { id: string | number; title: string; status: string; link: string }[] };
  const platform = platformInfo(website.cms_type);
  const cmsType = isCmsType(website.cms_type) ? website.cms_type : "custom";
  const dev = isDevelopmentTarget(website.base_url);

  return (
    <>
      <PageHeader
        title={website.name}
        description={<span className="flex flex-wrap items-center gap-2">{platform.label} · {website.base_url} · {website.clients?.name} · {website.timezone} {dev ? <DevTargetBadge /> : null}</span>}
        actions={canManage ? (
          <>
            <WebsiteFormDialog clients={clients} trigger={<Button size="sm" variant="outline">Edit</Button>}
              website={{ id, client_id: website.client_id, name: website.name, base_url: website.base_url, cms_type: cmsType, timezone: website.timezone, max_concurrency: Number(website.publishing_settings?.max_concurrency ?? 1), connected: !!connection }} />
            <ActionButton size="sm" variant="destructive" action={deleteWebsiteAction.bind(null, id)} redirectTo="/websites"
              confirm={{ title: "Delete website?", description: "Deletes the website, its stored credentials, content and job history in this app. The CMS itself is not changed.", destructive: true, confirmLabel: "Delete" }}>
              Delete
            </ActionButton>
          </>
        ) : null}
      />

      {dev ? (
        <Alert className="mb-6">
          <AlertTitle>Development target</AlertTitle>
          <AlertDescription>This address is on a local/private network and is only reachable because development mode allows it. Publishing here is simulated against a test server, not a real client site.</AlertDescription>
        </Alert>
      ) : null}

      <section className="mb-6 rounded-xl border bg-card p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h2 className="font-semibold">{platform.label} connection</h2>
            <ConnectionBadge status={website.connection_status} />
          </div>
          {connection && canConnect ? (
            <div className="flex gap-2">
              <ActionButton size="sm" variant="outline" action={testConnectionAction.bind(null, id)}>Test connection</ActionButton>
              <ActionButton size="sm" variant="destructive" action={deleteConnectionAction.bind(null, id)}
                confirm={{ title: "Remove connection?", description: <>The encrypted credentials are deleted from this app. To fully revoke access, also {platform.revokeHint}.</>, destructive: true, confirmLabel: "Remove" }}>
                Disconnect
              </ActionButton>
            </div>
          ) : null}
        </div>
        {!canConnect ? (
          <p className="text-sm text-muted-foreground">Only owners and admins can view or manage connection details.</p>
        ) : connection ? (
          <div className="grid gap-5">
            <dl className="grid gap-3 text-sm sm:grid-cols-4">
              <div><dt className="text-muted-foreground">Site</dt><dd>{meta.site_name || "—"}</dd></div>
              <div><dt className="text-muted-foreground">Publishing as</dt><dd>{meta.wp_user ?? meta.username ?? "—"}</dd></div>
              <div><dt className="text-muted-foreground">Last tested</dt><dd>{formatRelative(connection.last_tested_at)}</dd></div>
              <div><dt className="text-muted-foreground">{cmsType === "wordpress" ? "SEO plugins detected" : "SEO support"}</dt><dd>{meta.seo_plugins?.length ? meta.seo_plugins.join(", ") : "None"}</dd></div>
            </dl>
            {connection.last_error ? <Alert variant="destructive"><AlertTitle>Last error</AlertTitle><AlertDescription>{connection.last_error}</AlertDescription></Alert> : null}
            <Alert>
              <AlertTitle>SEO metadata support</AlertTitle>
              <AlertDescription>
                {platform.seoSupport}
                {cmsType === "wordpress" ? <> ({meta.seo_plugins?.length ? "plugin detected; fields must also be registered with show_in_rest" : "no supported plugin detected"}).</> : null}
                {" "}Each article shows whether its fields were stored here, sent, confirmed by {platform.label} and verified on the live page.
              </AlertDescription>
            </Alert>
            {meta.details && Object.keys(meta.details).length ? (
              <dl className="grid gap-3 text-sm sm:grid-cols-3">
                {Object.entries(meta.details).map(([k, v]) => <div key={k}><dt className="text-muted-foreground">{k}</dt><dd className="break-all">{v}</dd></div>)}
              </dl>
            ) : null}
            {meta.recent_posts?.length ? (
              <div>
                <p className="mb-2 text-sm font-medium">Recent {platform.label} items</p>
                <ul className="divide-y rounded-lg border text-sm">
                  {meta.recent_posts.map((p) => <li key={p.id} className="flex justify-between gap-3 px-3 py-2"><span className="truncate">{p.title || "(untitled)"}</span><span className="text-muted-foreground">{p.status}</span></li>)}
                </ul>
              </div>
            ) : null}
            <details className="rounded-lg border p-4">
              <summary className="cursor-pointer text-sm font-medium">Replace credentials</summary>
              <div className="mt-4"><ConnectForm cmsType={cmsType} websiteId={id} baseUrl={website.base_url} reconnect /></div>
            </details>
          </div>
        ) : (
          <ConnectForm cmsType={cmsType} websiteId={id} baseUrl={website.base_url} />
        )}
      </section>

      <section className="rounded-xl border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Recent jobs</h2>
          <Link className="text-sm hover:underline" href={`/job-history?website=${id}`}>View all</Link>
        </div>
        {jobs.items.length ? (
          <ul className="divide-y text-sm">
            {jobs.items.map((j) => (
              <li key={j.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="min-w-0 truncate">{JOB_TYPE_LABEL[j.job_type]} · {j.content?.title ?? "—"}</span>
                <span className="flex items-center gap-3"><span className="text-xs text-muted-foreground">{formatDateTime(j.created_at)}</span><JobStatusBadge status={j.status as JobStatus} /></span>
              </li>
            ))}
          </ul>
        ) : <p className="px-4 py-6 text-sm text-muted-foreground">No jobs yet.</p>}
      </section>
    </>
  );
}
