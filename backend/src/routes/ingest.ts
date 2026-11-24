import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { ingestRawEvent, fireGroupCompletedWebhook } from "../services/ingestService";
import { statsCache, performanceCache } from "../cache";
import { audit } from "../services/auditService";
import { orgContextMiddleware } from "../middleware/orgContext";

const router = Router();

// requireApiKey (mounted in app.ts, ahead of this router) already resolved
// req.org by the time this runs.
router.use(orgContextMiddleware);

const ingestSchema = z.object({
  policyId:       z.string().uuid("policyId must be a valid UUID"),
  body:           z.record(z.string(), z.unknown()),
  sequenceNumber: z.number().int().optional(),
});

// POST /api/v1/events/ingest
router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const org = req.org!;
    const input = ingestSchema.parse(req.body);
    const result = await ingestRawEvent(org.id, {
      policyId:       input.policyId,
      body:           input.body as Record<string, unknown>,
      sourceIp:       req.ip,
      apiKey:         req.headers["x-api-key"] as string | undefined,
      sequenceNumber: input.sequenceNumber,
    });

    // Invalidate aggregate caches so next stats/performance request is fresh
    statsCache.invalidateAll();
    performanceCache.invalidateAll();

    // Audit group lifecycle transitions only. Auditing every raw event made
    // the log unusable (2-3 rows per ingest) and drowned out human actions;
    // middle events are still visible on the group's raw-event list.
    if (result.action === "group_opened" || result.action === "group_promoted") {
      audit({
        orgId:          org.id,
        entityType:     "event",
        entityId:       result.groupId,
        action:         result.action === "group_opened" ? "event.group_opened" : "event.group_completed",
        policyId:       input.policyId,
        aggregationKey: result.aggregationKey,
        sourceIp:       req.ip,
        metadata:       { action: result.action, rawEventId: result.rawEventId },
      });
    }

    // Fire webhook after transaction -fire-and-forget, never blocks response
    if (result.action === "group_promoted") {
      fireGroupCompletedWebhook(result).catch(() => {});
    }

    const { _webhookPayload: _, ...publicResult } = result;
    const statusCode = result.action === "group_opened" ? 201 : 200;
    res.status(statusCode).json(publicResult);
  } catch (err) {
    next(err);
  }
});

export default router;
