import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser, type TestDb } from "./harness";

let db: TestDb;
let ownerA: string, ownerB: string, memberA: string, viewerA: string;
let orgA: string, orgB: string, clientA: string, websiteA: string;

const one = async <T>(p: Promise<{ rows: T[] }>) => (await p).rows[0];

beforeAll(async () => {
  db = await createTestDb();
  ownerA = await createUser(db, "owner-a@example.test");
  ownerB = await createUser(db, "owner-b@example.test");
  memberA = await createUser(db, "member-a@example.test");
  viewerA = await createUser(db, "viewer-a@example.test");

  orgA = (await asUser(db, ownerA, (tx) => one(tx.query<{ id: string }>("select public.create_organization('Agency A','agency-a') as id")))).id;
  orgB = (await asUser(db, ownerB, (tx) => one(tx.query<{ id: string }>("select public.create_organization('Agency B','agency-b') as id")))).id;
  await asUser(db, ownerA, async (tx) => {
    await tx.query("select public.add_member_by_email($1, 'member-a@example.test', 'member')", [orgA]);
    await tx.query("select public.add_member_by_email($1, 'viewer-a@example.test', 'viewer')", [orgA]);
    clientA = (await one(tx.query<{ id: string }>("insert into clients (organization_id, name) values ($1, 'Client A') returning id", [orgA]))).id;
    websiteA = (await one(tx.query<{ id: string }>(
      "insert into websites (organization_id, client_id, name, base_url) values ($1, $2, 'Site A', 'https://a.example.com') returning id",
      [orgA, clientA],
    ))).id;
  });
  await asService(db, (tx) => tx.query("update websites set connection_status = 'connected' where id = $1", [websiteA]));
});

async function newContent(userId: string, title = "Hello world", slug = "hello-world"): Promise<string> {
  return (await asUser(db, userId, (tx) => one(tx.query<{ id: string }>(
    "insert into content_items (organization_id, website_id, title, slug, body, created_by) values ($1, $2, $3, $4, 'Body', $5) returning id",
    [orgA, websiteA, title, slug, userId],
  )))).id;
}

/** Simulates the server-side validation service marking content as ready. */
async function markValidated(contentId: string) {
  await asService(db, async (tx) => {
    await tx.query("update content_items set status = 'VALIDATING' where id = $1", [contentId]);
    await tx.query(
      "update content_items set status = 'READY_FOR_REVIEW', validation_status = 'PASSED', validated_hash = content_hash where id = $1",
      [contentId],
    );
  });
}

