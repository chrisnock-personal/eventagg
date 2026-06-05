import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import { config } from "./config";
import { testConnection, closePool, query, withTransaction } from "./db/pool";
import { runMigrations } from "./db/migrate";
import { errorHandler, notFound } from "./middleware/errorHandler";
import { requireApiKey } from "./middleware/auth";
import { statsCache, performanceCache } from "./cache";
import { openApiSpec } from "./openapi";
import authRouter     from "./routes/auth";
import policiesRouter from "./routes/policies";
import eventsRouter   from "./routes/events";
import ingestRouter   from "./routes/ingest";
import snmpRouter     from "./routes/snmp";
import auditRouter    from "./routes/audit";
import webhooksRouter from "./routes/webhooks";
import systemRouter   from "./routes/system";
import adminRouter    from "./routes/admin";
import { createUser, updateUser } from "./services/userService";
import { startSnmpReceiver, stopSnmpReceiver, getSnmpStats } from "./snmp/trapReceiver";
import { triggerWebhooks } from "./services/webhookService";
import { sendGroupTimedOutAlert } from "./services/smtpService";

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Request logging in development
if (config.nodeEnv === "development") {
  app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
  });
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  try {
    // DB connectivity + partition check
    const [dbCheck, partitionCheck] = await Promise.all([
      query("SELECT 1 AS ok"),
      query<{ relname: string }>(`
        SELECT child.relname
        FROM   pg_inherits
        JOIN   pg_class child  ON pg_inherits.inhrelid  = child.oid
        JOIN   pg_class parent ON pg_inherits.inhparent = parent.oid
        WHERE  parent.relname = 'completed_events'
        ORDER  BY child.relname DESC LIMIT 4
      `),
    ]);
    const partitions = partitionCheck.map(r => r.relname);
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      db: { connected: true, recentPartitions: partitions },
      cache: { statsEntries: statsCache.size, performanceEntries: performanceCache.size },
      snmp: getSnmpStats(),
      uptime: Math.round(process.uptime()),
    });
  } catch (err: any) {
    res.status(503).json({ status: "error", error: err.message, timestamp: new Date().toISOString() });
  }
});

// ─── Rate limiting ────────────────────────────────────────────────────────────
const ingestRateLimit = rateLimit({
  windowMs: 60_000,          // 1 minute
  max: 10_000,               // 10k requests/min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Ingest rate limit exceeded — reduce request frequency or batch events" },
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/v1/auth",             authRouter);
app.use("/api/v1/policies",         policiesRouter);
app.use("/api/v1/events/ingest",    ingestRateLimit, requireApiKey, ingestRouter);
app.use("/api/v1/events",           eventsRouter);
app.use("/api/v1/snmp",             snmpRouter);
app.use("/api/v1/audit",            auditRouter);
app.use("/api/v1/webhooks",         webhooksRouter);
app.use("/api/v1/system",           systemRouter);
// Restore route needs raw SQL body — must be registered before adminRouter
app.use("/api/v1/admin/restore",    express.text({ type: "application/sql", limit: "100mb" }));
app.use("/api/v1/admin",            adminRouter);

// ─── OpenAPI spec + Swagger UI ────────────────────────────────────────────────
app.get("/api/v1/openapi.json", (_req, res) => res.json(openApiSpec));
app.use("/api/v1/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec, {
  customSiteTitle: "Aggre/Gator API Docs",
  customCss: `
    .swagger-ui .topbar { background-color: #1A1916; }
    .swagger-ui .topbar .download-url-wrapper { display: none; }
    .swagger-ui .info .title { color: #1D6B4E; }
    body { font-family: 'Calibri', sans-serif; }
  `,
  swaggerOptions: {
    docExpansion: "list",
    filter: true,
    tagsSorter: "alpha",
  },
}));

