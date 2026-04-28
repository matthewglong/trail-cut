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

/** Build a Van Wijk arc between two resolved cameras. Pure.
 *  Implements eqs. (1)-(8) of Van Wijk & Nuij (2003).
 *  See §3.4 — implemented in task 110. */
export function vanWijkArc(
  _camA: ResolvedCamera,
  _camB: ResolvedCamera,
): VanWijkArc {
  throw new Error('not implemented');
}

/** Sample the arc at parameter `s ∈ [0, arc.S]`.
 *  Returns the geographic center and (real) zoom at that arc position.
 *  See §3.4 — implemented in task 110. */
export function vanWijkSample(
  _camA: ResolvedCamera,
  _camB: ResolvedCamera,
  _arc: VanWijkArc,
  _s: number,
): { center: LngLat; zoom: number } {
  throw new Error('not implemented');
}

/** Auto-derive the arc duration from path length and "transition feel."
 *  See §3.4 — implemented in task 110. */
export function arcDurationMs(_arc: VanWijkArc, _feel: TransitionFeel): number {
  throw new Error('not implemented');
}
