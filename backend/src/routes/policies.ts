import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  listPolicies,
  getPolicyById,
  createPolicy,
  updatePolicy,
  deactivatePolicy,
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
  description:  z.string().max(1000).optional(),
});

const policyUpdateSchema = policyBodySchema.partial();

// GET /api/v1/policies
router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const policies = await listPolicies();
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
    res.json(policy);
  } catch (err) {
    next(err);
  }
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
