import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../app";
import { createTestOrg, createTestUser, loginAs, TEST_PASSWORD } from "../test/helpers";

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
});
