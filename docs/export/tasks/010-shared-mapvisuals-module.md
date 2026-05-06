# Task 010 — Shared `mapVisuals` module + MapView refactor

**Step**: Export pipeline (foundational; precedes the renderer worker)
**Estimated effort**: 4–8h
**Status**: pending
**Depends on**: nothing — this task implements the "Single source of visual truth" principle in `docs/export/PLAN.md` §"Constraints and principles".

## Goal

Extract every visual decision currently inlined in `src/components/MapView.tsx` into a browser+Node-safe shared module under `src/lib/mapVisuals/`. Refactor `MapView.tsx` to consume it. After this task, the module is the single source of truth for both the preview map and the export renderer worker (task 020) — a change to marker color, route paint, waypoint styling, or any animation curve is a one-PR change in `mapVisuals/` that automatically applies to both surfaces.

This is the structural enforcement of the visual-parity invariant. Without it, the same kind of drift that the 500-series migration eliminated for the camera (`cameraAt` as the single evaluator) will reappear for layers, paint, and animation — and the export will silently disagree with the preview.

## Files to touch

- New: `src/lib/mapVisuals/index.ts` — public surface (re-exports).
- New: `src/lib/mapVisuals/styleSpec.ts` — `buildStyleSpec(mapSettings)` returning a complete MapLibre `StyleSpecification` for the chosen `map_style` mode (`default`, `satellite`, `3d`), including the conditional 3D-buildings layer.
- New: `src/lib/mapVisuals/sources.ts` — `buildStaticSourceData({route, clips, mapSettings})` for setup-time source data (full-route line, waypoint feature collection); `buildPerFrameSourceData(...)` for per-frame source updates (slime trail, live-marker point).
- New: `src/lib/mapVisuals/paints.ts` — `buildPerFramePaints(...)` for per-frame paint property updates (active-clip highlighting on `waypoints-circle`, marker pulse on `live-marker-pulse`).
- New: `src/lib/mapVisuals/animations.ts` — `pulseAt(t)` and any other project-time-driven animation primitives. Pure functions of `t`.
- New: `src/lib/mapVisuals/perFrame.ts` — `buildPerFrameState(timeline, projectTimeMs, indexedRoute, clips, mapSettings)`: the top-level per-frame entry point, composing camera + per-frame sources + paints. The single function preview's ease loop and the export worker both call.
- New: `src/lib/mapVisuals/types.ts` — types for `PerFrameState`, `PaintUpdates`, `PulseState`, etc.
- New: `src/lib/mapVisuals/__tests__/styleSpec.test.ts` — snapshot test per `map_style` value.
- New: `src/lib/mapVisuals/__tests__/animations.test.ts` — `pulseAt(t)` is periodic; `pulseAt(t)` and `pulseAt(t + period)` agree.
- New: `src/lib/mapVisuals/__tests__/perFrame.test.ts` — `buildPerFrameState` is pure (deterministic for fixed inputs).
- Modified: `src/components/MapView.tsx` — refactor to consume the module:
  - Replace inline style/source/layer definitions with `buildStyleSpec` and `buildStaticSourceData` calls.
  - Replace inline trail/marker/active-clip computation with `buildPerFrameState`.
  - **Drop** the DOM-based pulsing marker (`maplibregl.Marker` + CSS keyframes) entirely. The marker is now two stacked `circle` layers in the style spec, animated via `setPaintProperty` driven by `pulseAt(projectTimeMs)` from the ease loop tick.
  - Keep preview-only concerns in MapView: container element, `ResizeObserver`, `NavigationControl`, `AttributionControl`, click/hover handlers on `waypoints-circle`, the ease loop itself, React hooks wiring.

## Deliverables

A pure, browser+Node-safe module exporting (illustrative — consolidate if it feels artificial):

