// ─── Database row types ───────────────────────────────────────────────────────

export interface Policy {
  id: string;
  name: string;
  domain: string;
  key_field: string;
  cradle_field: string;
  cradle_value: string;
  grave_field: string;
  grave_value: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface InProgressEvent {
  id: string;
  policy_id: string;
  aggregation_key: string;
  key_field: string;
  segment_count: number;
  cradle_segment_id: string | null;
  started_at: string;
  last_seen_at: string;
  expires_at: string | null;
  created_at: string;
}

export interface CompletedEvent {
  id: string;
  policy_id: string;
  aggregation_key: string;
  key_field: string;
  segment_count: number;
  cradle_segment_id: string;
  grave_segment_id: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  completed_at: string;
}

export interface EventSegment {
  id: string;
  in_progress_id: string | null;
  completed_id: string | null;
  policy_id: string;
  aggregation_key: string;
  sequence: number;
  is_cradle: boolean;
  is_grave: boolean;
  body: Record<string, unknown>;
  received_at: string;
  source_ip: string | null;
  ingest_api_key: string | null;
}

export interface AuditLog {
  id: number;
  event_time: string;
  entity_type: string;
  entity_id: string;
  action: string;
  policy_id: string | null;
  aggregation_key: string | null;
  actor: string | null;
  source_ip: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

// ─── API response shapes ──────────────────────────────────────────────────────

export interface EventGroupSummary {
  id: string;
  policyId: string;
  policyName: string;
  aggregationKey: string;
  keyField: string;
  status: "in_progress" | "completed";
  segmentCount: number;
  startTime: string;
  endTime: string | null;
  durationMs: number | null;
}

export interface EventGroupDetail extends EventGroupSummary {
  segments: SegmentDetail[];
}

export interface SegmentDetail {
  eventId: string;
  sequence: number;
  isCradle: boolean;
  isGrave: boolean;
  timestamp: string;
  body: Record<string, unknown>;
}

export interface PolicyResponse {
  id: string;
  name: string;
  domain: string;
  keyField: string;
  cradleField: string;
  cradleValue: string;
  graveField: string;
  graveValue: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ─── Audit action constants ───────────────────────────────────────────────────

export const AuditAction = {
  GROUP_OPENED:    "group.opened",
  SEGMENT_APPENDED:"segment.appended",
  GROUP_PROMOTED:  "group.promoted",
  GROUP_EXPIRED:   "group.expired",
  GROUP_DELETED:   "group.deleted",
  POLICY_CREATED:  "policy.created",
  POLICY_UPDATED:  "policy.updated",
  POLICY_DEACTIVATED: "policy.deactivated",
} as const;

export type AuditActionType = typeof AuditAction[keyof typeof AuditAction];
