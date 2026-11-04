import { describe, expect, it } from "vitest";
import { can, canEditContent } from "@/lib/auth/permissions";
import { CONTENT_STATUSES, canTransition } from "@/lib/content/state-machine";
import { AppError } from "@/lib/errors";
import { backoffDelay, decideOnFailure, isManuallyRetryable } from "@/lib/jobs/state-machine";
import { utcToZonedLocal, zonedLocalToUtc } from "@/lib/scheduling/timezone";
import { wordpressConnectionSchema, contentSchema, slugify } from "@/lib/validation/schemas";
import { createTestDb } from "../db/harness";

describe("content state machine", () => {
  it("matches the database transition table exactly", async () => {
    const db = await createTestDb();
    for (const from of CONTENT_STATUSES) {
      for (const to of CONTENT_STATUSES) {
        const r = await db.query<{ ok: boolean }>("select public.content_transition_allowed($1, $2) as ok", [from, to]);
        expect([from, to, r.rows[0].ok]).toEqual([from, to, canTransition(from, to)]);
      }
    }
  });

  it("never allows a validation failure to lead straight to publishing", () => {
    expect(canTransition("VALIDATION_FAILED", "QUEUED")).toBe(false);
    expect(canTransition("VALIDATION_FAILED", "APPROVED")).toBe(false);
    expect(canTransition("DRAFT", "PUBLISHING")).toBe(false);
    expect(canTransition("READY_FOR_REVIEW", "QUEUED")).toBe(false);
  });
});

describe("retry classification", () => {
  it("does not retry permanent failures", () => {
    expect(decideOnFailure(new AppError("VALIDATION_FAILED", "x"), 1, 5)).toEqual({ kind: "fail", code: "VALIDATION_FAILED", retryable: false });
    expect(decideOnFailure(new AppError("WP_AUTH_FAILED", "x"), 1, 5).kind).toBe("fail");
    expect(decideOnFailure(new Error("boom"), 1, 5).kind).toBe("fail");
  });

  it("retries transient failures with reconciliation for ambiguous writes", () => {
    const d = decideOnFailure(new AppError("TIMEOUT", "x", { retryable: true, ambiguous: true }), 1, 5, () => 0.5);
    expect(d).toEqual({ kind: "retry", delayMs: 30_000, reconcile: true });
  });

  it("stops at max attempts and honours Retry-After", () => {
    expect(decideOnFailure(new AppError("WP_SERVER_ERROR", "x", { retryable: true }), 5, 5)).toMatchObject({ kind: "fail", code: "MAX_ATTEMPTS_EXCEEDED" });
    expect(decideOnFailure(new AppError("WP_RATE_LIMITED", "x", { retryable: true, retryAfterMs: 120_000 }), 1, 5, () => 0.5)).toMatchObject({ delayMs: 120_000 });
  });

  it("uses bounded exponential backoff", () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4].map((a) => backoffDelay(a, mid))).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(backoffDelay(30, mid)).toBe(30 * 60_000);
  });

  it("flags manually retryable jobs", () => {
    expect(isManuallyRetryable({ status: "FAILED", retryable: false, error_code: "VALIDATION_FAILED" })).toBe(false);
    expect(isManuallyRetryable({ status: "FAILED", retryable: false, error_code: "WP_AUTH_FAILED" })).toBe(true);
    expect(isManuallyRetryable({ status: "COMPLETED", retryable: true, error_code: null })).toBe(false);
  });
});

describe("role permissions", () => {
  it("applies the role matrix", () => {
    expect(can("owner", "members.manage")).toBe(true);
    expect(can("admin", "members.manage")).toBe(false);
    expect(can("admin", "content.publish")).toBe(true);
    expect(can("member", "content.publish")).toBe(false);
    expect(can("member", "content.validate")).toBe(true);
    expect(can("viewer", "content.create")).toBe(false);
    expect(can(null, "reports.view")).toBe(false);
  });

  it("limits members to their own or assigned content", () => {
    expect(canEditContent("member", "u1", { created_by: "u1", assigned_to: null })).toBe(true);
    expect(canEditContent("member", "u1", { created_by: "u2", assigned_to: "u1" })).toBe(true);
    expect(canEditContent("member", "u1", { created_by: "u2", assigned_to: null })).toBe(false);
    expect(canEditContent("viewer", "u1", { created_by: "u1", assigned_to: null })).toBe(false);
  });
});

describe("input validation", () => {
  it("validates application passwords without requiring the login password", () => {
    const ok = wordpressConnectionSchema.safeParse({ cmsType: "wordpress", websiteId: crypto.randomUUID(), username: "editor", applicationPassword: "abcd EFGH ijkl MNOP qrst UVWX" });
    expect(ok.success && ok.data.applicationPassword).toBe("abcdEFGHijklMNOPqrstUVWX");
    expect(wordpressConnectionSchema.safeParse({ cmsType: "wordpress", websiteId: crypto.randomUUID(), username: "editor", applicationPassword: "hunter2" }).success).toBe(false);
  });

  it("validates content fields", () => {
    const base = { websiteId: crypto.randomUUID(), title: "T", body: "", slug: "good-slug" };
    expect(contentSchema.safeParse(base).success).toBe(true);
    expect(contentSchema.safeParse({ ...base, slug: "Bad Slug" }).success).toBe(false);
    expect(contentSchema.safeParse({ ...base, canonicalUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(contentSchema.parse({ ...base, categories: "3, 4" }).categories).toEqual([3, 4]);
  });

  it("slugifies titles", () => {
    expect(slugify("  Héllo, World! 2026 ")).toBe("hello-world-2026");
  });
});

describe("website-local scheduling", () => {
  it("converts wall-clock time to UTC across DST", () => {
    expect(zonedLocalToUtc("2026-07-01T09:00", "Europe/London").toISOString()).toBe("2026-07-01T08:00:00.000Z");
    expect(zonedLocalToUtc("2026-12-01T09:00", "Europe/London").toISOString()).toBe("2026-12-01T09:00:00.000Z");
    expect(zonedLocalToUtc("2026-03-08T12:00", "America/New_York").toISOString()).toBe("2026-03-08T16:00:00.000Z");
    expect(zonedLocalToUtc("2026-11-01T10:30", "Asia/Dhaka").toISOString()).toBe("2026-11-01T04:30:00.000Z");
    expect(utcToZonedLocal("2026-11-01T04:30:00Z", "Asia/Dhaka")).toBe("2026-11-01T10:30");
  });
});
