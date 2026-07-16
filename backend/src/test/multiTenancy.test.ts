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

describe("multi-tenancy isolation (HTTP)", () => {
  it("allows the same policy name across two different orgs", async () => {
    const orgA = await createTestOrg();
    const orgB = await createTestOrg();
    const adminA = await createTestUser(orgA.id, "admin");
    const adminB = await createTestUser(orgB.id, "admin");
    const cookieA = await loginAs(app, adminA.username, TEST_PASSWORD);
    const cookieB = await loginAs(app, adminB.username, TEST_PASSWORD);

    const sharedName = `Shared Policy ${randomUUID().slice(0, 8)}`;
    const resA = await request(app).post("/api/v1/policies").set("Cookie", cookieA).send(policyBody(sharedName));
    const resB = await request(app).post("/api/v1/policies").set("Cookie", cookieB).send(policyBody(sharedName));

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect(resA.body.id).not.toBe(resB.body.id);
  });

  it("never leaks one org's policies/events into another org's reads", async () => {
    const orgA = await createTestOrg();
    const orgB = await createTestOrg();
    const adminA = await createTestUser(orgA.id, "admin");
    const adminB = await createTestUser(orgB.id, "admin");
    const cookieA = await loginAs(app, adminA.username, TEST_PASSWORD);
    const cookieB = await loginAs(app, adminB.username, TEST_PASSWORD);

    const policyA = await request(app).post("/api/v1/policies").set("Cookie", cookieA)
      .send(policyBody(`Org A Policy ${randomUUID().slice(0, 8)}`));
    expect(policyA.status).toBe(201);

    const listAsB = await request(app).get("/api/v1/policies").set("Cookie", cookieB);
    expect(listAsB.status).toBe(200);
    expect(listAsB.body.find((p: any) => p.id === policyA.body.id)).toBeUndefined();

    const listAsA = await request(app).get("/api/v1/policies").set("Cookie", cookieA);
    expect(listAsA.body.find((p: any) => p.id === policyA.body.id)).toBeDefined();
  });

  it("keeps ingest groups isolated even with an identical aggregation key", async () => {
    const orgA = await createTestOrg();
    const orgB = await createTestOrg();
    const adminA = await createTestUser(orgA.id, "admin");
    const adminB = await createTestUser(orgB.id, "admin");
    const cookieA = await loginAs(app, adminA.username, TEST_PASSWORD);
    const cookieB = await loginAs(app, adminB.username, TEST_PASSWORD);

    const policyA = await request(app).post("/api/v1/policies").set("Cookie", cookieA)
      .send(policyBody(`Order Policy A ${randomUUID().slice(0, 8)}`));
    const policyB = await request(app).post("/api/v1/policies").set("Cookie", cookieB)
      .send(policyBody(`Order Policy B ${randomUUID().slice(0, 8)}`));

    const sharedKey = randomUUID();
    const ingestA = await request(app).post("/api/v1/events/ingest").set("X-API-Key", orgA.ingestApiKey)
      .send({ policyId: policyA.body.id, body: { eventType: "order.created", orderId: sharedKey } });
    const ingestB = await request(app).post("/api/v1/events/ingest").set("X-API-Key", orgB.ingestApiKey)
      .send({ policyId: policyB.body.id, body: { eventType: "order.created", orderId: sharedKey } });

    expect(ingestA.status).toBe(201);
    expect(ingestB.status).toBe(201);
    expect(ingestA.body.groupId).not.toBe(ingestB.body.groupId);
  });

  it("rejects an ingest key targeting another org's policy", async () => {
    const orgA = await createTestOrg();
    const orgB = await createTestOrg();
    const adminA = await createTestUser(orgA.id, "admin");
    const cookieA = await loginAs(app, adminA.username, TEST_PASSWORD);

    const policyA = await request(app).post("/api/v1/policies").set("Cookie", cookieA)
      .send(policyBody(`Order Policy ${randomUUID().slice(0, 8)}`));

    const res = await request(app).post("/api/v1/events/ingest").set("X-API-Key", orgB.ingestApiKey)
      .send({ policyId: policyA.body.id, body: { eventType: "order.created", orderId: randomUUID() } });

    expect(res.status).toBe(404);
  });

  it("rejects unauthenticated requests to org-scoped endpoints", async () => {
    const res = await request(app).get("/api/v1/policies");
    expect(res.status).toBe(401);
  });

  it("rejects superadmin on org-scoped endpoints with 403, not empty/all data", async () => {
    const superadmin = await createTestUser(null, "superadmin");
    const cookie = await loginAs(app, superadmin.username, TEST_PASSWORD);

    const res = await request(app).get("/api/v1/policies").set("Cookie", cookie);
    expect(res.status).toBe(403);
  });
});
