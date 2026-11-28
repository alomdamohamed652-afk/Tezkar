# Frontend design and motion toolkit

This repository uses project-local agent skills under `.agents/skills/` for frontend work. The skills guide implementation; they do not install runtime dependencies automatically.

## Installed project skills

- **Taste Skill** (`.agents/skills/design-taste-frontend/SKILL.md`): design direction, hierarchy, spacing, responsive layout and a pre-flight review.
- **Impeccable** (`.agents/skills/impeccable/SKILL.md`): audit, critique and polish existing UI. The full Impeccable CLI/hook is not vendored; install it locally with `npx impeccable install --providers=codex --scope=project` in a trusted checkout, then review/approve the hook.
- **Designlang** (`.agents/skills/extract-design/SKILL.md`): extract design tokens from a reference site. Requires the upstream CLI/browser setup; use only to study references, not copy another product's branding wholesale.
- **GSAP React** (`.agents/skills/gsap-react/SKILL.md`): correct GSAP use in React, cleanup and lifecycle.
- **Playwright CLI** (`.agents/skills/playwright-cli/SKILL.md`): browser interaction and visual verification. Install locally with `npm install -g @playwright/cli@latest`, then `playwright-cli install --skills`.

## Runtime libraries and component sources

Do not add every animation dependency globally. Choose a component or transition for a specific UI need, review its dependencies/license, then add only what is used:

- **React Bits**: browse https://reactbits.dev and install an individual component using its documented command (often `npx jsrepo add github/DavidHDev/react-bits/<component>`). Check each component's React/Tailwind requirements before installation.
- **GSAP**: when a real UI use case is approved, add `gsap` to `apps/web` using pnpm and commit the updated `pnpm-lock.yaml` in the same change.
- **Transitions.dev**: install the upstream skill using `npx skills add Jakubantalik/transitions.dev` in the coding-agent environment. Do not copy its transition library wholesale into this repository; use the official installer and respect its license.

## Tezkar UI guardrails

1. Keep the interface Arabic-first and RTL, with clear data density suitable for factory operations.
2. Prefer fast, restrained transitions for menus, dialogs, tabs, filters and loading states. Avoid scroll hijacking, autoplay effects and decorative motion in dense tables.
3. Respect `prefers-reduced-motion`; keep every action usable without animation.
4. Preserve existing behavior, permissions, financial calculations and production data. UI work must not alter business logic unless explicitly required.
5. Prefer existing design tokens/components before adding a new library. Avoid duplicate animation systems for the same interaction.
6. Use Playwright to verify desktop and mobile layouts, Arabic/RTL rendering, keyboard operation, filter behavior and important workflows before merging.
7. Keep deployment on Railway only; do not configure Vercel.

## Suggested workflow

1. Run the Impeccable audit/critique and inspect current UI before editing.
2. Identify the highest-impact screens and define a small, consistent visual direction.
3. Implement one screen or component group at a time.
4. Run typecheck, tests and build; then use Playwright screenshots and interaction checks.
5. Review motion/accessibility and confirm no business logic regressions before merging.
