# Task 320 — Convert Writer 3 (full-route fitBounds) to a region intent

**Step**: 3 (MapView refactor)
**Estimated effort**: 1h
**Status**: pending
**Depends on**: 300, 310

## Goal

Replace Writer 3 (`MapView.tsx:380-408`) — the imperative `map.fitBounds` call that frames the full route on first load — with a one-shot `region` intent applied via `resolveIntent` against the live viewport, per §6.3 step 3 of the migration doc.

## Files to touch

- `src/components/MapView.tsx` — modify — delete the Writer 3 `useEffect` and the `lastFitRouteRef` guard. Replace with logic that, on first route load, builds a `region` intent for the route's bounds and applies it via `resolveIntent` + `map.jumpTo` (or `easeTo` with a duration of 0).

## Deliverables

- Writer 3 (full-route fitBounds, lines ~380-408) — gone.
- New: a one-shot effect (or part of an existing init effect) that detects "first time we see this route" and calls `resolveIntent({ kind: 'region', bounds: routeBounds, padding: 0.06, bearing: 0, pitch: 0 }, viewport)` and applies the result.
- The `lastFitRouteRef` guard — gone (the new effect's dep array on `route` plus an internal `appliedRouteRef` keeps idempotence, OR the effect simply checks `prev !== route`).

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `npm run tauri dev`: opening a project with a GPX route shows the camera framing the full route on first load — same framing as before within a small padding tolerance.
- [ ] Loading a different project reframes for the new route.
- [ ] The fit happens exactly once per route load (no flicker, no re-fit on unrelated state changes).

## Implementation notes

Algorithm:

1. Compute route bounds from the parsed `Route` (min/max lng+lat across trackpoints). If none of the trackpoints have lat/lng (degenerate), skip.
2. Build the intent: `{ kind: 'region', bounds: { sw: {lng: minLng, lat: minLat}, ne: {lng: maxLng, lat: maxLat} }, padding: 0.06, bearing: 0, pitch: 0 }`.
3. Resolve via `resolveIntent(intent, viewport)` where `viewport` is read from `map.getContainer()`'s client size and `window.devicePixelRatio`.
4. Apply: `map.jumpTo({ center: [center.lng, center.lat], zoom, bearing, pitch })`. Use `jumpTo` (not `easeTo`) for the initial fit — there's no continuity to preserve here, and the §3.5 ease loop will pick up smoothly from this state on the next tick.

Padding `0.06` matches the follow-anchor default in §3.2; for a region intent on initial load this gives a comfortable inset on the smaller viewport edge. Today's writer uses pixel padding 60 (`MapView.tsx:403`) — at a typical 720×600 pane this is ~10% of the smaller dim, so 0.06 is comparable. If the spike (task 140) found a different value, use that.

This task interacts with the §3.5 ease loop from task 310: the loop fires every 50ms once `track` is present. If the route loads after the first track build, the loop may try to ease to a follow anchor while this one-shot region fit is happening. Two options:
1. Apply the region fit synchronously inside the same effect that builds `track`, before the first tick fires.
2. Skip — let the loop handle the framing once anchors are present (in which case Writer 3 is just deleted).

The migration doc's §6.3 says "Convert Writer 3 ... into a one-shot `region` intent applied via `resolveIntent` against the live viewport." Pick option 1 — the user expects the route to be visible immediately on project load, before any anchors take effect. Document the choice in a comment.
