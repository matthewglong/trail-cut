# Map Architecture Migration: From Imperative Preview to Pure `cameraAt(t)`

> Audience: an engineer or agent picking this up cold. Read top to bottom.
> Every claim about today's behavior is anchored to a file path and line
> number. Every target-state design item is concrete enough to start coding
> without further design questions.

Source-of-truth files cited throughout this document:

- `CLAUDE.md` — project overview and phase status
- `ARCHITECTURE.md` — long-form architecture doc (especially the export
  pipeline at `ARCHITECTURE.md:208-241`)
- `src/components/MapView.tsx` — the imperative map driver (699 lines)
- `src/hooks/useMapRecorder.ts` — debug recorder hook (172 lines)
- `src/hooks/useProject.ts` — project state hook
- `src/lib/routeLocation.ts` — pure location/bearing math (400 lines)
- `src/screens/ProjectView.tsx` — wires everything together
- `src/types.ts` — frontend data model
- `src-tauri/src/models.rs` — Rust persistence model
- `src-tauri/src/commands/project.rs` — `save_project` / `load_project`

---

## 1. Why this migration

Phase 3 (Export) is "render the final video" (see `CLAUDE.md:75`). Today the
preview is *imperative and stateful*: React effects in `MapView.tsx` fire
`easeTo` / `flyTo` on every state change, and MapLibre's internal
interpolator decides what camera state actually exists at any millisecond.
The throttles and gates (`lastFollowAtRef`, `clipTransitionEndsAtRef`,
GATED/THROTTLED events surfaced by the debug recorder) exist *because*
multiple imperative writers compete for camera state in real time. There
is no function that answers **"what should the camera be at exactly
t=4.237s?"** — only **"what is it now, given runtime history."** This makes
deterministic frame-by-frame export impossible. The Debug recorder
(`src/hooks/useMapRecorder.ts`) exists to reconcile *intent* vs *actual* —
itself a symptom of the wrong paradigm. The migration replaces the
imperative driver with a pure `cameraAt(t)` function and an
aspect-ratio-agnostic `CameraIntent` so that a single project specification
can drive both the live preview and the offline export, at any output
aspect, with frame-accurate determinism.

---

## 2. Current state

This section is a guided tour of every imperative camera writer, every
gate/throttle, and every implicit aspect-aware decision in the live
preview. File:line ranges are exact.

### 2.1 The single map instance and its props contract

`MapView` is mounted from `src/screens/ProjectView.tsx:553-562`:

```tsx
<MapView
  clips={clips}
  selectedClipId={selectedClipId}
  route={route}
  playheadMs={playheadMs}
  mapSettings={toolbarSettings}
  mapBearing={effectiveBearing}
  onSelectClip={handleSelectClip}
  recorder={recorder}
/>
```

`MapView`'s prop interface lives at `src/components/MapView.tsx:16-30`. Of
note: `mapBearing` is *already resolved* upstream (in
`ProjectView.tsx:199-205`) by sampling `bearingFromKeyframes` at
`playheadMs ?? clipTimeRange.startMs`. Everything else (zoom, follow mode,
route mode, etc.) is read out of `mapSettings`. There is no concept of
"camera at time t" anywhere — only "camera now, given current props."

### 2.2 Map initialization and the embedded viewport

`MapView.tsx:229-361` initializes a single `maplibregl.Map` instance bound
to the live DOM container `containerRef`. The map's viewport is
*implicitly* the size of that container, and is reactive only via:

```ts
const resizeObserver = new ResizeObserver(() => map.resize());
resizeObserver.observe(containerRef.current);
```

(`MapView.tsx:243-244`). All viewport-aware calls inside the file —
`map.cameraForBounds(...)` at `MapView.tsx:160`, `map.fitBounds(...)` at
`MapView.tsx:403`, every `flyTo`/`easeTo` — implicitly use whatever
rectangle that container currently has on screen. **There is no way today
to ask "what camera frames these bounds for a viewport of width W, height H
that does not exist on screen?"** That capability is the central thing
export needs.

### 2.3 Inventory of imperative camera writers in `MapView.tsx`

There are **seven** distinct imperative writers in `MapView.tsx`. Each one
is a React `useEffect` that, when its deps change, calls one of
`map.setZoom`, `map.easeTo`, `map.flyTo`, or `map.fitBounds`. They run in
no particular order and any two of them can stomp the same pending
animation.

#### Writer 1 — `runClipTransition` helper (Van Wijk arc)

Defined at `MapView.tsx:128-183`. Called by Writers 4 and 6 below. Two
branches:

- **Fast path (`MapView.tsx:142-154`)**: if the destination is inside the
  current viewport (`map.getBounds().contains(endLngLat)`), fire a flat
  `easeTo` to the target.
- **Arc path (`MapView.tsx:157-181`)**: otherwise compute a peak zoom that
  fits both endpoints via `map.cameraForBounds` (viewport-aware!), then
  fire a `flyTo` with `minZoom: peakZoom` to pin the arc apex.

Returns a duration in ms. The **viewport-awareness** in `cameraForBounds`
is one of the two things we will need to lift out of MapLibre into pure
code (see §5).

The duration model lives in `DEFAULT_MAP_TRANSITION` at
`MapView.tsx:119-126`:

```ts
{ baseMs: 1100, msPerZoomLevel: 580, minDurationMs: 1100,
  maxDurationMs: 7000, fitPaddingPx: 80, curve: 1.42 }
```

i.e. duration scales with the sum of `(startZoom - peakZoom) +
(targetZoom - peakZoom)`, clamped. This is the implicit "transition feel"
heuristic that the project-level "transition feel" knob (§3.6) replaces.

#### Writer 2 — Map style switch

`MapView.tsx:365-377`. On `mapSettings.map_style` change, calls
`map.setStyle(...)` and a 400ms `easeTo({pitch: ...})`. Doesn't modify
center/zoom/bearing, but resets `styleReadyRef` and gates Writers 3, 5, 6,
7 via the `if (styleReadyRef.current) apply()` pattern.

#### Writer 3 — Full-route fitBounds

`MapView.tsx:380-408`. Whenever a new route loads, calls
`map.fitBounds(bounds, { padding: 60, duration: 0 })`. This is the second
viewport-aware MapLibre call we have to lift out (see §5). The
`lastFitRouteRef` guard ensures it only fires once per route.

#### Writer 4 — Manual clip selection arc (follow OFF)

`MapView.tsx:533-554`. When the selected clip changes *and*
`mapSettings.follow_playhead` is false, runs `runClipTransition` from the
current center to the clip's waypoint. Sets:

```ts
clipTransitionEndsAtRef.current = performance.now() + duration;
prevBearingRef.current = mapBearingRef.current;
```

— two pieces of cross-effect state used by Writer 5 to avoid stomping the
in-flight animation.

#### Writer 5 — Live bearing updates

`MapView.tsx:513-528`. Fires whenever `mapBearing` (the resolved bearing
from `ProjectView`) changes. The body:

```ts
if (prevBearingRef.current === mapBearing) return;
if (performance.now() < clipTransitionEndsAtRef.current) {
  const left = Math.round(clipTransitionEndsAtRef.current - performance.now());
  recordEvent(`bearing:GATED(${left}ms)`);
  return;
}
prevBearingRef.current = mapBearing;
map.easeTo({ bearing: mapBearing, duration: 300, essential: true });
```

This is the *bearing gate*. Without it (the comment at
`MapView.tsx:518-519` is explicit), a bearing-only `easeTo` fired
mid-transition would cancel the in-flight `flyTo` and "leave the zoom arc
stranded at its interrupted frame."

#### Writer 6 — Live playhead marker + follow ease loop

`MapView.tsx:557-668`. The largest and most subtle effect. It does *three*
things in one body:

1. **Marker management** (`MapView.tsx:561-620`): resolves the live
   location via `locationAt(playheadMs, indexedRoute, fallback)`, lazy-
   creates a DOM marker, updates its lng/lat. Removes the marker when
   `resolved` is null. There is a side branch at `MapView.tsx:578-599`
   that handles "no playhead, but selection changed in follow mode" — it
   runs `runClipTransition` so the first clip on project load gets its
   zoom and center applied.

