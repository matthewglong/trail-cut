// Shared test fixtures for routeLocation tests (migration tasks 200/210/220/230).
//
// Timestamps are kept tight (1 Hz, round-second ISO strings) so tests can assert
// "exact hit" / "midpoint" / "before first" / "after last" behavior without any
// floating-point fuzz. Add fixtures here rather than building inline routes in
// individual tests — the whole point of the scaffold task (200) is to absorb the
// merge surface for 210/220/230.

import type { Route, TrackPoint } from '../../types';

/** Build a TrackPoint with a default elevation of null. Keeps test bodies
 *  readable — no inline `elevation: null` boilerplate. */
export function mkPoint(lat: number, lng: number, isoTime: string | null): TrackPoint {
  return { lat, lng, elevation: null, timestamp: isoTime };
}

/** Five trackpoints, 1 Hz, moving due north at ~111 m / sec. Latitude steps
 *  by 0.001° per second; longitude is constant at -122.0. Ideal for exact-hit,
 *  midpoint-interp, and bearing-due-north tests. */
export const linearRoute: Route = {
  source_path: '/fixtures/linear.gpx',
  format: 'gpx',
  trackpoints: [
    mkPoint(37.0, -122.0, '2026-04-04T15:00:00Z'),
    mkPoint(37.001, -122.0, '2026-04-04T15:00:01Z'),
    mkPoint(37.002, -122.0, '2026-04-04T15:00:02Z'),
    mkPoint(37.003, -122.0, '2026-04-04T15:00:03Z'),
    mkPoint(37.004, -122.0, '2026-04-04T15:00:04Z'),
  ],
};

/** A route with a gap > MAX_INTERPOLATION_GAP_MS (60s). Two trackpoints at
 *  t=0 and t=0+1s, then a third trackpoint at t=0+90s (gap of 89s between
 *  points 1 and 2). Inside that gap, locationAt and trailUpTo must NOT
 *  interpolate. */
export const routeWithGap: Route = {
  source_path: '/fixtures/with-gap.gpx',
  format: 'gpx',
  trackpoints: [
    mkPoint(37.0, -122.0, '2026-04-04T15:00:00Z'),
    mkPoint(37.001, -122.0, '2026-04-04T15:00:01Z'),
    // 89-second gap (well past the 60s MAX_INTERPOLATION_GAP_MS)
    mkPoint(37.002, -122.0, '2026-04-04T15:01:30Z'),
    mkPoint(37.003, -122.0, '2026-04-04T15:01:31Z'),
  ],
};

/** First half stationary (3 points at the same lat/lng), second half moves
 *  due north. Used to verify the stationary-segment fallbacks in `bearingAt`
 *  and `computeBearingKeyframes`. */
export const routeWithStationarySegment: Route = {
  source_path: '/fixtures/stationary.gpx',
  format: 'gpx',
  trackpoints: [
    mkPoint(37.0, -122.0, '2026-04-04T15:00:00Z'),
    mkPoint(37.0, -122.0, '2026-04-04T15:00:01Z'),
    mkPoint(37.0, -122.0, '2026-04-04T15:00:02Z'),
    mkPoint(37.001, -122.0, '2026-04-04T15:00:03Z'),
    mkPoint(37.002, -122.0, '2026-04-04T15:00:04Z'),
  ],
};

/** A long route spanning ten seconds, used for clip-waypoint tests where two
 *  halves of a split clip must resolve to different positions. Each second
 *  the latitude advances by 0.001° (~111 m). */
export const longLinearRoute: Route = {
  source_path: '/fixtures/long-linear.gpx',
  format: 'gpx',
  trackpoints: Array.from({ length: 11 }, (_, i) =>
    mkPoint(37.0 + i * 0.001, -122.0, `2026-04-04T15:00:${String(i).padStart(2, '0')}Z`),
  ),
};
