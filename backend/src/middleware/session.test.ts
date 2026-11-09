import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import jwt from "jsonwebtoken";
import { resolveJwtSecrets, verifyWithAny } from "./session";

describe("resolveJwtSecrets", () => {
  const missing = path.join(os.tmpdir(), "eventagg-no-such-jwt.key");

  it("prefers JWT_SECRET and splits a rotation window on commas", () => {
    expect(resolveJwtSecrets(" new , old ,", missing)).toEqual({ secrets: ["new", "old"], source: "env" });
  });

  it("falls back to the persisted key file when JWT_SECRET is unset or empty", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eventagg-jwt-"));
    const file = path.join(dir, "jwt.key");
    fs.writeFileSync(file, "persisted-secret\n");
    try {
      expect(resolveJwtSecrets(undefined, file)).toEqual({ secrets: ["persisted-secret"], source: "file" });
      expect(resolveJwtSecrets("", file)).toEqual({ secrets: ["persisted-secret"], source: "file" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generates a random secret (never a fixed string) when nothing is configured", () => {
    const a = resolveJwtSecrets(undefined, missing);
    const b = resolveJwtSecrets(undefined, missing);
    expect(a.source).toBe("random");
    expect(a.secrets[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(a.secrets[0]).not.toBe(b.secrets[0]);
  });
});

describe("verifyWithAny", () => {
  it("accepts a token signed with the old secret during a rotation window", () => {
    const token = jwt.sign({ sub: "u1" }, "old");
    expect((verifyWithAny(token, ["new", "old"]) as { sub: string }).sub).toBe("u1");
  });

  it("rejects a token signed with a secret no longer in the list", () => {
    const token = jwt.sign({ sub: "u1" }, "retired");
    expect(() => verifyWithAny(token, ["new", "old"])).toThrow("invalid signature");
  });

  it("fails an expired token immediately rather than trying other secrets", () => {
    const token = jwt.sign({ sub: "u1", exp: Math.floor(Date.now() / 1000) - 10 }, "new");
    expect(() => verifyWithAny(token, ["new", "old"])).toThrow(jwt.TokenExpiredError);
  });
});
