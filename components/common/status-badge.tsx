import { Badge } from "@/components/ui/badge";
import { CONTENT_STATUS_LABEL, type ContentStatus } from "@/lib/content/state-machine";
import { JOB_STATUS_LABEL, type JobStatus } from "@/lib/jobs/state-machine";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "progress";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
  success: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  warning: "bg-amber-50 text-amber-800 ring-1 ring-amber-200",
  danger: "bg-red-50 text-red-700 ring-1 ring-red-200",
  progress: "bg-violet-50 text-violet-700 ring-1 ring-violet-200",
};

export function ToneBadge({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return <Badge className={cn("rounded-md font-medium", TONE_CLASS[tone], className)}>{children}</Badge>;
}

const CONTENT_TONE: Record<ContentStatus, Tone> = {
  DRAFT: "neutral", VALIDATING: "progress", READY_FOR_REVIEW: "info", APPROVED: "success", QUEUED: "progress",
  PUBLISHING: "progress", VERIFYING: "progress", PUBLISHED: "success", VALIDATION_FAILED: "danger",
  PUBLISH_FAILED: "danger", VERIFICATION_FAILED: "warning", CANCELLED: "neutral",
};

export function ContentStatusBadge({ status }: { status: ContentStatus }) {
  return <ToneBadge tone={CONTENT_TONE[status]}>{CONTENT_STATUS_LABEL[status]}</ToneBadge>;
}

const JOB_TONE: Record<JobStatus, Tone> = {
  QUEUED: "neutral", VALIDATING: "progress", PUBLISHING: "progress", VERIFYING: "progress", COMPLETED: "success",
  FAILED: "danger", CANCELLED: "neutral", RETRY_SCHEDULED: "warning",
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return <ToneBadge tone={JOB_TONE[status]}>{JOB_STATUS_LABEL[status]}</ToneBadge>;
}

const VALIDATION: Record<string, [Tone, string]> = {
  NOT_RUN: ["neutral", "Not validated"],
  PASSED: ["success", "Passed"],
  PASSED_WITH_WARNINGS: ["warning", "Passed with warnings"],
  FAILED: ["danger", "Failed"],
  STALE: ["warning", "Out of date"],
};

export function ValidationBadge({ status }: { status: string }) {
  const [tone, label] = VALIDATION[status] ?? ["neutral", status];
  return <ToneBadge tone={tone}>{label}</ToneBadge>;
}

const CONNECTION: Record<string, [Tone, string]> = {
  not_connected: ["neutral", "Not connected"],
  pending: ["progress", "Pending"],
  connected: ["success", "Connected"],
  auth_failed: ["danger", "Credentials rejected"],
  error: ["warning", "Unreachable"],
};

export function ConnectionBadge({ status }: { status: string }) {
  const [tone, label] = CONNECTION[status] ?? ["neutral", status];
  return <ToneBadge tone={tone}>{label}</ToneBadge>;
}

export function DevTargetBadge() {
  return <ToneBadge tone="warning" className="uppercase tracking-wide">Development target</ToneBadge>;
}

/** Estimated share of AI-written text, from the latest validation (see lib/seo/ai-detection.ts). */
export function AiShareBadge({ percent, threshold }: { percent: number; threshold: number }) {
  return (
    <ToneBadge tone={percent >= threshold ? "warning" : "neutral"}>
      <span title="Estimated share of the text that reads as AI-generated. An estimate, not proof of authorship.">
        {percent >= threshold ? `AI-written · ${percent}%` : `AI ${percent}%`}
      </span>
    </ToneBadge>
  );
}
