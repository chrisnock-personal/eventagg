import { Router, Request, Response, NextFunction } from 'express';
import { execSync } from 'child_process';
import { z } from 'zod';
import * as fs from 'fs';
import * as os from 'os';
import { requireAuth, requireRole, setSessionCookie } from '../middleware/session';
import { query, runWithOrgContext } from '../db/pool';
import { getMultiTenancyConfig, enableMultiTenancy } from '../services/tenancyService';

const router = Router();
const adminOnly = requireRole('admin');

// ── System config ─────────────────────────────────────────────────────────────
// 'multi_tenancy' is deliberately excluded from this generic key/value store —
// it can only be flipped via POST /tenancy/enable below, which also performs
// the superadmin promotion in the same transaction. Allowing it through here
// too would let any admin flip the flag without actually promoting anyone.

// Shared with POST /config/smtp/test below — both need the same shape.
const smtpConfigSchema = z.object({
  host:     z.string().min(1),
  port:     z.number().int().min(1).max(65535),
  secure:   z.boolean(),
  user:     z.string().min(1),
  password: z.string().min(1),
  from:     z.string().optional().default(''),
});

// Per-key validation for the known keys this generic store actually holds
// today. An unrecognized key still falls through to a permissive "must be a
// plain object" check below, so the store stays forward-compatible with
// future config keys without needing a schema added here first.
const CONFIG_SCHEMAS: Record<string, z.ZodType> = {
  smtp: smtpConfigSchema,
};

router.get('/config/:key', requireAuth, adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await query<{ value: unknown }>(
      `SELECT value FROM system_config WHERE key = $1`, [req.params.key]
    );
    if (rows.length) { res.json(rows[0].value); } else { res.status(404).json({ error: 'Not found' }); }
  } catch (e) { next(e); }
});

router.put('/config/:key', requireAuth, adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.params.key === 'multi_tenancy') {
      return res.status(403).json({ error: 'Use POST /system/tenancy/enable to enable multi-tenancy' });
    }
    const schema = CONFIG_SCHEMAS[req.params.key] ?? z.record(z.string(), z.unknown());
    const value = schema.parse(req.body);
    await query(
      `INSERT INTO system_config (key, value, updated_at, updated_by)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now(), updated_by = $3`,
      [req.params.key, JSON.stringify(value), req.user?.email]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Multi-tenancy toggle ───────────────────────────────────────────────────────

router.get('/tenancy', requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getMultiTenancyConfig());
  } catch (e) { next(e); }
});

router.post('/tenancy/enable', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { password } = z.object({ password: z.string().min(1) }).parse(req.body);

    const user = req.user!;
    // Authenticating by username (before org is re-confirmed) and the
    // subsequent org_id -> NULL self-promotion to superadmin both need
    // bypass — the org_id NULL write is exactly what WITH CHECK otherwise
    // reserves for bypass contexts only (see migration 024).
    const result = await runWithOrgContext({ orgId: null, bypass: true }, () =>
      enableMultiTenancy(user.username, password)
    );
    if (!result.ok || !result.user) {
      return res.status(result.statusCode ?? 400).json({ error: result.error });
    }

    const sessionUser = {
      id: result.user.id,
      username: result.user.username,
      email: result.user.email,
      role: result.user.role,
      passwordChanged: result.user.passwordChanged,
      orgId: result.user.orgId,
      orgName: result.user.orgName,
    };
    setSessionCookie(res, sessionUser);
    res.json(sessionUser);
  } catch (e) { next(e); }
});

// ── SMTP test ─────────────────────────────────────────────────────────────────

router.post('/config/smtp/test', requireAuth, adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  // Shape errors (missing host, bad port, etc.) go through the standard
  // validation-error path; only an actual connection/auth failure gets the
  // friendlier inline 400 below, since that's the whole point of "test".
  let cfg: z.infer<typeof smtpConfigSchema>;
  try {
    cfg = smtpConfigSchema.parse(req.body);
  } catch (e) { return next(e); }

  try {
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.default.createTransport({
      host: cfg.host, port: cfg.port, secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.password },
    });
    await transporter.verify();
    res.json({ ok: true, message: 'SMTP connection successful' });
  } catch (e) { res.status(400).json({ ok: false, error: (e as Error).message }); }
});

// ── System health ─────────────────────────────────────────────────────────────

