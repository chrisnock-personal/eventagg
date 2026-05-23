import { Router, Request, Response, NextFunction } from "express";
import { requireAuth, requireRole } from "../middleware/session";
import * as webhookService from "../services/webhookService";

const router = Router();

// GET /api/v1/webhooks
router.get("/", requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await webhookService.listWebhooks());
  } catch (err) { next(err); }
});

// POST /api/v1/webhooks
router.post("/", requireAuth, requireRole("editor", "admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, url, secret, events } = req.body;
    if (!name || !url) return void res.status(400).json({ error: "name and url are required" });
    res.status(201).json(await webhookService.createWebhook({ name, url, secret, events }));
  } catch (err) { next(err); }
});

// GET /api/v1/webhooks/deliveries  (must come before /:id)
router.get("/deliveries", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { webhookId, limit } = req.query;
    res.json(await webhookService.listDeliveries({
      webhookId: webhookId as string | undefined,
      limit: limit ? Number(limit) : 100,
    }));
  } catch (err) { next(err); }
});

// PUT /api/v1/webhooks/:id
router.put("/:id", requireAuth, requireRole("editor", "admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await webhookService.updateWebhook(req.params.id, req.body);
    if (!result) return void res.status(404).json({ error: "Webhook not found" });
    res.json(result);
  } catch (err) { next(err); }
});

// DELETE /api/v1/webhooks/:id
router.delete("/:id", requireAuth, requireRole("editor", "admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await webhookService.deleteWebhook(req.params.id);
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
