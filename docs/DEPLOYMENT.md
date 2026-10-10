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
- Install command: `corepack enable && corepack prepare pnpm@10.12.4 --activate && pnpm install --no-frozen-lockfile`
- Build command: `pnpm --filter @tezkar/web build`
- Start command: `pnpm --filter @tezkar/web start`
- Set `API_PROXY_TARGET` at build time to the API service's private Railway address, for example `http://<api-private-domain>:4000`.
- Do not set `NEXT_PUBLIC_API_URL`; production uses the Web service's same-origin `/api/*` proxy.

### API service

- Root directory: repository root
- Node.js: 24.x
- Install command: `corepack enable && corepack prepare pnpm@10.12.4 --activate && pnpm install --no-frozen-lockfile`
- Build command: `pnpm --filter @tezkar/api build`
- Start command: `pnpm --filter @tezkar/api start`
- Health check path: `/api/health`
- Set `API_PORT=4000` so the API listens on the same port used by the private proxy target.
- Set `WEB_ORIGIN` to the exact public origin of the Railway Web service, including `https://` and without a trailing slash.
- Set `DATABASE_URL` using the Railway PostgreSQL connection string.
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