describe("organization isolation", () => {
  it("hides another organization's records", async () => {
    const contentId = await newContent(ownerA);
    await asUser(db, ownerB, async (tx) => {
      expect((await tx.query("select * from clients where id = $1", [clientA])).rows).toHaveLength(0);
      expect((await tx.query("select * from websites where id = $1", [websiteA])).rows).toHaveLength(0);
      expect((await tx.query("select * from content_items where id = $1", [contentId])).rows).toHaveLength(0);
      expect((await tx.query("select * from organizations where id = $1", [orgA])).rows).toHaveLength(0);
      expect((await tx.query("select * from memberships where organization_id = $1", [orgA])).rows).toHaveLength(0);
    });
  });

  it("blocks cross-tenant writes by changing IDs", async () => {
    const contentId = await newContent(ownerA, "Cross", "cross");
    await asUser(db, ownerB, async (tx) => {
      const upd = await tx.query("update content_items set title = 'pwned' where id = $1", [contentId]);
      expect(upd.affectedRows).toBe(0);
      const del = await tx.query("delete from clients where id = $1", [clientA]);
      expect(del.affectedRows).toBe(0);
    });
    await expect(
      asUser(db, ownerB, (tx) => tx.query(
        "insert into content_items (organization_id, website_id, title, created_by) values ($1, $2, 'x', $3)",
        [orgA, websiteA, ownerB],
      )),
    ).rejects.toThrow(/row-level security/);
    // Even with its own org id, B cannot attach content to A's website (composite FK).
    await expect(
      asUser(db, ownerB, (tx) => tx.query(
        "insert into content_items (organization_id, website_id, title, created_by) values ($1, $2, 'x', $3)",
        [orgB, websiteA, ownerB],
      )),
    ).rejects.toThrow();
    await expect(asUser(db, ownerB, (tx) => tx.query("select public.approve_content($1)", [contentId]))).rejects.toThrow(/Not allowed/);
    await expect(
      asUser(db, ownerB, (tx) => tx.query("select public.enqueue_content_job($1, 'VALIDATE', 'request-key-1')", [contentId])),
    ).rejects.toThrow(/not found/);
  });

  it("never exposes encrypted credentials to clients", async () => {
    await asService(db, (tx) => tx.query(
      "insert into cms_connections (organization_id, website_id, encrypted_credentials) values ($1, $2, 'v1:k1:aaa:bbb:ccc')",
      [orgA, websiteA],
    ));
    await asUser(db, ownerA, async (tx) => {
      const rows = (await tx.query("select id, connection_status from cms_connections where website_id = $1", [websiteA])).rows;
      expect(rows).toHaveLength(1);
    });
    await expect(
      asUser(db, ownerA, (tx) => tx.query("select encrypted_credentials from cms_connections")),
    ).rejects.toThrow(/permission denied/);
    await asUser(db, memberA, async (tx) => {
      expect((await tx.query("select id from cms_connections")).rows).toHaveLength(0);
    });
  });

  it("lists API keys to members without the hash and keeps alerts read-only and tenant-scoped", async () => {
    await asService(db, (tx) => tx.query("insert into api_keys (organization_id, name, prefix, key_hash) values ($1, 'CI', 'abcdef0123', $2)", [orgA, "a".repeat(64)]));
    await asService(db, (tx) => tx.query("insert into seo_alerts (organization_id, website_id, source, kind, severity, title, fingerprint) values ($1, $2, 'audit', 'noindex_added', 'critical', 'Page became noindex', 'f1')", [orgA, websiteA]));
    await asUser(db, ownerA, async (tx) => {
      expect((await tx.query("select name, prefix from api_keys")).rows).toEqual([{ name: "CI", prefix: "abcdef0123" }]);
      expect((await tx.query("select title from seo_alerts")).rows).toHaveLength(1);
    });
    await expect(asUser(db, ownerA, (tx) => tx.query("select key_hash from api_keys"))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, ownerA, (tx) => tx.query("update seo_alerts set status = 'resolved'"))).rejects.toThrow(/permission denied/);
    await asUser(db, ownerB, async (tx) => {
      expect((await tx.query("select id from api_keys")).rows).toHaveLength(0);
      expect((await tx.query("select id from seo_alerts")).rows).toHaveLength(0);
    });
    // One open alert per fingerprint; a resolved one does not block a new occurrence.
    await expect(asService(db, (tx) => tx.query("insert into seo_alerts (organization_id, website_id, source, kind, severity, title, fingerprint) values ($1, $2, 'audit', 'noindex_added', 'critical', 'x', 'f1')", [orgA, websiteA]))).rejects.toThrow(/duplicate key/);
    await asService(db, (tx) => tx.query("update seo_alerts set status = 'resolved' where fingerprint = 'f1'"));
    await asService(db, (tx) => tx.query("insert into seo_alerts (organization_id, website_id, source, kind, severity, title, fingerprint) values ($1, $2, 'audit', 'noindex_added', 'critical', 'x', 'f1')", [orgA, websiteA]));
  });
});

