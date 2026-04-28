# Task 001 — Install and configure Vitest

**Step**: Setup
**Estimated effort**: 1h
**Status**: pending
**Depends on**: none

## Goal

Install Vitest as the test runner alongside the existing Vite toolchain so that subsequent tasks (Step 2 routeLocation tests, plus any pure-lib tests in Steps 1/3) can run via `npm test`. The migration doc (§6.2) calls out that `routeLocation.ts` has zero tests today and that Vitest is the natural fit alongside Vite (`vite.config.ts` already exists at the repo root). This task only sets up the infrastructure — no test files yet.

## Files to touch

- `package.json` — modify — add `vitest`, `@vitest/coverage-v8`, `jsdom`, `@types/node` (if missing) to devDependencies; add `"test": "vitest"`, `"test:run": "vitest run"`, `"test:coverage": "vitest run --coverage"` scripts.
- `vitest.config.ts` — new — configure Vitest with `environment: 'jsdom'`, include pattern for `src/**/*.{test,spec}.{ts,tsx}`, and v8 coverage provider with `include: ['src/lib/**/*.ts']`.
- `tsconfig.json` (or `tsconfig.app.json`) — modify — ensure `vitest/globals` types are picked up if globals are enabled (otherwise rely on explicit imports).

## Deliverables

- `npm install` runs clean.
- `npm test` runs Vitest in watch mode and reports "no tests found" gracefully.
- `npm run test:run` runs once and exits 0.
- Coverage script wired but not exercised yet.

## Acceptance criteria

- [ ] `npm install` completes without errors.
- [ ] `npm run test:run` exits 0 with output like "no test files found".
- [ ] `npm run build` still passes (no regression to Vite build).
- [ ] `vitest.config.ts` exists at repo root and uses jsdom environment.

## Implementation notes

Pick the latest stable Vitest (>=1.6) compatible with the project's Vite version. Use jsdom (not happy-dom) since some routeLocation tests may want full DOM date parsing fidelity. Do NOT enable Vitest globals — prefer explicit imports (`import { describe, it, expect } from 'vitest'`) for grep-friendliness.

Coverage configuration should restrict the include glob to `src/lib/**/*.ts` for now so coverage numbers reflect the pure-lib surface that the migration cares about, not the React UI.

This task creates infrastructure only — no test files. Task 200 scaffolds the first test file structure.
