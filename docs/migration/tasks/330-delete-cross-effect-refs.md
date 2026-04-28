# Task 330 — Delete the six cross-effect refs and all recordEvent calls

**Step**: 3 (MapView refactor)
**Estimated effort**: 30min
**Status**: pending
**Depends on**: 310, 320

## Goal

Strip the six refs at `MapView.tsx:212-223` (defended at lines 399, 651, 579, 626, 499, 516, 525, 520, 648 per §2.4) and delete every `recordEvent(...)` call inside MapView. Per §3.8 of the migration doc: "In a pure-function model, **all six of these refs disappear**. They encode 'what camera commands I have already issued vs what state I want to be in' — a problem that does not exist when there is a single function saying 'the camera should be X at time t.'"

## Files to touch

- `src/components/MapView.tsx` — modify — delete the six refs and every line that reads or writes them. Delete the recordEvent imports and call sites.

## Deliverables

- Refs deleted: `lastFitRouteRef`, `lastFollowAtRef`, `lastFollowedClipRef`, `prevZoomRef`, `prevBearingRef`, `clipTransitionEndsAtRef`.
- All `recordEvent(...)` call sites in MapView gone (per §3.8: lines 502, 522, 527, 552, 596, 645, 650, 652, 661 — exact line numbers may have shifted after tasks 310/320, search for `recordEvent` in the file).
- The `recorder` prop is still in `MapViewProps` for now (its full removal is task 340).

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `npm run tauri dev`: app behaves equivalently. No console errors. No regressions vs after task 320.
- [ ] `grep -n "lastFollowAtRef\|lastFollowedClipRef\|prevZoomRef\|prevBearingRef\|clipTransitionEndsAtRef\|lastFitRouteRef" src/components/MapView.tsx` returns no results.
- [ ] `grep -n "recordEvent" src/components/MapView.tsx` returns no results.

## Implementation notes

This task is mostly mechanical deletion — most of these refs were only read inside Writers 1/4/5/6 and Writer 3, which tasks 310/320 already deleted. What remains are:

- Possibly `prevZoomRef` (used by the zoom-stepper writer at `MapView.tsx:496-503`). The migration doc's §3.8 table marks `prevZoomRef` as "Deleted." The zoom stepper writer still exists if its purpose is "user dragged the slider, set zoom directly" — but in the new model, the project-level zoom feeds into `mapSettings.zoom` which feeds into `buildMapTrack` → `track`, and the ease loop applies it on the next tick. So the zoom stepper writer becomes redundant; verify and delete if so. If a manual zoom slider needs to feel "instant," that's a UX call separate from this task — document and defer.

- The waypoint paint and source writers (`MapView.tsx:450-486`) do NOT use any of the six refs and are unaffected.

After deletion, run the app and exercise: project load, clip selection, playhead scrub, GPX load, map style change. None should regress.

The `recorder` prop survives this task because removing it touches `ProjectView.tsx` too — that's task 340.