```ts
import type {
  StyleSpecification,
  GeoJSONSourceSpecification,
} from 'maplibre-gl';
import type {
  Clip, Route, MapSettings,
} from '../../types';
import type { CompiledTimeline } from '../cameraIntent';
import type { ResolvedCamera } from '../cameraIntent';
import type { IndexedRoute } from '../routeLocation';

export function buildStyleSpec(mapSettings: MapSettings): {
  style: StyleSpecification | string;
  defaultPitch: number;       // applied by consumer; 60 for '3d', 0 otherwise
};

export function buildStaticSourceData(args: {
  route: Route | null;
  clips: Clip[];
  mapSettings: MapSettings;
}): Record<string, GeoJSON.GeoJsonObject>;

export interface PerFrameState {
  camera: ResolvedCamera;
  sources: Record<string, GeoJSON.GeoJsonObject>;   // 'route-trail', 'live-marker'
  paints: PaintUpdates;                             // active-clip highlight, marker pulse
}

export function buildPerFrameState(
  timeline: CompiledTimeline,
  projectTimeMs: number,
  indexedRoute: IndexedRoute | null,
  clips: Clip[],
  mapSettings: MapSettings,
  viewport: { width: number; height: number; dpr: number },
): PerFrameState;

export interface PulseState { radius: number; opacity: number }
export function pulseAt(projectTimeMs: number): PulseState;
```

## Acceptance criteria

- [ ] No `window`, `document`, `navigator`, `requestAnimationFrame`, or other browser-only globals referenced anywhere under `src/lib/mapVisuals/`. (Grep: `grep -r "window\|document\|navigator\|requestAnimationFrame" src/lib/mapVisuals/` returns no matches.)
- [ ] No `maplibregl.Marker` reference in `src/components/MapView.tsx` after the refactor. The live marker is two `circle` layers in the style spec.
- [ ] No `LIVE_MARKER_PULSE_KEYFRAMES` (or any CSS-keyframe-based animation) in `MapView.tsx`. All animation is project-time-driven via `pulseAt`.
- [ ] `MapView.tsx` LOC drops meaningfully (rough target: 30–40% smaller). Verifiable via `git diff --stat`.
- [ ] Visual smoke test passes: with `npm run tauri dev`, load a project with a route + clips, scrub the timeline. (a) Marker pulses with project-time — pausing freezes the pulse mid-cycle, (b) routes / waypoints / trail look the same as before, (c) `default`, `satellite`, and `3d` style modes all still work, (d) clicking a waypoint still selects the corresponding clip, (e) hovering a waypoint still changes cursor.
- [ ] Unit tests cover: style spec snapshots for `default` / `satellite` / `3d`; `pulseAt` periodicity (`pulseAt(t) === pulseAt(t + period)` within tolerance); `buildPerFrameState` purity (same inputs → same output across calls).
- [ ] `npm run test:run` passes. `npm run build` passes. `npm run lint` passes.
- [ ] No new runtime dependencies in `package.json`. (The module composes existing pure utilities + maplibre-gl type imports only.)

## Implementation notes

**The marker as layers.** Replace the DOM marker with two `circle` layers in the style spec, both sourced from a single GeoJSON `live-marker` source:

