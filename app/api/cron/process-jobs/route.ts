import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { logger } from "@/lib/observability/logger";
import { runWorkerBatch } from "@/lib/publishing/processor";
import { createProcessorDeps } from "@/lib/publishing/worker";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Processes due jobs. Called by Vercel Cron (Authorization: Bearer $CRON_SECRET) or any
 * external scheduler. Jobs live in Postgres, so a missed invocation only delays work.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runWorkerBatch(createProcessorDeps("cron"), { maxJobs: 20, timeBudgetMs: 45_000 });
    logger.info("cron.batch_completed", result);
    return NextResponse.json(result);
  } catch (err) {
    logger.error("cron.batch_failed", { error: err });
    return NextResponse.json({ error: "batch failed" }, { status: 500 });
  }
}