2. **Clip-boundary transition** (`MapView.tsx:625-645`): when
   `selectionChanged` (i.e. `lastFollowedClipRef.current !== selectedClipId`),
   targets the clip's waypoint (GPX-snapped, not the raw playhead — comment
   at `MapView.tsx:629-631`) and runs `runClipTransition`. Updates
   `clipTransitionEndsAtRef`, `lastFollowAtRef`, `prevBearingRef`.

3. **Within-clip tracking ease loop** (`MapView.tsx:646-663`): if
   selection didn't change, gate-throttle:
   - **GATED** if `clipTransitionEndsAtRef.current - now > 0` — a clip
     transition is in flight.
   - **THROTTLED** if `now - lastFollowAtRef.current <= 100` — already
     fired within the last 100ms (~10Hz cap).
   - **Otherwise** fire `map.easeTo({ center, bearing, duration: 220 })`
     and update `lastFollowAtRef`.

The "follow:GATED(...)" / "follow:THROTTLED(...)" / "follow:easeTo ..."
labels surfaced by the recorder come from `MapView.tsx:650, 652, 661`
respectively.

#### Writer 7 — Slime-trail data

`MapView.tsx:671-684`. Calls `src.setData(trailUpTo(playheadMs, indexedRoute))`
to update the visited-route GeoJSON source. This is the only writer that
*doesn't* touch the camera — but it shares the same "fire on every prop
change" pattern.

#### Plus: zoom and waypoint paint writers

- `MapView.tsx:496-503` — `map.setZoom(mapSettings.zoom)` on stepper
  changes. The comment explains why it's `setZoom` (instant) rather than
  `easeTo`: an `easeTo` would be cancelled by Writer 6's center-only
  `easeTo` firing on the next playhead update.
- `MapView.tsx:450-466` — waypoint source data update.
- `MapView.tsx:469-486` — waypoint paint properties (selection styling).

### 2.4 Cross-effect state (the gates and throttles)

All defined at `MapView.tsx:212-223`:

```ts
const lastFitRouteRef = useRef<Route | null>(null);
const lastFollowAtRef = useRef<number>(0);
const lastFollowedClipRef = useRef<string | null>(null);
const prevZoomRef = useRef<number>(mapSettings.zoom);
const prevBearingRef = useRef<number>(mapBearing);
const clipTransitionEndsAtRef = useRef<number>(0);
```

Each ref encodes a *runtime invariant that the imperative writers must
collectively maintain*:

| Ref | Invariant it enforces | Defended at |
|---|---|---|
| `lastFitRouteRef` | Don't re-fit bounds on the same route | `MapView.tsx:399` |
| `lastFollowAtRef` | Don't fire follow `easeTo` more than ~10Hz | `MapView.tsx:651` |
| `lastFollowedClipRef` | Detect clip-boundary crossings | `MapView.tsx:579, 626` |
| `prevZoomRef` | Don't redundantly setZoom on mount | `MapView.tsx:499` |
| `prevBearingRef` | Don't redundantly easeTo bearing | `MapView.tsx:516, 525` |
| `clipTransitionEndsAtRef` | Don't stomp an in-flight clip transition | `MapView.tsx:520, 648` |

In a pure-function model, **all six of these refs disappear**. They
encode "what camera commands I have already issued vs what state I want
to be in" — a problem that does not exist when there is a single function
saying "the camera should be X at time t."

### 2.5 The debug recorder as a symptom

