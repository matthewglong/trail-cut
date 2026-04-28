# Task 140 — Build CameraSpikeHarness with two-pane preview (HARD STOP)

**Step**: 1 (Spike)
**Estimated effort**: 3h
**Status**: pending
**Depends on**: 100, 110, 120, 130

## Goal

Build the dual-pane spike harness from §6.1 of the migration doc. Two MapLibre instances driven by the same `cameraAt(track, t)` and the same playhead, rendered side by side: one in the live aspect, one in a fixed 360×640 (9:16) box. The ease loop from §3.5 runs in both. This proves the new model produces preview-quality output for two different aspects from one project — the central thesis of the migration. The existing `MapView.tsx` is **not** touched in this task.

## Files to touch

- `src/dev/CameraSpikeHarness.tsx` — new — the two-pane harness component.
- `src/dev/cameraSpikeEaseLoop.ts` — new (optional) — the §3.5 ease loop extracted as a hook so both panes share logic.
- `src/App.tsx` — modify — mount the harness behind a query-param toggle (e.g., `?camera-spike=1`) or hidden route. Existing app behavior unchanged when toggle is off.

## Deliverables

- A dev-only screen reachable via `?camera-spike=1` (or similar) that:
  - Loads the currently-open project (clips + GPX route).
  - Builds a single `MapTrack` via `buildMapTrack`.
  - Renders two `<div>` panes side by side: pane A uses live container size, pane B is a fixed 360×640 box.
  - Each pane mounts its own `maplibregl.Map`.
  - One shared playhead clock drives both panes via the §3.5 ease loop.
  - Each pane calls `resolveIntent(cameraAt(track, t + 100ms), viewport)` and `easeTo` on every 50ms tick.
- Memory + frame-budget check: log `performance.memory.usedJSHeapSize` and the per-tick easeTo budget. If pane A frame rate drops below 30fps with both panes scrolling, document the result inline (§8.2 verification).
- Bearing-mode-auto sanity check: pick a project clip with `bearing_mode: 'auto'` and visually verify the arc rotation across a clip boundary (§8.3 spot check).

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `npm run tauri dev` shows the harness when query param is set, normal app otherwise.
- [ ] Both panes load tiles and run the ease loop; neither pane is blank.
- [ ] Both panes track the same playhead and never desync (verifiable by stopping the playhead at any t — both panes remain stable).
- [ ] The 9:16 pane shows visibly different framing than pane A for `region` intents on project load.
- [ ] Memory use under 500MB combined for both MapLibre instances over a 1-minute session (§8.2 pass criterion).
- [ ] Live pane stays at ≥30fps during clip-to-clip handoff (§8.2 pass criterion).

## Implementation notes

Ease loop body (verbatim §3.5):

```ts
const LOOKAHEAD_MS = 100;
const STEP_MS      = 50;

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
```

The migration doc is explicit (§3.5): "no `jumpTo` in preview. `jumpTo` would break the handoff illusion."

For pane B's fixed 360×640 box, hardcode the container width/height via inline style — do NOT scale. The whole point is to prove the same intent produces different framing at different aspects.

§8.2 verification: do a manual 1-minute session with both panes scrolling through the project, screenshot the Chrome DevTools Performance tab and the memory readout. If overhead is unacceptable, the spike has flagged it before Step 4 export builds two MapLibre instances for cross-fade later.

§8.1 (tile-load determinism) is NOT for this task — it belongs to task 430.

§8.3 (bearing-keyframe bleed at boundaries): eyeball the arc rotation on a project where two clips have very different direction-of-travel. If the rotation feels wrong, file a note for task 340 to address; do not fix here.

Pass criterion (§6.1):
- **A. Handoff parity** — clip-to-clip handoff visually indistinguishable from today's preview. Test side-by-side against the existing app on a real ≥3-clip project.
- **B. Aspect framing parity** — 9:16 pane reframes scenes that the wider pane only modestly reframes (e.g., region intent on initial route fit).

Fail signals (any → do not proceed):
- 9:16 pane shows the same camera as wide pane (forgot to pipe viewport through `resolveIntent`).
- Arc looks subtly different (likely `arcDurationMs` is off vs. `DEFAULT_MAP_TRANSITION`).
- Bearing snaps instead of arcs (`circularLerp` not wired).
- Two panes desync (two clocks instead of one shared playhead).

## HARD STOP

After this task, halt. Do not start the next task. Wait for human visual-parity review of the spike against the pass criteria above.
