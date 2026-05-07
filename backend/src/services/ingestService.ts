import { PoolClient } from "pg";
import { withTransaction, queryOne } from "../db/pool";
import { Policy, AuditAction, EventGroupDetail, SegmentDetail } from "../types";

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
}

export interface IngestResult {
  groupId: string;
  segmentId: string;
  aggregationKey: string;
  isCradle: boolean;
  isGrave: boolean;
  action: "group_opened" | "segment_appended" | "group_promoted";
  status: "in_progress" | "completed";
}

export async function ingestSegment(input: IngestInput): Promise<IngestResult> {
  return withTransaction(async (client) => {
    // 1. Load policy
    const policy = await client
      .query<Policy>(
        `SELECT * FROM policies WHERE id = $1 AND is_active = TRUE`,
        [input.policyId]
      )
      .then((r) => r.rows[0]);

    if (!policy) {
      throw new Error(`Policy ${input.policyId} not found or inactive`);
    }

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
      .query<{ id: string; segment_count: number; cradle_segment_id: string | null; started_at: string }>(
        `SELECT id, segment_count, cradle_segment_id, started_at
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
        `Received grave segment for key "${aggregationKey}" but no open group exists`
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

      const segment = await insertSegment(client, {
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
      });

      // Set cradle_segment_id
      await client.query(
        `UPDATE in_progress_events SET cradle_segment_id = $1 WHERE id = $2`,
        [segment.id, group.id]
      );

      await writeAudit(client, {
        entityType: "event_group",
        entityId: group.id,
        action: AuditAction.GROUP_OPENED,
        policyId: policy.id,
        aggregationKey,
        afterState: { groupId: group.id, segmentId: segment.id },
      });

      return {
        groupId: group.id,
        segmentId: segment.id,
        aggregationKey,
        isCradle: true,
        isGrave: false,
        action: "group_opened",
        status: "in_progress",
      };
    }

    // ── Group exists ──────────────────────────────────────────────────────
    const nextSequence = existingGroup.segment_count + 1;

    const segment = await insertSegment(client, {
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
    });

    if (!isGrave) {
      // ── Append to existing group ────────────────────────────────────────
      await writeAudit(client, {
        entityType: "event_group",
        entityId: existingGroup.id,
        action: AuditAction.SEGMENT_APPENDED,
        policyId: policy.id,
        aggregationKey,
        afterState: { segmentId: segment.id, sequence: nextSequence },
      });

      return {
        groupId: existingGroup.id,
        segmentId: segment.id,
        aggregationKey,
        isCradle: false,
        isGrave: false,
        action: "segment_appended",
        status: "in_progress",
      };
    }

    // ── Promote to completed ──────────────────────────────────────────────
    const completed = await client
      .query<{ id: string }>(
        `INSERT INTO completed_events
           (policy_id, aggregation_key, key_field, segment_count,
            cradle_segment_id, grave_segment_id, started_at, ended_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         RETURNING id`,
        [
          policy.id,
          aggregationKey,
          policy.key_field,
          nextSequence,
          existingGroup.cradle_segment_id,
          segment.id,
          existingGroup.started_at,
        ]
      )
      .then((r) => r.rows[0]);

    // Re-point all segments to the completed group
    await client.query(
      `UPDATE event_segments
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
      afterState: { completedId: completed.id, segmentCount: nextSequence },
    });

    return {
      groupId: completed.id,
      segmentId: segment.id,
      aggregationKey,
      isCradle: false,
      isGrave: true,
      action: "group_promoted",
      status: "completed",
    };
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function insertSegment(
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
  }
): Promise<{ id: string }> {
  return client
    .query<{ id: string }>(
      `INSERT INTO event_segments
         (in_progress_id, completed_id, policy_id, aggregation_key,
          sequence, is_cradle, is_grave, body, source_ip, ingest_api_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
      ]
    )
    .then((r) => r.rows[0]);
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
