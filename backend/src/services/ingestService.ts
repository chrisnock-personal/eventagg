import { PoolClient } from "pg";
import { withTransaction, queryOne } from "../db/pool";
import { Policy, AuditAction, EventGroupDetail, RawEventDetail } from "../types";
import { triggerWebhooks, WebhookGroupPayload } from "./webhookService";

// Resolve a dot-notation path against a JSON object
// e.g. resolvePath({ trade: { ref: "T-001" } }, "trade.ref") => "T-001"
function resolvePath(
  obj: Record<string, unknown>,
  path: string
): unknown {
  return path
    .split(".")
    .reduce<unknown>((curr, key) => {
      if (curr !== null && typeof curr === "object") {
        return (curr as Record<string, unknown>)[key];
      }
      return undefined;
    }, obj);
}

export interface IngestInput {
  policyId: string;
  body: Record<string, unknown>;
  sourceIp?: string;
  apiKey?: string;
  sequenceNumber?: number;
}

export interface IngestResult {
  groupId: string;
  rawEventId: string;
  aggregationKey: string;
  isCradle: boolean;
  isGrave: boolean;
  action: "group_opened" | "raw_event_appended" | "group_promoted";
  status: "in_progress" | "completed";
  _webhookPayload?: WebhookGroupPayload;
}

