# Tezkar — Factory Management Platform

Private factory management platform.

## Hosting

**Railway is the only supported production hosting platform.** The Web app, API, and PostgreSQL database run in the Railway project. The Next.js Web service proxies same-origin `/api/*` requests to the API over Railway's private network.

See [Railway-only deployment guide](docs/DEPLOYMENT.md) for service settings, environment variables, migrations, and release checks.

## Development

- Node.js: 24.x
- pnpm: 10.12.4
- Install: `pnpm install --no-frozen-lockfile`
- Run both apps: `pnpm dev`
- Verify: `pnpm typecheck && pnpm test && pnpm build`
