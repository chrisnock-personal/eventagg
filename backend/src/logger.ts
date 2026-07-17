import pino from "pino";
import { AsyncLocalStorage } from "async_hooks";
import { config } from "./config";

// Request-id correlation — set once per request by
// middleware/requestLogging.ts, read transparently here so every log call
// during that request carries the same requestId without threading a
// logger instance through every function signature. Same AsyncLocalStorage
// pattern already used for org context in db/pool.ts.
const requestIdStorage = new AsyncLocalStorage<string>();

export function runWithRequestId<T>(id: string, fn: () => T): T {
  return requestIdStorage.run(id, fn);
}

// All levels go to stdout only — deliberately not split across
// stdout/stderr the way supervisord's stdout_logfile/stderr_logfile
// historically separated console.log from console.error. A single JSON
// stream lets both a real log platform and this app's own admin Log
// Viewer determine severity from the `level` field itself, not from which
// fd a line arrived on.
export const logger = pino({
  level: config.nodeEnv === "production" ? "info" : config.nodeEnv === "test" ? "silent" : "debug",
  // pino-pretty is a devDependency only — the production image's
  // `npm install --omit=dev` build step (Dockerfile) never installs it,
  // so this must stay conditional or a real deployment would crash on boot.
  transport:
    config.nodeEnv === "development"
      ? {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        }
      : undefined,
  mixin() {
    const id = requestIdStorage.getStore();
    return id ? { requestId: id } : {};
  },
});
