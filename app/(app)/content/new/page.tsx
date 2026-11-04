import Link from "next/link";
import { ContentEditor } from "@/components/content/content-editor";
import { EmptyState, PageHeader } from "@/components/common/page-header";
import { buttonVariants } from "@/components/ui/button";
import { can } from "@/lib/auth/permissions";
import { requireWorkspace } from "@/lib/auth/session";
import { listWebsites } from "@/lib/services/websites";

export const metadata = { title: "New article" };

export default async function NewContentPage() {
  const ctx = await requireWorkspace();
  const sites = await listWebsites(ctx);
  if (!can(ctx.role, "content.create")) return <EmptyState title="Viewers cannot create content" />;
  return (
    <>
      <PageHeader title="New article" description="Saved as a draft. Validation and approval come next." />
      {sites.length === 0 ? (
        <EmptyState title="Add a website first" description="Every article belongs to one website." action={<Link className={buttonVariants({ size: "sm" })} href="/websites">Go to websites</Link>} />
      ) : (
        <section className="rounded-xl border bg-card p-5">
          <ContentEditor websites={sites.map((s) => ({ id: s.id, name: s.name, client: s.client?.name ?? "", cmsType: s.cms_type }))} />
        </section>
      )}
    </>
  );
}
