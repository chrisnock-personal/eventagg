import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import type { Express } from "express";
import { query, runWithOrgContext } from "../db/pool";
import { SYSTEM_ENTITY_ID } from "../services/auditService";
import { createTestOrg, createTestUser, loginAs } from "./helpers";

// Certificates made with openssl (Node can't create X.509 certificates).
// The routes read TLS_CERT_DIR at import, so app is imported after it's set.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eventagg-tls-"));
process.env.TLS_CERT_DIR = path.join(dir, "certs");

function openssl(...args: string[]) {
  execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
}
const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");

let app: Express;
let validateUpload: typeof import("../routes/tls").validateUpload;

interface TlsAuditRow {
  action: string;
  actor: string | null;
  org_id: string | null;
  entity_id: string;
  after_state: string | null;
}

// audit() is fire-and-forget and audit_log is RLS-protected, so read back
// under bypass and poll briefly for the row to land.
async function tlsAuditRows(actor: string): Promise<TlsAuditRow[]> {
  return runWithOrgContext({ orgId: null, bypass: true }, () =>
    query<TlsAuditRow>(
      `SELECT action, actor, org_id, entity_id, after_state::text AS after_state
         FROM audit_log
        WHERE actor = $1
          AND action IN ('tls.certificate_uploaded', 'tls.certificate_reset')
        ORDER BY event_time DESC`,
      [actor]
    )
  );
}

