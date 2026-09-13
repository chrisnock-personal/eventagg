import { query, withTransaction } from "../db/pool";
import { verifyCredentials, User } from "./userService";

export interface TenancyConfig {
  enabled: boolean;
}

// Mirrors smtpService.getSmtpConfig()'s convention exactly: no seed
// migration, absence of the row (or any error) means the feature is off.
export async function getMultiTenancyConfig(): Promise<TenancyConfig> {
  try {
    const rows = await query<{ value: TenancyConfig }>(
      `SELECT value FROM system_config WHERE key = 'multi_tenancy'`
    );
    return rows.length ? rows[0].value : { enabled: false };
  } catch {
    return { enabled: false };
  }
}

// The only path to a superadmin: an org's own admin re-confirms their
// password and promotes themselves, flipping the platform-wide flag in the
// same transaction. One-way -400s if multi-tenancy is already enabled.
export async function enableMultiTenancy(
  username: string,
  password: string
): Promise<{ ok: boolean; error?: string; statusCode?: number; user?: User }> {
  const verified = await verifyCredentials(username, password);
  if (!verified) {
    return { ok: false, error: "Incorrect password", statusCode: 401 };
  }
  if (verified.role !== "admin") {
    return { ok: false, error: "Only an organisation admin can enable multi-tenancy", statusCode: 403 };
  }

  return withTransaction(async (client) => {
    const current = await client
      .query<{ value: TenancyConfig }>(`SELECT value FROM system_config WHERE key = 'multi_tenancy'`)
      .then((r) => r.rows[0]?.value);
    if (current?.enabled) {
      return { ok: false, error: "Multi-tenancy is already enabled", statusCode: 400 };
    }

    const row = await client
      .query<{ id: string; username: string; email: string; role: string; is_active: boolean; password_changed: boolean; last_login: string | null; created_at: string }>(
        `UPDATE users SET role = 'superadmin', org_id = NULL, updated_at = NOW()
         WHERE id = $1
         RETURNING id, username, email, role, is_active, password_changed, last_login, created_at`,
        [verified.id]
      )
      .then((r) => r.rows[0]);

    await client.query(
      `INSERT INTO system_config (key, value, updated_by)
       VALUES ('multi_tenancy', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW(), updated_by = $2`,
      [JSON.stringify({ enabled: true }), verified.username]
    );

    const user: User = {
      id: row.id,
      username: row.username,
      email: row.email,
      role: row.role as User["role"],
      isActive: row.is_active,
      passwordChanged: row.password_changed,
      lastLogin: row.last_login,
      createdAt: row.created_at,
      orgId: null,
      orgName: null,
    };

    return { ok: true, user };
  });
}
