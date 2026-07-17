import { query, queryOne } from "../db/pool";
import {
  EventGroupSummary,
  EventGroupDetail,
  RawEventDetail,
  PaginatedResponse,
} from "../types";

export interface EventQueryFilters {
  status?: "in_progress" | "completed" | "timed_out" | "all";
  policyId?: string;
  aggregationKey?: string;
  from?: string;
  to?: string;
  bodySearch?: string;
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
    rawEventCount: row.raw_event_count as number,
    startTime: row.started_at as string,
    endTime: null,
    durationMs: null,
    closeReason: null,
    lastRawEventAt: (row.last_raw_event_at ?? row.started_at) as string,
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
    status: (row.status as "completed" | "timed_out") ?? "completed",
    rawEventCount: row.raw_event_count as number,
    startTime: row.started_at as string,
    endTime: row.ended_at as string,
    durationMs: row.duration_ms as number,
    closeReason: (row.close_reason as string | null) ?? null,
    lastRawEventAt: null,
  };
}

function rawEventToDetail(row: Record<string, unknown>): RawEventDetail {
  return {
    eventId: row.id as string,
    sequence: row.sequence as number,
    isCradle: row.is_cradle as boolean,
    isGrave: row.is_grave as boolean,
    timestamp: row.received_at as string,
    body: row.body as Record<string, unknown>,
    eventSequenceNumber: (row.event_sequence_number as number | null) ?? null,
  };
}

// ─── Performance data for Event Group Performance tab ─────────────────────────

export async function getEventPerformance(orgId: string, filters: EventQueryFilters): Promise<{
  slowestCompleted: EventGroupSummary[];
  inProgressAging:  EventGroupSummary[];
  durationHistogram: { bucket: string; minMs: number; maxMs: number; count: number }[];
}> {
  const conditions: string[] = [`e.org_id = $1`];
  const params: unknown[] = [orgId];
  let i = 2;
  if (filters.policyId)       { conditions.push(`e.policy_id = $${i++}`);          params.push(filters.policyId); }
  if (filters.aggregationKey) { conditions.push(`e.aggregation_key ILIKE $${i++}`); params.push(`%${filters.aggregationKey}%`); }
  if (filters.from)           { conditions.push(`e.started_at >= $${i++}`);         params.push(filters.from); }
  if (filters.to)             { conditions.push(`e.started_at <= $${i++}`);         params.push(filters.to); }
  const ceWhere  = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const ipWhere  = ceWhere;

  // Slowest 50 completed groups sorted by duration desc
  const ceRows = await query<Record<string, unknown>>(
    `SELECT e.id, e.policy_id, p.name AS policy_name, e.aggregation_key, e.key_field,
            e.raw_event_count, e.started_at, e.ended_at, e.duration_ms
     FROM completed_events e JOIN policies p ON p.id = e.policy_id
     ${ceWhere}
     ORDER BY e.duration_ms DESC NULLS LAST
     LIMIT 50`, params
  );

  // All in-progress groups sorted by age (oldest first)
  const ipRows = await query<Record<string, unknown>>(
    `SELECT e.id, e.policy_id, p.name AS policy_name, e.aggregation_key, e.key_field,
            e.raw_event_count, e.started_at
     FROM in_progress_events e JOIN policies p ON p.id = e.policy_id
     ${ipWhere}
     ORDER BY e.started_at ASC`, params
  );

  // Duration histogram buckets (all completed, not just top 50)
  const histBuckets = [
    { bucket: "< 1s",   minMs: 0,          maxMs: 1000        },
    { bucket: "1–10s",  minMs: 1000,        maxMs: 10000       },
    { bucket: "10s–1m", minMs: 10000,       maxMs: 60000       },
    { bucket: "1–10m",  minMs: 60000,       maxMs: 600000      },
    { bucket: "10m–1h", minMs: 600000,      maxMs: 3600000     },
    { bucket: "1–8h",   minMs: 3600000,     maxMs: 28800000    },
    { bucket: "8–24h",  minMs: 28800000,    maxMs: 86400000    },
    { bucket: "1–3d",   minMs: 86400000,    maxMs: 259200000   },
    { bucket: "> 3d",   minMs: 259200000,   maxMs: 999999999999 },
  ];

  const histRows = await query<{ bucket_idx: string; cnt: string }>(
    `SELECT
       CASE
         WHEN duration_ms < 1000        THEN '0'
         WHEN duration_ms < 10000       THEN '1'
         WHEN duration_ms < 60000       THEN '2'
         WHEN duration_ms < 600000      THEN '3'
         WHEN duration_ms < 3600000     THEN '4'
         WHEN duration_ms < 28800000    THEN '5'
         WHEN duration_ms < 86400000    THEN '6'
         WHEN duration_ms < 259200000   THEN '7'
         ELSE '8'
       END AS bucket_idx,
       COUNT(*)::TEXT AS cnt
     FROM completed_events e JOIN policies p ON p.id = e.policy_id
     ${ceWhere}
     GROUP BY bucket_idx
     ORDER BY bucket_idx`, params
  );
  const histMap = new Map(histRows.map(r => [r.bucket_idx, parseInt(r.cnt)]));

  return {
    slowestCompleted: ceRows.map(r => completedToSummary(r, r.policy_name as string)),
    inProgressAging:  ipRows.map(r => inProgressToSummary(r, r.policy_name as string)),
    durationHistogram: histBuckets.map((b, idx) => ({
      bucket: b.bucket,
      minMs:  b.minMs,
      maxMs:  b.maxMs,
      count:  histMap.get(String(idx)) ?? 0,
    })),
  };
}

