import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { requireAuth } from "../middleware/session";
import { requireInstanceAdmin } from "../middleware/instanceAdmin";
import { createError } from "../middleware/errorHandler";
import { audit, SYSTEM_ENTITY_ID } from "../services/auditService";

// Settings -> TLS. The backend only validates and *stages* a certificate in
// /app/certs/staged; tls.sh's watcher (root, under supervisord) installs it,
// checks it with `nginx -t`, reloads nginx and rolls back on failure, then
// writes /app/certs/status.json. The backend never writes the live key.

const router = Router();
router.use(requireAuth, requireInstanceAdmin);

export const CERT_DIR = process.env.TLS_CERT_DIR || "/app/certs";
const STAGED = () => path.join(CERT_DIR, "staged");

export interface TlsInfo {
  subject: string;
  issuer: string;
  subjectAltNames: string[];
  validFrom: string;
  validTo: string;
  fingerprint256: string;
  selfSigned: boolean;
  expired: boolean;
}

function describe(cert: crypto.X509Certificate, selfSigned: boolean): TlsInfo {
  return {
    subject: cert.subject.replace(/\n/g, ", "),
    issuer: cert.issuer.replace(/\n/g, ", "),
    subjectAltNames: (cert.subjectAltName ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    validFrom: new Date(cert.validFrom).toISOString(),
    validTo: new Date(cert.validTo).toISOString(),
    fingerprint256: cert.fingerprint256,
    selfSigned,
    expired: new Date(cert.validTo).getTime() < Date.now(),
  };
}

function readStatus(): { ok: boolean; message: string; fingerprint: string; at: string } | null {
  try { return JSON.parse(fs.readFileSync(path.join(CERT_DIR, "status.json"), "utf8")); } catch { return null; }
}

function splitPems(text: string): string[] {
  return text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

// Exported for tests: everything that can be checked without nginx.
export function validateUpload(certPem: string, keyPem: string, chainPem = ""): { cert: crypto.X509Certificate; fullchain: string } {
  const certs = splitPems(certPem);
  if (certs.length === 0) throw createError("The certificate isn't a PEM certificate (-----BEGIN CERTIFICATE-----)", 400);
  const chain = [...certs.slice(1), ...splitPems(chainPem)];

  let cert: crypto.X509Certificate;
  try { cert = new crypto.X509Certificate(certs[0]); } catch { throw createError("The certificate can't be parsed", 400); }

  let key: crypto.KeyObject;
  try { key = crypto.createPrivateKey(keyPem); } catch {
    throw createError("The private key can't be parsed (PEM, unencrypted: remove any passphrase first)", 400);
  }
  if (!cert.checkPrivateKey(key)) throw createError("The private key doesn't match the certificate", 400);

  const now = Date.now();
  if (new Date(cert.validTo).getTime() < now) throw createError(`The certificate expired on ${cert.validTo}`, 400);
  if (new Date(cert.validFrom).getTime() > now) throw createError(`The certificate isn't valid until ${cert.validFrom}`, 400);
  if (cert.ca) throw createError("That's a CA certificate, not a server certificate", 400);

  // Each chain certificate must parse, and the chain must actually link:
  // leaf issued by chain[0], chain[0] by chain[1], ...
  let child = cert;
  for (const pem of chain) {
    let parent: crypto.X509Certificate;
    try { parent = new crypto.X509Certificate(pem); } catch { throw createError("A chain certificate can't be parsed", 400); }
    if (!child.checkIssued(parent) || !child.verify(parent.publicKey)) {
      throw createError(`The chain is out of order or incomplete: "${child.subject.replace(/\n/g, ", ")}" isn't issued by the next certificate`, 400);
    }
    child = parent;
  }

  return { cert, fullchain: [certs[0], ...chain].join("\n") + "\n" };
}

// GET /api/v1/system/tls -the certificate nginx is serving now, plus the
// result of the last change.
router.get("/", (_req: Request, res: Response, next: NextFunction) => {
  try {
    let current: TlsInfo | null = null;
    try {
      const pem = fs.readFileSync(path.join(CERT_DIR, "server.crt"), "utf8");
      const selfSigned = fs.existsSync(path.join(CERT_DIR, "selfsigned.sans"));
      current = describe(new crypto.X509Certificate(splitPems(pem)[0]), selfSigned);
    } catch { /* no certificate readable (e.g. local dev) */ }
    const staged = STAGED();
    const pending = fs.existsSync(path.join(staged, "ready")) || fs.existsSync(path.join(staged, "regenerate"));
    res.json({ current, lastChange: readStatus(), pending });
  } catch (err) { next(err); }
});

// POST /api/v1/system/tls -upload a certificate, key and optional chain
// (PEM text). 202: the watcher applies it within a few seconds.
router.post("/", (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({
      cert:  z.string().min(1).max(200_000),
      key:   z.string().min(1).max(50_000),
      chain: z.string().max(200_000).optional(),
    }).parse(req.body);
    const { cert, fullchain } = validateUpload(body.cert, body.key, body.chain);

    const staged = STAGED();
    // Key first, mode 600; the watcher only acts once "ready" exists, so it
    // never sees a half-written pair.
    fs.writeFileSync(path.join(staged, "server.key"), body.key.trim() + "\n", { mode: 0o600 });
    fs.writeFileSync(path.join(staged, "server.crt"), fullchain, { mode: 0o600 });
    fs.writeFileSync(path.join(staged, "ready"), "");

    audit({ entityType: "system", entityId: SYSTEM_ENTITY_ID, action: "tls.certificate_uploaded", actor: req.user!.username,
      sourceIp: req.ip, orgId: req.user!.orgId, afterState: { fingerprint256: cert.fingerprint256, subject: cert.subject } });
    res.status(202).json({ pending: true, uploaded: describe(cert, false) });
  } catch (err) { next(err); }
});

// DELETE /api/v1/system/tls -go back to a self-signed certificate.
router.delete("/", (req: Request, res: Response, next: NextFunction) => {
  try {
    fs.writeFileSync(path.join(STAGED(), "regenerate"), "");
    audit({ entityType: "system", entityId: SYSTEM_ENTITY_ID, action: "tls.certificate_reset", actor: req.user!.username,
      sourceIp: req.ip, orgId: req.user!.orgId });
    res.status(202).json({ pending: true });
  } catch (err) { next(err); }
});

export default router;