`src/hooks/useMapRecorder.ts` (172 lines) exists for one reason: to
reconcile *intent* (what we wanted the camera to do) against *actual*
(what MapLibre's internal interpolator produced).

- The frame sampler at `useMapRecorder.ts:94-117` polls
  `map.getZoom()/getBearing()/getPitch()/getCenter()/isMoving()` on every
  RAF tick, and writes a TSV row.
- The event log (`useMapRecorder.ts:78-85`, mirrored from
  `MapView.tsx:502, 522, 527, 552, 596, 645, 650, 652, 661`) records every
  `easeTo`/`flyTo`/`setZoom` we *issued*, plus every GATED/THROTTLED skip.
- The popover renders dimmed rows for `GATED`/`THROTTLED` events
  (`ProjectView.tsx:471`), so a developer can eyeball when intent
  diverges from actual.

**This entire tool exists because today there is no "expected camera at t"
to compare against.** In the target model, this divergence cannot exist
in the preview by construction (both come from the same `cameraAt(t)`),
and in the export it is impossible (the camera is a deterministic function
of t). The recorder can be deleted as soon as the new model lands.
Recorder wiring in `ProjectView.tsx:209-216` and
`ProjectView.tsx:438-482` should be removed in the same change set.

### 2.6 Implicit aspect-awareness today

There is no aspect-ratio configuration anywhere in `MapView.tsx`. The map
just renders into whatever rectangle the live DOM gives it
(`ProjectView.tsx:543, 552`, `H_CLIPS_*` and `V_SPLIT_*` constants at
`ProjectView.tsx:23-28`). The two viewport-aware MapLibre calls:

- `map.cameraForBounds(...)` at `MapView.tsx:160`
- `map.fitBounds(...)` at `MapView.tsx:403`

…both implicitly use the live container's pixel size. This means **the
preview's framing decisions are silently bound to the live layout**, and
there is no way to ask the same project "what camera would I use if my
viewport were 1080×1920 (9:16) instead of 720×600 (the current pane)?"
The export pipeline planned in `ARCHITECTURE.md:225-241` cannot be built
on this primitive without a refactor.

### 2.7 Pure code already in place

The good news: `src/lib/routeLocation.ts` is already pure
(`routeLocation.ts:1-9` — explicit "zero React, MapLibre, or DOM
dependencies"). It contains:

- `parseTimestamp` (`routeLocation.ts:24-36`) — ISO-8601 + ExifTool format
- `indexRoute` (`routeLocation.ts:59-79`) — sorted, time-indexed route
- `locationAt` (`routeLocation.ts:100-141`) — t → lat/lng (linear,
  fallback-aware)
- `trailUpTo` (`routeLocation.ts:147-184`) — visited-trail LineString
- `clipWaypointLocation` (`routeLocation.ts:197-210`)
- `forwardAzimuth` (`routeLocation.ts:233-247`)
- `bearingAt` / `bearingFromKeyframes` / `computeBearingKeyframes`
  (`routeLocation.ts:255-390`) — bearing math with circular interpolation
- `circularLerp` (`routeLocation.ts:299-308`)

This file is already shaped to be the substrate of `cameraAt`. **It has
zero tests today** — see §6.2.

### 2.8 Persistence model recap

For reference when designing migration-compatible types:

- Rust `Project` (`src-tauri/src/models.rs:222-234`) holds `clips`, `route`,
  `exports`, optional `map_settings`.
- Rust `MapSettings` (`src-tauri/src/models.rs:139-157`) and per-clip
  `map_overrides` (`src-tauri/src/models.rs:55-72,
  187-205`) — already in place.
- Save/load: `src-tauri/src/commands/project.rs:24-41` — straight serde
  JSON, no migration needed for the new model since `CameraIntent` is
  derived from existing fields.
- Frontend mirror types: `src/types.ts:75-105` (`MapSettings`,
  `DEFAULT_MAP_SETTINGS`) and `src/types.ts:38, 53` (`MapOverrides`).

The data model already supports the agreed design: anchors are derived
from clips + their per-clip `map_overrides`. **The camera migration
itself requires no persisted-format change.** Two adjacent persistence
improvements (route extraction, schema versioning) are detailed in §3.9 —
they are independent of the camera work but cheap to fold in.

---

## 3. Target state

A pure, deterministic `cameraAt(t)` function is the single source of truth
for both live preview and offline export. It returns a `CameraIntent` —
aspect-ratio-agnostic. A separate `resolveIntent(intent, viewport)`
resolves it to a concrete `{center, zoom, bearing, pitch}` for whatever
rectangle the renderer is drawing into. **Same `cameraAt`, different
viewports → naturally correct framing for any aspect from one project.**

### 3.1 The `CameraIntent` type

Add a new file `src/lib/cameraIntent.ts` (location is a recommendation;
keep it next to `routeLocation.ts` since the two compose). It defines the
following types:

```ts
import type { IndexedRoute, BearingKeyframe } from './routeLocation';
import type { BearingMode } from '../types';

export interface LngLat {
  lng: number;
  lat: number;
}

export interface Bounds {
  /** Southwest corner */
  sw: LngLat;
  /** Northeast corner */
  ne: LngLat;
}

export interface Viewport {
  /** Pixel width of the rectangle the camera will render into. */
  width: number;
  /** Pixel height of the rectangle the camera will render into. */
  height: number;
  /** Device pixel ratio, used for raster style sharpness. Default 1. */
  dpr?: number;
}

export interface ResolvedCamera {
  center: LngLat;
  zoom: number;
  bearing: number;
  pitch: number;
}

/** Padding around content when fitting bounds, expressed as a *fraction*
 *  of the viewport's smaller dimension. Range: [0, 0.5).
 *
 *  This is the chosen unit for the strict aspect-ratio-agnosticism goal:
 *  pixel padding is rejected because the same N-pixel inset has wildly
 *  different visual proportions in a 360-wide vertical strip vs. a
 *  1920-wide landscape strip. A fractional inset against the *smaller*
 *  dimension scales sensibly at any aspect — a value of `0.06` always
 *  means "6% of the shorter edge." `resolveIntent` is the only function
 *  that knows the viewport's pixel dimensions and converts this fraction
 *  to pixels there.
 *
 *  Symmetric on all four edges. Asymmetric padding is intentionally
 *  out of scope; if a future feature needs it, it goes on `resolveIntent`'s
 *  call site as a `RenderHints` argument, not on the intent. */
export type Padding = number;

export type CameraIntent =
  | {
      kind: 'point';
      center: LngLat;
      zoom: number;
      bearing: number;
      pitch: number;
    }
  | {
      kind: 'region';
      bounds: Bounds;
      padding: Padding;
      bearing: number;
      pitch: number;
    }
  | {
      kind: 'follow';
      /** Wall-clock ms — same time-base as `IndexedRoute.points[].timeMs`. */
      playheadMs: number;
      route: IndexedRoute;
      targetZoom: number;
      bearingMode: BearingMode;
      /** Fractional padding around the moving point. Reserved for future
       *  "frame the marker plus N meters" extensions; ignored today. */
      padding: Padding;
      /** Used in 'fixed' bearing mode. Ignored in 'auto'. */
      fixedBearingDegrees?: number;
      /** Precomputed once per anchor in `buildMapTrack` and frozen on the
       *  intent. Used in 'auto' bearing mode. Empty array in 'fixed' mode.
       *  Precomputing here keeps `resolveIntent` pure in (intent, viewport)
       *  with zero coupling back to `IndexedRoute` math at render time. */
      bearingKeyframes: BearingKeyframe[];
      /** Pitch (degrees). Default 0 for 'default' / 'satellite' styles, 60 for '3d'. */
      pitch: number;
    };
```

**Why three kinds?**

- `point`: a fully-specified camera. The simplest anchor — used when a
  clip has explicit zoom + bearing and we don't care about fit.
- `region`: "frame these bounds." Used for the initial route fitBounds
  (Writer 3 today) and for any future "fit clip + N seconds of route"
  annotation. Aspect-agnostic because `bounds + padding` doesn't pre-bake
  a viewport; `resolveIntent` computes the zoom that fits.
- `follow`: "track the playhead" — the live within-clip tracking that
  Writer 6 does today. Carries the route reference because it has to
  resolve `locationAt(playheadMs, route, …)` in `resolveIntent`.

### 3.2 The `cameraAt(t)` function

```ts
import type { Clip, MapSettings, MapOverrides } from '../types';
import { resolveMapSettings } from '../types';
import {
  parseTimestamp, locationAt, indexRoute,
  clipWaypointLocation, computeBearingKeyframes,
  type IndexedRoute, type BearingKeyframe,
} from './routeLocation';

/** A timeline anchor. One per clip. The MapTrack contains *only anchors*. */
export interface MapAnchor {
  /** Wall-clock ms when this anchor takes effect (== clip start). */
  timeMs: number;
  /** Wall-clock ms when this anchor ends (== clip end). */
  endTimeMs: number;
  /** The intent active for the duration of the clip. */
  intent: CameraIntent;
}

/** A pure timeline. Built from (clips, route, mapSettings). No DOM. */
export interface MapTrack {
  anchors: MapAnchor[];
  /** Project-level "transition feel" knob. See §3.6. */
  transitionFeel: TransitionFeel;
}

export type TransitionFeel = 'natural' | 'snappy' | 'slow';

/** Build a MapTrack from project state. Pure. */
export function buildMapTrack(
  clips: Clip[],
  route: IndexedRoute | null,
  projectMapSettings: MapSettings,
  transitionFeel: TransitionFeel = 'natural',
): MapTrack {
  const anchors: MapAnchor[] = [];
  for (const clip of clips) {
    if (clip.visible === false) continue;
    if (!clip.created_at) continue;
    const baseMs = parseTimestamp(clip.created_at);
    if (Number.isNaN(baseMs)) continue;
    const inMs  = clip.trim?.in_ms  ?? 0;
    const outMs = clip.trim?.out_ms ?? clip.duration_ms ?? 0;
    if (outMs <= inMs) continue;

    const settings = resolveMapSettings(projectMapSettings, clip.map_overrides);
    const startMs = baseMs + inMs;
    const endMs   = baseMs + outMs;
    const intent  = anchorIntentForClip(clip, settings, route, startMs, endMs);
    anchors.push({ timeMs: startMs, endTimeMs: endMs, intent });
  }
  anchors.sort((a, b) => a.timeMs - b.timeMs);
  return { anchors, transitionFeel };
}

/** Pick the right CameraIntent kind for an anchor based on per-clip settings.
 *
 *  For `follow` anchors in `auto` bearing mode, we precompute the
 *  bearing-keyframe table here (once per anchor, frozen on the intent)
 *  rather than evaluating it lazily inside `resolveIntent`. This keeps
 *  `resolveIntent` pure in `(intent, viewport)` with no transitive
 *  dependency on `IndexedRoute` math at render time, and matches the
 *  resolution today's `effectiveBearing` memo applies in
 *  `ProjectView.tsx:199-205`. */
function anchorIntentForClip(
  clip: Clip,
  settings: MapSettings,
  route: IndexedRoute | null,
  anchorStartMs: number,
  anchorEndMs: number,
): CameraIntent {
  const pitch = settings.map_style === '3d' ? 60 : 0;

  if (settings.follow_playhead && route) {
    const bearingKeyframes: BearingKeyframe[] =
      settings.bearing_mode === 'auto'
        ? computeBearingKeyframes(
            anchorStartMs, anchorEndMs, route, settings.bearing_stops,
          )
        : [];
    return {
      kind: 'follow',
      playheadMs: anchorStartMs,   // overwritten per-frame by cameraAt
      route,
      targetZoom: settings.zoom,
      bearingMode: settings.bearing_mode,
      padding: 0.06,                // fraction of min(viewport.w, viewport.h)
      fixedBearingDegrees: settings.bearing_degrees,
      bearingKeyframes,
      pitch,
    };
  }
  // Fallback: a static point on the clip's waypoint.
  const wp = clipWaypointLocation(clip, route);
  return {
    kind: 'point',
    center: wp ? { lng: wp.lng, lat: wp.lat } : { lng: 0, lat: 0 },
    zoom: settings.zoom,
    bearing: settings.bearing_mode === 'fixed' ? settings.bearing_degrees : 0,
    pitch,
  };
}

/** The single source of truth.
 *  Returns the intent that should be active at wall-clock time t.
 *  Pure: deterministic in (track, t). No hidden state. No MapLibre.
 *
 *  Output kinds:
 *    - inside a clip's anchor range  → that anchor's intent (any kind)
 *    - in a gap between two anchors  → always a `point` intent
 *      (gap interpolation is intrinsically a center+zoom+bearing+pitch
 *      operation, not a fit-bounds operation; see `interpolateAnchors`
 *      in §3.4 for why) */
export function cameraAt(track: MapTrack, t: number): CameraIntent {
  const { anchors } = track;
  if (anchors.length === 0) {
    return DEFAULT_INTENT;
  }
  // Before first clip: hold the first anchor.
  if (t <= anchors[0].timeMs) {
    return liveIntent(anchors[0].intent, t);
  }
  // After last clip: hold the last anchor.
  const last = anchors[anchors.length - 1];
  if (t >= last.endTimeMs) {
    return liveIntent(last.intent, last.endTimeMs);
  }

  // Find the active or bracketing anchors.
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    if (t >= a.timeMs && t <= a.endTimeMs) {
      // Inside clip i — return the live (per-frame) intent.
      return liveIntent(a.intent, t);
    }
    const next = anchors[i + 1];
    if (next && t > a.endTimeMs && t < next.timeMs) {
      // Gap between clips — interpolate using Van Wijk & Nuij.
      // The interpolation is performed on a *resolved* form of each
      // anchor, evaluated at a canonical viewport. resolveIntent is
      // applied later by the renderer; the gap interp happens at the
      // intent level in a renderer-agnostic way (see §3.4).
      return interpolateAnchors(a, next, t, track.transitionFeel);
    }
  }
  return liveIntent(last.intent, last.endTimeMs);
}

/** For `follow` intents, evaluate at the current t (overwrite playheadMs).
 *  For `point` and `region`, return as-is — they are time-invariant within
 *  the clip's range. */
function liveIntent(intent: CameraIntent, t: number): CameraIntent {
  if (intent.kind === 'follow') {
    return { ...intent, playheadMs: t };
  }
  return intent;
}

const DEFAULT_INTENT: CameraIntent = {
  kind: 'point',
  center: { lng: -122.4194, lat: 37.7749 },
  zoom: 10,
  bearing: 0,
  pitch: 0,
};
```

**Key invariant**: `cameraAt(track, t)` is pure in `(track, t)`. There is
no `performance.now()`, no MapLibre, no DOM. Calling it twice with the
same arguments returns identical intents.

### 3.3 The `resolveIntent(intent, viewport)` function

This is the **only** aspect-aware function in the new architecture. It is
the **only** call site that knows the viewport's pixel dimensions, and
consequently the only place where fractional `Padding` is converted to
pixels.

```ts
import { bearingFromKeyframes, locationAt } from './routeLocation';

/** Resolve a CameraIntent to a concrete camera given the renderer's
 *  viewport. Pure in (intent, viewport). The same intent resolved against
 *  two different viewports correctly produces two different framings. */
export function resolveIntent(intent: CameraIntent, viewport: Viewport): ResolvedCamera {
  switch (intent.kind) {
    case 'point':
      return {
        center: intent.center,
        zoom: intent.zoom,
        bearing: intent.bearing,
        pitch: intent.pitch,
      };

    case 'region':
      return cameraForBounds(intent.bounds, intent.padding, viewport, {
        bearing: intent.bearing,
        pitch: intent.pitch,
      });

    case 'follow': {
      // Resolve geographic position from pure route math.
      const loc = locationAt(intent.playheadMs, intent.route, null);
      const center = loc ? { lng: loc.lng, lat: loc.lat } : { lng: 0, lat: 0 };

      // Bearing: 'fixed' mode uses fixedBearingDegrees. 'auto' mode reads
      // the precomputed keyframe table that buildMapTrack froze on the
      // intent. Falls back to 0 if the table is empty (e.g. anchor with
      // a degenerate time range).
      const bearing =
        intent.bearingMode === 'auto'
          ? (intent.bearingKeyframes.length > 0
              ? bearingFromKeyframes(intent.playheadMs, intent.bearingKeyframes)
              : 0)
          : (intent.fixedBearingDegrees ?? 0);

      // 'follow' uses targetZoom directly. `padding` is reserved for
      // future "frame the marker plus N meters" extensions; today it
      // is read-but-unused so call sites can be future-proof.
      return {
        center,
        zoom: intent.targetZoom,
        bearing,
        pitch: intent.pitch,
      };
    }
  }
}

/** Pure port of MapLibre's cameraForBounds — Web Mercator math, no DOM.
 *
 *  Converts the fractional `padding` (a number in [0, 0.5) representing
 *  a fraction of `min(viewport.width, viewport.height)`) to pixels here,
 *  insets the viewport by that pixel amount on all four edges, and
 *  computes the zoom that fits `bounds` into the inset rectangle, centered
 *  at the bounds midpoint. ~30 lines. See §5.2 for the algorithm. */
function cameraForBounds(
  bounds: Bounds, padding: Padding, viewport: Viewport,
  extra: { bearing: number; pitch: number },
): ResolvedCamera { /* … */ }
```

**Critical contract**: `resolveIntent` is the **only** place pixel-aware
math happens. Adding a 16:9 export later means calling
`resolveIntent(cameraAt(track, t), viewport_16x9)`. Adding a 1:1 export
means a different viewport. Same `cameraAt`, same intent, three different
resolved cameras. This is the entire point.

**Bearing-keyframe handling addressed inline.** The earlier draft of this
section punted bearing-keyframe evaluation to a stubbed `autoBearing`
helper with a TBD note. That hole is closed:
`buildMapTrack` (§3.2) calls `computeBearingKeyframes` once per `auto`-mode
follow anchor and freezes the result on the intent. `resolveIntent` reads
the frozen table via `bearingFromKeyframes`. Both functions are existing
exports of `routeLocation.ts` (lines 319-361 and 366-390). No new math, no
runtime IndexedRoute walk inside `resolveIntent`. The remaining question
of whether bearing keyframes "bleed" sensibly across anchor boundaries
during gap interpolation is tracked in §8.3 — that question is about
`interpolateAnchors`, not `resolveIntent`.

### 3.4 Anchor-to-anchor interpolation (Van Wijk & Nuij)

Today the imperative `runClipTransition` (`MapView.tsx:128-183`) decides
the arc on the fly, in viewport space, using `cameraForBounds` to pick a
peak zoom. In the target model the same arc happens at the **intent**
level, between two anchors, in a viewport-agnostic way:

```ts
/** Interpolate from anchor A to anchor B at time t.
 *  Uses Van Wijk & Nuij (2003) "Smooth and Efficient Zooming and Panning"
 *  to produce a smooth zoom-out + pan + zoom-in arc between the two
 *  anchors' resolved geographic positions.
 *
 *  Returns a `point` intent (the interpolated state at t). The resulting
 *  intent is passed through `resolveIntent` by the renderer.
 *
 *  Duration is auto-derived from the arc's "rho" parameter (the natural
 *  zoom-distance metric in Van Wijk's paper) and the project-level
 *  transition feel. */
function interpolateAnchors(
  a: MapAnchor, b: MapAnchor, t: number, feel: TransitionFeel,
): CameraIntent {
  // 1. Resolve each anchor to a *canonical* camera (LngLat + zoom + bearing
  //    + pitch). For `point` anchors this is trivial. For `follow` anchors
  //    we evaluate them at the boundary time (a.endTimeMs for A,
  //    b.timeMs for B). For `region` anchors we resolve at a canonical
  //    1024×1024 viewport — anchor-to-anchor interpolation is intrinsically
  //    not viewport-aware, so we choose a fixed reference viewport and
  //    let resolveIntent re-frame at render time if needed.
  const camA = canonicalCamera(a, a.endTimeMs);
  const camB = canonicalCamera(b, b.timeMs);

  // 2. Compute Van Wijk arc parameters (rho, S — the path length).
  const arc = vanWijkArc(camA, camB);

  // 3. Map t (linear in wall-clock) to s (arc parameter in [0, S]) using
  //    the feel-derived ease curve.
  const totalDurationMs = arcDurationMs(arc, feel);
  const tStart = a.endTimeMs;
  const tEnd   = a.endTimeMs + totalDurationMs;
  // If t > tEnd, hold camB. If t < tStart, hold camA.
  const localT = clamp01((t - tStart) / Math.max(1, tEnd - tStart));
  const eased = easeInOut(localT, feel);
  const s = arc.S * eased;

  // 4. Sample (center, zoom) along the arc at s. Bearing/pitch lerp linearly.
  const point = vanWijkSample(camA, camB, arc, s);
  const bearing = circularLerp(camA.bearing, camB.bearing, eased);
  const pitch   = camA.pitch + (camB.pitch - camA.pitch) * eased;

  return {
    kind: 'point',
    center: point.center,
    zoom: point.zoom,
    bearing,
    pitch,
  };
}

// -- Van Wijk & Nuij arc primitives -----------------------------------
// All three functions are pure. Together they are ~30 lines of code,
// porting Section 4 of "Smooth and Efficient Zooming and Panning"
// (Van Wijk & Nuij, 2003). The reference implementation lives in
// MapLibre's `src/ui/camera.ts` (look for `flyTo`'s u(s), w(s), and
// the `S` derivation). We are porting the core math out, not
// reinventing it.

/** Pre-computed parameters of an arc between two cameras. Computed once
 *  per (camA, camB) pair and reused for every sample along the arc.
 *  All fields are derived from the paper:
 *    - `rho`   — smoothing parameter, paper recommends 1.42.
 *    - `u0/u1` — start/end positions on the paper's 1-D parametric line,
 *                in units of "world meters at the higher zoom."
 *    - `r0/r1` — coefficients from eq. (7) used to drive cosh/sinh sweeps.
 *    - `w0`    — common-denominator world width at the start (from `zoom`).
 *    - `S`     — total arc length; the parameter `s ∈ [0, S]` parameterizes
 *                the smooth zoom-out + pan + zoom-in path. */
export interface VanWijkArc {
  rho: number;
  u0: number;
  u1: number;
  r0: number;
  r1: number;
  w0: number;
  S: number;
}

/** Build a Van Wijk arc between two resolved cameras. Pure.
 *  ~12 lines. Returns the closed-form arc parameters used by
 *  `vanWijkSample` and `arcDurationMs`. Implements eqs. (1)-(8) of
 *  Van Wijk & Nuij (2003). */
export function vanWijkArc(camA: ResolvedCamera, camB: ResolvedCamera): VanWijkArc;

/** Sample the arc at parameter `s ∈ [0, arc.S]`.
 *  Returns the geographic center and (real) zoom at that arc position.
 *  Pure. ~10 lines. Implements eq. (9) for u(s) and the `w(s)` width
 *  formula; the zoom is `log2(w0 / w(s))` plus the higher source zoom. */
export function vanWijkSample(
  camA: ResolvedCamera,
  camB: ResolvedCamera,
  arc: VanWijkArc,
  s: number,
): { center: LngLat; zoom: number };

/** Auto-derive the arc duration from path length and "transition feel."
 *  Pure. ~5 lines.
 *
 *  Today's `runClipTransition` uses (per `MapView.tsx:114-126`):
 *    minDurationMs: 1500, maxDurationMs: 7000, curve: 1.42 (== rho).
 *  The replacement formula:
 *    base   = clamp(arc.S * MS_PER_S_UNIT, MIN, MAX)
 *    return base * feelMultiplier(feel)   // natural=1, snappy=0.6, slow=1.5
 *  where MS_PER_S_UNIT and MIN/MAX are tuned to match today's preview
 *  durations within the spike (§6.1). */
export function arcDurationMs(arc: VanWijkArc, feel: TransitionFeel): number;
```

The three primitives above plus `interpolateAnchors`, `canonicalCamera`,
`clamp01`, `easeInOut`, and `circularLerp` (already exported from
`routeLocation.ts:299-308`) are the complete arc-interpolation surface.
References for the implementer:

- Van Wijk & Nuij, "Smooth and Efficient Zooming and Panning" (2003) —
  Section 4 contains the closed-form equations to code from directly.
- MapLibre's `flyTo` source (`src/ui/camera.ts` in the MapLibre repo) —
  same algorithm in TypeScript, useful for cross-checking edge cases
  (degenerate arcs where camA ≈ camB, very long arcs where rho should
  swap to the linear-pan branch of eq. (10)).

### 3.5 The live preview ease loop (replaces Writers 1, 4, 5, 6)

Today's Writer 6 is a tangle of effects + gates + throttles. The
replacement is a single per-frame ease loop:

```ts
// In MapView.tsx, after the `cameraAt`-based architecture lands.
// Replaces ALL of: Writers 1, 4, 5, 6 above.

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
    const t   = clockToWallClock(now); // playhead → wall-clock ms
    const intent = cameraAt(track, t + LOOKAHEAD_MS);

    const viewport: Viewport = {
      width:  map.getContainer().clientWidth,
      height: map.getContainer().clientHeight,
      dpr: window.devicePixelRatio,
    };
    const target = resolveIntent(intent, viewport);

    map.easeTo({
      center: [target.center.lng, target.center.lat],
      zoom:   target.zoom,
      bearing: target.bearing,
      pitch:  target.pitch,
      duration: STEP_MS,
      essential: true,
    });

    raf = window.setTimeout(() => {
      tick();
    }, STEP_MS);
  };

  tick();
  return () => {
    stopped = true;
    window.clearTimeout(raf);
  };
}, [track]);
```

**How this preserves the "smooth handoff" UX (non-negotiable)**:

- Every 50ms we compute `target = cameraAt(playhead + 100ms_lookahead)`.
- We fire `map.easeTo(target, { duration: 100ms })`.
- MapLibre keeps chasing a moving target.
- When the playhead crosses a clip boundary, the target shifts toward
  clip B's anchor; MapLibre picks up from `getCenter()` (whatever camera
  state currently exists) and arcs to the new target.
- Smooth clip-to-clip handoff is **identical** to today's behavior — same
  MapLibre interpolator, same continuous-camera-chasing-target model.

The difference: target comes from a pure function, not from competing
React effects. Crucially, **no `jumpTo` in preview**. `jumpTo` would
break the handoff illusion.

### 3.6 The "transition feel" knob

The MapTrack contains *only anchors* (one per clip). There is **no
first-class Transition object, no transition authoring UI, no per-pair
transition data**. When `t` falls between two anchors, `cameraAt(t)`
interpolates between them on the fly using Van Wijk math, with duration
auto-derived from camera distance.

**One project-level "transition feel" knob** is the only user-facing
parameter:

```ts
type TransitionFeel = 'natural' | 'snappy' | 'slow';
```

- `'natural'`: matches today's `DEFAULT_MAP_TRANSITION` defaults
  (`MapView.tsx:119-126`) — `baseMs: 1100`, `msPerZoomLevel: 580`,
  `curve: 1.42`. **Default.**
- `'snappy'`: `baseMs: 600`, `msPerZoomLevel: 320`, `curve: 1.6`.
- `'slow'`: `baseMs: 1800`, `msPerZoomLevel: 900`, `curve: 1.25`.

This preserves today's "drop in any clip and the transition just works"
flexibility — transitions remain *derived*, not authored. Persist this
under `Project.transition_feel: TransitionFeel` in `models.rs` (additive
field, defaulting to `'natural'`).

### 3.7 The export render loop

For each output frame at time t (call this from
`render_map_frames(timeline, layout, output_dir)` —
`ARCHITECTURE.md:143`):

```pseudocode
for frame_idx in 0..total_frames:
    t = wallClockForFrame(frame_idx, fps, project_start_ms)

    layout = layoutFor(export_aspect, video_aspect_at_t, project)
    // layoutFor is parallel to cameraAt — pure, aspect-agnostic at the spec
    // level. It returns map_rect (x, y, w, h) and video_rect.

    intent = cameraAt(track, t)
    viewport = { width: layout.map_rect.w, height: layout.map_rect.h, dpr: 1 }
    camera = resolveIntent(intent, viewport)

    map.jumpTo({                    // jumpTo, NOT easeTo — frame-accurate
      center: [camera.center.lng, camera.center.lat],
      zoom:   camera.zoom,
      bearing: camera.bearing,
      pitch:  camera.pitch,
    })
    awaitTilesIdle(map)             // see Open Questions §8.1

    map_png = capture(map, layout.map_rect)

    composite_frame(video_rect, video_frame_at(t), map_rect, map_png)
    encode_frame(out_video, composite)
```

**Why `jumpTo` is correct in export but wrong in preview**:

- Preview uses `easeTo` with a moving target so MapLibre's interpolator
  smooths over network/render hiccups and gives the user a continuous
  feel.
- Export evaluates `cameraAt(t)` at exactly the frame's wall-clock time.
  The function *already* contains the smooth Van Wijk interpolation. We
  do not want MapLibre to *also* interpolate — that would compound.
  `jumpTo` snaps the camera to exactly the value `cameraAt` produced, then
  we wait for tiles, then we capture.

### 3.8 Where the 7 imperative writers go

| Today's writer | After migration |
|---|---|
| 1 — `runClipTransition` | Deleted. Replaced by `interpolateAnchors` (intent-level). |
| 2 — Map style switch | Kept (style switch is orthogonal to camera). |
| 3 — Full-route fitBounds | Becomes a `region` intent on project load, resolved by `resolveIntent`. |
| 4 — Manual selection arc | Deleted. The ease loop already chases the active anchor's intent. |
| 5 — Live bearing easeTo | Deleted. Bearing is part of the resolved camera and is updated on every loop tick. |
| 6 — Live playhead marker + follow ease loop | Marker management stays (data-driven source updates). The follow ease logic is replaced by §3.5's loop. |
| 7 — Slime trail | Kept (data-driven source update, not a camera writer). |

| Today's ref | After migration |
|---|---|
| `lastFitRouteRef` | Deleted (idempotent in pure model). |
| `lastFollowAtRef` | Deleted (loop runs at fixed cadence). |
| `lastFollowedClipRef` | Deleted (no clip-boundary special case). |
| `prevZoomRef` | Deleted. |
| `prevBearingRef` | Deleted. |
| `clipTransitionEndsAtRef` | Deleted. |

Every GATED/THROTTLED event recording in `recordEvent(...)` calls at
`MapView.tsx:502, 522, 527, 552, 596, 645, 650, 652, 661` is also deleted
in this pass.

### 3.9 Persistence format

The camera migration adds exactly one new persisted field
(`Project.transition_feel`). This section justifies keeping JSON as the
on-disk format and proposes two adjacent persistence improvements that
cost almost nothing to ship at the same time.

#### 3.9.1 Why JSON stays

The constraints that matter for TrailCut all favor JSON:

- **Single user, single document**, opened/saved at human cadence — parse
  speed is irrelevant. Save latency is gated on FFmpeg, not on serializing
  ~50KB of clip metadata.
- **Bundle dominated by media** — proxies + thumbnails are 100s of MB. Any
  recipe-level compression saves nothing measurable.
- **Rust + serde + JS** — `serde_json` and `JSON.parse` are both free; no
  new deps, no codegen, no schema compiler.
- **Debuggability** — when a project bundle goes wrong (corrupted save,
  hand-merged conflict, partially restored backup), the user can open
  `project.json` in any text editor and see/fix it. Binary formats lose
  this.
- **Diff/undo-friendly** — Phase 4 plans undo/redo. JSON snapshots diff
  cleanly; binary formats don't.

Alternatives were considered and rejected:

| Alternative | Why not |
|---|---|
| MessagePack / CBOR | 2-3× smaller, faster parse — but the recipe is already a rounding error next to media. Cost: opaque to humans, ugly recovery from corruption. |
| SQLite | Useful for partial loads / queries / concurrent writes — none of which apply. The whole project is loaded and saved as a unit. Turns the bundle from "directory you can inspect" into "blob you must query." |
| TOML | Pleasant for flat configs, painful for deeply nested arrays of objects (which `clips[]` and `trackpoints[]` are). |
| YAML | Same nesting weakness as TOML, plus parser footguns (Norway problem, anchor surprises). |
| Protobuf / FlatBuffers | Only wins on perf-bound mobile. Not us. |

The only legitimate weakness JSON has — **schemalessness** — is
addressable with a version field (§3.9.3) for the cost of a single
`u32`.

#### 3.9.2 Stop persisting `Route` inside `project.json`

Today the parsed `Route` lives in `project.json` *and* the original GPX
sits at `route.gpx` in the bundle (`CLAUDE.md` project bundle layout).
This is redundant:

- A typical 1Hz GPX trace for a multi-hour hike runs 5–20k trackpoints.
  At ~80 bytes per JSON-serialized trackpoint, the parsed `Route` alone
  bloats `project.json` to 0.5–2 MB.
- The two copies can drift if anything ever rewrites one without the
  other.
- `route.gpx` is the canonical source — it survives any project.json
  corruption.

**Proposal**: drop the `route` field from the persisted `Project` and
re-parse from `route.gpx` on load. `project.json` becomes <10KB for a
typical project (clips + settings + exports + `transition_feel`).

**Backend touch**:

- `src-tauri/src/models.rs:222-234` — remove `route: Option<Route>` from
  the persisted shape. Keep `Route` as an in-memory type.
- `src-tauri/src/commands/project.rs` — `load_project` parses `route.gpx`
  via existing `parse_gpx` after JSON load. `save_project` no longer
  serializes route data.
- Frontend `Project` type stays the same — `route` is still on the
  in-memory model, just not persisted.

This is a one-shot migration step (read old format with `route` field if
present, ignore on save). With the schema version below, that fork is
clean.

#### 3.9.3 Add `schema_version`

Cheap insurance for the day a model field's *shape* needs to change
(not just be added). Serde already handles additive changes via
`#[serde(default)]`; the version field exists for the harder cases.

```json
{
  "schema_version": 2,
  "transition_feel": "natural",
  "clips": [ ... ],
  "exports": [ ... ],
  "map_settings": { ... }
}
```

- **v1**: pre-migration shape (`route` present in JSON, no
  `transition_feel`).
- **v2**: post-migration shape (`route` re-parsed from `route.gpx`,
  `transition_feel` present, defaults to `'natural'`).

`load_project` reads the version field, applies any one-shot migrations
(currently: v1 → v2 = drop `route` field, default `transition_feel`),
then deserializes against the current Rust struct. `save_project` always
writes the current version.

#### 3.9.4 What is *not* persisted

To prevent confusion: **`MapTrack`, `MapAnchor`, `CameraIntent`, and
`ResolvedCamera` are never persisted.** They are derived in memory by
`buildMapTrack(clips, route, settings, feel)` on every load. The whole
point of the migration is that the camera model is a *function*, not a
stored artifact.

This is also another argument for JSON: there are no
fast-random-access camera keyframes to optimize storage for. The recipe
on disk is small, declarative, and read once per session.

---

## 4. What's preserved (non-negotiable)

These behaviors must survive the migration. The spike's pass criterion
(see §6.1) explicitly tests them.

1. **Drop in any clip and transitions just work** — transitions are
   derived, not authored. `buildMapTrack` reads `clips` and produces
   anchors; the gap between any two consecutive anchors yields a Van Wijk
   arc with feel-derived duration. No per-pair authoring.
2. **One configuration → any aspect ratio** — `CameraIntent` and
   `LayoutPolicy` are aspect-agnostic at the spec level. Pixel-awareness
   is confined to `resolveIntent` and `layoutFor`.
3. **Smooth handoff between clips** — the live ease loop preserves the
   "chasing-target" UX. Clip-to-clip handoff in the new model must be
   visually indistinguishable from today's preview.
4. **Per-clip map overrides** — already supported by the existing
   `MapOverrides` type (`src/types.ts:38`,
   `src-tauri/src/models.rs:187-205`); `buildMapTrack` reads them via
   `resolveMapSettings(projectMapSettings, clip.map_overrides)`.
5. **Auto bearing from GPX keyframes** — preserved by passing `bearingMode`
   and `bearingStops` through to `follow` intents.
6. **Visited-route "slime trail"** — Writer 7 is unchanged. It is data, not
   camera.
7. **Project bundle format** — additive only. `Project.transition_feel`
   is the only new persisted field.

---

## 5. What's lost (and how reclaimed)

Two MapLibre built-ins disappear from our hot path. Both are replaced with
~30 lines of well-documented math.

### 5.1 MapLibre's built-in `flyTo` parabolic zoom-out

**Lost**: `map.flyTo({ minZoom, curve, … })` is invoked at
`MapView.tsx:173`. It uses Van Wijk & Nuij internally to produce the arc.

**Reclaimed**: port the same algorithm to `vanWijkArc` /
`vanWijkSample` / `arcDurationMs` (§3.4). Reference implementation in
MapLibre's `src/ui/camera.ts` (function `flyTo` and helpers
`zoomScale`/`scaleZoom`). The math is well-known, ~30 lines, and is
*easier* to write outside of MapLibre because we don't need the
viewport-pinning logic — we are operating in pure intent space.

