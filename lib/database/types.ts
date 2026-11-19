import type { SeoSyncState } from "@/lib/cms/types";
import type { Role } from "@/lib/auth/permissions";
import type { ContentStatus } from "@/lib/content/state-machine";
import type { JobStatus, JobType } from "@/lib/jobs/state-machine";

/** Row types mirroring supabase/migrations (kept by hand; small and explicit). */
export type ValidationStatus = "NOT_RUN" | "PASSED" | "PASSED_WITH_WARNINGS" | "FAILED" | "STALE";
export type ConnectionStatus = "not_connected" | "pending" | "connected" | "auth_failed" | "error";

export type OrganizationRow = { id: string; name: string; slug: string; settings: Record<string, unknown>; created_at: string; updated_at: string };
export type MembershipRow = { id: string; organization_id: string; user_id: string; role: Role; created_at: string };
export type ClientRow = { id: string; organization_id: string; name: string; notes: string | null; created_at: string; updated_at: string };
export type WebsiteRow = {
  id: string; organization_id: string; client_id: string; name: string; base_url: string; cms_type: string;
  connection_status: ConnectionStatus; timezone: string; publishing_settings: Record<string, unknown>; created_at: string; updated_at: string;
};
export type CmsConnectionRow = {
  id: string; organization_id: string; website_id: string; connection_type: string; metadata: Record<string, unknown>;
  connection_status: ConnectionStatus; last_tested_at: string | null; last_error: string | null; created_at: string; updated_at: string;
};
export type ContentRow = {
  id: string; organization_id: string; website_id: string; title: string; slug: string; body: string; body_format: "markdown" | "html";
  excerpt: string; meta_title: string; meta_description: string; canonical_url: string; target_keyword: string;
  categories: number[]; tags: number[]; featured_media_id: number | null;
  status: ContentStatus; validation_status: ValidationStatus; content_hash: string; validated_hash: string | null; approved_hash: string | null;
  scheduled_at: string | null; published_url: string | null; external_post_id: string | null; seo_sync: SeoSyncState;
  assigned_to: string | null; created_by: string | null; approved_by: string | null; approved_at: string | null; created_at: string; updated_at: string;
  schema_jsonld?: Record<string, unknown> | null; ai_generated?: boolean; brief?: Record<string, unknown> | null; template_id?: string | null; generation_task_id?: string | null;
};
export type JobRow = {
  id: string; organization_id: string; website_id: string; content_item_id: string | null; job_type: JobType; status: JobStatus;
  idempotency_key: string; attempts: number; max_attempts: number; scheduled_at: string | null; run_at: string;
  started_at: string | null; completed_at: string | null; lease_expires_at: string | null; locked_by: string | null;
  needs_reconciliation: boolean; error_code: string | null; error_message: string | null; retryable: boolean | null;
  result: Record<string, unknown>; created_by: string | null; created_at: string; updated_at: string;
};
export type QaResultRow = {
  id: string; organization_id: string; website_id: string; content_item_id: string; job_id: string | null; phase: "pre_publish" | "post_publish";
  check_name: string; status: "pass" | "fail" | "skipped"; severity: "error" | "warning" | "info"; kind: "technical" | "recommendation";
  message: string; field: string | null; url: string | null; remediation: string | null; details: Record<string, unknown>; created_at: string;
};
export type AutomationRuleRow = { id: string; organization_id: string; website_id: string | null; name: string; enabled: boolean; rules_json: Record<string, unknown> };
export type AuditLogRow = { id: number; organization_id: string; user_id: string | null; action: string; resource_type: string; resource_id: string | null; metadata: Record<string, unknown>; created_at: string };
