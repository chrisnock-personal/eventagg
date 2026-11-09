# Secrets rotation runbook

How to rotate each secret Aggre/Gator uses, and what each rotation breaks
while it's happening. Only `JWT_SECRET` supports a rotation *window* (old and
new both valid at once); the others are an immediate cutover, so plan those
for a quiet moment and update the clients straight after.

| Secret | Where it lives | Window? | Who notices a rotation |
|---|---|---|---|
| `JWT_SECRET` | env var, or the generated `/app/secrets/jwt.key` | **Yes** | Nobody, if you use the window |
| Ingest API key | `organisations.ingest_api_key`, one per org | No | That org's HTTP ingest clients |
| SNMP community | `organisations.snmp_community`, one per org | No | That org's trap senders |
| Webhook secret | `webhooks.secret`, one per webhook | No (see below) | That webhook's receiver |
| `PGPASSWORD` / `POSTGRES_PASSWORD` | env var, or the generated `/app/secrets/pg_app.pass` / `pg_super.pass` | No | Nothing outside the container |
| `ADMIN_PASSWORD` | env var, first boot only | No | Whoever logs in as `admin` |

---

## `JWT_SECRET` (session signing)

By default you don't set it: on first boot `entrypoint.sh` generates a random
key into `/app/secrets/jwt.key` (the `secrets` volume) and reuses it forever
after. An explicit `JWT_SECRET` always wins over that file.

`JWT_SECRET` may hold several comma-separated secrets. New sessions are signed
with the **first**; a session signed with **any** of them is accepted. So:

1. Generate a new value: `openssl rand -hex 32`.
2. Set `JWT_SECRET=<new>,<old>` in `.env` and redeploy (`./sync.sh`). If you
   were on the generated key, `<old>` is the contents of `jwt.key`:
   `podman exec eventagg cat /app/secrets/jwt.key`. The backend logs
   "JWT secret rotation window active" at startup.
3. Wait at least 8 hours (the session TTL). Every session still signed with
   `<old>` has then expired.
4. Set `JWT_SECRET=<new>` and redeploy. `<old>` is no longer accepted.

**Emergency (secret leaked):** skip the window. Set `JWT_SECRET=<new>` (or
delete `jwt.key` and leave `JWT_SECRET` unset, so a fresh one is generated)
and redeploy. Every session is invalidated at once and everyone signs in
again. That's the point: forged sessions die with the real ones.

## Ingest API key (per org)

Superadmin → Organizations → the org → **Regenerate key** (or
`PUT /api/v1/orgs/:id` with `{"regenerateKey": true}`). The old key stops
working immediately, so update that org's ingest clients (`X-API-Key`)
straight after. Other orgs are unaffected.

## SNMP community string (per org)

Superadmin → Organizations → edit the org's community string. Traps still
arriving with the old string no longer resolve to that org: they fall back to
the unscoped routing search, and usually end up unrouted in the SNMP log.
Update the devices' trap community straight after. Community strings must
stay unique across orgs.

## Webhook secret (per webhook)

Edit the webhook in the Webhooks panel (or `PUT /api/v1/webhooks/:id` with a
new `secret`). Deliveries are signed with the new secret from the next event
on (`X-Signature: sha256=...`). Aggre/Gator signs with one secret only, so to
avoid rejected deliveries, make the **receiver** accept both signatures first,
then change the secret here, then remove the old one from the receiver.

## `PGPASSWORD` / `POSTGRES_PASSWORD` (database)

By default you don't set them: `entrypoint.sh` generates both on first boot
into the `secrets` volume. Postgres listens on 127.0.0.1 only and uses
`scram-sha-256`. On every boot the entrypoint applies both passwords to their
roles (the superuser's over the local socket, so it never needs the old one)
and writes `/root/.pgpass`, so `podman exec eventagg psql ...` keeps working.

To rotate: delete the file (`podman exec eventagg rm /app/secrets/pg_app.pass`)
or set the env var in `.env`, then restart the container. There's a brief
outage of a few seconds while it restarts. Nothing outside the container
connects with these passwords; from another machine, use an SSH tunnel
(`ssh -L 5432:127.0.0.1:5432 <host>`) and read the password from the file.

## `ADMIN_PASSWORD` (seeded admin)

Used only when the `admin` user is first created. Unset, a random one-time
password is printed once to the backend log
(`grep "Default admin created" /var/log/supervisor/backend.log`). Either way
the API refuses everything except change-password, `/auth/me` and logout
until the admin changes it. Later boots don't touch it, so a password set in
the UI survives restarts.

**Locked out:** set `ADMIN_PASSWORD_RESET=true` (and optionally
`ADMIN_PASSWORD`) in `.env` and restart. The admin's password is reset (to
`ADMIN_PASSWORD`, or a generated one printed to the log) and must be changed
at the next login. Remove `ADMIN_PASSWORD_RESET` straight after, or every
restart resets it again.

---

## Known limitations

- No rotation window for ingest keys or SNMP communities: each org has
  exactly one active value.
- The audit log records logins and policy changes, not which secret value a
  request used, so you can't confirm from logs that an old value is unused.
- `jwt.key` is **not** included in a database backup (it's in the `secrets`
  volume, not Postgres). Losing it just signs everyone out: see
  [DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md).
