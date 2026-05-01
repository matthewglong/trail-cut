// Pure, renderer-portable camera-intent surface. Composes with
// `routeLocation.ts` to drive the map's framing in a viewport-agnostic way.

import type {
  Clip,
  ClipEntryTransition,
  MapSettings,
  ProjectStartCamera,
} from '../types';
import { resolveMapSettings, type BearingMode } from '../types';
import {
  parseTimestamp,
  clipWaypointLocation,
  computeBearingKeyframes,
  bearingFromKeyframes,
  circularLerp,
  locationAt,
  type IndexedRoute,
  type BearingKeyframe,
} from './routeLocation';

// -- Core geometric / camera types ------------------------------------------

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

// -- Timeline anchors and the MapTrack --------------------------------------

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
  /** Project-level "transition feel" knob. */
  transitionFeel: TransitionFeel;
}

export type TransitionFeel = 'natural' | 'snappy' | 'slow';

// -- Compiled timeline (project-time) ---------------------------------------
//
// Runtime-only. Produced by `compileTimeline` (task 520) from the ordered
// clip list, authored entry-transition settings, and media durations. Never
// persisted: project-time is fully derived. See
// `docs/migration/COMPILED_TIMELINE_PLAN.md` §"Data Model → Compiled Data"
// for the design contract — compiler purity, span endpoints, and continuity
// invariants.
//
// Coexists with the wall-clock `MapAnchor`/`MapTrack` above during the 500-
// series migration. Task 570 removes the wall-clock types once the new path
// is fully wired.

/** A clip's contribution to the compiled timeline. `startMs`/`endMs` live on
 *  the project-time axis; `mediaInMs`/`mediaOutMs` live on the clip-local
 *  axis (matching `clip.trim`). The two axes are related by
 *  `endMs - startMs = (mediaOutMs - mediaInMs) / clip.effects.speed`.
 *
 *  `canonicalSeekMs` is the project-time the preview should land on when the
 *  user selects this clip. Per `COMPILED_TIMELINE_PLAN.md` §"Preview
 *  Semantics", this is typically `startMs` — i.e. *after* any incoming
 *  transition — so selecting a clip shows the camera state export would
 *  render at the start of that clip's media. */
export interface ClipSpan {
  clipId: string;
  /** Project-time, ms. Inclusive start of the clip's contribution. */
  startMs: number;
  /** Project-time, ms. Exclusive end of the clip's contribution. */
  endMs: number;
  /** Clip-local, ms. Equals `clip.trim.in_ms`. */
  mediaInMs: number;
  /** Clip-local, ms. Equals `clip.trim.out_ms`. */
  mediaOutMs: number;
  /** Project-time, ms. Where preview selection lands for this clip. */
  canonicalSeekMs: number;
  /** Equals `clip.effects.speed`. Stored on the span so the project-time →
   *  clip-local → wall-clock translation in `cameraAt(timeline, t)` is a
   *  pure function of the timeline (no `Clip` lookup required). */
  speed: number;
  /** `parseTimestamp(clip.created_at)`. The wall-clock anchor of `mediaInMs
   *  = 0`. Stored here so the evaluator can resolve follow intents without
   *  re-parsing timestamps. NaN is impossible — `compileTimeline` filters
   *  unparseable `created_at` upstream. */
  wallClockBaseMs: number;
  /** The camera intent active inside this clip span. Produced by the
   *  existing `anchorIntentForClip` (or its successor). */
  intent: CameraIntent;
}

/** A camera transition's contribution to the compiled timeline. One per clip
 *  including clip 1's project-start → clip 1 transition (`fromClipId: null`).
 *
 *  Spans the project-time window over which a Van Wijk arc plays between two
 *  canonical resolved cameras: the previous clip's terminal camera (or the
 *  project start camera, for clip 1) and the destination clip's initial
 *  camera. `effectiveDurationMs` is the post-clamp width of that window —
 *  `endMs - startMs` after the boundary formula's `min(requestedX,
 *  availableX)` clamps the requested pre/post-cut sides against neighboring
 *  media availability. See `COMPILED_TIMELINE_PLAN.md` §"Boundary Formula". */
export interface TransitionSpan {
  /** `null` for the project-start → clip-1 transition. */
  fromClipId: string | null;
  toClipId: string;
  /** Project-time, ms. */
  startMs: number;
  /** Project-time, ms. */
  endMs: number;
  /** Equals `endMs - startMs`. Provided as a named field so call sites can
   *  read "duration after clamping" without recomputing. */
  effectiveDurationMs: number;
}

/** The fully compiled timeline. Pure function of (ordered clips, indexed
 *  route, project settings). Same inputs → deeply-equal output. See
 *  `COMPILED_TIMELINE_PLAN.md` §"Continuity Invariants" for the gating
 *  guarantees the compiler/evaluator must satisfy. */
export interface CompiledTimeline {
  clipSpans: ClipSpan[];
  transitionSpans: TransitionSpan[];
  /** Equals `clipSpans[clipSpans.length - 1].endMs`, or 0 if no clips. */
  totalDurationMs: number;
  /** Resolved at compile time from `Project.start_camera` (override) or the
   *  computed default. Used as the `from` endpoint of clip 1's transition
   *  arc and as the `t < 0` hold camera in the evaluator. */
  startCamera: ResolvedCamera;
  /** Project-level feel pass-through. Applies only to auto-derived
   *  transition durations; authored `durationMs` is respected literally. */
  transitionFeel: TransitionFeel;
}

// -- Van Wijk arc parameters ------------------------------------------------

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

// -- DEFAULT_INTENT constant ------------------------------------------------

/** Fallback intent used by `cameraAt` when a track has no anchors. The
 *  coordinates are an arbitrary marker (San Francisco) that's only ever
 *  seen if a project has no visible, timestamped clips. */
export const DEFAULT_INTENT: CameraIntent = {
  kind: 'point',
  center: { lng: -122.4194, lat: 37.7749 },
  zoom: 10,
  bearing: 0,
  pitch: 0,
};

// -- Pure geometric helpers -------------------------------------------------

/** World pixel size at zoom 0. We pick 512 to match MapLibre's default
 *  TILE_SIZE so that any zoom values produced here read identically to
 *  MapLibre's own `cameraForBounds` output. (Choosing 256 would shift every
 *  resolved zoom by exactly +1 — same framing, different numeric label.) */
const WORLD_SIZE_AT_ZOOM_0 = 512;

/** Project a `LngLat` into world-pixel coordinates at zoom 0. Standard
 *  Web Mercator (spherical), clamped implicitly by the caller — latitudes
 *  approaching ±90° will blow up because tan(latRad) → ∞. Bounds within
 *  the Mercator-valid band (≈±85.0511°) are well-defined. */
function lngLatToMercator(ll: LngLat): { x: number; y: number } {
  const x = ((ll.lng + 180) / 360) * WORLD_SIZE_AT_ZOOM_0;
  const latRad = (ll.lat * Math.PI) / 180;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    WORLD_SIZE_AT_ZOOM_0;
  return { x, y };
}

