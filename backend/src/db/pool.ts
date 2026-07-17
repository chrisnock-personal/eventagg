import { Pool, PoolClient } from "pg";
import { AsyncLocalStorage } from "async_hooks";
import { config } from "../config";
import { logger } from "../logger";

let pool: Pool;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool(config.db);

    pool.on("error", (err) => {
      logger.error({ err }, "Unexpected PostgreSQL pool error");
    });

    pool.on("connect", () => {
      // logger.ts's level config already suppresses debug outside
      // development — no manual nodeEnv check needed here anymore.
      logger.debug("📦  New PostgreSQL client connected");
    });
  }
  return pool;
}

// ─── Row-Level Security org context ───────────────────────────────────────────
// Request-scoped context (set by orgContextMiddleware, or explicitly by
// background jobs) read transparently here to SET a Postgres session
// variable that RLS policies key off. This is internal plumbing only —
// service functions still take orgId explicitly and still write their own
// WHERE org_id = $1; this layer is a separate, lower backstop, not a
// replacement for application-level scoping.
export interface OrgContext {
  orgId: string | null;
  bypass: boolean; // true for superadmin / background jobs
}

const orgContextStorage = new AsyncLocalStorage<OrgContext>();

export function runWithOrgContext<T>(ctx: OrgContext, fn: () => Promise<T>): Promise<T> {
  return orgContextStorage.run(ctx, fn);
}

// set_config() (not a string-interpolated SET LOCAL) is the parameterizable
// form — avoids building SQL out of the org UUID. Third arg `true` = local,
// i.e. transaction-scoped, automatically reverting at COMMIT/ROLLBACK so a
// pooled connection never carries stale org context into an unrelated
// later request.
async function applyOrgContext(client: PoolClient): Promise<void> {
  const ctx = orgContextStorage.getStore();
  if (!ctx) return; // no context — RLS-protected tables fail closed, by design
  if (ctx.bypass) {
    await client.query(`SELECT set_config('app.bypass_rls', 'true', true)`);
  } else {
    await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [ctx.orgId ?? ""]);
  }
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const ctx = orgContextStorage.getStore();
  if (!ctx) {
    const result = await getPool().query(sql, params);
    return result.rows as T[];
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await applyOrgContext(client);
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return result.rows as T[];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await applyOrgContext(client);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─── Per-query statement timeout ──────────────────────────────────────────────
// Sets statement_timeout on a dedicated connection for the duration of fn().
// fn receives the client if it needs it (e.g. for transactions), but can ignore
// it if it uses the pool-level query() helper internally.
// The timeout resets automatically when the client is released.
export async function withStatementTimeout<T>(
  timeoutMs: number,
  fn: (client: PoolClient) => Promise<T>
): Promise<T>;
export async function withStatementTimeout<T>(
  timeoutMs: number,
  fn: () => Promise<T>
): Promise<T>;
export async function withStatementTimeout<T>(
  timeoutMs: number,
  fn: ((client: PoolClient) => Promise<T>) | (() => Promise<T>)
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    // statement_timeout is session-level (not LOCAL) so it's set/reset
    // outside the transaction below — but applyOrgContext's set_config(...,
    // true) is LOCAL (transaction-scoped) and needs an explicit BEGIN/COMMIT
    // around it to take effect at all, otherwise it reverts immediately.
    await client.query(`SET statement_timeout = ${timeoutMs}`);
    await client.query("BEGIN");
    await applyOrgContext(client);
    const result = await (fn as (c?: PoolClient) => Promise<T>)(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.query("SET statement_timeout = 0").catch(() => {});
    client.release();
  }
}

export async function testConnection(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    logger.info(
      { host: config.db.host, port: config.db.port, database: config.db.database },
      "✅  PostgreSQL connected"
    );
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
  }
}
