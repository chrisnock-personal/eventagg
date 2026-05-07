import { query, queryOne } from "../db/pool";
import {
  EventGroupSummary,
  EventGroupDetail,
  SegmentDetail,
  PaginatedResponse,
} from "../types";

export interface EventQueryFilters {
  status?: "in_progress" | "completed" | "all";
  policyId?: string;
  aggregationKey?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

// ─── Map DB rows to API shapes ────────────────────────────────────────────────

function inProgressToSummary(
  row: Record<string, unknown>,
  policyName: string
): EventGroupSummary {
  return {
    id: row.id as string,
    policyId: row.policy_id as string,
    policyName,
    aggregationKey: row.aggregation_key as string,
    keyField: row.key_field as string,
    status: "in_progress",
    segmentCount: row.segment_count as number,
    startTime: row.started_at as string,
    endTime: null,
    durationMs: null,
  };
}

function completedToSummary(
  row: Record<string, unknown>,
  policyName: string
): EventGroupSummary {
  return {
    id: row.id as string,
    policyId: row.policy_id as string,
    policyName,
    aggregationKey: row.aggregation_key as string,
    keyField: row.key_field as string,
    status: "completed",
    segmentCount: row.segment_count as number,
    startTime: row.started_at as string,
    endTime: row.ended_at as string,
    durationMs: row.duration_ms as number,
  };
}

function segmentToDetail(row: Record<string, unknown>): SegmentDetail {
  return {
    eventId: row.id as string,
    sequence: row.sequence as number,
    isCradle: row.is_cradle as boolean,
    isGrave: row.is_grave as boolean,
    timestamp: row.received_at as string,
    body: row.body as Record<string, unknown>,
  };
}

// ─── List events (both stores, unified) ───────────────────────────────────────

export async function listEvents(
  filters: EventQueryFilters
): Promise<PaginatedResponse<EventGroupSummary>> {
  const page  = Math.max(1, filters.page  ?? 1);
  const limit = Math.min(200, Math.max(1, filters.limit ?? 50));
  const offset = (page - 1) * limit;
  const status = filters.status ?? "all";

  const results: EventGroupSummary[] = [];
  let total = 0;

  // Shared WHERE clause builder
  const buildWhere = (
    store: "in_progress" | "completed",
    paramOffset: number
  ): { where: string; params: unknown[] } => {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let i = paramOffset;

    if (filters.policyId) {
      conditions.push(`e.policy_id = $${i++}`);
      params.push(filters.policyId);
    }
    if (filters.aggregationKey) {
      conditions.push(`e.aggregation_key ILIKE $${i++}`);
      params.push(`%${filters.aggregationKey}%`);
    }
    if (filters.from) {
      const col = store === "in_progress" ? "started_at" : "started_at";
      conditions.push(`e.${col} >= $${i++}`);
      params.push(filters.from);
    }
    if (filters.to) {
      const col = store === "in_progress" ? "started_at" : "started_at";
      conditions.push(`e.${col} <= $${i++}`);
      params.push(filters.to);
    }

    return {
      where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
      params,
    };
  };

  if (status === "all" || status === "in_progress") {
    const { where, params } = buildWhere("in_progress", 1);
    const rows = await query<Record<string, unknown>>(
      `SELECT e.*, p.name AS policy_name
       FROM   in_progress_events e
       JOIN   policies p ON p.id = e.policy_id
       ${where}
       ORDER BY e.started_at DESC`,
      params
    );
    rows.forEach((r) =>
      results.push(inProgressToSummary(r, r.policy_name as string))
    );
  }

  if (status === "all" || status === "completed") {
    const { where, params } = buildWhere("completed", 1);
    const rows = await query<Record<string, unknown>>(
      `SELECT e.*, p.name AS policy_name
       FROM   completed_events e
       JOIN   policies p ON p.id = e.policy_id
       ${where}
       ORDER BY e.started_at DESC`,
      params
    );
    rows.forEach((r) =>
      results.push(completedToSummary(r, r.policy_name as string))
    );
  }

  // Sort unified result set by startTime desc, then paginate in memory
  // (For large scale, push pagination into DB per-store; fine for POC)
  results.sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
  );
  total = results.length;
  const paged = results.slice(offset, offset + limit);

  return {
    data: paged,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

// ─── Get single event group with segments ─────────────────────────────────────

export async function getEventById(
  id: string
): Promise<EventGroupDetail | null> {
  // Try in_progress first
  const ip = await queryOne<Record<string, unknown>>(
    `SELECT e.*, p.name AS policy_name
     FROM   in_progress_events e
     JOIN   policies p ON p.id = e.policy_id
     WHERE  e.id = $1`,
    [id]
  );

  if (ip) {
    const segments = await getSegments({ inProgressId: id });
    return {
      ...inProgressToSummary(ip, ip.policy_name as string),
      segments,
    };
  }

  // Try completed
  const ce = await queryOne<Record<string, unknown>>(
    `SELECT e.*, p.name AS policy_name
     FROM   completed_events e
     JOIN   policies p ON p.id = e.policy_id
     WHERE  e.id = $1`,
    [id]
  );

  if (ce) {
    const segments = await getSegments({ completedId: id });
    return {
      ...completedToSummary(ce, ce.policy_name as string),
      segments,
    };
  }

  return null;
}

// ─── Get segments for a group ─────────────────────────────────────────────────

async function getSegments(
  filter: { inProgressId?: string; completedId?: string }
): Promise<SegmentDetail[]> {
  let rows: Record<string, unknown>[];

  if (filter.inProgressId) {
    rows = await query<Record<string, unknown>>(
      `SELECT * FROM event_segments WHERE in_progress_id = $1 ORDER BY sequence ASC`,
      [filter.inProgressId]
    );
  } else {
    rows = await query<Record<string, unknown>>(
      `SELECT * FROM event_segments WHERE completed_id = $1 ORDER BY sequence ASC`,
      [filter.completedId]
    );
  }

  return rows.map(segmentToDetail);
}

export async function getSegmentsForEvent(
  groupId: string
): Promise<SegmentDetail[] | null> {
  const detail = await getEventById(groupId);
  if (!detail) return null;
  return detail.segments;
}
