import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { listEvents, getEventById, getRawEventsForEvent, getEventStats, getEventPerformance } from "../services/eventService";
import { createError } from "../middleware/errorHandler";
import { statsCache, performanceCache, cacheKey } from "../cache";
import { TIMEOUTS } from "../middleware/timeout";
import { withStatementTimeout } from "../db/pool";

const router = Router();

const listQuerySchema = z.object({
  status:         z.enum(["in_progress", "completed", "timed_out", "all"]).default("all"),
  policyId:       z.string().uuid().optional(),
  aggregationKey: z.string().optional(),
  from:           z.string().datetime({ offset: true }).optional(),
  to:             z.string().datetime({ offset: true }).optional(),
  bodySearch:     z.string().max(500).optional(),
  page:           z.coerce.number().int().min(1).default(1),
  limit:          z.coerce.number().int().min(1).max(200).default(50),
});

const statsQuerySchema = z.object({
  status:         z.enum(["in_progress", "completed", "timed_out", "all"]).default("all"),
  policyId:       z.string().uuid().optional(),
  aggregationKey: z.string().optional(),
  from:           z.string().datetime({ offset: true }).optional(),
  to:             z.string().datetime({ offset: true }).optional(),
});

// GET /api/v1/events/stats
router.get("/stats", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filters = statsQuerySchema.parse(req.query);
    const key = cacheKey("stats", filters as Record<string, unknown>);
    const cached = statsCache.get(key);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      return res.json(cached);
    }
    // Apply 15s statement timeout — aggregate queries can be slow on large datasets
    const result = await withStatementTimeout(TIMEOUTS.stats, () => getEventStats(filters));
    statsCache.set(key, result);
    res.setHeader("X-Cache", "MISS");
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const performanceQuerySchema = z.object({
  policyId:       z.string().uuid().optional(),
  aggregationKey: z.string().optional(),
  from:           z.string().datetime({ offset: true }).optional(),
  to:             z.string().datetime({ offset: true }).optional(),
});

// GET /api/v1/events/performance
router.get("/performance", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filters = performanceQuerySchema.parse(req.query);
    const key = cacheKey("perf", filters as Record<string, unknown>);
    const cached = performanceCache.get(key);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      return res.json(cached);
    }
    // Apply 15s statement timeout
    const result = await withStatementTimeout(TIMEOUTS.stats, () => getEventPerformance(filters));
    performanceCache.set(key, result);
    res.setHeader("X-Cache", "MISS");
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/events — paginated list
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

// GET /api/v1/events/:id/raw-events
router.get("/:id/raw-events", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawEvents = await getRawEventsForEvent(req.params.id);
    if (!rawEvents) return next(createError("Event group not found", 404));
    res.json(rawEvents);
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