/** Pure port of MapLibre's `cameraForBounds`. Computes the zoom and
 *  geographic center that frame `bounds` inside `viewport` with a symmetric
 *  inset of `padding * min(width, height)` pixels. Bearing and pitch are
 *  passed through unchanged from `extra`.
 *
 *  Algorithm:
 *    1. `pad = padding * min(viewport.width, viewport.height)` (px)
 *    2. Project `sw` and `ne` to world pixels at zoom 0 (Web Mercator).
 *    3. `dx = ne.x - sw.x`, `dy = sw.y - ne.y` (mercator Y grows southward).
 *    4. `zx = log2((W - 2*pad) / dx)`, `zy = log2((H - 2*pad) / dy)`.
 *    5. `zoom = min(zx, zy)` — the limiting axis wins.
 *    6. `center` = bounds midpoint in `lng/lat` (straight average).
 *
 *  Padding is rejected (not clamped) when `>= 0.5` because such an inset
 *  would consume the entire smaller dimension of the viewport and leave
 *  zero or negative pixels of usable framing. Silent clamping would hide
 *  caller bugs; explicit rejection surfaces them.
 *
 *  Antimeridian limitation: bounds that straddle ±180° longitude are not
 *  handled in v1 — `lngLatToMercator` projects each corner independently,
 *  so a bounds with `sw.lng = 170, ne.lng = -170` is interpreted as the
 *  long way around the world. Document and revisit if a real route ever
 *  crosses the antimeridian. */
export function cameraForBounds(
  bounds: Bounds,
  padding: Padding,
  viewport: Viewport,
  extra: { bearing: number; pitch: number },
): ResolvedCamera {
  if (padding >= 0.5) {
    throw new Error(
      `cameraForBounds: padding must be < 0.5 (got ${padding}); a fractional padding ≥ 0.5 would inset the smaller viewport dimension to ≤0 pixels.`,
    );
  }

  const pad = padding * Math.min(viewport.width, viewport.height);

  const sw = lngLatToMercator(bounds.sw);
  const ne = lngLatToMercator(bounds.ne);

  const dx = ne.x - sw.x;
  const dy = sw.y - ne.y;

  const zx = Math.log2((viewport.width - 2 * pad) / dx);
  const zy = Math.log2((viewport.height - 2 * pad) / dy);
  const zoom = Math.min(zx, zy);

  const center: LngLat = {
    lng: (bounds.sw.lng + bounds.ne.lng) / 2,
    lat: (bounds.sw.lat + bounds.ne.lat) / 2,
  };

  return {
    center,
    zoom,
    bearing: extra.bearing,
    pitch: extra.pitch,
  };
}

// -- Function signatures ----------------------------------------------------

/** Build a MapTrack from project state. Pure.
 *
 *  For each visible clip with a parseable `created_at` and a non-degenerate
 *  trim range, builds one anchor whose `intent` is chosen by
 *  `anchorIntentForClip`. Anchors are sorted by start time so `cameraAt`'s
 *  linear scan can rely on monotonicity.
 *
 *  Note on `route`: caller is responsible for indexing the GPX route via
 *  `indexRoute` before calling. We do *not* call `indexRoute` here so this
 *  function stays a pure mapping over already-derived inputs. */
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
    const inMs = clip.trim?.in_ms ?? 0;
    const outMs = clip.trim?.out_ms ?? clip.duration_ms ?? 0;
    if (outMs <= inMs) continue;

    const settings = resolveMapSettings(projectMapSettings, clip.map_overrides);
    const startMs = baseMs + inMs;
    const endMs = baseMs + outMs;
    const intent = anchorIntentForClip(clip, settings, route, startMs, endMs);
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
 *  dependency on `IndexedRoute` math at render time.
 *
 *  `computeBearingKeyframes` returns `null` for degenerate inputs (no route,
 *  zero-length range, etc.). We coerce that to an empty array on the
 *  intent — `resolveIntent`'s 'auto' branch already falls back to bearing 0
 *  when `bearingKeyframes.length === 0`. */
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
        ? (computeBearingKeyframes(
            anchorStartMs,
            anchorEndMs,
            route,
            settings.bearing_stops,
          ) ?? [])
        : [];
    return {
      kind: 'follow',
      // Initial value; `cameraAt` overwrites this per-frame via `liveIntent`.
      playheadMs: anchorStartMs,
      route,
      targetZoom: settings.zoom,
      bearingMode: settings.bearing_mode,
      // Fraction of min(viewport.w, viewport.h). Reserved for future
      // "frame the marker plus N meters" extensions; ignored by today's
      // 'follow' branch in resolveIntent.
      padding: 0.06,
      fixedBearingDegrees: settings.bearing_degrees,
      bearingKeyframes,
      pitch,
    };
  }

  // Fallback: a static point on the clip's waypoint. Coordinates fall back
  // to {lng:0, lat:0} when neither GPX nor embedded GPS resolves.
  const wp = clipWaypointLocation(clip, route);
  return {
    kind: 'point',
    center: wp ? { lng: wp.lng, lat: wp.lat } : { lng: 0, lat: 0 },
    zoom: settings.zoom,
    bearing: settings.bearing_mode === 'fixed' ? settings.bearing_degrees : 0,
    pitch,
  };
}

/** Wall-clock evaluator (legacy path). Returns the intent that should be
 *  active at wall-clock time t against a `MapTrack`. Pure: deterministic in
 *  (track, t). No hidden state. No MapLibre.
 *
 *  Renamed from `cameraAt` in task 530 to disambiguate from the new
 *  project-time `cameraAt(timeline, t)` further down. Surviving call sites
 *  (the legacy `MapView` ease loop) hand off to the new evaluator in task
 *  550; this function plus the rest of the wall-clock anchor surface
 *  (`MapAnchor`, `MapTrack`, `buildMapTrack`, `interpolateAnchors`) is
 *  removed in task 570.
 *
 *  Output kinds:
 *    - empty track                    → DEFAULT_INTENT
 *    - before first anchor's start    → `liveIntent(first.intent, t)`
 *    - inside an anchor's range       → `liveIntent(active.intent, t)`
 *    - after last anchor's end        → `liveIntent(last.intent, last.endTimeMs)`
 *      (clamped t — holding past the last clip should display the same
 *      framing the last frame of that clip rendered, not advance the
 *      follow marker into "no-clip" territory)
 *    - in a gap between two anchors   → `interpolateAnchors(a, next, t, feel)`
 *      (always returns a `point` intent) */
