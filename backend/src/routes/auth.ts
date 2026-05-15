import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { verifyCredentials, listUsers, createUser, updateUser, deleteUser } from "../services/userService";
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
    res.json({ id: user.id, username: user.username, role: user.role, email: user.email });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/v1/auth/logout ──────────────────────────────────────────────────
router.post("/logout", (_req: Request, res: Response) => {
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
