# General-account source details UI

Optional expandable table under settlement reconciliation. Requires the companion API response; older API responses remain supported.

Display source date/reference, source type, effect scope, exact four-decimal signed amount, recorded description and provenance status. Anonymous historical rows visibly need review, with no inferred reversal/carry label. Closure cutoff, verified rounding, unexplained differences and final general-account total are visible. Bridge rows explain subtraction of already-displayed order effects, not additional deductions or cash postings.

Synthetic UI fixture330 order subtotal and-20 anonymous adjustment reproduces310 total and opens the detail table. Local browser interaction verifies310 full-settlement fill and null order IDs; no real payment is made. Production build/typecheck and15 web tests pass; lint has0 errors and40 existing warnings. Remote CI must finish on the pushed head. Known local API validation caveats are documented in the API companion, not silently fixed here.
