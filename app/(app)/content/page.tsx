import { FileText } from "lucide-react";
import Link from "next/link";
import { ContentTable } from "@/components/content/content-table";
import { NativeSelect } from "@/components/common/native-select";
import { EmptyState, PageHeader } from "@/components/common/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { can } from "@/lib/auth/permissions";
import { requireWorkspace } from "@/lib/auth/session";
import { CONTENT_STATUSES, CONTENT_STATUS_LABEL } from "@/lib/content/state-machine";
import { formatDateTime } from "@/lib/format";
import { param } from "@/lib/pages";
import { listClients } from "@/lib/services/clients";
import { listContent } from "@/lib/services/content";
import { listWebsites } from "@/lib/services/websites";

export const metadata = { title: "Content" };

export default async function ContentListPage({ searchParams }: PageProps<"/content">) {
  const sp = await searchParams;
  const filters = { q: param(sp.q), status: param(sp.status), websiteId: param(sp.website), clientId: param(sp.client), page: Number(param(sp.page) ?? 1) || 1 };
  const ctx = await requireWorkspace();
  const [data, sites, clients] = await Promise.all([listContent(ctx, filters), listWebsites(ctx), listClients(ctx)]);
  const qs = (page: number) => {
    const p = new URLSearchParams(Object.entries({ ...filters, page: String(page) }).filter(([, v]) => v) as [string, string][]);
    if (filters.websiteId) { p.delete("websiteId"); p.set("website", filters.websiteId); }
    if (filters.clientId) { p.delete("clientId"); p.set("client", filters.clientId); }
    return `/content?${p}`;
  };

  return (
    <>
      <PageHeader title="Content" description={`${data.total} article${data.total === 1 ? "" : "s"}`} actions={can(ctx.role, "content.create") ? (
        <>
          <Link className={buttonVariants({ size: "sm", variant: "outline" })} href="/content/import">Import CSV</Link>
          <Link className={buttonVariants({ size: "sm" })} href="/content/new">New article</Link>
        </>
      ) : null} />
      <form className="mb-4 grid gap-2 sm:grid-cols-[1fr_180px_180px_180px_auto]" role="search">
        <Input name="q" placeholder="Search titles" defaultValue={filters.q} aria-label="Search titles" />
        <NativeSelect name="status" defaultValue={filters.status ?? ""} aria-label="Status">
          <option value="">All statuses</option>
          {CONTENT_STATUSES.map((s) => <option key={s} value={s}>{CONTENT_STATUS_LABEL[s]}</option>)}
        </NativeSelect>
        <NativeSelect name="client" defaultValue={filters.clientId ?? ""} aria-label="Client">
          <option value="">All clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </NativeSelect>
        <NativeSelect name="website" defaultValue={filters.websiteId ?? ""} aria-label="Website">
          <option value="">All websites</option>
          {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </NativeSelect>
        <Button type="submit" variant="outline">Filter</Button>
      </form>
      {data.items.length === 0 ? (
        <EmptyState icon={<FileText className="size-6" />} title="No content found" description="Create an article or import a CSV file." />
      ) : (
        <ContentTable
          canApprove={can(ctx.role, "content.approve")} canPublish={can(ctx.role, "content.publish")} canValidate={can(ctx.role, "content.validate")}
          rows={data.items.map((r) => ({
            id: r.id, title: r.title, status: r.status, validation_status: r.validation_status, published_url: r.published_url,
            client: r.website?.client?.name ?? "—", website: r.website?.name ?? "—",
            scheduled: r.scheduled_at ? `${formatDateTime(r.scheduled_at, r.website?.timezone)}` : "—",
          }))}
        />
      )}
      {data.pageCount > 1 ? (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
          <span className="text-muted-foreground">Page {data.page} of {data.pageCount}</span>
          <div className="flex gap-2">
            {data.page > 1 ? <Link className={buttonVariants({ size: "sm", variant: "outline" })} href={qs(data.page - 1)}>Previous</Link> : null}
            {data.page < data.pageCount ? <Link className={buttonVariants({ size: "sm", variant: "outline" })} href={qs(data.page + 1)}>Next</Link> : null}
          </div>
        </nav>
      ) : null}
    </>
  );
}