- `live-marker-pulse` — outer pulse ring. Per-frame `circle-radius` and `circle-opacity` driven by `pulseAt(projectTimeMs)`. Pulse curve: ease-out from radius=8/opacity=0.55 to radius=22/opacity=0, period ~1.6s (matches today's CSS animation).
- `live-marker-dot` — inner solid dot. Static paint (white fill, `colors.accent` stroke at 3px).

Both layers' source `data` is updated per frame from `buildPerFrameState` — single `Point` feature when `markerTrace` resolves; empty `FeatureCollection` otherwise.

**Pulse animation correctness.** Today's CSS keyframe animation runs on wall-clock — pausing playback continues to pulse, scrubbing produces no pulse-vs-content correlation. After this task, `pulseAt(projectTimeMs)` is a pure function of project-time; pause freezes the pulse mid-cycle, scrub aligns pulse-to-content, export reproduces it identically. This is a small preview UX improvement in addition to enabling export parity.

**`buildPerFrameState` purity contract.** Same `(timeline, projectTimeMs, indexedRoute, clips, mapSettings, viewport)` → same output. No closures over external state, no `Date.now()`, no `Math.random()`. This is what makes export reproducible at any sampled `t` and what allows preview/export parity verification (task 120) to be a strict equality check.

**Static vs. per-frame split.** Mirrors what's already in `MapView.tsx`:
- *Static* (set on setup, on `route` change, or on `mapSettings` change): full-route line geometry; waypoint feature collection (id + index + position); style spec itself.
- *Per-frame*: slime-trail polyline (rebuilt to current head), live-marker source (one point or empty), active-clip paint, pulse paint.

**Active-clip highlighting.** Keep it as data-driven paint expressions (`['case', ['==', ['get', 'id'], active_id], ...]`) on `waypoints-circle`. The per-frame paint update is one `setPaintProperty('waypoints-circle', 'circle-color', expr)` call with the new active id baked in; no layer churn.

**3D mode.** `add3DBuildings`'s logic and `pitch=60` become part of `buildStyleSpec('3d')`'s output. Pitch isn't a style property, so `buildStyleSpec` returns both the `StyleSpecification` and a `defaultPitch` the consumer applies via `easeTo({pitch})` (preview) or `map.render({pitch})` (export).

**Visited-mode trail.** `trailUpTo(wallMs, indexedRoute)` already exists in `src/lib/routeLocation.ts` as a pure function; reuse it. The wall-clock translation (`markerTrace`) is also pure logic — extract from `MapView.tsx` into `mapVisuals/perFrame.ts` (or a small `wallClockTrace.ts` helper).

**What stays in `MapView.tsx`** (preview-only):
- Container element creation, `ResizeObserver`, `NavigationControl`, `AttributionControl`.
- Click + hover handlers on `waypoints-circle`.
- The ease loop (`easeTo` + `pickEaseDurationMs`). The export worker uses `map.render({...camera})` per frame and doesn't ease.
- React hooks (`useEffect`, `useRef`, etc.) wiring project state into the map instance.

The pattern: every `addLayer` / `addSource` / `setPaintProperty` / `setData` call in MapView reads its argument from a `mapVisuals/` function. MapView orchestrates *when* those updates happen (on style.load, on route change, per ease-loop tick); the module owns *what* the updates are.

**What does NOT belong in `mapVisuals/`.** Anything that reads from React state, refs, or DOM. Anything that subscribes to events. Anything that touches `window`/`document`. The module is plain TS, runnable in any V8.

**Testing.** Use the existing Vitest setup. Style-spec snapshot tests catch accidental visual regressions. For `buildPerFrameState`, table-driven tests at sampled `t` values (e.g., t=0, t=mid-clip, t=mid-transition, t=end) are sufficient. For `pulseAt`, test periodicity and that the curve is monotonic within each half-period.

## Open questions deferred to follow-up tasks

- Whether `buildPerFrameState` should also return `viewport`-derived info (it currently takes viewport as input for `resolveIntent` only). Likely not — keep the contract narrow.
- Whether `defaultPitch` belongs in `buildStyleSpec`'s return or as a sibling `defaultCameraOverrides` function. Consolidate as it feels right during implementation.
- The exact pulse curve (ease-out shape, radius/opacity ranges) — start by matching today's CSS animation, tune in a follow-up if it doesn't translate cleanly.

## Doc tie-in

This task is the structural implementation of the "Single source of visual truth" principle in `docs/export/PLAN.md` §"Constraints and principles" and the precondition for the IPC contract in PLAN.md §"Rust → renderer worker". After it lands, task 020 (renderer worker) imports from `src/lib/mapVisuals/` directly via the worker's TypeScript build (esbuild → CJS), and visual parity is enforced by the build graph rather than by review discipline.
