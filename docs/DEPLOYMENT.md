# TEZKAR Deployment

## Production topology

- Vercel: `apps/web`
- Render: `apps/api`
- PostgreSQL: managed production PostgreSQL
- Frontend calls the API through `NEXT_PUBLIC_API_URL`
- API allows only the exact frontend origin through `WEB_ORIGIN`

## Vercel

Create a Vercel project from this repository.

- Root Directory: `apps/web`
- Node.js: 24.x
- Build Command: `pnpm build` (or the detected Next.js build)
- Install Command: `pnpm install --no-frozen-lockfile`
- Environment:
  - `NEXT_PUBLIC_API_URL=https://<api-host>`

Do not put `DATABASE_URL`, `SESSION_SECRET`, or any other server secret in `NEXT_PUBLIC_*`.

## Render API

The repository contains `render.yaml`.

Required production variables:

- `NODE_ENV=production`
- `DATABASE_URL=<managed postgres connection string>`
- `WEB_ORIGIN=https://<vercel-domain-or-custom-domain>`
- `SESSION_SECRET=<random value of at least 32 characters>`
- `SESSION_COOKIE_SAMESITE=lax`
- `DB_POOL_MAX=10`

Build:

`pnpm install --no-frozen-lockfile && pnpm --filter @tezkar/api build`

Start:

`pnpm --filter @tezkar/api start`

Before the first production login, run migrations:

`pnpm --filter @tezkar/api migrate`

Then bootstrap the initial admin only if the production database is empty:

`pnpm --filter @tezkar/api bootstrap`

## Cookie topology

Preferred production setup is same-site custom subdomains, for example:

- `https://app.example.com`
- `https://api.example.com`

Keep `SESSION_COOKIE_SAMESITE=lax` in that topology.

If the frontend and API are on genuinely different sites, use `SESSION_COOKIE_SAMESITE=none` and HTTPS. Keep CORS restricted to the exact frontend origin.

## Release checks

1. API `/api/health` reports database `ok`.
2. Login creates the HTTP-only `tezkar_session` cookie.
3. `/api/auth/me` works from the browser.
4. Production creation/approval creates exactly one earnings ledger entry.
5. Payment cannot exceed the current ledger balance.
6. Advance payout creates a debit in the earnings ledger.
7. Warehouse OUT cannot make a location balance negative.
8. Warehouse transfer creates matching OUT/IN movement records.
9. CI passes typecheck and build on Node 24.
