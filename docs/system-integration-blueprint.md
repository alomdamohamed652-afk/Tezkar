# Tezkar System Integration Blueprint

## Goal

Tezkar is one connected operational and financial system, not a collection of independent pages. Each real-world event is recorded once in its owning module, then related modules read or reference that event. Derived totals must never be maintained by hand in multiple places.

## Source-of-truth ownership

| Domain | Owns the facts | Downstream consumers |
| --- | --- | --- |
| Employees and access | Employee identity, active status, user links, roles and permissions | Attendance, production, payroll, custody, advances, worker dues |
| Attendance | Raw imported punches, corrections/reviews, effective schedules, daily calculations | Monthly attendance review, payroll preparation and frozen payroll snapshots |
| Production | Worker/machine production, approved good quantity, scrap and design/machine attribution | Worker earnings, production reports, machine rankings, scrap inventory |
| Warehouse | Receipts, withdrawals, deliveries, stock movements and scrap stock | Inventory balance, production availability, order costing |
| Worker earnings | Approved production earnings, adjustments, advances and settlement references | Worker dues, advance repayment, payroll-related settlements and employee account views |
| Advances | Request, approval, actual payout, repayment plan and each repayment | Employee balance, custody movement, payroll deduction, worker account |
| Payroll | Monthly salary profiles, draft payroll items, named bonus/deduction lines, approval, payments and frozen attendance | Payslips, employee account, cash custody and accounting expenses |
| Cash custody | Every cash IN/OUT and transfer by custody holder, with source reference | Custody balance, cash-flow reports, payout validation and close review |
| Accounting | Revenues, expenses, accounting periods, review/close state and order profitability | Financial summary, period close, order profitability and reconciliation |
| Audit and notifications | Who performed an action, before/after data, and actionable events | Review trail, administration and user alerts |

## Cross-module rules

1. **One source event, one financial effect.** A payroll payment, advance payout, worker settlement or expense must not be manually re-entered as a second unrelated transaction to make a dashboard look right.
2. **Use stable source references.** Downstream postings should reference the originating record through source type + source ID, or a dedicated foreign key, and have a database uniqueness guard wherever retries are possible.
3. **Commit linked changes together.** A business event and its dependent ledger/custody/accounting postings belong in one database transaction. If any dependent posting fails, the originating event must not be left half-complete.
4. **Draft → review → approval → posting.** Draft values can be edited by authorized roles. Approval freezes the reviewed inputs and posts downstream effects. Approved/closed records are corrected through reversal or adjustment records, not silent overwrites.
5. **Reversals are new traceable events.** Never delete a posted cash, payroll, advance, earnings or accounting transaction to correct history. Create a reversal linked to the original, with reason, actor, date and audit trail.
6. **Cash is not the same as revenue or expense.** Moving money into a custody is funding/transfer, not revenue. A cash movement is only created when money actually changes custody; non-cash payments must not change cash custody.
7. **No silent duplicate operations.** Mutating requests use idempotency keys or unique source constraints. Replaying a request with the same key and same payload returns the original result; reusing it with different data is rejected.
8. **Accounting-period locks apply consistently.** Any financial mutation checks the entire posting date/month against open periods inside the same transaction.
9. **Snapshots are immutable evidence.** Once payroll or a period is approved, preserve the exact attendance/financial basis used for approval. Later corrections require an explicit amendment/reversal process.
10. **Reports are derived, not editable ledgers.** Dashboards and summary cards query the authoritative transaction records and expose discrepancies rather than maintaining their own totals.

## Required lifecycle links

### Payroll
Attendance + salary profile + explicitly entered bonus/deduction lines + approved advance instalments → draft payroll → reviewer checks each employee/day → approval freezes attendance and posts the salary expense/employee earnings → each actual payment records method, date, reference and (cash only) custody holder → payslip and employee account display the same approved figures and payment history.

### Advances
Request → independent approval → actual payout with the real paying custody → repayment schedule → each actual repayment or payroll-linked deduction is posted once → remaining advance balance is calculated from the original amount less linked repayments. An approved request is not cash paid yet.

### Worker dues
Approved good production and explicit adjustments → available earnings → settlement/payment record → one linked custody outflow if cash was actually paid → employee earnings balance and worker dues both reflect that settlement. Scrap must not earn wages when the wage policy excludes it.

### Order finances
Customer revenue/collections and expenses are distinct facts. Order profitability is derived from linked revenues, direct costs, allocated administrative costs and production costs. Custody funding and transfers must never appear as order revenue. Historical corrections must be explicitly marked and must not create a second current cash movement.

### Cash custody
Each holder's balance is the signed sum of their dated transactions. Transfers create paired linked movements; a cash expense or payroll/advance payout creates one OUT; a real cash receipt/repayment creates one IN. Reports must show source type and source record for every movement.

## Reconciliation controls to build and maintain

- Approved payroll items with a missing or mismatched accounting expense.
- Payroll payment totals greater than net salary, duplicate payment references, or cash payments without exactly one matching custody OUT.
- Paid advances without a matching payout/custody movement, and repayments without matching repayment-ledger/custody links.
- Worker settlements that exceed approved available earnings or have missing/double cash movements.
- Custody transfers where the OUT and IN sides differ in amount, date, or source link.
- Accounting expenses paid from a custody without a matching custody movement, and custody funding incorrectly categorized as revenue.
- Approved production entries whose earnings or scrap/stock consequences are missing or duplicated.
- Closed periods containing ordinary postings after closure.

## Implementation order

1. Stabilize the current payroll branch: syntax/typecheck, migrations, tests and approval/payment invariants.
2. Inventory all financial posting paths and map each to its owning record, ledger rows, custody movements, accounting effects and reversal route.
3. Add read-only reconciliation checks and tests before changing legacy data or balances.
4. Consolidate shared posting helpers and source-link uniqueness constraints one workflow at a time, preserving legacy balances.
5. Add explicit reversal/correction flows, then surface reconciliation status in the finance/accounting UI.
6. Verify CI and Railway deployment readiness. No production deployment, data reset, historical migration execution or merge should occur without explicit authorization.

## Safety guardrails

- Never fix mismatched balances by editing totals directly.
- Never infer an undocumented historical payment or bonus.
- Never auto-replay a financial posting without idempotency protection.
- Keep source history, actor, timestamp, reason and original transaction references.
- Any reconciliation finding is initially a warning for review; automated repairs require a separately reviewed, tested migration or correction action.
