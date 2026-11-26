import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import app from "../app";
import { query, runWithOrgContext } from "../db/pool";
import { createTestOrg, createTestUser, loginAs, TEST_PASSWORD } from "./helpers";

// Marker action so direct fixture assertions never pick up the user.login
// audit rows written by loginAs() (or anything else the routes may log).
const FIXTURE_ACTION = "test.purge_retention";

type Org = Awaited<ReturnType<typeof createTestOrg>>;

interface Fixture {
  org: Org;
  cookie: string[];
  oldAuditId: string;
  recentAuditId: string;
  oldCompletedId: string;
}

async function makeOrgWithOldData(): Promise<Fixture> {
  const org = await createTestOrg();
  const admin = await createTestUser(org.id, "admin");
  const cookie = await loginAs(app, admin.username, TEST_PASSWORD);

  const oldAuditId = randomUUID();
  const recentAuditId = randomUUID();
  const oldCompletedId = randomUUID();
  const policyId = randomUUID();

  // Fixture setup, not a tenant action: insert under bypass so RLS doesn't
  // interfere with creating old rows for two different orgs.
  await runWithOrgContext({ orgId: null, bypass: true }, async () => {
    await query(
      `INSERT INTO policies
         (id, org_id, name, domain, key_field, cradle_field, cradle_value, grave_field, grave_value)
       VALUES ($1, $2, $3, 'test.*', 'orderId', 'eventType', 'order.created', 'eventType', 'order.delivered')`,
      [policyId, org.id, `Purge test policy ${randomUUID().slice(0, 8)}`]
    );
    await query(
      `INSERT INTO audit_log (org_id, entity_type, entity_id, action, event_time)
       VALUES ($1, 'test', $2, $3, now() - interval '100 days'),
              ($1, 'test', $4, $3, now())`,
      [org.id, oldAuditId, FIXTURE_ACTION, recentAuditId]
    );
    await query(
      `INSERT INTO completed_events
         (id, org_id, policy_id, aggregation_key, key_field, raw_event_count,
          cradle_raw_event_id, grave_raw_event_id, started_at, ended_at)
       VALUES ($1, $2, $3, $4, 'orderId', 1, $5, $5,
               now() - interval '101 days', now() - interval '100 days')`,
      [oldCompletedId, org.id, policyId, randomUUID(), randomUUID()]
    );
  });

  return { org, cookie, oldAuditId, recentAuditId, oldCompletedId };
}

// Read fixtures back under bypass -outside the request's org context, RLS on
// audit_log would fail closed and make the assertions vacuous.
async function auditIds(orgId: string): Promise<string[]> {
  const rows = await runWithOrgContext({ orgId: null, bypass: true }, () =>
    query<{ entity_id: string }>(
      `SELECT entity_id FROM audit_log
        WHERE org_id = $1 AND action = $2 ORDER BY entity_id`,
      [orgId, FIXTURE_ACTION]
    )
  );
  return rows.map((r) => r.entity_id);
}

async function oldCompletedIds(orgId: string): Promise<string[]> {
  const rows = await runWithOrgContext({ orgId: null, bypass: true }, () =>
    query<{ id: string }>(
      `SELECT id::text FROM completed_events
        WHERE org_id = $1 AND ended_at < now() - interval '90 days' ORDER BY id`,
      [orgId]
    )
  );
  return rows.map((r) => r.id);
}

describe("admin purge of RLS-protected audit rows", () => {
  it("counts and deletes old audit rows for the calling org", async () => {
    const a = await makeOrgWithOldData();
    const b = await makeOrgWithOldData();

    // Without orgContextMiddleware the COUNT below fails closed and reports
    // audit = 0 while the old row is still there.
    const preview = await request(app)
      .get("/api/v1/admin/db/purgeable")
      .set("Cookie", a.cookie);
    expect(preview.status).toBe(200);
    expect(Number(preview.body.purgeable_90d.audit)).toBe(1);
    expect(Number(preview.body.purgeable_90d.completed)).toBe(1);

    const purge = await request(app)
      .post("/api/v1/admin/db/purge")
      .set("Cookie", a.cookie)
      .send({ days: 90 });
    expect(purge.status).toBe(200);
    expect(purge.body.deleted_audit).toBe(1);
    expect(purge.body.deleted_completed).toBe(1);

    expect(await auditIds(a.org.id)).toEqual([a.recentAuditId]);
    expect(await oldCompletedIds(a.org.id)).toEqual([]);
    // Another org's old rows are neither counted nor deleted by this admin.
    expect(await auditIds(b.org.id)).toEqual([b.oldAuditId, b.recentAuditId].sort());
    expect(await oldCompletedIds(b.org.id)).toEqual([b.oldCompletedId]);
  });

  it("purges each org's old audit rows only for that org's admin", async () => {
    const a = await makeOrgWithOldData();
    const b = await makeOrgWithOldData();

    const purgeA = await request(app)
      .post("/api/v1/admin/db/purge")
      .set("Cookie", a.cookie)
      .send({ days: 30 });
    expect(purgeA.status).toBe(200);
    expect(purgeA.body.deleted_audit).toBe(1);

    // B's preview still sees its own old audit row after A purged.
    const previewB = await request(app)
      .get("/api/v1/admin/db/purgeable")
      .set("Cookie", b.cookie);
    expect(previewB.status).toBe(200);
    expect(Number(previewB.body.purgeable_90d.audit)).toBe(1);

    const purgeB = await request(app)
      .post("/api/v1/admin/db/purge")
      .set("Cookie", b.cookie)
      .send({ days: 30 });
    expect(purgeB.status).toBe(200);
    expect(purgeB.body.deleted_audit).toBe(1);

    expect(await auditIds(a.org.id)).toEqual([a.recentAuditId]);
    expect(await auditIds(b.org.id)).toEqual([b.recentAuditId]);
  });
});
