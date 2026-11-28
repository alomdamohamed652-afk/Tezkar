# Tezkar Frontend — All-Page UI Audit

This checklist is the acceptance gate for the global UI polish and follow-up page-by-page work. The application is Arabic-first and RTL. Do not mark a route complete merely because shared CSS loads.

## Shared checks required on every route

- [ ] Page title, primary action, and content hierarchy are clear.
- [ ] Desktop, tablet, and 320–390px mobile widths have no accidental page-level horizontal overflow.
- [ ] Tables and wide forms scroll inside their own container where necessary; they do not stretch the whole viewport.
- [ ] Dropdowns, dialogs, toasts, and sticky elements are not clipped by scroll containers.
- [ ] Hover, focus-visible, active, loading, disabled, success, and error states are visually distinguishable.
- [ ] Motion is short and purposeful; no animation changes business values or delays essential actions.
- [ ] `prefers-reduced-motion: reduce` disables non-essential transitions and smooth scrolling.
- [ ] Keyboard navigation and visible focus work; focus is not hidden behind sticky headers.
- [ ] Arabic labels, numerals, dates, and mixed LTR identifiers remain readable.
- [ ] Existing permissions, API calls, validation, and business calculations are unchanged.
- [ ] Empty, loading, error, and long-content states are reviewed.
- [ ] Browser console and network requests are checked during interactive testing.

## Route inventory

Every route below requires its own pass, including nested routes.

### Accounts, finance, and payroll
- [ ] `/account` — `apps/web/app/account/page.tsx`
- [ ] `/accounting` — `apps/web/app/accounting/page.tsx`
- [ ] `/advances` — `apps/web/app/advances/page.tsx`
- [ ] `/earnings` — `apps/web/app/earnings/page.tsx`
- [ ] `/earnings/direct-pay` — `apps/web/app/earnings/direct-pay/page.tsx`
- [ ] `/finance/review` — `apps/web/app/finance/review/page.tsx`
- [ ] `/finance/worker-settlements` — `apps/web/app/finance/worker-settlements/page.tsx`
- [ ] `/payments` — `apps/web/app/payments/page.tsx`
- [ ] `/payroll` — `apps/web/app/payroll/page.tsx`
- [ ] `/receipts` — `apps/web/app/receipts/page.tsx`

### Production, orders, deliveries, and inventory
- [ ] `/cartons` — `apps/web/app/cartons/page.tsx`
- [ ] `/coding` — `apps/web/app/coding/page.tsx`
- [ ] `/deliveries` — `apps/web/app/deliveries/page.tsx`
- [ ] `/machine-production` — `apps/web/app/machine-production/page.tsx`
- [ ] `/my-production` — `apps/web/app/my-production/page.tsx`
- [ ] `/operations` — `apps/web/app/operations/page.tsx`
- [ ] `/orders` — `apps/web/app/orders/page.tsx`
- [ ] `/orders/[id]` — `apps/web/app/orders/[id]/page.tsx`
- [ ] `/production` — `apps/web/app/production/page.tsx`
- [ ] `/production/scrap` — `apps/web/app/production/scrap/page.tsx`
- [ ] `/warehouse` — `apps/web/app/warehouse/page.tsx`
- [ ] `/warehouse/scrap` — `apps/web/app/warehouse/scrap/page.tsx`
- [ ] `/shift-withdrawals` — `apps/web/app/shift-withdrawals/page.tsx`

### People, attendance, and administration
- [ ] `/attendance` — `apps/web/app/attendance/page.tsx`
- [ ] `/employees` — `apps/web/app/employees/page.tsx`
- [ ] `/shift-leaders` — `apps/web/app/shift-leaders/page.tsx`
- [ ] `/admin/security` — `apps/web/app/admin/security/page.tsx`
- [ ] `/master-data` — `apps/web/app/master-data/page.tsx`
- [ ] `/custody` — `apps/web/app/custody/page.tsx`
- [ ] `/tasks` — `apps/web/app/tasks/page.tsx`
- [ ] `/notifications` — `apps/web/app/notifications/page.tsx`
- [ ] `/reports` — `apps/web/app/reports/page.tsx`
- [ ] `/search` — `apps/web/app/search/page.tsx`
- [ ] `/settings` — `apps/web/app/settings/page.tsx`

### Authentication and onboarding
- [ ] `/login` — `apps/web/app/login/page.tsx`
- [ ] `/forgot-password` — `apps/web/app/forgot-password/page.tsx`
- [ ] `/password-reset-requests` — `apps/web/app/password-reset-requests/page.tsx`
- [ ] `/register` — `apps/web/app/register/page.tsx`
- [ ] `/registration-requests` — `apps/web/app/registration-requests/page.tsx`
- [ ] `/setup` — `apps/web/app/setup/page.tsx`

## Motion and scrolling rules

1. Use shared CSS transitions for common controls; add GSAP only for a concrete interaction that benefits from orchestration.
2. Avoid parallax, scroll-jacking, auto-playing decorative sequences, and motion on rapidly updating production/finance numbers.
3. Keep native scrolling. Horizontal overflow belongs to the table/filter container, not the whole page.
4. Dialogs and dropdowns must remain usable with keyboard, touch, and reduced motion.
5. Validate on real routes with representative permissions and realistic data before marking a route complete.

## Release rule

- Shared baseline changes must pass repository CI (typecheck, tests, build).
- Page-specific changes should be grouped into reviewable PRs, with before/after evidence and route-level test notes.
- Production deployment target is Railway only. Do not use Vercel as a deployment target.