function getMemoryInfo() {
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const getKb = (key: string) => {
      const match = raw.split('\n').find(l => l.startsWith(key));
      return match ? parseInt(match.split(/\s+/)[1]) : 0;
    };
    const total     = getKb('MemTotal:')     * 1024;
    const available = getKb('MemAvailable:') * 1024;
    const used      = total - available;
    return {
      total_mb: Math.round(total     / 1024 / 1024),
      free_mb:  Math.round(available / 1024 / 1024),
      used_mb:  Math.round(used      / 1024 / 1024),
      used_pct: total > 0 ? Math.round((used / total) * 100) : 0,
    };
  } catch {
    const total = os.totalmem();
    const free  = os.freemem();
    return {
      total_mb: Math.round(total          / 1024 / 1024),
      free_mb:  Math.round(free           / 1024 / 1024),
      used_mb:  Math.round((total - free) / 1024 / 1024),
      used_pct: Math.round(((total - free) / total) * 100),
    };
  }
}

function getDiskInfo() {
  try {
    const output = execSync('df -k /', { encoding: 'utf8' });
    const parts  = output.split('\n')[1].split(/\s+/);
    const total  = parseInt(parts[1]) * 1024;
    const used   = parseInt(parts[2]) * 1024;
    const free   = parseInt(parts[3]) * 1024;
    return {
      total_mb: Math.round(total / 1024 / 1024),
      used_mb:  Math.round(used  / 1024 / 1024),
      free_mb:  Math.round(free  / 1024 / 1024),
      used_pct: total > 0 ? Math.round((used / total) * 100) : 0,
    };
  } catch {
    return { total_mb: 0, used_mb: 0, free_mb: 0, used_pct: 0 };
  }
}

async function getCpuUsage(): Promise<number> {
  try {
    const readStat = () => {
      const line  = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
      const parts = line.split(/\s+/).slice(1).map(Number);
      const idle  = parts[3];
      const total = parts.reduce((a, b) => a + b, 0);
      return { idle, total };
    };
    const s1 = readStat();
    await new Promise(r => setTimeout(r, 250));
    const s2 = readStat();
    const dIdle  = s2.idle  - s1.idle;
    const dTotal = s2.total - s1.total;
    return dTotal > 0 ? Math.round(((dTotal - dIdle) / dTotal) * 100) : 0;
  } catch {
    return 0;
  }
}