### 5.2 MapLibre's built-in `cameraForBounds` / `fitBounds`

**Lost**: `map.cameraForBounds(...)` at `MapView.tsx:160` and
`map.fitBounds(...)` at `MapView.tsx:403`. Both are viewport-aware but
the viewport is the live DOM container.

**Reclaimed**: implement `cameraForBounds(bounds, padding, viewport, extra)`
inside `resolveIntent` (§3.3) — same math, lifted out so it can run for
any viewport, not just the live one. Algorithm (Web Mercator):

1. Convert the fractional `padding` to pixels:
   `pad = padding * Math.min(viewport.width, viewport.height)`.
   This is the only step where pixel-awareness enters; everything below
   it operates in viewport-pixel units. Reject `padding >= 0.5`
   (would inset the viewport to ≤0 in the smaller dimension).
2. Project `bounds.sw` and `bounds.ne` into world pixel coordinates at
   zoom 0 using the standard `lng/lat → mercator` transform.
3. Compute `dx = ne.x - sw.x`, `dy = sw.y - ne.y` (latitude flips Y).
4. Compute the per-axis zoom that makes the bounds fit inside the
   inset rectangle `(viewport.width - 2*pad, viewport.height - 2*pad)`:
   `zx = log2((viewport.width - 2*pad) / dx)`
   `zy = log2((viewport.height - 2*pad) / dy)`.
