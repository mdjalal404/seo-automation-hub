import type { ContentRow, ConnectionStatus, JobRow, WebsiteRow } from "@/lib/database/types";
import type { ResolvedRules } from "@/lib/seo/rules";
import type { CheckPhase, CheckResult, SiblingLookup } from "@/lib/seo/types";

/**
 * Persistence boundary for the job processor. The production implementation uses
 * the Supabase service-role client; tests use the same SQL schema in PGlite.
 * Every write is scoped by organization_id taken from the job row itself.
 */
export type JobContext = {
  job: JobRow;
  content: ContentRow | null;
  website: WebsiteRow;
  encryptedCredentials: string | null;
  rules: ResolvedRules;
};

export type JobPatch = Partial<Pick<JobRow,
  "status" | "run_at" | "completed_at" | "lease_expires_at" | "needs_reconciliation" | "error_code" | "error_message" | "retryable" | "result" | "locked_by"
>>;
export type ContentPatch = Partial<Pick<ContentRow,
  "status" | "validation_status" | "validated_hash" | "published_url" | "external_post_id" | "seo_sync"
>>;

export interface JobRepository {
  claimNext(workerId: string, leaseSeconds: number, organizationId?: string): Promise<JobRow | null>;
  reapExpiredLeases(): Promise<number>;
  loadContext(job: JobRow): Promise<JobContext>;
  /** Conditional on the job still being leased by `workerId`; returns false if the lease was lost. */
  updateJob(job: JobRow, workerId: string, patch: JobPatch): Promise<boolean>;
  updateContent(content: ContentRow, patch: ContentPatch): Promise<ContentRow>;
  saveQaResults(input: { job: JobRow; contentId: string; phase: CheckPhase; results: CheckResult[] }): Promise<void>;
  setConnectionStatus(job: JobRow, status: ConnectionStatus, error?: string | null): Promise<void>;
  audit(job: JobRow, action: string, metadata: Record<string, unknown>): Promise<void>;
  siblings: SiblingLookup;
}
