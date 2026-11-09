import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { execSync } from "child_process";
import request from "supertest";
import app from "../app";
import { queryOne, runWithOrgContext } from "../db/pool";
import { createTestOrg, createTestUser, loginAs } from "./helpers";

// policies/users/audit_log are under FORCE ROW LEVEL SECURITY (migrations
// 023/024), which binds eventagg_user even as table owner. pg_dump refuses
// such tables under its default row_security=off, and psql's restored rows
// fail the policies' WITH CHECK unless app.bypass_rls is set, so both routes
// set it for their own connection. These tests prove a backup really contains
// RLS-protected rows and that a restore of it succeeds.

function collectText(res: NodeJS.ReadableStream, cb: (err: Error | null, body: string) => void) {
  let data = "";
  res.setEncoding("utf8");
  res.on("data", (chunk: string) => { data += chunk; });
  res.on("end", () => cb(null, data));
}

describe("Backup and restore with RLS-protected tables", () => {
  it("backs up rows from FORCE-RLS tables and restores them", async () => {
    const org = await createTestOrg();
    const policyName = `Backup RLS ${randomUUID().slice(0, 8)}`;
    await runWithOrgContext({ orgId: org.id, bypass: false }, () =>
      queryOne(
        `INSERT INTO policies (org_id, name, domain, key_field, cradle_field, cradle_value, grave_field, grave_value)
         VALUES ($1, $2, 'test.*', 'k', 'eventType', 'test.created', 'eventType', 'test.done')`,
        [org.id, policyName]
      )
    );

    const superadmin = await createTestUser(null, "superadmin");
    const cookie = await loginAs(app, superadmin.username, superadmin.password);

    const backup = await request(app)
      .post("/api/v1/admin/backup")
      .set("Cookie", cookie)
      .buffer(true)
      .parse(collectText);
    expect(backup.status).toBe(200);
    const dump = backup.body as string;
    expect(dump).toContain(policyName);           // policies (FORCE RLS)
    expect(dump).toContain(superadmin.username);  // users (FORCE RLS, org_id NULL)

    // The restore drops and recreates every table (--clean), including users,
    // so the superadmin's session must still verify afterwards: the JWT is
    // stateless and the user row comes back from the dump.
    const restore = await request(app)
      .post("/api/v1/admin/restore")
      .set("Cookie", cookie)
      .set("Content-Type", "application/sql")
      .send(dump);
    expect(restore.status, JSON.stringify(restore.body)).toBe(200);

    const row = await runWithOrgContext({ orgId: null, bypass: true }, () =>
      queryOne<{ name: string }>(`SELECT name FROM policies WHERE name = $1`, [policyName])
    );
    expect(row?.name).toBe(policyName);
  }, 120_000);

  // Helpers for the cases below: a policy to look for, and a superadmin.
  async function seedPolicy(): Promise<string> {
    const org = await createTestOrg();
    const name = `Backup RLS ${randomUUID().slice(0, 8)}`;
    await runWithOrgContext({ orgId: org.id, bypass: false }, () =>
      queryOne(
        `INSERT INTO policies (org_id, name, domain, key_field, cradle_field, cradle_value, grave_field, grave_value)
         VALUES ($1, $2, 'test.*', 'k', 'eventType', 'test.created', 'eventType', 'test.done')`,
        [org.id, name]
      )
    );
    return name;
  }
  async function policyExists(name: string): Promise<boolean> {
    const row = await runWithOrgContext({ orgId: null, bypass: true }, () =>
      queryOne<{ name: string }>(`SELECT name FROM policies WHERE name = $1`, [name])
    );
    return row?.name === name;
  }

  it("rolls a failed restore back completely instead of leaving the database half-restored", async () => {
    const before = await seedPolicy();
    const superadmin = await createTestUser(null, "superadmin");
    const cookie = await loginAs(app, superadmin.username, superadmin.password);

    const backup = await request(app).post("/api/v1/admin/backup").set("Cookie", cookie).buffer(true).parse(collectText);
    expect(backup.status).toBe(200);
    // Created after the backup: it must survive the failed restore (rolled
    // back), proving the schema wipe at the start was undone too.
    const after = await seedPolicy();

    const broken = (backup.body as string) + "\nSELECT * FROM no_such_table_in_this_dump;\n";
    const restore = await request(app).post("/api/v1/admin/restore").set("Cookie", cookie)
      .set("Content-Type", "application/sql").send(broken);
    expect(restore.status).toBe(500);

    expect(await policyExists(before)).toBe(true);
    expect(await policyExists(after)).toBe(true);
  }, 120_000);

  it("still restores an older --clean backup, partitions included", async () => {
    const name = await seedPolicy();
    const superadmin = await createTestUser(null, "superadmin");
    const cookie = await loginAs(app, superadmin.username, superadmin.password);

    // What /backup produced before: per-object DROPs, which on their own fail
    // on completed_events' partitions ("cannot drop inherited constraint").
    const legacy = execSync("pg_dump --clean --if-exists --enable-row-security", {
      env: { ...process.env, PGOPTIONS: "-c app.bypass_rls=true" },
      maxBuffer: 1024 * 1024 * 100,
    }).toString();
    expect(legacy).toMatch(/DROP CONSTRAINT IF EXISTS completed_events_\d{4}_q\d_pkey/);

    const restore = await request(app).post("/api/v1/admin/restore").set("Cookie", cookie)
      .set("Content-Type", "application/sql").send(legacy);
    expect(restore.status, JSON.stringify(restore.body)).toBe(200);
    expect(await policyExists(name)).toBe(true);
  }, 120_000);
});
