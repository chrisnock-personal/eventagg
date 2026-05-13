# Aggre/Gator — Operations Guide

## WAL Archiving

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
  message: { error: "Ingest rate limit exceeded — slow down or batch your events" },
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
