import { Request, Response, NextFunction } from "express";

// ─── API Key authentication ───────────────────────────────────────────────────
// Protects the ingest endpoint. Set INGEST_API_KEY in environment to enable.
// If the env var is not set, auth is disabled (dev/local mode).
// Clients send the key as:  X-API-Key: <key>
//
// Per-policy key support: the ingest_api_key column on event_segments already
// records the key used — a future migration can add a keys table for per-policy
// keys validated here.

const INGEST_API_KEY = process.env.INGEST_API_KEY;

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  // If no key is configured, auth is disabled
  if (!INGEST_API_KEY) {
    next();
    return;
  }

  const providedKey = req.headers["x-api-key"] as string | undefined;
  if (!providedKey || providedKey !== INGEST_API_KEY) {
    res.status(401).json({
      error: "Unauthorized — provide a valid X-API-Key header",
      hint: !providedKey ? "No X-API-Key header provided" : "Key is invalid",
    });
    return;
  }

  next();
}
