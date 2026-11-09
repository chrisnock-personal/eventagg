import { describe, it, expect } from "vitest";
import crypto from "crypto";
import os from "os";
import path from "path";
import request from "supertest";
import app from "../app";
import { queryOne, runWithOrgContext } from "../db/pool";
import { encryptSecret, decryptSecret, needsReencrypt, resolveDataKeys } from "../services/secretBox";
import { getSmtpConfig } from "../services/smtpService";
import { createTestOrg, createTestUser, loginAs } from "./helpers";

describe("secretBox", () => {
  it("round-trips, with a fresh IV each time", () => {
    const a = encryptSecret("s3cret");
    const b = encryptSecret("s3cret");
    expect(a).toMatch(/^enc:v1:[0-9a-f]{8}:/);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("s3cret");
  });

  it("passes legacy plaintext through, and flags it for re-encryption", () => {
    expect(decryptSecret("old-plain")).toBe("old-plain");
    expect(needsReencrypt("old-plain")).toBe(true);
    expect(needsReencrypt(encryptSecret("x"))).toBe(false);
    expect(encryptSecret("")).toBe("");
  });

  it("rejects a tampered value (GCM authentication)", () => {
    const enc = encryptSecret("s3cret");
    const parts = enc.split(":");
    parts[5] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("resolves a rotation window from the env, and refuses to run keyless in production", () => {
    const k1 = crypto.randomBytes(32).toString("hex");
    const k2 = crypto.randomBytes(32).toString("hex");
    const r = resolveDataKeys(`${k1},${k2}`, "/nonexistent", true);
    expect(r.source).toBe("env");
    expect(r.keys).toHaveLength(2);
    expect(() => resolveDataKeys(undefined, path.join(os.tmpdir(), "no-such-data.key"), true)).toThrow(/No data encryption key/);
    expect(() => resolveDataKeys("abcd", "/nonexistent", false)).toThrow(/32 bytes/);
  });
});

describe("webhook secrets are write-only and encrypted at rest", () => {
  it("never returns the secret, stores it encrypted, and keeps/clears it on update", async () => {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, "admin");
    const cookie = await loginAs(app, admin.username, admin.password);

    const created = await request(app).post("/api/v1/webhooks").set("Cookie", cookie)
      .send({ name: "hook", url: "https://example.invalid/hook", secret: "hmac-key-123" });
    expect(created.status).toBe(201);
    expect(created.body.hasSecret).toBe(true);
    expect(JSON.stringify(created.body)).not.toContain("hmac-key-123");

    const stored = () => runWithOrgContext({ orgId: null, bypass: true }, () =>
      queryOne<{ secret: string }>(`SELECT secret FROM webhooks WHERE id = $1`, [created.body.id]));
    const first = (await stored())!.secret;
    expect(first).toMatch(/^enc:v1:/);
    expect(decryptSecret(first)).toBe("hmac-key-123");

    const list = await request(app).get("/api/v1/webhooks").set("Cookie", cookie);
    expect(JSON.stringify(list.body)).not.toContain("hmac-key-123");

    // No secret in the update: kept as it was.
    await request(app).put(`/api/v1/webhooks/${created.body.id}`).set("Cookie", cookie).send({ name: "renamed" });
    expect((await stored())!.secret).toBe(first);

    // "" removes it.
    const cleared = await request(app).put(`/api/v1/webhooks/${created.body.id}`).set("Cookie", cookie).send({ secret: "" });
    expect(cleared.body.hasSecret).toBe(false);
    expect((await stored())!.secret).toBe("");
  });
});

describe("SMTP password is write-only, encrypted, and instance-admin only", () => {
  it("hides the password, keeps it when omitted, and decrypts it for sending", async () => {
    const superadmin = await createTestUser(null, "superadmin");
    const cookie = await loginAs(app, superadmin.username, superadmin.password);
    const cfg = { host: "smtp.example.invalid", port: 587, secure: false, user: "mailer", from: "ag@example.invalid" };

    const put = await request(app).put("/api/v1/system/config/smtp").set("Cookie", cookie).send({ ...cfg, password: "mail-pass-9" });
    expect(put.status).toBe(200);

    const get = await request(app).get("/api/v1/system/config/smtp").set("Cookie", cookie);
    expect(get.body.hasPassword).toBe(true);
    expect(JSON.stringify(get.body)).not.toContain("mail-pass-9");

    const raw = await queryOne<{ value: { password: string } }>(`SELECT value FROM system_config WHERE key = 'smtp'`);
    expect(raw!.value.password).toMatch(/^enc:v1:/);

    // Saving without a password keeps the stored one.
    await request(app).put("/api/v1/system/config/smtp").set("Cookie", cookie).send({ ...cfg, host: "smtp2.example.invalid" });
    expect((await getSmtpConfig())?.password).toBe("mail-pass-9");
    expect((await getSmtpConfig())?.host).toBe("smtp2.example.invalid");
  });

  it("refuses an org editor", async () => {
    const org = await createTestOrg();
    const editor = await createTestUser(org.id, "editor");
    const cookie = await loginAs(app, editor.username, editor.password);
    expect((await request(app).get("/api/v1/system/config/smtp").set("Cookie", cookie)).status).toBe(403);
  });
});
