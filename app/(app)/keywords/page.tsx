import { KeyRound } from "lucide-react";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/common/page-header";
import { WebsitePicker } from "@/components/seo/website-picker";
import { can } from "@/lib/auth/permissions";
import { requireWorkspace } from "@/lib/auth/session";
import { param } from "@/lib/pages";
import { listKeywords } from "@/lib/services/seo";
import { pickWebsite } from "@/lib/services/site-picker";
import { KeywordsManager } from "./keywords-manager";

export const metadata = { title: "Keywords" };

export default async function KeywordsPage({ searchParams }: PageProps<"/keywords">) {
  const ctx = await requireWorkspace();
  const { websites, selected } = await pickWebsite(ctx, param((await searchParams).website));
  if (!selected) return (<><PageHeader title="Keywords" /><EmptyState icon={<KeyRound className="size-6" />} title="Add a website first" action={<Link className="underline" href="/websites">Websites</Link>} /></>);
  const { keywords, clusters } = await listKeywords(ctx, selected.id);
  return (
    <>
      <PageHeader title="Keywords" description="Research, cluster and track keywords; turn clusters into AI-drafted articles." actions={<WebsitePicker websites={websites} value={selected.id} />} />
      <KeywordsManager websiteId={selected.id} keywords={keywords} clusters={clusters} canEdit={can(ctx.role, "keywords.manage")} canRun={can(ctx.role, "seo.run")} />
    </>
  );
}
