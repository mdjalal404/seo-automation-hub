import { NextResponse, type NextRequest } from "next/server";
import { AUDIT_EXPORT_FORMATS, auditIssuesCsv, auditJson, auditPagesCsv, type AuditExportFormat } from "@/lib/audit/export";
import { auditPdf } from "@/lib/audit/pdf";
import { requireActionContext } from "@/lib/auth/session";
import { isAppError } from "@/lib/errors";
import { getAudit } from "@/lib/services/seo";
import { getWebsite } from "@/lib/services/websites";

export const dynamic = "force-dynamic";

/** Downloads a site audit (RLS-scoped to the signed-in user's workspace): ?format=pdf|pages|issues|json. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/audits/[id]/export">) {
  try {
    const session = await requireActionContext("reports.view");
    const requested = request.nextUrl.searchParams.get("format") ?? "pages";
    const format: AuditExportFormat = (AUDIT_EXPORT_FORMATS as readonly string[]).includes(requested) ? (requested as AuditExportFormat) : "pages";
    const { audit, pages } = await getAudit(session, (await ctx.params).id);
    const { website } = await getWebsite(session, audit.website_id);
    const base = `${website.name.replace(/[^\w-]+/g, "-").slice(0, 60) || "website"}-audit-${audit.created_at.slice(0, 10)}`;
    const headers = (type: string, ext: string) => ({ "content-type": type, "content-disposition": `attachment; filename="${base}${format === "issues" ? "-issues" : ""}.${ext}"`, "cache-control": "no-store" });
    if (format === "pdf") return new NextResponse(new Uint8Array(await auditPdf(audit, website, pages)), { headers: headers("application/pdf", "pdf") });
    if (format === "json") return new NextResponse(JSON.stringify(auditJson(audit, website, pages), null, 2), { headers: headers("application/json; charset=utf-8", "json") });
    const csv = format === "issues" ? auditIssuesCsv(pages) : auditPagesCsv(pages);
    // BOM so Excel opens UTF-8 (accented titles, en dashes) correctly.
    return new NextResponse(`﻿${csv}`, { headers: headers("text/csv; charset=utf-8", "csv") });
  } catch (err) {
    const status = isAppError(err) ? (err.code === "UNAUTHENTICATED" ? 401 : err.code === "FORBIDDEN" ? 403 : err.code === "NOT_FOUND" ? 404 : 400) : 400;
    return NextResponse.json({ error: isAppError(err) ? err.message : "Invalid request" }, { status });
  }
}
