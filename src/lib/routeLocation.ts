// Pure, renderer-portable spec for resolving the videographer's geographic
// position at a given wall-clock time, using GPX trackpoints as the source of
// truth and falling back to a clip's embedded GPS when GPX is missing or
// out of range.
//
// This module has zero React, MapLibre, or DOM dependencies. The Rust
// exporter will mirror these functions verbatim at render time so the export
// matches the preview frame-for-frame.

import type { Clip, GpsCoord, Route } from '../types';

/** Maximum gap between two GPX trackpoints across which we'll still
 *  interpolate. Beyond this, we treat the area as "no GPS coverage" and fall
 *  back to the clip's embedded GPS. */
export const MAX_INTERPOLATION_GAP_MS = 60_000;

/** Parse a timestamp string into ms since epoch.
 *  Handles two formats:
 *    - Real ISO 8601 ("2026-04-04T15:13:00Z") — from GPX
 *    - ExifTool's "CreationDate" ("2026:04:04 12:49:25-07:00"), which uses
 *      colons in the date and a space separator instead of T. We normalize
 *      it to ISO before parsing.
 *  Returns NaN if unparseable. */
export function parseTimestamp(s: string | null | undefined): number {
  if (!s) return NaN;
  // Direct ISO first.
  const direct = Date.parse(s);
  if (!Number.isNaN(direct)) return direct;
  // ExifTool format: "YYYY:MM:DD HH:MM:SS[+/-HH:MM]"
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(.*)$/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}${m[5] || ''}`;
    return Date.parse(iso);
  }
  return NaN;
}

export interface IndexedPoint {
  lat: number;
  lng: number;
  timeMs: number;
}

export interface IndexedRoute {
  points: IndexedPoint[];
  minTimeMs: number;
  maxTimeMs: number;
  /** Cumulative geodesic arc length (haversine) in metres at each indexed
   *  point (parallel array). cumulativeDistMeters[0] is always 0. Real-world
   *  distance — exposed for any consumer that needs "how far has the hiker
   *  walked." Not used by `progressUpTo` (see cumulativeMercatorMeters). */
  cumulativeDistMeters: number[];
  totalDistMeters: number;
  /** Cumulative Web Mercator (EPSG:3857, metres) length at each indexed
   *  point. Used by `progressUpTo` to produce a fraction that MapLibre's
   *  `line-progress` evaluator agrees with — `line-progress` is computed
   *  in projected (tile) space, not geodesic, so a geodesic fraction at
   *  high latitudes can disagree with the painted gradient stop by tens of
   *  pixels at high zoom (validated empirically: ~36px offset at zoom 20,
   *  lat 37.7°). Same length as `cumulativeDistMeters`; first entry 0. */
  cumulativeMercatorMeters: number[];
  totalMercatorMeters: number;
}

export interface ResolvedLocation {
  lat: number;
  lng: number;
  source: 'gpx' | 'fallback';
}

const EARTH_RADIUS_METERS = 6_371_000;

/** Great-circle distance in metres between two lat/lng points. */
function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lng2 - lng1);
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Parse a route's trackpoints into a sorted, time-indexed structure. Drops
 *  any trackpoints without timestamps. Returns null if the route has no
 *  usable timed points. Memoize at the call site. */
export function indexRoute(route: Route | null): IndexedRoute | null {
  if (!route || route.trackpoints.length === 0) return null;

  const points: IndexedPoint[] = [];
  for (const tp of route.trackpoints) {
    if (tp.timestamp == null) continue;
    const t = parseTimestamp(tp.timestamp);
    if (Number.isNaN(t)) continue;
    points.push({ lat: tp.lat, lng: tp.lng, timeMs: t });
  }
  if (points.length === 0) return null;

  // GPX trkseg points are typically already in order, but don't trust it.
  points.sort((a, b) => a.timeMs - b.timeMs);

  const cumulativeDistMeters: number[] = new Array(points.length);
  const cumulativeMercatorMeters: number[] = new Array(points.length);
  cumulativeDistMeters[0] = 0;
  cumulativeMercatorMeters[0] = 0;
  // Web Mercator (EPSG:3857), in metres. R is the equatorial radius used by
  // the Web Mercator standard. We accumulate Euclidean length in (mercX,
  // mercY) space, which is what MapLibre's `line-progress` parameterizes
  // against.
  const R_MERCATOR = 6378137;
  const mercX = (lng: number) => (R_MERCATOR * lng * Math.PI) / 180;
  const mercY = (lat: number) =>
    R_MERCATOR * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    cumulativeDistMeters[i] =
      cumulativeDistMeters[i - 1] + haversineMeters(prev.lat, prev.lng, cur.lat, cur.lng);
    const dx = mercX(cur.lng) - mercX(prev.lng);
    const dy = mercY(cur.lat) - mercY(prev.lat);
    cumulativeMercatorMeters[i] =
      cumulativeMercatorMeters[i - 1] + Math.hypot(dx, dy);
  }

  return {
    points,
    minTimeMs: points[0].timeMs,
    maxTimeMs: points[points.length - 1].timeMs,
    cumulativeDistMeters,
    totalDistMeters: cumulativeDistMeters[cumulativeDistMeters.length - 1],
    cumulativeMercatorMeters,
    totalMercatorMeters:
      cumulativeMercatorMeters[cumulativeMercatorMeters.length - 1],
  };
}

/** Find the index of the first point whose timeMs is >= target.
 *  Returns points.length if no such point exists. */
function bisectLeft(points: IndexedPoint[], targetMs: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].timeMs < targetMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Resolve a position at a given wall-clock time.
 *  - In range, with a small enough gap → linear interpolation between the
 *    two bracketing trackpoints.
 *  - In range, but the bracketing gap exceeds MAX_INTERPOLATION_GAP_MS → fallback.
 *  - Out of range or no indexed route → fallback.
 *  - No fallback available → null. */
export function locationAt(
  wallClockMs: number,
  route: IndexedRoute | null,
  fallback: GpsCoord | null,
): ResolvedLocation | null {
  const fb: ResolvedLocation | null = fallback
    ? { lat: fallback.lat, lng: fallback.lng, source: 'fallback' }
    : null;

  if (!route) return fb;
  if (wallClockMs < route.minTimeMs || wallClockMs > route.maxTimeMs) return fb;

  const pts = route.points;
  const i = bisectLeft(pts, wallClockMs);

  // Exact hit on a trackpoint (or first point)
  if (i < pts.length && pts[i].timeMs === wallClockMs) {
    return { lat: pts[i].lat, lng: pts[i].lng, source: 'gpx' };
  }
  if (i === 0) {
    return { lat: pts[0].lat, lng: pts[0].lng, source: 'gpx' };
  }
  if (i >= pts.length) {
    const last = pts[pts.length - 1];
    return { lat: last.lat, lng: last.lng, source: 'gpx' };
  }

  const before = pts[i - 1];
  const after = pts[i];
  const gap = after.timeMs - before.timeMs;
  if (gap > MAX_INTERPOLATION_GAP_MS) return fb;
  if (gap === 0) {
    return { lat: before.lat, lng: before.lng, source: 'gpx' };
  }

  const t = (wallClockMs - before.timeMs) / gap;
  return {
    lat: before.lat + (after.lat - before.lat) * t,
    lng: before.lng + (after.lng - before.lng) * t,
    source: 'gpx',
  };
}

/** Build the slime trail: all GPX points up to wallClockMs, plus an
 *  interpolated head point at exactly wallClockMs (when in range and within
 *  an interpolatable gap). Returns a GeoJSON LineString feature ready to
 *  hand to a map source. Empty coordinates if nothing applies. */
export function trailUpTo(
  wallClockMs: number,
  route: IndexedRoute,
): GeoJSON.Feature<GeoJSON.LineString> {
  const pts = route.points;
  const empty: GeoJSON.Feature<GeoJSON.LineString> = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: [] },
  };

  if (wallClockMs < route.minTimeMs) return empty;

  const coords: [number, number][] = [];
  if (wallClockMs >= route.maxTimeMs) {
    for (const p of pts) coords.push([p.lng, p.lat]);
    return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } };
  }

  // Include all points strictly before the playhead
  const i = bisectLeft(pts, wallClockMs);
  for (let k = 0; k < i; k++) coords.push([pts[k].lng, pts[k].lat]);

  // Append an interpolated head if we're between two close-enough points
  if (i > 0 && i < pts.length) {
    const before = pts[i - 1];
    const after = pts[i];
    const gap = after.timeMs - before.timeMs;
    if (gap > 0 && gap <= MAX_INTERPOLATION_GAP_MS) {
      const t = (wallClockMs - before.timeMs) / gap;
      const lat = before.lat + (after.lat - before.lat) * t;
      const lng = before.lng + (after.lng - before.lng) * t;
      coords.push([lng, lat]);
    }
  }

  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } };
}

/** Map a wall-clock time onto a [0, 1] line-progress fraction along the
 *  indexed route, parameterized in Web Mercator (projected) length so the
 *  result agrees with MapLibre's `line-progress` evaluator at the same
 *  fraction. Geodesic fractions can disagree with `line-progress` by tens
 *  of pixels at high zoom and high latitude (the projection stretches
 *  N-S vs E-W differently), which manifests as a slime-trail head that
 *  paints away from the live POV marker. See `IndexedRoute.cumulativeMercatorMeters`.
 *
 *  Semantics mirror `trailUpTo`:
 *    - Before route start → 0.
 *    - At/after route end → 1.
 *    - Inside a tractable gap → linear-in-time interpolation between the
 *      bracketing points' cumulative projected lengths. (Time-linear within
 *      a single segment is correct: MapLibre's `line-progress` is also
 *      length-linear within a segment, and we model the hiker as moving
 *      uniformly between adjacent GPX samples.)
 *    - Inside an over-MAX_INTERPOLATION_GAP_MS gap → snaps to the previous
 *      point's progress (matches `locationAt`'s fallback behavior — no
 *      pretend movement across coverage holes).
 *    - Empty route (totalMercatorMeters == 0) → 0. */
export function progressUpTo(
  wallClockMs: number,
  route: IndexedRoute,
): number {
  if (route.totalMercatorMeters <= 0) return 0;
  if (wallClockMs <= route.minTimeMs) return 0;
  if (wallClockMs >= route.maxTimeMs) return 1;

  const pts = route.points;
  const cum = route.cumulativeMercatorMeters;
  const total = route.totalMercatorMeters;
  const i = bisectLeft(pts, wallClockMs);

  if (i <= 0) return 0;
  if (i >= pts.length) return 1;
  if (pts[i].timeMs === wallClockMs) {
    return cum[i] / total;
  }

  const before = pts[i - 1];
  const after = pts[i];
  const gap = after.timeMs - before.timeMs;
  if (gap <= 0) return cum[i - 1] / total;
  if (gap > MAX_INTERPOLATION_GAP_MS) {
    return cum[i - 1] / total;
  }
  const t = (wallClockMs - before.timeMs) / gap;
  const dist = cum[i - 1] + t * (cum[i] - cum[i - 1]);
  return dist / total;
}

/** Cumulative geodesic distance (metres, `cumulativeDistMeters` space) the
 *  hiker has covered at a wall-clock time. The travel-transition animation
 *  interpolates in THIS space ("real ground distance at constant eased
 *  speed"), then inverts back through `wallClockAtDistance` — geodesic, not
 *  Mercator, because the traveling marker should cross real terrain
 *  uniformly; `line-progress` parity is unaffected (the synthesized
 *  wall-clock still flows through `progressUpTo` for gradients).
 *
 *  Semantics mirror `progressUpTo`:
 *    - Before route start → 0; at/after route end → totalDistMeters.
 *    - Inside a tractable gap → linear-in-time interpolation.
 *    - Inside an over-MAX_INTERPOLATION_GAP_MS gap → snaps to the previous
 *      point's distance (no pretend movement across coverage holes). */
export function distanceAtWallClock(
  wallClockMs: number,
  route: IndexedRoute,
): number {
  if (wallClockMs <= route.minTimeMs) return 0;
  if (wallClockMs >= route.maxTimeMs) return route.totalDistMeters;

  const pts = route.points;
  const cum = route.cumulativeDistMeters;
  const i = bisectLeft(pts, wallClockMs);

  if (i <= 0) return 0;
  if (i >= pts.length) return route.totalDistMeters;
  if (pts[i].timeMs === wallClockMs) return cum[i];

  const before = pts[i - 1];
  const after = pts[i];
  const gap = after.timeMs - before.timeMs;
  if (gap <= 0) return cum[i - 1];
  if (gap > MAX_INTERPOLATION_GAP_MS) return cum[i - 1];
  const t = (wallClockMs - before.timeMs) / gap;
  return cum[i - 1] + t * (cum[i] - cum[i - 1]);
}

/** Find the first index whose cumulative value is >= target. `cum` is
 *  monotone non-decreasing (flat runs at duplicate/stationary points). */
function bisectLeftCumulative(cum: number[], target: number): number {
  let lo = 0;
  let hi = cum.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cum[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Invert `distanceAtWallClock`: the wall-clock time at which the hiker
 *  first reached a cumulative geodesic distance. Clamps outside
 *  `[0, totalDistMeters]`. Within a moving segment the time is
 *  distance-proportional; on stationary plateaus (one distance spanning
 *  many timestamps — paused recording, GPS-jitter-free rests) it returns
 *  the EARLIEST time at that distance. Callers needing boundary continuity
 *  across plateaus must clamp the result to their own time window (the
 *  travel trace in `mapVisuals/perFrame.ts` does — same position either
 *  way, only downstream time-keyed state like waypoint activation could
 *  shift, bounded by the clamp).
 *
 *  Deliberately gap-agnostic: inverting into an over-
 *  MAX_INTERPOLATION_GAP_MS hole yields a time inside the hole, where
 *  `locationAt` applies its normal fallback — a travel animation sweeping
 *  a coverage hole momentarily shows the fallback position rather than
 *  pretending the route covers it. */
export function wallClockAtDistance(
  distMeters: number,
  route: IndexedRoute,
): number {
  const pts = route.points;
  const cum = route.cumulativeDistMeters;
  if (distMeters <= 0) return route.minTimeMs;
  const target = Math.min(distMeters, route.totalDistMeters);

  const i = bisectLeftCumulative(cum, target);
  if (i <= 0) return pts[0].timeMs;
  if (i >= pts.length) return route.maxTimeMs;
  // Exact hit — bisectLeft lands on the FIRST index at this distance, so a
  // plateau resolves to its earliest timestamp.
  if (cum[i] === target) return pts[i].timeMs;

  const segLen = cum[i] - cum[i - 1];
  // segLen > 0 here: cum[i-1] < target (bisect) and cum[i] > target (no
  // exact hit), so the bracketing values differ. Guard anyway.
  if (segLen <= 0) return pts[i - 1].timeMs;
  const t = (target - cum[i - 1]) / segLen;
  return pts[i - 1].timeMs + t * (pts[i].timeMs - pts[i - 1].timeMs);
}

/** Convert a clip + media-time-in-seconds to a wall-clock timestamp in ms.
 *  Returns null if the clip has no created_at anchor. */
export function clipWallClockMs(clip: Clip | null, mediaSeconds: number): number | null {
  if (!clip || !clip.created_at) return null;
  const startMs = parseTimestamp(clip.created_at);
  if (Number.isNaN(startMs)) return null;
  return startMs + mediaSeconds * 1000;
}

/** Convenience: resolve a clip's *start* position (waypoint) using GPX when
 *  possible, falling back to embedded GPS. */
export function clipWaypointLocation(
  clip: Clip,
  route: IndexedRoute | null,
): ResolvedLocation | null {
  // Anchor at created_at + trim.in_ms so each split segment (and any trimmed
  // clip) resolves to the geographic position the hiker was actually at
  // when that segment *starts*, not where the underlying source starts.
  const sourceStartMs = clip.created_at ? parseTimestamp(clip.created_at) : NaN;
  if (Number.isNaN(sourceStartMs)) {
    return clip.gps ? { lat: clip.gps.lat, lng: clip.gps.lng, source: 'fallback' } : null;
  }
  const segmentStartMs = sourceStartMs + (clip.trim?.in_ms ?? 0);
  return locationAt(segmentStartMs, route, clip.gps);
}

// ---- Bearing (direction of travel) ----
// Computes the direction the hiker is moving at a given wall-clock time,
// derived from GPX geometry. This is direction of *travel* — not camera
// facing (that would need iPhone CoreMotion metadata). Used to drive map
// orientation during playback.

/** Default smoothing window for bearingAt, in ms. Sampling the GPX position
 *  ~2 seconds before and after the playhead and measuring the vector between
 *  those two points averages out GPS jitter. Larger windows smooth more but
 *  lag behind quick direction changes (switchbacks). */
export const DEFAULT_BEARING_WINDOW_MS = 4_000;

function toRad(d: number): number {
  return (d * Math.PI) / 180;
}
function toDeg(r: number): number {
  return (r * 180) / Math.PI;
}

/** Initial bearing (forward azimuth) from point A to point B, in degrees
 *  in [0, 360). 0 = north, 90 = east. */
export function forwardAzimuth(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Resolve the direction of travel at a given wall-clock time by sampling
 *  the route a fixed window before and after the playhead and measuring the
 *  vector between those two positions. Returns a bearing in degrees in
 *  [0, 360), or null if a bearing can't be computed (no route, fewer than
 *  two points, out of range with nowhere to straddle, or the two samples
 *  land on the same coordinate — e.g. a stationary segment). */
export function bearingAt(
  wallClockMs: number,
  route: IndexedRoute | null,
  windowMs: number = DEFAULT_BEARING_WINDOW_MS,
): number | null {
  if (!route || route.points.length < 2) return null;
  if (windowMs <= 0) return null;

  // Clamp the sample window inside the route's time range so we always get
  // two distinct timestamps to sample, even near the start/end.
  const half = windowMs / 2;
  let tBefore = wallClockMs - half;
  let tAfter = wallClockMs + half;
  if (tBefore < route.minTimeMs) {
    tBefore = route.minTimeMs;
    tAfter = Math.min(route.maxTimeMs, tBefore + windowMs);
  }
  if (tAfter > route.maxTimeMs) {
    tAfter = route.maxTimeMs;
    tBefore = Math.max(route.minTimeMs, tAfter - windowMs);
  }
  if (tAfter <= tBefore) return null;

  const a = locationAt(tBefore, route, null);
  const b = locationAt(tAfter, route, null);
  if (!a || !b) return null;
  if (a.lat === b.lat && a.lng === b.lng) return null;

  return forwardAzimuth(a.lat, a.lng, b.lat, b.lng);
}

// ---- Predetermined bearing keyframes ----
// Instead of computing a noisy bearing every frame, we pre-derive a small set
// of keyframes for a clip's time range and smoothly interpolate between them.
// Recomputed whenever the clip's trim, route, or stop count changes.

export interface BearingKeyframe {
  timeMs: number;
  bearing: number;
}

/** Shortest-arc circular interpolation between two angles in degrees.
 *  Handles the 360°/0° wraparound correctly (e.g. 350° → 10° arcs 20°
 *  clockwise, not 340° counterclockwise). Returns a value in [0, 360). */
export function circularLerp(a: number, b: number, t: number): number {
  // Normalize both into [0, 360)
  a = ((a % 360) + 360) % 360;
  b = ((b % 360) + 360) % 360;
  let diff = b - a;
  // Pick shortest arc
  if (diff > 180) diff -= 360;
  else if (diff < -180) diff += 360;
  return ((a + diff * t) % 360 + 360) % 360;
}

/** Compute bearing keyframes for a clip's wall-clock time range.
 *  Divides the range into `stops` equal-time segments, computes the
 *  representative bearing for each segment midpoint, and returns one
 *  keyframe per segment boundary (start of each segment + end of last).
 *
 *  For `stops = 1`, returns a single keyframe at the midpoint of the clip
 *  (one fixed bearing for the whole clip).
 *
 *  Returns null if bearings can't be computed (no route, etc.). */
export function computeBearingKeyframes(
  clipStartMs: number,
  clipEndMs: number,
  route: IndexedRoute | null,
  stops: number,
): BearingKeyframe[] | null {
  if (!route || route.points.length < 2) return null;
  if (clipEndMs <= clipStartMs) return null;
  if (stops < 1) return null;

  const duration = clipEndMs - clipStartMs;
  const segLen = duration / stops;

  // Compute one bearing per segment using the segment's full extent as the
  // sampling window (start → end of that segment).
  const segmentBearings: number[] = [];
  for (let i = 0; i < stops; i++) {
    const segStart = clipStartMs + i * segLen;
    const segEnd = segStart + segLen;
    const a = locationAt(segStart, route, null);
    const b = locationAt(segEnd, route, null);
    if (!a || !b) return null;
    if (a.lat === b.lat && a.lng === b.lng) {
      // Stationary segment — try the old windowed approach as fallback
      const mid = (segStart + segEnd) / 2;
      const fb = bearingAt(mid, route, DEFAULT_BEARING_WINDOW_MS);
      if (fb == null) return null;
      segmentBearings.push(fb);
    } else {
      segmentBearings.push(forwardAzimuth(a.lat, a.lng, b.lat, b.lng));
    }
  }

  // Build keyframes: each segment's bearing is placed at the segment midpoint.
  // This way interpolation arcs smoothly between segment centers.
  const keyframes: BearingKeyframe[] = [];
  for (let i = 0; i < stops; i++) {
    const midTime = clipStartMs + (i + 0.5) * segLen;
    keyframes.push({ timeMs: midTime, bearing: segmentBearings[i] });
  }

  return keyframes;
}

/** Resolve a bearing at a given wall-clock time from pre-computed keyframes.
 *  Before the first keyframe, holds the first bearing; after the last,
 *  holds the last bearing; between keyframes, circular-lerps. */
export function bearingFromKeyframes(
  wallClockMs: number,
  keyframes: BearingKeyframe[],
): number {
  if (keyframes.length === 0) return 0;
  if (keyframes.length === 1) return keyframes[0].bearing;

  // Before first keyframe — hold
  if (wallClockMs <= keyframes[0].timeMs) return keyframes[0].bearing;
  // After last keyframe — hold
  const last = keyframes[keyframes.length - 1];
  if (wallClockMs >= last.timeMs) return last.bearing;

  // Find the two keyframes we're between
  for (let i = 0; i < keyframes.length - 1; i++) {
    const kA = keyframes[i];
    const kB = keyframes[i + 1];
    if (wallClockMs >= kA.timeMs && wallClockMs <= kB.timeMs) {
      const t = (wallClockMs - kA.timeMs) / (kB.timeMs - kA.timeMs);
      return circularLerp(kA.bearing, kB.bearing, t);
    }
  }

  return last.bearing;
}

const CARDINALS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export type Cardinal8 = (typeof CARDINALS_8)[number];

/** Quantize a bearing in degrees to an 8-point cardinal label. */
export function cardinalFromBearing(degrees: number): Cardinal8 {
  const normalized = ((degrees % 360) + 360) % 360;
  const i = Math.round(normalized / 45) % 8;
  return CARDINALS_8[i];
}
