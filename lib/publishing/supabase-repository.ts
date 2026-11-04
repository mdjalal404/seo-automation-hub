import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConnectionStatus, ContentRow, JobRow, WebsiteRow } from "@/lib/database/types";
import { AppError } from "@/lib/errors";
import type { ContentPatch, JobContext, JobPatch, JobRepository } from "@/lib/publishing/repository";
import { resolveRules } from "@/lib/seo/rules";
import type { CheckPhase, CheckResult, SiblingLookup } from "@/lib/seo/types";

function check<T>(res: { data: T; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) throw new AppError("INTERNAL", `Database error while ${what}.`, { retryable: true, cause: res.error });
  return res.data;
}

export function supabaseSiblingLookup(db: SupabaseClient, organizationId?: string): SiblingLookup {
  return {
    async findBySlug(websiteId, slug, excludeId) {
      let q = db.from("content_items").select("id, title").eq("website_id", websiteId).eq("slug", slug).neq("id", excludeId).neq("status", "CANCELLED").limit(5);
      if (organizationId) q = q.eq("organization_id", organizationId);
      return check(await q, "checking duplicate slugs") ?? [];
    },
    async findByTitle(websiteId, title, excludeId) {
      let q = db.from("content_items").select("id, slug").eq("website_id", websiteId).ilike("title", title.replace(/[%_\\]/g, "\\$&")).neq("id", excludeId).neq("status", "CANCELLED").limit(5);
      if (organizationId) q = q.eq("organization_id", organizationId);
      return check(await q, "checking duplicate titles") ?? [];
    },
  };
}

/** Service-role repository. Every query is filtered by the job's organization_id. */
export function createSupabaseJobRepository(db: SupabaseClient): JobRepository {
  return {
    async claimNext(workerId, leaseSeconds, organizationId) {
      const rows = check(await db.rpc("claim_next_job", { p_worker: workerId, p_lease_seconds: leaseSeconds, p_org: organizationId ?? null }), "claiming a job") as JobRow[] | null;
      return rows?.[0] ?? null;
    },
    async reapExpiredLeases() {
      return (check(await db.rpc("reap_expired_leases"), "reaping leases") as number | null) ?? 0;
    },
    async loadContext(job): Promise<JobContext> {
      const org = job.organization_id;
      const website = check(await db.from("websites").select("*").eq("id", job.website_id).eq("organization_id", org).single(), "loading website") as WebsiteRow;
      const content = job.content_item_id
        ? (check(await db.from("content_items").select("*").eq("id", job.content_item_id).eq("organization_id", org).maybeSingle(), "loading content") as ContentRow | null)
        : null;
      const conn = check(
        await db.from("cms_connections").select("encrypted_credentials").eq("website_id", job.website_id).eq("organization_id", org).maybeSingle(),
        "loading connection",
      ) as { encrypted_credentials: string } | null;
      const rules = check(
        await db.from("automation_rules").select("website_id, rules_json").eq("organization_id", org).eq("enabled", true).or(`website_id.is.null,website_id.eq.${job.website_id}`),
        "loading rules",
      ) as { website_id: string | null; rules_json: unknown }[];
      const orgRules = rules.find((r) => r.website_id === null)?.rules_json;
      const siteRules = rules.find((r) => r.website_id === job.website_id)?.rules_json;
      return { job, website, content, encryptedCredentials: conn?.encrypted_credentials ?? null, rules: resolveRules(orgRules, siteRules) };
    },
    async updateJob(job, workerId, patch: JobPatch) {
      const res = await db.from("content_jobs").update(patch).eq("id", job.id).eq("organization_id", job.organization_id).eq("locked_by", workerId).select("id");
      return (check(res, "updating job") ?? []).length === 1;
    },
    async updateContent(content, patch: ContentPatch) {
      const res = await db.from("content_items").update(patch).eq("id", content.id).eq("organization_id", content.organization_id).select("*").single();
      if (res.error) {
        throw new AppError("CONFLICT", res.error.code === "23514" ? res.error.message : "Could not update content state.", { cause: res.error });
      }
      return res.data as ContentRow;
    },
    async saveQaResults({ job, contentId, phase, results }: { job: JobRow; contentId: string; phase: CheckPhase; results: CheckResult[] }) {
      check(await db.from("qa_results").delete().eq("content_item_id", contentId).eq("organization_id", job.organization_id).eq("phase", phase), "clearing results");
      if (!results.length) return;
      check(await db.from("qa_results").insert(results.map((r) => ({
        organization_id: job.organization_id, website_id: job.website_id, content_item_id: contentId, job_id: job.id, phase,
        check_name: r.checkName, status: r.status, severity: r.severity, kind: r.kind, message: r.message.slice(0, 2000),
        field: r.field ?? null, url: r.url?.slice(0, 2048) ?? null, remediation: r.remediation ?? null, details: r.details ?? {},
      }))), "saving results");
    },
    async setConnectionStatus(job, status: ConnectionStatus, error) {
      const now = new Date().toISOString();
      check(await db.from("cms_connections").update({ connection_status: status, last_error: error ?? null, last_tested_at: now }).eq("website_id", job.website_id).eq("organization_id", job.organization_id), "updating connection");
      check(await db.from("websites").update({ connection_status: status }).eq("id", job.website_id).eq("organization_id", job.organization_id), "updating website");
    },
    async audit(job, action, metadata) {
      await db.from("audit_logs").insert({
        organization_id: job.organization_id, user_id: job.created_by, action, resource_type: "content_job", resource_id: job.id, metadata,
      });
    },
    siblings: supabaseSiblingLookup(db),
  };
}