// ─── Stats for Reports (aggregate queries — no pagination) ────────────────────

export async function getEventStats(orgId: string, filters: EventQueryFilters): Promise<{
  totalGroups: number; completed: number; inProgress: number; timedOut: number;
  totalRawEvents: number; avgDurationMs: number;
  byPolicy: { policyId: string; policyName: string; total: number; completed: number; timedOut: number; inProgress: number; totalRawEvents: number; avgDurationMs: number }[];
  throughput: { bucket: string; opened: number; closed: number }[];
}> {
  const status = filters.status ?? "all";

  const conditions: string[] = [`e.org_id = $1`];
  const params: unknown[] = [orgId];
  let i = 2;
  if (filters.policyId)       { conditions.push(`e.policy_id = $${i++}`);              params.push(filters.policyId); }
  if (filters.aggregationKey) { conditions.push(`e.aggregation_key ILIKE $${i++}`);     params.push(`%${filters.aggregationKey}%`); }
  if (filters.from)           { conditions.push(`e.started_at >= $${i++}`);             params.push(filters.from); }
  if (filters.to)             { conditions.push(`e.started_at <= $${i++}`);             params.push(filters.to); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  // In-progress count
  const ipRow = await queryOne<{ cnt: string; rawevts: string }>(
    `SELECT COUNT(*)::TEXT AS cnt, COALESCE(SUM(e.raw_event_count),0)::TEXT AS rawevts
     FROM in_progress_events e JOIN policies p ON p.id = e.policy_id ${where}`, params
  );

  // Completed count — split by status
  const ceRow = await queryOne<{ cnt: string; rawevts: string; avg_dur: string; timed_out_cnt: string }>(
    `SELECT COUNT(*)::TEXT AS cnt,
            COALESCE(SUM(e.raw_event_count),0)::TEXT AS rawevts,
            COALESCE(AVG(e.duration_ms),0)::TEXT AS avg_dur,
            COUNT(*) FILTER (WHERE e.status = 'timed_out')::TEXT AS timed_out_cnt
     FROM completed_events e JOIN policies p ON p.id = e.policy_id ${where}`, params
  );

  const inProgressCount  = status === "completed" || status === "timed_out" ? 0 : parseInt(ipRow?.cnt ?? "0");
  const completedCount   = status === "in_progress" ? 0 : parseInt(ceRow?.cnt ?? "0");
  const timedOutCount    = status === "in_progress" ? 0 : parseInt(ceRow?.timed_out_cnt ?? "0");
  const totalRawEvents   = (status !== "completed" && status !== "timed_out" ? parseInt(ipRow?.rawevts ?? "0") : 0)
                         + (status !== "in_progress" ? parseInt(ceRow?.rawevts ?? "0") : 0);
  const avgDurationMs    = status !== "in_progress" ? parseFloat(ceRow?.avg_dur ?? "0") : 0;

  // Per-policy breakdown — include timed_out split
  const polRows = await query<{ policy_id: string; policy_name: string; status: string; cnt: string; rawevts: string; avg_dur: string }>(
    `SELECT e.policy_id, p.name AS policy_name, 'ip' AS status,
            COUNT(*)::TEXT AS cnt, COALESCE(SUM(e.raw_event_count),0)::TEXT AS rawevts, '0' AS avg_dur
     FROM in_progress_events e JOIN policies p ON p.id = e.policy_id ${where}
     GROUP BY e.policy_id, p.name
     UNION ALL
     SELECT e.policy_id, p.name, e.status::text,
            COUNT(*)::TEXT, COALESCE(SUM(e.raw_event_count),0)::TEXT, COALESCE(AVG(e.duration_ms),0)::TEXT
     FROM completed_events e JOIN policies p ON p.id = e.policy_id ${where}
     GROUP BY e.policy_id, p.name, e.status`, params
  );

  const polMap = new Map<string, { policyId: string; policyName: string; total: number; completed: number; timedOut: number; inProgress: number; totalRawEvents: number; durSum: number; durCnt: number }>();
  for (const r of polRows) {
    const ex = polMap.get(r.policy_id) ?? { policyId: r.policy_id, policyName: r.policy_name, total: 0, completed: 0, timedOut: 0, inProgress: 0, totalRawEvents: 0, durSum: 0, durCnt: 0 };
    const cnt = parseInt(r.cnt);
    ex.total += cnt; ex.totalRawEvents += parseInt(r.rawevts);
    if (r.status === "completed")      { ex.completed += cnt; ex.durSum += parseFloat(r.avg_dur) * cnt; ex.durCnt += cnt; }
    else if (r.status === "timed_out") { ex.timedOut  += cnt; ex.durSum += parseFloat(r.avg_dur) * cnt; ex.durCnt += cnt; }
    else { ex.inProgress += cnt; }
    polMap.set(r.policy_id, ex);
  }
  const byPolicy = Array.from(polMap.values()).map(p => ({
    policyId: p.policyId, policyName: p.policyName, total: p.total,
    completed: p.completed, timedOut: p.timedOut, inProgress: p.inProgress,
    totalRawEvents: p.totalRawEvents,
    avgDurationMs: p.durCnt > 0 ? p.durSum / p.durCnt : 0,
  }));

  // Throughput
  const windowStart = filters.from ?? new Date(Date.now() - 90 * 86400000).toISOString();
  const tpWhere = conditions.length ? where + ` AND e.started_at >= '${windowStart}'` : `WHERE e.started_at >= '${windowStart}'`;
  const tpRows = await query<{ bucket: string; opened: string; closed: string }>(
    `SELECT to_char(date_trunc('day', e.started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS bucket,
            COUNT(*)::TEXT AS opened, '0' AS closed
     FROM in_progress_events e JOIN policies p ON p.id = e.policy_id ${tpWhere}
     GROUP BY bucket
     UNION ALL
     SELECT to_char(date_trunc('day', e.started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD'),
            COUNT(*)::TEXT, '0'
     FROM completed_events e JOIN policies p ON p.id = e.policy_id ${tpWhere}
     GROUP BY date_trunc('day', e.started_at AT TIME ZONE 'UTC')
     UNION ALL
     SELECT to_char(date_trunc('day', e.ended_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD'),
            '0', COUNT(*)::TEXT
     FROM completed_events e JOIN policies p ON p.id = e.policy_id
     ${conditions.length ? where + ` AND e.ended_at >= '${windowStart}'` : `WHERE e.ended_at >= '${windowStart}'`}
     GROUP BY date_trunc('day', e.ended_at AT TIME ZONE 'UTC')
     ORDER BY bucket`, params
  );
  const tpMap = new Map<string, { opened: number; closed: number }>();
  for (const r of tpRows) {
    const ex = tpMap.get(r.bucket) ?? { opened: 0, closed: 0 };
    ex.opened += parseInt(r.opened); ex.closed += parseInt(r.closed);
    tpMap.set(r.bucket, ex);
  }
  const throughput = Array.from(tpMap.entries()).sort(([a],[b]) => a.localeCompare(b)).map(([bucket, v]) => ({ bucket, ...v }));

  return { totalGroups: inProgressCount + completedCount, completed: completedCount - timedOutCount, timedOut: timedOutCount, inProgress: inProgressCount, totalRawEvents, avgDurationMs, byPolicy, throughput };
}

// ─── List events (both stores, unified) ───────────────────────────────────────

export async function listEvents(
  orgId: string,
  filters: EventQueryFilters
): Promise<PaginatedResponse<EventGroupSummary>> {
  const page  = Math.max(1, filters.page  ?? 1);
  const limit = Math.min(200, Math.max(1, filters.limit ?? 50));
  const offset = (page - 1) * limit;
  const status = filters.status ?? "all";

  const results: EventGroupSummary[] = [];

  // ── Detect body search mode ─────────────────────────────────────────────────
  const bodySearchMode = (() => {
    if (!filters.bodySearch?.trim()) return null;
    return /^[\w.]+=[^\s=]+$/.test(filters.bodySearch.trim()) ? "pair" : "freetext";
  })();

  // Shared WHERE clause builder
  const buildWhere = (
    store: "in_progress" | "completed",
    paramOffset: number
  ): { where: string; params: unknown[] } => {
    const conditions: string[] = [`e.org_id = $${paramOffset}`];
    const params: unknown[] = [orgId];
    let i = paramOffset + 1;

    if (filters.policyId) {
      conditions.push(`e.policy_id = $${i++}`);
      params.push(filters.policyId);
    }
    if (filters.aggregationKey) {
      conditions.push(`e.aggregation_key ILIKE $${i++}`);
      params.push(`%${filters.aggregationKey}%`);
    }
    if (filters.from) {
      conditions.push(`e.started_at >= $${i++}`);
      params.push(filters.from);
    }
    if (filters.to) {
      conditions.push(`e.started_at <= $${i++}`);
      params.push(filters.to);
    }

    // Body search — EXISTS subquery against raw_events
    // Using EXISTS avoids JOIN fan-out and DISTINCT complications
    if (bodySearchMode === "pair") {
      const eqIdx = filters.bodySearch!.indexOf("=");
      const field  = filters.bodySearch!.slice(0, eqIdx).trim();
      const value  = filters.bodySearch!.slice(eqIdx + 1).trim();
      const idCol  = store === "in_progress" ? "in_progress_id" : "completed_id";

      if (field.includes(".")) {
        // Nested path — jsonb_path_exists with string cast
        conditions.push(
          `EXISTS (
            SELECT 1 FROM raw_events re
            WHERE  re.${idCol} = e.id
            AND    jsonb_path_exists(re.body, $${i++})
          )`
        );
        params.push(`$.${field} == "${value}"`);
      } else {
        // Top-level key — try @> containment first (works for string values);
        // also fall back to casting stored value to text for numeric matches
        conditions.push(
          `EXISTS (
            SELECT 1 FROM raw_events re
            WHERE  re.${idCol} = e.id
            AND    (
              re.body @> $${i}::jsonb
              OR re.body->$${i + 1} = $${i + 2}::jsonb
            )
          )`
        );
        params.push(
          JSON.stringify({ [field]: value }),  // string match: @>
          field,                               // key for -> operator
          JSON.stringify(value)                // also try as raw JSON (catches numbers if user types them as string)
        );
        i += 3;
      }
    } else if (bodySearchMode === "freetext") {
      const idCol = store === "in_progress" ? "in_progress_id" : "completed_id";
      conditions.push(
        `EXISTS (
          SELECT 1 FROM raw_events re
          WHERE  re.${idCol} = e.id
          AND    re.body::text ILIKE $${i++}
        )`
      );
      params.push(`%${filters.bodySearch!.trim()}%`);
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

  if (status === "all" || status === "completed" || status === "timed_out") {
    const { where: baseWhere, params } = buildWhere("completed", 1);
    const statusClause = status === "timed_out"
      ? (baseWhere ? baseWhere + " AND e.status = 'timed_out'" : "WHERE e.status = 'timed_out'")
      : status === "completed"
      ? (baseWhere ? baseWhere + " AND e.status = 'completed'" : "WHERE e.status = 'completed'")
      : baseWhere;
    const rows = await query<Record<string, unknown>>(
      `SELECT e.*, p.name AS policy_name
       FROM   completed_events e
       JOIN   policies p ON p.id = e.policy_id
       ${statusClause}
       ORDER BY e.started_at DESC`,
      params
    );
    rows.forEach((r) =>
      results.push(completedToSummary(r, r.policy_name as string))
    );
  }

  // Sort unified result set by startTime desc, then paginate in memory
  results.sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
  );
  const total = results.length;
  const paged = results.slice(offset, offset + limit);

  return {
    data: paged,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

// ─── Get single event group with raw events ───────────────────────────────────

export async function getEventById(
  orgId: string,
  id: string
): Promise<EventGroupDetail | null> {
  // Try in_progress first
  const ip = await queryOne<Record<string, unknown>>(
    `SELECT e.*, p.name AS policy_name
     FROM   in_progress_events e
     JOIN   policies p ON p.id = e.policy_id
     WHERE  e.id = $1 AND e.org_id = $2`,
    [id, orgId]
  );

  if (ip) {
    const rawEvents = await getRawEvents(orgId, { inProgressId: id });
    return {
      ...inProgressToSummary(ip, ip.policy_name as string),
      rawEvents,
    };
  }

  // Try completed
  const ce = await queryOne<Record<string, unknown>>(
    `SELECT e.*, p.name AS policy_name
     FROM   completed_events e
     JOIN   policies p ON p.id = e.policy_id
     WHERE  e.id = $1 AND e.org_id = $2`,
    [id, orgId]
  );

  if (ce) {
    const rawEvents = await getRawEvents(orgId, { completedId: id });
    return {
      ...completedToSummary(ce, ce.policy_name as string),
      rawEvents,
    };
  }

  return null;
}

// ─── Get raw events for a group ───────────────────────────────────────────────

async function getRawEvents(
  orgId: string,
  filter: { inProgressId?: string; completedId?: string }
): Promise<RawEventDetail[]> {
  let rows: Record<string, unknown>[];

  if (filter.inProgressId) {
    rows = await query<Record<string, unknown>>(
      `SELECT * FROM raw_events WHERE in_progress_id = $1 AND org_id = $2 ORDER BY sequence ASC`,
      [filter.inProgressId, orgId]
    );
  } else {
    rows = await query<Record<string, unknown>>(
      `SELECT * FROM raw_events WHERE completed_id = $1 AND org_id = $2 ORDER BY sequence ASC`,
      [filter.completedId, orgId]
    );
  }

  return rows.map(rawEventToDetail);
}

export async function getRawEventsForEvent(
  orgId: string,
  groupId: string
): Promise<RawEventDetail[] | null> {
  const detail = await getEventById(orgId, groupId);
  if (!detail) return null;
  return detail.rawEvents;
}