describe("roles", () => {
  it("viewers are read-only", async () => {
    await expect(newContent(viewerA, "Viewer", "viewer")).rejects.toThrow(/row-level security/);
    await expect(
      asUser(db, viewerA, (tx) => tx.query("insert into clients (organization_id, name) values ($1, 'x')", [orgA])),
    ).rejects.toThrow(/row-level security/);
  });

  it("members cannot change workflow columns or approve", async () => {
    const id = await newContent(memberA, "Member post", "member-post");
    await expect(
      asUser(db, memberA, (tx) => tx.query("update content_items set status = 'APPROVED' where id = $1", [id])),
    ).rejects.toThrow(/permission denied/);
    await markValidated(id);
    await expect(asUser(db, memberA, (tx) => tx.query("select public.approve_content($1)", [id]))).rejects.toThrow(/Not allowed/);
    await expect(
      asUser(db, memberA, (tx) => tx.query("select public.enqueue_content_job($1, 'PUBLISH', 'request-key-2')", [id])),
    ).rejects.toThrow(/Only owners and admins/);
  });

  it("members cannot edit content they neither created nor were assigned", async () => {
    const id = await newContent(ownerA, "Owner post", "owner-post");
    const res = await asUser(db, memberA, (tx) => tx.query("update content_items set title = 'x' where id = $1", [id]));
    expect(res.affectedRows).toBe(0);
  });

  it("jobs and QA results are not client-writable", async () => {
    await expect(
      asUser(db, ownerA, (tx) => tx.query(
        "insert into content_jobs (organization_id, website_id, job_type, idempotency_key) values ($1, $2, 'PUBLISH', 'manual-key-1')",
        [orgA, websiteA],
      )),
    ).rejects.toThrow(/permission denied/);
    await expect(asUser(db, ownerA, (tx) => tx.query("select * from public.claim_next_job('w', 60)"))).rejects.toThrow(/permission denied/);
  });

  it("keeps at least one owner", async () => {
    const m = await asUser(db, ownerA, (tx) => one(tx.query<{ id: string }>(
      "select id from memberships where organization_id = $1 and user_id = $2", [orgA, ownerA],
    )));
    await expect(asUser(db, ownerA, (tx) => tx.query("select public.set_member_role($1, 'admin')", [m.id]))).rejects.toThrow(/at least one owner/);
  });
});

