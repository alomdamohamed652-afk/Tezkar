# Tezkar System Integration & Redundancy Audit

**Status:** Initial static review of repository code and route wiring. This is a verified findings register, not a claim that every screen has passed browser acceptance testing. No production data, migrations, or deployment were changed by this audit.

## Goals

- Give each business action one clear home.
- Keep one authoritative calculation/source of truth per business concept.
- Connect the lifecycle across modules instead of creating parallel records.
- Remove or redirect dead/duplicate screens only after confirming permissions, external links, and feature parity.
- Preserve audit history and historical records; prefer archival or redirects over destructive deletion.

## Initial findings

### 1. Worker payments have overlapping entry points — consolidation candidate

Current routes:
- **/payments** — payment requests and approvals, direct current-custody settlement, historical allocation review, unpaid production selection, employee statements, order summaries, and payment history.
- **/finance/worker-settlements** — prior-custody settlements and prior-custody expenses.
- **/earnings/direct-pay** — standalone direct payout form using the same **/api/worker-payments/direct** endpoint; no sidebar entry or internal link was found in the reviewed frontend code.

These are not fully interchangeable: current-custody payouts, previous-custody accounting, and employee requests have different controls. However, three entry points make the workflow difficult to understand.

**Proposed target**
- Keep **/payments** as the home for employee requests, approval, current-custody payout, historical payment reconciliation, and employee payment statements.
- Keep **/finance/worker-settlements** for previous/off-system custody settlements and their linked accounting expenses.
- **Action in PR #197:** preserve **/earnings/direct-pay** as a compatibility route that redirects users with payout permission to **/payments**. The old route is not deleted, so existing bookmarks continue to resolve; the underlying API and payment records remain unchanged. PR #197 also exposes the unified page in navigation for payout-only roles and separates request-view permissions from payout access.

**Required acceptance tests:** same employee balance in all views; no duplicate payout across entry points; cash custody reflects only physical cash; historical allocation never creates a second payment; idempotent retries do not duplicate accounting/custody entries.

### 2. Earnings calculations need a shared reconciliation contract

The payout path calculates available production earnings from approved production entries, non-production employee earnings adjustments, settlements, and legacy payments. The **/earnings** views read the employee earnings ledger.

These are useful ledgers for different purposes, but they can drift if a production approval, adjustment, legacy payment, or settlement fails to create/link its matching ledger row.

**Action:** define one shared earnings calculation/service contract and add a reconciliation report/test that compares:
- approved production earnings (including production bonus/deduction totals),
- non-production bonuses/deductions,
- canonical settlement allocations and gross settlement totals,
- legacy payment allocations,
- employee earnings ledger entries,
- outstanding available balance.

Do not blindly replace either source or backfill production data until differences are measured and classified.

### 3. Production scrap and scrap warehouse are separate lifecycle steps

- **/production/scrap** records scrap against production.
- **/warehouse/scrap** shows movements in the scrap warehouse.

These should not be merged into one CRUD page: production scrap capture and physical scrap-store movement are distinct. They should share a stable scrap reference/source, preserve quantity and reason snapshots, and make it easy to navigate from a production scrap record to its warehouse movement. Reconciliation must identify scrap recorded but not moved to the scrap warehouse, and warehouse scrap without a valid source.

### 4. Worker production and machine production are separate processes

- **/production** is worker production and has worker wage/production implications.
- **/machine-production** records machine runs, design versions, cycles, operators, good quantity, and scrap.

They are not duplicates. Keep separate data entry, but align common concepts (date, shift, order/stage, product/design, good quantity, scrap, cancellation, and audit history). Machine output into general stock must remain quantity-only where specified; it must not invent inventory value. Worker wages must be based on good production according to the configured wage policy.

### 5. Payroll and production earnings must remain clearly distinguished

- **/payroll** handles salary profiles, monthly payroll, payroll adjustments, and payroll payments.
- **/earnings** handles production earnings, production bonus/deductions, and the earnings ledger.

These are related employee finances but not the same entitlement. Avoid adding the same bonus/deduction to both systems unless there is an explicit, traceable transfer rule. Employee-facing balances should label salary due, production due, advances, and actual paid amounts separately.

### 6. Personal account vs accounting is not a duplicate

- **/account** is the user's account/profile.
- **/accounting** is business accounting and profitability.

Keep both. The sidebar wording and active navigation should make this distinction clear.

### 7. Migration filenames need a forward-only convention

The migration runner sorts by numeric prefix and then filename, and stores the full filename in schema_migrations. Multiple files share numeric prefixes, so the runner has a deterministic tie-breaker, but the naming scheme is hard to audit.

**Action:** do not rename or reorder already-applied migration files. That can make existing installations treat renamed files as new migrations. For new migrations, use a single monotonic timestamp or unique sequence plus descriptive name, and test the full migration chain on a disposable PostgreSQL database.

### 8. Frontend QA checklist is not evidence of completed QA

**docs/FRONTEND-ALL-PAGES-AUDIT.md** lists the route-by-route acceptance checks, but its checklist remains unchecked in the reviewed file. Treat page-level responsive/accessibility/permission QA as pending until each route has evidence.

### 9. Feature PR dependencies need release sequencing

The laser/machine feature series includes explicit dependencies between PRs #187–#194. PR #195 is based on **fix/release-migration-order-ci**, not on that laser stack. Keep these changes reviewable, but before release, verify the intended dependency order and ensure a release branch includes only reviewed, compatible changes. Do not merge the entire stack just to make features appear connected.

### 10. Unrelated global reminder adds background traffic and UI noise

The root layout mounted a global Dhikr reminder on every route. The component polled the authentication endpoint every 20 seconds and showed a religious reminder on login and periodically afterward. This behavior is unrelated to factory operations and had no settings/opt-in in the reviewed component.

**Action taken in PR #197:** removed the global mount, component, and its CSS. This does not affect authentication, production, or financial workflows.

## Recommended cleanup sequence

### P0 — correctness and financial integrity
1. Finish PR #195 CI and verify the production-vs-adjustment allocation case.
2. Add cross-entry-point payout/idempotency tests.
3. Add a read-only earnings reconciliation test/report before changing calculations.
4. Confirm order revenue, expense, custody, and delivery idempotency remains intact.

### P1 — reduce confusing duplicate workflows
1. Review **/earnings/direct-pay** permissions and external usage; then redirect or retire the UI route if confirmed redundant.
2. Keep current-custody payment and previous-custody settlement labels explicit.
3. Split the **/payments** page into clear sections/tabs without duplicating API writes or financial logic.
4. Make production scrap and scrap warehouse movements link to each other by source reference.

### P2 — consistency and maintainability
1. Use shared date/money/quantity formatting, searchable selectors, loading/empty/error states, and table containers.
2. Verify sidebar visibility against server-side RBAC; navigation hiding is never a substitute for API permission checks.
3. Complete the existing route-by-route frontend checklist with evidence.
4. Standardize names and migration conventions for new work only; preserve historical schema and API compatibility.

## Guardrails

- Railway is the only deployment target; no Vercel deployment.
- No destructive reset, bulk backfill, deletion of historical financial rows, or migration rename as part of cleanup.
- Do not label a candidate “unused” solely because it is absent from the sidebar; verify code references, route permissions, and external/bookmarked use first.
- Every cross-module fix should include isolated PostgreSQL integration tests and CI typecheck/tests/build before merge.
