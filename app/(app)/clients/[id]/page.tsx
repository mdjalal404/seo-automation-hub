import Link from "next/link";
import { deleteClientAction } from "@/app/actions/clients";
import { ActionButton } from "@/components/common/action-button";
import { ClientFormDialog } from "@/components/common/client-form-dialog";
import { EmptyState, PageHeader } from "@/components/common/page-header";
import { ConnectionBadge } from "@/components/common/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { can } from "@/lib/auth/permissions";
import { requireWorkspace } from "@/lib/auth/session";
import { orNotFound } from "@/lib/pages";
import { getClient } from "@/lib/services/clients";
import { listWebsites } from "@/lib/services/websites";

export default async function ClientPage({ params }: PageProps<"/clients/[id]">) {
  const { id } = await params;
  const ctx = await requireWorkspace();
  const client = await orNotFound(getClient(ctx, id));
  const sites = await listWebsites(ctx, { clientId: id });
  const canManage = can(ctx.role, "clients.manage");

  return (
    <>
      <PageHeader
        title={client.name}
        description={client.notes ?? undefined}
        actions={canManage ? (
          <>
            <Link href={`/websites?client=${id}&new=1`} className={buttonVariants({ size: "sm" })}>Add website</Link>
            <ClientFormDialog client={client} trigger={<Button size="sm" variant="outline">Edit</Button>} />
            <ActionButton size="sm" variant="destructive" action={deleteClientAction.bind(null, id)} redirectTo="/clients"
              confirm={{ title: "Delete client?", description: "This deletes the client, its websites, their stored connections, content and job history in this app. WordPress is not changed.", destructive: true, confirmLabel: "Delete" }}>
              Delete
            </ActionButton>
          </>
        ) : null}
      />
      <h2 className="mb-3 text-sm font-semibold">Websites</h2>
      {sites.length === 0 ? (
        <EmptyState title="No websites for this client" description="Add a website and connect its CMS." />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {sites.map((s) => (
            <li key={s.id} className="rounded-xl border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link href={`/websites/${s.id}`} className="font-medium hover:underline">{s.name}</Link>
                  <p className="truncate text-xs text-muted-foreground">{s.base_url}</p>
                </div>
                <ConnectionBadge status={s.connection_status} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
