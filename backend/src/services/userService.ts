import bcrypt from "bcryptjs";
import { query, queryOne, withTransaction } from "../db/pool";

export interface User {
  id: string;
  username: string;
  email: string;
  role: "viewer" | "editor" | "admin";
  isActive: boolean;
  passwordChanged: boolean;
  lastLogin: string | null;
  createdAt: string;
}

interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  role: string;
  is_active: boolean;
  password_changed: boolean;
  last_login: string | null;
  created_at: string;
}

function toUser(r: UserRow): User {
  return {
    id: r.id,
    username: r.username,
    email: r.email,
    role: r.role as User["role"],
    isActive: r.is_active,
    passwordChanged: r.password_changed,
    lastLogin: r.last_login,
    createdAt: r.created_at,
  };
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function verifyCredentials(
  username: string,
  password: string
): Promise<User | null> {
  const row = await queryOne<UserRow>(
    `SELECT * FROM users WHERE username = $1 AND is_active = TRUE`,
    [username]
  );
  if (!row) return null;

  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return null;

  // Update last_login
  await query(
    `UPDATE users SET last_login = NOW() WHERE id = $1`,
    [row.id]
  );

  return toUser(row);
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function listUsers(): Promise<User[]> {
  const rows = await query<UserRow>(
    `SELECT * FROM users ORDER BY created_at ASC`
  );
  return rows.map(toUser);
}

export async function createUser(input: {
  username: string;
  email: string;
  password: string;
  role: string;
}): Promise<User> {
  const hash = await bcrypt.hash(input.password, 10);
  const row = await queryOne<UserRow>(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.username, input.email.toLowerCase(), hash, input.role]
  );
  if (!row) throw new Error("Failed to create user");
  return toUser(row);
}

export async function updateUser(
  id: string,
  input: { email?: string; role?: string; isActive?: boolean; password?: string }
): Promise<User | null> {
  return withTransaction(async (client) => {
    const existing = await client
      .query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id])
      .then((r) => r.rows[0]);
    if (!existing) return null;

    const hash = input.password ? await bcrypt.hash(input.password, 10) : existing.password_hash;

    const row = await client
      .query<UserRow>(
        `UPDATE users SET
           email         = COALESCE($1, email),
           role          = COALESCE($2, role),
           is_active     = COALESCE($3, is_active),
           password_hash = $4,
           updated_at    = NOW()
         WHERE id = $5
         RETURNING *`,
        [
          input.email?.toLowerCase() ?? null,
          input.role ?? null,
          input.isActive ?? null,
          hash,
          id,
        ]
      )
      .then((r) => r.rows[0]);

    return row ? toUser(row) : null;
  });
}

export async function changePassword(
  id: string,
  currentPassword: string,
  newPassword: string
): Promise<{ ok: boolean; error?: string }> {
  const row = await queryOne<UserRow>(
    `SELECT * FROM users WHERE id = $1 AND is_active = TRUE`, [id]
  );
  if (!row) return { ok: false, error: "User not found" };

  const valid = await bcrypt.compare(currentPassword, row.password_hash);
  if (!valid) return { ok: false, error: "Current password is incorrect" };

  const hash = await bcrypt.hash(newPassword, 10);
  await query(
    `UPDATE users SET password_hash = $1, password_changed = TRUE, updated_at = NOW() WHERE id = $2`,
    [hash, id]
  );
  return { ok: true };
}

export async function forcePasswordChange(id: string, newPassword: string): Promise<void> {
  const hash = await bcrypt.hash(newPassword, 10);
  await query(
    `UPDATE users SET password_hash = $1, password_changed = TRUE, updated_at = NOW() WHERE id = $2`,
    [hash, id]
  );
}

export async function deleteUser(id: string): Promise<boolean> {
  const result = await query(`DELETE FROM users WHERE id = $1`, [id]);
  return (result as any).rowCount > 0;
}