router.get('/health', requireAuth, adminOnly, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [dbStats] = await query<{
      db_size: string; active_queries: string;
      in_progress: string; completed_24h: string; timed_out_24h: string;
    }>(
      `SELECT
        pg_size_pretty(pg_database_size(current_database())) AS db_size,
        (SELECT COUNT(*) FROM pg_stat_activity WHERE state = 'active') AS active_queries,
        (SELECT COUNT(*) FROM in_progress_events) AS in_progress,
        (SELECT COUNT(*) FROM completed_events WHERE ended_at > now() - interval '24h') AS completed_24h,
        (SELECT COUNT(*) FROM completed_events WHERE close_reason = 'timeout' AND ended_at > now() - interval '24h') AS timed_out_24h`
    );

    const tableSizes = await query<{ table: string; size: string; rows: string }>(
      `SELECT relname AS table,
              pg_size_pretty(pg_total_relation_size(relid)) AS size,
              n_live_tup::text AS rows
       FROM pg_stat_user_tables
       ORDER BY pg_total_relation_size(relid) DESC
       LIMIT 8`
    );

    const [cpuPct, memInfo, diskInfo] = await Promise.all([
      getCpuUsage(),
      Promise.resolve(getMemoryInfo()),
      Promise.resolve(getDiskInfo()),
    ]);

    const uptime = process.uptime();
    const mem    = process.memoryUsage();

    res.json({
      timestamp: new Date().toISOString(),
      backend: {
        uptime_seconds:  Math.round(uptime),
        uptime_human:    `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
        memory_mb:       Math.round(mem.heapUsed  / 1024 / 1024),
        memory_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
        node_version:    process.version,
      },
      host: {
        hostname: os.hostname(),
        platform: os.platform(),
        arch:     os.arch(),
        cpus:     os.cpus().length,
      },
      system: {
        cpu_pct:      cpuPct,
        mem_used_mb:  memInfo.used_mb,
        mem_total_mb: memInfo.total_mb,
        mem_free_mb:  memInfo.free_mb,
        mem_used_pct: memInfo.used_pct,
        disk_used_mb:  diskInfo.used_mb,
        disk_total_mb: diskInfo.total_mb,
        disk_free_mb:  diskInfo.free_mb,
        disk_used_pct: diskInfo.used_pct,
      },
      database: {
        size:           dbStats.db_size,
        active_queries: parseInt(dbStats.active_queries),
        in_progress:    parseInt(dbStats.in_progress),
        completed_24h:  parseInt(dbStats.completed_24h),
        timed_out_24h:  parseInt(dbStats.timed_out_24h),
        table_sizes:    tableSizes,
      },
    });
  } catch (e) { next(e); }
});

// ── Log viewer ────────────────────────────────────────────────────────────────

const LOG_DIR = '/var/log/supervisor';

function formatBytes(bytes: number): string {
  if (bytes < 1024)      return `${bytes} B`;
  if (bytes < 1048576)   return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

router.get('/logs/sizes', requireAuth, adminOnly, (_req: Request, res: Response, next: NextFunction) => {
  try {
    const collect = (dir: string, prefix = '') => {
      try {
        return fs.readdirSync(dir)
          .filter(f => f.endsWith('.log') || f.includes('.log.'))
          .map(f => {
            const stat = fs.statSync(`${dir}/${f}`);
            return { file: prefix + f, size_bytes: stat.size, size_human: formatBytes(stat.size), modified: stat.mtime };
          });
      } catch { return []; }
    };
    const sizes = [
      ...collect(LOG_DIR),
      ...collect('/var/log/nginx', 'nginx/'),
    ].sort((a, b) => a.file.localeCompare(b.file));
    res.json(sizes);
  } catch (e) { next(e); }
});

const ALL_LOG_FILES = [
  `${LOG_DIR}/backend.log`,
  `${LOG_DIR}/backend-err.log`,
  `${LOG_DIR}/postgres-err.log`,
  '/var/log/nginx/access.log',
  '/var/log/nginx/error.log',
];

router.post('/logs/rotate', requireAuth, adminOnly, (_req: Request, res: Response, next: NextFunction) => {
  try {
    let truncated = 0;
    for (const f of ALL_LOG_FILES) {
      try { if (fs.existsSync(f)) { fs.writeFileSync(f, ''); truncated++; } } catch { /* ignore */ }
    }
    res.json({ ok: true, output: `Truncated ${truncated} log file(s)` });
  } catch (e) { next(e); }
});

const SERVICE_LOGS: Record<string, string> = {
  backend:         `${LOG_DIR}/backend.log`,
  // Genuine uncaught-crash output that bypasses pino entirely (backend.log
  // is now the complete structured stream — see logger.ts) still lands
  // here, so it's kept as its own tab, mirroring nginx's error/access split.
  'backend-err':   `${LOG_DIR}/backend-err.log`,
  nginx:           `${LOG_DIR}/nginx-err.log`,
  'nginx-access':  '/var/log/nginx/access.log',
  postgres:        `${LOG_DIR}/postgres-err.log`,
};

router.get('/logs/:service', requireAuth, adminOnly, (req: Request, res: Response, next: NextFunction) => {
  const service = req.params.service;
  const logFile = SERVICE_LOGS[service];
  if (!logFile) return res.status(404).json({ error: 'Unknown service' });
  try {
    if (!fs.existsSync(logFile)) return res.json({ lines: [], errors: [], service });
    const { lines: lineCount } = z.object({
      lines: z.coerce.number().int().min(1).max(2000).default(200),
    }).parse(req.query);
    const output    = execSync(`tail -n ${lineCount} ${logFile}`, { encoding: 'utf8' });
    const allLines  = output.split('\n').filter(Boolean);
    // `backend` is now real pino JSON — determine severity from the actual
    // `level` field (pino: warn=40, error=50, fatal=60) instead of a
    // substring match. Every other service is an external process in its
    // own native (non-JSON) format, so keeps the old substring heuristic.
    const errors = allLines.filter(l => {
      if (service !== 'backend') {
        return l.toLowerCase().includes('error') || l.toLowerCase().includes('warn') || l.toLowerCase().includes('fatal');
      }
      try { return JSON.parse(l).level >= 40; } catch { return false; }
    }).slice(-100);
    res.json({ lines: allLines, errors, service });
  } catch (e) { next(e); }
});

export default router;
