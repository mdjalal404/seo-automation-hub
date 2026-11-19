import { NextResponse, type NextRequest } from "next/server";
import { requireActionContext } from "@/lib/auth/session";
import { isAppError } from "@/lib/errors";
import { searchCsv } from "@/lib/services/analytics";
import { getWebsite } from "@/lib/services/websites";
import { uuid } from "@/lib/validation/schemas";

export const dynamic = "force-dynamic";

/** CSV export of Search Console rows for the signed-in user's workspace (RLS-scoped). */
export async function GET(request: NextRequest) {
  try {
    const ctx = await requireActionContext("reports.view");
    const websiteId = uuid.parse(request.nextUrl.searchParams.get("website"));
    const days = Math.min(480, Math.max(1, Number(request.nextUrl.searchParams.get("days") ?? 90) || 90));
    const { website } = await getWebsite(ctx, websiteId);
    const csv = await searchCsv(ctx, websiteId, days);
    const name = website.name.replace(/[^\w-]+/g, "-").slice(0, 60) || "website";
    return new NextResponse(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}-search-${days}d.csv"`, "cache-control": "no-store" } });
  } catch (err) {
    const status = isAppError(err) ? (err.code === "UNAUTHENTICATED" ? 401 : err.code === "FORBIDDEN" ? 403 : err.code === "NOT_FOUND" ? 404 : 400) : 400;
    return NextResponse.json({ error: isAppError(err) ? err.message : "Invalid request" }, { status });
  }
}
