import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  listPolicies,
  getPolicyById,
  createPolicy,
  updatePolicy,
  deactivatePolicy,
  applyPolicyTimeout,
} from "../services/policyService";
import { createError } from "../middleware/errorHandler";

const router = Router();

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
router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const policies = await listPolicies(true);
    res.json(policies);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/policies/:id
router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const policy = await getPolicyById(req.params.id);
    if (!policy) return next(createError("Policy not found", 404));
    res.json(policy);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/policies
router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = policyBodySchema.parse(req.body);
    const policy = await createPolicy({ ...input, createdBy: "api" });
    res.status(201).json(policy);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/policies/:id
router.put("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = policyUpdateSchema.parse(req.body);
    const policy = await updatePolicy(req.params.id, { ...input, updatedBy: "api" });
    if (!policy) return next(createError("Policy not found", 404));

    // If timeout was just set, retroactively apply it to existing in-progress groups
    if (policy.timeoutMs !== null && policy.timeoutMs !== undefined) {
      const count = await applyPolicyTimeout(req.params.id);
      if (count > 0) console.log(`⏱  Retroactive timeout: ${count} group(s) closed for policy ${policy.name}`);
    }

    res.json(policy);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/policies/:id/toggle — activate or deactivate
router.patch("/:id/toggle", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    const { query } = await import("../db/pool");
    const rows = await query<{ id: string }>(
      `UPDATE policies SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING id`,
      [active, req.params.id]
    );
    if (!rows.length) return next(createError("Policy not found", 404));
    const policy = await getPolicyById(req.params.id);
    res.json(policy);
  } catch (err) { next(err); }
});

// DELETE /api/v1/policies/:id
router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deleted = await deactivatePolicy(req.params.id, "api");
    if (!deleted) return next(createError("Policy not found", 404));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
