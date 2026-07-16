import { runMigrations } from "../db/migrate";

// Runs once before the whole suite. Reuses the real migration runner so
// tests exercise the exact same schema as production — no separate
// test-schema logic to maintain.
export default async function setup(): Promise<void> {
  await runMigrations();
}
