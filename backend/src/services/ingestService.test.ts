import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { ingestRawEvent } from "./ingestService";
import { createPolicy } from "./policyService";
import { queryOne, runWithOrgContext } from "../db/pool";
import { createTestOrg } from "../test/helpers";

// This file calls the service layer directly, bypassing Express and its
// orgContextMiddleware entirely -so every touch of the RLS-protected
// `policies` table (creates, the ad-hoc UPDATE below, and ingestRawEvent's
// own internal policy lookup) needs its own explicit runWithOrgContext,
// exactly like a background job would. HTTP-level tests (multiTenancy.test.ts
// etc.) don't need this -supertest(app) already goes through the real
// middleware chain.

async function makeOrderPolicy(orgId: string) {
  return runWithOrgContext({ orgId, bypass: false }, () =>
    createPolicy(orgId, {
      name: `Order Policy ${randomUUID().slice(0, 8)}`,
      domain: "test.*",
      keyField: "orderId",
      cradleField: "eventType",
      cradleValue: "order.created",
      graveField: "eventType",
      graveValue: "order.delivered",
    })
  );
}

function ingest(orgId: string, input: Parameters<typeof ingestRawEvent>[1]) {
  return runWithOrgContext({ orgId, bypass: false }, () => ingestRawEvent(orgId, input));
}

describe("ingestService.ingestRawEvent", () => {
  it("opens a new group on the cradle event", async () => {
    const org = await createTestOrg();
    const policy = await makeOrderPolicy(org.id);
    const key = randomUUID();

    const result = await ingest(org.id, {
      policyId: policy.id,
      body: { eventType: "order.created", orderId: key },
    });

    expect(result.action).toBe("group_opened");
    expect(result.status).toBe("in_progress");
    expect(result.isCradle).toBe(true);
    expect(result.orgId).toBe(org.id);
    expect(result.aggregationKey).toBe(key);
  });

  it("appends to an existing group on a non-grave event", async () => {
    const org = await createTestOrg();
    const policy = await makeOrderPolicy(org.id);
    const key = randomUUID();

    await ingest(org.id, { policyId: policy.id, body: { eventType: "order.created", orderId: key } });
    const appended = await ingest(org.id, { policyId: policy.id, body: { eventType: "order.allocated", orderId: key } });

    expect(appended.action).toBe("raw_event_appended");
    expect(appended.status).toBe("in_progress");
  });

  it("promotes to completed on the grave event", async () => {
    const org = await createTestOrg();
    const policy = await makeOrderPolicy(org.id);
    const key = randomUUID();

    await ingest(org.id, { policyId: policy.id, body: { eventType: "order.created", orderId: key } });
    const promoted = await ingest(org.id, { policyId: policy.id, body: { eventType: "order.delivered", orderId: key } });

    expect(promoted.action).toBe("group_promoted");
    expect(promoted.status).toBe("completed");
    expect(promoted.isGrave).toBe(true);

    const completed = await queryOne<{ org_id: string; status: string }>(
      `SELECT org_id, status FROM completed_events WHERE id = $1`,
      [promoted.groupId]
    );
    expect(completed?.status).toBe("completed");
    expect(completed?.org_id).toBe(org.id);
  });

  it("treats a resent identical body as an idempotent duplicate", async () => {
    const org = await createTestOrg();
    const policy = await makeOrderPolicy(org.id);
    const key = randomUUID();
    const body = { eventType: "order.allocated", orderId: key };

    await ingest(org.id, { policyId: policy.id, body: { eventType: "order.created", orderId: key } });
    const first = await ingest(org.id, { policyId: policy.id, body });
    const resent = await ingest(org.id, { policyId: policy.id, body });

    expect(resent.rawEventId).toBe(first.rawEventId);

    const group = await queryOne<{ raw_event_count: number }>(
      `SELECT raw_event_count FROM in_progress_events WHERE id = $1`,
      [first.groupId]
    );
    // Only the cradle + first "allocated" event should have been counted —
    // the resend must not have incremented the count again.
    expect(group?.raw_event_count).toBe(2);
  });

  it("rejects ingest against an inactive policy", async () => {
    const org = await createTestOrg();
    const policy = await makeOrderPolicy(org.id);
    await runWithOrgContext({ orgId: org.id, bypass: false }, () =>
      queryOne(`UPDATE policies SET is_active = FALSE WHERE id = $1`, [policy.id])
    );

    await expect(
      ingest(org.id, { policyId: policy.id, body: { eventType: "order.created", orderId: randomUUID() } })
    ).rejects.toMatchObject({ statusCode: 400, code: "POLICY_INACTIVE" });
  });

  it("rejects ingest when the policy belongs to a different org", async () => {
    const orgA = await createTestOrg();
    const orgB = await createTestOrg();
    const policyInOrgA = await makeOrderPolicy(orgA.id);

    await expect(
      ingest(orgB.id, { policyId: policyInOrgA.id, body: { eventType: "order.created", orderId: randomUUID() } })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
