import { NextResponse } from "next/server";
import { configurationProblems } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Liveness/config probe. Reports only whether configuration is complete — never values. */
export async function GET() {
  const problems = configurationProblems().length;
  return NextResponse.json({ ok: problems === 0, configurationProblems: problems }, { status: problems ? 503 : 200 });
}
