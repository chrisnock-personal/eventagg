import { Router, Request, Response, NextFunction } from "express";
import { requireAuth, SessionUser } from "../middleware/session";
import { createError } from "../middleware/errorHandler";
import { queryAuditLogPaged } from "../services/auditService";
import { orgContextMiddleware } from "../middleware/orgContext";

const router = Router();
router.use(requireAuth);

// Superadmin has no org to scope the audit log to — Phase 2 (Organizations
// admin panel) is where instance-wide audit visibility would be built.
router.use((req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).user as SessionUser;
  if (!user.orgId) {
    return next(createError("Superadmin has no organisation context", 403));
  }
  next();
});

// Mounted after the guard above — user.orgId is guaranteed set by this point.
router.use(orgContextMiddleware);

// GET /api/v1/audit — returns { rows, total, limit, offset }
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = (req as any).user.orgId as string;
    const limit  = Math.min(parseInt(req.query.limit  as string || "200"), 500);
    const offset = parseInt(req.query.offset as string || "0");
    const result = await queryAuditLogPaged({
      orgId,
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
