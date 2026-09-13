# Aggre/Gator -Operations Guide

## Duplicate Segment Detection

Two unique indexes protect against duplicate ingestion:

- **Sequence-based** (`in_progress_id, sequence`): prevents the same sequence number appearing twice in a group. This is the primary guard -it catches the common case of a producer retrying a request and the same event being delivered twice.
- **Body-hash-based** (`in_progress_id, body_hash`): catches exact body duplicates regardless of sequence, using `md5(body::text)`.

**Known limitation:** `body_hash` is computed from `body::text` (JSONB cast to text). PostgreSQL does not guarantee stable key ordering when casting JSONB to text, so two semantically identical events with different JSON key insertion orders may produce different hashes and both be stored. In practice this is rare -the sequence index catches the retry case reliably. A future improvement would use `jsonb_build_object` with sorted keys to produce a canonical hash.



The default container runs PostgreSQL without WAL archiving. A crash between checkpoints (default every 5 minutes) loses that window of data.

### Enabling WAL archiving

Add the following to your `docker-compose.override.yml` or Helm values:

```yaml
# Continuous WAL archiving to a local volume or S3
environment:
  POSTGRES_CONF_archive_mode: "on"
  POSTGRES_CONF_archive_command: "cp %p /mnt/wal-archive/%f"
  POSTGRES_CONF_archive_timeout: "60"       # Archive segment at least every 60s
  POSTGRES_CONF_wal_level: "replica"        # Required for archiving
volumes:
  - ./wal-archive:/mnt/wal-archive
```

For S3 archiving, replace `archive_command` with:
```
aws s3 cp %p s3://your-bucket/wal/%f
```

