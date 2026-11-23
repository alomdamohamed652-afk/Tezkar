# TEZKAR Deployment — Railway Only

## Production topology

All production services run on Railway:

- **Web:** Next.js app from `apps/web`
- **API:** Fastify app from `apps/api`
- **Database:** Railway PostgreSQL
- **Browser-to-API traffic:** same-origin `/api/*` requests proxied by Next.js to the API over Railway's private network

Do not configure a separate frontend hosting provider. The repository's supported production deployment target is Railway.

## Railway service setup

Create or use three services in the same Railway project and production environment:

### Web service

- Root directory: repository root (the monorepo uses the root pnpm workspace)
- Node.js: 24.x
- Install command: `corepack enable && corepack prepare pnpm@10.12.4 --activate && pnpm install --frozen-lockfile`
- Build command: `pnpm --filter @tezkar/web build`
- Start command: `pnpm --filter @tezkar/web start`
- Set `API_PROXY_TARGET` at build time to the API service's private Railway address, for example `http://<api-private-domain>:4000`.
- Do not set `NEXT_PUBLIC_API_URL`; production uses the Web service's same-origin `/api/*` proxy.

### API service

- Root directory: repository root
- Node.js: 24.x
- Install command: `corepack enable && corepack prepare pnpm@10.12.4 --activate && pnpm install --frozen-lockfile`
- Build command: `pnpm --filter @tezkar/api build`
- Start command: `pnpm --filter @tezkar/api start`
- Health check path: `/api/health`
- Set `API_PORT=4000` so the API listens on the same port used by the private proxy target.
- Set `WEB_ORIGIN` to the exact public origin of the Railway Web service, including `https://` and without a trailing slash.
- Set `DATABASE_URL` using the Railway PostgreSQL connection string (the existing/source database; inspection enforces read-only sessions).
- Optionally set `TARGET_DATABASE_URL` to the separate Supabase target database when enabling the in-app inspection screen. Keep it server-side only. The inspection feature refuses to run if it cannot prove source and target are distinct; it does not write to either database.
- Set `SESSION_SECRET` to a random secret of at least 32 characters.
- Set `SESSION_COOKIE_SAMESITE=lax` and `DB_POOL_MAX=10`.

Keep database credentials and session secrets only in Railway server-side service variables. Never expose them through `NEXT_PUBLIC_*` variables.

### PostgreSQL service

Use the PostgreSQL service and persistent storage managed by Railway. Attach the API's `DATABASE_URL` to the correct Railway database. Do not point production to a local database or a separate hosting provider.

## Database release procedure

Before deploying a release that contains database migrations:

1. Confirm the target Railway environment and PostgreSQL service.
2. Review the migration files and confirm they are additive/backward-compatible where required.
3. Run `pnpm --filter @tezkar/api migrate` against the intended Railway environment.
4. Verify the migration command completed successfully and the API health check reports database `ok`.
5. Run the release checks below before treating the release as complete.

Run `pnpm --filter @tezkar/api bootstrap` only when the production database is empty and the initial administrator has not already been created. Never rerun bootstrap against an established production database as a routine deployment step.

## Release checks

1. API `/api/health` reports database `ok`.
2. Login creates the HTTP-only `tezkar_session` cookie.
3. `/api/auth/me` works from the browser through the Web service's `/api/*` path.
4. Production creation/approval creates exactly one earnings ledger entry.
5. Payment cannot exceed the current ledger balance.
6. Advance payout creates a debit in the earnings ledger.
7. Warehouse OUT cannot make a location balance negative.
8. Warehouse transfer creates matching OUT/IN movement records.
9. Finance collection retries with the same idempotency key do not create duplicate revenue.
10. Accounting allocation totals exactly match the expenses to the cent.
11. GitHub CI passes typecheck, tests, and build on Node 24.

## PostgreSQL backup and restore

This procedure creates and verifies a logical backup. It does not run automatically and must not be pointed at a production restore target as a test.

### Create a backup

1. Confirm that `DATABASE_URL` points to the intended Railway PostgreSQL source and that the backup destination has sufficient disk space.
2. Use a trusted machine with a PostgreSQL client version compatible with the server's major version. Do not paste connection strings into tickets, chat, screenshots, or committed files.
3. Run:

```bash
umask 077
export DATABASE_URL='postgresql://...'
BACKUP_FILE="tezkar-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner --no-acl --file="$BACKUP_FILE" "$DATABASE_URL"
pg_restore --list "$BACKUP_FILE" >/dev/null
sha256sum "$BACKUP_FILE" > "$BACKUP_FILE.sha256"
```

4. Copy the dump and checksum to access-controlled storage separate from the database host. Confirm the copied file's checksum matches. Keep credentials out of shell scripts and source control.
5. Record the backup timestamp, source environment, PostgreSQL major version, file size, and checksum in the operational backup log. A successful `pg_dump` is not proof of a tested restore.

### Test a restore safely

1. Provision a separate, empty disposable PostgreSQL database. Never use the live production database as a restore test target.
2. Set `RESTORE_DATABASE_URL` to that disposable database and verify its host, database name, and environment before continuing.
3. Restore and stop on the first error:

```bash
export RESTORE_DATABASE_URL='postgresql://...'
pg_restore --exit-on-error --no-owner --no-acl --dbname="$RESTORE_DATABASE_URL" "$BACKUP_FILE"
```

4. Run application migrations only if the test is explicitly intended to validate a post-migration restore; otherwise inspect the restored schema and data as captured by the dump.
5. Verify critical table counts, representative records, constraints, indexes, and application read-only health checks against the disposable database. Do not use production credentials for this test.
6. Record the restore result and elapsed time. Remove the disposable database only after the verification is complete and its owner approves cleanup.

### Scope and operational limits

- A custom-format `pg_dump` backs up one database's objects and data; it does not back up cluster-wide roles or other databases. This procedure uses `--no-owner --no-acl`, so ownership and grants must be provisioned separately during a controlled recovery.
- Large Objects are included by default in a full `pg_dump`; do not use `--no-blobs`.
- Keep at least one backup in storage independent of Railway. Restrict access and retention according to the sensitivity of worker, production, payment, and accounting data.
- Set an explicit backup cadence and retention policy for the business. No schedule is configured by this document.
- Never run a restore, migration, or destructive cleanup against production without a separately approved change window and a verified recovery point.
