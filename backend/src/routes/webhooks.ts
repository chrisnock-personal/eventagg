import { Router, Request, Response, NextFunction } from "express";
import { requireAuth, requireRole } from "../middleware/session";
import { createError } from "../middleware/errorHandler";
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
    res.status(201).json(await webhookService.createWebhook(orgId, { name, url, secret, events }));
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
    const result = await webhookService.updateWebhook(orgId, req.params.id, req.body);
    if (!result) return void res.status(404).json({ error: "Webhook not found" });
    res.json(result);
  } catch (err) { next(err); }
});

// DELETE /api/v1/webhooks/:id
router.delete("/:id", requireRole("editor", "admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.user!.orgId as string;
    await webhookService.deleteWebhook(orgId, req.params.id);
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
