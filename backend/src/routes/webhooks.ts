import { Router, Request, Response, NextFunction } from "express";
import { requireAuth, requireRole } from "../middleware/session";
import { createError } from "../middleware/errorHandler";
import { orgContextMiddleware } from "../middleware/orgContext";
import { audit } from "../services/auditService";
import * as webhookService from "../services/webhookService";

const router = Router();

router.use(requireAuth);

// Superadmin has no org to scope webhooks to.
router.use((req: Request, res: Response, next: NextFunction) => {
  const user = req.user!;
  if (!user.orgId) {
    return next(createError("Superadmin has no organisation context", 403));
  }
  next();
});

// audit_log is RLS-protected; writes need the caller's org context.
router.use(orgContextMiddleware);

// GET /api/v1/webhooks
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.user!.orgId as string;
    res.json(await webhookService.listWebhooks(orgId));
  } catch (err) { next(err); }
});

// POST /api/v1/webhooks
router.post("/", requireRole("editor", "admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.user!.orgId as string;
    const { name, url, secret, events } = req.body;
    if (!name || !url) return void res.status(400).json({ error: "name and url are required" });
    if (secret !== undefined && typeof secret !== "string") return void res.status(400).json({ error: "secret must be a string" });
    const webhook = await webhookService.createWebhook(orgId, { name, url, secret, events });
    // The signing secret is write-only; never copy it into the audit log.
    audit({
      orgId, entityType: "webhook", entityId: webhook.id, action: "webhook.created",
      actor: req.user!.username, sourceIp: req.ip,
      afterState: { name: webhook.name, url: webhook.url, events: webhook.events },
    });
    res.status(201).json(webhook);
  } catch (err) { next(err); }
});

// GET /api/v1/webhooks/deliveries  (must come before /:id)
router.get("/deliveries", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.user!.orgId as string;
    const { webhookId, limit } = req.query;
    res.json(await webhookService.listDeliveries(orgId, {
      webhookId: webhookId as string | undefined,
      limit: limit ? Number(limit) : 100,
    }));
  } catch (err) { next(err); }
});

// PUT /api/v1/webhooks/:id
router.put("/:id", requireRole("editor", "admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.user!.orgId as string;
    if (req.body?.secret !== undefined && typeof req.body.secret !== "string") {
      return void res.status(400).json({ error: "secret must be a string" });
    }
    const result = await webhookService.updateWebhook(orgId, req.params.id, req.body);
    if (!result) return void res.status(404).json({ error: "Webhook not found" });
    audit({
      orgId, entityType: "webhook", entityId: result.id, action: "webhook.updated",
      actor: req.user!.username, sourceIp: req.ip,
      afterState: { name: result.name, url: result.url, isActive: result.isActive },
    });
    res.json(result);
  } catch (err) { next(err); }
});

// DELETE /api/v1/webhooks/:id
router.delete("/:id", requireRole("editor", "admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.user!.orgId as string;
    const deleted = await webhookService.deleteWebhook(orgId, req.params.id);
    if (deleted) {
      audit({
        orgId, entityType: "webhook", entityId: req.params.id, action: "webhook.deleted",
        actor: req.user!.username, sourceIp: req.ip,
      });
    }
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
