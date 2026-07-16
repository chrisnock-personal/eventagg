import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { verifyCredentials, listUsers, createUser, updateUser, deleteUser, changePassword, forcePasswordChange } from "../services/userService";
import { audit } from "../services/auditService";
import { setSessionCookie, clearSessionCookie, requireAuth, requireRole } from "../middleware/session";
import { createError } from "../middleware/errorHandler";
import { orgContextMiddleware } from "../middleware/orgContext";
import { runWithOrgContext } from "../db/pool";

const router = Router();

// ── POST /api/v1/auth/login ───────────────────────────────────────────────────
router.post("/login", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password } = z.object({
      username: z.string().min(1),
      password: z.string().min(1),
    }).parse(req.body);

    // Authenticating by username is inherently a cross-org lookup — the org
    // isn't known until after the row is found, and no session/JWT exists
    // yet for orgContextMiddleware to derive one from. Run under bypass so
    // the RLS policies on `users`/`audit_log` (024) don't fail this closed.
    await runWithOrgContext({ orgId: null, bypass: true }, async () => {
      const user = await verifyCredentials(username, password);
      if (!user) {
        const err = createError("Invalid username or password", 401);
        return next(err);
      }

      const sessionUser = {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        passwordChanged: user.passwordChanged,
        orgId: user.orgId,
        orgName: user.orgName,
      };
      setSessionCookie(res, sessionUser);
      audit({ entityType: "user", entityId: user.id, action: "user.login", actor: user.username, sourceIp: req.ip, orgId: user.orgId });
      res.json(sessionUser);
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/v1/auth/change-password ────────────────────────────────────────
router.post("/change-password", requireAuth, orgContextMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { currentPassword, newPassword } = z.object({
      currentPassword: z.string().min(1),
      newPassword:     z.string().min(6, "New password must be at least 6 characters"),
    }).parse(req.body);

    const userId = req.user!.id;
    const result = await changePassword(userId, currentPassword, newPassword);
    if (!result.ok) return next(createError(result.error ?? "Password change failed", 400));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/v1/auth/logout ──────────────────────────────────────────────────
router.post("/logout", requireAuth, orgContextMiddleware, (req: Request, res: Response) => {
  const user = req.user!;
  audit({ entityType: "user", entityId: user.id, action: "user.logout", actor: user.username, sourceIp: req.ip, orgId: user.orgId });
  clearSessionCookie(res);
  res.status(204).send();
});

// ── GET /api/v1/auth/me ───────────────────────────────────────────────────────
router.get("/me", requireAuth, (req: Request, res: Response) => {
  res.json(req.user);
});

// ── Users CRUD (admin only) ───────────────────────────────────────────────────

const userBodySchema = z.object({
  username: z.string().min(1).max(50).optional(),
  email:    z.string().email().optional(),
  password: z.string().min(6).optional(),
  role:     z.enum(["viewer", "editor", "admin"]).optional(),
  isActive: z.boolean().optional(),
});

// GET /api/v1/auth/users
router.get("/users", requireAuth, requireRole("admin"), orgContextMiddleware, async (req, res, next) => {
  try {
    const orgId = req.user!.orgId as string;
    res.json(await listUsers(orgId));
  } catch (err) { next(err); }
});

// POST /api/v1/auth/users
router.post("/users", requireAuth, requireRole("admin"), orgContextMiddleware, async (req, res, next) => {
  try {
    const body = z.object({
      username: z.string().min(1).max(50),
      email:    z.string().email(),
      password: z.string().min(6),
      role:     z.enum(["viewer", "editor", "admin"]).default("viewer"),
    }).parse(req.body);

    const orgId = req.user!.orgId as string;
    const user = await createUser({ ...body, orgId });
    res.status(201).json(user);
  } catch (err) { next(err); }
});

// PUT /api/v1/auth/users/:id
router.put("/users/:id", requireAuth, requireRole("admin"), orgContextMiddleware, async (req, res, next) => {
  try {
    const input = userBodySchema.parse(req.body);
    const orgId = req.user!.orgId as string;
    const user = await updateUser(orgId, req.params.id, input);
    if (!user) return next(createError("User not found", 404));
    res.json(user);
  } catch (err) { next(err); }
});

// DELETE /api/v1/auth/users/:id
router.delete("/users/:id", requireAuth, requireRole("admin"), orgContextMiddleware, async (req, res, next) => {
  try {
    const orgId = req.user!.orgId as string;
    const deleted = await deleteUser(orgId, req.params.id);
    if (!deleted) return next(createError("User not found", 404));
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
