import { platformInfo } from "@/lib/cms/platforms";
import { Globe } from "lucide-react";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/common/page-header";
import { ConnectionBadge, DevTargetBadge } from "@/components/common/status-badge";
import { WebsiteFormDialog } from "@/components/websites/website-form-dialog";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can } from "@/lib/auth/permissions";
import { requireWorkspace } from "@/lib/auth/session";
import { formatRelative } from "@/lib/format";
import { param } from "@/lib/pages";
import { isDevelopmentTarget } from "@/lib/security/url";
import { listClients } from "@/lib/services/clients";
import { listWebsites } from "@/lib/services/websites";

export const metadata = { title: "Websites" };

export default async function WebsitesPage({ searchParams }: PageProps<"/websites">) {
  const sp = await searchParams;
  const clientId = param(sp.client);
  const ctx = await requireWorkspace();
  const [sites, clients] = await Promise.all([listWebsites(ctx, { clientId }), listClients(ctx)]);
  const canManage = can(ctx.role, "websites.manage");
  const add = canManage ? (
    <WebsiteFormDialog clients={clients} defaultClientId={clientId} defaultOpen={sp.new === "1"} trigger={<Button size="sm">Add website</Button>} />
  ) : null;

  return (
    <>
      <PageHeader
        title="Websites"
        description={clientId ? <>Filtered to one client. <Link className="underline" href="/websites">Show all</Link></> : "Client websites and their CMS connections."}
        actions={add}
      />
      {sites.length === 0 ? (
        <EmptyState icon={<Globe className="size-6" />} title="No websites yet" description="Add a website, then connect its WordPress, Webflow, Shopify or custom CMS." action={add} />
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Website</TableHead><TableHead>Client</TableHead><TableHead>CMS</TableHead><TableHead>Connection</TableHead>
                <TableHead>Last test</TableHead><TableHead className="text-right">Pending jobs</TableHead><TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sites.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <Link className="font-medium hover:underline" href={`/websites/${s.id}`}>{s.name}</Link>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">{s.base_url} {isDevelopmentTarget(s.base_url) ? <DevTargetBadge /> : null}</div>
                  </TableCell>
                  <TableCell>{s.client ? <Link className="hover:underline" href={`/clients/${s.client.id}`}>{s.client.name}</Link> : "—"}</TableCell>
                  <TableCell>{platformInfo(s.cms_type).label}</TableCell>
                  <TableCell><ConnectionBadge status={s.connection_status} /></TableCell>
                  <TableCell className="text-muted-foreground">{formatRelative(s.connection?.last_tested_at)}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.pending_jobs}</TableCell>
                  <TableCell className="text-right"><Link className="text-sm font-medium hover:underline" href={`/websites/${s.id}`}>{s.connection_status === "connected" ? "Manage" : "Connect"}</Link></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
