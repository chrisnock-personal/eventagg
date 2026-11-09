import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import type { Express } from "express";
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
    const res = await request(app).get("/api/v1/system/tls").set("Cookie", cookie);
    expect(res.status).toBe(403);
  });
});
