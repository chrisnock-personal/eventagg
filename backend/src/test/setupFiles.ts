import { afterAll } from "vitest";
import { closePool } from "../db/pool";

// Each test file gets its own isolated module registry (Vitest's default),
// so its own instance of the pg Pool in db/pool.ts — close it once that
// file's tests finish, otherwise open connections keep the process alive
// until Vitest force-exits ("close timed out after 10000ms").
afterAll(async () => {
  await closePool();
});
