import { NextResponse, type NextRequest } from "next/server";
import { requireActionContext } from "@/lib/auth/session";
import { isAppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { analyzeLogUpload } from "@/lib/services/automation";
import { uuid } from "@/lib/validation/schemas";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Upload an access log (plain or .gz, multipart field "file") for crawl-budget analysis. */
export async function POST(request: NextRequest) {
  try {
    const ctx = await requireActionContext("seo.run");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Choose a log file." }, { status: 400 });
    const id = await analyzeLogUpload(ctx, uuid.parse(form.get("websiteId")), file);
    return NextResponse.json({ id });
  } catch (err) {
    if (!isAppError(err)) logger.error("logs.upload_failed", { error: err });
    const status = isAppError(err) ? (err.code === "UNAUTHENTICATED" ? 401 : err.code === "FORBIDDEN" ? 403 : err.code === "NOT_FOUND" ? 404 : 400) : 500;
    return NextResponse.json({ error: isAppError(err) ? err.message : "The log could not be analyzed." }, { status });
  }
}
