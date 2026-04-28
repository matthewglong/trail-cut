// Pure, renderer-portable camera-intent surface. Composes with
// `routeLocation.ts` to drive the map's framing in a viewport-agnostic way.
// See `docs/MAP_ARCHITECTURE_MIGRATION.md` §3 for the full design.
//
// This file currently scaffolds the *type* surface and stub function
// signatures only. Logic bodies are filled in by tasks 100/110/120/130.

import type { Clip, MapSettings } from '../types';
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

// -- §3.1  Core geometric / camera types ------------------------------------

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

// -- §3.2  Timeline anchors and the MapTrack --------------------------------

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

// -- §3.4  Van Wijk arc parameters ------------------------------------------

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
 *  Algorithm — §5.2 of `docs/MAP_ARCHITECTURE_MIGRATION.md`:
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

// -- Stub function signatures ----------------------------------------------
// Bodies are filled in by Step 1 tasks (110, 120, 130). The signatures
// match §3.2-3.4 verbatim so consumers can already type-check usage.

/** Build a MapTrack from project state. Pure.
 *  See §3.2.
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
  // to {lng:0, lat:0} when neither GPX nor embedded GPS resolves — matches
  // the spec in §3.2 of MAP_ARCHITECTURE_MIGRATION.md.
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
 *    - empty track                    → DEFAULT_INTENT
 *    - before first anchor's start    → `liveIntent(first.intent, t)`
 *    - inside an anchor's range       → `liveIntent(active.intent, t)`
 *    - after last anchor's end        → `liveIntent(last.intent, last.endTimeMs)`
 *      (clamped t — holding past the last clip should display the same
 *      framing the last frame of that clip rendered, not advance the
 *      follow marker into "no-clip" territory)
 *    - in a gap between two anchors   → `interpolateAnchors(a, next, t, feel)`
 *      (always returns a `point` intent — see §3.4) */
export function cameraAt(track: MapTrack, t: number): CameraIntent {
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
      // Gap between clips — Van Wijk interpolation. Lives in §3.4 / task 130.
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
 *  This is the **only** aspect-aware function in the architecture (see
 *  §3.3 of MAP_ARCHITECTURE_MIGRATION.md). The fractional `Padding` on a
 *  `region` intent is converted to pixels here against the viewport's
 *  smaller dimension; everywhere else, padding stays unitless.
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

/** Resolve an anchor to a `ResolvedCamera` at the canonical viewport.
 *  Used inside `interpolateAnchors` to give the Van Wijk arc two concrete
 *  endpoints regardless of intent kind.
 *
 *  - `point`: trivial pass-through (point intents already carry a zoom).
 *  - `region`: resolved against the canonical 1024×1024 viewport. The
 *    actual render-time framing may differ — that's `resolveIntent`'s job
 *    when the renderer takes over after the gap closes.
 *  - `follow`: evaluate at `refTimeMs` (boundary of the anchor's range).
 *    `refTimeMs` is `endTimeMs` for the outgoing anchor and `timeMs` for
 *    the incoming anchor, per §3.4. */
function canonicalCamera(
  anchor: MapAnchor,
  refTimeMs: number,
): ResolvedCamera {
  const intent = anchor.intent;
  if (intent.kind === 'follow') {
    return resolveIntent(
      { ...intent, playheadMs: refTimeMs },
      CANONICAL_VIEWPORT,
    );
  }
  return resolveIntent(intent, CANONICAL_VIEWPORT);
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
 *  See §3.4 of MAP_ARCHITECTURE_MIGRATION.md for the full algorithm. */
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

// -- §3.4  Van Wijk arc primitives -----------------------------------------
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
  // viewport's worth of geography. Documented in §3.4 of the migration
  // doc as an acceptable approximation.
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

/** Per-feel duration multiplier. From §3.6 of MAP_ARCHITECTURE_MIGRATION.md:
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
 *    well within the ±10% target of today's 1100ms baseline. Will be
 *    re-tuned in task 140 against the spike harness; treat as a starting
 *    point, not gospel.
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