5. Take `zoom = min(zx, zy)`.
6. Center is the bounds midpoint in lng/lat.

(This is what `cameraForBounds` does internally — see MapLibre's
`src/geo/transform.ts` — except MapLibre takes pixel padding directly,
whereas we take fractional padding and convert here.)

### 5.3 What is *not* lost

- `easeTo`/`flyTo`/`jumpTo` themselves are still used — `easeTo` in the
  preview loop, `jumpTo` in the export loop. We are not reimplementing
  the camera mutator, only the *intent producer*.
- `setStyle`, `setLayoutProperty`, `setPaintProperty`, GeoJSON sources —
  all unchanged. Style and source management are orthogonal to camera
  state.
- The MapLibre instance lifecycle (`MapView.tsx:229-361`) is unchanged.

---

## 6. Migration sequence

This sequence is **critical**. Do not skip step 1. Do not start step 3
before step 1 has passed.

### 6.1 Step 1 — Spike first, refactor second

**Goal**: prove the new model produces preview-quality output for *both*
the live aspect and an alternate aspect, without touching the existing
imperative code.

**Build**:

1. New file `src/lib/cameraIntent.ts` containing `CameraIntent`,
   `Viewport`, `MapTrack`, `MapAnchor`, `buildMapTrack`, `cameraAt`,
   `interpolateAnchors`, `resolveIntent`, plus `vanWijkArc`,
   `vanWijkSample`, `arcDurationMs`, `cameraForBounds` helpers.
