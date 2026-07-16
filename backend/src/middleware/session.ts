import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { config } from "../config";

// A hardcoded fallback secret here would be a real hole — it's sitting in
// public source, so anyone could forge a valid session (including
// superadmin) for any deployment that didn't override it. If JWT_SECRET
// isn't set, generate a random one for this boot instead: closes that hole
// without refusing to start, at the cost of invalidating every session on
// restart (set JWT_SECRET explicitly to avoid that).
// `||` (not `??`) deliberately — docker-compose.yml passes JWT_SECRET as an
// empty string, not unset, when the host env var isn't set, and an empty
// string must fall back too (jsonwebtoken rejects "" outright: "secretOrPrivateKey
// must have a value").
const SECRET = config.jwtSecret || crypto.randomBytes(32).toString("hex");
if (!config.jwtSecret) {
  console.warn(
    "⚠️  JWT_SECRET is not set — using a random secret generated for this boot only.\n" +
    "    All sessions will be invalidated on every restart. Set JWT_SECRET in your\n" +
    "    environment for persistent sessions and to avoid regenerating it on every deploy."
  );
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
  return jwt.sign(user, SECRET, { expiresIn: TTL_S });
}

export function setSessionCookie(res: Response, user: SessionUser): void {
  const token = signSession(user);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    maxAge: TTL_S * 1000,
    secure: config.cookieSecure, // only safe once TLS is actually in front — see COOKIE_SECURE
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE);
}

// ── Middleware ────────────────────────────────────────────────────────────────

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[COOKIE] || extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: "Unauthorized — please sign in" });
    return;
  }
  try {
    const user = jwt.verify(token, SECRET) as SessionUser;
    (req as any).user = user;
    next();
  } catch {
    res.status(401).json({ error: "Session expired — please sign in again" });
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as any).user as SessionUser | undefined;
    if (!user || !roles.includes(user.role)) {
      res.status(403).json({ error: `Forbidden — requires role: ${roles.join(" or ")}` });
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
