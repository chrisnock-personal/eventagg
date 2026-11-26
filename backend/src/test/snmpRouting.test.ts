import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import app from "../app";
import { query, queryOne, runWithOrgContext } from "../db/pool";
import { normalizeTrap, RawTrap, invalidateRoutingCache } from "../snmp/trapNormalizer";
import { ingestRawEvent } from "../services/ingestService";
import { createTestOrg, createTestUser, loginAs, TEST_PASSWORD } from "./helpers";

// Standard (non-AggreGator) trap OID -SNMPv2-MIB linkDown, used throughout
// as a stand-in for "some ordinary trap routed via snmp_routing_rules".
const LINK_DOWN_OID = "1.3.6.1.6.3.1.1.5.3";
const AG_TRAP_OID = "1.3.6.1.4.1.99999.2.1";
const AG_POLICY_ID_OID = "1.3.6.1.4.1.99999.4.1";
const AG_AGGREGATION_KEY_OID = "1.3.6.1.4.1.99999.4.2";

// In production, trapReceiver.ts's processTrap() establishes a bypass org
// context before calling normalizeTrap() -the dgram receiver has no
// request/session to derive org from ahead of time; org is resolved
// per-trap by normalizeTrap()'s own queries instead. Replicate that same
// context here since these tests call normalizeTrap() directly.
function callNormalizeTrap(trap: RawTrap) {
  return runWithOrgContext({ orgId: null, bypass: true }, () => normalizeTrap(trap));
}

function rawTrap(overrides: Partial<RawTrap> & { community: string }): RawTrap {
  return {
    sourceAddress: "10.0.0.1",
    trapOid: LINK_DOWN_OID,
    uptime: 12345,
    varbinds: [],
    version: 2,
    ...overrides,
  };
}

async function makePolicy(orgId: string, keyField = "orderId"): Promise<string> {
  // Fixture setup, not a real tenant action -bypass, since policies is
  // RLS-protected (023) and this helper is called with no ambient context.
  const row = await runWithOrgContext({ orgId: null, bypass: true }, () =>
    queryOne<{ id: string }>(
      `INSERT INTO policies (org_id, name, domain, key_field, cradle_field, cradle_value, grave_field, grave_value)
       VALUES ($1, $2, 'test.*', $3, 'eventType', 'test.created', 'eventType', 'test.done')
       RETURNING id`,
      [orgId, `SNMP Test Policy ${randomUUID().slice(0, 8)}`, keyField]
    )
  );
  if (!row) throw new Error("Failed to create test policy");
  return row.id;
}

async function makeRule(orgId: string, policyId: string, opts: { priority?: number; matchTrapOid?: string; matchCommunity?: string } = {}): Promise<void> {
  await query(
    `INSERT INTO snmp_routing_rules (org_id, priority, match_trap_oid, match_community, policy_id, key_field)
     VALUES ($1, $2, $3, $4, $5, 'sourceIp')`,
    [orgId, opts.priority ?? 100, opts.matchTrapOid ?? null, opts.matchCommunity ?? null, policyId]
  );
  invalidateRoutingCache();
}

