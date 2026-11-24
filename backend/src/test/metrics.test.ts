import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import app from "../app";
import { createTestOrg, createTestUser, loginAs, TEST_PASSWORD } from "./helpers";

async function setupOrgWithPolicy() {
  const org = await createTestOrg();
  const admin = await createTestUser(org.id, "admin");
  const cookie = await loginAs(app, admin.username, TEST_PASSWORD);
  const res = await request(app)
    .post("/api/v1/policies")
    .set("Cookie", cookie)
    .send({
      name: `Metrics policy ${randomUUID().slice(0, 8)}`,
      domain: "test.*",
      keyField: "orderId",
      cradleField: "eventType",
      cradleValue: "order.created",
      graveField: "eventType",
      graveValue: "order.delivered",
    });
  expect(res.status).toBe(201);
  return { org, policyId: res.body.id as string };
}

describe("Prometheus metrics", () => {
  it("serves default process and HTTP histogram metrics unauthenticated", async () => {
    // Generate at least one labelled observation before scraping.
    const health = await request(app).get("/health");
    expect(health.status).toBe(200);

    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("http_request_duration_seconds_bucket");
    expect(res.text).toContain('route="/health"');
    expect(res.text).toContain("process_cpu_user_seconds_total");
    expect(res.text).toContain("in_progress_groups");
  });

  it("also serves the scrape under the API prefix", async () => {
    const res = await request(app).get("/api/v1/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("http_request_duration_seconds");
  });

  it("counts ingests per policy and reports open groups on scrape", async () => {
    const { org, policyId } = await setupOrgWithPolicy();
    const orderId = randomUUID();
    const ingested = await request(app)
      .post("/api/v1/events/ingest")
      .set("X-API-Key", org.ingestApiKey)
      .send({ policyId, body: { eventType: "order.created", orderId } });
    expect(ingested.status).toBe(201);

    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);

    const counterLine = res.text.split("\n").find(
      (line) => line.startsWith("ingest_events_total{") && line.includes(`policy_id="${policyId}"`)
    );
    expect(counterLine).toBeDefined();
    expect(counterLine).toContain('outcome="group_opened"');
    expect(counterLine).toMatch(/\} 1(?:\.0+)?$/);

    const gaugeLine = res.text.split("\n").find((line) => line.startsWith("in_progress_groups "));
    expect(gaugeLine).toBeDefined();
    expect(Number(gaugeLine!.split(" ")[1])).toBeGreaterThanOrEqual(1);
  });
});
