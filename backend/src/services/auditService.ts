import { query } from "../db/pool";

export type AuditAction =
  | "user.login"
  | "user.logout"
  | "user.created"
  | "user.updated"
  | "user.deleted"
  | "user.password_changed"
  | "policy.created"
  | "policy.updated"
  | "policy.deleted"
  | "policy.toggled"
  | "event.ingested"
  | "event.timed_out"
  | "event.group_opened"
  | "event.group_completed";

export interface AuditEntry {
  // Nullable to allow superadmin actions (e.g. login) to still be logged even
  // though superadmin has no org context.
  orgId?:         string | null;
  entityType:     string;
  entityId:       string;
  action:         AuditAction;
  policyId?:      string;
  aggregationKey?: string;
  actor?:         string;
  sourceIp?:      string;
  beforeState?:   Record<string, unknown>;
  afterState?:    Record<string, unknown>;
  metadata?:      Record<string, unknown>;
}

// Fire-and-forget — never throws, never blocks the caller
export function audit(entry: AuditEntry): void {
  query(
    `INSERT INTO audit_log
       (org_id, entity_type, entity_id, action, policy_id, aggregation_key,
        actor, source_ip, before_state, after_state, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      entry.orgId         ?? null,
      entry.entityType,
      entry.entityId,
      entry.action,
      entry.policyId      ?? null,
      entry.aggregationKey ?? null,
      entry.actor         ?? null,
      entry.sourceIp      ?? null,
      entry.beforeState   ? JSON.stringify(entry.beforeState) : null,
      entry.afterState    ? JSON.stringify(entry.afterState)  : null,
      entry.metadata      ? JSON.stringify(entry.metadata)    : null,
    ]
  ).catch(err => console.error("⚠️  Audit log write failed:", err.message));
}

// Query helpers for the audit log route
export interface AuditLogFilters {
  // Required in practice for org-scoped admins; superadmin (Phase 2) would
  // omit it to see instance-wide audit history.
  orgId?:      string;
  entityType?: string;
  entityId?:   string;
  action?:     string;
  actor?:      string;
  from?:       string;
  to?:         string;
  limit?:      number;
  offset?:     number;
}

function buildAuditConditions(filters: AuditLogFilters): { where: string; params: unknown[]; nextI: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (filters.orgId)      { conditions.push(`org_id = $${i++}`);     params.push(filters.orgId); }
  if (filters.entityType) { conditions.push(`entity_type = $${i++}`); params.push(filters.entityType); }
  if (filters.entityId)   { conditions.push(`entity_id = $${i++}`);   params.push(filters.entityId); }
  if (filters.action)     { conditions.push(`action ILIKE $${i++}`);  params.push(`%${filters.action}%`); }
  if (filters.actor)      { conditions.push(`actor ILIKE $${i++}`);   params.push(`%${filters.actor}%`); }
  if (filters.from)       { conditions.push(`event_time >= $${i++}`); params.push(filters.from); }
  if (filters.to)         { conditions.push(`event_time <= $${i++}`); params.push(filters.to); }

  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params, nextI: i };
}

export async function queryAuditLog(filters: AuditLogFilters = {}): Promise<unknown[]> {
  const { where, params, nextI } = buildAuditConditions(filters);
  const limit  = Math.min(filters.limit ?? 200, 500);
  const offset = filters.offset ?? 0;

  return query(
    `SELECT id, event_time, entity_type, entity_id, action,
            policy_id, aggregation_key, actor, source_ip, metadata
     FROM audit_log ${where}
     ORDER BY event_time DESC LIMIT $${nextI} OFFSET $${nextI + 1}`,
    [...params, limit, offset]
  );
}

export async function queryAuditLogPaged(filters: AuditLogFilters = {}): Promise<{ rows: unknown[]; total: number }> {
  const { where, params, nextI } = buildAuditConditions(filters);
  const limit  = Math.min(filters.limit ?? 100, 500);
  const offset = filters.offset ?? 0;

  const [rows, countRows] = await Promise.all([
    query(
      `SELECT id, event_time, entity_type, entity_id, action,
              policy_id, aggregation_key, actor, source_ip, metadata
       FROM audit_log ${where}
       ORDER BY event_time DESC LIMIT $${nextI} OFFSET $${nextI + 1}`,
      [...params, limit, offset]
    ),
    query<{ total: string }>(
      `SELECT COUNT(*) AS total FROM audit_log ${where}`,
      params
    ),
  ]);

  return { rows, total: parseInt(countRows[0]?.total ?? "0") };
}
