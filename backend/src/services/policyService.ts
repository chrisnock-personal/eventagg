import { PoolClient } from "pg";
import { query, queryOne, withTransaction } from "../db/pool";
import {
  Policy,
  PolicyResponse,
  AuditAction,
} from "../types";

function toResponse(p: Policy): PolicyResponse {
  return {
    id: p.id,
    name: p.name,
    domain: p.domain,
    keyField: p.key_field,
    cradleField: p.cradle_field,
    cradleValue: p.cradle_value,
    graveField: p.grave_field,
    graveValue: p.grave_value,
    description: p.description,
    isActive: p.is_active,
    timeoutMs: p.timeout_ms ?? null,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

export async function listPolicies(includeInactive = false): Promise<PolicyResponse[]> {
  const rows = await query<Policy>(
    includeInactive
      ? `SELECT * FROM policies ORDER BY created_at ASC`
      : `SELECT * FROM policies WHERE is_active = TRUE ORDER BY created_at ASC`
  );
  return rows.map(toResponse);
}

export async function getPolicyById(id: string): Promise<PolicyResponse | null> {
  const row = await queryOne<Policy>(
    `SELECT * FROM policies WHERE id = $1`,
    [id]
  );
  return row ? toResponse(row) : null;
}

export interface CreatePolicyInput {
  name: string;
  domain: string;
  keyField: string;
  cradleField: string;
  cradleValue: string;
  graveField: string;
  graveValue: string;
  description?: string | null;
  timeoutMs?: number | null;
  createdBy?: string;
}

export async function createPolicy(
  input: CreatePolicyInput
): Promise<PolicyResponse> {
  return withTransaction(async (client) => {
    const [row] = await client.query<Policy>(
      `INSERT INTO policies
         (name, domain, key_field, cradle_field, cradle_value, grave_field, grave_value, description, timeout_ms, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        input.name,
        input.domain,
        input.keyField,
        input.cradleField,
        input.cradleValue,
        input.graveField,
        input.graveValue,
        input.description ?? null,
        input.timeoutMs ?? null,
        input.createdBy ?? null,
      ]
    ).then(r => r.rows);

    await writeAudit(client, {
      entityType: "policy",
      entityId: row.id,
      action: AuditAction.POLICY_CREATED,
      policyId: row.id,
      afterState: row as unknown as Record<string, unknown>,
      actor: input.createdBy,
    });

    return toResponse(row);
  });
}

export interface UpdatePolicyInput extends Partial<CreatePolicyInput> {
  updatedBy?: string;
}

export async function updatePolicy(
  id: string,
  input: UpdatePolicyInput
): Promise<PolicyResponse | null> {
  return withTransaction(async (client) => {
    const existing = await client.query<Policy>(
      `SELECT * FROM policies WHERE id = $1 AND is_active = TRUE`,
      [id]
    ).then(r => r.rows[0]);

    if (!existing) return null;

    const [updated] = await client.query<Policy>(
      `UPDATE policies SET
         name         = COALESCE($1, name),
         domain       = COALESCE($2, domain),
         key_field    = COALESCE($3, key_field),
         cradle_field = COALESCE($4, cradle_field),
         cradle_value = COALESCE($5, cradle_value),
         grave_field  = COALESCE($6, grave_field),
         grave_value  = COALESCE($7, grave_value),
         description  = COALESCE($8, description),
         timeout_ms   = $9,
         updated_by   = $10
       WHERE id = $11
       RETURNING *`,
      [
        input.name ?? null,
        input.domain ?? null,
        input.keyField ?? null,
        input.cradleField ?? null,
        input.cradleValue ?? null,
        input.graveField ?? null,
        input.graveValue ?? null,
        input.description ?? null,
        "timeoutMs" in input ? (input.timeoutMs ?? null) : existing.timeout_ms,
        input.updatedBy ?? null,
        id,
      ]
    ).then(r => r.rows);

    await writeAudit(client, {
      entityType: "policy",
      entityId: id,
      action: AuditAction.POLICY_UPDATED,
      policyId: id,
      beforeState: existing as unknown as Record<string, unknown>,
      afterState: updated as unknown as Record<string, unknown>,
      actor: input.updatedBy,
    });

    return toResponse(updated);
  });
}

export async function deactivatePolicy(
  id: string,
  actor?: string
): Promise<boolean> {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE policies SET is_active = FALSE, updated_by = $1 WHERE id = $2 AND is_active = TRUE`,
      [actor ?? null, id]
    );

    if (result.rowCount === 0) return false;

    await writeAudit(client, {
      entityType: "policy",
      entityId: id,
      action: AuditAction.POLICY_DEACTIVATED,
      policyId: id,
      actor,
    });

    return true;
  });
}

// ─── Shared audit helper ──────────────────────────────────────────────────────
async function writeAudit(
  client: PoolClient,
  opts: {
    entityType: string;
    entityId: string;
    action: string;
    policyId?: string;
    aggregationKey?: string;
    actor?: string;
    beforeState?: Record<string, unknown>;
    afterState?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log
       (entity_type, entity_id, action, policy_id, aggregation_key, actor, before_state, after_state, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      opts.entityType,
      opts.entityId,
      opts.action,
      opts.policyId ?? null,
      opts.aggregationKey ?? null,
      opts.actor ?? null,
      opts.beforeState ? JSON.stringify(opts.beforeState) : null,
      opts.afterState ? JSON.stringify(opts.afterState) : null,
      opts.metadata ? JSON.stringify(opts.metadata) : null,
    ]
  );
}

// ─── Retroactive timeout sweep for a specific policy ─────────────────────────
export async function applyPolicyTimeout(policyId: string): Promise<number> {
  return withTransaction(async (client) => {
    // 1. Backfill last_raw_event_at from actual max received_at per group
    await client.query(
      `UPDATE in_progress_events ip
       SET    last_raw_event_at = COALESCE(
                (SELECT MAX(re.received_at)
                 FROM   raw_events re
                 WHERE  re.in_progress_id = ip.id),
                ip.started_at
              )
       WHERE  ip.policy_id = $1`,
      [policyId]
    );

    // 2. Find groups that have now elapsed
    const timedOut = await client.query<{
      id: string; aggregation_key: string; key_field: string;
      raw_event_count: number; cradle_raw_event_id: string | null; started_at: string;
    }>(
      `SELECT e.id, e.aggregation_key, e.key_field,
              e.raw_event_count, e.cradle_raw_event_id, e.started_at
       FROM   in_progress_events e
       JOIN   policies p ON p.id = e.policy_id
       WHERE  e.policy_id = $1
         AND  p.timeout_ms IS NOT NULL
         AND  e.last_raw_event_at + (p.timeout_ms || ' milliseconds')::INTERVAL < NOW()`,
      [policyId]
    );

    if (timedOut.rows.length === 0) return 0;

    let count = 0;
    for (const group of timedOut.rows) {
      const [completed] = await client.query<{ id: string }>(
        `INSERT INTO completed_events
           (policy_id, aggregation_key, key_field, raw_event_count,
            cradle_raw_event_id, grave_raw_event_id, started_at, ended_at,
            status, close_reason)
         VALUES ($1, $2, $3, $4, $5, $5, $6, NOW(), 'timed_out', 'policy_timeout')
         RETURNING id`,
        [policyId, group.aggregation_key, group.key_field, group.raw_event_count,
         group.cradle_raw_event_id ?? '00000000-0000-0000-0000-000000000000',
         group.started_at]
      ).then(r => r.rows);

      await client.query(
        `UPDATE raw_events SET in_progress_id = NULL, completed_id = $1 WHERE in_progress_id = $2`,
        [completed.id, group.id]
      );
      await client.query(`DELETE FROM in_progress_events WHERE id = $1`, [group.id]);
      count++;
      console.log(`    ✓ Retroactively timed out: ${group.aggregation_key} (${group.id.slice(0,8)}…)`);
    }
    return count;
  });
}
