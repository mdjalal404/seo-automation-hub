import "server-only";
import type { SessionContext } from "@/lib/auth/session";
import { logger } from "@/lib/observability/logger";

/** Writes an audit entry as the acting user (RLS allows only their own org and user id). */
export async function audit(ctx: SessionContext, action: string, resourceType: string, resourceId: string | null, metadata: Record<string, unknown> = {}) {
  const { error } = await ctx.supabase.from("audit_logs").insert({
    organization_id: ctx.org.id, user_id: ctx.user.id, action, resource_type: resourceType, resource_id: resourceId, metadata,
  });
  if (error) logger.error("audit.write_failed", { action, error });
}
