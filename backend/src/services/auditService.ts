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
       (entity_type, entity_id, action, policy_id, aggregation_key,
        actor, source_ip, before_state, after_state, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
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
  entityType?: string;
  entityId?:   string;
  action?:     string;
  actor?:      string;
  from?:       string;
  to?:         string;
  limit?:      number;
}

export async function queryAuditLog(filters: AuditLogFilters = {}): Promise<unknown[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (filters.entityType) { conditions.push(`entity_type = $${i++}`); params.push(filters.entityType); }
  if (filters.entityId)   { conditions.push(`entity_id = $${i++}`);   params.push(filters.entityId); }
  if (filters.action)     { conditions.push(`action = $${i++}`);       params.push(filters.action); }
  if (filters.actor)      { conditions.push(`actor = $${i++}`);        params.push(filters.actor); }
  if (filters.from)       { conditions.push(`event_time >= $${i++}`);  params.push(filters.from); }
  if (filters.to)         { conditions.push(`event_time <= $${i++}`);  params.push(filters.to); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(filters.limit ?? 200, 500);

  return query(
    `SELECT id, event_time, entity_type, entity_id, action,
            policy_id, aggregation_key, actor, source_ip, metadata
     FROM audit_log ${where}
     ORDER BY event_time DESC LIMIT ${limit}`,
    params
  );
}
