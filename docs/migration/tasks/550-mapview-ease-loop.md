# Task 550 — Update MapView ease loop to consume `cameraAt(timeline, t)`

**Step**: Compiled Timeline (Step 6)
**Estimated effort**: 1.5h
**Status**: pending
**Depends on**: 530, 540

## Goal

Update `MapView.tsx`'s per-frame ease loop to consume the new `cameraAt(timeline, t)` from the compiled timeline, in project-time. Per §"Implementation Plan → 6. Update MapView ease loop" of `docs/migration/COMPILED_TIMELINE_PLAN.md`. The lookahead pattern (`t + LOOKAHEAD_MS`) and the `easeTo({ duration: STEP_MS })` chase pattern stay — only the source of `t` and the evaluator function change.

## Files to touch

- `src/components/MapView.tsx` — modify — the existing ease loop (`MapView.tsx:442-490`, currently calling `cameraAt(track, t + LOOKAHEAD_MS)` with wall-clock `t`) becomes a project-time loop. `t` is read from props (the project-time playhead from task 540). The evaluator call becomes `cameraAt(timeline, t + LOOKAHEAD_MS)`.

## Deliverables

- `MapView` consumes `timeline: CompiledTimeline` and `playheadMs: number | null` (project-time).
- Each tick: `cameraAt(timeline, playheadMs + LOOKAHEAD_MS)` → `resolveIntent(intent, viewport)` → `easeTo({ ..., duration: STEP_MS, essential: true })`.
- `LOOKAHEAD_MS = 100`, `STEP_MS = 50` unchanged.
- Marker DOM management stays — its lng/lat updates from `locationAt(wallClockMs, indexedRoute, fallback)` where `wallClockMs` is derived from project-time per the active clip span (§"Time-Axis Translation"). This translation is the same one task 530 performs internally; expose a small helper if both call sites would otherwise duplicate it.
- No imperative camera writes outside the ease loop.

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `npm run tauri dev` runs and the live preview behaves correctly:
  - [ ] Clip-to-clip auto-advance plays the Van Wijk entry transition.
  - [ ] Manual selection of a clip seeks to `canonicalSeekMs` and the map lands on the correct camera.
  - [ ] In-clip follow continues to track the marker / GPX position smoothly.
  - [ ] Looping inside one clip behaves identically to today.
- [ ] Marker (lng/lat) tracks the playhead correctly through both clip spans and transition spans (during a transition, the marker can either freeze at the previous clip's last known position or smoothly interpolate — pick one, document).
- [ ] No reference to `MapTrack` / wall-clock `cameraAt` remains in `MapView.tsx` after this task.
- [ ] Tile-load behavior is unchanged (no new janks on rapid camera moves).

## Implementation notes

The §3.5 ease-loop pattern from the original migration doc (which task 310 introduced) carries over almost unchanged. The only edit is the evaluator call:

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
    const t = playheadMs ?? 0;                                        // project-time
    const intent = cameraAt(timeline, t + LOOKAHEAD_MS);              // NEW
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
}, [timeline, playheadMs]);
```

Note the dependency change: previously `[track]`; now `[timeline, playheadMs]` (or read `playheadMs` from a ref to avoid restarting the loop on every playhead tick — the existing code already does this for wall-clock playhead; preserve the pattern).

Marker position during a transition: when `t` is inside a `transitionSpan`, the marker has no canonical "position" because the camera is between two clips. Two simple options:

1. Hide the marker.
2. Hold the previous clip's last marker position until `t == transitionSpan.endMs`, then jump to the next clip's start.

Option 2 is consistent with current behavior (the marker doesn't disappear). Document the choice.

`mapBearing` prop and any other camera-related props: review and remove anything now driven by the ease loop. Bearing and pitch flow purely through `resolveIntent(intent, viewport)`.
