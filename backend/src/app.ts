import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import { config } from "./config";
import { query } from "./db/pool";
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
import { getSnmpStats } from "./snmp/trapReceiver";

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

export default app;