export function cameraAtWallClock(track: MapTrack, t: number): CameraIntent {
  const { anchors } = track;
  if (anchors.length === 0) {
    return DEFAULT_INTENT;
  }
  // Before the first anchor: hold the first anchor's framing at t.
  if (t <= anchors[0].timeMs) {
    return liveIntent(anchors[0].intent, t);
  }
  // After the last anchor: hold the last anchor's framing at its endTimeMs
  // (i.e. don't drag the follow marker beyond the last clip's end).
  const last = anchors[anchors.length - 1];
  if (t >= last.endTimeMs) {
    return liveIntent(last.intent, last.endTimeMs);
  }

  // Find the active anchor or the bracketing pair for a gap.
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    if (t >= a.timeMs && t <= a.endTimeMs) {
      // Inside clip i — return the live (per-frame) intent.
      return liveIntent(a.intent, t);
    }
    const next = anchors[i + 1];
    if (next && t > a.endTimeMs && t < next.timeMs) {
      // Gap between clips — Van Wijk interpolation.
      return interpolateAnchors(a, next, t, track.transitionFeel);
    }
  }
  // Unreachable in well-formed (sorted, non-overlapping) tracks; fall back
  // to holding the last anchor rather than throwing.
  return liveIntent(last.intent, last.endTimeMs);
}

/** For `follow` intents, evaluate at the current t (overwrite `playheadMs`).
 *  For `point` and `region`, return as-is — they are time-invariant within
 *  the clip's range. Pure. */
function liveIntent(intent: CameraIntent, t: number): CameraIntent {
  if (intent.kind === 'follow') {
    return { ...intent, playheadMs: t };
  }
  return intent;
}

/** Resolve a CameraIntent to a concrete camera given the renderer's
 *  viewport. Pure in (intent, viewport). The same intent resolved against
 *  two different viewports correctly produces two different framings.
 *
 *  This is the **only** aspect-aware function in the architecture. The
 *  fractional `Padding` on a `region` intent is converted to pixels here
 *  against the viewport's smaller dimension; everywhere else, padding stays
 *  unitless.
 *
 *  `follow` resolution intentionally does NOT walk the IndexedRoute for
 *  bearing — `bearingKeyframes` are precomputed once per anchor by
 *  `buildMapTrack` and frozen on the intent. The empty-array fallback
 *  (bearing = 0) handles degenerate inputs (no route, zero-length window,
 *  etc.) without coupling this function back to route math. */
export function resolveIntent(
  intent: CameraIntent,
  viewport: Viewport,
): ResolvedCamera {
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
      const loc = locationAt(intent.playheadMs, intent.route, null);
      const center: LngLat = loc
        ? { lng: loc.lng, lat: loc.lat }
        : { lng: 0, lat: 0 };

      const bearing =
        intent.bearingMode === 'auto'
          ? intent.bearingKeyframes.length > 0
            ? bearingFromKeyframes(intent.playheadMs, intent.bearingKeyframes)
            : 0
          : (intent.fixedBearingDegrees ?? 0);

      return {
        center,
        zoom: intent.targetZoom,
        bearing,
        pitch: intent.pitch,
      };
    }
  }
}

/** Canonical 1024×1024 viewport used for cross-anchor interpolation.
 *  Anchor-to-anchor interpolation is intrinsically not viewport-aware —
 *  `interpolateAnchors` must produce a single arc that the renderer can
 *  later re-frame for any viewport via `resolveIntent`. We collapse
 *  region/follow anchors to a fixed reference viewport so `vanWijkArc`'s
 *  endpoints (LngLat + zoom) are well-defined regardless of where the
 *  camera ultimately renders. */
const CANONICAL_VIEWPORT: Viewport = { width: 1024, height: 1024, dpr: 1 };

/** Resolve a CameraIntent to a `ResolvedCamera` at the canonical viewport.
 *  The "follow snapshot" function: for `follow` intents it overwrites
 *  `playheadMs` with the supplied wall-clock reference time so the
 *  resulting camera is the snapshot of where the marker is at *that*
 *  instant. Per `COMPILED_TIMELINE_PLAN.md` §"Camera State During a
 *  Transition": follow intents collapse to point intents during the
 *  transition window — the transition is between two snapshots, not a
 *  moving-target chase. This is the helper that does the collapse.
 *
 *  - `point`: trivial pass-through (point intents already carry a zoom).
 *  - `region`: resolved against the canonical 1024×1024 viewport. The
 *    actual render-time framing may differ — that's `resolveIntent`'s job
 *    when the renderer takes over after the gap closes.
 *  - `follow`: evaluate at `refWallClockMs` (boundary of the clip's
 *    range, in wall-clock).
 *
 *  Used by both the legacy `interpolateAnchors` path (via the wrapper
 *  `canonicalCamera`) and the new `compileTimeline` (task 520) /
 *  `cameraAt(timeline, t)` (task 530). */
function resolveCanonical(
  intent: CameraIntent,
  refWallClockMs: number,
): ResolvedCamera {
  if (intent.kind === 'follow') {
    return resolveIntent(
      { ...intent, playheadMs: refWallClockMs },
      CANONICAL_VIEWPORT,
    );
  }
  return resolveIntent(intent, CANONICAL_VIEWPORT);
}

/** Wall-clock-anchor wrapper around `resolveCanonical`. Kept for the
 *  legacy `interpolateAnchors` call site; deleted in task 570 along with
 *  the rest of the wall-clock anchor surface. */
function canonicalCamera(
  anchor: MapAnchor,
  refTimeMs: number,
): ResolvedCamera {
  return resolveCanonical(anchor.intent, refTimeMs);
}

/** Clamp a number into [0, 1]. Internal helper for `interpolateAnchors`. */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Standard cubic ease-in-out on [0, 1].
 *  Matches the curve used by most UI animation libraries: gentle start,
 *  fast middle, gentle end. The `_feel` parameter is accepted for API
 *  symmetry but unused — feel manifests through `arcDurationMs`'s
 *  multiplier (snappy=0.6, slow=1.5), not the easing curve itself. */
