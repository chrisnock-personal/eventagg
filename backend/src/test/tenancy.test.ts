import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../app";
import { createTestOrg, createTestUser, loginAs, TEST_PASSWORD } from "./helpers";
import { queryOne, runWithOrgContext } from "../db/pool";

describe("multi-tenancy enable flow", () => {
  it("promotes an org admin to superadmin and flips the flag, in one shot", async () => {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, "admin");
    const cookie = await loginAs(app, admin.username, TEST_PASSWORD);

    const res = await request(app)
      .post("/api/v1/system/tenancy/enable")
      .set("Cookie", cookie)
      .send({ password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ role: "superadmin", orgId: null });

    // Asserting raw DB state, not going through a request -needs bypass
    // now that `users` is RLS-protected (024), same as createTestUser.
    const row = await runWithOrgContext({ orgId: null, bypass: true }, () =>
      queryOne<{ role: string; org_id: string | null }>(
        `SELECT role, org_id FROM users WHERE id = $1`,
        [admin.id]
      )
    );
    expect(row).toMatchObject({ role: "superadmin", org_id: null });

    const flag = await queryOne<{ value: { enabled: boolean } }>(
      `SELECT value FROM system_config WHERE key = 'multi_tenancy'`
    );
    expect(flag?.value.enabled).toBe(true);
  });

  it("rejects enabling again once already enabled (one-way)", async () => {
    // Set the flag directly rather than relying on another test's side
    // effect, so this assertion doesn't depend on test ordering.
    const { query } = await import("../db/pool");
    await query(
      `INSERT INTO system_config (key, value) VALUES ('multi_tenancy', '{"enabled":true}')
       ON CONFLICT (key) DO UPDATE SET value = '{"enabled":true}'`
    );

    const org = await createTestOrg();
    const admin = await createTestUser(org.id, "admin");
    const cookie = await loginAs(app, admin.username, TEST_PASSWORD);

    const res = await request(app)
      .post("/api/v1/system/tenancy/enable")
      .set("Cookie", cookie)
      .send({ password: TEST_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already enabled/i);
  });

  it("rejects the wrong password", async () => {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, "admin");
    const cookie = await loginAs(app, admin.username, TEST_PASSWORD);

    const res = await request(app)
      .post("/api/v1/system/tenancy/enable")
      .set("Cookie", cookie)
      .send({ password: "wrong-password" });

    expect(res.status).toBe(401);
  });

  it("rejects non-admin roles (editor/viewer/superadmin can't call this)", async () => {
    const org = await createTestOrg();
    const editor = await createTestUser(org.id, "editor");
    const cookie = await loginAs(app, editor.username, TEST_PASSWORD);

    const res = await request(app)
      .post("/api/v1/system/tenancy/enable")
      .set("Cookie", cookie)
      .send({ password: TEST_PASSWORD });

    expect(res.status).toBe(403);
  });

  it("blocks the generic system_config route from touching the flag directly", async () => {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, "admin");
    const cookie = await loginAs(app, admin.username, TEST_PASSWORD);

    const res = await request(app)
      .put("/api/v1/system/config/multi_tenancy")
      .set("Cookie", cookie)
      .send({ enabled: true });

    expect(res.status).toBe(403);
  });
});
