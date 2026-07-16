import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "aggre-gator-dev-secret-change-in-production";
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
    // secure: true, // enable in production behind HTTPS
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