function easeInOut(x: number, _feel: TransitionFeel): number {
  return x < 0.5
    ? 4 * x * x * x
    : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** Interpolate from anchor A to anchor B at time t.
 *  Uses Van Wijk & Nuij (2003) "Smooth and Efficient Zooming and Panning"
 *  to produce a smooth zoom-out + pan + zoom-in arc between the two
 *  anchors' canonical resolved cameras.
 *
 *  Returns a `point` intent (the interpolated state at t). The renderer
 *  passes this through `resolveIntent` like any other intent — gap frames
 *  and clip frames go through the same pipeline.
 *
 *  Time mapping: the arc's wall-clock duration is `arcDurationMs(arc, feel)`,
 *  starting at `a.endTimeMs`. `t` outside that window clamps to the
 *  appropriate endpoint (cubic ease-in-out compresses the [0,1] map at
 *  the boundaries — but `clamp01` ensures values strictly outside snap to
 *  exactly camA/camB, not just "very close").
 *
 *  Bearing in gap arcs: lerping between camA.bearing and camB.bearing at
 *  the canonical-time endpoints (a.endTimeMs / b.timeMs) may diverge from
 *  the GPX direction-of-travel mid-gap when the two clips point very
 *  different ways. If the arc rotation looks wrong,
 *  the fix is to consult GPX bearing at intermediate times rather than
 *  lerp endpoints — that's a contained follow-up, not a redesign. */
export function interpolateAnchors(
  a: MapAnchor,
  b: MapAnchor,
  t: number,
  feel: TransitionFeel,
): CameraIntent {
  const camA = canonicalCamera(a, a.endTimeMs);
  const camB = canonicalCamera(b, b.timeMs);

  const arc = vanWijkArc(camA, camB);

  const tStart = a.endTimeMs;
  const tEnd = tStart + arcDurationMs(arc, feel);
  const localT = clamp01((t - tStart) / Math.max(1, tEnd - tStart));
  const eased = easeInOut(localT, feel);
  const s = arc.S * eased;

  const point = vanWijkSample(camA, camB, arc, s);
  const bearing = circularLerp(camA.bearing, camB.bearing, eased);
  const pitch = camA.pitch + (camB.pitch - camA.pitch) * eased;

  return {
    kind: 'point',
    center: point.center,
    zoom: point.zoom,
    bearing,
    pitch,
  };
}

// -- Van Wijk arc primitives ------------------------------------------------
//
// Implementation of Van Wijk & Nuij (2003), "Smooth and Efficient Zooming
// and Panning." Equations (1)-(9) plus the eq. (10) linear-pan special
// case. Cross-checked against MapLibre's `src/ui/camera.ts` `flyTo` (which
// is the canonical TypeScript port of the same paper) for numerical
// agreement and edge-case handling.
//
// Key insight on units: the paper parameterizes the arc in a 1-D "world"
// where positions u and visible widths w share the same unit (call it
// "world pixels at the higher source zoom"). We follow MapLibre's choice:
//   - w0 = visible width at camA in world pixels at camA's zoom
//   - w1 = visible width at camB in those same units
//        = w0 * 2^(camA.zoom - camB.zoom)
//          (zooming in by 1 halves the visible world width)
//   - u1 = ground-plane distance from camA.center to camB.center in those
//          same world pixels at camA's zoom.
// With these conventions, `zoom(s) = camA.zoom - log2(w(s))` because
// `w(s) = w(0)/scale` and a doubling of scale is +1 zoom level.

/** Smoothing parameter from Van Wijk & Nuij (2003). The paper's user study
 *  found 1.42 to be the average preferred value; MapLibre uses the same
 *  default and today's `DEFAULT_MAP_TRANSITION.curve` is also 1.42.
 *  Higher rho → straighter (more zoom-out) arc; lower rho → flatter arc. */
const RHO = 1.42;

/** Linear-branch threshold from eq. (10) of the paper / MapLibre's flyTo.
 *  When `rho * |u1 - u0|` is within this absolute tolerance OR when the
 *  derived `S` becomes non-finite, the cosh/sinh formulas degenerate and
 *  we switch to a pure exponential zoom interpolation (no pan). */
const LINEAR_BRANCH_EPSILON = 0.000002;

/** Threshold below which two cameras with no horizontal travel are also
 *  considered identical in zoom — both endpoints are the same camera. */
const DEGENERATE_ARC_EPSILON = 0.000001;

// Hyperbolic helpers — JS doesn't ship these on `Math` cross-platform-
// reliably for `tanh`, so we inline all three for parity with MapLibre.
function sinh(n: number): number {
  return (Math.exp(n) - Math.exp(-n)) / 2;
}
function cosh(n: number): number {
  return (Math.exp(n) + Math.exp(-n)) / 2;
}
function tanh(n: number): number {
  return sinh(n) / cosh(n);
}

/** Mercator-pixel distance between two LngLats at a given MapLibre zoom.
 *  Uses the same `lngLatToMercator` projection as `cameraForBounds` (zoom
 *  0 → 512px world). Distance scales by `2^zoom`. */
function pixelDistanceAtZoom(a: LngLat, b: LngLat, zoom: number): number {
  const pa = lngLatToMercator(a);
  const pb = lngLatToMercator(b);
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const distAtZoom0 = Math.sqrt(dx * dx + dy * dy);
  return distAtZoom0 * Math.pow(2, zoom);
}

/** Build a Van Wijk arc between two resolved cameras. Pure.
 *  Implements eqs. (1)-(8) of Van Wijk & Nuij (2003) plus the eq. (10)
 *  linear-pan branch for short / pure-zoom paths. */
export function vanWijkArc(
  camA: ResolvedCamera,
  camB: ResolvedCamera,
): VanWijkArc {
  const rho = RHO;
  const rho2 = rho * rho;

  // Choose the "higher source zoom" for our common unit. Per MapLibre and
  // the paper, anchoring at camA's zoom is sufficient — w1 is then derived
  // by the zoom-ratio formula and the math is symmetric in the math sense
  // (forward and reverse arcs share the same total path length S).
  const w0 = 1; // unit width at camA's zoom; absolute scale cancels out
  const w1 = w0 * Math.pow(2, camA.zoom - camB.zoom);

  // u1 is the great-circle (here: planar Mercator) distance from camA to
  // camB, in the same unit as w0. We measure in "viewport widths" at
  // camA's zoom: distance in pixels at camA's zoom divided by w0_in_pixels.
  // Since w0=1 above is dimensionless, the actual divisor cancels — what
  // matters is u1 / w0 ratio. Use a fixed 1000-px reference width so u1
  // expresses "ground distance / 1000-px window" — same shape as MapLibre
  // (the absolute reference width drops out of S in the linear branch and
  // appears symmetrically in r0/r1 in the curved branch).
  const REFERENCE_VIEWPORT_PX = 1000;
  const distancePx = pixelDistanceAtZoom(camA.center, camB.center, camA.zoom);
  const u0 = 0;
  const u1 = distancePx / REFERENCE_VIEWPORT_PX;

  // ------------------------------------------------------------------
  // Edge case: linear-zoom branch (eq. 10). Same-place pure zoom (or
  // numerically tiny pan) — cosh/sinh formulas blow up, fall back to a
  // pure exponential `w(s) = w0 * exp(±rho * s)` with u(s) = 0.
  // ------------------------------------------------------------------
  if (rho * Math.abs(u1 - u0) < LINEAR_BRANCH_EPSILON) {
    if (Math.abs(w0 - w1) < DEGENERATE_ARC_EPSILON) {
      // Both endpoints identical (within tolerance). Return a zero-length
      // arc; sampling at any s returns camA.
      return { rho, u0, u1, r0: 0, r1: 0, w0, S: 0 };
    }
    const S = Math.abs(Math.log(w1 / w0)) / rho;
    // r0/r1 are unused in the linear branch but must be finite so callers
    // can serialize/log them safely. 0 is a sentinel — `vanWijkSample`
    // detects the linear branch by `arc.u1 - arc.u0` being near-zero.
    return { rho, u0, u1, r0: 0, r1: 0, w0, S };
  }

  // ------------------------------------------------------------------
  // Curved branch (paper §4 eqs. 7-8). r0 / r1 are the "rapidity"
  // coefficients; S is the total arc length.
  // ------------------------------------------------------------------
  // b(i) from eq. (7), where i ∈ {0, 1}. Both share the `w1² - w0²`
  // numerator base; the descent flag (i=1 → descent=true) flips the sign
  // of the ρ⁴(u1-u0)² term, and the denominator uses wi. Matches MapLibre's
  // `zoomOutFactor(descent)` exactly.
  const du = u1 - u0;
  const b = (i: 0 | 1): number => {
    const wi = i === 0 ? w0 : w1;
    const sign = i === 0 ? 1 : -1;
    return (
      (w1 * w1 - w0 * w0 + sign * rho2 * rho2 * du * du) /
      (2 * wi * rho2 * du)
    );
  };

  // r(i) = ln(-b(i) + sqrt(b(i)^2 + 1)) — eq. (7).
  const r = (i: 0 | 1): number => {
    const bi = b(i);
    return Math.log(-bi + Math.sqrt(bi * bi + 1));
  };

  const r0 = r(0);
  const r1 = r(1);
  const S = (r1 - r0) / rho;

  return { rho, u0, u1, r0, r1, w0, S };
}

/** Sample the arc at parameter `s ∈ [0, arc.S]`.
 *  Returns the geographic center and (real) zoom at that arc position.
 *
 *  Center is interpolated linearly between camA.center and camB.center via
 *  the normalized arc-length parameter u(s)/u1 (paper eq. 9). On the
 *  linear branch (camA.center ≈ camB.center) this collapses to camA.center.
 *
 *  Zoom comes from w(s): a doubling of the visible window halves zoom, so
 *  `zoom(s) = camA.zoom - log2(w(s) / w0)`. */
export function vanWijkSample(
  camA: ResolvedCamera,
  camB: ResolvedCamera,
  arc: VanWijkArc,
  s: number,
): { center: LngLat; zoom: number } {
  const { rho, u0, u1, r0, w0 } = arc;

  // Detect the linear branch via the same predicate vanWijkArc used.
  const isLinearBranch = rho * Math.abs(u1 - u0) < LINEAR_BRANCH_EPSILON;

  let wRatio: number; // w(s) / w0
  let uFraction: number; // (u(s) - u0) / (u1 - u0); 0 at camA, 1 at camB

  if (isLinearBranch) {
    // Pure-zoom branch. Direction of zoom (in vs. out) determined by
    // whether camB is closer (w1 < w0) → k=-1, or farther → k=+1.
    const w1 = w0 * Math.pow(2, camA.zoom - camB.zoom);
    if (Math.abs(w0 - w1) < DEGENERATE_ARC_EPSILON) {
      // Degenerate: arc.S == 0, every sample is camA.
      return { center: { ...camA.center }, zoom: camA.zoom };
    }
    const k = w1 < w0 ? -1 : 1;
    wRatio = Math.exp(k * rho * s);
    // Fraction of the way through the arc (0..1). Linearly proportional
    // to s/S so that s=0→camA and s=S→camB exactly.
    uFraction = arc.S === 0 ? 0 : s / arc.S;
  } else {
    // Curved branch — paper eqs. (8) and (9).
    wRatio = cosh(r0) / cosh(r0 + rho * s);
    const uPath =
      w0 * ((cosh(r0) * tanh(r0 + rho * s) - sinh(r0)) / (rho * rho));
    // u(s) is in our shared unit; normalize to the camA→camB span.
    uFraction = uPath / (u1 - u0);
  }

  // Linear lng/lat lerp — fine for the small geographic spans typical
  // here (the paper's small-area assumption holds at the meter scale of
  // hiking footage). Great-circle interpolation is overkill at this scale
  // and would diverge negligibly from the linear path inside any single
  // viewport's worth of geography.
  const center: LngLat = {
    lng: camA.center.lng + (camB.center.lng - camA.center.lng) * uFraction,
    lat: camA.center.lat + (camB.center.lat - camA.center.lat) * uFraction,
  };

  // zoom(s) = camA.zoom - log2(w(s) / w0). At s=0, wRatio=1 → zoom=camA.zoom.
  // At s=S, wRatio = w1/w0 = 2^(camA.zoom - camB.zoom) so log2(wRatio) =
  // camA.zoom - camB.zoom and zoom = camB.zoom. Exact at both endpoints.
  const zoom = camA.zoom - Math.log2(wRatio);

  return { center, zoom };
}

/** Per-feel duration multiplier:
 *    natural: 1.0 (matches today's defaults baseMs:1100, msPerZoomLevel:580)
 *    snappy:  0.6 (≈ baseMs:600,  msPerZoomLevel:320)
 *    slow:    1.5 (≈ baseMs:1800, msPerZoomLevel:900)
 *  Internal helper — exported only via `arcDurationMs`. */
function feelMultiplier(feel: TransitionFeel): number {
  switch (feel) {
    case 'snappy':
      return 0.6;
    case 'slow':
      return 1.5;
    case 'natural':
    default:
      return 1.0;
  }
}

/** Tuning constants for `arcDurationMs`. These map the unitless arc length
 *  `S` (natural-log of zoom-distance ratio) into wall-clock milliseconds.
 *
 *  - `MS_PER_S_UNIT = 800`: chosen empirically so a typical hiking-clip arc
 *    (roughly 1-2 zoom levels of zoom-out + a viewport of pan) lands near
 *    today's `runClipTransition` defaults (baseMs ≈ 1100). For the canonical
 *    "1 zoom level + 1 viewport pan" arc, S ≈ 1.4, giving base ≈ 1120ms —
 *    well within the ±10% target of today's 1100ms baseline. Treat as a
 *    starting point, not gospel.
 *  - `MIN_MS = 1100`: floor — pure zoom-only (S≈0) transitions still need a
 *    perceptible duration. Matches today's `DEFAULT_MAP_TRANSITION.baseMs`.
 *  - `MAX_MS = 7000`: ceiling — extreme cross-country jumps shouldn't run
 *    arbitrarily long. Matches today's effective ceiling. */
const MS_PER_S_UNIT = 800;
const MIN_MS = 1100;
const MAX_MS = 7000;

/** Auto-derive the arc duration from path length and "transition feel."
 *  Formula: `clamp(arc.S * MS_PER_S_UNIT, MIN_MS, MAX_MS) * feelMultiplier`.
 *  Symmetric: `arcDurationMs` for an A→B arc equals B→A because S is
 *  invariant under endpoint swap (paper §4). */
export function arcDurationMs(arc: VanWijkArc, feel: TransitionFeel): number {
  const raw = arc.S * MS_PER_S_UNIT;
  const base = Math.max(MIN_MS, Math.min(MAX_MS, raw));
  return base * feelMultiplier(feel);
}

// -- Compiled-timeline compiler ---------------------------------------------
//
// Pure compiler that walks the ordered clip list, applies authored entry-
// transition settings, and produces a `CompiledTimeline`. Same authored
// inputs → same compiled output, deeply equal across calls. See
// `docs/migration/COMPILED_TIMELINE_PLAN.md` §"Implementation Plan → 3" and
// §"Entry Placement → Boundary Formula" for the design.
//
// The compiler is the single place where authored data meets media reality:
// clip-local trim ranges + clip ordering + speed → project-time spans;
// authored `entryBias` / `durationMs` + neighboring media availability →
// clamped transition spans.
//
// Reuses `anchorIntentForClip` (above) for per-clip intents,
// `vanWijkArc` + `arcDurationMs` for auto-derived transition durations,
// and `resolveCanonical` for collapsing follow intents into the snapshot
// cameras a Van Wijk arc connects.

/** Settings the compiler reads off the project. Narrow object so this
 *  module stays free of a transitive dependency on the full `Project`
 *  type. Field names match the persisted shape in `types.ts` /
 *  `models.rs`. */
export interface CompileTimelineProjectSettings {
  transition_feel?: TransitionFeel;
  start_camera?: ProjectStartCamera;
  default_entry_transition?: ClipEntryTransition;
}

/** Merge a project-level entry-transition default with a per-clip
 *  override. Per-field override → fall back to default. The compiler
 *  treats this merged shape as the authoritative authoring for the
 *  destination clip's transition. */
function mergeEntryTransition(
  base: ClipEntryTransition | undefined,
  override: ClipEntryTransition | undefined,
): ClipEntryTransition {
  return {
    enabled: override?.enabled ?? base?.enabled,
    duration_ms: override?.duration_ms ?? base?.duration_ms,
    entry_bias: override?.entry_bias ?? base?.entry_bias,
    feel: override?.feel ?? base?.feel,
  };
}

/** Resolve the project's start camera. Honors `project.start_camera` when
 *  present; otherwise computes the default per `COMPILED_TIMELINE_PLAN.md`
 *  §"Project Start Camera": centroid of clip starting locations, zoom 12,
 *  bearing 0, pitch 0/60-by-style.
 *
 *  Pure: no DOM, no MapLibre, no `performance.now`. */
export function resolveProjectStartCamera(
  clips: Clip[],
  settings: CompileTimelineProjectSettings,
  projectMapSettings: MapSettings,
  route: IndexedRoute | null,
): ResolvedCamera {
  if (settings.start_camera) {
    return {
      center: {
        lng: settings.start_camera.center.lng,
        lat: settings.start_camera.center.lat,
      },
      zoom: settings.start_camera.zoom,
      bearing: settings.start_camera.bearing,
      pitch: settings.start_camera.pitch,
    };
  }

  let sumLng = 0;
  let sumLat = 0;
  let count = 0;
  for (const clip of clips) {
    const wp = clipWaypointLocation(clip, route);
    if (wp) {
      sumLng += wp.lng;
      sumLat += wp.lat;
      count += 1;
    }
  }
  const center: LngLat =
    count > 0
      ? { lng: sumLng / count, lat: sumLat / count }
      : { lng: 0, lat: 0 };

  return {
    center,
    zoom: 12,
    bearing: 0,
    pitch: projectMapSettings.map_style === '3d' ? 60 : 0,
  };
}

/** Apply the same skip rules `buildMapTrack` enforces: invisible clips,
 *  missing/unparseable `created_at`, degenerate trim ranges. Returns the
 *  filtered list in the same order. */
function filterCompilableClips(clips: Clip[]): Clip[] {
  const out: Clip[] = [];
  for (const clip of clips) {
    if (clip.visible === false) continue;
    if (!clip.created_at) continue;
    if (Number.isNaN(parseTimestamp(clip.created_at))) continue;
    const inMs = clip.trim?.in_ms ?? 0;
    const outMs = clip.trim?.out_ms ?? clip.duration_ms ?? 0;
    if (outMs <= inMs) continue;
    out.push(clip);
  }
  return out;
}

/** Wall-clock equivalent of a clip-span endpoint. Used for `resolveCanonical`
 *  on follow intents — the wall-clock the marker should snapshot at. */
function wallClockAtClipSpanEdge(
  clip: Clip,
  span: ClipSpan,
  edge: 'start' | 'end',
): number {
  const base = parseTimestamp(clip.created_at!);
  return edge === 'start' ? base + span.mediaInMs : base + span.mediaOutMs;
}

/** Compile an ordered clip list into a CompiledTimeline. Pure.
 *
 *  - Clip spans tile the project-time axis end-to-end with no gaps.
 *  - Each transition span (one per visible clip, including the project-
 *    start → clip-1 transition) is computed by the boundary formula in
 *    `COMPILED_TIMELINE_PLAN.md` §"Entry Placement → Boundary Formula"
 *    and clamped against neighboring span lengths.
 *  - The startCamera is `project.start_camera` if set, else the computed
 *    default centroid camera.
 *  - `transitionFeel` propagates from `project.transition_feel ??
 *    'natural'`.
 *
 *  Skip rules match `buildMapTrack`: invisible clips, missing or
 *  unparseable `created_at`, and degenerate trim ranges (`out <= in`) are
 *  excluded. An empty clip list produces a valid, empty CompiledTimeline.
 *
 *  Note on consumer: the new `cameraAt(timeline, t)` evaluator (task 530)
 *  reads this output. `MapAnchor` / `MapTrack` produced by `buildMapTrack`
 *  are an independent path that survives until task 570. */
export function compileTimeline(
  clips: Clip[],
  route: IndexedRoute | null,
  projectMapSettings: MapSettings,
  settings: CompileTimelineProjectSettings,
): CompiledTimeline {
  const transitionFeel: TransitionFeel = settings.transition_feel ?? 'natural';

  const validClips = filterCompilableClips(clips);

  // Pre-compute the start camera (used both for clip 1's transition arc
  // and stored on the CompiledTimeline for the t<0 hold).
  const startCamera = resolveProjectStartCamera(
    validClips,
    settings,
    projectMapSettings,
    route,
  );

  if (validClips.length === 0) {
    return {
      clipSpans: [],
      transitionSpans: [],
      totalDurationMs: 0,
      startCamera,
      transitionFeel,
    };
  }

  // Build clip spans by tiling the project-time axis end-to-end.
  const clipSpans: ClipSpan[] = [];
  let cursor = 0;
  for (const clip of validClips) {
    const inMs = clip.trim?.in_ms ?? 0;
    const outMs = clip.trim?.out_ms ?? clip.duration_ms ?? 0;
    // Defensive: speed should be positive per the schema. A non-positive
    // speed would produce a non-positive lengthMs and break tiling.
    const speed = clip.effects.speed > 0 ? clip.effects.speed : 1;
    const lengthMs = (outMs - inMs) / speed;

    const spanStartMs = cursor;
    const spanEndMs = cursor + lengthMs;

    // Build the per-clip intent. anchorIntentForClip wants wall-clock
    // anchor start/end so it can pre-compute bearing keyframes against
    // GPX trackpoint timestamps. The bearing keyframes stay on the
    // wall-clock axis; the new evaluator translates project-time →
    // wall-clock at evaluation time before reading them.
    const baseWallMs = parseTimestamp(clip.created_at!);
    const settingsForClip = resolveMapSettings(projectMapSettings, clip.map_overrides);
    const intent = anchorIntentForClip(
      clip,
      settingsForClip,
      route,
      baseWallMs + inMs,
      baseWallMs + outMs,
    );

    clipSpans.push({
      clipId: clip.id,
      startMs: spanStartMs,
      endMs: spanEndMs,
      mediaInMs: inMs,
      mediaOutMs: outMs,
      // canonicalSeekMs lands at the start of the clip's media, after any
      // incoming transition that sits entirely pre-cut. For transitions
      // whose post-cut content extends into this span, the camera shown
      // will still be the in-flight arc until t == transitionSpan.endMs;
      // selecting a clip seeks to startMs and the ease loop catches up
      // naturally on the next tick. See plan §"Preview Semantics".
      canonicalSeekMs: spanStartMs,
      speed,
      wallClockBaseMs: baseWallMs,
      intent,
    });
    cursor = spanEndMs;
  }

  // Build one transition span per clip. fromClipId is null for clip 1
  // (project-start → clip-1 transition).
  const transitionSpans: TransitionSpan[] = [];
  for (let i = 0; i < clipSpans.length; i++) {
    const currSpan = clipSpans[i];
    const currClip = validClips[i];
    const prevSpan = i > 0 ? clipSpans[i - 1] : null;
    const prevClip = i > 0 ? validClips[i - 1] : null;
    const cutTime = prevSpan ? prevSpan.endMs : 0;

    // Resolve authored fields: per-clip override beats project default.
    const authored = mergeEntryTransition(
      settings.default_entry_transition,
      currClip.entry_transition,
    );

    // When transitions are explicitly disabled, the span collapses to a
    // zero-length window at the cut. Continuity still holds — fromCamera
    // and toCamera coincide as the same instant.
    let durationMs: number;
    let entryBias: number;
    if (authored.enabled === false) {
      durationMs = 0;
      entryBias = 0;
    } else {
      entryBias = authored.entry_bias ?? 0;
      // Clip 1 has no pre-cut media available, so any non-+1 bias is
      // equivalent to +1 after clamping. Authoring UI should hint at
      // this; here we clamp the math without warning.

      if (authored.duration_ms != null) {
        // Authored duration: respected literally per plan §"Duration:
        // Authored vs. Auto-Derived". `transitionFeel` does not apply to
        // an authored duration.
        durationMs = authored.duration_ms;
      } else {
        // Auto-derived from the Van Wijk arc length.
        const fromCamera = prevSpan && prevClip
          ? resolveCanonical(
              prevSpan.intent,
              wallClockAtClipSpanEdge(prevClip, prevSpan, 'end'),
            )
          : startCamera;
        const toCamera = resolveCanonical(
          currSpan.intent,
          wallClockAtClipSpanEdge(currClip, currSpan, 'start'),
        );
        const arc = vanWijkArc(fromCamera, toCamera);
        const feel: TransitionFeel = authored.feel ?? transitionFeel;
        durationMs = arcDurationMs(arc, feel);
      }
    }

    const requestedPreCut = (durationMs * (1 - entryBias)) / 2;
    const requestedPostCut = (durationMs * (1 + entryBias)) / 2;
    const availablePreCut = prevSpan ? prevSpan.endMs - prevSpan.startMs : 0;
    const availablePostCut = currSpan.endMs - currSpan.startMs;
    const effectivePreCut = Math.min(requestedPreCut, availablePreCut);
    const effectivePostCut = Math.min(requestedPostCut, availablePostCut);

    const start = cutTime - effectivePreCut;
    const end = cutTime + effectivePostCut;

    transitionSpans.push({
      fromClipId: prevClip ? prevClip.id : null,
      toClipId: currClip.id,
      startMs: start,
      endMs: end,
      effectiveDurationMs: end - start,
    });
  }

  return {
    clipSpans,
    transitionSpans,
    totalDurationMs: clipSpans[clipSpans.length - 1].endMs,
    startCamera,
    transitionFeel,
  };
}

// -- Compiled-timeline evaluator (project-time) -----------------------------
//
// The new project-time `cameraAt(timeline, t)`. Single source of truth for
// preview AND export. Pure in (timeline, t): same inputs → same output.
// Routes by t-region:
//
//   - empty timeline           → startCamera as a point intent
//   - t < 0                    → startCamera as a point intent
//   - t >= totalDurationMs     → last clip's intent, clamped to its endMs
//   - inside a transition span → Van Wijk between the canonical resolved
//                                 cameras at the boundary, parameterized by
//                                 a cubic-eased localT
//   - inside a clip span       → the clip's authored intent, with project-
//                                 time → clip-local → wall-clock translation
//                                 for follow intents
//
// Span-lookup tradeoff: clip and transition spans are short (≤ a few dozen
// per project), so a linear scan is the simplest correct routing. Binary
// search would be valid but over-engineered for this size. Transition span
// lookup explicitly preserves "later span wins" in the pathological both-
// sides-overrun case where two adjacent transitions share project-time.

/** Promote a `ResolvedCamera` to a `point` CameraIntent. Used at the t<0
 *  hold and the empty-timeline fallback so callers always receive a
 *  CameraIntent (not a ResolvedCamera) — viewport stays out of this layer. */
function startCameraAsPointIntent(cam: ResolvedCamera): CameraIntent {
  return {
    kind: 'point',
    center: { lng: cam.center.lng, lat: cam.center.lat },
    zoom: cam.zoom,
    bearing: cam.bearing,
    pitch: cam.pitch,
  };
}

/** Inside-clip-span live intent. For follow intents, translates project-time
 *  `t` → clip-local → wall-clock per `COMPILED_TIMELINE_PLAN.md` §"Time-Axis
 *  Translation" and overwrites `playheadMs`. For point/region, returns the
 *  intent unchanged (time-invariant within a clip span).
 *
 *  Clamps `t` into `[span.startMs, span.endMs]` before translating so a
 *  caller probing `t > span.endMs` does not drag the follow marker past the
 *  clip's last GPX point. */
function liveIntentForClipSpan(span: ClipSpan, t: number): CameraIntent {
  if (span.intent.kind !== 'follow') return span.intent;
  const tClamped =
    t < span.startMs ? span.startMs : t > span.endMs ? span.endMs : t;
  const clipLocalMs = (tClamped - span.startMs) * span.speed + span.mediaInMs;
  const wallClockMs = span.wallClockBaseMs + clipLocalMs;
  return { ...span.intent, playheadMs: wallClockMs };
}

/** Find the clip span containing project-time `t`. All but the last span
 *  use a half-open `[start, end)` interval so the seam between adjacent
 *  spans belongs to the later span; the last span is closed on the right
 *  to handle `t == totalDurationMs` exactly. Returns null only for
 *  out-of-range `t`, which the caller's region-routing rules out. */
function findClipSpanAt(spans: ClipSpan[], t: number): ClipSpan | null {
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    const isLast = i === spans.length - 1;
    if (t >= s.startMs && (isLast ? t <= s.endMs : t < s.endMs)) return s;
  }
  return null;
}

