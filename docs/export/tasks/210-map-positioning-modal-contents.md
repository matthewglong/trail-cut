# Task 210 — Map Positioning modal contents (3-pane preview + controls)

**Step**: Layout & Export UI (positioning track)
**Estimated effort**: ~1.5 days
**Status**: pending
**Depends on**: 200
**Companion plan**: `docs/export/plans/layout-ui.md`

## Goal

Fill the modal shell from 200 with the per-aspect positioning UI. After this task:

- Modal body shows three live preview panes — one per aspect (16:9, 4:5, 9:16) — each rendering that aspect's stored `LayoutConfig`.
- Each pane has: mode toggle (PiP / Side-by-Side), reset button, and (PiP only) corner radius slider.
- Each pane is fully interactive — drag the inset (PiP) or divider (SbS), swap via overlaid icon, all changes write to `project.layouts[aspect]` via existing auto-save.
- Existing `LayoutConfigurator` component is reused inside each pane.

## Files to touch

- **Modified** `src/components/MapPositioningModal/MapPositioningModal.tsx`:
  - Replace placeholder body with a 3-pane grid.
  - Each pane wraps an existing `<LayoutConfigurator>` (from `src/components/LayoutConfigurator/`) sized to the pane's container.
  - Layout values come from a parent-supplied `layouts: ProjectLayouts` prop; changes emit via `onLayoutChange(aspect, next)`.
  - **New** `<ResetButton>` per pane: reverts that aspect's layout to `defaultLayoutFor(aspect)`.
- **Modified** `src/components/LayoutConfigurator/LayoutConfigurator.tsx`:
  - No behavioral change; verify it accepts `containerWidth` / `containerHeight` props and renders cleanly at small sizes (~280–360px wide panes).
- **Modified** `src/screens/ProjectView.tsx`:
  - Pass `layouts={projectLayouts}` and `onLayoutChange={(aspect, next) => setProjectLayouts(prev => ({ ...prev, [aspect]: next }))}` to `<MapPositioningModal>`.

## Layout / sizing

- Pane grid: responsive flex; aim for side-by-side at full modal width, wraps to 2+1 on narrower viewports.
- Pane interior: aspect-fit container with 16px padding around the configurator surface; pane chrome (label, mode toggle, reset, slider) above/below the surface.

## Acceptance

- [ ] All 3 aspect previews render at modal-open with their current `project.layouts[aspect]` values.
- [ ] Drag in any pane updates only that aspect's stored layout.
- [ ] Mode toggle switches between PiP and SbS, seeding a default geometry on switch (existing `defaultPipLayout` / `defaultSplitLayout` from task 100).
- [ ] Reset button restores the seeded default for that aspect.
- [ ] Corner radius slider visible only in PiP mode; persists to `LayoutConfig.corner_radius`.
- [ ] Auto-save writes layout changes to disk within ~1s of last edit.
- [ ] Closing the modal does not lose any pending edits (auto-save already debounced; flush on close).

## Tests

- `MapPositioningModal.test.tsx`: renders 3 panes; mode toggle round-trips; reset returns to seeded default; auto-save fires `onLayoutChange` per pane.
- Manual: open modal, drag in each pane, close + reopen — confirm persisted values match.
