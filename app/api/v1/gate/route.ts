import { NextResponse, type NextRequest } from "next/server";
import { authenticateApiKey, createGateFromApi } from "@/lib/services/monitoring";
import { apiError } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

/**
 * Starts an SEO deploy gate run (for CI/CD). Auth: Authorization: Bearer <API key>.
 * Body: { website_id, target_base_url?, paths?, max_urls?, fail_on?, allow_noindex? }.
 * Returns 202 with the run id; poll GET /api/v1/gate/{id} until status is COMPLETED or FAILED.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await authenticateApiKey(request.headers.get("authorization"));
    const body = await request.json().catch(() => ({}));
    const id = await createGateFromApi(principal, body);
    return NextResponse.json({ id, status: "QUEUED", status_url: new URL(`/api/v1/gate/${id}`, request.url).toString() }, { status: 202 });
  } catch (err) {
    return apiError(err);
  }
}