/** Find the transition span that owns project-time `t`. Closed on both ends
 *  so `cameraAt(transitionSpan.endMs)` returns the localT=1 sample (= the
 *  destination clip's initial canonical camera) — directly satisfying the
 *  continuity invariant in `COMPILED_TIMELINE_PLAN.md` §"Continuity
 *  Invariants". Zero-duration spans (disabled / clamped to nothing) are
 *  skipped and the caller falls through to clip-span lookup.
 *
 *  Pathological overlap: when two transitions cover `t` (only possible when
 *  both sides of an adjacent boundary overrun a too-short clip per the
 *  clamping policy), the LATER one wins. Its `toCamera` is more recent and
 *  matches the seam handoff direction. */
function findTransitionSpanAt(
  spans: TransitionSpan[],
  t: number,
): TransitionSpan | null {
  let result: TransitionSpan | null = null;
  for (const s of spans) {
    if (s.effectiveDurationMs <= 0) continue;
    if (t >= s.startMs && t <= s.endMs) result = s;
  }
  return result;
}

/** Evaluate a transition span at project-time `t`. Returns a `point` intent
 *  on the Van Wijk arc between the previous clip's terminal canonical camera
 *  (or `startCamera` for clip 1) and the destination clip's initial canonical
 *  camera. Bearing is short-way circular-lerped; pitch is linearly lerped;
 *  center+zoom come from `vanWijkSample`. The cubic ease-in-out matches the
 *  legacy `interpolateAnchors` behavior — gentle entry, fast middle, gentle
 *  landing. */
