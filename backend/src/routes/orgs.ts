import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/session";
import { createError } from "../middleware/errorHandler";
import { listOrgs, createOrg, updateOrg, deleteOrg } from "../services/orgService";
import { listUsers, createUser, adminSetUserOrgAndRole } from "../services/userService";
import { orgContextMiddleware } from "../middleware/orgContext";
import { audit } from "../services/auditService";
import { invalidateCommunityCache } from "../snmp/trapNormalizer";

const router = Router();

// Platform-operator territory -superadmin only, not org-scoped admins.
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
    // Organisation admin is a superadmin-only action: log it with NULL org
    // (like login/logout). Using the new org's ID here would add an audit FK
    // that prevents the org from ever being deleted.
    audit({
      entityType: "organisation", entityId: org.id, action: "org.created",
      actor: req.user!.username, sourceIp: req.ip, orgId: null,
      afterState: { name: org.name, slug: org.slug },
    });
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
      // The community string is SNMPv2c's only credential: no well-known
      // values, and long enough not to be guessed.
      snmpCommunity: z.string().min(12, "SNMP community must be at least 12 characters").max(255)
        .refine((v) => !["public", "private"].includes(v.toLowerCase()), "Use a unique SNMP community, not public/private")
        .optional(),
    }).parse(req.body);
    const org = await updateOrg(req.params.id, body);
    if (!org) return next(createError("Organisation not found", 404));
    // A renamed or deactivated org's old community must stop resolving now,
    // not when its cache entry expires.
    invalidateCommunityCache();
    // Never record the ingest key or SNMP community, only that a key was
    // rotated.
    audit({
      entityType: "organisation", entityId: org.id, action: "org.updated",
      actor: req.user!.username, sourceIp: req.ip, orgId: null,
      afterState: {
        name: org.name, isActive: org.isActive,
        ...(body.regenerateKey ? { ingestKeyRegenerated: true } : {}),
        ...(body.snmpCommunity ? { snmpCommunityChanged: true } : {}),
      },
    });
    res.json(org);
  } catch (err) { next(err); }
});

// DELETE /api/v1/orgs/:id
router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deleted = await deleteOrg(req.params.id);
    if (!deleted) return next(createError("Organisation not found", 404));
    // The org row (and its FK target) is gone by now, so record this as a
    // superadmin action with no org instead of dangling on a deleted FK.
    audit({
      entityType: "organisation", entityId: req.params.id, action: "org.deleted",
      actor: req.user!.username, sourceIp: req.ip, orgId: null,
    });
    res.status(204).send();
  } catch (err) { next(err); }
});

// GET /api/v1/orgs/:id/users
router.get("/:id/users", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await listUsers(req.params.id));
  } catch (err) { next(err); }
});

// POST /api/v1/orgs/:id/users -create a user directly in this org
router.post("/:id/users", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({
      username: z.string().min(1).max(50),
      email:    z.string().email(),
      password: z.string().min(6),
      role:     z.enum(["viewer", "editor", "admin"]).default("viewer"),
    }).parse(req.body);
    const user = await createUser({ ...body, orgId: req.params.id });
    audit({
      entityType: "user", entityId: user.id, action: "user.created",
      actor: req.user!.username, sourceIp: req.ip, orgId: req.params.id,
      afterState: { username: user.username, email: user.email, role: user.role },
    });
    res.status(201).json(user);
  } catch (err) { next(err); }
});

// PUT /api/v1/orgs/users/:userId -move a user between orgs, and/or
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
    audit({
      entityType: "user", entityId: user.id, action: "user.updated",
      actor: req.user!.username, sourceIp: req.ip, orgId: user.orgId,
      afterState: { role: user.role, orgId: user.orgId, isActive: user.isActive },
    });
    res.json(user);
  } catch (err) { next(err); }
});

export default router;
