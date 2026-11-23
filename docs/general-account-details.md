# General-account source itemization

Read-only additive response at `reconciliation.generalAccountDetails`. No migration, settlement execution, historical source relinking or balance-policy change.

Each nonzero row exposes source type, stable source ID, code/date when recorded, order association, signed exact four-decimal effect, description and provenance status. Anonymous historical adjustment rows stay unresolved. Descriptions are displayed as data, never parsed to infer a reversal, advance or carry.

The report is a projection bridge, not a second journal. It lists global source effects and then subtracts the unrounded signed order projection. Thus order-production bridge rows are accounting explanations, not new wage deductions or cash movements. Cancelled approval credits, price-delta exclusions, advance-principal exclusions, gross settlements, legacy payments and historical marks retain their actual structured sources. General payments are not arbitrarily assigned to orders or relabeled as overpayment carry. An exact carry journal is not invented from residual arithmetic.

Closure mode labels pre-cutoff order-production effects as closure exclusions. Ledger-only fallback exposes the ledger rows and outstanding-advance add-back. The active cutoff is returned. No-order approved production remains in the global side with no order association.

Rounding is classified only when source rows independently reproduce both the rounded global balance and the sum of rounded order balances. Otherwise the difference is explicitly unexplained and requires review. The report does not assert completeness when those checks fail. Anonymous provenance can require review even when arithmetic reconciles exactly.

Synthetic tests verify per-entry sums, unresolved historical rows, advance and price exclusions, closure effects, fallback and fractional offsets. Existing payments integration remains the behavioral guard. Local PostgreSQL18 occasionally raises a cleanup connection-termination failure; reruns pass. The previously reproduced payroll attendance expectation mismatch on the unchanged base remains outside scope. Remote CI must be checked separately on the final head.
