import { Router, Request, Response, NextFunction } from "express";
import { queryOne } from "../db/pool";
import { inProgressGroups, register } from "../metrics";

const router = Router();

// GET /metrics -Prometheus text-exposition format. Unauthenticated, matching
// /health's precedent: meant for internal scrapers, not people, and it exposes
// only counts/timings, never event content or credentials.
router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // in_progress_events has no RLS yet, so a plain count is the whole
    // platform's value. Reading it on scrape keeps the gauge correct across
    // restarts and multiple backend processes.
    const row = await queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM in_progress_events`
    );
    inProgressGroups.set(Number(row?.count ?? 0));

    res.set("Content-Type", register.contentType);
    res.send(await register.metrics());
  } catch (err) {
    next(err);
  }
});

export default router;
