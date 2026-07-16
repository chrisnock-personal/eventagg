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
  isGlobal: boolean;
}

export interface Org {
  id: string; name: string; slug: string; ingestApiKey: string;
  isActive: boolean; createdAt: string; updatedAt: string;
}

export interface TenancyConfig {
  enabled: boolean;
}

export interface EventGroupSummary {
  id: string; policyId: string; policyName: string;
  aggregationKey: string; keyField: string;
  status: "in_progress" | "completed" | "timed_out";
  rawEventCount: number; startTime: string; endTime: string | null;
  durationMs: number | null; closeReason: string | null; lastRawEventAt: string | null;
}

export interface RawEventDetail {
  eventId: string; sequence: number; isCradle: boolean; isGrave: boolean;
  timestamp: string; body: Record<string, unknown>;
  eventSequenceNumber: number | null;
}

export interface EventGroupDetail extends EventGroupSummary {
  rawEvents: RawEventDetail[];
}

export interface PaginatedResponse<T> {
  data: T[]; total: number; page: number; limit: number; totalPages: number;
}

export interface IngestResult {
  groupId: string; rawEventId: string; aggregationKey: string;
  isCradle: boolean; isGrave: boolean;
  action: "group_opened" | "raw_event_appended" | "group_promoted";
  status: "in_progress" | "completed";
}

export interface EventStats {
  totalGroups: number; completed: number; inProgress: number; timedOut: number;
  totalRawEvents: number; avgDurationMs: number;
  byPolicy: { policyId: string; policyName: string; total: number; completed: number; timedOut: number; inProgress: number; totalRawEvents: number; avgDurationMs: number }[];
  throughput: { bucket: string; opened: number; closed: number }[];
}

export interface EventPerformance {
  slowestCompleted: EventGroupSummary[];
  inProgressAging: EventGroupSummary[];
  durationHistogram: { bucket: string; minMs: number; maxMs: number; count: number }[];
}

export interface SessionUser {
  id: string; username: string; email?: string;
  role: "superadmin" | "viewer" | "editor" | "admin";
  passwordChanged: boolean;
  orgId: string | null;
  orgName: string | null;
}

