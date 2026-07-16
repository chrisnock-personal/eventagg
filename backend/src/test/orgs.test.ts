import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import app from "../app";
import { createTestOrg, createTestUser, loginAs, TEST_PASSWORD } from "./helpers";

describe("organizations + global policies (superadmin)", () => {
  it("lets superadmin create a new org, and a regular admin reach it", async () => {
    const superadmin = await createTestUser(null, "superadmin");
    const superCookie = await loginAs(app, superadmin.username, TEST_PASSWORD);

    const res = await request(app)
      .post("/api/v1/orgs")
      .set("Cookie", superCookie)
      .send({ name: `Test Org via API ${randomUUID().slice(0, 8)}` });

    expect(res.status).toBe(201);
    expect(res.body.slug).toBeTruthy();
    expect(res.body.ingestApiKey).toBeTruthy();
  });

  it("rejects org CRUD from a regular admin (superadmin-only)", async () => {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, "admin");
    const cookie = await loginAs(app, admin.username, TEST_PASSWORD);

    const res = await request(app).get("/api/v1/orgs").set("Cookie", cookie);
    expect(res.status).toBe(403);
  });

  it("shows global policies to every org, read-only for non-superadmin", async () => {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, "admin");
    const cookie = await loginAs(app, admin.username, TEST_PASSWORD);

    const list = await request(app).get("/api/v1/policies").set("Cookie", cookie);
    expect(list.status).toBe(200);
    const globalPolicy = list.body.find((p: any) => p.isGlobal === true);
    expect(globalPolicy, "expected at least one global (org_id IS NULL) seed policy").toBeTruthy();

    const putRes = await request(app)
      .put(`/api/v1/policies/${globalPolicy.id}`)
      .set("Cookie", cookie)
      .send({ description: "trying to edit a global policy" });
    expect(putRes.status).toBe(404);

    const delRes = await request(app).delete(`/api/v1/policies/${globalPolicy.id}`).set("Cookie", cookie);
    expect(delRes.status).toBe(404);
  });

  it("lets superadmin edit global policies directly", async () => {
    const superadmin = await createTestUser(null, "superadmin");
    const superCookie = await loginAs(app, superadmin.username, TEST_PASSWORD);

    const list = await request(app).get("/api/v1/policies").set("Cookie", superCookie);
    expect(list.status).toBe(200);
    // Superadmin's list is global-only by design.
    expect(list.body.every((p: any) => p.isGlobal === true)).toBe(true);

    const target = list.body[0];
    const putRes = await request(app)
      .put(`/api/v1/policies/${target.id}`)
      .set("Cookie", superCookie)
      .send({ description: "updated by superadmin" });
    expect(putRes.status).toBe(200);
    expect(putRes.body.description).toBe("updated by superadmin");
  });

  it("moves a user between orgs, and promotes/demotes to superadmin", async () => {
    const superadmin = await createTestUser(null, "superadmin");
    const superCookie = await loginAs(app, superadmin.username, TEST_PASSWORD);
    const orgA = await createTestOrg();
    const orgB = await createTestOrg();
    const editor = await createTestUser(orgA.id, "editor");

    const moved = await request(app)
      .put(`/api/v1/orgs/users/${editor.id}`)
      .set("Cookie", superCookie)
      .send({ orgId: orgB.id });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ orgId: orgB.id, role: "editor" });

    const promoted = await request(app)
      .put(`/api/v1/orgs/users/${editor.id}`)
      .set("Cookie", superCookie)
      .send({ role: "superadmin" });
    expect(promoted.status).toBe(200);
    expect(promoted.body).toMatchObject({ role: "superadmin", orgId: null });

    // Demoting without specifying an org should fail — can't leave a
    // non-superadmin user with no org.
    const badDemote = await request(app)
      .put(`/api/v1/orgs/users/${editor.id}`)
      .set("Cookie", superCookie)
      .send({ role: "viewer" });
    expect(badDemote.status).toBe(400);

    const goodDemote = await request(app)
      .put(`/api/v1/orgs/users/${editor.id}`)
      .set("Cookie", superCookie)
      .send({ role: "viewer", orgId: orgA.id });
    expect(goodDemote.status).toBe(200);
    expect(goodDemote.body).toMatchObject({ role: "viewer", orgId: orgA.id });
  });
});
