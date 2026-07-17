import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/session';
import { orgContextMiddleware } from '../middleware/orgContext';
import { query, queryOne } from '../db/pool';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const router         = Router();
const adminOnly      = requireRole('admin');
// Whole-instance operations — a pg_dump/restore/VACUUM/table-stats touches
// every org's data, so these are superadmin-only, not reachable by an
// individual org's admin. See CLAUDE.md's RC roadmap: this was a known gap
// while multi-tenancy had no platform-level role to restrict it to.
const superadminOnly = requireRole('superadmin');
const execAsync = promisify(exec);

// ── Policy export ─────────────────────────────────────────────────────────────
// orgContextMiddleware here (not router.use — this router's other routes are
// whole-instance operations, not per-tenant, see the note further down) since
// these two routes touch the RLS-protected `policies` table.

router.get('/export/policies', requireAuth, adminOnly, orgContextMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.user!.orgId as string;
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
      exported_by: req.user?.email,
      policies,
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="eventagg-policies-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(bundle);
  } catch (e) { next(e); }
});

// ── Policy import ─────────────────────────────────────────────────────────────

// Only the bundle's outer shape (version + policies being an array) is
// validated strictly — a single malformed policy entry inside a mostly-good
// bundle is collected into results.errors below rather than rejecting the
// whole import, matching this route's existing partial-success design (the
// same reason DB-constraint failures per policy are caught individually).
const policyImportBundleSchema = z.object({
  version:  z.string().min(1, 'Invalid bundle — missing version field'),
  policies: z.array(z.unknown()).default([]),
});

const policyImportItemSchema = z.object({
  name:         z.string().min(1),
  domain:       z.string().min(1),
  key_field:    z.string().min(1),
  cradle_field: z.string().min(1),
  cradle_value: z.string().min(1),
  grave_field:  z.string().min(1),
  grave_value:  z.string().min(1),
  timeout_ms:   z.number().int().positive().nullable().optional(),
  description:  z.string().nullable().optional(),
});

router.post('/import/policies', requireAuth, adminOnly, orgContextMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.user!.orgId as string;
    const bundle = policyImportBundleSchema.parse(req.body);

    const results = { imported: 0, updated: 0, errors: [] as string[] };

    for (const raw of bundle.policies) {
      const parsed = policyImportItemSchema.safeParse(raw);
      if (!parsed.success) {
        const label = (raw as Record<string, unknown>)?.name ?? '(unnamed)';
        results.errors.push(`Policy "${label}": ${parsed.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join(', ')}`);
        continue;
      }
      const pol = parsed.data;
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
             pol.grave_field, pol.grave_value, pol.timeout_ms ?? null, pol.description ?? null]
          );
          results.updated++;
        } else {
          await query(
            `INSERT INTO policies (org_id, name, domain, key_field, cradle_field, cradle_value,
             grave_field, grave_value, timeout_ms, description)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [orgId, pol.name, pol.domain, pol.key_field, pol.cradle_field, pol.cradle_value,
             pol.grave_field, pol.grave_value, pol.timeout_ms ?? null, pol.description ?? null]
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

// NOTE: backup/restore below use pg_dump/psql against the whole database —
// fundamentally not tenant-scopable (a dump contains every organisation's
// data) — so these, plus the whole-instance table stats and VACUUM further
// down, are superadmin-only. /db/purge stays admin-accessible since it's
// already scoped to the caller's own org.

// ── Database backup ───────────────────────────────────────────────────────────

router.get('/backup/info', requireAuth, superadminOnly, async (_req: Request, res: Response, next: NextFunction) => {
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

router.post('/backup', requireAuth, superadminOnly, async (_req: Request, res: Response, next: NextFunction) => {
  const tmpFile = path.join(os.tmpdir(), `eventagg-backup-${Date.now()}.sql`);
  try {
    const host = process.env.PGHOST     || 'localhost';
    const port = process.env.PGPORT     || '5432';
    const db   = process.env.PGDATABASE || 'eventagg';
    const user = process.env.PGUSER     || 'eventagg_user';
    // --clean --if-exists: without these, the dump is bare CREATE TABLE/
    // CREATE FUNCTION/etc. statements with nothing dropping the old ones
    // first. Restoring that into a database that already has the schema
    // (always true here — migrations run at container boot, before the
    // restore feature is even reachable) collides on every single object
    // with "already exists" errors.
    await execAsync(
      `pg_dump --clean --if-exists -h ${host} -p ${port} -U ${user} -d ${db} -f ${tmpFile}`,
      { timeout: 120_000 }
    );
    const stat = fs.statSync(tmpFile);
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="eventagg-backup-${new Date().toISOString().slice(0, 10)}.sql"`);
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('end',   () => { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } });
    stream.on('error', next);
  } catch (e) {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    next(e);
  }
});

// ── Database restore ──────────────────────────────────────────────────────────

router.post('/restore', requireAuth, superadminOnly, async (req: Request, res: Response, next: NextFunction) => {
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
    // ON_ERROR_STOP=1 is essential here: without it, psql prints an error for
    // a failing statement (e.g. a schema mismatch from a dump taken on an
    // older version of this app) and just carries on to the next statement,
    // exiting 0 regardless — silently leaving a partially-restored database
    // while reporting success.
    await execAsync(
      `psql -v ON_ERROR_STOP=1 -h ${host} -p ${port} -U ${user} -d ${db} -f ${tmpFile}`,
      { timeout: 1_800_000, maxBuffer: 1024 * 1024 * 100 }
    );
    res.json({ ok: true, message: 'Restore completed' });
  } catch (e) {
    next(e);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
});

// ── DB maintenance ────────────────────────────────────────────────────────────

router.get('/db/stats', requireAuth, superadminOnly, async (_req: Request, res: Response, next: NextFunction) => {
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
    res.json({ tables, db_size: dbSize.size, db_size_bytes: dbSize.size_bytes });
  } catch (e) { next(e); }
});

// Org-scoped preview of what THIS org's /db/purge would actually delete —
// separate from /db/stats (whole-instance, superadmin-only) since the old
// combined endpoint's purgeable_90d counted every org's rows, not just the
// caller's, which didn't match what their own purge call would do.
router.get('/db/purgeable', requireAuth, adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.user!.orgId as string;
    const [purgeable] = await query<{ completed: string; audit: string }>(
      `SELECT
        (SELECT COUNT(*) FROM completed_events WHERE org_id = $1 AND ended_at < now() - interval '90 days')::text AS completed,
        (SELECT COUNT(*) FROM audit_log        WHERE org_id = $1 AND event_time < now() - interval '90 days')::text AS audit`,
      [orgId]
    );
    res.json({ purgeable_90d: purgeable });
  } catch (e) { next(e); }
});

router.post('/db/vacuum', requireAuth, superadminOnly, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await query('VACUUM ANALYZE');
    res.json({ ok: true, message: 'VACUUM ANALYZE completed' });
  } catch (e) { next(e); }
});

const purgeBodySchema = z.object({
  days: z.coerce.number().int().min(30, 'Minimum retention is 30 days').default(90),
});

router.post('/db/purge', requireAuth, adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.user!.orgId as string;
    const { days } = purgeBodySchema.parse(req.body);

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