2. New file `src/dev/CameraSpikeHarness.tsx` — a route or hidden screen
   that renders **two `MapView`-like instances side by side**:

   ```
   ┌────────────────────────┬────────────────────────┐
   │ Live pane (16:9-ish)   │ Mock 9:16 pane (fixed) │
   │ uses cameraAt + the    │ uses cameraAt + the    │
   │ live container size    │ a fixed 360x640 box    │
   └────────────────────────┴────────────────────────┘
   ```

   Both instances are driven by the *same* `cameraAt(track, t)` and the
   same playhead. Each calls `resolveIntent` with its own viewport. The
   ease loop from §3.5 runs in both.

3. Mount the harness behind a dev-only flag so the existing
   `MapView.tsx` is untouched.

**Pass criterion** (must hit BOTH):

- **A. Handoff parity**: clip-to-clip handoff in the new model is
  visually indistinguishable from today's preview. Test on a real
  project with ≥3 clips and a loaded GPX route. Eyeball the live pane
  against today's preview running side by side. The smoothness of the
  arc, the duration, the bearing rotation: identical or closer-than-
  noticeable.
- **B. Aspect framing parity**: the two side-by-side viewports show
  correctly framed output for their respective aspects from the same
  project. The 9:16 pane should clearly reframe scenes that the wider
  pane would only modestly reframe (e.g. a region intent that fits
  bounds will use a different zoom in each pane). Both panes track the
  same playhead and never desync.

