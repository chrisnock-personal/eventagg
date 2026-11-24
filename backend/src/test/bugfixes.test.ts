import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import app from "../app";
import { query, runWithOrgContext } from "../db/pool";
import { sendGroupTimedOutAlert } from "../services/smtpService";
import { createTestOrg, createTestUser, loginAs, TEST_PASSWORD } from "./helpers";

// The SMTP alert test needs to observe the outgoing message without a real
// mail server. The service uses a dynamic import, so mock the module itself.
const { sendMailMock } = vi.hoisted(() => ({ sendMailMock: vi.fn() }));
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: sendMailMock }) },
}));

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
    .send(policyBody(`Body search policy ${randomUUID().slice(0, 8)}`));
  expect(res.status).toBe(201);
  return { org, cookie, policyId: res.body.id as string };
}

async function ingest(
  org: Awaited<ReturnType<typeof createTestOrg>>,
  policyId: string,
  body: Record<string, unknown>
) {
  const res = await request(app)
    .post("/api/v1/events/ingest")
    .set("X-API-Key", org.ingestApiKey)
    .send({ policyId, body });
  expect(res.status).toBe(201);
  return res.body.groupId as string;
}

describe("backlog bug fixes", () => {
  describe("body search", () => {
    it("matches a nested field=value only when the value is equal", async () => {
      const { org, cookie, policyId } = await setupOrgWithPolicy();
      const matching = randomUUID();
      const other = randomUUID();
      await ingest(org, policyId, {
        eventType: "order.created", orderId: matching, fix: { symbol: "VOD.L" },
      });
      await ingest(org, policyId, {
        eventType: "order.created", orderId: other, fix: { symbol: "BP.L" },
      });

      const hit = await request(app)
        .get("/api/v1/events")
        .query({ bodySearch: "fix.symbol=VOD.L" })
        .set("Cookie", cookie);
      expect(hit.status).toBe(200);
      expect(hit.body.data.map((e: any) => e.aggregationKey)).toEqual([matching]);

      const miss = await request(app)
        .get("/api/v1/events")
        .query({ bodySearch: "fix.symbol=NOPE" })
        .set("Cookie", cookie);
      expect(miss.status).toBe(200);
      expect(miss.body.data).toHaveLength(0);
    });

    it("matches a quoted phrase across a raw event body", async () => {
      const { org, cookie, policyId } = await setupOrgWithPolicy();
      const matching = randomUUID();
      const other = randomUUID();
      await ingest(org, policyId, {
        eventType: "order.created", orderId: matching, note: "Met at Northgate Cafe today",
      });
      await ingest(org, policyId, {
        eventType: "order.created", orderId: other, note: "Met at Southgate Cafe today",
      });

      const res = await request(app)
        .get("/api/v1/events")
        .query({ bodySearch: '"Northgate Cafe"' })
        .set("Cookie", cookie);
      expect(res.status).toBe(200);
      expect(res.body.data.map((e: any) => e.aggregationKey)).toEqual([matching]);
    });
  });

  describe("instance-wide admin counts", () => {
    it("reports groups that timed out in the last 24 hours", async () => {
      const { org, policyId } = await setupOrgWithPolicy();
      const superadmin = await createTestUser(null, "superadmin");
      const cookie = await loginAs(app, superadmin.username, TEST_PASSWORD);
      const rawEventId = randomUUID();
      await runWithOrgContext({ orgId: null, bypass: true }, () =>
        query(
          `INSERT INTO completed_events
             (org_id, policy_id, aggregation_key, key_field, raw_event_count,
              cradle_raw_event_id, grave_raw_event_id, started_at, ended_at,
              status, close_reason)
           VALUES ($1, $2, $3, 'orderId', 1, $4, $4,
                   now() - interval '1 hour', now(), 'timed_out', 'policy_timeout')`,
          [org.id, policyId, randomUUID(), rawEventId]
        )
      );

      const res = await request(app).get("/api/v1/system/health").set("Cookie", cookie);
      expect(res.status).toBe(200);
      expect(res.body.database.timed_out_24h).toBeGreaterThanOrEqual(1);
    });

    it("counts all audit rows for the superadmin's backup panel", async () => {
      const { org } = await setupOrgWithPolicy();
      const superadmin = await createTestUser(null, "superadmin");
      const cookie = await loginAs(app, superadmin.username, TEST_PASSWORD);
      await runWithOrgContext({ orgId: null, bypass: true }, () =>
        query(
          `INSERT INTO audit_log (org_id, entity_type, entity_id, action)
           VALUES ($1, 'test', $2, 'test.backup_count')`,
          [org.id, randomUUID()]
        )
      );

      const res = await request(app)
        .get("/api/v1/admin/backup/info")
        .set("Cookie", cookie);
      expect(res.status).toBe(200);
      expect(Number(res.body.counts.audit_entries)).toBeGreaterThanOrEqual(1);
    });
  });

  describe("timeout email alerts", () => {
    beforeEach(() => sendMailMock.mockClear());

    it("emails only the group's org admins and prints the policy timeout", async () => {
      const orgA = await createTestOrg();
      const orgB = await createTestOrg();
      const adminA = await createTestUser(orgA.id, "admin");
      const adminB = await createTestUser(orgB.id, "admin");

      await runWithOrgContext({ orgId: null, bypass: true }, () =>
        query(
          `INSERT INTO system_config (key, value)
           VALUES ('smtp', $1::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [JSON.stringify({
            host: "smtp.test.local", port: 25, secure: false,
            user: "mailer", password: "", from: "alerts@test.local",
          })]
        )
      );

      // The timeout sweep calls this from inside its bypass context.
      await runWithOrgContext({ orgId: null, bypass: true }, () =>
        sendGroupTimedOutAlert({
          orgId: orgA.id,
          policyName: "Order lifecycle",
          aggregationKey: "ORD-1",
          timeoutMs: 15 * 60_000,
          openedAt: new Date("2026-11-24T10:00:00Z"),
        })
      );

      expect(sendMailMock).toHaveBeenCalledTimes(1);
      const mail = sendMailMock.mock.calls[0][0];
      expect(mail.to).toContain(`${adminA.username}@test.local`);
      expect(mail.to).not.toContain(`${adminB.username}@test.local`);
      expect(mail.text).toContain("Timeout:        15 minutes");
    });
  });
});