async function waitForTlsAudit(actor: string, minRows: number): Promise<TlsAuditRow[]> {
  for (let i = 0; i < 50; i++) {
    const rows = await tlsAuditRows(actor);
    if (rows.length >= minRows) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return tlsAuditRows(actor);
}

beforeAll(async () => {
  fs.mkdirSync(path.join(dir, "certs", "staged"), { recursive: true });
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  // A CA, an intermediate signed by it, and a server leaf signed by the intermediate.
  openssl("req", "-x509", ...ec, "-days", "30", "-subj", "/CN=Test Root", "-keyout", "ca.key", "-out", "ca.crt",
    "-addext", "basicConstraints=critical,CA:TRUE");
  openssl("req", ...ec, "-subj", "/CN=Test Intermediate", "-keyout", "int.key", "-out", "int.csr");
  fs.writeFileSync(path.join(dir, "int.ext"), "basicConstraints=critical,CA:TRUE\n");
  openssl("x509", "-req", "-in", "int.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "30",
    "-extfile", "int.ext", "-out", "int.crt");
  openssl("req", ...ec, "-subj", "/CN=eventagg.test", "-keyout", "leaf.key", "-out", "leaf.csr");
  fs.writeFileSync(path.join(dir, "leaf.ext"), "basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:eventagg.test\n");
  openssl("x509", "-req", "-in", "leaf.csr", "-CA", "int.crt", "-CAkey", "int.key", "-CAcreateserial", "-days", "30",
    "-extfile", "leaf.ext", "-out", "leaf.crt");
  // An unrelated key, to mismatch.
  openssl("genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-out", "other.key");

  ({ validateUpload } = await import("../routes/tls"));
  app = (await import("../app")).default;
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("TLS certificate upload validation", () => {
  it("accepts a leaf with its key and a correctly ordered chain", () => {
    const { cert, fullchain } = validateUpload(read("leaf.crt"), read("leaf.key"), read("int.crt") + read("ca.crt"));
    expect(cert.subject).toContain("eventagg.test");
    expect(fullchain.match(/BEGIN CERTIFICATE/g)).toHaveLength(3);
  });

  it("accepts the chain inside the certificate file too", () => {
    expect(() => validateUpload(read("leaf.crt") + read("int.crt"), read("leaf.key"))).not.toThrow();
  });

  it("rejects a key that doesn't match the certificate", () => {
    expect(() => validateUpload(read("leaf.crt"), read("other.key"))).toThrow(/doesn't match/);
  });

  it("rejects a chain in the wrong order", () => {
    expect(() => validateUpload(read("leaf.crt"), read("leaf.key"), read("ca.crt") + read("int.crt"))).toThrow(/out of order/);
  });

  it("rejects a CA certificate as the server certificate", () => {
    expect(() => validateUpload(read("ca.crt"), read("ca.key"))).toThrow(/CA certificate/);
  });

  it("rejects things that aren't PEM", () => {
    expect(() => validateUpload("hello", read("leaf.key"))).toThrow(/isn't a PEM certificate/);
    expect(() => validateUpload(read("leaf.crt"), "not a key")).toThrow(/can't be parsed/);
  });
});

describe("TLS routes", () => {
  it("stage a valid upload for the watcher, and only for an instance admin", async () => {
    const superadmin = await createTestUser(null, "superadmin");
    const cookie = await loginAs(app, superadmin.username, superadmin.password);

    const res = await request(app).post("/api/v1/system/tls").set("Cookie", cookie)
      .send({ cert: read("leaf.crt"), key: read("leaf.key"), chain: read("int.crt") });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const staged = path.join(dir, "certs", "staged");
    expect(fs.existsSync(path.join(staged, "ready"))).toBe(true);
    expect(fs.statSync(path.join(staged, "server.key")).mode & 0o777).toBe(0o600);

    const bad = await request(app).post("/api/v1/system/tls").set("Cookie", cookie)
      .send({ cert: read("leaf.crt"), key: read("other.key") });
    expect(bad.status).toBe(400);
  });

  it("refuses an editor", async () => {
    const org = await createTestOrg();
    const editor = await createTestUser(org.id, "editor");
    const cookie = await loginAs(app, editor.username, editor.password);
    expect((await request(app).get("/api/v1/system/tls").set("Cookie", cookie)).status).toBe(403);
    expect((await request(app).post("/api/v1/system/tls").set("Cookie", cookie)
      .send({ cert: read("leaf.crt"), key: read("leaf.key") })).status).toBe(403);
    expect((await request(app).delete("/api/v1/system/tls").set("Cookie", cookie)).status).toBe(403);
  });

  it("writes audit rows for both upload and reset as a superadmin", async () => {
    const superadmin = await createTestUser(null, "superadmin");
    const cookie = await loginAs(app, superadmin.username, superadmin.password);

    const upload = await request(app).post("/api/v1/system/tls").set("Cookie", cookie)
      .send({ cert: read("leaf.crt"), key: read("leaf.key") });
    expect(upload.status, JSON.stringify(upload.body)).toBe(202);

    const reset = await request(app).delete("/api/v1/system/tls").set("Cookie", cookie);
    expect(reset.status, JSON.stringify(reset.body)).toBe(202);

    const rows = await waitForTlsAudit(superadmin.username, 2);
    expect(rows.map((r) => r.action).sort()).toEqual(["tls.certificate_reset", "tls.certificate_uploaded"]);
    for (const row of rows) {
      expect(row.entity_id).toBe(SYSTEM_ENTITY_ID);
      expect(row.org_id).toBeNull(); // superadmin actions live outside any org
    }
    const uploaded = rows.find((r) => r.action === "tls.certificate_uploaded")!;
    expect(JSON.parse(uploaded.after_state!)).toMatchObject({
      fingerprint256: upload.body.uploaded.fingerprint256,
    });
  });

  it("writes an org-scoped audit row for an instance admin before multi-tenancy", async () => {
    // The tenancy flag is a one-way, suite-wide setting; clear it just long
    // enough to exercise the single-tenant instance-admin case, then restore.
    const previous = await query<{ value: { enabled: boolean } }>(
      `SELECT value FROM system_config WHERE key = 'multi_tenancy'`
    );
    await query(
      `INSERT INTO system_config (key, value) VALUES ('multi_tenancy', '{"enabled":false}')
       ON CONFLICT (key) DO UPDATE SET value = '{"enabled":false}'`
    );
    try {
      const org = await createTestOrg();
      const admin = await createTestUser(org.id, "admin");
      const cookie = await loginAs(app, admin.username, admin.password);

      const res = await request(app).post("/api/v1/system/tls").set("Cookie", cookie)
        .send({ cert: read("leaf.crt"), key: read("leaf.key") });
      expect(res.status, JSON.stringify(res.body)).toBe(202);

      const rows = await waitForTlsAudit(admin.username, 1);
      expect(rows[0]).toMatchObject({
        action: "tls.certificate_uploaded",
        org_id: org.id,
        entity_id: SYSTEM_ENTITY_ID,
      });

      // The same admin can see it through the normal (org-scoped) audit API.
      const auditApi = await request(app)
        .get("/api/v1/audit?action=tls.certificate_uploaded")
        .set("Cookie", cookie);
      expect(auditApi.status).toBe(200);
      expect(auditApi.body.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "tls.certificate_uploaded", actor: admin.username }),
      ]));
    } finally {
      if (previous.length) {
        await query(`UPDATE system_config SET value = $1 WHERE key = 'multi_tenancy'`,
          [JSON.stringify(previous[0].value)]);
      } else {
        await query(`DELETE FROM system_config WHERE key = 'multi_tenancy'`);
      }
    }
  });
});
