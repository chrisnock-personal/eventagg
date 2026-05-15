const BASE = "/api/v1";

async function request<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
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
  timeoutMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventGroupSummary {
  id: string;
  policyId: string;
  policyName: string;
  aggregationKey: string;
  keyField: string;
  status: "in_progress" | "completed" | "timed_out";
  segmentCount: number;
  startTime: string;
  endTime: string | null;
  durationMs: number | null;
  closeReason: string | null;
  lastSegmentAt: string | null;
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

export interface EventStats {
  totalGroups: number;
  completed: number;
  inProgress: number;
  timedOut: number;
  totalSegments: number;
  avgDurationMs: number;
  byPolicy: { policyId: string; policyName: string; total: number; completed: number; timedOut: number; inProgress: number; totalSegments: number; avgDurationMs: number }[];
  throughput: { bucket: string; opened: number; closed: number }[];
}

export interface EventPerformance {
  slowestCompleted:  EventGroupSummary[];
  inProgressAging:   EventGroupSummary[];
  durationHistogram: { bucket: string; minMs: number; maxMs: number; count: number }[];
}

export interface SessionUser {
  id: string;
  username: string;
  email?: string;
  role: "viewer" | "editor" | "admin";
}

export interface AppUser {
  id: string;
  username: string;
  email: string;
  role: "viewer" | "editor" | "admin";
  isActive: boolean;
  lastLogin: string | null;
  createdAt: string;
}

// ─── API ──────────────────────────────────────────────────────────────────────

export const api = {
  auth: {
    login: (username: string, password: string) =>
      request<SessionUser>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
    logout: () =>
      request<void>("/auth/logout", { method: "POST" }),
    me: () =>
      request<SessionUser>("/auth/me"),
    users: {
      list: () => request<AppUser[]>("/auth/users"),
      create: (body: { username: string; email: string; password: string; role: string }) =>
        request<AppUser>("/auth/users", { method: "POST", body: JSON.stringify(body) }),
      update: (id: string, body: Partial<{ email: string; role: string; isActive: boolean; password: string }>) =>
        request<AppUser>(`/auth/users/${id}`, { method: "PUT", body: JSON.stringify(body) }),
      delete: (id: string) =>
        request<void>(`/auth/users/${id}`, { method: "DELETE" }),
    },
  },

  policies: {
    list: () =>
      request<Policy[]>("/policies"),

    get: (id: string) =>
      request<Policy>(`/policies/${id}`),

    create: (body: Omit<Policy, "id" | "isActive" | "createdAt" | "updatedAt">) =>
      request<Policy>("/policies", { method: "POST", body: JSON.stringify(body) }),

    update: (id: string, body: Partial<Omit<Policy, "id" | "isActive" | "createdAt" | "updatedAt">>) =>
      request<Policy>(`/policies/${id}`, { method: "PUT", body: JSON.stringify(body) }),

    toggle: (id: string, active: boolean) =>
      request<Policy>(`/policies/${id}/toggle`, { method: "PATCH", body: JSON.stringify({ active }) }),

    delete: (id: string) =>
      request<void>(`/policies/${id}`, { method: "DELETE" }),
  },

  events: {
    stats: (params: { status?: string; policyId?: string; aggregationKey?: string; from?: string; to?: string } = {}) => {
      const qs = new URLSearchParams();
      if (params.status)         qs.set("status",         params.status);
      if (params.policyId)       qs.set("policyId",       params.policyId);
      if (params.aggregationKey) qs.set("aggregationKey", params.aggregationKey);
      if (params.from)           qs.set("from",           params.from);
      if (params.to)             qs.set("to",             params.to);
      return request<EventStats>(`/events/stats?${qs}`);
    },

    performance: (params: { policyId?: string; aggregationKey?: string; from?: string; to?: string } = {}) => {
      const qs = new URLSearchParams();
      if (params.policyId)       qs.set("policyId",       params.policyId);
      if (params.aggregationKey) qs.set("aggregationKey", params.aggregationKey);
      if (params.from)           qs.set("from",           params.from);
      if (params.to)             qs.set("to",             params.to);
      return request<EventPerformance>(`/events/performance?${qs}`);
    },

    list: (params: {
      status?: "in_progress" | "completed" | "all";
      policyId?: string;
      aggregationKey?: string;
      from?: string;
      to?: string;
      bodySearch?: string;
      page?: number;
      limit?: number;
    }) => {
      const qs = new URLSearchParams();
      if (params.status)         qs.set("status",         params.status);
      if (params.policyId)       qs.set("policyId",       params.policyId);
      if (params.aggregationKey) qs.set("aggregationKey", params.aggregationKey);
      if (params.from)           qs.set("from",           params.from);
      if (params.to)             qs.set("to",             params.to);
      if (params.bodySearch)     qs.set("bodySearch",     params.bodySearch);
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
