import express from "express";
import cors from "cors";
import { config } from "./config";
import { testConnection, closePool } from "./db/pool";
import { runMigrations } from "./db/migrate";
import { errorHandler, notFound } from "./middleware/errorHandler";
import policiesRouter from "./routes/policies";
import eventsRouter   from "./routes/events";
import ingestRouter   from "./routes/ingest";

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Request logging in development
if (config.nodeEnv === "development") {
  app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
  });
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/v1/policies",         policiesRouter);
app.use("/api/v1/events/ingest",    ingestRouter);
app.use("/api/v1/events",           eventsRouter);

// ─── 404 & error handlers ─────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── Startup ──────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  try {
    await testConnection();
    await runMigrations();

    const server = app.listen(config.port, () => {
      console.log(`🚀  EventAgg API running on port ${config.port} [${config.nodeEnv}]`);
      console.log(`    Health:   http://localhost:${config.port}/health`);
      console.log(`    Policies: http://localhost:${config.port}/api/v1/policies`);
      console.log(`    Events:   http://localhost:${config.port}/api/v1/events`);
      console.log(`    Ingest:   POST http://localhost:${config.port}/api/v1/events/ingest`);
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`\n${signal} received — shutting down gracefully...`);
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