// ─── 404 & error handlers ─────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── Auto-partition management ────────────────────────────────────────────────
// Ensures completed_events partitions exist for the current + next 3 quarters.
// Runs on startup and every 24h. Safe to run repeatedly (IF NOT EXISTS).
async function runPartitionJob(): Promise<void> {
  try {
    const now = new Date();
    const year = now.getFullYear();
    const quarter = Math.floor(now.getMonth() / 3); // 0-based

    // Create partitions for current quarter + next 3
    const toCreate: Array<{ year: number; q: number }> = [];
    for (let i = 0; i < 4; i++) {
      const totalQ = quarter + i;
      toCreate.push({ year: year + Math.floor(totalQ / 4), q: totalQ % 4 });
    }

    const quarterMonths = [[1,4],[4,7],[7,10],[10,1]]; // [start, end] month (1-based)
    for (const { year: y, q } of toCreate) {
      const [startM, endM] = quarterMonths[q];
      const endY = endM === 1 ? y + 1 : y;
      const tableName = `completed_events_${y}_q${q + 1}`;
      const startDate = `${y}-${String(startM).padStart(2, "0")}-01`;
      const endDate   = `${endY}-${String(endM).padStart(2, "0")}-01`;

      await query(
        `CREATE TABLE IF NOT EXISTS ${tableName}
         PARTITION OF completed_events
         FOR VALUES FROM ($1) TO ($2)`,
        [startDate, endDate]
      );
    }
    console.log(`📅  Partition job: ensured partitions for ${toCreate.map(t => `${t.year} Q${t.q+1}`).join(", ")}`);
  } catch (err) {
    console.error("📅  Partition job error:", err);
  }
}

// ─── Timeout background job ───────────────────────────────────────────────────
// Runs every 60s. Finds in-progress groups where last_raw_event_at + policy.timeout_ms
// is in the past, and promotes them to completed_events with status='timed_out'.
async function runTimeoutJob(): Promise<void> {
  try {
    // Find all in-progress groups where the policy has a timeout and it has elapsed
    const timedOut = await query<{
      id: string;
      policy_id: string;
      policy_name: string;
      aggregation_key: string;
      key_field: string;
      raw_event_count: number;
      cradle_raw_event_id: string | null;
      started_at: string;
      last_raw_event_at: string;
    }>(
      `SELECT e.id, e.policy_id, p.name AS policy_name, e.aggregation_key, e.key_field,
              e.raw_event_count, e.cradle_raw_event_id, e.started_at, e.last_raw_event_at
       FROM   in_progress_events e
       JOIN   policies p ON p.id = e.policy_id
       WHERE  p.timeout_ms IS NOT NULL
         AND  e.last_raw_event_at + (p.timeout_ms || ' milliseconds')::INTERVAL < NOW()`
    );

    if (timedOut.length === 0) return;

    console.log(`⏱  Timeout job: ${timedOut.length} group(s) to close`);

    for (const group of timedOut) {
      try {
        await withTransaction(async (client) => {
          const now = new Date().toISOString();

          // Promote to completed_events with timed_out status
          const [completed] = await client.query<{ id: string }>(
            `INSERT INTO completed_events
               (policy_id, aggregation_key, key_field, raw_event_count,
                cradle_raw_event_id, grave_raw_event_id, started_at, ended_at,
                status, close_reason)
             VALUES ($1, $2, $3, $4, $5, $5, $6, NOW(), 'timed_out', 'policy_timeout')
             RETURNING id`,
            [
              group.policy_id,
              group.aggregation_key,
              group.key_field,
              group.raw_event_count,
              group.cradle_raw_event_id ?? '00000000-0000-0000-0000-000000000000',
              group.started_at,
            ]
          ).then(r => r.rows);

          // Re-point raw events to the completed record
          await client.query(
            `UPDATE raw_events
             SET    in_progress_id = NULL, completed_id = $1
             WHERE  in_progress_id = $2`,
            [completed.id, group.id]
          );

          // Remove from in_progress
          await client.query(
            `DELETE FROM in_progress_events WHERE id = $1`,
            [group.id]
          );

          console.log(`    ✓ Timed out: ${group.aggregation_key} (${group.id.slice(0,8)}…)`);

          // Fire webhooks + SMTP alert after transaction commits
          const endedAt = new Date();
          setImmediate(() => {
            triggerWebhooks("group_timed_out", {
              id: completed.id,
              policyId: group.policy_id,
              policyName: group.policy_name,
              aggregationKey: group.aggregation_key,
              status: "timed_out",
              rawEventCount: group.raw_event_count,
              startTime: group.started_at,
              endTime: endedAt.toISOString(),
              durationMs: endedAt.getTime() - new Date(group.started_at).getTime(),
            }).catch(() => {});
            sendGroupTimedOutAlert({
              policyName:     group.policy_name,
              aggregationKey: group.aggregation_key,
              timeoutMs:      0,
              openedAt:       new Date(group.started_at),
            }).catch(() => {});
          });
        });
      } catch (err) {
        console.error(`    ✗ Failed to time out group ${group.id}:`, err);
      }
    }
  } catch (err) {
    console.error("⏱  Timeout job error:", err);
  }
}

