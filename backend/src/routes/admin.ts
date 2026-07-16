import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/session';
import { query, queryOne } from '../db/pool';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const router    = Router();
const adminOnly = requireRole('admin');
const execAsync = promisify(exec);

// ── Policy export ─────────────────────────────────────────────────────────────

router.get('/export/policies', requireAuth, adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = (req as any).user.orgId as string;
    const policies = await query(
      `SELECT name, domain, key_field, cradle_field, cradle_value,
              grave_field, grave_value, timeout_ms, description
       FROM policies
       WHERE org_id = $1
       ORDER BY name`,
      [orgId]
    );
    const bundle = {
      version:     '1.0',
      exported_at: new Date().toISOString(),
      exported_by: (req as any).user?.email,
      policies,
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="eventagg-policies-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(bundle);
  } catch (e) { next(e); }
});

// ── Policy import ─────────────────────────────────────────────────────────────

router.post('/import/policies', requireAuth, adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = (req as any).user.orgId as string;
    const bundle = req.body as { version?: string; policies?: unknown[] };
    if (!bundle.version) return res.status(400).json({ error: 'Invalid bundle — missing version field' });

    const results = { imported: 0, updated: 0, errors: [] as string[] };

    for (const p of bundle.policies ?? []) {
      const pol = p as Record<string, unknown>;
      try {
        const existing = await queryOne<{ id: string }>(
          `SELECT id FROM policies WHERE name = $1 AND org_id = $2`, [pol.name, orgId]
        );
        if (existing) {
          await query(
            `UPDATE policies SET domain=$2, key_field=$3, cradle_field=$4, cradle_value=$5,
             grave_field=$6, grave_value=$7, timeout_ms=$8, description=$9
             WHERE id=$1`,
            [existing.id, pol.domain, pol.key_field, pol.cradle_field, pol.cradle_value,
             pol.grave_field, pol.grave_value, pol.timeout_ms, pol.description]
          );
          results.updated++;
        } else {
          await query(
            `INSERT INTO policies (org_id, name, domain, key_field, cradle_field, cradle_value,
             grave_field, grave_value, timeout_ms, description)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [orgId, pol.name, pol.domain, pol.key_field, pol.cradle_field, pol.cradle_value,
             pol.grave_field, pol.grave_value, pol.timeout_ms, pol.description]
          );
          results.imported++;
        }
      } catch (e) {
        results.errors.push(`Policy "${pol.name}": ${(e as Error).message}`);
      }
    }

    res.json(results);
  } catch (e) { next(e); }
});

// NOTE (multi-tenancy Phase 1 limitation): backup/restore below use pg_dump/psql
// against the whole database — they are fundamentally not tenant-scopable (a
// dump contains every organisation's data) and remain accessible to any org's
// 'admin' role, same as before this change. Restricting them to a platform-level
// role is tracked as Phase 2 work alongside the Organizations admin panel.

// ── Database backup ───────────────────────────────────────────────────────────

router.get('/backup/info', requireAuth, adminOnly, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [sizeRow] = await query<{ size: string }>(
      `SELECT pg_size_pretty(pg_database_size(current_database())) AS size`
    );
    const [counts] = await query<Record<string, string>>(
      `SELECT
        (SELECT COUNT(*) FROM policies)          AS policies,
        (SELECT COUNT(*) FROM in_progress_events) AS in_progress,
        (SELECT COUNT(*) FROM completed_events)   AS completed,
        (SELECT COUNT(*) FROM audit_log)          AS audit_entries`
    );
    res.json({ db_size: sizeRow.size, counts });
  } catch (e) { next(e); }
});

router.post('/backup', requireAuth, adminOnly, async (_req: Request, res: Response, next: NextFunction) => {
  const tmpFile = path.join(os.tmpdir(), `eventagg-backup-${Date.now()}.sql`);
  try {
    const host = process.env.PGHOST     || 'localhost';
    const port = process.env.PGPORT     || '5432';
    const db   = process.env.PGDATABASE || 'eventagg';
    const user = process.env.PGUSER     || 'eventagg_user';
    await execAsync(
      `pg_dump -h ${host} -p ${port} -U ${user} -d ${db} -f ${tmpFile}`,
      { timeout: 120_000 }
    );
    const stat = fs.statSync(tmpFile);
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="eventagg-backup-${new Date().toISOString().slice(0, 10)}.sql"`);
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('end',   () => { try { fs.unlinkSync(tmpFile); } catch {} });
    stream.on('error', next);
  } catch (e) {
    try { fs.unlinkSync(tmpFile); } catch {}
    next(e);
  }
});

// ── Database restore ──────────────────────────────────────────────────────────

router.post('/restore', requireAuth, adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  const tmpFile = path.join(os.tmpdir(), `eventagg-restore-${Date.now()}.sql`);
  try {
    if (typeof req.body !== 'string' || !req.body.startsWith('--')) {
      return res.status(400).json({ error: 'Invalid backup file — must be a PostgreSQL SQL dump' });
    }
    fs.writeFileSync(tmpFile, req.body);
    const host = process.env.PGHOST     || 'localhost';
    const port = process.env.PGPORT     || '5432';
    const db   = process.env.PGDATABASE || 'eventagg';
    const user = process.env.PGUSER     || 'eventagg_user';
    await execAsync(
      `psql -h ${host} -p ${port} -U ${user} -d ${db} -f ${tmpFile}`,
      { timeout: 1_800_000, maxBuffer: 1024 * 1024 * 100 }
    );
    res.json({ ok: true, message: 'Restore completed' });
  } catch (e) {
    next(e);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

// ── DB maintenance ────────────────────────────────────────────────────────────

router.get('/db/stats', requireAuth, adminOnly, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const tables = await query<{ table: string; size: string; size_bytes: string; rows: string; dead_rows: string; last_autovacuum: string | null }>(
      `SELECT relname AS table,
              pg_size_pretty(pg_total_relation_size(relid)) AS size,
              pg_total_relation_size(relid)::text AS size_bytes,
              n_live_tup::text AS rows,
              n_dead_tup::text AS dead_rows,
              last_autovacuum
       FROM pg_stat_user_tables
       ORDER BY pg_total_relation_size(relid) DESC`
    );
    const [dbSize] = await query<{ size: string; size_bytes: string }>(
      `SELECT pg_size_pretty(pg_database_size(current_database())) AS size,
              pg_database_size(current_database())::text AS size_bytes`
    );
    const [purgeable] = await query<{ completed: string; audit: string }>(
      `SELECT
        (SELECT COUNT(*) FROM completed_events WHERE ended_at < now() - interval '90 days')::text AS completed,
        (SELECT COUNT(*) FROM audit_log       WHERE event_time < now() - interval '90 days')::text AS audit`
    );
    res.json({ tables, db_size: dbSize.size, db_size_bytes: dbSize.size_bytes, purgeable_90d: purgeable });
  } catch (e) { next(e); }
});

router.post('/db/vacuum', requireAuth, adminOnly, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await query('VACUUM ANALYZE');
    res.json({ ok: true, message: 'VACUUM ANALYZE completed' });
  } catch (e) { next(e); }
});

router.post('/db/purge', requireAuth, adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = (req as any).user.orgId as string;
    const days = parseInt((req.body as { days?: string }).days ?? '90');
    if (isNaN(days) || days < 30) return res.status(400).json({ error: 'Minimum retention is 30 days' });

    const [cntCompleted] = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM completed_events WHERE org_id = $1 AND ended_at < now() - ($2 || ' days')::interval`,
      [orgId, days]
    );
    const [cntAudit] = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_log WHERE org_id = $1 AND event_time < now() - ($2 || ' days')::interval`,
      [orgId, days]
    );

    await query(`DELETE FROM completed_events WHERE org_id = $1 AND ended_at   < now() - ($2 || ' days')::interval`, [orgId, days]);
    await query(`DELETE FROM audit_log         WHERE org_id = $1 AND event_time < now() - ($2 || ' days')::interval`, [orgId, days]);

    res.json({
      ok: true,
      deleted_completed: parseInt(cntCompleted.count),
      deleted_audit:     parseInt(cntAudit.count),
      message: `Purged records older than ${days} days`,
    });
  } catch (e) { next(e); }
});

export default router;