describe("SNMP community-string org resolution", () => {
  it("resolves a real org from the community string alone, even with zero routing rules configured", async () => {
    const org = await createTestOrg();
    const trap = rawTrap({ community: org.snmpCommunity, trapOid: LINK_DOWN_OID });

    const result = await callNormalizeTrap(trap);

    expect(result.routeType).toBe("unrouted");
    expect(result.ingestInput).toBeNull();
    // The point of this phase: org identity doesn't depend on a rule/policy
    // match existing at all.
    expect(result.orgId).toBe(org.id);
  });

  it("scopes routing-rule matching to the resolved org, closing the cross-org matching bug", async () => {
    const orgA = await createTestOrg();
    const orgB = await createTestOrg();
    const policyA = await makePolicy(orgA.id);
    const policyB = await makePolicy(orgB.id);
    const sharedOid = `1.3.6.1.4.1.55555.${randomUUID().slice(0, 4)}`;

    // Org B's rule has a much better (lower) priority number and would win
    // an unscoped global search -proving scoping, not just priority, is
    // what keeps this correct.
    await makeRule(orgB.id, policyB, { priority: 1, matchTrapOid: sharedOid });
    await makeRule(orgA.id, policyA, { priority: 100, matchTrapOid: sharedOid });

    const trap = rawTrap({ community: orgA.snmpCommunity, trapOid: sharedOid });
    const result = await callNormalizeTrap(trap);

    expect(result.orgId).toBe(orgA.id);
    expect(result.routedTo).toBe(policyA);
  });

  it("rejects a standard trap whose community string isn't registered to any org, even if a wildcard rule would match", async () => {
    const org = await createTestOrg();
    const policy = await makePolicy(org.id);
    const unknownOid = `1.3.6.1.4.1.55555.${randomUUID().slice(0, 4)}`;
    await makeRule(org.id, policy, { matchTrapOid: unknownOid, matchCommunity: undefined });

    const trap = rawTrap({ community: `unregistered-${randomUUID().slice(0, 8)}`, trapOid: unknownOid });
    const result = await callNormalizeTrap(trap);

    // This used to fall back to an unscoped search across every org's
    // rules: no credential needed at all.
    expect(result.routeType).toBe("rejected");
    expect(result.ingestInput).toBeNull();
    expect(result.orgId).toBeNull();
  });

  it("rejects an AggreGator MIB trap naming a real policy when the community string is unknown", async () => {
    const org = await createTestOrg();
    const policyId = await makePolicy(org.id, "tradeRef");

    const trap = rawTrap({
      community: "public",
      trapOid: AG_TRAP_OID,
      varbinds: [
        { oid: AG_POLICY_ID_OID, value: policyId },
        { oid: AG_AGGREGATION_KEY_OID, value: "TR-789" },
      ],
    });

    const result = await callNormalizeTrap(trap);

    expect(result.routeType).toBe("rejected");
    expect(result.ingestInput).toBeNull();
  });

  it("no org keeps the well-known 'public' community after migration 026", async () => {
    const row = await runWithOrgContext({ orgId: null, bypass: true }, () =>
      queryOne<{ n: string }>(`SELECT count(*)::text AS n FROM organisations WHERE snmp_community IN ('public', 'private')`)
    );
    expect(row?.n).toBe("0");
  });

  it("AggreGator MIB trap: community-resolved org disagreeing with the policy's own org is dropped as unrouted, but still attributed to the community's org", async () => {
    const orgA = await createTestOrg();
    const orgB = await createTestOrg();
    const policyB = await makePolicy(orgB.id, "tradeRef");

    const trap = rawTrap({
      community: orgA.snmpCommunity, // org A's community...
      trapOid: AG_TRAP_OID,
      varbinds: [
        { oid: AG_POLICY_ID_OID, value: policyB }, // ...but referencing org B's policy
        { oid: AG_AGGREGATION_KEY_OID, value: "TR-123" },
      ],
    });

    const result = await callNormalizeTrap(trap);

    expect(result.routeType).toBe("unrouted");
    expect(result.ingestInput).toBeNull();
    expect(result.orgId).toBe(orgA.id);
  });

  it("AggreGator MIB trap: community-resolved org agreeing with the policy's org routes normally", async () => {
    const org = await createTestOrg();
    const policyId = await makePolicy(org.id, "tradeRef");

    const trap = rawTrap({
      community: org.snmpCommunity,
      trapOid: AG_TRAP_OID,
      varbinds: [
        { oid: AG_POLICY_ID_OID, value: policyId },
        { oid: AG_AGGREGATION_KEY_OID, value: "TR-456" },
      ],
    });

    const result = await callNormalizeTrap(trap);

    expect(result.routeType).toBe("aggregator_mib");
    expect(result.orgId).toBe(org.id);
    expect(result.ingestInput).toMatchObject({ policyId });
  });
});

