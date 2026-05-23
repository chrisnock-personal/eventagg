import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { ingestSegment } from "../services/ingestService";
import { statsCache, performanceCache } from "../cache";
import { audit } from "../services/auditService";

const router = Router();

const ingestSchema = z.object({
  policyId: z.string().uuid("policyId must be a valid UUID"),
  body:     z.record(z.unknown()),
});

// POST /api/v1/events/ingest
router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = ingestSchema.parse(req.body);
    const result = await ingestSegment({
      policyId:  input.policyId,
      body:      input.body as Record<string, unknown>,
      sourceIp:  req.ip,
      apiKey:    req.headers["x-api-key"] as string | undefined,
    });

    // Invalidate aggregate caches so next stats/performance request is fresh
    if (!result.action.includes("duplicate")) {
      statsCache.invalidateAll();
      performanceCache.invalidateAll();
      audit({
        entityType:     "event",
        entityId:       result.groupId,
        action:         result.action === "group_opened"   ? "event.group_opened"
                      : result.action === "group_promoted" ? "event.group_completed"
                      : "event.ingested",
        policyId:       input.policyId,
        aggregationKey: result.aggregationKey,
        sourceIp:       req.ip,
        metadata:       { action: result.action, segmentId: result.segmentId },
      });
    }

    const statusCode = result.action === "group_opened" ? 201 : 200;
    res.status(statusCode).json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