export interface AppUser {
  id: string; username: string; email: string;
  role: "superadmin" | "viewer" | "editor" | "admin";
  isActive: boolean; lastLogin: string | null; createdAt: string;
  orgId: string | null;
  orgName: string | null;
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

function fetchRawEvents(id: string): Promise<RawEventDetail[]> {
  return request<RawEventDetail[]>(`/events/${id}/raw-events`);
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
  return request<{ rows: any[]; total: number }>(`/audit?${qs}`).then(r => r.rows);
}

function fetchPolicies(): Promise<Policy[]> {
  return request<Policy[]>("/policies");
}

function fetchPolicy(id: string): Promise<Policy> {
  return request<Policy>(`/policies/${id}`);
}

function createPolicy(body: Omit<Policy, "id" | "isActive" | "createdAt" | "updatedAt" | "isGlobal">): Promise<Policy> {
  return request<Policy>("/policies", { method: "POST", body: JSON.stringify(body) });
}

function updatePolicy(id: string, body: Partial<Omit<Policy, "id" | "isActive" | "createdAt" | "updatedAt" | "isGlobal">>): Promise<Policy> {
  return request<Policy>(`/policies/${id}`, { method: "PUT", body: JSON.stringify(body) });
}

function togglePolicy(id: string, active: boolean): Promise<Policy> {
  return request<Policy>(`/policies/${id}/toggle`, { method: "PATCH", body: JSON.stringify({ active }) });
}

function deletePolicy(id: string): Promise<void> {
  return request<void>(`/policies/${id}`, { method: "DELETE" });
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export interface Webhook {
  id: string; name: string; url: string; secret: string;
  events: string[]; isActive: boolean; createdAt: string; updatedAt: string;
}

export interface WebhookDelivery {
  id: string; webhookId: string; webhookName: string;
  eventType: string; groupId: string;
  status: "pending" | "success" | "failed";
  attempts: number; lastAttemptAt: string | null;
  responseStatus: number | null; responseBody: string | null;
  errorMessage: string | null; createdAt: string;
}

function fetchWebhooks(): Promise<Webhook[]> {
  return request<Webhook[]>("/webhooks");
}

function createWebhook(body: { name: string; url: string; secret?: string; events?: string[] }): Promise<Webhook> {
  return request<Webhook>("/webhooks", { method: "POST", body: JSON.stringify(body) });
}

function updateWebhook(id: string, body: Partial<{ name: string; url: string; secret: string; events: string[]; isActive: boolean }>): Promise<Webhook> {
  return request<Webhook>(`/webhooks/${id}`, { method: "PUT", body: JSON.stringify(body) });
}

function deleteWebhook(id: string): Promise<void> {
  return request<void>(`/webhooks/${id}`, { method: "DELETE" });
}

function fetchWebhookDeliveries(params: { webhookId?: string; limit?: number } = {}): Promise<WebhookDelivery[]> {
  const qs = new URLSearchParams();
  if (params.webhookId) qs.set("webhookId", params.webhookId);
  if (params.limit)     qs.set("limit",     String(params.limit));
  return request<WebhookDelivery[]>(`/webhooks/deliveries?${qs}`);
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

// ─── System / Health ─────────────────────────────────────────────────────────

function fetchSystemHealth(): Promise<any> { return request<any>("/system/health"); }
function fetchLogSizes(): Promise<any[]>    { return request<any[]>("/system/logs/sizes"); }
function fetchServiceLog(service: string, lines?: number): Promise<any> {
  return request<any>(`/system/logs/${service}?lines=${lines ?? 200}`);
}
function rotateLogs(): Promise<any> { return request<any>("/system/logs/rotate", { method: "POST" }); }

function getSystemConfig(key: string): Promise<any> { return request<any>(`/system/config/${key}`); }
function setSystemConfig(key: string, value: unknown): Promise<any> {
  return request<any>(`/system/config/${key}`, { method: "PUT", body: JSON.stringify(value) });
}
function testSmtp(cfg: { host: string; port: number; secure: boolean; user: string; password: string }): Promise<any> {
  return request<any>("/system/config/smtp/test", { method: "POST", body: JSON.stringify(cfg) });
}

// ─── Admin ────────────────────────────────────────────────────────────────────

function exportPolicies(): Promise<Blob> {
  return fetch(`${BASE}/admin/export/policies`, { credentials: "include" }).then(r => {
    if (!r.ok) throw new Error(`Export failed: ${r.status}`);
    return r.blob();
  });
}

function importPolicies(bundle: unknown): Promise<any> {
  return request<any>("/admin/import/policies", { method: "POST", body: JSON.stringify(bundle) });
}

function getBackupInfo(): Promise<any> { return request<any>("/admin/backup/info"); }

function downloadBackup(): Promise<Blob> {
  return fetch(`${BASE}/admin/backup`, { credentials: "include", method: "POST" }).then(r => {
    if (!r.ok) throw new Error(`Backup failed: ${r.status}`);
    return r.blob();
  });
}

function restoreBackup(sql: string): Promise<any> {
  return fetch(`${BASE}/admin/restore`, {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/sql" },
    body: sql,
  }).then(async r => {
    if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error ?? `Restore failed: ${r.status}`); }
    return r.json();
  });
}

function getDbStats(): Promise<any>     { return request<any>("/admin/db/stats"); }
function runVacuum(): Promise<any>      { return request<any>("/admin/db/vacuum", { method: "POST" }); }
function purgeDb(days: number): Promise<any> {
  return request<any>("/admin/db/purge", { method: "POST", body: JSON.stringify({ days }) });
}

function fetchAuditLogPaged(params: { entityType?: string; action?: string; actor?: string; from?: string; to?: string; limit?: number; offset?: number } = {}): Promise<{ rows: any[]; total: number }> {
  const qs = new URLSearchParams();
  if (params.entityType) qs.set("entityType", params.entityType);
  if (params.action)     qs.set("action",     params.action);
  if (params.actor)      qs.set("actor",      params.actor);
  if (params.from)       qs.set("from",       params.from);
  if (params.to)         qs.set("to",         params.to);
  if (params.limit)      qs.set("limit",      String(params.limit));
  if (params.offset)     qs.set("offset",     String(params.offset));
  return request<{ rows: any[]; total: number }>(`/audit?${qs}`);
}

// ─── Organizations (superadmin only) ──────────────────────────────────────────

function fetchOrgs(): Promise<Org[]> {
  return request<Org[]>("/orgs");
}

function createOrg(body: { name: string; slug?: string }): Promise<Org> {
  return request<Org>("/orgs", { method: "POST", body: JSON.stringify(body) });
}

function updateOrg(id: string, body: { name?: string; isActive?: boolean; regenerateKey?: boolean }): Promise<Org> {
  return request<Org>(`/orgs/${id}`, { method: "PUT", body: JSON.stringify(body) });
}

function deleteOrg(id: string): Promise<void> {
  return request<void>(`/orgs/${id}`, { method: "DELETE" });
}

function fetchOrgUsers(orgId: string): Promise<AppUser[]> {
  return request<AppUser[]>(`/orgs/${orgId}/users`);
}

function createOrgUser(orgId: string, body: { username: string; email: string; password: string; role: string }): Promise<AppUser> {
  return request<AppUser>(`/orgs/${orgId}/users`, { method: "POST", body: JSON.stringify(body) });
}

function updateUserOrgAndRole(userId: string, body: { role?: string; orgId?: string | null; isActive?: boolean }): Promise<AppUser> {
  return request<AppUser>(`/orgs/users/${userId}`, { method: "PUT", body: JSON.stringify(body) });
}

// ─── Multi-tenancy toggle ──────────────────────────────────────────────────────

function getTenancy(): Promise<TenancyConfig> {
  return request<TenancyConfig>("/system/tenancy");
}

function enableTenancy(password: string): Promise<SessionUser> {
  return request<SessionUser>("/system/tenancy/enable", { method: "POST", body: JSON.stringify({ password }) });
}

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
    rawEvents:   fetchRawEvents,
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
  webhooks: {
    list:       fetchWebhooks,
    create:     createWebhook,
    update:     updateWebhook,
    delete:     deleteWebhook,
    deliveries: fetchWebhookDeliveries,
  },
  system: {
    health:    fetchSystemHealth,
    logSizes:  fetchLogSizes,
    log:       fetchServiceLog,
    rotateLogs,
    getConfig: getSystemConfig,
    setConfig: setSystemConfig,
    testSmtp,
  },
  admin: {
    exportPolicies,
    importPolicies,
    backupInfo:   getBackupInfo,
    backup:       downloadBackup,
    restore:      restoreBackup,
    dbStats:      getDbStats,
    vacuum:       runVacuum,
    purge:        purgeDb,
    auditPaged:   fetchAuditLogPaged,
  },
  orgs: {
    list:            fetchOrgs,
    create:          createOrg,
    update:          updateOrg,
    delete:          deleteOrg,
    users:           fetchOrgUsers,
    createUser:      createOrgUser,
    setUserOrgRole:  updateUserOrgAndRole,
  },
  tenancy: {
    get:    getTenancy,
    enable: enableTenancy,
  },
};
