# Task 310 — Replace Writers 1, 4, 5, 6 with the live ease loop

**Step**: 3 (MapView refactor)
**Estimated effort**: 3h
**Status**: pending
**Depends on**: 300

## Goal

Replace the four imperative camera writers in `MapView.tsx` (the `runClipTransition` helper plus Writers 4, 5, 6) with the single per-frame ease loop from §3.5 that consumes `track` (added in task 300). Per §6.3 step 1: "Delete Writers 1, 4, 5 entirely. Delete the `runClipTransition` helper (`MapView.tsx:128-183`) and the `MapTransitionConfig` / `DEFAULT_MAP_TRANSITION` constants (`MapView.tsx:110-126`)." Per §6.3 step 2: "Replace Writer 6 with the live ease loop (§3.5). Marker DOM management is preserved as a data-driven update."

## Files to touch

- `src/components/MapView.tsx` — modify — delete `runClipTransition`, `MapTransitionConfig`, `DEFAULT_MAP_TRANSITION`. Delete Writer 4 (manual clip selection arc), Writer 5 (live bearing easeTo), Writer 6 (the follow ease loop). Add the §3.5 ease loop. Preserve marker DOM management (lng/lat updates from `cameraAt`'s underlying location math).

## Deliverables

- `runClipTransition` (lines ~128-183) — gone.
- `MapTransitionConfig` and `DEFAULT_MAP_TRANSITION` (lines ~110-126) — gone.
- Writer 4 (manual clip selection arc, lines ~533-554) — gone.
- Writer 5 (live bearing easeTo, lines ~513-528) — gone.
- Writer 6's three-part body (marker mgmt, clip-boundary transition, within-clip ease loop, lines ~557-668) — clip-boundary and within-clip portions gone; marker mgmt kept.
- A new `useEffect([track])` running the §3.5 tick loop with `LOOKAHEAD_MS=100`, `STEP_MS=50`, `easeTo({ duration: STEP_MS, essential: true })`.
- The marker's lng/lat each tick reads from the same `cameraAt`/`resolveIntent` pipeline (or directly from `locationAt(playheadMs, indexedRoute, fallback)` — either is fine, document the choice).

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `npm run tauri dev` runs and the live preview behaves equivalent to today's: smooth clip-to-clip handoff, marker tracks playhead, bearing rotates as configured.
- [ ] No reference to `runClipTransition`, `MapTransitionConfig`, `DEFAULT_MAP_TRANSITION` remains in `MapView.tsx`.
- [ ] Tested on a real ≥3-clip project against the existing app (pre-migration build, e.g. via `git stash` of these changes) — handoff is visually indistinguishable per §6.1's pass criterion A.
- [ ] `mapBearing` prop is no longer consumed for camera writes inside MapView (bearing comes from `resolveIntent` on the loop).

## Implementation notes

The §3.5 loop body (verbatim):

```ts
useEffect(() => {
  const map = mapRef.current;
  if (!map) return;
  const LOOKAHEAD_MS = 100;
  const STEP_MS      = 50;

  let raf = 0;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    const t   = clockToWallClock(now);
    const intent = cameraAt(track, t + LOOKAHEAD_MS);
    const viewport: Viewport = {
      width:  map.getContainer().clientWidth,
      height: map.getContainer().clientHeight,
      dpr: window.devicePixelRatio,
    };
    const target = resolveIntent(intent, viewport);
    map.easeTo({
      center: [target.center.lng, target.center.lat],
      zoom: target.zoom,
      bearing: target.bearing,
      pitch: target.pitch,
      duration: STEP_MS,
      essential: true,
    });
    raf = window.setTimeout(tick, STEP_MS);
  };

  tick();
  return () => { stopped = true; window.clearTimeout(raf); };
}, [track]);
```

The doc explains why this preserves the smooth handoff (§3.5): "Every 50ms we compute `target = cameraAt(playhead + 100ms_lookahead)`. We fire `map.easeTo(target, { duration: 100ms })`. MapLibre keeps chasing a moving target. ... Smooth clip-to-clip handoff is **identical** to today's behavior — same MapLibre interpolator, same continuous-camera-chasing-target model."

`clockToWallClock(now)` — implement as a helper that maps `performance.now()` to the project's wall-clock playhead. The current ProjectView already has playhead → wall-clock translation; mirror it. Alternative: pass `playheadMs` as a prop and just read it directly inside `tick`. Either works; the simpler one is to read `props.playheadMs` directly.

Marker DOM mgmt (preserved): keep the lazy-create marker pattern from `MapView.tsx:561-620`, but update its lng/lat from `locationAt(playheadMs, indexedRoute, fallback)` — same source today. The "no playhead but selection changed in follow mode" branch (lines 578-599) is no longer needed because the ease loop already chases the active anchor's intent on selection change.

§8.3 verification (bearing keyframe bleed at boundaries) is addressed in task 340 — flag any oddities here but do not fix.

Tasks 320 (Writer 3 region intent), 330 (delete refs), 340 (delete recorder) are independent of this task and can land in any order after 300.
