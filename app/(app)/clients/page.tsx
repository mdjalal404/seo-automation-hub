import { Building2 } from "lucide-react";
import Link from "next/link";
import { ClientFormDialog } from "@/components/common/client-form-dialog";
import { EmptyState, PageHeader } from "@/components/common/page-header";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can } from "@/lib/auth/permissions";
import { requireWorkspace } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { listClients } from "@/lib/services/clients";

export const metadata = { title: "Clients" };

export default async function ClientsPage() {
  const ctx = await requireWorkspace();
  const clients = await listClients(ctx);
  const canManage = can(ctx.role, "clients.manage");
  const addButton = canManage ? <ClientFormDialog trigger={<Button size="sm">Add client</Button>} /> : null;

  return (
    <>
      <PageHeader title="Clients" description="The agencies' customers whose websites you manage." actions={addButton} />
      {clients.length === 0 ? (
        <EmptyState icon={<Building2 className="size-6" />} title="No clients yet" description={canManage ? "Add your first client to start connecting websites." : "An owner or admin needs to add clients."} action={addButton} />
      ) : (
        <div className="rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow><TableHead>Client</TableHead><TableHead>Websites</TableHead><TableHead>Notes</TableHead><TableHead>Added</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {clients.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium"><Link className="hover:underline" href={`/clients/${c.id}`}>{c.name}</Link></TableCell>
                  <TableCell><Link className="hover:underline" href={`/websites?client=${c.id}`}>{c.website_count} website{c.website_count === 1 ? "" : "s"}</Link></TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">{c.notes ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDateTime(c.created_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