describe("SNMP policy keyField cache invalidation on policy edits", () => {
  const AG_KEY = "TR-CACHE-1";

  function cachedPolicyTrap(org: { snmpCommunity: string }, policyId: string): RawTrap {
    return rawTrap({
      community: org.snmpCommunity,
      trapOid: AG_TRAP_OID,
      varbinds: [
        { oid: AG_POLICY_ID_OID, value: policyId },
        { oid: AG_AGGREGATION_KEY_OID, value: AG_KEY },
      ],
    });
  }

  async function setupRoutePolicy() {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, "admin");
    const cookie = await loginAs(app, admin.username, TEST_PASSWORD);
    const res = await request(app)
      .post("/api/v1/policies")
      .set("Cookie", cookie)
      .send({
        name: `SNMP cache policy ${randomUUID().slice(0, 8)}`,
        domain: "test.*",
        keyField: "orderId",
        cradleField: "eventType",
        cradleValue: "order.created",
        graveField: "eventType",
        graveValue: "order.done",
      });
    expect(res.status).toBe(201);
    return { org, cookie, policyId: res.body.id as string };
  }

  it("uses the edited keyField for subsequent traps instead of the cached one", async () => {
    const { org, cookie, policyId } = await setupRoutePolicy();
    const trap = cachedPolicyTrap(org, policyId);

    // First trap caches { keyField: "orderId", orgId }.
    const before = await callNormalizeTrap(trap);
    expect(before.ingestInput?.body).toMatchObject({ orderId: AG_KEY });

    const update = await request(app)
      .put(`/api/v1/policies/${policyId}`)
      .set("Cookie", cookie)
      .send({ keyField: "tradeRef" });
    expect(update.status).toBe(200);
    expect(update.body.keyField).toBe("tradeRef");

    const after = await callNormalizeTrap(trap);
    expect(after.routeType).toBe("aggregator_mib");
    expect(after.ingestInput?.body).toMatchObject({ tradeRef: AG_KEY });
    expect(after.ingestInput?.body).not.toHaveProperty("orderId");

    // ingestRawEvent reads the policy fresh: a stale keyField here used to
    // fail with "Could not resolve aggregation key from body.orderId".
    const ingested = await runWithOrgContext({ orgId: org.id, bypass: false }, () =>
      ingestRawEvent(org.id, after.ingestInput!)
    );
    expect(ingested.aggregationKey).toBe(AG_KEY);
  });

  it("drops the cached policy on toggle and delete so inactive policies are not routed", async () => {
    const { org, cookie, policyId } = await setupRoutePolicy();
    const trap = cachedPolicyTrap(org, policyId);

    expect((await callNormalizeTrap(trap)).routeType).toBe("aggregator_mib");

    const deactivate = await request(app)
      .patch(`/api/v1/policies/${policyId}/toggle`)
      .set("Cookie", cookie)
      .send({ active: false });
    expect(deactivate.status).toBe(200);
    const inactive = await callNormalizeTrap(trap);
    expect(inactive.routeType).toBe("unrouted");
    expect(inactive.ingestInput).toBeNull();

    const reactivate = await request(app)
      .patch(`/api/v1/policies/${policyId}/toggle`)
      .set("Cookie", cookie)
      .send({ active: true });
    expect(reactivate.status).toBe(200);
    const active = await callNormalizeTrap(trap);
    expect(active.routeType).toBe("aggregator_mib");
    expect(active.ingestInput?.body).toMatchObject({ orderId: AG_KEY });

    const remove = await request(app).delete(`/api/v1/policies/${policyId}`).set("Cookie", cookie);
    expect(remove.status).toBe(204);
    const deleted = await callNormalizeTrap(trap);
    expect(deleted.routeType).toBe("unrouted");
    expect(deleted.ingestInput).toBeNull();
  });
});
