# Phase 1 settlement calculation

Base: `fix/release-migration-order-ci`. This change does not merge the web service's separate branch. No migrations, account settings, production data changes or deployment changes are included.

## Rules

- A payment uses canonical settlement allocations when allocation rows exist, otherwise ORDER allocations, otherwise legacy allocations. A parent settlement link with no canonical allocation rows does not select the canonical source.
- Allocation reversals subtract from their original lineage. Fully reversed rows do not reactivate stale copies in other allocation tables.
- An order's remaining balance is signed. Sum four-decimal entitlement and active paid amounts before rounding to cents. Do not sum per-production clamps.
- The all-orders result reconciles to signed order balances plus a visible general-account / reconciliation bucket. This bucket contains standalone adjustments, unallocated carry, no-order production, closure exclusions and account-boundary rounding. It is not silently assigned to an order. It is a residual reconciliation bucket, not a new journal or a claim that every component is itemized.
- Advance principal is separate from gross wage entitlement. Repayment at settlement reduces net cash and advance debt, not the order's gross labor cost a second time.
- Existing order-scoped payout behavior is retained. A standalone general-account deduction does not silently reduce a specifically selected order's entitlement.

## Legacy projection bridge

The application combines current production entitlement with historical anonymous adjustment ledger rows. Source-linked cancelled production approval credits and posted production adjustments must offset their anonymous cancellation reversals instead of counting only the reversal debit. Price-change deltas are already reflected in current production entitlement and must not be added twice. Advance payout debits are identified through `advance_requests.ledger_entry_id` and excluded from wage deductions.

This bridge uses existing structured source records, not free-text notes. It does not delete, relink or rewrite historical ledger entries. Missing or inconsistent historical source records still require accounting review. It does not claim to repair missing ledger records or classify every anonymous adjustment individually.

## Verification

Synthetic integration scenarios cover330 versus30 after a cancelled300 approval, a4928.04 ORDER allocation with settlement parent counted once, signed half-cent offsets, separate advance debt, price-change delta deduplication and reconciliation. The existing full payments integration test remains the guard for bulk settlement, custody offsets, order-scoped payments, carry, reversals and difference-event cycles. Fixed-point tests cover negative halfway rounding and allocation precedence.

Remote CI must run on the final pushed commit. Local checks do not prove remote CI or production behavior. No production repair SQL is included.