// ─── Seed default admin ───────────────────────────────────────────────────────
async function seedDefaultAdmin(): Promise<void> {
  try {
    const existing = await query<{ id: string }>(
      "SELECT id FROM users WHERE username = 'admin' LIMIT 1"
    );
    const password = process.env.ADMIN_PASSWORD || "admin123";
    if (existing.length === 0) {
      await createUser({ username: "admin", email: "admin@localhost", password, role: "admin" });
      console.log(`👤  Default admin created — username: admin  password: ${password}`);
    } else {
      // Always reset the hash on startup so it matches the current bcryptjs implementation
      await updateUser(existing[0].id, { password });
      // Reset password_changed so the first-login change prompt re-appears
      await query(`UPDATE users SET password_changed = FALSE WHERE id = $1 AND username = 'admin'`, [existing[0].id]);
      console.log(`👤  Admin password refreshed — username: admin  password: ${password}`);
    }
  } catch (err) {
    console.error("⚠️  Failed to seed admin user:", err);
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  try {
    await testConnection();
    await runMigrations();

    // Seed default admin if no users exist yet
    await seedDefaultAdmin();

    const server = app.listen(config.port, () => {
      console.log(`🚀  Aggre/Gator API running on port ${config.port} [${config.nodeEnv}]`);
      console.log(`    Health:   http://localhost:${config.port}/health`);
      console.log(`    Policies: http://localhost:${config.port}/api/v1/policies`);
      console.log(`    Events:   http://localhost:${config.port}/api/v1/events`);
      console.log(`    Ingest:   POST http://localhost:${config.port}/api/v1/events/ingest`);
      console.log(`    Docs:     http://localhost:${config.port}/api/v1/docs`);
      console.log(`    SNMP:     UDP port ${process.env.SNMP_PORT ?? "1162"} (${process.env.SNMP_ENABLED === "true" ? "enabled" : "disabled — set SNMP_ENABLED=true"})`);
    });

    // Start timeout job — run immediately then every 60 seconds
    runTimeoutJob();
    const timeoutJobInterval = setInterval(runTimeoutJob, 60_000);

    // Start partition job — run immediately then every 24 hours
    runPartitionJob();
    const partitionJobInterval = setInterval(runPartitionJob, 24 * 60 * 60_000);

    // Start SNMP trap receiver
    startSnmpReceiver({
      port:      parseInt(process.env.SNMP_PORT ?? "1162"),
      community: process.env.SNMP_COMMUNITY ?? "public",
      enabled:   process.env.SNMP_ENABLED === "true",
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`\n${signal} received — shutting down gracefully...`);
      clearInterval(timeoutJobInterval);
      clearInterval(partitionJobInterval);
      stopSnmpReceiver();
      statsCache.destroy();
      performanceCache.destroy();
      server.close(async () => {
        await closePool();
        console.log("✅  Shutdown complete");
        process.exit(0);
      });
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT",  () => shutdown("SIGINT"));
  } catch (err) {
    console.error("❌  Failed to start:", err);
    process.exit(1);
  }
}

start();
