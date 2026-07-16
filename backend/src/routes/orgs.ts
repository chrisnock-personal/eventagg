import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/session";
import { createError } from "../middleware/errorHandler";
import { listOrgs, createOrg, updateOrg, deleteOrg } from "../services/orgService";
import { listUsers, createUser, adminSetUserOrgAndRole } from "../services/userService";
import { orgContextMiddleware } from "../middleware/orgContext";

const router = Router();

// Platform-operator territory — superadmin only, not org-scoped admins.
// role is guaranteed "superadmin" past this point, so orgContextMiddleware's
// existing bypass: user.role === "superadmin" logic naturally grants every
// route below cross-org visibility on the users/audit_log RLS policies.
router.use(requireAuth, requireRole("superadmin"), orgContextMiddleware);

// GET /api/v1/orgs
router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await listOrgs());
  } catch (err) { next(err); }
});

// POST /api/v1/orgs
router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({
      name: z.string().min(1).max(255),
      slug: z.string().min(1).max(100).optional(),
    }).parse(req.body);
    const org = await createOrg(body);
    res.status(201).json(org);
  } catch (err) { next(err); }
});

// PUT /api/v1/orgs/:id
router.put("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({
      name: z.string().min(1).max(255).optional(),
      isActive: z.boolean().optional(),
      regenerateKey: z.boolean().optional(),
      snmpCommunity: z.string().min(1).max(255).optional(),
    }).parse(req.body);
    const org = await updateOrg(req.params.id, body);
    if (!org) return next(createError("Organisation not found", 404));
    res.json(org);
  } catch (err) { next(err); }
});

// DELETE /api/v1/orgs/:id
router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deleted = await deleteOrg(req.params.id);
    if (!deleted) return next(createError("Organisation not found", 404));
    res.status(204).send();
  } catch (err) { next(err); }
});

// GET /api/v1/orgs/:id/users
router.get("/:id/users", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await listUsers(req.params.id));
  } catch (err) { next(err); }
});

// POST /api/v1/orgs/:id/users — create a user directly in this org
router.post("/:id/users", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({
      username: z.string().min(1).max(50),
      email:    z.string().email(),
      password: z.string().min(6),
      role:     z.enum(["viewer", "editor", "admin"]).default("viewer"),
    }).parse(req.body);
    const user = await createUser({ ...body, orgId: req.params.id });
    res.status(201).json(user);
  } catch (err) { next(err); }
});

// PUT /api/v1/orgs/users/:userId — move a user between orgs, and/or
// promote/demote to/from superadmin.
router.put("/users/:userId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({
      role:     z.enum(["viewer", "editor", "admin", "superadmin"]).optional(),
      orgId:    z.string().uuid().nullable().optional(),
      isActive: z.boolean().optional(),
    }).parse(req.body);
    const user = await adminSetUserOrgAndRole(req.params.userId, body);
    if (!user) return next(createError("User not found", 404));
    res.json(user);
  } catch (err) { next(err); }
});

export default router;
