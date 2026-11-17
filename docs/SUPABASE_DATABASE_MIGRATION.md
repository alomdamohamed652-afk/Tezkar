# Supabase PostgreSQL migration plan (Railway Web/API stay in place)

## Target architecture

- Keep the Next.js Web service on Railway.
- Keep the Fastify API service on Railway.
- Move only PostgreSQL to a Supabase Free project initially.
- Configure the API's `DATABASE_URL` in Railway to the Supabase PostgreSQL connection string. Never put database credentials in GitHub, frontend variables, logs, or this document.
- The browser must continue calling the Railway API. It must never connect directly to Supabase.

## Free-tier constraints to plan around

Verify the live Supabase dashboard before migration. The Free plan currently lists a 500 MB database quota, 5 GB uncached egress plus 5 GB cached egress, 500 MB shared compute memory, no automatic database backups, and automatic pausing after a week of low activity. Treat the 500 MB as a hard ceiling, not a target. Aim to stay below 350 MB and alert at 70%, 80%, and 90%.

## Connection mode

Railway API is a persistent Node.js server with a `pg.Pool`. Prefer Supabase's Shared Pooler in **Session mode** if Railway networking is IPv4-only. Direct connections require IPv6 unless the project has IPv4 support enabled. Use the exact connection string shown by Supabase's Connect panel; do not manually construct the host or credentials.

Keep the application pool modest. Initial suggested Railway API variable:
- `DB_POOL_MAX=5`
- `DB_IDLE_TIMEOUT_MS=10000`
- `DB_CONNECTION_TIMEOUT_MS=10000`

Only set `DB_STATEMENT_TIMEOUT_MS` after testing the longest legitimate reports and operations. The code supports it as an optional per-connection PostgreSQL statement timeout.

## Required migration sequence

1. Create the Supabase project and record its region, project reference, and current quota. Do not copy production data yet.
2. Obtain the Supabase connection string from the Connect panel. Prefer Session Pooler for IPv4 compatibility if needed.
3. Provision a separate, isolated target database/project for rehearsals if possible. Never rehearse restore against the live Tezkar database.
4. From a trusted environment, take a fresh PostgreSQL logical dump from the current source. Keep it encrypted and off-repository.
5. Restore into the isolated Supabase target using PostgreSQL-native tooling, then run the repository's existing migrations against that isolated target. Confirm migration versions and schema.
6. Validate row counts and critical aggregates for employees, users, orders, production, payments, advances, custody, settlements, ledger, and audit records. Compare financial totals using read-only queries; do not change formulas or data.
7. Test login, permissions, production reads/writes, settlement workflows, reports, and concurrent API requests from Railway against the isolated target.
8. Measure database size, query latency, connection usage, and egress during a representative workload.
9. Before cutover, schedule a short write freeze. Take a final source dump, restore it to Supabase, validate again, then change only Railway API `DATABASE_URL`. Restart API and verify health and critical workflows.
10. Keep the original database intact and read-only during a rollback window. If checks fail, restore the previous Railway `DATABASE_URL`; do not attempt an improvised reverse data sync.
11. Only decommission the old database after explicit approval and a verified independent backup.

## Logs and retention

Do not delete or truncate all logs on a calendar schedule without checking their purpose and foreign-key dependencies. First classify log tables:
- Operational/audit logs needed for accountability or financial traceability: retain according to business/legal requirements and archive before pruning.
- High-volume diagnostic/request logs: apply a documented retention window (for example 30–90 days) only after confirming they are not used by reports, dispute investigations, or foreign keys.
- Never prune ledger entries, payment records, settlement history, production records, or audit evidence merely to fit the free quota.

Run monthly size reports and alert before the database approaches the limit. Deleting rows may not immediately return disk space to the operating system; PostgreSQL vacuum behavior and indexes must be considered. Keep the full encrypted backup outside Supabase before any cleanup.

## Operational safeguards

- Supabase Free does not provide automatic daily database backups. Maintain scheduled encrypted off-site PostgreSQL dumps and test restores.
- Free projects may pause after a week of low database activity; verify whether the project's usage pattern is enough to avoid pausing.
- Monitor database size, egress, CPU/memory, active connections, slow queries, and API errors.
- Keep all secrets in Railway Variables. Rotate the database password if it is exposed.
- No production cutover, migration, cleanup, or destructive SQL is authorized by this plan. Perform the cutover only after a separate explicit approval.

## Current application compatibility

The API already reads its PostgreSQL connection from `DATABASE_URL`; Web continues to talk to API and needs no direct database connection. The API pool now supports configurable connection limits/timeouts and optional statement timeout. This is preparation only: no database endpoint or production data was changed.
