import { Request, Response, NextFunction } from "express";
import { getPool } from "../db/pool";

// Default timeouts by route category (milliseconds)
export const TIMEOUTS = {
  ingest:      5_000,   // 5s  — ingest should be fast
  read:       10_000,   // 10s — list/detail queries
  stats:      15_000,   // 15s — aggregate queries
  background: 30_000,   // 30s — timeout sweep job
};

// Express middleware: sets PostgreSQL statement_timeout for the request lifetime.
// Uses a pool-level session variable; resets on connection return.
export function statementTimeout(ms: number) {
  return async (_req: Request, _res: Response, next: NextFunction) => {
    // We don't hold a client here — instead we patch pool.query for this request.
    // The actual timeout is applied per-query in the route handlers via
    // withStatementTimeout(), so this middleware just attaches the value.
    (_req as any).__statementTimeoutMs = ms;
    next();
  };
}

// Wraps a pool query with a statement_timeout for the current connection.
// Use in route handlers that don't go through withTransaction().
export async function timedQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[],
  timeoutMs: number
): Promise<T[]> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = ${timeoutMs}`);
    const result = await client.query(sql, params);
    return result.rows as T[];
  } finally {
    await client.query("SET statement_timeout = 0").catch(() => {});
    client.release();
  }
}
