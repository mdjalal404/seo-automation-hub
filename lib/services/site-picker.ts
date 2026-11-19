import "server-only";
import { unwrap } from "@/lib/actions/result";
import type { SessionContext } from "@/lib/auth/session";

/** Websites for a page's picker and the selected one (?website=, defaulting to the first). */
export async function pickWebsite(ctx: SessionContext, requested?: string) {
  const websites = (unwrap(await ctx.supabase.from("websites").select("id, name, base_url, cms_type").eq("organization_id", ctx.org.id).order("name")) ?? []) as
    { id: string; name: string; base_url: string; cms_type: string }[];
  const selected = websites.find((w) => w.id === requested) ?? websites[0] ?? null;
  return { websites, selected };
}
