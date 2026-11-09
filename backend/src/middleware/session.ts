import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import fs from "fs";
import { config } from "../config";
import { logger } from "../logger";


// Session signing secrets. Resolution order:
//   1. JWT_SECRET env var. May hold several comma-separated secrets for a
//      rotation window ("<new>,<old>"): new sessions are signed with the
//      first, and a token signed with any of them still verifies -see
//      SECRETS_ROTATION.md.
//   2. /app/secrets/jwt.key, generated on first boot by entrypoint.sh and
//      persisted in the `secrets` volume, so sessions survive restarts and
//      container recreates without anyone having to set JWT_SECRET.
//   3. A random secret for this process only (local dev / tests), with a
//      warning. Never a fixed string: a hardcoded fallback is public in
//      source, so anyone could forge a session (including superadmin).
// config.jwtSecret is already normalized so docker-compose's "" counts as
// unset (jsonwebtoken rejects "" outright).
export const JWT_KEY_FILE = process.env.JWT_KEY_FILE || "/app/secrets/jwt.key";

export function resolveJwtSecrets(envValue: string | undefined, keyFile: string): { secrets: string[]; source: "env" | "file" | "random" } {
  const fromEnv = (envValue ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (fromEnv.length) return { secrets: fromEnv, source: "env" };
  try {
    const persisted = fs.readFileSync(keyFile, "utf8").trim();
    if (persisted) return { secrets: [persisted], source: "file" };
  } catch { /* missing/unreadable -fall through */ }
  return { secrets: [crypto.randomBytes(32).toString("hex")], source: "random" };
}

const { secrets: SECRETS, source: SECRET_SOURCE } = resolveJwtSecrets(config.jwtSecret, JWT_KEY_FILE);
if (SECRET_SOURCE === "random") {
  logger.warn(
    `JWT_SECRET is not set and no persisted key at ${JWT_KEY_FILE} -using a random secret for this process only. ` +
    "All sessions will be invalidated on restart."
  );
} else if (SECRETS.length > 1) {
  logger.info({ secrets: SECRETS.length }, "JWT secret rotation window active -signing with the first, accepting all");
}

export function verifyWithAny(token: string, secrets: string[]): unknown {
  let lastErr: unknown;
  for (const secret of secrets) {
    try {
      return jwt.verify(token, secret);
    } catch (e) {
      lastErr = e;
      // Only a signature mismatch means "try the next secret"; an expired or
      // malformed token fails the same way under every secret.
      if (!(e instanceof jwt.JsonWebTokenError) || e.message !== "invalid signature") throw e;
    }
  }
  throw lastErr;
}

const COOKIE = "ag_session";
const TTL_S  = 8 * 60 * 60; // 8 hours

export interface SessionUser {
  id: string;
  username: string;
  email: string;
  role: "superadmin" | "viewer" | "editor" | "admin";
  passwordChanged: boolean;
  orgId: string | null;
  orgName: string | null;
}

export function signSession(user: SessionUser): string {
  return jwt.sign(user, SECRETS[0], { expiresIn: TTL_S });
}

export function setSessionCookie(res: Response, user: SessionUser): void {
  const token = signSession(user);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    maxAge: TTL_S * 1000,
    secure: config.cookieSecure, // only safe once TLS is actually in front -see COOKIE_SECURE
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE);
}

// ── Middleware ────────────────────────────────────────────────────────────────

function authenticate(req: Request, res: Response, next: NextFunction, allowPendingPasswordChange: boolean): void {
  const token = req.cookies?.[COOKIE] || extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: "Unauthorized -please sign in" });
    return;
  }
  let user: SessionUser;
  try {
    user = verifyWithAny(token, SECRETS) as SessionUser;
  } catch {
    res.status(401).json({ error: "Session expired -please sign in again" });
    return;
  }
  // The first-login password change is enforced here, not just by the
  // frontend's ChangePasswordScreen: otherwise an API client could keep
  // using a default/bootstrap password indefinitely. Only === false blocks,
  // so tokens issued before this claim existed aren't locked out.
  if (user.passwordChanged === false && !allowPendingPasswordChange) {
    res.status(403).json({
      error: "Password change required -change your password before using the API",
      code: "PASSWORD_CHANGE_REQUIRED",
    });
    return;
  }
  req.user = user;
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  authenticate(req, res, next, false);
}

// For the few routes a user must reach while a password change is still
// pending: change-password itself, /me (the frontend's session check) and
// logout. Everything else uses requireAuth.
export function requireAuthAllowingPasswordChange(req: Request, res: Response, next: NextFunction): void {
  authenticate(req, res, next, true);
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user || !roles.includes(user.role)) {
      res.status(403).json({ error: `Forbidden -requires role: ${roles.join(" or ")}` });
      return;
    }
    next();
  };
}

function extractBearerToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}
