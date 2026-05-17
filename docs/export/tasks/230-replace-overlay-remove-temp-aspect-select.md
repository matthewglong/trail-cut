# Task 230 — Replace LayoutConfigurator overlay; remove temp aspect `<select>`

**Step**: Layout & Export UI (positioning track)
**Estimated effort**: ~0.5 day
**Status**: pending
**Depends on**: 210, 220
**Companion plan**: `docs/export/plans/layout-ui.md`

## Goal

Cut over from the dev-grade overlay configurator to the modal. After this task:

- The "Edit" affordance on `LayoutPreviewToggle` no longer mounts `LayoutConfigurator` over the video pane.
- The temporary `<select>` aspect picker (the `TEMP scaffold (task 100)` element in `ProjectView`) is removed.
- All layout editing happens inside the modal from 210; preview-only display stays via `LayoutPreview`.

Note: at this point the modal is the sole positioning surface, but the export flow still uses the three temp buttons — that cutover happens in 290 after 270 + 280 land.

## Files to touch

- **Modified** `src/screens/ProjectView.tsx`:
  - Remove the `<select>` and surrounding scaffold comment block (`TEMP scaffold (task 100)` block, ~lines 826–848).
  - Remove the `configuratorOpen` state and the `LayoutConfigurator` overlay branch (~lines 802–815). Keep the read-only `LayoutPreview` branch (~lines 817–823) — it stays as the always-on preview overlay on the video pane.
  - `selectedExportAspect` state stays — it's still referenced by export dispatch and feeds `LayoutPreview` to decide which aspect's layout to render. Its setter is no longer wired to a UI control until the export modal lands (240); add a TODO comment.
- **Modified** `src/components/LayoutPreview/LayoutPreviewToggle.tsx`:
  - Remove `onEdit` prop and the secondary edit button. Toggle is now visibility-only.
  - Update tests accordingly.
- **Removed (call sites)**: any `LayoutConfigurator` import in `ProjectView`. The component itself stays — it's the building block reused inside the modal.

## Acceptance

- [ ] No way to enter "edit mode" via clicks on the video preview pane.
- [ ] Temp `<select>` aspect picker is gone from the UI.
- [ ] Read-only `LayoutPreview` overlay still toggles on/off via `LayoutPreviewToggle`.
- [ ] Map Positioning modal (from 210) is the only path to mutate `project.layouts`.
- [ ] No regressions to the three temp export buttons (they still work; aspect they target is whatever `selectedExportAspect` last was — defaults to `'9_16'` after this task until 240 lands).

## Tests

- `LayoutPreviewToggle.test.tsx`: update to remove edit-button cases.
- Manual: open project, confirm overlay can be toggled but not edited from the video pane; modal-driven editing works as before; temp aspect `<select>` is gone.

## Risk note

Between 230 landing and 240 landing, the user has no way to change `selectedExportAspect`. If 240 is more than a day or two out, consider a temporary keyboard-only switch (`Cmd+1/2/3` for aspect) — but only if the gap matters. Default behavior (always export 9:16) is acceptable for the gap window.
