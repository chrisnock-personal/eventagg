import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/session";
import { queryAuditLog } from "../services/auditService";

const router = Router();
router.use(requireAuth);

// GET /api/v1/audit
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await queryAuditLog({
      entityType: req.query.entityType as string | undefined,
      entityId:   req.query.entityId   as string | undefined,
      action:     req.query.action     as string | undefined,
      actor:      req.query.actor      as string | undefined,
      from:       req.query.from       as string | undefined,
      to:         req.query.to         as string | undefined,
      limit:      req.query.limit ? parseInt(req.query.limit as string) : 200,
    });
    res.json(rows);
  } catch (err) { next(err); }
});

export default router;
