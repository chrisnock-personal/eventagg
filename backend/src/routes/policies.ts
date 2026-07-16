import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { audit } from "../services/auditService";
import {
  listPolicies,
  getPolicyById,
  createPolicy,
  updatePolicy,
  deactivatePolicy,
  applyPolicyTimeout,
} from "../services/policyService";
import { createError } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/session";
import { orgContextMiddleware } from "../middleware/orgContext";

const router = Router();

router.use(requireAuth);
router.use(orgContextMiddleware);

// orgId is string | null throughout this file — null means superadmin, who
// reads/writes only global (org_id IS NULL) policies. Regular org-scoped
// callers read their own org's policies plus every global one (handled
// inside policyService), but writes stay confined to their own org.

const policyBodySchema = z.object({
  name:         z.string().min(1).max(255),
  domain:       z.string().min(1).max(255).default("*"),
  keyField:     z.string().min(1).max(255),
  cradleField:  z.string().min(1).max(255),
  cradleValue:  z.string().min(1).max(255),
  graveField:   z.string().min(1).max(255),
  graveValue:   z.string().min(1).max(255),
  description:  z.string().max(1000).nullable().optional(),
  timeoutMs:    z.number().min(1).nullable().optional().transform(v => v === null || v === undefined ? v : Math.round(v)),
});

const policyUpdateSchema = policyBodySchema.partial();

// GET /api/v1/policies
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.user!.orgId;
    const policies = await listPolicies(orgId, true);
    res.json(policies);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/policies/:id
router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.user!.orgId;
    const policy = await getPolicyById(orgId, req.params.id);
    if (!policy) return next(createError("Policy not found", 404));
    res.json(policy);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/policies
router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.user!.orgId;
    const input = policyBodySchema.parse(req.body);
    const policy = await createPolicy(orgId, { ...input, createdBy: "api" });
    audit({ orgId, entityType: "policy", entityId: policy.id, action: "policy.created", actor: req.user?.username, sourceIp: req.ip, afterState: { name: policy.name } });
    res.status(201).json(policy);
  } catch (err) { next(err); }
});

// PUT /api/v1/policies/:id
router.put("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.user!.orgId;
    const input = policyUpdateSchema.parse(req.body);
    const policy = await updatePolicy(orgId, req.params.id, { ...input, updatedBy: "api" });
    if (!policy) return next(createError("Policy not found", 404));

    if (policy.timeoutMs !== null && policy.timeoutMs !== undefined) {
      const count = await applyPolicyTimeout(orgId, req.params.id);
      if (count > 0) console.log(`⏱  Retroactive timeout: ${count} group(s) closed for policy ${policy.name}`);
    }

    audit({ orgId, entityType: "policy", entityId: policy.id, action: "policy.updated", actor: req.user?.username, sourceIp: req.ip, afterState: { name: policy.name, timeoutMs: policy.timeoutMs } });
    res.json(policy);
  } catch (err) { next(err); }
});

// PATCH /api/v1/policies/:id/toggle — activate or deactivate
router.patch("/:id/toggle", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.user!.orgId;
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    const { query } = await import("../db/pool");
    const orgMatch = orgId === null ? "org_id IS NULL" : "org_id = $3";
    const params = orgId === null ? [active, req.params.id] : [active, req.params.id, orgId];
    const rows = await query<{ id: string }>(
      `UPDATE policies SET is_active = $1, updated_at = NOW() WHERE id = $2 AND ${orgMatch} RETURNING id`,
      params
    );
    if (!rows.length) return next(createError("Policy not found", 404));
    const policy = await getPolicyById(orgId, req.params.id);
    audit({ orgId, entityType: "policy", entityId: req.params.id, action: "policy.toggled", actor: req.user?.username, sourceIp: req.ip, metadata: { active } });
    res.json(policy);
  } catch (err) { next(err); }
});

// DELETE /api/v1/policies/:id
router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.user!.orgId;
    const deleted = await deactivatePolicy(orgId, req.params.id, "api");
    if (!deleted) return next(createError("Policy not found", 404));
    audit({ orgId, entityType: "policy", entityId: req.params.id, action: "policy.deleted", actor: req.user?.username, sourceIp: req.ip });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
