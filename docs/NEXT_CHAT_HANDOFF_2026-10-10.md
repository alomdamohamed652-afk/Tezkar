# Tezkar ERP — Next Chat Handoff (2026-10-10)

## Source of truth / deployment
- Repository: https://github.com/alomdamohamed652-afk/Tezkar
- Working branch: `fix/employee-selectors-and-deduction-options`
- Review PR: https://github.com/alomdamohamed652-afk/Tezkar/pull/38 (keep as Draft until all checks and deployment smoke tests pass)
- **Railway is the production platform. Vercel has been closed and must not be used or treated as a deployment target.**
- Railway project ID: `efa2187b-4315-417d-947a-95a69b2aa2f7`
- Environment ID: `d9143a39-89b3-4456-a204-caf62bc1dd3d`
- Web service ID: `d0ee5d09-aedc-4fd5-9d94-82f94a68aac7`
- API service ID: `7a08420d-b0c2-4aca-9d69-c699bc32a952`
- PostgreSQL service ID: `1e88bfe7-5b7a-4380-b9a6-5204570a743b`
- Do not mutate production payroll, inventory, delivery, or accounting records during testing. Use the CI PostgreSQL service or a disposable isolated database/schema.

## Work already in PR #38
- Configurable payroll deductions: fixed amount, percent of base salary, percent of base + bonus. Server-side calculation and preview UI.
- Dedicated eligible-employee endpoint for advances; custody employee selector respects RBAC scope.
- Payroll payment-history modal.
- Shared payroll deduction calculator and unit tests.
- Isolated-schema PostgreSQL test for migration `1012_payroll_deduction_options.sql`.
- Order price-change scopes and history (NEW_ONLY, UNPAID_ONLY, ALL), delivery metadata, and tests were already added on this branch in migrations `1013_order_price_changes_and_delivery_details.sql` and related files.
- Production shift-leader relationship work exists in migration `1014_production_shift_leader.sql`.
- Order details have reconciliation panels, price-change history and per-worker deltas; delivery UI has multi-line/carton fields and available-to-deliver display.
- Warehouse has a quick-add product flow.
- Global CSS already includes alternating table row colors, hover highlighting, calmer form controls, responsive account/logout links, delivery print styles, and notification styles.
- The prior CI run #1266 passed Typecheck, Tests, and Build on commit `0e23f349867a9d84538f82b3c8eeedaa7a690290`; this was before the newest searchable task selector commits. Re-run/check CI for current branch head before merging.

## Latest work in this continuation
- Added `apps/web/components/searchable-multi-select.tsx`.
- Updated `apps/web/app/tasks/page.tsx` to assign tasks by searchable employee name, showing employee code as secondary metadata. Supports selecting multiple employees without Ctrl/long-press, selected-name chips, selecting search results, and clearing selection.
- Added responsive styles in `apps/web/app/globals.css` for the searchable multi-select.
- Must validate latest changes with TypeScript, tests and production build.

## Requirements still to review/complete (from user)
### Visual consistency / mobile UX
- Keep alternating subtle row colors in dense operational tables (production, worker payout, warehouse withdrawals, deliveries, order detail, task lists) and ensure every dense list follows the same pattern.
- Make form boxes and nested editors responsive, well spaced and visually consistent. Avoid oversized raw browser controls.
- Ensure mobile shows account/profile settings and sign-out actions clearly, not hidden by the collapsed navigation.
- Human-readable names/account names should be primary in UI; keep technical IDs/codes as secondary metadata where useful.

### Employee profile / payments
- Let each employee maintain their own InstaPay number and Vodafone Cash number securely.
- Show those payout details to the employee in the relevant payment-request/payout flow. Avoid exposing them broadly to other employees; enforce permissions and ownership on API.
- Preserve account profile and change-password flow.
- Admin must be able to reset forgotten passwords; the current users API already has a reset-password route requiring `users.edit`, forces setup completion, revokes active sessions, and audits the reset. Confirm UI presents this safely and the employee receives a temporary password through a secure process.
- Account disable/reactivation should work without losing history; verify UI/API both directions.

### Roles / permissions / approvals / notifications
- “رئيس الوردية” is a role/permission assignment, not an employee job title. Keep employee and shift-leader assignment concepts separate; do not show a redundant “مسؤول الإنتاج” control in production entry.
- Approval buttons/actions for production, orders, payments and other flows must appear only when the current account has the relevant approval permission; API must also enforce it.
- Notifications should support events such as new task, production approved, payment/withdrawal approved, and important status changes, with user opt-in/preferences where feasible. Do not spam; allow notification settings and mark-read.
- Master-data options like sizes/coding fields should allow adding a new option inline or via searchable dropdown without leaving the current workflow.

### Orders, prices, warehouse, delivery
- In order details, provide a complete order workspace: production, warehouse withdrawals/receipts, deliveries, prices, and reconciliation.
- Price change policy options: new production only; unpaid production only; all past eligible production. For “all”, add a transparent per-worker balance adjustment/ledger entry with reason “تغيير سعر الطلبية”. Do not mutate historical earnings silently. Ensure partially paid production is treated according to the explicitly selected policy, and reject any reduction below amounts already paid unless a reviewed adjustment/receivable policy is implemented.
- Fix stage-rate editing so editing an existing stage rate updates that stage instead of accidentally creating a new stage. Verify API route/ID path and UI edit mode.
- Remove the helper sentence in production that says selecting a stage auto-selects the linked product.
- Delivery: selecting order + product should show order-specific availability, including approved production remaining, reserved deliveries, warehouse stock, and deliverable quantity. Investigate the error “كمية إذن التسليم تتجاوز الإنتاج المعتمد المتبقي للطلبية” even when entered quantity appears lower than warehouse stock; do not simply weaken controls. Reconcile units, product/variant matching, released/reserved quantities, and concurrent release checks.
- Support multiple carton codes in one delivery, carton weights, total delivery weight, piece count, samples, and arbitrary delivery notes/details.
- Printed delivery permission must include company identity “شركة تذكار”, larger logo, smaller barcode, all products/lines, carton/weight/piece/sample fields and extra details. Test Arabic RTL and long multi-line receipts.
- Add quick-add product in warehouse (already exists; test permission gating and workflow).
- Fix numeric display like `110000.0000000`: format numbers by context (currency 2 decimal places; quantities up to appropriate precision), never stringify PostgreSQL decimal precision directly.

## Next recommended sequence
1. Check current branch head and latest CI. Fix any typecheck/test/build failures first.
2. Test migration 1012 and 1013 against isolated PostgreSQL. Verify existing rows and idempotency.
3. Review order-stage rate editing and delivery availability/release transaction end-to-end.
4. Review payout profiles and secure employee visibility.
5. Verify role-gated approval UI/API, account disable/reactivate, password reset UI, and mobile account/logout.
6. Do responsive UI review on tasks, production, warehouse, order details and deliveries; normalize number formatting.
7. Run CI again. Only after passing, deploy through Railway (not Vercel), then perform non-destructive production smoke checks and report exact service/commit/deployment status.
8. Do not merge or deploy without explicit user authorization and verified green checks.

## Style and language
- Arabic-first, RTL.
- Use Arabic labels; show employee names first and code/account as secondary metadata.
- Keep workflows simple for a small factory and touch-friendly on phones.
