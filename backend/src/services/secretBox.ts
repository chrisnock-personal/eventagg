import crypto from "crypto";
import fs from "fs";
import { logger } from "../logger";

// Encryption at rest for stored credentials (webhook signing secrets, the
// SMTP password): AES-256-GCM with a random 96-bit IV per value.
//
// Stored format: "enc:v1:<kid>:<iv>:<tag>:<ciphertext>" (base64url parts),
// where <kid> is the first 8 hex chars of SHA-256(key), so a value names the
// key it needs and a rotation can keep the previous key for decrypting.
// Anything without the prefix is a legacy plaintext value: decrypt() returns
// it unchanged and reencryptStoredSecrets() (index.ts, at boot) converts it.
//
// Key resolution, same shape as the JWT secret (middleware/session.ts):
//   1. DATA_ENCRYPTION_KEY env: 64 hex chars, or several comma-separated
//      ("<new>,<old>") during a rotation. The first encrypts; all decrypt.
//   2. /app/secrets/data.key, generated on first boot by entrypoint.sh.
//   3. Outside production only: a random key for this process, with a
//      warning. Production refuses to start without a key, since values
//      encrypted with a throwaway key are lost at the next restart.
//
// The key lives in the `secrets` volume, not in Postgres, so a database
// backup alone doesn't reveal these values. That also means restoring a
// backup on a new host needs data.key too (DISASTER_RECOVERY.md).

export const DATA_KEY_FILE = process.env.DATA_KEY_FILE || "/app/secrets/data.key";
const PREFIX = "enc:v1:";

interface Key { kid: string; key: Buffer }

function parseKey(hex: string): Key {
  const key = Buffer.from(hex.trim(), "hex");
  if (key.length !== 32) throw new Error("data encryption key must be 32 bytes (64 hex characters)");
  return { kid: crypto.createHash("sha256").update(key).digest("hex").slice(0, 8), key };
}

export function resolveDataKeys(envValue: string | undefined, keyFile: string, production: boolean): { keys: Key[]; source: "env" | "file" | "random" } {
  const fromEnv = (envValue ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (fromEnv.length) return { keys: fromEnv.map(parseKey), source: "env" };
  let persisted = "";
  try { persisted = fs.readFileSync(keyFile, "utf8").trim(); } catch { /* missing/unreadable */ }
  if (persisted) return { keys: [parseKey(persisted)], source: "file" };
  if (production) {
    throw new Error(`No data encryption key: set DATA_ENCRYPTION_KEY or provide ${keyFile} (entrypoint.sh generates it)`);
  }
  return { keys: [parseKey(crypto.randomBytes(32).toString("hex"))], source: "random" };
}

let KEYS: Key[] | null = null;
function keys(): Key[] {
  if (!KEYS) {
    const r = resolveDataKeys(process.env.DATA_ENCRYPTION_KEY, DATA_KEY_FILE, process.env.NODE_ENV === "production");
    if (r.source === "random") {
      logger.warn(`No DATA_ENCRYPTION_KEY and no ${DATA_KEY_FILE}: using a random key for this process only (stored secrets won't survive a restart)`);
    } else if (r.keys.length > 1) {
      logger.info({ keys: r.keys.length }, "Data key rotation window active: encrypting with the first, decrypting with all");
    }
    KEYS = r.keys;
  }
  return KEYS;
}

// Called at boot so a missing key fails the start, not the first webhook.
export function initSecretBox(): void { keys(); }

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Encrypts a credential for storage. "" stays "" (meaning "no secret"). */
export function encryptSecret(plain: string): string {
  if (!plain) return "";
  const { kid, key } = keys()[0];
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [kid, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":");
}

/** Decrypts a stored credential. Legacy plaintext is returned unchanged. */
export function decryptSecret(stored: string): string {
  if (!stored || !isEncrypted(stored)) return stored;
  const [kid, iv, tag, ct] = stored.slice(PREFIX.length).split(":");
  const k = keys().find((x) => x.kid === kid);
  if (!k) throw new Error(`stored secret was encrypted with an unknown data key (${kid}): is DATA_ENCRYPTION_KEY/data.key the one this database was written with?`);
  const decipher = crypto.createDecipheriv("aes-256-gcm", k.key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

/** True if this stored value should be rewritten: plaintext, or under a non-current key. */
export function needsReencrypt(stored: string): boolean {
  if (!stored) return false;
  if (!isEncrypted(stored)) return true;
  return stored.slice(PREFIX.length).split(":")[0] !== keys()[0].kid;
}
