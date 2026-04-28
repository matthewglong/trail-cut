// Pure, renderer-portable camera-intent surface. Composes with
// `routeLocation.ts` to drive the map's framing in a viewport-agnostic way.
// See `docs/MAP_ARCHITECTURE_MIGRATION.md` §3 for the full design.
//
// This file currently scaffolds the *type* surface and stub function
// signatures only. Logic bodies are filled in by tasks 100/110/120/130.

import type { Clip } from '../types';
import type { BearingMode } from '../types';
import type { IndexedRoute, BearingKeyframe } from './routeLocation';

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
 *  See §3.2 — implemented in task 120. */
export function buildMapTrack(
  _clips: Clip[],
  _route: IndexedRoute | null,
  _projectMapSettings: import('../types').MapSettings,
  _transitionFeel: TransitionFeel = 'natural',
): MapTrack {
  throw new Error('not implemented');
}

/** The single source of truth.
 *  Returns the intent that should be active at wall-clock time t.
 *  Pure: deterministic in (track, t). No hidden state. No MapLibre.
 *  See §3.2 — implemented in task 120. */
export function cameraAt(_track: MapTrack, _t: number): CameraIntent {
  throw new Error('not implemented');
}

/** Resolve a CameraIntent to a concrete camera given the renderer's
 *  viewport. Pure in (intent, viewport). The same intent resolved against
 *  two different viewports correctly produces two different framings.
 *  See §3.3 — implemented in task 130. */
export function resolveIntent(
  _intent: CameraIntent,
  _viewport: Viewport,
): ResolvedCamera {
  throw new Error('not implemented');
}

/** Interpolate from anchor A to anchor B at time t.
 *  Uses Van Wijk & Nuij (2003) "Smooth and Efficient Zooming and Panning"
 *  to produce a smooth zoom-out + pan + zoom-in arc between the two
 *  anchors' resolved geographic positions.
 *  See §3.4 — implemented in task 130. */
export function interpolateAnchors(
  _a: MapAnchor,
  _b: MapAnchor,
  _t: number,
  _feel: TransitionFeel,
): CameraIntent {
  throw new Error('not implemented');
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
