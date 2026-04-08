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
}

export interface ResolvedLocation {
  lat: number;
  lng: number;
  source: 'gpx' | 'fallback';
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

  return {
    points,
    minTimeMs: points[0].timeMs,
    maxTimeMs: points[points.length - 1].timeMs,
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