Or use [pgBackRest](https://pgbackrest.org/) for production-grade backup + PITR:
```bash
pgbackrest --stanza=aggre-gator backup
pgbackrest --stanza=aggre-gator --target="2026-05-12 14:30:00" restore
```

### Checkpoint tuning

Reduce data loss window by increasing checkpoint frequency:
```sql
-- In postgresql.conf or via ALTER SYSTEM
ALTER SYSTEM SET checkpoint_timeout = '2min';
ALTER SYSTEM SET max_wal_size = '256MB';
SELECT pg_reload_conf();
```

---

## Async Ingest Queue

The current ingest path is synchronous: HTTP request → transaction → response. Under high volume this creates back-pressure directly on PostgreSQL.

### When to add a queue

Add a queue when any of these are true:
- Ingest rate exceeds ~500 events/s sustained
- P99 ingest latency exceeds 500ms
- You need guaranteed delivery (retry on failure)
- Producers are external and cannot handle back-pressure

### Recommended architecture

```
Producer → POST /ingest → Queue (pg-boss) → Worker → DB transaction
                              ↓
                         Immediate 202 Accepted to producer
```

**[pg-boss](https://github.com/timgit/pg-boss)** is the recommended queue because:
- Uses PostgreSQL as the queue backend (no new infrastructure)
- Supports retries, concurrency control, and dead-letter queues
- Works within the existing container

### Implementation sketch

```typescript
// 1. Install pg-boss
npm install pg-boss

// 2. Initialise in index.ts
import PgBoss from "pg-boss";
const boss = new PgBoss(config.db);
await boss.start();
await boss.work("ingest", { teamSize: 5, teamConcurrency: 5 }, async (job) => {
  await ingestSegment(job.data);
});

// 3. Ingest route becomes async
router.post("/", async (req, res) => {
  const input = ingestSchema.parse(req.body);
  await boss.send("ingest", input, { priority: 1 });
  res.status(202).json({ queued: true });
});
```

### Rate limiting (immediate, no queue needed)

Add `express-rate-limit` to protect the ingest endpoint from runaway producers:

```typescript
import rateLimit from "express-rate-limit";
app.use("/api/v1/events/ingest", rateLimit({
  windowMs: 60_000,    // 1 minute
  max: 10_000,         // 10k requests per minute per IP
  standardHeaders: true,
  message: { error: "Ingest rate limit exceeded -slow down or batch your events" },
}));
```

---

## Partition Management

Partitions are pre-created by the migration and the background job (runs every 24h). The job ensures the current quarter + next 3 quarters always exist.

If you need to manually add a partition:
```sql
CREATE TABLE IF NOT EXISTS completed_events_2029_q1
    PARTITION OF completed_events
    FOR VALUES FROM ('2029-01-01') TO ('2029-04-01');
```

Check existing partitions:
```sql
SELECT child.relname, pg_get_expr(child.relpartbound, child.oid, true) AS bounds
FROM   pg_inherits
JOIN   pg_class child  ON pg_inherits.inhrelid  = child.oid
JOIN   pg_class parent ON pg_inherits.inhparent = parent.oid
WHERE  parent.relname = 'completed_events'
ORDER  BY child.relname;
```

---

## Migrations & Rollback

Migrations run automatically on every container boot (`entrypoint.sh` →
`node dist/db/migrate.js`, before `supervisord` starts). All pending
migrations for that boot are applied inside a **single transaction**
(`db/migrate.ts`): if any one of them throws, the whole batch rolls back and
the schema is left exactly as it was -that's real protection against a
migration failing halfway through, but it's a schema-shape safety net only.
It doesn't help once a migration has committed and only then turns out to be
wrong (a backfill that populated the wrong values, a partition rename that
broke a query nobody tested), and it can't undo any application code that
already ran against the new schema.

There is no `down`/rollback tooling -23 migrations in, several of them
(partition renames, column backfills, data promotions) aren't cleanly
reversible with a mechanical inverse anyway. Rather than maintain
per-migration down-scripts that would mostly go untested, this project's
rollback story is: **take a `pg_dump` backup immediately before deploying any
change that adds a migration, and restore it if the deploy goes wrong.**

### Rollback procedure

1. **Before deploying**, take a backup -either via the UI (Administration →
   Backup, superadmin only) or directly:
   ```bash
   ssh <remote-host> "podman exec eventagg pg_dump -U eventagg_user -d eventagg --clean --if-exists" \
     > pre-deploy-backup-$(date +%Y%m%d-%H%M%S).sql
   ```
2. **Deploy as normal** (`./sync.sh`, which rebuilds and restarts the
   container -`entrypoint.sh` applies any new migrations on that restart).
3. **If something's wrong** -the app misbehaves, a migration corrupted data,
   a query now errors -restore the pre-deploy backup via the UI (Backup panel
   → restore) or:
   ```bash
   cat pre-deploy-backup-*.sql | ssh <remote-host> \
     "podman exec -i eventagg psql -U eventagg_user -d eventagg -v ON_ERROR_STOP=1"
   ```
   This puts the schema *and* data back to exactly the pre-deploy state —
   strictly stronger than a schema-only `down` migration would have given you.
   The tradeoff: any real user data written between the backup and the
   restore is lost, same as any point-in-time restore. For a deploy-time
   rollback (minutes, not hours, between backup and restore) that's normally
   an acceptable cost; it's not a substitute for a real backup/retention
   policy (see WAL archiving above) for disaster recovery.
4. Re-run `podman-compose up -d` if the restore was done against a stopped
   app, or just confirm the app reconnects -the restore doesn't restart the
   container itself.

`sync.sh` prints a reminder to do this before every rebuild; it doesn't
block on it, since not every deploy adds a migration and forcing a backup
on every doc/script-only sync would just get skipped out of habit.

### Convention for writing new migrations

Existing migrations (001–023) aren't being retrofitted, but new ones should
add a one-line reversibility note to their header comment, e.g.:

```sql
-- 024_add_widget_priority.sql
-- Reversibility: trivial -`ALTER TABLE widgets DROP COLUMN priority` fully
-- reverses this if needed; no backfill, no data loss on rollback.
```

```sql
-- 025_backfill_widget_owner.sql
-- Reversibility: none -backfills owner_id from a heuristic that can't be
-- un-derived. Rollback is restore-from-backup only (see OPERATIONS.md).
```

This costs one line per migration and tells the next person (or the next
deploy) whether a schema-level rollback is even possible before they reach
for the backup.

---

## Query Timeout Reference

| Category   | Timeout | Route |
|------------|---------|-------|
| Ingest     | 5s      | POST /events/ingest |
| Read       | 10s     | GET /events, GET /events/:id |
| Stats      | 15s     | GET /events/stats |
| Performance| 15s     | GET /events/performance |
| Background | 30s     | Timeout sweep job |

Adjust in `src/middleware/timeout.ts`.

---

## Stats Cache TTL Reference

| Cache          | TTL  | Invalidated by |
|----------------|------|----------------|
| statsCache     | 60s  | Any successful ingest |
| performanceCache | 30s | Any successful ingest |

Cache entries are also swept automatically at 2× TTL. Adjust in `src/cache.ts`.
