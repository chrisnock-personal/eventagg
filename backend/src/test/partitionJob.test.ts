import { describe, it, expect } from "vitest";
import { runPartitionJob } from "../index";
import { query } from "../db/pool";

// Regression test for a bug fixed this session: PostgreSQL rejects bind
// parameters inside `FOR VALUES FROM/TO` for partition bounds ("bind message
// supplies N parameters, but prepared statement requires 0"). runPartitionJob
// catches and logs errors internally rather than throwing, so the real
// assertion here is on the resulting DB state, not on runPartitionJob()
// itself throwing.
describe("runPartitionJob", () => {
  it("creates the expected quarterly partitions without error", async () => {
    await runPartitionJob();

    const now = new Date();
    const year = now.getFullYear();
    const quarter = Math.floor(now.getMonth() / 3) + 1; // 1-based
    const expectedTable = `completed_events_${year}_q${quarter}`;

    const rows = await query<{ relname: string }>(
      `SELECT child.relname
       FROM   pg_inherits
       JOIN   pg_class child  ON pg_inherits.inhrelid  = child.oid
       JOIN   pg_class parent ON pg_inherits.inhparent = parent.oid
       WHERE  parent.relname = 'completed_events'
         AND  child.relname = $1`,
      [expectedTable]
    );

    expect(rows.length).toBe(1);
  });
});
