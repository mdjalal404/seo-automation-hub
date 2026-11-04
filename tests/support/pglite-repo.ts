import type { ContentRow, JobRow, WebsiteRow } from "@/lib/database/types";
import type { JobRepository } from "@/lib/publishing/repository";
import { resolveRules } from "@/lib/seo/rules";
import { asService, type TestDb } from "../db/harness";

/** JobRepository over the real schema in PGlite, executed as service_role (like the worker). */
export function createPgliteRepo(db: TestDb): JobRepository {
  const svc = <T>(fn: (tx: TestDb) => Promise<T>) => asService(db, fn);
  const setClause = (patch: Record<string, unknown>, start: number) => {
    const keys = Object.keys(patch);
    return {
      sql: keys.map((k, i) => `${k} = $${i + start}`).join(", "),
      values: keys.map((k) => (patch[k] !== null && typeof patch[k] === "object" && !Array.isArray(patch[k]) ? JSON.stringify(patch[k]) : patch[k])),
    };
  };
  return {
    async claimNext(workerId, lease, organizationId) {
      const r = await svc((tx) => tx.query<JobRow>("select * from public.claim_next_job($1, $2, $3)", [workerId, lease, organizationId ?? null]));
      return r.rows[0] ?? null;
    },
    async reapExpiredLeases() {
      const r = await svc((tx) => tx.query<{ n: number }>("select public.reap_expired_leases() as n"));
      return r.rows[0].n;
    },
    async loadContext(job) {
      return svc(async (tx) => {
        const website = (await tx.query<WebsiteRow>("select * from websites where id = $1 and organization_id = $2", [job.website_id, job.organization_id])).rows[0];
        const content = job.content_item_id
          ? (await tx.query<ContentRow>("select * from content_items where id = $1 and organization_id = $2", [job.content_item_id, job.organization_id])).rows[0] ?? null
          : null;
        const conn = (await tx.query<{ encrypted_credentials: string }>("select encrypted_credentials from cms_connections where website_id = $1", [job.website_id])).rows[0];
        const rules = (await tx.query<{ website_id: string | null; rules_json: unknown }>(
          "select website_id, rules_json from automation_rules where organization_id = $1 and enabled and (website_id is null or website_id = $2)",
          [job.organization_id, job.website_id],
        )).rows;
        return {
          job, website, content, encryptedCredentials: conn?.encrypted_credentials ?? null,
          rules: resolveRules(rules.find((r) => !r.website_id)?.rules_json, rules.find((r) => r.website_id)?.rules_json),
        };
      });
    },
    async updateJob(job, workerId, patch) {
      const { sql, values } = setClause(patch, 4);
      const r = await svc((tx) => tx.query(`update content_jobs set ${sql} where id = $1 and organization_id = $2 and locked_by = $3`, [job.id, job.organization_id, workerId, ...values]));
      return r.affectedRows === 1;
    },
    async updateContent(content, patch) {
      const { sql, values } = setClause(patch, 3);
      const r = await svc((tx) => tx.query<ContentRow>(`update content_items set ${sql} where id = $1 and organization_id = $2 returning *`, [content.id, content.organization_id, ...values]));
      return r.rows[0];
    },
    async saveQaResults({ job, contentId, phase, results }) {
      await svc(async (tx) => {
        await tx.query("delete from qa_results where content_item_id = $1 and phase = $2", [contentId, phase]);
        for (const r of results) {
          await tx.query(
            `insert into qa_results (organization_id, website_id, content_item_id, job_id, phase, check_name, status, severity, kind, message, field, url, remediation, details)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [job.organization_id, job.website_id, contentId, job.id, phase, r.checkName, r.status, r.severity, r.kind, r.message, r.field ?? null, r.url ?? null, r.remediation ?? null, JSON.stringify(r.details ?? {})],
          );
        }
      });
    },
    async setConnectionStatus(job, status, error) {
      await svc(async (tx) => {
        await tx.query("update cms_connections set connection_status = $2, last_error = $3 where website_id = $1", [job.website_id, status, error ?? null]);
        await tx.query("update websites set connection_status = $2 where id = $1", [job.website_id, status]);
      });
    },
    async audit(job, action, metadata) {
      await svc((tx) => tx.query(
        "insert into audit_logs (organization_id, user_id, action, resource_type, resource_id, metadata) values ($1,$2,$3,'content_job',$4,$5)",
        [job.organization_id, job.created_by, action, job.id, JSON.stringify(metadata)],
      ));
    },
    siblings: {
      async findBySlug(websiteId, slug, excludeId) {
        return (await svc((tx) => tx.query<{ id: string; title: string }>("select id, title from content_items where website_id = $1 and slug = $2 and id <> $3 and status <> 'CANCELLED'", [websiteId, slug, excludeId]))).rows;
      },
      async findByTitle(websiteId, title, excludeId) {
        return (await svc((tx) => tx.query<{ id: string; slug: string }>("select id, slug from content_items where website_id = $1 and lower(title) = lower($2) and id <> $3 and status <> 'CANCELLED'", [websiteId, title, excludeId]))).rows;
      },
    },
  };
}