export async function ingestRawEvent(input: IngestInput): Promise<IngestResult> {
  return withTransaction(async (client) => {
    // 1. Load and validate policy — check existence and active state separately
    const policyRow = await client
      .query<Policy & { is_active: boolean }>(
        `SELECT * FROM policies WHERE id = $1`,
        [input.policyId]
      )
      .then((r) => r.rows[0]);

    if (!policyRow) {
      const err = new Error(`Policy ${input.policyId} not found`);
      (err as any).statusCode = 404;
      throw err;
    }
    if (!policyRow.is_active) {
      const err = new Error(
        `Policy "${policyRow.name}" (${input.policyId}) is inactive — activate it before ingesting`
      );
      (err as any).statusCode = 400;
      (err as any).code = "POLICY_INACTIVE";
      throw err;
    }
    const policy = policyRow;

    // 2. Resolve aggregation key from body
    const rawKey = resolvePath(input.body, policy.key_field);
    if (rawKey === undefined || rawKey === null) {
      throw new Error(
        `Could not resolve aggregation key from body.${policy.key_field}`
      );
    }
    const aggregationKey = String(rawKey);

    // 3. Evaluate cradle and grave conditions
    const cradleActual = resolvePath(input.body, policy.cradle_field);
    const graveActual  = resolvePath(input.body, policy.grave_field);
    const isCradle = String(cradleActual) === policy.cradle_value;
    const isGrave  = String(graveActual)  === policy.grave_value;

    // 4. Find existing open group (lock row for update to prevent races)
    const existingGroup = await client
      .query<{ id: string; raw_event_count: number; cradle_raw_event_id: string | null; started_at: string }>(
        `SELECT id, raw_event_count, cradle_raw_event_id, started_at
         FROM   in_progress_events
         WHERE  policy_id = $1 AND aggregation_key = $2
         FOR UPDATE`,
        [policy.id, aggregationKey]
      )
      .then((r) => r.rows[0] ?? null);

    // 5. Branch: open, append, or promote
    if (!existingGroup && isGrave && !isCradle) {
      // Grave with no open group — discard (no group to close)
      throw new Error(
        `Received grave raw event for key "${aggregationKey}" but no open group exists`
      );
    }

    if (!existingGroup) {
      // ── Open a new group ─────────────────────────────────────────────────
      const group = await client
        .query<{ id: string }>(
          `INSERT INTO in_progress_events
             (policy_id, aggregation_key, key_field)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [policy.id, aggregationKey, policy.key_field]
        )
        .then((r) => r.rows[0]);

      const rawEvent = await insertRawEvent(client, {
        inProgressId: group.id,
        completedId: null,
        policyId: policy.id,
        aggregationKey,
        sequence: 1,
        isCradle,
        isGrave: false,
        body: input.body,
        sourceIp: input.sourceIp,
        apiKey: input.apiKey,
        eventSequenceNumber: input.sequenceNumber,
      });

      if (rawEvent.isDuplicate) {
        return { groupId: group.id, rawEventId: rawEvent.id, aggregationKey, isCradle, isGrave: false, action: "raw_event_appended", status: "in_progress" };
      }

      // Set cradle_raw_event_id
      await client.query(
        `UPDATE in_progress_events SET cradle_raw_event_id = $1 WHERE id = $2`,
        [rawEvent.id, group.id]
      );

      await writeAudit(client, {
        entityType: "event_group",
        entityId: group.id,
        action: AuditAction.GROUP_OPENED,
        policyId: policy.id,
        aggregationKey,
        afterState: { groupId: group.id, rawEventId: rawEvent.id },
      });

      return {
        groupId: group.id,
        rawEventId: rawEvent.id,
        aggregationKey,
        isCradle: true,
        isGrave: false,
        action: "group_opened",
        status: "in_progress",
      };
    }

    // ── Group exists ──────────────────────────────────────────────────────
    const nextSequence = existingGroup.raw_event_count + 1;

    const rawEvent = await insertRawEvent(client, {
      inProgressId: existingGroup.id,
      completedId: null,
      policyId: policy.id,
      aggregationKey,
      sequence: nextSequence,
      isCradle: false,
      isGrave,
      body: input.body,
      sourceIp: input.sourceIp,
      apiKey: input.apiKey,
      eventSequenceNumber: input.sequenceNumber,
    });

    // Idempotent duplicate — return existing group state without side-effects
    if (rawEvent.isDuplicate) {
      return { groupId: existingGroup.id, rawEventId: rawEvent.id, aggregationKey, isCradle: false, isGrave: false, action: "raw_event_appended", status: "in_progress" };
    }

    if (!isGrave) {
      // ── Append to existing group ────────────────────────────────────────
      // Reset the timeout clock on every new raw event
      await client.query(
        `UPDATE in_progress_events SET last_raw_event_at = NOW() WHERE id = $1`,
        [existingGroup.id]
      );

      await writeAudit(client, {
        entityType: "event_group",
        entityId: existingGroup.id,
        action: AuditAction.RAW_EVENT_APPENDED,
        policyId: policy.id,
        aggregationKey,
        afterState: { rawEventId: rawEvent.id, sequence: nextSequence },
      });

      return {
        groupId: existingGroup.id,
        rawEventId: rawEvent.id,
        aggregationKey,
        isCradle: false,
        isGrave: false,
        action: "raw_event_appended",
        status: "in_progress",
      };
    }

    // ── Promote to completed ──────────────────────────────────────────────
    const endTime = new Date();
    const completed = await client
      .query<{ id: string }>(
        `INSERT INTO completed_events
           (policy_id, aggregation_key, key_field, raw_event_count,
            cradle_raw_event_id, grave_raw_event_id, started_at, ended_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         RETURNING id`,
        [
          policy.id,
          aggregationKey,
          policy.key_field,
          nextSequence,
          existingGroup.cradle_raw_event_id,
          rawEvent.id,
          existingGroup.started_at,
        ]
      )
      .then((r) => r.rows[0]);

    // Re-point all raw events to the completed group
    await client.query(
      `UPDATE raw_events
       SET    in_progress_id = NULL,
              completed_id   = $1
       WHERE  in_progress_id = $2`,
      [completed.id, existingGroup.id]
    );

    // Delete from in_progress
    await client.query(
      `DELETE FROM in_progress_events WHERE id = $1`,
      [existingGroup.id]
    );

    await writeAudit(client, {
      entityType: "event_group",
      entityId: completed.id,
      action: AuditAction.GROUP_PROMOTED,
      policyId: policy.id,
      aggregationKey,
      afterState: { completedId: completed.id, rawEventCount: nextSequence },
    });

    const startTime = new Date(existingGroup.started_at);
    const durationMs = endTime.getTime() - startTime.getTime();

    return {
      groupId: completed.id,
      rawEventId: rawEvent.id,
      aggregationKey,
      isCradle: false,
      isGrave: true,
      action: "group_promoted",
      status: "completed",
      _webhookPayload: {
        id: completed.id,
        policyId: policy.id,
        policyName: policy.name,
        aggregationKey,
        status: "completed",
        rawEventCount: nextSequence,
        startTime: existingGroup.started_at,
        endTime: endTime.toISOString(),
        durationMs,
      },
    };
  });
}

export async function fireGroupCompletedWebhook(result: IngestResult): Promise<void> {
  if (result._webhookPayload) {
    await triggerWebhooks("group_completed", result._webhookPayload);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function insertRawEvent(
  client: PoolClient,
  opts: {
    inProgressId: string | null;
    completedId: string | null;
    policyId: string;
    aggregationKey: string;
    sequence: number;
    isCradle: boolean;
    isGrave: boolean;
    body: Record<string, unknown>;
    sourceIp?: string;
    apiKey?: string;
    eventSequenceNumber?: number;
  }
): Promise<{ id: string; isDuplicate: boolean }> {
  // ON CONFLICT on the unique indexes (sequence OR body_hash within group)
  // returns the existing row id so the caller can treat it as idempotent
  const result = await client.query<{ id: string }>(
    `INSERT INTO raw_events
       (in_progress_id, completed_id, policy_id, aggregation_key,
        sequence, is_cradle, is_grave, body, source_ip, ingest_api_key, event_sequence_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      opts.inProgressId,
      opts.completedId,
      opts.policyId,
      opts.aggregationKey,
      opts.sequence,
      opts.isCradle,
      opts.isGrave,
      JSON.stringify(opts.body),
      opts.sourceIp ?? null,
      opts.apiKey ?? null,
      opts.eventSequenceNumber ?? null,
    ]
  );

  if (result.rows.length > 0) {
    return { id: result.rows[0].id, isDuplicate: false };
  }

  // ON CONFLICT hit — fetch the existing raw event id
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM raw_events
     WHERE  ${opts.inProgressId ? "in_progress_id = $1" : "completed_id = $1"}
       AND  body_hash = md5($2::text)
     LIMIT 1`,
    [opts.inProgressId ?? opts.completedId, JSON.stringify(opts.body)]
  );

  console.log(`⚠️  Duplicate raw event detected for key "${opts.aggregationKey}" seq=${opts.sequence} — skipping`);
  return { id: existing.rows[0]?.id ?? "duplicate", isDuplicate: true };
}

async function writeAudit(
  client: PoolClient,
  opts: {
    entityType: string;
    entityId: string;
    action: string;
    policyId?: string;
    aggregationKey?: string;
    actor?: string;
    afterState?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log
       (entity_type, entity_id, action, policy_id, aggregation_key, actor, after_state, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      opts.entityType,
      opts.entityId,
      opts.action,
      opts.policyId ?? null,
      opts.aggregationKey ?? null,
      opts.actor ?? null,
      opts.afterState ? JSON.stringify(opts.afterState) : null,
      opts.metadata ? JSON.stringify(opts.metadata) : null,
    ]
  );
}
