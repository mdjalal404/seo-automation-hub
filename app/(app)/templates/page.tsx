import { FileStack } from "lucide-react";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/common/page-header";
import { can } from "@/lib/auth/permissions";
import { requireWorkspace } from "@/lib/auth/session";
import { listTemplates } from "@/lib/services/seo";
import { pickWebsite } from "@/lib/services/site-picker";
import { TemplateWorkbench } from "./template-workbench";

export const metadata = { title: "Page templates" };

export default async function TemplatesPage() {
  const ctx = await requireWorkspace();
  const [{ websites }, templates] = await Promise.all([pickWebsite(ctx), listTemplates(ctx)]);
  return (
    <>
      <PageHeader title="Page templates" description="Programmatic SEO: generate many pages (locations, products, comparisons) from a template and a data feed. Pages are created as drafts and validated like any other content." />
      {websites.length ? <TemplateWorkbench websites={websites} templates={templates} canEdit={can(ctx.role, "templates.manage")} />
        : <EmptyState icon={<FileStack className="size-6" />} title="Add a website first" action={<Link className="underline" href="/websites">Websites</Link>} />}
    </>
  );
}
