import Link from "next/link";
import { PageHeader } from "@/components/common/page-header";
import { can } from "@/lib/auth/permissions";
import { requireWorkspace } from "@/lib/auth/session";
import { param } from "@/lib/pages";
import { listChecks } from "@/lib/seo/engine";
import { getRuleSet } from "@/lib/services/rules";
import { listWebsites } from "@/lib/services/websites";
import { cn } from "@/lib/utils";
import { RulesForm } from "./rules-form";

export const metadata = { title: "Automation rules" };

export default async function RulesPage({ searchParams }: PageProps<"/automation-rules">) {
  const websiteId = param((await searchParams).website) ?? null;
  const ctx = await requireWorkspace();
  const sites = await listWebsites(ctx);
  const site = websiteId ? sites.find((s) => s.id === websiteId) : null;
  const scopeId = site ? site.id : null;
  const { effective, siteRow } = await getRuleSet(ctx, scopeId);
  const checks = listChecks().map((c) => ({ name: c.name, label: c.label, kind: c.kind }));

  return (
    <>
      <PageHeader title="Automation rules" description="Configure SEO validation and publishing behaviour for the whole workspace, or override it for one website." />
      <div className="mb-5 flex flex-wrap gap-1.5 text-sm" role="tablist" aria-label="Scope">
        <Link role="tab" aria-selected={!scopeId} href="/automation-rules" className={cn("rounded-md px-2.5 py-1", !scopeId ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted")}>Workspace defaults</Link>
        {sites.map((s) => (
          <Link key={s.id} role="tab" aria-selected={scopeId === s.id} href={`/automation-rules?website=${s.id}`} className={cn("rounded-md px-2.5 py-1", scopeId === s.id ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted")}>{s.name}</Link>
        ))}
      </div>
      <RulesForm key={scopeId ?? "org"} websiteId={scopeId} initial={effective} checks={checks} readOnly={!can(ctx.role, "rules.manage")} overrideEnabled={siteRow?.enabled ?? !!scopeId} />
    </>
  );
}