**Fail signals** (any of these → do not proceed):

- The 9:16 pane shows the same camera as the wide pane (you forgot to
  pipe the viewport through `resolveIntent`).
- The arc looks subtly different (likely your `arcDurationMs` is off
  vs. `DEFAULT_MAP_TRANSITION`).
- Bearing snaps instead of arcs (`circularLerp` not wired in).
- The two panes desync over time (two clocks instead of one shared
  playhead).

### 6.2 Step 2 — Add tests for `src/lib/routeLocation.ts`

This 400-line file becomes load-bearing for export. **No tests exist
today.** Add a test runner (Vitest is the natural fit alongside Vite —
`vite.config.ts` already exists at the repo root) and cover:

| Function | Cases to cover |
|---|---|
| `parseTimestamp` | ISO 8601 (`"2026-04-04T15:13:00Z"`), ExifTool format (`"2026:04:04 12:49:25-07:00"`), null/undefined, garbage. Verify exact ms output. |
| `indexRoute` | Empty route → null. Trackpoints without timestamps dropped. Out-of-order trackpoints sorted ascending. minTimeMs/maxTimeMs correct. |
| `locationAt` | Exact hit on a trackpoint. Strict-before-first, strict-after-last → fallback. Linear interp midpoint. Gap > `MAX_INTERPOLATION_GAP_MS` (60s) → fallback. Empty route + null fallback → null. |
| `trailUpTo` | Before route start → empty coords. After route end → all coords. Mid-route → strict-before points + interpolated head. Big gap straddling t → no interpolated head. |
| `clipWaypointLocation` | Anchor at `created_at + trim.in_ms` (verify split-clip semantics — left half and right half of a split clip resolve to different positions). |
| `forwardAzimuth` | Cardinals: due north → 0°, due east → 90°, due south → 180°, due west → 270°. Antipodal edge case. |
| `bearingAt` | Two-point route → constant bearing. Out-of-range t with clamp. Stationary segment → null. |
| `circularLerp` | 350° → 10° at t=0.5 → 0°. 10° → 350° at t=0.5 → 0°. 0° → 180° at t=0.5 → 90° (or 270°, document which arc). |
| `computeBearingKeyframes` | stops=1 returns single midpoint keyframe. stops=N returns N keyframes at segment midpoints. Stationary first segment → falls back to windowed bearing. |
| `bearingFromKeyframes` | Before first → first.bearing. After last → last.bearing. Between → circularLerp. |

**Pass criterion**: ≥90% line coverage on `routeLocation.ts`. All tests
pass on `npm test`.

These tests must exist before Step 3, because Step 3 will refactor a lot
of code that *implicitly* depends on this file behaving correctly.

### 6.3 Step 3 — Refactor `MapView.tsx` to consume `cameraAt`

Now (and only now), modify `MapView.tsx` itself:

1. Delete Writers 1, 4, 5 entirely. Delete the `runClipTransition` helper
   (`MapView.tsx:128-183`) and the `MapTransitionConfig` /
   `DEFAULT_MAP_TRANSITION` constants (`MapView.tsx:110-126`).
2. Replace Writer 6 with the live ease loop (§3.5). Marker DOM management
   (`MapView.tsx:603-620`) is preserved as a data-driven update (the
   marker's lng/lat is read from `cameraAt`'s underlying location math
   per tick).
3. Convert Writer 3 (full-route fitBounds, `MapView.tsx:380-408`) into a
   one-shot `region` intent applied via `resolveIntent` against the live
   viewport.
4. Delete all six refs at `MapView.tsx:212-223`.
5. Delete every `recordEvent(...)` call inside `MapView.tsx`.
6. Delete the `recorder` prop from `MapViewProps`. Delete
   `useMapRecorder` import. Delete `registerFrameSampler` setup.
7. Delete `src/hooks/useMapRecorder.ts`.
8. Delete the Debug popover in `ProjectView.tsx:438-482` and the
   `useMapRecorder` call at `ProjectView.tsx:209-216`.

The build of `MapTrack` happens in `ProjectView.tsx` (or a new
`useMapTrack` hook) and is passed into `MapView` as a prop:

```tsx
const indexedRoute = useMemo(() => indexRoute(route), [route]);
const track = useMemo(
  () => buildMapTrack(clips, indexedRoute, mapSettings, projectTransitionFeel),
  [clips, indexedRoute, mapSettings, projectTransitionFeel],
);
```

`MapView`'s prop interface becomes:

```ts
interface MapViewProps {
  track: MapTrack;
  /** Optional — if present, drives the playhead. If absent, the loop holds. */
  playheadMs: number | null;
  /** Visual-only state passed through (style, route source data). */
  mapSettings: MapSettings;
  selectedClipId: string | null;        // for marker/waypoint paint only
  route: Route | null;                  // for source data, not camera
  onSelectClip?: (clipId: string) => void;
}
```

**Pass criterion**: the live preview behavior is equivalent to today's,
verified by running the same test project as in Step 1's parity test. The
debug recorder is gone and not missed.

### 6.4 Step 4 — Build offline export render harness

