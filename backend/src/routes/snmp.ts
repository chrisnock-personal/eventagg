import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { query, queryOne } from "../db/pool";
import { requireAuth, requireRole, SessionUser } from "../middleware/session";
import { createError } from "../middleware/errorHandler";
import { getSnmpStats, invalidateRoutingCache } from "../snmp/trapReceiver";

const router = Router();

// All SNMP routes require auth; most require editor+
router.use(requireAuth);

// Superadmin has no org to scope SNMP config to.
router.use((req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).user as SessionUser;
  if (!user.orgId) {
    return next(createError("Superadmin has no organisation context", 403));
  }
  next();
});

// ── GET /api/v1/snmp/status ───────────────────────────────────────────────────
router.get("/status", (_req, res) => {
  const stats = getSnmpStats();
  res.json({
    enabled:   process.env.SNMP_ENABLED === "true",
    port:      parseInt(process.env.SNMP_PORT ?? "1162"),
    community: process.env.SNMP_COMMUNITY ?? "public",
    ...stats,
  });
});

// ── GET /api/v1/snmp/sources ──────────────────────────────────────────────────
router.get("/sources", async (req, res, next) => {
  try {
    const orgId = (req as any).user.orgId as string;
    const sources = await query(
      `SELECT * FROM snmp_trap_sources WHERE org_id = $1 ORDER BY last_seen DESC NULLS LAST`,
      [orgId]
    );
    res.json(sources);
  } catch (err) { next(err); }
});

// ── POST /api/v1/snmp/sources ─────────────────────────────────────────────────
router.post("/sources", requireRole("editor", "admin"), async (req, res, next) => {
  try {
    const orgId = (req as any).user.orgId as string;
    const body = z.object({
      name:        z.string().min(1),
      agentAddr:   z.string().min(1),
      community:   z.string().default("public"),
      description: z.string().optional(),
    }).parse(req.body);

    const row = await queryOne(
      `INSERT INTO snmp_trap_sources (org_id, name, agent_addr, community, description)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [orgId, body.name, body.agentAddr, body.community, body.description ?? null]
    );
    res.status(201).json(row);
  } catch (err) { next(err); }
});

// ── PUT /api/v1/snmp/sources/:id ──────────────────────────────────────────────
router.put("/sources/:id", requireRole("editor", "admin"), async (req, res, next) => {
  try {
    const orgId = (req as any).user.orgId as string;
    const body = z.object({
      name:        z.string().optional(),
      community:   z.string().optional(),
      description: z.string().optional(),
      isActive:    z.boolean().optional(),
    }).parse(req.body);

    const row = await queryOne(
      `UPDATE snmp_trap_sources SET
         name        = COALESCE($1, name),
         community   = COALESCE($2, community),
         description = COALESCE($3, description),
         is_active   = COALESCE($4, is_active),
         updated_at  = NOW()
       WHERE id = $5 AND org_id = $6 RETURNING *`,
      [body.name ?? null, body.community ?? null, body.description ?? null, body.isActive ?? null, req.params.id, orgId]
    );
    if (!row) return next(createError("Source not found", 404));
    res.json(row);
  } catch (err) { next(err); }
});

// ── DELETE /api/v1/snmp/sources/:id ──────────────────────────────────────────
router.delete("/sources/:id", requireRole("admin"), async (req, res, next) => {
  try {
    const orgId = (req as any).user.orgId as string;
    await query(`DELETE FROM snmp_trap_sources WHERE id = $1 AND org_id = $2`, [req.params.id, orgId]);
    res.status(204).send();
  } catch (err) { next(err); }
});

// ── GET /api/v1/snmp/rules ────────────────────────────────────────────────────
router.get("/rules", async (req, res, next) => {
  try {
    const orgId = (req as any).user.orgId as string;
    const rules = await query(
      `SELECT r.*, p.name AS policy_name
       FROM snmp_routing_rules r
       JOIN policies p ON p.id = r.policy_id
       WHERE r.org_id = $1
       ORDER BY r.priority ASC`,
      [orgId]
    );
    res.json(rules);
  } catch (err) { next(err); }
});

// ── POST /api/v1/snmp/rules ───────────────────────────────────────────────────
router.post("/rules", requireRole("editor", "admin"), async (req, res, next) => {
  try {
    const orgId = (req as any).user.orgId as string;
    const body = z.object({
      priority:       z.number().int().default(100),
      matchCommunity: z.string().optional(),
      matchAgent:     z.string().optional(),
      matchTrapOid:   z.string().optional(),
      policyId:       z.string().uuid(),
      keyField:       z.string().default("sourceIp"),
    }).parse(req.body);

    // The referenced policy must belong to this org — otherwise an editor
    // could route SNMP traps into another org's policy by guessing its UUID.
    const policy = await queryOne(`SELECT id FROM policies WHERE id = $1 AND org_id = $2`, [body.policyId, orgId]);
    if (!policy) return next(createError("Policy not found", 404));

    const row = await queryOne(
      `INSERT INTO snmp_routing_rules
         (org_id, priority, match_community, match_agent, match_trap_oid, policy_id, key_field)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [orgId, body.priority, body.matchCommunity ?? null, body.matchAgent ?? null, body.matchTrapOid ?? null, body.policyId, body.keyField]
    );
    invalidateRoutingCache();
    res.status(201).json(row);
  } catch (err) { next(err); }
});

