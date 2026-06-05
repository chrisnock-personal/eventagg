import crypto from "crypto";
import { query, queryOne } from "../db/pool";

export interface Webhook {
  id: string;
  name: string;
  url: string;
  secret: string;
  events: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  webhookName: string;
  eventType: string;
  groupId: string;
  status: "pending" | "success" | "failed";
  attempts: number;
  lastAttemptAt: string | null;
  responseStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface WebhookGroupPayload {
  id: string;
  policyId: string;
  policyName: string;
  aggregationKey: string;
  status: "completed" | "timed_out";
  rawEventCount: number;
  startTime: string;
  endTime: string;
  durationMs: number;
}

interface WebhookRow {
  id: string; name: string; url: string; secret: string;
  events: string[]; is_active: boolean; created_at: string; updated_at: string;
}

interface DeliveryRow {
  id: string; webhook_id: string; webhook_name: string;
  event_type: string; group_id: string; status: string; attempts: number;
  last_attempt_at: string | null; response_status: number | null;
  response_body: string | null; error_message: string | null; created_at: string;
}

function toWebhook(r: WebhookRow): Webhook {
  return { id: r.id, name: r.name, url: r.url, secret: r.secret,
    events: r.events, isActive: r.is_active, createdAt: r.created_at, updatedAt: r.updated_at };
}

function toDelivery(r: DeliveryRow): WebhookDelivery {
  return { id: r.id, webhookId: r.webhook_id, webhookName: r.webhook_name,
    eventType: r.event_type, groupId: r.group_id, status: r.status as WebhookDelivery["status"],
    attempts: r.attempts, lastAttemptAt: r.last_attempt_at, responseStatus: r.response_status,
    responseBody: r.response_body, errorMessage: r.error_message, createdAt: r.created_at };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function listWebhooks(): Promise<Webhook[]> {
  const rows = await query<WebhookRow>(`SELECT * FROM webhooks ORDER BY created_at ASC`);
  return rows.map(toWebhook);
}

export async function createWebhook(input: {
  name: string; url: string; secret?: string; events?: string[];
}): Promise<Webhook> {
  const row = await queryOne<WebhookRow>(
    `INSERT INTO webhooks (name, url, secret, events)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [input.name, input.url, input.secret ?? "", input.events ?? ["group_completed", "group_timed_out"]]
  );
  if (!row) throw new Error("Failed to create webhook");
  return toWebhook(row);
}

export async function updateWebhook(id: string, input: {
  name?: string; url?: string; secret?: string; events?: string[]; isActive?: boolean;
}): Promise<Webhook | null> {
  const row = await queryOne<WebhookRow>(
    `UPDATE webhooks SET
       name       = COALESCE($1, name),
       url        = COALESCE($2, url),
       secret     = COALESCE($3, secret),
       events     = COALESCE($4, events),
       is_active  = COALESCE($5, is_active),
       updated_at = NOW()
     WHERE id = $6 RETURNING *`,
    [input.name ?? null, input.url ?? null, input.secret ?? null,
     input.events ?? null, input.isActive ?? null, id]
  );
  return row ? toWebhook(row) : null;
}

export async function deleteWebhook(id: string): Promise<boolean> {
  const result = await query(`DELETE FROM webhooks WHERE id = $1`, [id]);
  return (result as any).rowCount > 0;
}

export async function listDeliveries(params: {
  webhookId?: string; limit?: number;
}): Promise<WebhookDelivery[]> {
  const lim = params.limit ?? 100;
  const rows = params.webhookId
    ? await query<DeliveryRow>(
        `SELECT d.*, w.name AS webhook_name FROM webhook_deliveries d
         JOIN webhooks w ON w.id = d.webhook_id
         WHERE d.webhook_id = $1 ORDER BY d.created_at DESC LIMIT $2`,
        [params.webhookId, lim]
      )
    : await query<DeliveryRow>(
        `SELECT d.*, w.name AS webhook_name FROM webhook_deliveries d
         JOIN webhooks w ON w.id = d.webhook_id
         ORDER BY d.created_at DESC LIMIT $1`,
        [lim]
      );
  return rows.map(toDelivery);
}

// ── Delivery ──────────────────────────────────────────────────────────────────

async function attemptDelivery(
  webhook: Webhook,
  eventType: string,
  group: WebhookGroupPayload,
  deliveryId: string,
  attempt: number,
): Promise<void> {
  const payload = JSON.stringify({ event: eventType, timestamp: new Date().toISOString(), group });
  const signature = webhook.secret
    ? "sha256=" + crypto.createHmac("sha256", webhook.secret).update(payload).digest("hex")
    : "";

  await query(
    `UPDATE webhook_deliveries SET attempts = $1, last_attempt_at = NOW(), status = 'pending' WHERE id = $2`,
    [attempt, deliveryId]
  );

  try {
    const res = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "AggreGator-Webhook/1.0",
        "X-AggreGator-Event": eventType,
        "X-AggreGator-Delivery": deliveryId,
        ...(signature ? { "X-AggreGator-Signature": signature } : {}),
      },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    });

    const responseBody = await res.text().catch(() => "");
    const success = res.status >= 200 && res.status < 300;

    await query(
      `UPDATE webhook_deliveries SET status = $1, response_status = $2, response_body = $3 WHERE id = $4`,
      [success ? "success" : "failed", res.status, responseBody.slice(0, 1000), deliveryId]
    );

    if (!success && attempt < 3) {
      const delay = attempt === 1 ? 5_000 : 30_000;
      setTimeout(() => attemptDelivery(webhook, eventType, group, deliveryId, attempt + 1).catch(() => {}), delay);
    }
  } catch (err: any) {
    await query(
      `UPDATE webhook_deliveries SET status = 'failed', error_message = $1 WHERE id = $2`,
      [String(err.message ?? "Unknown error").slice(0, 500), deliveryId]
    );
    if (attempt < 3) {
      const delay = attempt === 1 ? 5_000 : 30_000;
      setTimeout(() => attemptDelivery(webhook, eventType, group, deliveryId, attempt + 1).catch(() => {}), delay);
    }
  }
}

export async function triggerWebhooks(
  eventType: "group_completed" | "group_timed_out",
  group: WebhookGroupPayload,
): Promise<void> {
  try {
    const rows = await query<WebhookRow>(
      `SELECT * FROM webhooks WHERE is_active = TRUE AND $1 = ANY(events)`,
      [eventType]
    );
    if (rows.length === 0) return;

    const payload = { event: eventType, timestamp: new Date().toISOString(), group };

    for (const row of rows) {
      const delivery = await queryOne<{ id: string }>(
        `INSERT INTO webhook_deliveries (webhook_id, event_type, group_id, payload)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [row.id, eventType, group.id, JSON.stringify(payload)]
      );
      if (!delivery) continue;

      const webhook = toWebhook(row);
      setImmediate(() => {
        attemptDelivery(webhook, eventType, group, delivery.id, 1).catch(err =>
          console.error(`Webhook delivery error [${row.id}]:`, err)
        );
      });
    }
  } catch (err) {
    console.error("triggerWebhooks error:", err);
  }
}
