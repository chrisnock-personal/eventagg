import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import app from "../app";
import { createTestOrg, createTestUser, loginAs, TEST_PASSWORD } from "./helpers";

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
    .send(policyBody(`RLS route policy ${randomUUID().slice(0, 8)}`));
  expect(res.status).toBe(201);
  return { org, admin, cookie, policyId: res.body.id as string };
}

async function ingestGroup(org: { ingestApiKey: string }, policyId: string, orderId: string) {
  const res = await request(app)
    .post("/api/v1/events/ingest")
    .set("X-API-Key", org.ingestApiKey)
    .send({ policyId, body: { eventType: "order.created", orderId } });
  expect(res.status).toBe(201);
  return res.body.groupId as string;
}

describe("route-level RLS org context", () => {
  it("scopes event lists, details, raw events and stats to the requesting org", async () => {
    const a = await setupOrgWithPolicy();
    const b = await setupOrgWithPolicy();
    const keyA = randomUUID();
    const keyB = randomUUID();
    const groupA = await ingestGroup(a.org, a.policyId, keyA);
    const groupB = await ingestGroup(b.org, b.policyId, keyB);

    const listA = await request(app).get("/api/v1/events").set("Cookie", a.cookie);
    expect(listA.status).toBe(200);
    expect(listA.body.total).toBe(1);
    expect(listA.body.data.map((e: any) => e.id)).toEqual([groupA]);

    const listB = await request(app).get("/api/v1/events").set("Cookie", b.cookie);
    expect(listB.status).toBe(200);
    expect(listB.body.total).toBe(1);
    expect(listB.body.data.map((e: any) => e.id)).toEqual([groupB]);

    const detailA = await request(app).get(`/api/v1/events/${groupA}`).set("Cookie", a.cookie);
    expect(detailA.status).toBe(200);
    expect(detailA.body.aggregationKey).toBe(keyA);
    const crossDetail = await request(app).get(`/api/v1/events/${groupB}`).set("Cookie", a.cookie);
    expect(crossDetail.status).toBe(404);

    const rawA = await request(app).get(`/api/v1/events/${groupA}/raw-events`).set("Cookie", a.cookie);
    expect(rawA.status).toBe(200);
    expect(rawA.body).toHaveLength(1);
    const crossRaw = await request(app).get(`/api/v1/events/${groupB}/raw-events`).set("Cookie", a.cookie);
    expect(crossRaw.status).toBe(404);

    // These aggregate queries join policies; without orgContextMiddleware on
    // the router they fail closed and return empty/zero for every tenant.
    const statsA = await request(app).get("/api/v1/events/stats").set("Cookie", a.cookie);
    expect(statsA.status).toBe(200);
    expect(statsA.body.totalGroups).toBe(1);
    expect(statsA.body.byPolicy.map((p: any) => p.policyId)).toEqual([a.policyId]);

    const statsB = await request(app).get("/api/v1/events/stats").set("Cookie", b.cookie);
    expect(statsB.status).toBe(200);
    expect(statsB.body.totalGroups).toBe(1);
    expect(statsB.body.byPolicy.map((p: any) => p.policyId)).toEqual([b.policyId]);
  });

  it("creates and lists SNMP rules only against the caller's own policies", async () => {
    const a = await setupOrgWithPolicy();
    const b = await setupOrgWithPolicy();

    // This POST used to 404 "Policy not found" for every org: the policy
    // lookup joins the RLS-protected policies table with no org context.
    const ruleA = await request(app)
      .post("/api/v1/snmp/rules")
      .set("Cookie", a.cookie)
      .send({ priority: 10, policyId: a.policyId, keyField: "orderId" });
    expect(ruleA.status).toBe(201);

    const ruleB = await request(app)
      .post("/api/v1/snmp/rules")
      .set("Cookie", b.cookie)
      .send({ priority: 20, policyId: b.policyId, keyField: "orderId" });
    expect(ruleB.status).toBe(201);

    const listA = await request(app).get("/api/v1/snmp/rules").set("Cookie", a.cookie);
    expect(listA.status).toBe(200);
    expect(listA.body.map((r: any) => r.id)).toEqual([ruleA.body.id]);

    const listB = await request(app).get("/api/v1/snmp/rules").set("Cookie", b.cookie);
    expect(listB.status).toBe(200);
    expect(listB.body.map((r: any) => r.id)).toEqual([ruleB.body.id]);

    const crossUpdate = await request(app)
      .put(`/api/v1/snmp/rules/${ruleB.body.id}`)
      .set("Cookie", a.cookie)
      .send({ priority: 99 });
    expect(crossUpdate.status).toBe(404);
  });
});
