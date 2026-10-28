# Tezkar ERP — System Audit (Initial, 2026-10-28)

## Scope and safety

- Repository: `alomdamohamed652-afk/Tezkar`
- Audit branch: `audit/financial-flow-integrity`
- Starting point: PR #195 head `6aa62f391efc52df178fe847484d3507e2da226d`
- PR: [#195](https://github.com/alomdamohamed652-afk/Tezkar/pull/195), currently open and not merged.
- CI verified for that head: [run #3490](https://github.com/alomdamohamed652-afk/Tezkar/actions/runs/40749665816) — `verify` job succeeded for Install, Typecheck, Tests, and Build.
- No production database was accessed or changed. No reset/truncate/delete operation was run. No PR merge or Railway deployment was performed.
- Railway is the only approved deployment platform. Vercel notifications are not a deployment target for this project.

This is the first evidence-based audit snapshot, focused on the finance workflow in PR #195. It is not yet a claim that every route and module in the repository has been exhaustively audited; subsequent passes should extend the inventory across all application routes and API modules.

## PR #195 — reviewed change surface

The PR changes 13 files:

| Area | File | Responsibility in this change |
|---|---|---|
| API | `apps/api/src/modules/payments/payments.routes.ts` | Worker payment requests, direct settlements, earning availability, historical payment allocation, worker statement |
| API | `apps/api/src/modules/custody/custody.routes.ts` | Cash custody movements and in-kind custody handover/settlement |
| API | `apps/api/src/modules/accounting/accounting.routes.ts` | Expenses, historical order expense correction, accounting periods and profitability reports |
| API | `apps/api/src/modules/production/production.routes.ts` | Production records that generate approved worker earnings |
| API tests | `apps/api/test/payments-api-integration.test.ts` | Isolated PostgreSQL integration coverage for payments and related workflows |
| Web | `apps/web/app/payments/page.tsx` | Worker payment / dues UI and worker statement |
| Web | `apps/web/app/finance/review/page.tsx` | Historical payment-to-production allocation review only |
| Web | `apps/web/app/finance/worker-settlements/page.tsx` | Historical order expense corrections only |
| Web | `apps/web/app/custody/page.tsx` | Cash custody ledger, collections, expenses and transfers |
| Web | `apps/web/app/custody/assets/page.tsx` | In-kind custody, returns, loss/damage and transfers |
| Web | `apps/web/app/accounting/page.tsx` | Accounting expense/revenue and financial reporting UI |
| Web | `apps/web/app/payroll/page.tsx` | Monthly payroll, salary adjustments and payroll payments |
| Web | `apps/web/components/sidebar.tsx` | Navigation and permission-gated links |

## Financial source-of-truth map

| Concept | Canonical records observed in code | Write path / API | Read surfaces observed |
|---|---|---|---|
| Approved production earnings | `production_entries` (especially `earning_amount`, `total_earning_amount`, `status`) | Production routes; worker payment settlement reads these records | Payments page, worker statement, settlement summary, production and accounting reports |
| Cash worker payment | `worker_payments` | `POST /api/worker-payments/direct` or payment-request approval flow | Payments page, worker statement, finance reports |
| Settlement against production | `employee_earnings_settlements`, `employee_earnings_settlement_allocations` | Same transactional worker-payment flow | Payments page and worker statement; historical review can migrate/reconcile existing allocations |
| Legacy production allocation | `worker_payment_allocations`, `worker_payment_order_allocations` | Legacy paths / historical allocation workflow | Historical review, worker statement, settlement eligibility queries |
| Worker earning ledger | `employee_earnings_ledger` | Payment/advance/adjustment workflows | Worker statement and finance period snapshots |
| Advances and repayments | `advance_requests`, `advance_repayments` | Advance and worker-payment flows | Worker statement, payroll/advance UI, finance period snapshots |
| Cash custody | `cash_custody_transactions` | Custody API; direct worker payout creates an OUT movement for physical cash paid | Cash custody page, worker-payment flow, period snapshots |
| In-kind custody | Custody records, settlement records, transfer history (exact schema is maintained by custody migrations) | `/api/custodies` routes | `/custody/assets` |
| Order expenses | `accounting_expenses` | Accounting expense API; historical correction form sets `historicalSettlement=true` | Accounting UI and order profitability reports |
| Order revenue / collections | `order_revenues` plus corresponding cash custody movement where actual cash is collected | Accounting/custody APIs in a transaction | Accounting and cash custody pages |
| Period close snapshots | `accounting_periods`, `accounting_period_close_snapshots`, opening-balance records | Accounting period routes | Finance period reports and later-period opening balances |

### Important boundaries

1. **Worker payout** is the only path here that creates a cash-payment record. It creates the worker payment, a settlement record, earning-ledger debit and (when paid from current custody) one physical cash-custody OUT movement in a database transaction.
2. **Historical review** allocates an existing payment to production/order records. It must not create another cash payment or change cash custody.
3. **Historical order expense correction** writes a historical accounting expense and must not debit a current cash custody a second time.
4. **Cash custody** is physical cash accountability. Advance repayment is an internal offset; the cash OUT amount is the net cash actually paid, not the gross worker entitlement.
5. **In-kind custody** tracks assets and physical returns/loss/damage. A recorded loss/damage does not automatically create a salary deduction or cash movement.
6. **Payroll deductions** are manual payroll adjustments. They must not be silently repeated by accounting or custody workflows.

## Observed UI/API workflow links

- `/payments` — worker payout and worker statement; links to cash custody, finance review, payroll and accounting.
- `/finance/review` — historical payment allocation only; calls `/api/worker-payments/historical-unallocated`, `/api/worker-payments/historical-allocation-orders`, `/api/worker-payments/historical-allocation-stages`, and `POST /api/worker-payments/:id/allocate-historical`.
- `/finance/worker-settlements` — historical order expense correction only; calls `GET /api/accounting/historical-expense-orders` and `POST /api/accounting/expenses` with `historicalSettlement=true`.
- `/custody` — cash custody and cash movements.
- `/custody/assets` — in-kind custody. The UI explicitly states that it is separate from cash custody and worker dues.
- `/payroll` — salary run and manual salary adjustments; not a substitute for worker production dues.
- `/accounting` — expense/revenue and profitability source surfaces.

## Findings and priorities

### P1 — summary field does not use the same production earning definition

**Fixed on this audit branch:** `GET /api/worker-payments/settlement-summary` now sums `COALESCE(total_earning_amount, earning_amount)`, consistent with available-earnings and unpaid-production calculations. Added an integration regression assertion using a production record with base earnings 100, bonus 50, deduction 20, and expected total earnings 130. CI validation for this branch is still pending.

### P1 — shift-leader cost visibility guard was not applied consistently

The warehouse API defines `canViewWarehouseCosts(userId, roleCodes)` to suppress cost fields for the `shift_leader` role. The stock endpoint passed the role codes, but the lots and movements endpoints called the helper without them; because the parameter defaulted to an empty array, a shift leader who also had the dashboard permission could receive unit-cost/total-cost fields or order references. The warehouse dashboard also returned aggregate inventory value without a role-level denial.

**Fixed on this audit branch:** pass the authenticated role codes to the lots and movements cost filter, and explicitly deny the warehouse financial dashboard to shift leaders. The warehouse integration test now deliberately grants the shift-leader role both `warehouse.view` and `warehouse.dashboard`, proving the role-level restriction still blocks disclosure even if a financial permission is misassigned. This protects the API response itself, not just the UI. CI for the latest changes is running.

### P1 — keep selected settlement amounts server-enforced

The direct payout endpoint currently validates selected production IDs and compares the submitted amount with the sum of the selected remaining balances before writing. Keep this server-side validation as a mandatory invariant; the client-side disabled button is not a security or accounting control. Add regression coverage for amount mismatch, invalid/settled records, and rollback of all related financial records when validation fails.

### P1 — historical allocation must remain cash-neutral

The historical allocation path is designed to mirror or allocate an existing payment without inserting a second payment. Preserve the transaction, period-lock, employee lock, source-link validation and audit record. Regression tests should assert the cash-payment count and custody balance remain unchanged after allocation.

### P2 — screen responsibility is improved but should be monitored

The current navigation separates cash custody, in-kind custody, historical expense correction, historical payment allocation and worker payout. Preserve those distinct responsibilities and avoid reintroducing a combined form that creates ambiguous or duplicated transactions.

### P2 — presentation cleanup

**Fixed on this audit branch:** renamed the transfer-history heading to “سجل التحويلات”; no custody calculations or API behavior changed.

## Required validation for finance changes

- Typecheck and production build.
- API integration tests using a disposable local PostgreSQL database only.
- Assert payment, settlement, allocation, ledger and cash-custody records before and after each operation.
- Assert a failed operation rolls back all writes.
- Assert a replay with the same idempotency key does not create a second payment or cash movement.
- Assert historical allocation changes allocation links only, not cash or payment totals.
- Assert closed-period protections and API permission checks.
- Never test by mutating the production database.

## API module registry observed in `apps/api/src/main.ts`

The current API bootstrap registers the following route modules. This is a registration inventory, not a substitute for reviewing every handler and permission:

| Module / routes file | Domain to audit next |
|---|---|
| `health/health.routes.ts` | Health/readiness |
| `auth/auth.routes.ts`, `registration.routes.ts`, `password-reset.routes.ts`, `account.routes.ts` | Login, registration, password recovery, profile/session management |
| `employees/employees.routes.ts` | Employee master data |
| `attendance/attendance.routes.ts` | Attendance and fingerprint imports |
| `master-data/master-data.routes.ts` | Catalog/master data |
| `users/users.routes.ts` | Users, roles and access |
| `operations-master/operations-master.routes.ts` | Shifts, rates and production setup |
| `production/production.routes.ts`, `machine-production.routes.ts`, `production-scrap.routes.ts` | Worker/machine production, cancellation and scrap |
| `payments/payments.routes.ts`, `earnings/earnings.routes.ts` | Worker payout, dues and earning ledger |
| `warehouse/warehouse.routes.ts`, `shift-withdrawals.routes.ts`, `cartons-deliveries.routes.ts`, `receipts.routes.ts` | Stock, withdrawals, carton deliveries and receiving |
| `advances/advances.routes.ts` | Advance requests and repayment lifecycle |
| `dashboard/dashboard.routes.ts` | Summary metrics |
| `reports/reports.routes.ts` | Reporting/export |
| `orders/orders.routes.ts` | Orders, stages and customer/product relationships |
| `custody/custody.routes.ts` | Cash and in-kind custody workflows |
| `coding/coding.routes.ts` | Coding/design workflow |
| `accounting/accounting.routes.ts` | Expenses, revenue, profitability and period close |
| `tasks/tasks.routes.ts` | Tasks and due dates |
| `payroll/payroll.routes.ts` | Salaries, payroll periods and payments |
| `search/global-search.routes.ts` | Cross-module search |
| `notifications/notifications.routes.ts` | Notifications |
| `system-reset/system-reset.routes.ts` | Guarded system reset workflow; never run during this audit |

The bootstrap also has a global response hook that writes request audit records for mutations and selected sensitive reads, plus module-level audit calls for important financial actions. Follow-up work should check that important mutations retain both correct business audit context and appropriate failure visibility, without treating a generic request log as a substitute for transaction-level audit evidence.

## Remaining audit work

- Enumerate every route under `apps/web/app` and every API module under `apps/api/src/modules`, including actual permissions, reads/writes and links.
- Trace inventory/warehouse, machine production, worker production, scrap, delivery, attendance, payroll, notifications, exports and settings through their source tables and APIs.
- Search for duplicate balance formulas and legacy tables/endpoints, then verify each usage before proposing removal.
- Review migration ordering and old-data compatibility for all schema touched by finance workflows.
- Record each issue, owner/priority, exact files changed and tests run in follow-up commits to this audit branch.
