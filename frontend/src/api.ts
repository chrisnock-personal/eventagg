const BASE = "/api/v1";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
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

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Policy {
  id: string; name: string; domain: string;
  keyField: string; cradleField: string; cradleValue: string;
  graveField: string; graveValue: string;
  description: string | null; isActive: boolean; timeoutMs: number | null;
  createdAt: string; updatedAt: string;
}

export interface EventGroupSummary {
  id: string; policyId: string; policyName: string;
  aggregationKey: string; keyField: string;
  status: "in_progress" | "completed" | "timed_out";
  segmentCount: number; startTime: string; endTime: string | null;
  durationMs: number | null; closeReason: string | null; lastSegmentAt: string | null;
}

export interface SegmentDetail {
  eventId: string; sequence: number; isCradle: boolean; isGrave: boolean;
  timestamp: string; body: Record<string, unknown>;
}

export interface EventGroupDetail extends EventGroupSummary {
  segments: SegmentDetail[];
}

export interface PaginatedResponse<T> {
  data: T[]; total: number; page: number; limit: number; totalPages: number;
}

export interface IngestResult {
  groupId: string; segmentId: string; aggregationKey: string;
  isCradle: boolean; isGrave: boolean;
  action: "group_opened" | "segment_appended" | "group_promoted";
  status: "in_progress" | "completed";
}

export interface EventStats {
  totalGroups: number; completed: number; inProgress: number; timedOut: number;
  totalSegments: number; avgDurationMs: number;
  byPolicy: { policyId: string; policyName: string; total: number; completed: number; timedOut: number; inProgress: number; totalSegments: number; avgDurationMs: number }[];
  throughput: { bucket: string; opened: number; closed: number }[];
}

export interface EventPerformance {
  slowestCompleted: EventGroupSummary[];
  inProgressAging: EventGroupSummary[];
  durationHistogram: { bucket: string; minMs: number; maxMs: number; count: number }[];
}

export interface SessionUser {
  id: string; username: string; email?: string;
  role: "viewer" | "editor" | "admin";
  passwordChanged: boolean;
}

export interface AppUser {
  id: string; username: string; email: string;
  role: "viewer" | "editor" | "admin";
  isActive: boolean; lastLogin: string | null; createdAt: string;
}

export interface StatsParams {
  status?: string; policyId?: string; aggregationKey?: string; from?: string; to?: string;
}
export interface PerformanceParams {
  policyId?: string; aggregationKey?: string; from?: string; to?: string;
}
export interface ListEventsParams {
  status?: "in_progress" | "completed" | "timed_out" | "all";
  policyId?: string; aggregationKey?: string; from?: string; to?: string;
  bodySearch?: string; page?: number; limit?: number;
}

// ─── Hoisted functions (esbuild cannot handle TS generics in object literals) ─

function fetchStats(params: StatsParams = {}): Promise<EventStats> {
  const qs = new URLSearchParams();
  if (params.status)         qs.set("status",         params.status);
  if (params.policyId)       qs.set("policyId",       params.policyId);
  if (params.aggregationKey) qs.set("aggregationKey", params.aggregationKey);
  if (params.from)           qs.set("from",           params.from);
  if (params.to)             qs.set("to",             params.to);
  return request<EventStats>(`/events/stats?${qs}`);
}

function fetchPerformance(params: PerformanceParams = {}): Promise<EventPerformance> {
  const qs = new URLSearchParams();
  if (params.policyId)       qs.set("policyId",       params.policyId);
  if (params.aggregationKey) qs.set("aggregationKey", params.aggregationKey);
  if (params.from)           qs.set("from",           params.from);
  if (params.to)             qs.set("to",             params.to);
  return request<EventPerformance>(`/events/performance?${qs}`);
}

function fetchEvents(params: ListEventsParams = {}): Promise<PaginatedResponse<EventGroupSummary>> {
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
}

function fetchEvent(id: string): Promise<EventGroupDetail> {
  return request<EventGroupDetail>(`/events/${id}`);
}

function fetchSegments(id: string): Promise<SegmentDetail[]> {
  return request<SegmentDetail[]>(`/events/${id}/segments`);
}

function sendIngest(body: { policyId: string; body: Record<string, unknown> }): Promise<IngestResult> {
  return request<IngestResult>("/events/ingest", { method: "POST", body: JSON.stringify(body) });
}

function authLogin(username: string, password: string): Promise<SessionUser> {
  return request<SessionUser>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
}

function authLogout(): Promise<void> {
  return request<void>("/auth/logout", { method: "POST" });
}

function authMe(): Promise<SessionUser> {
  return request<SessionUser>("/auth/me");
}

function authUsersList(): Promise<AppUser[]> {
  return request<AppUser[]>("/auth/users");
}

