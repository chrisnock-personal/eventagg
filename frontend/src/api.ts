const BASE = "/api/v1";

async function request<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// ─── Types matching the API responses ────────────────────────────────────────

export interface Policy {
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

export interface SegmentDetail {
  eventId: string;
  sequence: number;
  isCradle: boolean;
  isGrave: boolean;
  timestamp: string;
  body: Record<string, unknown>;
}

export interface EventGroupDetail extends EventGroupSummary {
  segments: SegmentDetail[];
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
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

// ─── Policies ─────────────────────────────────────────────────────────────────

export const api = {
  policies: {
    list: () =>
      request<Policy[]>("/policies"),

    get: (id: string) =>
      request<Policy>(`/policies/${id}`),

    create: (body: Omit<Policy, "id" | "isActive" | "createdAt" | "updatedAt">) =>
      request<Policy>("/policies", { method: "POST", body: JSON.stringify(body) }),

    update: (id: string, body: Partial<Omit<Policy, "id" | "isActive" | "createdAt" | "updatedAt">>) =>
      request<Policy>(`/policies/${id}`, { method: "PUT", body: JSON.stringify(body) }),

    delete: (id: string) =>
      request<void>(`/policies/${id}`, { method: "DELETE" }),
  },

  events: {
    list: (params: {
      status?: "in_progress" | "completed" | "all";
      policyId?: string;
      aggregationKey?: string;
      from?: string;
      to?: string;
      page?: number;
      limit?: number;
    }) => {
      const qs = new URLSearchParams();
      if (params.status)         qs.set("status",         params.status);
      if (params.policyId)       qs.set("policyId",       params.policyId);
      if (params.aggregationKey) qs.set("aggregationKey", params.aggregationKey);
      if (params.from)           qs.set("from",           params.from);
      if (params.to)             qs.set("to",             params.to);
      if (params.page)           qs.set("page",           String(params.page));
      if (params.limit)          qs.set("limit",          String(params.limit));
      return request<PaginatedResponse<EventGroupSummary>>(`/events?${qs}`);
    },

    get: (id: string) =>
      request<EventGroupDetail>(`/events/${id}`),

    segments: (id: string) =>
      request<SegmentDetail[]>(`/events/${id}/segments`),
  },

  ingest: {
    send: (body: { policyId: string; body: Record<string, unknown> }) =>
      request<IngestResult>("/events/ingest", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  },
};
