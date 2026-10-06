# Tezkar — Foundation v0.3

## Current branch

`foundation/v0.3`

## Foundation decisions

- Private web platform / PWA.
- Arabic-first RTL UI.
- PostgreSQL is the system of record.
- SQL-first database access; Excel is not the primary database.
- Backend and frontend are separated under `apps/api` and `apps/web`.
- Authenticated users are separate from employees and may be linked one-to-one.
- Current authenticated user is the audit actor automatically.
- Financial, payroll, production and inventory changes will use transactional business commands.
- Historical/financial records are append-only or corrected by reversal rather than destructive edits.
- Permission checks will be enforced server-side; UI visibility is not a security boundary.
- Audit logging is a first-class platform concern.

## First implementation slice

1. Repository/workspace foundation.
2. PostgreSQL connection and migration runner.
3. Authentication/session foundation.
4. Users, employees, departments, job titles.
5. Roles, permissions and scope evaluation.
6. Audit infrastructure.
7. Then expand into production, rates, inventory lots, purchasing, finance, coding station, labels and reporting.

## Not implemented yet

The foundation intentionally does not pretend that the complete ERP is finished. Business modules are added incrementally against the approved specification and its unresolved decisions.
