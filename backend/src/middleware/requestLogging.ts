import { randomUUID } from "crypto";
import { Request, Response, NextFunction } from "express";
import { logger, runWithRequestId } from "../logger";

// Mounted first in app.ts, before cors/json/cookie-parser, so every
// subsequent middleware, route, and error handler during this request logs
// under the same requestId (via logger.ts's mixin) — replaces the old
// dev-only method+path console.log with real access logging in every
// environment.
export function requestLogging(req: Request, res: Response, next: NextFunction): void {
  const id = randomUUID();
  res.setHeader("X-Request-Id", id);
  const start = Date.now();
  res.on("finish", () => {
    logger.info(
      { method: req.method, path: req.path, statusCode: res.statusCode, durationMs: Date.now() - start },
      "request"
    );
  });
  runWithRequestId(id, next);
}
