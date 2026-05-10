# Task 220 — Snap tuning + visual feedback

**Step**: Layout & Export UI (positioning track)
**Estimated effort**: ~0.5 day
**Status**: pending
**Depends on**: 210
**Companion plan**: `docs/export/plans/layout-ui.md` §3 (snap), §7 (snap tolerance)

## Goal

Make snap behavior feel "free-form with helpful snapping" rather than the current dev-tuned 1.5%. After this task:

- Snap threshold bumped to 5% (`SNAP_THRESHOLD = 0.05`).
- `Shift` key bypasses snap entirely (free positioning while held).
- Visual feedback: when a drag is within snap range of a target, the target is highlighted (subtle outline glow or thin guide line); the dragged element settles into snap on a 120 ms ease-out.
- No pulse-on-approach; no animation on the dragged element until snap engages.

## Files to touch

- **Modified** `src/components/LayoutConfigurator/snap.ts`:
  - `SNAP_THRESHOLD: 0.015 → 0.05`.
  - Export the threshold so feedback components can read it (no duplication).
  - Add `findActiveSnapTarget(value, targets, threshold)`: returns the target value if within range, else `null`. Used by feedback overlays to know what to highlight.
- **Modified** `src/components/LayoutConfigurator/usePipDrag.ts`:
  - Detect `event.shiftKey` on pointer events; when held, skip the `snap()` call.
  - Expose active snap-target state to the component for highlight rendering.
- **Modified** `src/components/LayoutConfigurator/useSplitDrag.ts`:
  - Same Shift bypass + active-target exposure.
- **Modified** `src/components/LayoutConfigurator/LayoutConfigurator.tsx`:
  - Render snap-target highlights (thin colored line for divider snaps; corner/edge guide for PiP snaps) when active.
  - Apply CSS transition `transform 120ms ease-out` only when transitioning *into* snap (not during free drag).

## Visual spec

- Snap target highlight: 1px line, color `rgba(120, 180, 255, 0.7)` (blueish; matches existing accent), full pane width/height.
- Ease-out duration: 120 ms.
- No pulse, no fade-loop. Highlight is binary: present when active, gone when not.

## Acceptance

- [ ] Snap threshold is 5% for both PiP edges and SbS divider.
- [ ] Holding Shift mid-drag disables snap (verify by dragging through a snap target without sticking).
- [ ] When approaching a snap target, the target highlights and the dragged element eases into the snapped value.
- [ ] No twitchy pulse animation.

## Tests

- `snap.test.ts`: `findActiveSnapTarget` returns correct target / null at threshold boundaries.
- `usePipDrag.test.ts` / `useSplitDrag.test.ts`: Shift-held event bypasses snap; emitted values are raw.
- Manual: drag the divider slowly across a snap point — verify highlight appears, drag eases in, holding Shift bypasses cleanly.
