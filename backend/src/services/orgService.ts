import { randomBytes } from "crypto";
import { query, queryOne } from "../db/pool";

export interface Org {
  id: string;
  name: string;
  slug: string;
  ingestApiKey: string;
  snmpCommunity: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  ingest_api_key: string;
  snmp_community: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function toOrg(r: OrgRow): Org {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    ingestApiKey: r.ingest_api_key,
    snmpCommunity: r.snmp_community,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "org";
}

export async function listOrgs(): Promise<Org[]> {
  const rows = await query<OrgRow>(`SELECT * FROM organisations ORDER BY created_at ASC`);
  return rows.map(toOrg);
}

export async function createOrg(input: { name: string; slug?: string }): Promise<Org> {
  const slug = input.slug?.trim() || slugify(input.name);
  const row = await queryOne<OrgRow>(
    `INSERT INTO organisations (name, slug, snmp_community) VALUES ($1, $2, $3) RETURNING *`,
    [input.name, slug, randomBytes(6).toString("hex")]
  );
  if (!row) throw new Error("Failed to create organisation");
  return toOrg(row);
}

export async function updateOrg(
  id: string,
  input: { name?: string; isActive?: boolean; regenerateKey?: boolean; snmpCommunity?: string }
): Promise<Org | null> {
  const row = await queryOne<OrgRow>(
    `UPDATE organisations SET
       name           = COALESCE($1, name),
       is_active      = COALESCE($2, is_active),
       ingest_api_key = CASE WHEN $3 THEN encode(gen_random_bytes(24), 'hex') ELSE ingest_api_key END,
       snmp_community = COALESCE($4, snmp_community),
       updated_at     = NOW()
     WHERE id = $5
     RETURNING *`,
    [input.name ?? null, input.isActive ?? null, input.regenerateKey === true, input.snmpCommunity ?? null, id]
  );
  return row ? toOrg(row) : null;
}

export async function deleteOrg(id: string): Promise<boolean> {
  try {
    const result = await query(`DELETE FROM organisations WHERE id = $1`, [id]);
    return (result as any).rowCount > 0;
  } catch (err: any) {
    if (err.code === "23503") { // foreign_key_violation
      const friendly = new Error("Organisation still has policies, users, or events — deactivate it instead of deleting");
      (friendly as any).statusCode = 409;
      throw friendly;
    }
    throw err;
  }
}
