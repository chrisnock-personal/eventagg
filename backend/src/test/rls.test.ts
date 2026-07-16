import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { query, runWithOrgContext } from "../db/pool";
import { createTestOrg } from "./helpers";

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
