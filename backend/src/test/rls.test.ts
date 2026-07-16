import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import app from "../app";
import { query, runWithOrgContext } from "../db/pool";
import { createTestOrg, createTestUser, TEST_PASSWORD } from "./helpers";

// These tests deliberately bypass the service layer entirely — the point of
// RLS is that even a raw, unscoped query against a protected table can't
// leak another org's rows. Every other test in this suite goes through
// policyService/routes, which already scope correctly; these prove the
// database-level backstop works independently of that application code.

async function makePolicy(orgId: string | null, name: string) {
  await query(
    `INSERT INTO policies (org_id, name, domain, key_field, cradle_field, cradle_value, grave_field, grave_value)
     VALUES ($1, $2, 'test.*', 'k', 'eventType', 'test.created', 'eventType', 'test.done')`,
    [orgId, name]
  );
}

describe("Postgres RLS backstop on policies", () => {
  it("an unscoped query only returns the current org's rows + global rows, never another org's", async () => {
    const orgA = await createTestOrg();
    const orgB = await createTestOrg();
    const nameA = `RLS Test A ${randomUUID().slice(0, 8)}`;
    const nameB = `RLS Test B ${randomUUID().slice(0, 8)}`;
    const nameGlobal = `RLS Test Global ${randomUUID().slice(0, 8)}`;

    await runWithOrgContext({ orgId: orgA.id, bypass: false }, async () => {
      await makePolicy(orgA.id, nameA);
    });
    await runWithOrgContext({ orgId: orgB.id, bypass: false }, async () => {
      await makePolicy(orgB.id, nameB);
    });
    // Only superadmin (bypass) can write a global policy — WITH CHECK
    // rejects org_id IS NULL from a regular org context (proven separately
    // below), so this insert has to happen under bypass.
    await runWithOrgContext({ orgId: null, bypass: true }, async () => {
      await makePolicy(null, nameGlobal);
    });

    // No WHERE clause at all — RLS is the only thing keeping this scoped.
    const seenAsOrgA = await runWithOrgContext({ orgId: orgA.id, bypass: false }, () =>
      query<{ name: string }>(`SELECT name FROM policies WHERE name IN ($1, $2, $3)`, [nameA, nameB, nameGlobal])
    );
    const names = seenAsOrgA.map((r) => r.name).sort();
    expect(names).toEqual([nameA, nameGlobal].sort());
    expect(names).not.toContain(nameB);
  });

  it("fails closed: no org context at all means zero rows, not every org's rows", async () => {
    const org = await createTestOrg();
    const name = `RLS Fail Closed ${randomUUID().slice(0, 8)}`;
    await runWithOrgContext({ orgId: org.id, bypass: false }, async () => {
      await makePolicy(org.id, name);
    });

    // Deliberately outside runWithOrgContext — no context established at all.
    const rows = await query<{ name: string }>(`SELECT name FROM policies WHERE name = $1`, [name]);
    expect(rows).toEqual([]);
  });

  it("bypass context (superadmin/background jobs) sees every org's rows", async () => {
    const orgA = await createTestOrg();
    const orgB = await createTestOrg();
    const nameA = `RLS Bypass A ${randomUUID().slice(0, 8)}`;
    const nameB = `RLS Bypass B ${randomUUID().slice(0, 8)}`;

    await runWithOrgContext({ orgId: orgA.id, bypass: false }, async () => {
      await makePolicy(orgA.id, nameA);
    });
    await runWithOrgContext({ orgId: orgB.id, bypass: false }, async () => {
      await makePolicy(orgB.id, nameB);
    });

    const seenAsBypass = await runWithOrgContext({ orgId: null, bypass: true }, () =>
      query<{ name: string }>(`SELECT name FROM policies WHERE name IN ($1, $2)`, [nameA, nameB])
    );
    expect(seenAsBypass.map((r) => r.name).sort()).toEqual([nameA, nameB].sort());
  });

  it("WITH CHECK rejects a regular org context trying to write a global (org_id NULL) row", async () => {
    const org = await createTestOrg();
    const name = `RLS Check Reject ${randomUUID().slice(0, 8)}`;

    await expect(
      runWithOrgContext({ orgId: org.id, bypass: false }, () => makePolicy(null, name))
    ).rejects.toThrow();

    // Confirm nothing was actually written (even under bypass, to rule out
    // a partial/rolled-back write rather than a clean rejection).
    const rows = await runWithOrgContext({ orgId: null, bypass: true }, () =>
      query<{ name: string }>(`SELECT name FROM policies WHERE name = $1`, [name])
    );
    expect(rows).toEqual([]);
  });

  it("WITH CHECK rejects writing into a different org than the current context", async () => {
    const orgA = await createTestOrg();
    const orgB = await createTestOrg();
    const name = `RLS Check Cross Org ${randomUUID().slice(0, 8)}`;

    await expect(
      runWithOrgContext({ orgId: orgA.id, bypass: false }, () => makePolicy(orgB.id, name))
    ).rejects.toThrow();
  });
});