// ── PUT /api/v1/snmp/rules/:id ────────────────────────────────────────────────
router.put("/rules/:id", requireRole("editor", "admin"), async (req, res, next) => {
  try {
    const orgId = (req as any).user.orgId as string;
    const body = z.object({
      priority:       z.number().int().optional(),
      matchCommunity: z.string().nullable().optional(),
      matchAgent:     z.string().nullable().optional(),
      matchTrapOid:   z.string().nullable().optional(),
      policyId:       z.string().uuid().optional(),
      keyField:       z.string().optional(),
      isActive:       z.boolean().optional(),
    }).parse(req.body);

    if (body.policyId) {
      const policy = await queryOne(`SELECT id FROM policies WHERE id = $1 AND org_id = $2`, [body.policyId, orgId]);
      if (!policy) return next(createError("Policy not found", 404));
    }

    const row = await queryOne(
      `UPDATE snmp_routing_rules SET
         priority        = COALESCE($1, priority),
         match_community = COALESCE($2, match_community),
         match_agent     = COALESCE($3, match_agent),
         match_trap_oid  = COALESCE($4, match_trap_oid),
         policy_id       = COALESCE($5, policy_id),
         key_field       = COALESCE($6, key_field),
         is_active       = COALESCE($7, is_active)
       WHERE id = $8 AND org_id = $9 RETURNING *`,
      [body.priority ?? null, body.matchCommunity ?? null, body.matchAgent ?? null,
       body.matchTrapOid ?? null, body.policyId ?? null, body.keyField ?? null,
       body.isActive ?? null, req.params.id, orgId]
    );
    if (!row) return next(createError("Rule not found", 404));
    invalidateRoutingCache();
    res.json(row);
  } catch (err) { next(err); }
});

// ── DELETE /api/v1/snmp/rules/:id ─────────────────────────────────────────────
router.delete("/rules/:id", requireRole("admin"), async (req, res, next) => {
  try {
    const orgId = (req as any).user.orgId as string;
    await query(`DELETE FROM snmp_routing_rules WHERE id = $1 AND org_id = $2`, [req.params.id, orgId]);
    invalidateRoutingCache();
    res.status(204).send();
  } catch (err) { next(err); }
});

// ── GET /api/v1/snmp/log ──────────────────────────────────────────────────────
router.get("/log", async (req, res, next) => {
  try {
    const orgId = (req as any).user.orgId as string;
    const limit = Math.min(parseInt(String(req.query.limit ?? "100")), 500);
    const rows = await query(
      `SELECT * FROM snmp_trap_log WHERE org_id = $1 ORDER BY received_at DESC LIMIT $2`,
      [orgId, limit]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

export default router;
