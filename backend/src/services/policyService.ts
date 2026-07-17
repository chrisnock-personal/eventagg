import { PoolClient } from "pg";
import { query, queryOne, withTransaction } from "../db/pool";
import { logger } from "../logger";
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
    isGlobal: p.org_id === null,
  };
}

// orgId semantics throughout this file:
//   string -> a regular org-scoped caller: sees/owns their own org's
//             policies plus every global (org_id IS NULL) policy, read-only
//             for the global ones (enforced by the WHERE clauses below).
//   null   -> superadmin: sees/owns only global policies. There is no
//             "all orgs' policies" view — superadmin manages global
//             templates, not other orgs' private policies.

export async function listPolicies(orgId: string | null, includeInactive = false): Promise<PolicyResponse[]> {
  const activeClause = includeInactive ? "" : "AND is_active = TRUE";
  const rows = orgId === null
    ? await query<Policy>(`SELECT * FROM policies WHERE org_id IS NULL ${activeClause} ORDER BY created_at ASC`)
    : await query<Policy>(
        `SELECT * FROM policies WHERE (org_id = $1 OR org_id IS NULL) ${activeClause} ORDER BY created_at ASC`,
        [orgId]
      );
  return rows.map(toResponse);
}

export async function getPolicyById(orgId: string | null, id: string): Promise<PolicyResponse | null> {
  const row = orgId === null
    ? await queryOne<Policy>(`SELECT * FROM policies WHERE id = $1 AND org_id IS NULL`, [id])
    : await queryOne<Policy>(`SELECT * FROM policies WHERE id = $1 AND (org_id = $2 OR org_id IS NULL)`, [id, orgId]);
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
  orgId: string | null,
  input: CreatePolicyInput
): Promise<PolicyResponse> {
  return withTransaction(async (client) => {
    const [row] = await client.query<Policy>(
      `INSERT INTO policies
         (org_id, name, domain, key_field, cradle_field, cradle_value, grave_field, grave_value, description, timeout_ms, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        orgId,
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
      orgId,
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
  orgId: string | null,
  id: string,
  input: UpdatePolicyInput
): Promise<PolicyResponse | null> {
  return withTransaction(async (client) => {
    const orgMatch = orgId === null ? "org_id IS NULL" : "org_id = $2";
    const existingParams = orgId === null ? [id] : [id, orgId];
    const existing = await client.query<Policy>(
      `SELECT * FROM policies WHERE id = $1 AND ${orgMatch} AND is_active = TRUE`,
      existingParams
    ).then(r => r.rows[0]);

    if (!existing) return null;

    const updateOrgMatch = orgId === null ? "org_id IS NULL" : "org_id = $12";
    const updateParams: unknown[] = [
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
    ];
    if (orgId !== null) updateParams.push(orgId);

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
       WHERE id = $11 AND ${updateOrgMatch}
       RETURNING *`,
      updateParams
    ).then(r => r.rows);

    await writeAudit(client, {
      orgId,
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
  orgId: string | null,
  id: string,
  actor?: string
): Promise<boolean> {
  return withTransaction(async (client) => {
    const orgMatch = orgId === null ? "org_id IS NULL" : "org_id = $3";
    const params = orgId === null ? [actor ?? null, id] : [actor ?? null, id, orgId];
    const result = await client.query(
      `UPDATE policies SET is_active = FALSE, updated_by = $1 WHERE id = $2 AND ${orgMatch} AND is_active = TRUE`,
      params
    );

    if (result.rowCount === 0) return false;

    await writeAudit(client, {
      orgId,
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
    orgId: string | null;
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
       (org_id, entity_type, entity_id, action, policy_id, aggregation_key, actor, before_state, after_state, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      opts.orgId,
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
// orgId=null (superadmin editing a global policy) sweeps every org currently
// using this policy_id, not just one — there's no single "owning" org for a
// global policy's in-flight groups. Each group's own org_id (already stamped
// at ingest time, independent of the policy's org_id) is used when
// promoting it, never the outer orgId param.
export async function applyPolicyTimeout(orgId: string | null, policyId: string): Promise<number> {
  return withTransaction(async (client) => {
    const orgMatch1 = orgId === null ? "" : "AND ip.org_id = $2";
    const params1 = orgId === null ? [policyId] : [policyId, orgId];

    // 1. Backfill last_raw_event_at from actual max received_at per group
    await client.query(
      `UPDATE in_progress_events ip
       SET    last_raw_event_at = COALESCE(
                (SELECT MAX(re.received_at)
                 FROM   raw_events re
                 WHERE  re.in_progress_id = ip.id),
                ip.started_at
              )
       WHERE  ip.policy_id = $1 ${orgMatch1}`,
      params1
    );

    // 2. Find groups that have now elapsed
    const orgMatch2 = orgId === null ? "" : "AND e.org_id = $2";
    const timedOut = await client.query<{
      id: string; org_id: string; aggregation_key: string; key_field: string;
      raw_event_count: number; cradle_raw_event_id: string | null; started_at: string;
    }>(
      `SELECT e.id, e.org_id, e.aggregation_key, e.key_field,
              e.raw_event_count, e.cradle_raw_event_id, e.started_at
       FROM   in_progress_events e
       JOIN   policies p ON p.id = e.policy_id
       WHERE  e.policy_id = $1
         ${orgMatch2}
         AND  p.timeout_ms IS NOT NULL
         AND  e.last_raw_event_at + (p.timeout_ms || ' milliseconds')::INTERVAL < NOW()`,
      params1
    );

    if (timedOut.rows.length === 0) return 0;

    let count = 0;
    for (const group of timedOut.rows) {
      const [completed] = await client.query<{ id: string }>(
        `INSERT INTO completed_events
           (org_id, policy_id, aggregation_key, key_field, raw_event_count,
            cradle_raw_event_id, grave_raw_event_id, started_at, ended_at,
            status, close_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7, NOW(), 'timed_out', 'policy_timeout')
         RETURNING id`,
        [group.org_id, policyId, group.aggregation_key, group.key_field, group.raw_event_count,
         group.cradle_raw_event_id ?? '00000000-0000-0000-0000-000000000000',
         group.started_at]
      ).then(r => r.rows);

      await client.query(
        `UPDATE raw_events SET in_progress_id = NULL, completed_id = $1 WHERE in_progress_id = $2`,
        [completed.id, group.id]
      );
      await client.query(`DELETE FROM in_progress_events WHERE id = $1`, [group.id]);
      count++;
      logger.info({ aggregationKey: group.aggregation_key, groupId: group.id }, "✓ Retroactively timed out");
    }
    return count;
  });
}
