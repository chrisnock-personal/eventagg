# Disaster recovery runbook

How to get Aggre/Gator back after losing data or the host. For rolling back a
bad *deploy* (a migration that went wrong), see
[OPERATIONS.md § Migrations & Rollback](./OPERATIONS.md#migrations--rollback).
That's the same restore, done deliberately.

## What there is to lose

| What | Where | Backed up by |
|---|---|---|
| Everything in Postgres: orgs, users, policies, event groups, audit log, webhooks, SNMP config, system config (SMTP) | `pgdata` volume | A `pg_dump` backup (below) |
| Data encryption key (`data.key`) | `secrets` volume | **You** (copy it once, below). Without it, the webhook secrets and SMTP password in a restored database can't be decrypted and must be re-entered |
| Session signing key (`jwt.key`), generated DB passwords | `secrets` volume | Nothing needed. Losing them signs everyone out; the DB passwords are regenerated and re-applied at boot |
| HTTPS certificate | `certs` volume | You, if it's an uploaded one (you have the files). A self-signed one is just regenerated |
| `.env` (passwords, explicit secrets) | Host, next to `docker-compose.yml` | **You.** Keep a copy somewhere safe |

## Taking a backup

**From the UI:** Backup → Download (the superadmin, or the admin before
multi-tenancy is on).

**Encrypt it.** Set `BACKUP_AGE_RECIPIENTS` to one or more
[age](https://age-encryption.org) public keys and every backup comes out as
`eventagg-<date>.sql.age`, readable only with the matching private key.
Generate that key on a machine that is *not* this server and keep it there
(and in your password manager):

```bash
age-keygen -o eventagg-backup.key      # prints "Public key: age1..."
# .env on the server:  BACKUP_AGE_RECIPIENTS=age1...
# To restore: decrypt first, then restore the .sql as below
age -d -i eventagg-backup.key eventagg-2026-11-09.sql.age > eventagg-2026-11-09.sql
```

**Copy `data.key` once** (it doesn't change unless you rotate it), and keep
it apart from the backups:

```bash
podman exec eventagg cat /app/secrets/data.key
```

On a new host, put it back before restoring (or set `DATA_ENCRYPTION_KEY`
to it in `.env`): `podman exec -i eventagg sh -c 'cat > /app/secrets/data.key' < data.key`, then restart.

**From the host (scriptable, e.g. a nightly cron):**

```bash
podman exec -e PGOPTIONS='-c app.bypass_rls=true' eventagg \
  pg_dump --enable-row-security \
          -h 127.0.0.1 -U eventagg_user -d eventagg \
  | age -r age1... > eventagg-$(date +%F).sql.age     # or "> ....sql" unencrypted
```

`PGOPTIONS` and `--enable-row-security` matter. `policies`, `users` and
`audit_log` are under `FORCE ROW LEVEL SECURITY`, so a plain `pg_dump` either
refuses those tables or (with row security on but no bypass) dumps them
empty. The Backup panel does the same thing internally.

Check that a backup is real before you need it: it should be more than a few
KB, and `grep -c '^COPY public.policies' eventagg-*.sql` should print `1`.

---

## Scenario A: restore onto a running stack

Data is wrong or lost, and the container and host are fine.

1. Superadmin → Backup → Restore, and pick the `.sql` file. Or from the host:
   ```bash
   podman exec -i -e PGOPTIONS='-c app.bypass_rls=true' eventagg \
     psql -1 -v ON_ERROR_STOP=1 -h 127.0.0.1 -U eventagg_user -d eventagg \
       -c 'DROP SCHEMA IF EXISTS public CASCADE' -c 'CREATE SCHEMA public' \
       -f - < eventagg-2026-11-01.sql
   ```
   This is what the Restore button runs. Emptying the schema first is
   needed: a dump's own per-object DROPs (older `--clean` backups) fail on
   the partitioned `completed_events` table. `-1` makes it all one
   transaction, so a failed restore changes nothing.
2. The restore replaces every table, so everything written since the backup
   is gone.
3. Run the [post-restore checklist](#post-restore-checklist).

A restore fails part-way (and stops, thanks to `ON_ERROR_STOP`) if the dump
came from an *older* schema than the running app. In that case restore onto
a stack built from the commit the backup was taken on, then upgrade.

## Scenario B: full host loss

1. Build a new host with Podman and `podman-compose`.
2. Clone the repo and check out the commit you were running (or a newer one;
   see the schema note above).
3. Put your saved `.env` back next to `docker-compose.yml`.
4. `podman-compose up -d --build`. The entrypoint creates an empty database,
   runs migrations and seeds the `admin` user.
5. Log in as `admin` (`ADMIN_PASSWORD`, or the generated password from
   `podman exec eventagg grep "Default admin created" /var/log/supervisor/backend.log`)
   and restore the backup
   (Scenario A). The users, orgs and passwords come back from the dump.
6. Unless `JWT_SECRET` is in your `.env`, a new `jwt.key` was generated:
   everyone signs in again. Expected.
7. Point clients at the new host if its address changed: HTTP ingest
   clients, SNMP trap senders (UDP `1162`), webhook receivers' allow-lists.
8. Run the [post-restore checklist](#post-restore-checklist).

## Scenario C: point-in-time restore

Only possible if you enabled WAL archiving beforehand
([OPERATIONS.md § Enabling WAL archiving](./OPERATIONS.md#enabling-wal-archiving)).
The default container doesn't archive WAL, so without it the best you can do
is the most recent `pg_dump` (Scenario A/B).

With WAL archiving: stop the container, restore a base backup into the
`pgdata` volume, add `restore_command` and `recovery_target_time` to
`postgresql.conf`, create `recovery.signal` in the data directory, and start
the container. Postgres replays WAL up to the target time. This is standard
Postgres PITR; follow the
[Postgres docs](https://www.postgresql.org/docs/16/continuous-archiving.html#BACKUP-PITR-RECOVERY).

---

## Post-restore checklist

- [ ] `curl -s http://<host>:8080/health` returns ok (the backend's own `:3001` is loopback-only).
- [ ] Webhooks still sign deliveries and the SMTP test passes. If they fail
      with "unknown data key", this host doesn't have the `data.key` the
      database was written with: restore it (below) or re-enter the
      secrets.
- [ ] You can log in, and the Organizations panel lists every org.
- [ ] Policies list per org looks right (spot-check one org as its own admin,
      not just as superadmin: that exercises row-level security).
- [ ] Send a test event (`node scripts/ingest.js` or the Ingest modal) and see
      a group open.
- [ ] Send a test trap (`node scripts/send-trap.js --host <host> --port 1162 ...`)
      and see it in the SNMP log for the right org.
- [ ] Webhooks panel: trigger a test delivery, and check the receiver accepts
      the signature.
- [ ] Settings → SMTP: send a test email.
- [ ] Take a fresh backup. The restored instance is now the baseline.

## Known limitations

- The UI backup has a 2-minute `pg_dump` timeout. A large database should be
  backed up from the host command above instead.
- Backups are only as fresh as the last one you took: nothing schedules them.
  Use the host command in a cron job on the host.
- No backup of the `secrets` volume. Not needed: losing `jwt.key` only signs
  everyone out.
