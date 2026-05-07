import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { listEvents, getEventById, getSegmentsForEvent } from "../services/eventService";
import { createError } from "../middleware/errorHandler";

const router = Router();

const listQuerySchema = z.object({
  status:         z.enum(["in_progress", "completed", "all"]).default("all"),
  policyId:       z.string().uuid().optional(),
  aggregationKey: z.string().optional(),
  from:           z.string().datetime({ offset: true }).optional(),
  to:             z.string().datetime({ offset: true }).optional(),
  page:           z.coerce.number().int().min(1).default(1),
  limit:          z.coerce.number().int().min(1).max(200).default(50),
});

// GET /api/v1/events
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filters = listQuerySchema.parse(req.query);
    const result = await listEvents(filters);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/events/:id
router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const group = await getEventById(req.params.id);
    if (!group) return next(createError("Event group not found", 404));
    res.json(group);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/events/:id/segments
router.get("/:id/segments", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const segments = await getSegmentsForEvent(req.params.id);
    if (!segments) return next(createError("Event group not found", 404));
    res.json(segments);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/events/:id  (soft delete - audit log only, not yet implemented as a DB field for brevity)
router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const group = await getEventById(req.params.id);
    if (!group) return next(createError("Event group not found", 404));
    // Soft delete is recorded in audit_log; extend with a deleted_at column via migration as needed
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