function evaluateTransitionSpan(
  timeline: CompiledTimeline,
  span: TransitionSpan,
  t: number,
): CameraIntent {
  const { clipSpans, startCamera, transitionFeel } = timeline;

  const fromSpan = span.fromClipId
    ? clipSpans.find((s) => s.clipId === span.fromClipId) ?? null
    : null;
  const toSpan = clipSpans.find((s) => s.clipId === span.toClipId) ?? null;

  // toSpan must exist for any well-formed timeline (transitions always point
  // at an existing clip). Guard for paranoia, returning startCamera so the
  // caller still receives a valid intent.
  if (!toSpan) return startCameraAsPointIntent(startCamera);

  const fromCamera: ResolvedCamera = fromSpan
    ? resolveCanonical(
        fromSpan.intent,
        fromSpan.wallClockBaseMs + fromSpan.mediaOutMs,
      )
    : startCamera;
  const toCamera: ResolvedCamera = resolveCanonical(
    toSpan.intent,
    toSpan.wallClockBaseMs + toSpan.mediaInMs,
  );

  // localT is well-defined here because findTransitionSpanAt skipped any
  // zero-duration span. Clamp to [0, 1] defensively for the case where t
  // sits exactly at startMs/endMs and float math kicks it slightly out.
  const lengthMs = span.endMs - span.startMs;
  const rawLocalT = (t - span.startMs) / lengthMs;
  const localT = rawLocalT < 0 ? 0 : rawLocalT > 1 ? 1 : rawLocalT;
  const eased = easeInOut(localT, transitionFeel);

  const arc = vanWijkArc(fromCamera, toCamera);
  const sample = vanWijkSample(fromCamera, toCamera, arc, arc.S * eased);
  const bearing = circularLerp(fromCamera.bearing, toCamera.bearing, eased);
  const pitch = fromCamera.pitch + (toCamera.pitch - fromCamera.pitch) * eased;

  return {
    kind: 'point',
    center: sample.center,
    zoom: sample.zoom,
    bearing,
    pitch,
  };
}

