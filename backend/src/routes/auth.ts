import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { verifyCredentials, listUsers, createUser, updateUser, deleteUser, changePassword, forcePasswordChange } from "../services/userService";
import { audit } from "../services/auditService";
import { setSessionCookie, clearSessionCookie, requireAuth, requireRole } from "../middleware/session";
import { createError } from "../middleware/errorHandler";

const router = Router();

// ── POST /api/v1/auth/login ───────────────────────────────────────────────────
router.post("/login", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password } = z.object({
      username: z.string().min(1),
      password: z.string().min(1),
    }).parse(req.body);

    const user = await verifyCredentials(username, password);
    if (!user) {
      const err = createError("Invalid username or password", 401);
      return next(err);
    }

    setSessionCookie(res, { id: user.id, username: user.username, role: user.role });
    audit({ entityType: "user", entityId: user.id, action: "user.login", actor: user.username, sourceIp: req.ip });
    res.json({
      id: user.id,
      username: user.username,
      role: user.role,
      email: user.email,
      passwordChanged: user.passwordChanged,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/v1/auth/change-password ────────────────────────────────────────
router.post("/change-password", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { currentPassword, newPassword } = z.object({
      currentPassword: z.string().min(1),
      newPassword:     z.string().min(6, "New password must be at least 6 characters"),
    }).parse(req.body);

    const userId = (req as any).user.id;
    const result = await changePassword(userId, currentPassword, newPassword);
    if (!result.ok) return next(createError(result.error ?? "Password change failed", 400));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/v1/auth/logout ──────────────────────────────────────────────────
router.post("/logout", requireAuth, (req: Request, res: Response) => {
  const user = (req as any).user;
  audit({ entityType: "user", entityId: user.id, action: "user.logout", actor: user.username, sourceIp: req.ip });
  clearSessionCookie(res);
  res.status(204).send();
});

// ── GET /api/v1/auth/me ───────────────────────────────────────────────────────
router.get("/me", requireAuth, (req: Request, res: Response) => {
  res.json((req as any).user);
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
router.get("/users", requireAuth, requireRole("admin"), async (_req, res, next) => {
  try {
    res.json(await listUsers());
  } catch (err) { next(err); }
});

// POST /api/v1/auth/users
router.post("/users", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const body = z.object({
      username: z.string().min(1).max(50),
      email:    z.string().email(),
      password: z.string().min(6),
      role:     z.enum(["viewer", "editor", "admin"]).default("viewer"),
    }).parse(req.body);

    const user = await createUser(body);
    res.status(201).json(user);
  } catch (err) { next(err); }
});

// PUT /api/v1/auth/users/:id
router.put("/users/:id", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const input = userBodySchema.parse(req.body);
    const user = await updateUser(req.params.id, input);
    if (!user) return next(createError("User not found", 404));
    res.json(user);
  } catch (err) { next(err); }
});

// DELETE /api/v1/auth/users/:id
router.delete("/users/:id", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const deleted = await deleteUser(req.params.id);
    if (!deleted) return next(createError("User not found", 404));
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
