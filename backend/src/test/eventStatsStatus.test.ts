import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import app from "../app";
import { query, runWithOrgContext } from "../db/pool";
import { createTestOrg, createTestUser, loginAs, TEST_PASSWORD } from "./helpers";

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

// Stats are org-scoped and cached, so each test gets a fresh org (and cache key).
async function setupStatsFixtures() {
  const org = await createTestOrg();
  const admin = await createTestUser(org.id, "admin");
  const cookie = await loginAs(app, admin.username, TEST_PASSWORD);

  const policyRes = await request(app)
    .post("/api/v1/policies")
    .set("Cookie", cookie)
    .send({
      name: `Stats status policy ${randomUUID().slice(0, 8)}`,
      domain: "test.*",
      keyField: "orderId",
      cradleField: "eventType",
      cradleValue: "order.created",
      graveField: "eventType",
      graveValue: "order.delivered",
    });
  expect(policyRes.status).toBe(201);
  const policyId = policyRes.body.id as string;

  // Two open groups, one normally completed group and one timed-out group.
  // Each contributes to a different part of the completed store's breakdown.
  for (let n = 0; n < 2; n++) {
    await runWithOrgContext({ orgId: org.id, bypass: false }, () =>
      query(
        `INSERT INTO in_progress_events
           (org_id, policy_id, aggregation_key, key_field, raw_event_count, started_at)
         VALUES ($1, $2, $3, 'orderId', $4, now() - interval '1 hour')`,
        [org.id, policyId, `open-${randomUUID()}`, n + 2]
      )
    );
  }
  for (const status of ["completed", "timed_out"] as const) {
    const rawEventId = randomUUID();
    await runWithOrgContext({ orgId: org.id, bypass: false }, () =>
      query(
        `INSERT INTO completed_events
           (org_id, policy_id, aggregation_key, key_field, raw_event_count,
            cradle_raw_event_id, grave_raw_event_id, started_at, ended_at, status)
         VALUES ($1, $2, $3, 'orderId', $4, $5, $5,
                 now() - interval '2 hours', now() - interval '1 hour', $6)`,
        [org.id, policyId, `closed-${status}-${randomUUID()}`, 5, rawEventId, status]
      )
    );
  }

  return { cookie };
}

async function getStats(cookie: string[], status: string) {
  const res = await request(app)
    .get("/api/v1/events/stats")
    .query({ status, from: new Date(Date.now() - 7 * 86400000).toISOString() })
    .set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body;
}

describe("event stats status filter", () => {
  it("keeps byPolicy and throughput consistent with completed-only top-level counts", async () => {
    const { cookie } = await setupStatsFixtures();
    const stats = await getStats(cookie, "completed");

    expect(stats.totalGroups).toBe(2);
    expect(stats.inProgress).toBe(0);
    expect(stats.completed).toBe(1);
    expect(stats.timedOut).toBe(1);
    expect(stats.totalRawEvents).toBe(10);

    expect(sum(stats.byPolicy.map((p: any) => p.total))).toBe(stats.totalGroups);
    expect(sum(stats.byPolicy.map((p: any) => p.inProgress))).toBe(0);
    expect(sum(stats.byPolicy.map((p: any) => p.completed))).toBe(stats.completed);
    expect(sum(stats.byPolicy.map((p: any) => p.timedOut))).toBe(stats.timedOut);
    expect(sum(stats.byPolicy.map((p: any) => p.totalRawEvents))).toBe(stats.totalRawEvents);

    // Only groups in the completed store may be opened/closed in throughput.
    expect(sum(stats.throughput.map((b: any) => b.opened))).toBe(stats.totalGroups);
    expect(sum(stats.throughput.map((b: any) => b.closed))).toBe(stats.completed + stats.timedOut);
  });

  it("keeps byPolicy and throughput consistent with in-progress-only top-level counts", async () => {
    const { cookie } = await setupStatsFixtures();
    const stats = await getStats(cookie, "in_progress");

    expect(stats.totalGroups).toBe(2);
    expect(stats.inProgress).toBe(2);
    expect(stats.completed).toBe(0);
    expect(stats.timedOut).toBe(0);
    expect(stats.totalRawEvents).toBe(5);

    expect(sum(stats.byPolicy.map((p: any) => p.total))).toBe(stats.totalGroups);
    expect(sum(stats.byPolicy.map((p: any) => p.inProgress))).toBe(stats.inProgress);
    expect(sum(stats.byPolicy.map((p: any) => p.completed))).toBe(0);
    expect(sum(stats.byPolicy.map((p: any) => p.timedOut))).toBe(0);
    expect(sum(stats.byPolicy.map((p: any) => p.totalRawEvents))).toBe(stats.totalRawEvents);

    expect(sum(stats.throughput.map((b: any) => b.opened))).toBe(stats.totalGroups);
    expect(sum(stats.throughput.map((b: any) => b.closed))).toBe(0);
  });

  it("still includes both stores when status is all", async () => {
    const { cookie } = await setupStatsFixtures();
    const stats = await getStats(cookie, "all");

    expect(stats.totalGroups).toBe(4);
    expect(stats.inProgress).toBe(2);
    expect(stats.completed).toBe(1);
    expect(stats.timedOut).toBe(1);
    expect(sum(stats.byPolicy.map((p: any) => p.total))).toBe(stats.totalGroups);
    expect(sum(stats.throughput.map((b: any) => b.opened))).toBe(stats.totalGroups);
  });
});
