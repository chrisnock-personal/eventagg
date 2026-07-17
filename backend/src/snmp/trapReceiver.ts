import { query, runWithOrgContext } from "../db/pool";
import { ingestRawEvent } from "../services/ingestService";
import { normalizeTrap, RawTrap, invalidateRoutingCache, getDefaultOrgId } from "./trapNormalizer";
import { statsCache, performanceCache } from "../cache";
import { logger } from "../logger";
import * as dgram from "dgram";

export interface SnmpReceiverConfig {
  port:      number;
  community: string;
  enabled:   boolean;
}

export interface SnmpReceiverStats {
  received:  number;
  routed:    number;
  unrouted:  number;
  errors:    number;
  startedAt: Date | null;
}

const stats: SnmpReceiverStats = {
  received: 0, routed: 0, unrouted: 0, errors: 0, startedAt: null,
};

let socket: dgram.Socket | null = null;

export function getSnmpStats(): SnmpReceiverStats {
  return { ...stats };
}

async function logTrap(trap: Awaited<ReturnType<typeof normalizeTrap>>, result?: any): Promise<void> {
  try {
    // SNMP multi-tenant routing is a later phase — every trap resolves to an
    // org today (via the policy/rule it routes to, or the Default
    // Organisation if unrouted) so the NOT NULL org_id columns below are
    // always satisfiable.
    const orgId = trap.orgId ?? await getDefaultOrgId();
    if (!orgId) return; // organisations table not seeded yet (e.g. mid-migration)

    await query(
      `INSERT INTO snmp_trap_log
         (org_id, agent_addr, community, trap_oid, trap_name, varbinds, routed_to, route_type, ingest_result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [orgId, trap.agentAddr, trap.community, trap.trapOid, trap.trapName,
       JSON.stringify(trap.varbinds), trap.routedTo ?? null, trap.routeType,
       result ? JSON.stringify(result) : null]
    );
    await query(`DELETE FROM snmp_trap_log WHERE id NOT IN (SELECT id FROM snmp_trap_log ORDER BY received_at DESC LIMIT 1000)`, []);
    await query(
      `INSERT INTO snmp_trap_sources (org_id, name, agent_addr, community, last_seen, trap_count)
       VALUES ($1,$2,$3,$4,NOW(),1)
       ON CONFLICT (org_id, agent_addr) DO UPDATE
         SET last_seen=NOW(), trap_count=snmp_trap_sources.trap_count+1,
             community=EXCLUDED.community, updated_at=NOW()`,
      [orgId, trap.agentAddr, trap.agentAddr, trap.community]
    );
  } catch (err) {
    logger.error({ err }, "📡  SNMP log error");
  }
}

async function processTrap(raw: RawTrap): Promise<void> {
  stats.received++;
  // The dgram receiver has no request/session — which org a trap belongs
  // to is resolved dynamically per-trap (by community string, then
  // policy/rule) inside normalizeTrap()/ingestRawEvent(), not known ahead
  // of time. Bypass, same as the other background jobs in index.ts.
  await runWithOrgContext({ orgId: null, bypass: true }, async () => {
    try {
      const normalized = await normalizeTrap(raw);
      if (!normalized.ingestInput || !normalized.orgId) {
        stats.unrouted++;
        logger.info({ trapName: normalized.trapName, sourceAddress: raw.sourceAddress }, "📡  SNMP unrouted");
        await logTrap(normalized);
        return;
      }
      const result = await ingestRawEvent(normalized.orgId, normalized.ingestInput);
      stats.routed++;
      statsCache.invalidateAll();
      performanceCache.invalidateAll();
      logger.info(
        { routeType: normalized.routeType, trapName: normalized.trapName, aggregationKey: result.aggregationKey, action: result.action },
        "📡  SNMP trap processed"
      );
      await logTrap(normalized, result);
    } catch (err: any) {
      stats.errors++;
      logger.error({ err, sourceAddress: raw.sourceAddress }, "📡  SNMP process error");
    }
  });
}

// ─── Minimal SNMPv2c BER/ASN.1 parser ────────────────────────────────────────
function parseTrap(buf: Buffer, sourceAddr: string, defaultCommunity: string): RawTrap | null {
  let p = 0;
  const rb   = ()         => buf[p++];
  const rl   = (): number => { const b=rb(); if(b<0x80) return b; const n=b&0x7f; let l=0; for(let i=0;i<n;i++) l=(l<<8)|rb(); return l; };
  const rtlv = ()         => { const tag=rb(); const len=rl(); const data=buf.slice(p,p+len); p+=len; return {tag,data}; };
  const toOid = (b: Buffer): string => {
    const parts=[Math.floor(b[0]/40),b[0]%40]; let v=0;
    for(let i=1;i<b.length;i++){ v=(v<<7)|(b[i]&0x7f); if(!(b[i]&0x80)){parts.push(v);v=0;} }
    return parts.join(".");
  };
  const toInt = (b: Buffer): number => { let v=0; for(let i=0;i<b.length;i++) v=v*256+b[i]; return v; };

  try {
    if(rb()!==0x30) return null; rl();
    rtlv(); // version
    const comm = rtlv().data.toString("ascii");
    const pduTLV = rtlv();
    if(pduTLV.tag!==0xa7 && pduTLV.tag!==0xa4) return null;

    const pb=pduTLV.data; let pp=0;
    const prb  = ()        => pb[pp++];
    const prl  = ():number => { const b=prb(); if(b<0x80) return b; const n=b&0x7f; let l=0; for(let i=0;i<n;i++) l=(l<<8)|prb(); return l; };
    const prtlv= ()        => { const tag=prb(); const len=prl(); const data=pb.slice(pp,pp+len); pp+=len; return {tag,data}; };

    prtlv(); prtlv(); prtlv(); // reqId, errStatus, errIdx
    // varbindList SEQUENCE — read tag+length only, don't skip content
    prb(); prl();

    let trapOid=""; let uptime=0;
    const varbinds: RawTrap["varbinds"] = [];

    while(pp<pb.length) {
      if(pb[pp]!==0x30) break;
      const vbSeq = prtlv(); // read entire varbind SEQUENCE into its own buffer
      // parse OID and value from the varbind's own data buffer
      let vp = 0;
      const vrb = () => vbSeq.data[vp++];
      const vrl = (): number => { const b=vrb(); if(b<0x80) return b; const n=b&0x7f; let l=0; for(let i=0;i<n;i++) l=(l<<8)|vrb(); return l; };
      const vrtlv = () => { const tag=vrb(); const len=vrl(); const data=vbSeq.data.slice(vp,vp+len); vp+=len; return {tag,data}; };
      const oidT = vrtlv();
      const valT = vrtlv();
      const oid = toOid(oidT.data);
      if(oid==="1.3.6.1.2.1.1.3.0")          uptime=toInt(valT.data);
      else if(oid==="1.3.6.1.6.3.1.1.4.1.0") trapOid=toOid(valT.data);
      else {
        const val = valT.tag===0x04 ? valT.data.toString("utf8")
                  : valT.tag===0x06 ? toOid(valT.data)
                  : valT.tag===0x02 ? toInt(valT.data)
                  : valT.data.toString("hex");
        varbinds.push({oid, value: val});
      }
    }
    if(!trapOid) return null;
    return { sourceAddress: sourceAddr, community: comm||defaultCommunity, trapOid, uptime, varbinds, version: 2 };
  } catch { return null; }
}

export function startSnmpReceiver(config: SnmpReceiverConfig): void {
  if (!config.enabled) {
    logger.info("📡  SNMP trap receiver disabled (set SNMP_ENABLED=true to enable)");
    return;
  }
  if (socket) return;

  socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

  socket.on("error", (err: NodeJS.ErrnoException) => {
    logger.error({ err }, "📡  SNMP socket error");
    socket = null;
  });

  socket.on("message", async (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    logger.debug({ address: rinfo.address, port: rinfo.port, bytes: msg.length }, "📡  UDP packet received");
    const raw = parseTrap(msg, rinfo.address, config.community);
    if (!raw) {
      logger.warn({ firstByte: `0x${msg[0]?.toString(16)}` }, "📡  Not a valid SNMPv2c trap");
      return;
    }
    await processTrap(raw);
  });

  socket.bind({ port: config.port, address: "0.0.0.0", exclusive: false }, () => {
    const addr = socket?.address();
    stats.startedAt = new Date();
    logger.info({ address: addr?.address, port: addr?.port, enterpriseOid: "1.3.6.1.4.1.99999" }, "📡  SNMP trap receiver listening");
  });
}

export function stopSnmpReceiver(): void {
  if (socket) {
    try { socket.close(); } catch { /* ignore */ }
    socket = null;
    logger.info("📡  SNMP trap receiver stopped");
  }
}

export { invalidateRoutingCache };
