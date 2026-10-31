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

### 11. Two additional routes are absent from navigation and need usage/permission review

- **/operations** is not in the sidebar. Its current form overlaps the master-data page for shifts, rate groups, units, products, stages, and wage types. Its shift-leader assignment overlaps the dedicated **/shift-leaders** page. The reviewed page also uses raw fetch helpers and does not hide sections by permission; server-side API authorization remains the actual security boundary.
- **/cartons** is not in the sidebar and uses the separate **/api/warehouse/cartons** flow. The linked **/coding** page uses **/api/coding/units** and packaging templates. These may be distinct inventory concepts, so this is a candidate for usage/linkage verification, not a deletion decision.

**Next step:** inspect role permissions, live/internal references, and whether carton records are used by warehouse/delivery flows. If a route is legacy, preserve it as a compatibility redirect and keep its historical data/API intact until the migration path is proven.

## Recommended cleanup sequence

### P0 — correctness and financial integrity
1. Finish PR #195 CI and verify the production-vs-adjustment allocation case.
2. Add cross-entry-point payout/idempotency tests.
3. Add a read-only earnings reconciliation test/report before changing calculations.
4. Confirm order revenue, expense, custody, and delivery idempotency remains intact.

### P1 — reduce confusing duplicate workflows
1. Review the **/operations** and **/cartons** routes against role permissions and live references; redirect only where feature parity is confirmed.
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


## Revalidated repository status — 2026-10-31

This section supersedes older sequencing notes above where the repository has since advanced. It is still a static repository/CI audit, not completed browser acceptance testing or production verification.

### Verified current state

- PR #195 was merged on 2026-10-28. The older P0 instruction to finish PR #195 is obsolete.
- PR #226 (financial integrity center) passed GitHub Actions CI on head `72bce4c`. It remains Draft and unmerged.
- PR #227 (warehouse low-stock alerts), #228 (searchable employee selector), and #229 (permission presets) each passed CI on their previously checked heads. PR #227 received an additional correction on 2026-10-31: its global minimum-stock calculation now uses active non-scrap warehouses, because the product minimum is global and scrap stock must not hide a usable-stock shortage. CI for that correction is pending.
- PR #230 ports the pending/approved production status + employee filter regression assertions onto the current release base. CI is pending.
- The current release base already contains canonical settlement-allocation precedence and a more comprehensive historical-payment reconciliation than the older PR #168 patch. The current production routes also contain the duplicate-allocation precedence logic proposed in PR #210; the remaining distinct coverage from #210 is the direct `GET /api/production` row-level regression assertion, now ported to PR #230.
- The older payment branches #145, #146, #168, and #210 are substantially behind/diverged from the current release base. Do not merge them as-is; compare their intent against current code and port only a missing test or behavior.
- The current release base already has the two-person accounting-period close workflow and snapshot tables through migrations `2026101701_accounting_period_approval_snapshots.sql` and `2026101702_accounting_period_snapshot_immutability.sql`, including review, approval, close, reopen, and snapshot immutability. PR #122's separate `9999_quarterly_financial_close.sql` design is an older competing implementation and must not be merged over the current workflow.
- Effective-dated attendance schedules are already present on the current base through migration `1038_attendance_schedule_effective_dates.sql`, API routes, and the attendance page. Existing attendance calculation tests do not yet exercise schedule-version date boundaries; add focused tests before declaring this area fully verified.
- The current base already exposes order expense and collection workflows in cash custody. PR #69 should be checked for any unique behavior not already present before considering its old branch.
- `docs/FRONTEND-ALL-PAGES-AUDIT.md` remains unchecked. All listed routes still require route-level browser checks for responsive behavior, permissions, empty/error states, console/network errors, and Arabic/RTL rendering.

### Updated execution order

1. Finish CI and review the current-base test-only PR #230 and the corrected PR #227.
2. Complete financial correctness review around payroll, advances, settlements, custody, historical allocations, and order profitability. Keep #226 Draft until the full review is complete.
3. Add attendance effective-date boundary tests and verify the current period-close workflow; do not resurrect the superseded #122 schema.
4. Review inventory, scrap traceability, deliveries, machine production, and order-stage lifecycle end to end.
5. Run a role-by-role API authorization matrix and complete the all-route frontend checklist.
6. Prepare Railway-only release checks: migration status on the intended environment, backup/restore readiness, API/Web health, and read-only smoke tests. No deployment or production-data mutation is part of this audit.

### Release guardrails

- CI success is necessary but not equivalent to browser acceptance or business-flow verification.
- Keep test databases disposable and isolated; do not use production data for destructive tests.
- Do not merge, close, rebase, or deploy a PR solely because its CI is green. Review current-base compatibility and preserve the existing financial source of truth first.


### CI and Railway snapshot — 2026-10-31 05:03 UTC

- PR #226: CI `success` on `72bce4c`.
- PR #227: CI `success` on corrected head `8acd9e7`.
- PR #230: CI `success` on `6e923aa`.
- PR #231: CI `success` on `4da8cdd`.
- PR #196 audit-document update: CI `success` on `17094d1`.
- PRs #226–#231 remain unmerged; the new test/feature PRs remain Draft pending review and release sequencing.

**Railway production read-only check**
- Only one Railway environment is configured: `production`; there is no separate staging environment.
- Tezkar Web, Tezkar API, and Postgres are all online, each with one running replica and zero Railway warnings/critical issues.
- No staged Railway changes are pending.
- Web and API are both deployed from `fix/release-migration-order-ci` at commit `c7377bf`.
- Over the last 24 hours, Railway reported zero 5xx responses across 7,360 API requests and 9,886 Web requests. Observed p95 latency was approximately 244 ms for the API and 296 ms for Web.
- This verifies service health and deployment provenance only. It does not verify database backup restoration, schema migration state inside production, or browser acceptance of every workflow.

**Frontend checklist count:** 40 routes plus 12 shared checks remain unchecked (52 total). Do not mark them complete from CI alone.
