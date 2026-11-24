import { Request, Response, NextFunction } from "express";
import { httpRequestDuration } from "../metrics";

/**
 * Records request duration/count/status for every request. Uses res.on("finish")
 * so errors and 404s are recorded too, and is mounted globally before routers.
 *
 * The route label uses the matched Express route pattern plus its baseUrl
 * (e.g. "/api/v1/policies/:id"), never the raw request path: raw paths contain
 * UUIDs and would give Prometheus unbounded label cardinality.
 */
export function metrics(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : "unmatched";
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestDuration.observe(
      { method: req.method, route, status_code: res.statusCode },
      durationSeconds
    );
  });

  next();
}
