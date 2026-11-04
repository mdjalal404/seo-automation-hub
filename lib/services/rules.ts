import "server-only";
import { unwrap } from "@/lib/actions/result";
import { assertCan, type SessionContext } from "@/lib/auth/session";
import type { AutomationRuleRow } from "@/lib/database/types";
import { AppError } from "@/lib/errors";
import { resolveRules, rulesSchema, type ResolvedRules } from "@/lib/seo/rules";
import { audit } from "@/lib/services/audit";

export async function getRuleSet(ctx: SessionContext, websiteId: string | null) {
  const rows = (unwrap(await ctx.supabase.from("automation_rules").select("*").eq("organization_id", ctx.org.id)) ?? []) as AutomationRuleRow[];
  const orgRow = rows.find((r) => r.website_id === null) ?? null;
  const siteRow = websiteId ? rows.find((r) => r.website_id === websiteId) ?? null : null;
  const effective: ResolvedRules = websiteId
    ? resolveRules(orgRow?.enabled ? orgRow.rules_json : {}, siteRow?.enabled ? siteRow.rules_json : {})
    : resolveRules(orgRow?.rules_json);
  const inherited: ResolvedRules = websiteId ? resolveRules(orgRow?.enabled ? orgRow.rules_json : {}) : resolveRules();
  return { orgRow, siteRow, effective, inherited };
}

export async function saveRuleSet(ctx: SessionContext, websiteId: string | null, raw: unknown, enabled = true) {
  assertCan(ctx, "rules.manage");
  const parsed = rulesSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("INVALID_INPUT", "The rule configuration is invalid.");
  for (const [name, r] of Object.entries(parsed.data.checks ?? {})) {
    const min = (r as { min?: number }).min, max = (r as { max?: number }).max;
    if (min !== undefined && max !== undefined && min > max) throw new AppError("INVALID_INPUT", `${name}: minimum cannot exceed maximum.`);
  }
  let q = ctx.supabase.from("automation_rules").select("id").eq("organization_id", ctx.org.id);
  q = websiteId ? q.eq("website_id", websiteId) : q.is("website_id", null);
  const existing = unwrap(await q.maybeSingle());
  if (existing) {
    unwrap(await ctx.supabase.from("automation_rules").update({ rules_json: parsed.data, enabled }).eq("id", existing.id));
  } else {
    unwrap(await ctx.supabase.from("automation_rules").insert({
      organization_id: ctx.org.id, website_id: websiteId, name: websiteId ? "Website override" : "Workspace defaults", rules_json: parsed.data, enabled,
    }));
  }
  await audit(ctx, "rules.updated", "automation_rules", websiteId ?? ctx.org.id, { scope: websiteId ? "website" : "workspace" });
}
