import { NextResponse, type NextRequest } from "next/server";
import { authenticateApiKey, getGateFromApi } from "@/lib/services/monitoring";
import { apiError } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

/** Status and result of a deploy gate run. `passed` is set once status is COMPLETED. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/v1/gate/[id]">) {
  try {
    const principal = await authenticateApiKey(request.headers.get("authorization"));
    const run = await getGateFromApi(principal, (await ctx.params).id);
    const r = run.result;
    return NextResponse.json({
      id: run.id, status: run.status, progress: run.progress, error: run.error_message,
      passed: run.status === "COMPLETED" ? !!r.passed : null,
      target: r.target ?? null, checked: r.checked ?? null, errors: r.errors ?? null, warnings: r.warnings ?? null, fail_on: r.failOn ?? null,
      baseline_audit_id: r.baselineAuditId ?? null, checks: r.checks ?? [], created_at: run.created_at, completed_at: run.completed_at,
    }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return apiError(err);
  }
}
