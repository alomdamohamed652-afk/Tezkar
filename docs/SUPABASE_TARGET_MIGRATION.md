# Supabase target schema preparation

This procedure prepares the **empty Supabase target** for a later data-transfer rehearsal. It does not migrate application data and must never be run against the Railway source.

## Required server-side variables

- `DATABASE_URL`: the existing Railway source connection. The preflight opens it only inside a PostgreSQL `READ ONLY` transaction to compare database identity.
- `TARGET_DATABASE_URL`: the intended Supabase target connection.
- Keep both values server-side. Never expose them in browser variables, logs, screenshots, or source control.

## Preview first

From `apps/api`, run:

```bash
pnpm migrate:target
```

The command refuses to continue unless it can verify that:

1. Both connection strings are present; the target URL must expose a Supabase project reference, and the source and target must not resolve to the same Supabase project. Direct and Pooler URLs for the same project are treated as identical. A PostgreSQL server/database identity comparison is also performed.
2. The target has Supabase markers (`auth`, `storage`, and `supabase_admin`).
3. The target role is not default-read-only.
4. The target `public` schema contains no relations, routines, types, operators, or collations; the check fails closed on any such application object.

Preview mode performs read-only identity/schema checks only. It does not run migrations. The project reference is extracted from the standard Supabase Direct hostname (`db.<project-ref>.supabase.co`) or Pooler username (`<role>.<project-ref>`); unsupported target URL formats fail closed.

## Explicit schema creation

Only after reviewing the migration chain, confirming a recoverable target, and approving the change window, run:

```bash
CONFIRM_TARGET_SCHEMA_MIGRATIONS=YES pnpm migrate:target -- --apply
```

The wrapper passes `TARGET_DATABASE_URL` to the existing migration runner in a child process. The source `DATABASE_URL` is never used by that runner. The wrapper intentionally refuses non-empty or partially initialized `public` schemas; do not bypass this guard to resume a partial run without reviewing the exact applied migration state.

## Important migration review notes

- The migration runner sorts files by their leading numeric prefix, then filename. Several prefixes are shared; their lexical order is therefore part of the effective execution order.
- The chain includes seed inserts for roles, permissions, master data, coding packaging types, templates, and production types. These are schema/bootstrap defaults, not copied Railway business records.
- The chain also includes data-oriented statements, including updates/backfills and narrowly scoped permission deletes. They are expected to operate on an empty target during initial schema preparation, but each must be reviewed before execution.
- Notable examples found during review: the worker permission cleanup in `023_worker_ui_permissions.sql` and `026_operational_finance_custody.sql`; the stock-balance-to-inventory-lot backfill in `1005_inventory_lots_rls_and_legacy_backfill.sql`; the payroll `net_amount` column replacement in `1015_advance_repayment_integration.sql`; and historical linkage updates plus an index replacement in `2026110607_financial_reversals.sql`.
- The application migration chain enables RLS on application tables. The Fastify API connects directly to PostgreSQL; do not assume the Supabase Data API should have direct table access.
- Supabase-managed schemas, roles, default privileges, and platform extensions are not to be copied from Railway or overwritten.
- Sequence `last_value/is_called` values are not validated by the schema comparison. They must be reconciled against imported IDs before enabling application writes after any later data transfer.

## After schema creation

1. Re-run the read-only schema inspection from the TEZKAR settings page.
2. Resolve all remaining table, column, key, routine, trigger, extension, and permission differences.
3. Verify sequence definitions and later sequence state separately.
4. Rehearse data transfer into a disposable target before considering production cutover.

This procedure does not authorize data transfer, application cutover, or any change to the Railway source. Those require separate approval.
