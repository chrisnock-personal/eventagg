import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import app from "../app";
import { query, runWithOrgContext } from "../db/pool";
import { createTestOrg, createTestUser, loginAs, TEST_PASSWORD } from "./helpers";

interface AuditRow {
  action: string;
  actor: string | null;
  entity_id: string;
  org_id: string | null;
  policy_id: string | null;
  after_state: string | null;
  metadata: string | null;
}

// audit() is fire-and-forget, so tests query the table directly (under bypass)
// and poll briefly rather than sleeping a fixed amount once.
async function auditRows(where: string, params: unknown[]): Promise<AuditRow[]> {
  return runWithOrgContext({ orgId: null, bypass: true }, () =>
    query<AuditRow>(
      `SELECT action, actor, entity_id, org_id, policy_id,
              after_state::text AS after_state, metadata::text AS metadata
         FROM audit_log
        WHERE ${where}
        ORDER BY event_time DESC`,
      params
    )
  );
}

async function waitForAudit(where: string, params: unknown[], minRows = 1): Promise<AuditRow[]> {
  let rows: AuditRow[] = [];
  for (let i = 0; i < 50; i++) {
    rows = await auditRows(where, params);
    if (rows.length >= minRows) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return rows;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

const policyBody = (name: string) => ({
  name,
  domain: "test.*",
  keyField: "orderId",
  cradleField: "eventType",
  cradleValue: "order.created",
  graveField: "eventType",
  graveValue: "order.delivered",
});

async function setupOrgWithPolicy() {
  const org = await createTestOrg();
  const admin = await createTestUser(org.id, "admin");
  const cookie = await loginAs(app, admin.username, TEST_PASSWORD);
  const res = await request(app)
    .post("/api/v1/policies")
    .set("Cookie", cookie)
    .send(policyBody(`Audit test policy ${randomUUID().slice(0, 8)}`));
  expect(res.status).toBe(201);
  return { org, admin, cookie, policyId: res.body.id as string };
}

async function ingest(org: { ingestApiKey: string }, policyId: string, body: Record<string, unknown>) {
  const res = await request(app)
    .post("/api/v1/events/ingest")
    .set("X-API-Key", org.ingestApiKey)
    .send({ policyId, body });
  expect([200, 201]).toContain(res.status);
  return res.body;
}

describe("audit log gaps", () => {
  it("audits group lifecycle transitions but not every ingested event", async () => {
    const { org, policyId } = await setupOrgWithPolicy();
    const orderId = randomUUID();

    const opened = await ingest(org, policyId, { eventType: "order.created", orderId });
    expect(opened.action).toBe("group_opened");

    const rows = await waitForAudit(
      "org_id = $1 AND action LIKE 'event.%'",
      [org.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("event.group_opened");
    expect(rows[0].entity_id).toBe(opened.groupId);

    const middle = await ingest(org, policyId, { eventType: "order.allocated", orderId });
    expect(middle.action).toBe("raw_event_appended");
    await settle();
    expect(await auditRows("org_id = $1 AND action LIKE 'event.%'", [org.id])).toHaveLength(1);

    const completed = await ingest(org, policyId, { eventType: "order.delivered", orderId });
    expect(completed.action).toBe("group_promoted");
    const afterCompletion = await waitForAudit(
      "org_id = $1 AND action LIKE 'event.%'",
      [org.id],
      2
    );
    expect(afterCompletion.map((r) => r.action).sort()).toEqual([
      "event.group_completed",
      "event.group_opened",
    ]);
  });

  it("audits user create/update/delete with the acting admin", async () => {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, "admin");
    const cookie = await loginAs(app, admin.username, TEST_PASSWORD);
    const username = `new-user-${randomUUID().slice(0, 8)}`;

    const created = await request(app)
      .post("/api/v1/auth/users")
      .set("Cookie", cookie)
      .send({ username, email: `${username}@test.local`, password: TEST_PASSWORD, role: "viewer" });
    expect(created.status).toBe(201);

    const createAudit = await waitForAudit("entity_id = $1 AND action = $2", [created.body.id, "user.created"]);
    expect(createAudit[0].actor).toBe(admin.username);
    expect(createAudit[0].org_id).toBe(org.id);
    expect(createAudit[0].after_state).toContain(username);

    const updated = await request(app)
      .put(`/api/v1/auth/users/${created.body.id}`)
      .set("Cookie", cookie)
      .send({ role: "editor" });
    expect(updated.status).toBe(200);
    expect((await waitForAudit("entity_id = $1 AND action = $2", [created.body.id, "user.updated"]))[0].actor)
      .toBe(admin.username);

    const deleted = await request(app)
      .delete(`/api/v1/auth/users/${created.body.id}`)
      .set("Cookie", cookie);
    expect(deleted.status).toBe(204);
    expect((await waitForAudit("entity_id = $1 AND action = $2", [created.body.id, "user.deleted"]))[0].actor)
      .toBe(admin.username);
  });

  it("audits webhook configuration without recording the signing secret", async () => {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, "admin");
    const cookie = await loginAs(app, admin.username, TEST_PASSWORD);
    const secret = `secret-${randomUUID()}`;

    const created = await request(app)
      .post("/api/v1/webhooks")
      .set("Cookie", cookie)
      .send({ name: "Audit webhook", url: "https://example.test/hook", secret, events: ["group.completed"] });
    expect(created.status).toBe(201);

    const createAudit = await waitForAudit("entity_id = $1 AND action = $2", [created.body.id, "webhook.created"]);
    expect(createAudit[0].org_id).toBe(org.id);
    expect(createAudit[0].after_state).toContain("Audit webhook");
    expect(createAudit[0].after_state).not.toContain(secret);

    const updated = await request(app)
      .put(`/api/v1/webhooks/${created.body.id}`)
      .set("Cookie", cookie)
      .send({ name: "Renamed webhook" });
    expect(updated.status).toBe(200);
    expect((await waitForAudit("entity_id = $1 AND action = $2", [created.body.id, "webhook.updated"]))[0].after_state)
      .toContain("Renamed webhook");

    const deleted = await request(app)
      .delete(`/api/v1/webhooks/${created.body.id}`)
      .set("Cookie", cookie);
    expect(deleted.status).toBe(204);
    expect((await waitForAudit("entity_id = $1 AND action = $2", [created.body.id, "webhook.deleted"]))[0].actor)
      .toBe(admin.username);
  });

  it("audits SNMP sources and rules without recording the community string", async () => {
    const { org, admin, cookie, policyId } = await setupOrgWithPolicy();
    const community = `community-${randomUUID()}`;

    const source = await request(app)
      .post("/api/v1/snmp/sources")
      .set("Cookie", cookie)
      .send({ name: "Switch 1", agentAddr: "192.0.2.10", community });
    expect(source.status).toBe(201);

    const sourceAudit = await waitForAudit("entity_id = $1 AND action = $2", [source.body.id, "snmp.source_created"]);
    expect(sourceAudit[0].org_id).toBe(org.id);
    expect(sourceAudit[0].after_state).toContain("Switch 1");
    expect(sourceAudit[0].after_state).not.toContain(community);

    const sourceUpdate = await request(app)
      .put(`/api/v1/snmp/sources/${source.body.id}`)
      .set("Cookie", cookie)
      .send({ name: "Switch 2" });
    expect(sourceUpdate.status).toBe(200);
    expect((await waitForAudit("entity_id = $1 AND action = $2", [source.body.id, "snmp.source_updated"]))[0].actor)
      .toBe(admin.username);

    const rule = await request(app)
      .post("/api/v1/snmp/rules")
      .set("Cookie", cookie)
      .send({ priority: 10, policyId, keyField: "orderId" });
    expect(rule.status).toBe(201);

    const ruleAudit = await waitForAudit("entity_id = $1 AND action = $2", [rule.body.id, "snmp.rule_created"]);
    expect(ruleAudit[0].policy_id).toBe(policyId);
    expect(ruleAudit[0].actor).toBe(admin.username);

    const ruleDelete = await request(app)
      .delete(`/api/v1/snmp/rules/${rule.body.id}`)
      .set("Cookie", cookie);
    expect(ruleDelete.status).toBe(204);
    expect((await waitForAudit("entity_id = $1 AND action = $2", [rule.body.id, "snmp.rule_deleted"]))[0].org_id)
      .toBe(org.id);
  });

  it("audits organisation and system config changes made by a superadmin", async () => {
    const superadmin = await createTestUser(null, "superadmin");
    const cookie = await loginAs(app, superadmin.username, TEST_PASSWORD);
    const name = `Audit org ${randomUUID().slice(0, 8)}`;

    const created = await request(app)
      .post("/api/v1/orgs")
      .set("Cookie", cookie)
      .send({ name });
    expect(created.status).toBe(201);

    const createAudit = await waitForAudit("entity_id = $1 AND action = $2", [created.body.id, "org.created"]);
    expect(createAudit[0].actor).toBe(superadmin.username);
    // Superadmin-only changes are logged with no org, so their audit rows do
    // not hold an FK to the org being managed.
    expect(createAudit[0].org_id).toBeNull();
    expect(createAudit[0].after_state).toContain(name);

    const renamed = `Renamed ${name}`;
    const updated = await request(app)
      .put(`/api/v1/orgs/${created.body.id}`)
      .set("Cookie", cookie)
      .send({ name: renamed });
    expect(updated.status).toBe(200);
    expect((await waitForAudit("entity_id = $1 AND action = $2", [created.body.id, "org.updated"]))[0].after_state)
      .toContain(renamed);

    // Deleting the org removes the FK target, so the audit row is recorded as
    // a NULL-org superadmin action instead.
    const deleted = await request(app)
      .delete(`/api/v1/orgs/${created.body.id}`)
      .set("Cookie", cookie);
    expect(deleted.status).toBe(204);
    const deleteAudit = await waitForAudit("entity_id = $1 AND action = $2", [created.body.id, "org.deleted"]);
    expect(deleteAudit).toHaveLength(1);
    expect(deleteAudit[0].org_id).toBeNull();

    const key = `audit-test-${randomUUID().slice(0, 8)}`;
    const config = await request(app)
      .put(`/api/v1/system/config/${key}`)
      .set("Cookie", cookie)
      .send({ enabled: true });
    expect(config.status).toBe(200);
    const configAudit = await waitForAudit("action = $1 AND metadata->>'key' = $2", ["system.config_updated", key]);
    expect(configAudit[0].actor).toBe(superadmin.username);
    expect(configAudit[0].org_id).toBeNull();
  });
});
