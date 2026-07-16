import { Request, Response, NextFunction } from "express";
import { queryOne } from "../db/pool";

// ─── API Key authentication ───────────────────────────────────────────────────
// Protects the ingest endpoint. Each organisation has its own generated key
// (organisations.ingest_api_key) — the key both authenticates the request and
// resolves which org it belongs to, attached to the request as req.org.
// Clients send the key as:  X-API-Key: <key>

export interface RequestOrg {
  id: string;
  name: string;
}

export async function requireApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const providedKey = req.headers["x-api-key"] as string | undefined;
  if (!providedKey) {
    res.status(401).json({
      error: "Unauthorized — provide a valid X-API-Key header",
      hint: "No X-API-Key header provided",
    });
    return;
  }

  const org = await queryOne<{ id: string; name: string }>(
    `SELECT id, name FROM organisations WHERE ingest_api_key = $1 AND is_active = TRUE`,
    [providedKey]
  );
  if (!org) {
    res.status(401).json({
      error: "Unauthorized — provide a valid X-API-Key header",
      hint: "Key is invalid",
    });
    return;
  }

  (req as any).org = { id: org.id, name: org.name } as RequestOrg;
  next();
}
