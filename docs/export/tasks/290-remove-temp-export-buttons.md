# Task 290 — Remove the three temp export buttons; final cutover

**Step**: Layout & Export UI (export track — cutover)
**Estimated effort**: ~0.25 day
**Status**: pending
**Depends on**: 270, 280
**Companion plan**: `docs/export/plans/layout-ui.md` §1, §9

## Goal

The point-of-no-return cutover. After this task:

- The three developer-grade buttons (Composite / Map-only / Video-only) and their dispatch handlers are gone from `ProjectView`.
- The single "Export" button is the sole entry point.
- All scaffolding comments referencing the temp buttons are removed.

## Files to touch

- **Modified** `src/screens/ProjectView.tsx`:
  - Remove the three export buttons and their `onClick` handlers (`handleExportComposite`, `handleExportMapOnly`, `handleExportVideoOnly` — names approximate; check current code).
  - Remove `runExport` callback if no other call site remains. Otherwise keep, but it should now be the queue's per-job dispatch (already moved to `useExportQueue` in 270).
  - Remove `exportError` / `exportDetailsOpen` / `exporting` state if they were exclusive to the temp buttons. Verify they're not also used by the modal flow.
  - Remove tooltips/comments that reference "temp" / "scaffold" / task IDs 060/070/090.
- **Modified** any tests that asserted the three buttons existed; update to assert the single Export button.

## Verification before merging

- [ ] Single Export button is the only export entry point.
- [ ] Modal flow has been exercised end-to-end: select → estimate → render → done.
- [ ] No dead code: search for `handleExportComposite`, `handleExportMapOnly`, `handleExportVideoOnly`, `runExport`, `exportDetailsOpen` and confirm only the kept references remain.
- [ ] No broken tests.

## Risk note

This is the cut over — once landed, the only path to render is the modal. **Do not land 290 until 270 + 280 are stable on `main`.** Both should have been dogfooded on at least one real export run.

## Tests

- Update existing component tests to reflect the new toolbar.
- Manual: full happy path — open project → click Export → select 9:16 composite → pick folder → render → confirm output → reopen project, modal prefills last selection.
