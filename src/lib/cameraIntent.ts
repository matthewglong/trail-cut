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

// -- Stub function signatures ----------------------------------------------
// Bodies are filled in by Step 1 tasks (100, 110, 120, 130). The signatures
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