function authUsersCreate(body: { username: string; email: string; password: string; role: string }): Promise<AppUser> {
  return request<AppUser>("/auth/users", { method: "POST", body: JSON.stringify(body) });
}

function authUsersUpdate(id: string, body: Partial<{ email: string; role: string; isActive: boolean; password: string }>): Promise<AppUser> {
  return request<AppUser>(`/auth/users/${id}`, { method: "PUT", body: JSON.stringify(body) });
}

function authUsersDelete(id: string): Promise<void> {
  return request<void>(`/auth/users/${id}`, { method: "DELETE" });
}

function authChangePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
}

function fetchAuditLog(params: { entityType?: string; action?: string; actor?: string; from?: string; to?: string; limit?: number } = {}): Promise<any[]> {
  const qs = new URLSearchParams();
  if (params.entityType) qs.set("entityType", params.entityType);
  if (params.action)     qs.set("action",     params.action);
  if (params.actor)      qs.set("actor",      params.actor);
  if (params.from)       qs.set("from",       params.from);
  if (params.to)         qs.set("to",         params.to);
  if (params.limit)      qs.set("limit",      String(params.limit));
  return request<any[]>(`/audit?${qs}`);
}

function fetchPolicies(): Promise<Policy[]> {
  return request<Policy[]>("/policies");
}

function fetchPolicy(id: string): Promise<Policy> {
  return request<Policy>(`/policies/${id}`);
}

function createPolicy(body: Omit<Policy, "id" | "isActive" | "createdAt" | "updatedAt">): Promise<Policy> {
  return request<Policy>("/policies", { method: "POST", body: JSON.stringify(body) });
}

function updatePolicy(id: string, body: Partial<Omit<Policy, "id" | "isActive" | "createdAt" | "updatedAt">>): Promise<Policy> {
  return request<Policy>(`/policies/${id}`, { method: "PUT", body: JSON.stringify(body) });
}

function togglePolicy(id: string, active: boolean): Promise<Policy> {
  return request<Policy>(`/policies/${id}/toggle`, { method: "PATCH", body: JSON.stringify({ active }) });
}

function deletePolicy(id: string): Promise<void> {
  return request<void>(`/policies/${id}`, { method: "DELETE" });
}

function snmpStatus(): Promise<any> { return request<any>("/snmp/status"); }
function snmpSourcesList(): Promise<any[]> { return request<any[]>("/snmp/sources"); }
function snmpSourcesCreate(body: any): Promise<any> { return request<any>("/snmp/sources", { method: "POST", body: JSON.stringify(body) }); }
function snmpSourcesUpdate(id: string, body: any): Promise<any> { return request<any>(`/snmp/sources/${id}`, { method: "PUT", body: JSON.stringify(body) }); }
function snmpSourcesDelete(id: string): Promise<void> { return request<void>(`/snmp/sources/${id}`, { method: "DELETE" }); }
function snmpRulesList(): Promise<any[]> { return request<any[]>("/snmp/rules"); }
function snmpRulesCreate(body: any): Promise<any> { return request<any>("/snmp/rules", { method: "POST", body: JSON.stringify(body) }); }
function snmpRulesUpdate(id: string, body: any): Promise<any> { return request<any>(`/snmp/rules/${id}`, { method: "PUT", body: JSON.stringify(body) }); }
function snmpRulesDelete(id: string): Promise<void> { return request<void>(`/snmp/rules/${id}`, { method: "DELETE" }); }
function snmpLog(limit = 100): Promise<any[]> { return request<any[]>(`/snmp/log?limit=${limit}`); }

// ─── API object — zero TypeScript syntax, plain property references only ──────

export const api = {
  auth: {
    login:          authLogin,
    logout:         authLogout,
    me:             authMe,
    changePassword: authChangePassword,
    users: {
      list:   authUsersList,
      create: authUsersCreate,
      update: authUsersUpdate,
      delete: authUsersDelete,
    },
  },
  policies: {
    list:   fetchPolicies,
    get:    fetchPolicy,
    create: createPolicy,
    update: updatePolicy,
    toggle: togglePolicy,
    delete: deletePolicy,
  },
  events: {
    stats:       fetchStats,
    performance: fetchPerformance,
    list:        fetchEvents,
    get:         fetchEvent,
    segments:    fetchSegments,
  },
  ingest: {
    send: sendIngest,
  },
  snmp: {
    status: snmpStatus,
    sources: { list: snmpSourcesList, create: snmpSourcesCreate, update: snmpSourcesUpdate, delete: snmpSourcesDelete },
    rules:   { list: snmpRulesList,   create: snmpRulesCreate,   update: snmpRulesUpdate,   delete: snmpRulesDelete },
    log: snmpLog,
  },
  audit: {
    list: fetchAuditLog,
  },
};
