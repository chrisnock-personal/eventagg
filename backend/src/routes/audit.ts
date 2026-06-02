import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/session";
import { queryAuditLogPaged } from "../services/auditService";

const router = Router();
router.use(requireAuth);

// GET /api/v1/audit — returns { rows, total, limit, offset }
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  as string || "200"), 500);
    const offset = parseInt(req.query.offset as string || "0");
    const result = await queryAuditLogPaged({
      entityType: req.query.entityType as string | undefined,
      entityId:   req.query.entityId   as string | undefined,
      action:     req.query.action     as string | undefined,
      actor:      req.query.actor      as string | undefined,
      from:       req.query.from       as string | undefined,
      to:         req.query.to         as string | undefined,
      limit,
      offset,
    });
    res.json({ rows: result.rows, total: result.total, limit, offset });
  } catch (err) { next(err); }
});

export default router;
