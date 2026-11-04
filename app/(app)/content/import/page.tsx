import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/page-header";
import { can } from "@/lib/auth/permissions";
import { requireWorkspace } from "@/lib/auth/session";
import { CsvImport } from "./csv-import";

export const metadata = { title: "Import CSV" };

export default async function ImportPage() {
  const ctx = await requireWorkspace();
  if (!can(ctx.role, "content.create")) return <EmptyState title="Viewers cannot import content" />;
  return (
    <>
      <PageHeader title="Import articles from CSV" description="Every row is validated before anything is saved. Imported articles start as drafts and are never published automatically." />
      <CsvImport />
    </>
  );
}
