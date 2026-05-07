import fs from "fs";
import path from "path";
import { getPool } from "./pool";

const MIGRATIONS_DIR = path.join(__dirname, "../migrations");

async function ensureMigrationsTable(client: import("pg").PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT        PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedMigrations(client: import("pg").PoolClient): Promise<Set<string>> {
  const result = await client.query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY version"
  );
  return new Set(result.rows.map((r) => r.version));
}

function getMigrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

// ── Standalone runner (called directly by entrypoint.sh) ─────────────────────
if (require.main === module) {
  runMigrations()
    .then(() => { process.exit(0); })
    .catch((err) => { console.error(err); process.exit(1); });
}

export async function runMigrations(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);
    const files = getMigrationFiles();
    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      console.log("✅  Database schema up to date");
      await client.query("COMMIT");
      return;
    }

    console.log(`🔄  Applying ${pending.length} migration(s)...`);

    for (const file of pending) {
      const filePath = path.join(MIGRATIONS_DIR, file);
      const sql = fs.readFileSync(filePath, "utf-8");
      console.log(`    → ${file}`);
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [file]
      );
    }

    await client.query("COMMIT");
    console.log("✅  Migrations complete");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌  Migration failed:", err);
    throw err;
  } finally {
    client.release();
  }
}
