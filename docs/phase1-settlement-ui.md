# Phase 1 settlement UI

Base: `deploy/web-production-request-optimizations`. API fixes have a separate PR based on `fix/release-migration-order-ci`. No main, deployment or account settings changes.

- PREVIOUS_CUSTODY can fill all-orders dues without requiring an order selection.
- An unselected order is submitted as null, not an invalid empty UUID string.
- The amount input uses the selected order's balance or the all-orders balance consistently.
- The reconciliation table is additive and appears only when the API supplies `reconciliation`. Old API responses remain supported. Deploy the API PR first to enable the table.
- Signed order subtotal plus the general-account / reconciliation bucket equals the unified wage total. Advance debt is shown separately. The residual bucket includes adjustments, carry, rounding and closure differences; this is not full per-component journal itemization.

Local production build and typecheck pass. UI checks use synthetic API fixtures, not live financial records: select a worker, choose PREVIOUS_CUSTODY with all orders, click full settlement, verify330 fills, and verify submitted orderId/orderStageId are null. No live settlement is executed. Remote CI must validate the final pushed commit.
