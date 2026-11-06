# Client and Server Resource Architecture

## Purpose

Reduce avoidable Railway API/database work by using each user's device for presentation and safe computation, without weakening correctness, authorization, auditability, or responsiveness.

This is an incremental architecture. PostgreSQL remains the single source of truth. The API remains authoritative for every business decision and every write.

## Non-negotiable invariants

1. **Server authority:** permissions, validation, balances, stock availability, payroll, attendance approval, accounting, reversals, and transaction ordering are decided by the API/database.
2. **No client-trusted totals:** client calculations are previews or presentation only. The server recomputes and validates every submitted operation.
3. **No stale-after-write UI:** a successful mutation invalidates every affected cache entry before the UI treats the new state as current.
4. **No cross-user leakage:** cached data is scoped to the authenticated browser session. Logout, session expiry, account switch, and authorization changes clear user-scoped memory.
5. **No blind offline writes:** financial, payroll, stock, production approval, attendance correction, and reversal operations must not be queued for later automatic execution.
6. **No API response caching by Service Worker/CDN:** authenticated API responses remain network-authoritative unless a future endpoint is explicitly reviewed and designed otherwise.
7. **Progressive rollout:** each optimization is measured and can be disabled or rolled back independently.

## Target architecture

### 1. Presentation layer (browser)

Owns rendering, pagination controls, sorting, filtering over already-loaded bounded datasets, form state, print layout, and export presentation. Use list virtualization for large tables. Avoid downloading an entire table just to filter it.

### 2. Client data-access layer

All API requests go through the shared API client. It owns:
- request deduplication for identical in-flight GET requests;
- short-lived, bounded in-memory caching for explicitly approved read endpoints;
- typed cache policies per endpoint (not one global long TTL);
- mutation-driven invalidation;
- session lifecycle clearing;
- optional request cancellation when a page is no longer interested.

Do not add ad-hoc fetch caches inside individual pages.

### 3. Local device storage

Use in-memory cache first. Consider IndexedDB only for reviewed, low-sensitivity reference data or explicitly designed offline read models. Do not persist credentials, session tokens, payroll data, personal employee data, account balances, custody records, or financial ledgers in browser storage.

Every persisted dataset must define owner/session scope, schema version, expiry, invalidation, maximum size, and logout cleanup before implementation.

### 4. Local computation

Use normal browser execution for small work. Use Web Workers only after profiling shows CPU-heavy work that blocks interaction (large report transformations, parsing, or exports). Transfer only the minimum required data. Workers must not become a second source of business rules.

### 5. API and PostgreSQL

Continue to own authentication, authorization, business validation, transactions, audit logs, authoritative aggregates, concurrency control, and durable storage. Optimize SQL and add indexes only after examining actual query plans and workload.

## Cache policy

| Data class | Default strategy | Notes |
|---|---|---|
| Session, permissions, user identity | No long-lived cache | Clear on logout/session changes; revalidate through API |
| Payroll, accounting, balances, custody, employee-private data | No persistent browser cache | Short/no cache unless endpoint-specific review proves safe |
| Pending approvals, notifications, live production/stock | Short TTL or explicit refresh | Invalidate after related mutations |
| Reference lists (products, stages, rates, shifts, machines) | Bounded in-memory cache | Longer TTL only where data is low-volatility; invalidate after edits |
| Large reports and tables | Server pagination/filtering first | Cache bounded pages, not unbounded full datasets |

The initial implementation uses a 30-second in-memory TTL for a narrow reference-data allowlist, a 1.5-second default for other GETs, a 100-entry cap, and full GET-cache invalidation after successful mutations. This is a conservative first step, not the final policy. The allowlist must be verified against actual endpoint semantics before expanding it.

## Performance rules

- Prefer server-side filtering, sorting, and pagination when the dataset is large or permission-scoped.
- Perform local filtering only on bounded datasets already needed by the current view.
- Never fetch hundreds of records only to display a count; use dedicated count endpoints.
- Avoid polling when an event, manual refresh, or sensible stale interval is sufficient.
- Avoid loading hidden tabs, unopened report sections, and below-the-fold heavy components.
- Lazy-load large export/chart/report code only when requested.
- Use Web Workers only when profiling justifies their startup and memory overhead.
- Do not optimize by increasing browser memory without a strict size/expiry limit.

## Rollout plan

### Phase A — Safe request reduction
- Audit API calls and identify duplicate/repeated GET requests.
- Maintain a reviewed endpoint cache-policy registry.
- Add request deduplication, bounded cache, and mutation invalidation.
- Verify logout/account-switch cleanup and stale-data behavior.

### Phase B — Efficient screens
- Add server pagination and count endpoints where needed.
- Virtualize large tables.
- Keep filtering local only for bounded loaded data.
- Lazy-load heavy screens, charts, and exports.

### Phase C — Device-side computation
- Profile report/export workloads on representative low- and mid-range devices.
- Move only measured CPU-heavy, non-authoritative transformations to Web Workers.
- Keep server validation and authoritative calculations unchanged.

### Phase D — Carefully selected local read models
- Evaluate IndexedDB per dataset; no blanket offline cache.
- Add schema versioning, expiry, session scoping, invalidation, quota handling, and cleanup.
- Start read-only. Offline writes are a separate design and are not part of this phase.

## Required verification before merge

1. Existing lint, typecheck, tests, and production build pass on the exact PR head.
2. Tests cover cache expiry, request deduplication, mutation invalidation, bounded eviction, and session/logout clearing.
3. Tests prove sensitive/session endpoints are not assigned long cache TTLs.
4. Verify no stale balances, permissions, pending counts, stock, or payroll after a mutation.
5. Measure browser CPU/memory and API request counts on representative devices and workflows.
6. Compare API/DB request volume and Railway usage over equivalent windows; do not claim cost savings from code changes alone.
7. No production deployment or production database changes without explicit approval.

## Metrics to record

- API requests per user workflow and per active user.
- Duplicate GET requests avoided.
- Cache hit/miss/eviction rates by endpoint class.
- Browser memory and long-task duration on low/mid-range devices.
- API latency (median/P95), database query count and slow-query distribution.
- Railway service usage over comparable time windows.

## Current implementation status

- PR #255 contains the first server-side request reductions: compact permission-scoped Sidebar count endpoints, a consolidated `/api/auth/me` read, throttled session activity writes, and attendance report indexing by employee plus Cairo-local date. Overnight shifts retain the next-day OUT-punch rule; regression coverage checks that the next shift's punches are not stolen.
- PR #256 begins the browser-side layer with bounded, tab-local in-memory GET caching and a short reference-data TTL. Its stacked follow-up PR #257 tightens the allowlist to products, stages, shift rate-group names, and machine reference data; wage rates and shifts with dynamic employee counts are excluded.
- Latest verified PR #255 head: `f4fe6eb5d0cc1722c4053df8463521c40eb9c191` (Install, Lint, Typecheck, Tests, Build all pass). The PR remains open and unmerged.
- IndexedDB, Service Worker API caching, offline writes, and Web Workers are **not** implemented. They require separate profiling, threat review, and tests before adoption.
