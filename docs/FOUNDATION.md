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

## Implemented in v0.3 on this branch

- Production entries with rate snapshots, approval/rejection/cancellation and earnings ledger posting.
- Worker payment requests with balance protection and transactional payment posting.
- Configurable payment methods.
- Employee earnings ledger and worker/management views.
- Warehouse master data, stock balances, stock movement ledger and transfers.
- Carton records and delivery permissions with scan-before-exit release.
- Employee advances linked to the earnings ledger.
- Live operational dashboard with role-protected metrics.
- Production deployment configuration for Node 24, Vercel frontend and Render API.
- Baseline security headers, credentialed CORS policy, session cookie configuration, expired-session cleanup and login throttling.
- GitHub Actions CI definition for Node 24 typecheck/build.

## Still not implemented

The complete ERP is intentionally not claimed as finished. The next business slices still need to be implemented against the approved specification and unresolved decisions:

1. Purchasing and supplier cycle.
2. Sales/orders and order lines.
3. Full accounting/finance ledger and expense workflows.
4. Employee profile editing, attendance/deductions/bonuses and full payroll statements.
5. Warehouse advanced barcode/QR printing, carton split/merge rules, returns and richer delivery documents.
6. Reporting/export/Excel mirror and printable operational reports.
7. Full audit-log UI and administration workflows.
8. Comprehensive automated tests, including database migration tests and RBAC matrix tests.

Business rules for accounting, purchasing, and order costing should be confirmed before implementing them rather than invented in code.