// Unlike policies, org_id IS NULL on `users`/`audit_log` means "superadmin" /
// "a superadmin's own action" — NOT "visible to everyone". So there's no
// global-row branch to prove here; a regular org context must see neither
// another org's rows nor the superadmin's.
describe("Postgres RLS backstop on users", () => {
  it("an unscoped query only returns the current org's rows, never another org's or superadmin's", async () => {
    const orgA = await createTestOrg();
    const orgB = await createTestOrg();
    const userA = await createTestUser(orgA.id, "admin");
    const userB = await createTestUser(orgB.id, "admin");
    const superadmin = await createTestUser(null, "superadmin");

    const seenAsOrgA = await runWithOrgContext({ orgId: orgA.id, bypass: false }, () =>
      query<{ id: string }>(`SELECT id FROM users WHERE id IN ($1, $2, $3)`, [userA.id, userB.id, superadmin.id])
    );
    expect(seenAsOrgA.map((r) => r.id)).toEqual([userA.id]);
  });

  it("fails closed: no org context at all means zero rows", async () => {
    const org = await createTestOrg();
    const user = await createTestUser(org.id, "admin");

    const rows = await query<{ id: string }>(`SELECT id FROM users WHERE id = $1`, [user.id]);
    expect(rows).toEqual([]);
  });

  it("bypass context sees every org's users + superadmin", async () => {
    const orgA = await createTestOrg();
    const orgB = await createTestOrg();
    const userA = await createTestUser(orgA.id, "admin");
    const userB = await createTestUser(orgB.id, "admin");
    const superadmin = await createTestUser(null, "superadmin");

    const seenAsBypass = await runWithOrgContext({ orgId: null, bypass: true }, () =>
      query<{ id: string }>(`SELECT id FROM users WHERE id IN ($1, $2, $3)`, [userA.id, userB.id, superadmin.id])
    );
    expect(seenAsBypass.map((r) => r.id).sort()).toEqual([userA.id, userB.id, superadmin.id].sort());
  });

  it("login has no session yet but still succeeds — regression test for the bypass wrap on POST /login", async () => {
    // Authenticating by username is a cross-org lookup before any org is
    // known; if the bypass wrap on the login handler were missing, RLS
    // would fail this closed and every login would 401.
    const org = await createTestOrg();
    const user = await createTestUser(org.id, "admin");

    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ username: user.username, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: user.username, orgId: org.id });
  });
});

describe("Postgres RLS backstop on audit_log", () => {
  async function insertAuditEntry(orgId: string | null, entityId: string) {
    await query(
      `INSERT INTO audit_log (org_id, entity_type, entity_id, action) VALUES ($1, 'user', $2, 'user.login')`,
      [orgId, entityId]
    );
  }

  it("an unscoped query only returns the current org's rows, never another org's or superadmin's", async () => {
    const orgA = await createTestOrg();
    const orgB = await createTestOrg();
    const idA = randomUUID();
    const idB = randomUUID();
    const idSuper = randomUUID();

    await runWithOrgContext({ orgId: orgA.id, bypass: false }, () => insertAuditEntry(orgA.id, idA));
    await runWithOrgContext({ orgId: orgB.id, bypass: false }, () => insertAuditEntry(orgB.id, idB));
    await runWithOrgContext({ orgId: null, bypass: true }, () => insertAuditEntry(null, idSuper));

    const seenAsOrgA = await runWithOrgContext({ orgId: orgA.id, bypass: false }, () =>
      query<{ entity_id: string }>(`SELECT entity_id FROM audit_log WHERE entity_id IN ($1, $2, $3)`, [idA, idB, idSuper])
    );
    expect(seenAsOrgA.map((r) => r.entity_id)).toEqual([idA]);
  });

  it("fails closed: no org context at all means zero rows", async () => {
    const org = await createTestOrg();
    const id = randomUUID();
    await runWithOrgContext({ orgId: org.id, bypass: false }, () => insertAuditEntry(org.id, id));

    const rows = await query<{ entity_id: string }>(`SELECT entity_id FROM audit_log WHERE entity_id = $1`, [id]);
    expect(rows).toEqual([]);
  });

  it("bypass context sees every org's entries + superadmin's", async () => {
    const orgA = await createTestOrg();
    const orgB = await createTestOrg();
    const idA = randomUUID();
    const idB = randomUUID();

    await runWithOrgContext({ orgId: orgA.id, bypass: false }, () => insertAuditEntry(orgA.id, idA));
    await runWithOrgContext({ orgId: orgB.id, bypass: false }, () => insertAuditEntry(orgB.id, idB));

    const seenAsBypass = await runWithOrgContext({ orgId: null, bypass: true }, () =>
      query<{ entity_id: string }>(`SELECT entity_id FROM audit_log WHERE entity_id IN ($1, $2)`, [idA, idB])
    );
    expect(seenAsBypass.map((r) => r.entity_id).sort()).toEqual([idA, idB].sort());
  });

  it("WITH CHECK rejects a regular org context trying to write a superadmin (org_id NULL) entry", async () => {
    const org = await createTestOrg();
    const id = randomUUID();

    await expect(
      runWithOrgContext({ orgId: org.id, bypass: false }, () => insertAuditEntry(null, id))
    ).rejects.toThrow();
  });

  it("logging in writes an audit_log entry despite login having no ambient org context", async () => {
    const org = await createTestOrg();
    const user = await createTestUser(org.id, "admin");

    await request(app).post("/api/v1/auth/login").send({ username: user.username, password: TEST_PASSWORD });

    // audit() is fire-and-forget — give its query a tick to land.
    await new Promise((r) => setTimeout(r, 50));

    const rows = await runWithOrgContext({ orgId: null, bypass: true }, () =>
      query<{ action: string }>(`SELECT action FROM audit_log WHERE entity_id = $1 AND action = 'user.login'`, [user.id])
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});