/** Find the clip id that should be treated as "active" for UI highlighting at
 *  project-time `t`. Per `COMPILED_TIMELINE_PLAN.md` §"Implementation Plan →
 *  7": transition spans report the destination clip as active. Returns null
 *  outside the `[0, totalDurationMs]` range or for an empty timeline.
 *
 *  Used by Timeline (clip-card highlight), EditToolbar (active clip's
 *  controls), and MapView (waypoint selection styling). Mirrors `cameraAt`'s
 *  routing — transitions win at the seam so the destination becomes "active"
 *  the moment project-time enters the transition window.
 *
 *  Distinct from `selectedClipId` (the user's persistent selection state):
 *  during an auto-advance transition the user's selection still points at
 *  the source clip while the active clip is the destination. The two
 *  reconverge once the animator lands and selection follows. */
export function activeClipIdAt(
  timeline: CompiledTimeline,
  t: number,
): string | null {
  if (timeline.clipSpans.length === 0) return null;
  if (t < 0 || t > timeline.totalDurationMs) return null;
  const ts = findTransitionSpanAt(timeline.transitionSpans, t);
  if (ts) return ts.toClipId;
  const cs = findClipSpanAt(timeline.clipSpans, t);
  return cs ? cs.clipId : null;
}

/** Evaluate the compiled timeline at project-time `t`. Pure, deterministic,
 *  viewport-agnostic — the renderer (preview ease loop OR export frame loop)
 *  hands the returned intent to `resolveIntent(intent, viewport)` to get a
 *  concrete camera. See `COMPILED_TIMELINE_PLAN.md` §"Continuity Invariants"
 *  for the gating contract this function honors.
 *
 *  Both preview and export consume this. Preview drives `t` from the
 *  project-time playhead each animation tick; export drives `t = frame_index
 *  / fps`. Same evaluator, same output for the same `t`. */
export function cameraAt(timeline: CompiledTimeline, t: number): CameraIntent {
  const { clipSpans, transitionSpans, totalDurationMs, startCamera } = timeline;

  if (clipSpans.length === 0) {
    return startCameraAsPointIntent(startCamera);
  }

  if (t < 0) {
    return startCameraAsPointIntent(startCamera);
  }

  if (t >= totalDurationMs) {
    const last = clipSpans[clipSpans.length - 1];
    return liveIntentForClipSpan(last, last.endMs);
  }

  const transitionSpan = findTransitionSpanAt(transitionSpans, t);
  if (transitionSpan) {
    return evaluateTransitionSpan(timeline, transitionSpan, t);
  }

  const clipSpan = findClipSpanAt(clipSpans, t);
  if (clipSpan) return liveIntentForClipSpan(clipSpan, t);

  // Unreachable for well-formed (gapless) timelines. Fall back to the last
  // clip's terminal frame rather than throwing — matches the wall-clock
  // evaluator's "hold the last frame" defensive posture.
  const last = clipSpans[clipSpans.length - 1];
  return liveIntentForClipSpan(last, last.endMs);
}