describe("content workflow", () => {
  it("rejects invalid state transitions", async () => {
    const id = await newContent(ownerA, "Transition", "transition");
    await expect(
      asService(db, (tx) => tx.query("update content_items set status = 'PUBLISHED' where id = $1", [id])),
    ).rejects.toThrow(/Invalid content status transition/);
  });

  it("requires validation before approval and invalidates approval on edit", async () => {
    const id = await newContent(ownerA, "Approve me", "approve-me");
    await expect(asUser(db, ownerA, (tx) => tx.query("select public.approve_content($1)", [id]))).rejects.toThrow(/ready for review/);
    await markValidated(id);
    await asUser(db, ownerA, (tx) => tx.query("select public.approve_content($1)", [id]));
    let row = await one(db.query<{ status: string; approved_by: string | null }>("select status, approved_by from content_items where id = $1", [id]));
    expect(row).toMatchObject({ status: "APPROVED", approved_by: ownerA });
    const audit = await db.query("select * from audit_logs where action = 'content.approved' and resource_id = $1", [id]);
    expect(audit.rows).toHaveLength(1);

    await asUser(db, ownerA, (tx) => tx.query("update content_items set body = 'Changed body' where id = $1", [id]));
    row = await one(db.query("select status, approved_by, validation_status from content_items where id = $1", [id]));
    expect(row).toMatchObject({ status: "DRAFT", approved_by: null, validation_status: "STALE" });
  });

  it("de-duplicates publish submissions and allows only one active publish job", async () => {
    const id = await newContent(ownerA, "Publish me", "publish-me");
    await markValidated(id);
    await asUser(db, ownerA, (tx) => tx.query("select public.approve_content($1)", [id]));
    const first = await asUser(db, ownerA, (tx) => one(tx.query<{ id: string }>("select public.enqueue_content_job($1, 'PUBLISH', 'submit-abc-123') as id", [id])));
    const again = await asUser(db, ownerA, (tx) => one(tx.query<{ id: string }>("select public.enqueue_content_job($1, 'PUBLISH', 'submit-abc-123') as id", [id])));
    expect(again.id).toBe(first.id);
    await expect(
      asUser(db, ownerA, (tx) => tx.query("select public.enqueue_content_job($1, 'PUBLISH', 'submit-other-456')", [id])),
    ).rejects.toThrow(/must be approved/);
    const jobs = await db.query("select * from content_jobs where content_item_id = $1", [id]);
    expect(jobs.rows).toHaveLength(1);

    // Locked content cannot be edited while queued.
    await expect(
      asUser(db, ownerA, (tx) => tx.query("update content_items set title = 'Nope' where id = $1", [id])),
    ).rejects.toThrow(/locked/);

    await asUser(db, ownerA, (tx) => tx.query("select public.cancel_job($1)", [first.id]));
    const c = await one(db.query("select status from content_items where id = $1", [id]));
    expect(c).toMatchObject({ status: "APPROVED" });
  });

  it("claims jobs with per-website concurrency and refuses non-retryable retries", async () => {
    const ids = [await newContent(ownerA, "C1", "c-one"), await newContent(ownerA, "C2", "c-two")];
    for (const id of ids) {
      await asUser(db, ownerA, (tx) => tx.query("select public.enqueue_content_job($1, 'VALIDATE', $2)", [id, `validate-${id}`]));
    }
    const claimed = await asService(db, (tx) => tx.query<{ id: string; status: string; attempts: number }>("select * from public.claim_next_job('worker-1', 60)"));
    expect(claimed.rows).toHaveLength(1);
    expect(claimed.rows[0]).toMatchObject({ status: "VALIDATING", attempts: 1 });
    const second = await asService(db, (tx) => tx.query("select * from public.claim_next_job('worker-2', 60)"));
    expect(second.rows).toHaveLength(0); // same website, concurrency 1

    await asService(db, (tx) => tx.query(
      "update content_jobs set status = 'FAILED', retryable = false, error_code = 'VALIDATION_FAILED' where id = $1",
      [claimed.rows[0].id],
    ));
    await expect(asUser(db, ownerA, (tx) => tx.query("select public.retry_job($1)", [claimed.rows[0].id]))).rejects.toThrow(/not retryable/);
  });

  it("reaps expired leases into a reconciling retry", async () => {
    const id = await newContent(ownerA, "Lease", "lease");
    const job = await asUser(db, ownerA, (tx) => one(tx.query<{ id: string }>("select public.enqueue_content_job($1, 'VALIDATE', 'lease-key-1') as id", [id])));
    await asService(db, (tx) => tx.query("update content_jobs set status = 'FAILED' where status in ('QUEUED','VALIDATING') and id <> $1", [job.id]));
    await asService(db, (tx) => tx.query("select * from public.claim_next_job('w', 60)"));
    await asService(db, (tx) => tx.query("update content_jobs set lease_expires_at = now() - interval '1 second' where id = $1", [job.id]));
    const n = await asService(db, (tx) => one(tx.query<{ n: number }>("select public.reap_expired_leases() as n")));
    expect(n.n).toBeGreaterThanOrEqual(1);
    const j = await one(db.query("select status, needs_reconciliation from content_jobs where id = $1", [job.id]));
    expect(j).toMatchObject({ status: "RETRY_SCHEDULED", needs_reconciliation: true });
  });

  it("rate limit counter is persistent and bounded", async () => {
    const results: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await asService(db, (tx) => one(tx.query<{ ok: boolean }>("select public.check_rate_limit('test:key', 3, 60) as ok")));
      results.push(r.ok);
    }
    expect(results).toEqual([true, true, true, false]);
  });
});
