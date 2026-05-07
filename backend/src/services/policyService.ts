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
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

export async function listPolicies(): Promise<PolicyResponse[]> {
  const rows = await query<Policy>(
    `SELECT * FROM policies WHERE is_active = TRUE ORDER BY created_at ASC`
  );
  return rows.map(toResponse);
}

export async function getPolicyById(id: string): Promise<PolicyResponse | null> {
  const row = await queryOne<Policy>(
    `SELECT * FROM policies WHERE id = $1 AND is_active = TRUE`,
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
  description?: string;
  createdBy?: string;
}

export async function createPolicy(
  input: CreatePolicyInput
): Promise<PolicyResponse> {
  return withTransaction(async (client) => {
    const [row] = await client.query<Policy>(
      `INSERT INTO policies
         (name, domain, key_field, cradle_field, cradle_value, grave_field, grave_value, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
         updated_by   = $9
       WHERE id = $10
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
