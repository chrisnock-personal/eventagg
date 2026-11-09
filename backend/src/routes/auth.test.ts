import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../app";
import { createTestOrg, createTestUser, loginAs, TEST_PASSWORD } from "../test/helpers";
import { query, runWithOrgContext } from "../db/pool";

describe("auth routes", () => {
  it("logs in successfully and returns the session shape including orgId", async () => {
    const org = await createTestOrg();
    const user = await createTestUser(org.id, "admin");

    const res = await request(app).post("/api/v1/auth/login").send({ username: user.username, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeDefined();
    expect(res.body).toMatchObject({
      username: user.username,
      role: "admin",
      orgId: org.id,
    });
  });

  it("rejects an invalid password", async () => {
    const org = await createTestOrg();
    const user = await createTestUser(org.id, "admin");

    const res = await request(app).post("/api/v1/auth/login").send({ username: user.username, password: "wrong-password" });

    expect(res.status).toBe(401);
  });

  it("round-trips orgId through the JWT via GET /me", async () => {
    const org = await createTestOrg();
    const user = await createTestUser(org.id, "editor");
    const cookie = await loginAs(app, user.username, TEST_PASSWORD);

    const res = await request(app).get("/api/v1/auth/me").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: user.username, role: "editor", orgId: org.id });
  });

  it("requireAuth rejects requests with no session cookie", async () => {
    const res = await request(app).get("/api/v1/auth/me");
    expect(res.status).toBe(401);
  });

  it("requireAuth rejects a garbage cookie value", async () => {
    const res = await request(app).get("/api/v1/auth/me").set("Cookie", "ag_session=not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("requireRole rejects a viewer from an admin-only route", async () => {
    const org = await createTestOrg();
    const viewer = await createTestUser(org.id, "viewer");
    const cookie = await loginAs(app, viewer.username, TEST_PASSWORD);

    const res = await request(app).get("/api/v1/auth/users").set("Cookie", cookie);
    expect(res.status).toBe(403);
  });

  it("change-password rejects the wrong current password, then succeeds with the right one", async () => {
    const org = await createTestOrg();
    const user = await createTestUser(org.id, "admin");
    const cookie = await loginAs(app, user.username, TEST_PASSWORD);

    const wrong = await request(app).post("/api/v1/auth/change-password").set("Cookie", cookie)
      .send({ currentPassword: "definitely-wrong", newPassword: "new-password-456" });
    expect(wrong.status).toBe(400);

    const right = await request(app).post("/api/v1/auth/change-password").set("Cookie", cookie)
      .send({ currentPassword: TEST_PASSWORD, newPassword: "new-password-456" });
    expect(right.status).toBe(200);

    const reLogin = await request(app).post("/api/v1/auth/login").send({ username: user.username, password: "new-password-456" });
    expect(reLogin.status).toBe(200);
  });

  describe("pending first-login password change", () => {
    async function pendingUser() {
      const org = await createTestOrg();
      const user = await createTestUser(org.id, "admin");
      await runWithOrgContext({ orgId: null, bypass: true }, () =>
        query(`UPDATE users SET password_changed = FALSE WHERE id = $1`, [user.id])
      );
      const cookie = await loginAs(app, user.username, TEST_PASSWORD);
      return { user, cookie };
    }

    it("blocks every other API route server-side, not just in the UI", async () => {
      const { cookie } = await pendingUser();

      const res = await request(app).get("/api/v1/policies").set("Cookie", cookie);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("PASSWORD_CHANGE_REQUIRED");

      // Bearer tokens are held to the same rule as the cookie.
      const token = /ag_session=([^;]+)/.exec(cookie.join(";"))![1];
      const bearer = await request(app).get("/api/v1/auth/users").set("Authorization", `Bearer ${token}`);
      expect(bearer.status).toBe(403);
    });

    it("still allows /me, change-password and logout", async () => {
      const { cookie } = await pendingUser();

      const me = await request(app).get("/api/v1/auth/me").set("Cookie", cookie);
      expect(me.status).toBe(200);
      expect(me.body.passwordChanged).toBe(false);

      const logout = await request(app).post("/api/v1/auth/logout").set("Cookie", cookie);
      expect(logout.status).toBe(204);
    });

    it("re-issues the session after the change, so the user isn't stuck until re-login", async () => {
      const { cookie } = await pendingUser();

      const changed = await request(app).post("/api/v1/auth/change-password").set("Cookie", cookie)
        .send({ currentPassword: TEST_PASSWORD, newPassword: "new-password-456" });
      expect(changed.status).toBe(200);
      const newCookie = changed.headers["set-cookie"] as unknown as string[];
      expect(newCookie).toBeDefined();

      const me = await request(app).get("/api/v1/auth/me").set("Cookie", newCookie);
      expect(me.body.passwordChanged).toBe(true);
      const res = await request(app).get("/api/v1/policies").set("Cookie", newCookie);
      expect(res.status).toBe(200);
    });
  });
});
