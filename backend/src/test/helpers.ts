import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import request from "supertest";
import type { Express } from "express";
import { queryOne, runWithOrgContext } from "../db/pool";

// Every helper generates random slugs/usernames per call so tests remain
// safe to run against a shared Postgres instance without colliding.

export async function createTestOrg(): Promise<{ id: string; ingestApiKey: string; slug: string; snmpCommunity: string }> {
  const slug = `test-org-${randomUUID().slice(0, 8)}`;
  const snmpCommunity = `test-community-${randomUUID().slice(0, 8)}`;
  const row = await queryOne<{ id: string; ingest_api_key: string }>(
    `INSERT INTO organisations (name, slug, snmp_community) VALUES ($1, $2, $3) RETURNING id, ingest_api_key`,
    [`Test Org ${slug}`, slug, snmpCommunity]
  );
  if (!row) throw new Error("Failed to create test org");
  return { id: row.id, ingestApiKey: row.ingest_api_key, slug, snmpCommunity };
}

export const TEST_PASSWORD = "test-password-123";

export async function createTestUser(
  orgId: string | null,
  role: "superadmin" | "admin" | "editor" | "viewer" = "admin"
): Promise<{ id: string; username: string; password: string }> {
  const username = `test-user-${randomUUID().slice(0, 8)}`;
  // Low bcrypt cost factor -these are throwaway test credentials, not real
  // secrets, and a low cost keeps the suite fast across many test users.
  const hash = await bcrypt.hash(TEST_PASSWORD, 4);
  // Fixture setup, not a real tenant action -bypass, same as seedDefaultAdmin,
  // so this can insert regardless of which org (or no org, for superadmin
  // fixtures) the caller asked for.
  const row = await runWithOrgContext({ orgId: null, bypass: true }, () =>
    queryOne<{ id: string }>(
      `INSERT INTO users (username, email, password_hash, role, org_id, password_changed)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       RETURNING id`,
      [username, `${username}@test.local`, hash, role, orgId]
    )
  );
  if (!row) throw new Error("Failed to create test user");
  return { id: row.id, username, password: TEST_PASSWORD };
}

// Logs in via the real HTTP endpoint and returns the Set-Cookie header(s) to
// pass into subsequent supertest requests via .set("Cookie", cookie).
export async function loginAs(app: Express, username: string, password: string): Promise<string[]> {
  const res = await request(app).post("/api/v1/auth/login").send({ username, password });
  if (res.status !== 200) {
    throw new Error(`Login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const cookie = res.headers["set-cookie"];
  if (!cookie) throw new Error("No session cookie returned from login");
  return Array.isArray(cookie) ? cookie : [cookie];
}