Now we have a pure `cameraAt` and a tested `routeLocation`. Build the
offline export render harness:

1. Add a Tauri command `render_map_frames(track, layout_per_frame, fps,
   output_dir)` in a new `src-tauri/src/commands/export.rs`. The command
   signature mirrors `ARCHITECTURE.md:143`.
2. Inside the command, spawn a hidden Tauri window with a route
   `/export-renderer` that loads a minimal page: a single `<div>` for
   MapLibre, no UI chrome.
3. The export-renderer page receives `(track, layout_per_frame, fps)` via
   the asset protocol or a one-shot IPC and runs the export render loop
   from §3.7.
4. For each frame: `cameraAt → resolveIntent → map.jumpTo →
   awaitTilesIdle → capture canvas → write PNG`.
5. **Prove tile-load determinism**: per frame, instead of just
   `map.once('idle', …)`, poll `map.areTilesLoaded()` with a hard
   timeout (e.g. 2000ms) and record every frame whose tiles failed to
   resolve in time. Report the failure rate. See §8.1.

**Pass criterion**: render a 30-frame sequence (1s at 30fps) for a real
project. Every frame is non-blank, every frame's PNG matches the
`cameraAt` resolved camera within ~1 zoom-step (allow tile downsampling
fallback). Two independent runs of the same render produce
byte-identical (or near-identical, modulo tile freshness) PNGs.

### 6.5 Step 5 — Layout policy and compositing

Comes after the map track is proven. Out of scope for this document
beyond the contract sketch:

```ts
interface LayoutRect { x: number; y: number; width: number; height: number; }
interface LayoutFrame {
  /** Where the map frame is painted on the output canvas. */
  map_rect: LayoutRect;
  /** Where the video frame is painted. */
  video_rect: LayoutRect;
  /** Output canvas dimensions (matches export resolution). */
  canvas: { width: number; height: number };
}

/** Pure: given the project's per-frame state and the export aspect,
 *  return the layout for this frame. */
function layoutFor(
  exportAspect: '9:16' | '16:9' | '1:1',
  videoAspectAtT: number,
  project: Project,
  t: number,
): LayoutFrame { /* … */ }
```

Then composition is just: place `map_rect` and `video_rect` on the canvas
and pipe to FFmpeg's `filter_complex` (`ARCHITECTURE.md:215-222`).

---

## 7. Out of scope for this migration document

Explicitly **not** addressed here. Do not derail the migration with these:

- The unrelated current build failures (six TS errors in WIP map
  customization). Surface them as a separate fix.
- Identity-scheme bug in `mergeClips` — path collision after split. (See
  the `useProject.ts:168-230` split flow; the bug is upstream of camera
  state.)
- Color grading.
- Audio handling.
- Project persistence robustness *beyond* what §3.9 covers — atomic save
  (write to tempfile + rename), backup rotation, recovery from partial
  writes. The schema version field lands here; the durability work does
  not.
- Any UI for transition authoring (deliberately **NOT** building — see
  §3.6).
- Multi-instance MapLibre style cross-fade (mentioned in §8.2 as an open
  question; not solved here).
- Stabilization (already deferred to Phase 4 per `CLAUDE.md:73`).

---

## 8. Open questions for verification

Flag these to the implementer. They are **not** blockers for starting
Step 1, but each must be resolved before the corresponding later step.

### 8.1 Tile-load idle determinism for offline render

The export render loop (§3.7) does `map.jumpTo(camera); await idle;
capture`. Question: is `map.once('idle', …)` reliable enough as the
"capture barrier," or does the export need explicit
`map.areTilesLoaded()` polling with a timeout fallback?

**Why this matters**: the `'idle'` event in MapLibre fires when the
*frame finishes drawing with whatever tiles are currently in cache* —
including downsampled placeholders. If we `jumpTo` to a region whose
tiles haven't downloaded, `'idle'` may fire on a blurry frame.

**To verify**: in Step 4's harness, render the same frame twice — once
right after `jumpTo`, once after a 2s soak — and pixel-compare. If they
differ beyond a tile-edge tolerance, switch to `areTilesLoaded()`
polling.

**Decision needed before**: Step 4 ships.

### 8.2 Two-instance MapLibre overhead for style cross-fade rendering

If a future feature wants to cross-fade between two map styles (e.g.,
Liberty → Satellite during a clip transition), we'll need two MapLibre
instances rendered to two canvases, alpha-blended at composite time.
Each instance carries ~30-50MB of WebGL state and a tile cache.

**Why this matters**: the spike harness (§6.1) already runs two
MapLibre instances. If overhead is acceptable there, it's acceptable
for export. If it isn't, the spike harness will tell us early.

**To verify**: in the spike, monitor memory and frame budget with both
panes scrolling. If the live pane drops below 30fps, we have an issue.

**Decision needed before**: Step 1's pass criterion is signed off.

### 8.3 Bearing keyframe interaction at anchor boundaries

`computeBearingKeyframes` (`routeLocation.ts:319-361`) divides a clip's
range into `bearing_stops` segments and emits a keyframe at each
segment's midpoint. `bearingFromKeyframes` (`routeLocation.ts:366-390`)
holds the first/last bearing outside the keyframe range.

**Question**: does an in-progress bearing keyframe arc within clip A
"bleed into" clip B's anchor entry? Specifically: at `t = a.endTimeMs`,
the auto-bearing for clip A holds at `last keyframe.bearing`. At
`t = b.timeMs`, clip B's auto-bearing is `first keyframe.bearing` of B.
Between the two anchors, `interpolateAnchors` runs Van Wijk on
*center+zoom* and `circularLerp` on bearing. So the bearing during the
gap is a circular lerp between A's last keyframe bearing and B's first
keyframe bearing — which may not match what the user "saw" as the
direction of travel mid-arc.

**To verify**: in Step 1's spike, with `bearing_mode: 'auto'`, does the
arc rotate as expected when bridging two clips with very different
direction-of-travel? If not, `interpolateAnchors` may need to consult
the GPX bearing at intermediate times rather than lerp endpoints.

**Decision needed before**: Step 3's parity check.

---

## Appendix A — File touch list summary

| File | Change |
|---|---|
| `src/lib/cameraIntent.ts` | **NEW** — `CameraIntent`, `MapTrack`, `cameraAt`, `resolveIntent`, Van Wijk math. |
| `src/lib/routeLocation.ts` | No code change. Add tests. |
| `src/lib/routeLocation.test.ts` | **NEW** — see §6.2. |
| `src/dev/CameraSpikeHarness.tsx` | **NEW** — Step 1 spike, then deleted. |
| `src/components/MapView.tsx` | Major rewrite (§6.3). Delete Writers 1, 4, 5. Replace 6. Keep 2, 3 (rebuilt as `region` intent), 7. Drop all six refs. Drop recorder wiring. Net line count drops ~250+. |
| `src/hooks/useMapRecorder.ts` | **DELETE**. |
| `src/screens/ProjectView.tsx` | Build `MapTrack` via `useMemo` (§6.3). Delete recorder import, hook call (`ProjectView.tsx:209-216`), Debug popover (`ProjectView.tsx:438-482`). |
| `src/types.ts` | Optional: add `transition_feel: TransitionFeel` to `Project`. |
| `src-tauri/src/models.rs` | Add `transition_feel: Option<String>` and `schema_version: u32` on `Project`. Drop `route` from the persisted shape (§3.9.2 — keep the in-memory field). |
| `src-tauri/src/commands/project.rs` | `load_project` reads `schema_version`, applies v1→v2 migration (drop persisted `route`, default `transition_feel`), then re-parses `route.gpx`. `save_project` always writes current version. |
| `src-tauri/src/commands/export.rs` | **NEW** in Step 4 — `render_map_frames` command. |

## Appendix B — Quick reference: MapLibre methods we still call

After migration, the only MapLibre camera mutators in the live preview
are:

- `map.easeTo(...)` — once per ~50ms tick in the live ease loop (§3.5).
- `map.setStyle(...)` — Writer 2, on style change.
- `map.setLayoutProperty/setPaintProperty/getSource(...)` — for waypoint
  + route source data and visibility, unchanged.

In offline export:

- `map.jumpTo(...)` — once per output frame.
- `map.areTilesLoaded()` — polled per frame as a capture barrier.

Everything else (`flyTo`, `cameraForBounds`, `fitBounds`,
`map.getBounds().contains(...)`) is gone from our hot path.
