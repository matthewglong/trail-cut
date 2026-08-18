// Unit tests for the pure helpers in `routeLocation.ts` — the timestamp,
// position, trail, and bearing pipeline that powers both the live preview
// and the future Rust exporter.

import { describe, it, expect } from 'vitest';
import {
  parseTimestamp,
  indexRoute,
  locationAt,
  trailUpTo,
  progressUpTo,
  distanceAtWallClock,
  wallClockAtDistance,
  clipWaypointLocation,
  forwardAzimuth,
  bearingAt,
  circularLerp,
  computeBearingKeyframes,
  bearingFromKeyframes,
  clipWallClockMs,
  cardinalFromBearing,
  DEFAULT_BEARING_WINDOW_MS,
  MAX_INTERPOLATION_GAP_MS,
  type IndexedRoute,
} from './routeLocation';
import type { Clip, Route } from '../types';
import {
  linearRoute,
  longLinearRoute,
  mkPoint,
  routeWithGap,
  routeWithStationarySegment,
} from './__fixtures__/routes';

/** Build a minimal Clip for tests. Only the fields routeLocation reads
 *  matter — everything else is filled with reasonable defaults. */
function mkClip(overrides: Partial<Clip>): Clip {
  return {
    id: 'test-clip',
    path: '/fixtures/clip.mov',
    filename: 'clip.mov',
    created_at: null,
    duration_ms: 1000,
    gps: null,
    resolution: null,
    frame_rate: null,
    trim: null,
    focal_point: { x: 0.5, y: 0.5, zoom: 1 },
    effects: { stabilize: { enabled: false, shakiness: 5 }, speed: 1 },
    visible: true,
    map_overrides: null,
    // WS0 color metadata — required on the Clip type as of the color-pipeline
    // foundation. Test fixtures default to "no signal" (Unknown class,
    // treated as SDR downstream).
    pix_fmt: null,
    color_primaries: null,
    color_trc: null,
    color_space: null,
    color_range: null,
    has_dolby_vision: false,
    camera_make: null,
    camera_model: null,
    source_color_class: 'unknown',
    ...overrides,
  };
}

describe('parseTimestamp', () => {
  it('parses ISO 8601 ("2026-04-04T15:13:00Z")', () => {
    expect(parseTimestamp('2026-04-04T15:13:00Z')).toBe(Date.UTC(2026, 3, 4, 15, 13, 0));
  });

  it('parses the epoch ("1970-01-01T00:00:00Z") to 0', () => {
    expect(parseTimestamp('1970-01-01T00:00:00Z')).toBe(0);
  });

  it('parses ExifTool format ("2026:04:04 12:49:25-07:00")', () => {
    // Same instant as the equivalent ISO 8601 string. Rebuilding the ISO form
    // here documents what the regex normalizer in parseTimestamp produces.
    expect(parseTimestamp('2026:04:04 12:49:25-07:00')).toBe(
      Date.parse('2026-04-04T12:49:25-07:00'),
    );
  });

  it('parses ExifTool format with no timezone offset', () => {
    // The regex tail is optional; parser falls back to local-time semantics.
    // Either NaN or a real number is acceptable as long as it's deterministic.
    const v = parseTimestamp('2026:04:04 12:49:25');
    expect(v).toBe(Date.parse('2026-04-04T12:49:25'));
  });

  it('returns NaN for null', () => {
    expect(parseTimestamp(null)).toBeNaN();
  });

  it('returns NaN for undefined', () => {
    expect(parseTimestamp(undefined)).toBeNaN();
  });

  it('returns NaN for an empty string', () => {
    expect(parseTimestamp('')).toBeNaN();
  });

  it('returns NaN for a garbage string', () => {
    expect(parseTimestamp('not a date at all')).toBeNaN();
  });
});

describe('indexRoute', () => {
  it('returns null for a null route', () => {
    expect(indexRoute(null)).toBeNull();
  });

  it('returns null for an empty trackpoint array', () => {
    const empty: Route = { source_path: '', format: 'gpx', trackpoints: [] };
    expect(indexRoute(empty)).toBeNull();
  });

  it('returns null when no trackpoints have parseable timestamps', () => {
    const noTimes: Route = {
      source_path: '',
      format: 'gpx',
      trackpoints: [
        mkPoint(37.0, -122.0, null),
        mkPoint(37.001, -122.0, 'totally not a date'),
      ],
    };
    expect(indexRoute(noTimes)).toBeNull();
  });

  it('drops trackpoints without timestamps and keeps the rest', () => {
    const mixed: Route = {
      source_path: '',
      format: 'gpx',
      trackpoints: [
        mkPoint(37.0, -122.0, '2026-04-04T15:00:00Z'),
        mkPoint(37.001, -122.0, null),
        mkPoint(37.002, -122.0, '2026-04-04T15:00:02Z'),
      ],
    };
    const idx = indexRoute(mixed);
    expect(idx).not.toBeNull();
    expect(idx!.points).toHaveLength(2);
    expect(idx!.points.map((p) => p.lat)).toEqual([37.0, 37.002]);
  });

  it('sorts out-of-order trackpoints ascending by timeMs', () => {
    const scrambled: Route = {
      source_path: '',
      format: 'gpx',
      trackpoints: [
        mkPoint(37.002, -122.0, '2026-04-04T15:00:02Z'),
        mkPoint(37.0, -122.0, '2026-04-04T15:00:00Z'),
        mkPoint(37.001, -122.0, '2026-04-04T15:00:01Z'),
      ],
    };
    const idx = indexRoute(scrambled)!;
    const times = idx.points.map((p) => p.timeMs);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    }
    expect(idx.points.map((p) => p.lat)).toEqual([37.0, 37.001, 37.002]);
  });

  it('reports correct minTimeMs / maxTimeMs from the sorted points', () => {
    const idx = indexRoute(linearRoute)!;
    expect(idx.minTimeMs).toBe(Date.UTC(2026, 3, 4, 15, 0, 0));
    expect(idx.maxTimeMs).toBe(Date.UTC(2026, 3, 4, 15, 0, 4));
    expect(idx.points).toHaveLength(5);
  });
});

describe('locationAt', () => {
  it('exact hit on a trackpoint returns that point with source=gpx', () => {
    const idx = indexRoute(linearRoute)!;
    const t = Date.UTC(2026, 3, 4, 15, 0, 2);
    const loc = locationAt(t, idx, null);
    expect(loc).toEqual({ lat: 37.002, lng: -122.0, source: 'gpx' });
  });

  it('exact hit on the first trackpoint returns the first point with source=gpx', () => {
    const idx = indexRoute(linearRoute)!;
    const loc = locationAt(idx.minTimeMs, idx, null);
    expect(loc).toEqual({ lat: 37.0, lng: -122.0, source: 'gpx' });
  });

  it('strict-before-first returns the fallback when one is provided', () => {
    const idx = indexRoute(linearRoute)!;
    const loc = locationAt(idx.minTimeMs - 1, idx, { lat: 12.34, lng: 56.78 });
    expect(loc).toEqual({ lat: 12.34, lng: 56.78, source: 'fallback' });
  });

  it('strict-before-first returns null when the fallback is null', () => {
    const idx = indexRoute(linearRoute)!;
    expect(locationAt(idx.minTimeMs - 1, idx, null)).toBeNull();
  });

  it('strict-after-last returns the fallback when one is provided', () => {
    const idx = indexRoute(linearRoute)!;
    const loc = locationAt(idx.maxTimeMs + 1, idx, { lat: 12.34, lng: 56.78 });
    expect(loc).toEqual({ lat: 12.34, lng: 56.78, source: 'fallback' });
  });

  it('linear-interp midpoint between two close trackpoints', () => {
    const idx = indexRoute(linearRoute)!;
    // Halfway between t=15:00:01 and t=15:00:02 → halfway lat between 37.001 and 37.002.
    const t = Date.UTC(2026, 3, 4, 15, 0, 1) + 500;
    const loc = locationAt(t, idx, null);
    expect(loc).not.toBeNull();
    expect(loc!.source).toBe('gpx');
    expect(loc!.lat).toBeCloseTo(0.5 * (37.001 + 37.002), 12);
    expect(loc!.lng).toBeCloseTo(-122.0, 12);
  });

  it('gap > MAX_INTERPOLATION_GAP_MS falls back instead of interpolating', () => {
    const idx = indexRoute(routeWithGap)!;
    // Pick a t inside the 89-second gap between points 2 and 3.
    const t = Date.UTC(2026, 3, 4, 15, 0, 30);
    expect(idx.points[2].timeMs - idx.points[1].timeMs).toBeGreaterThan(
      MAX_INTERPOLATION_GAP_MS,
    );
    const loc = locationAt(t, idx, { lat: 99.9, lng: 88.8 });
    expect(loc).toEqual({ lat: 99.9, lng: 88.8, source: 'fallback' });
  });

  it('gap > MAX_INTERPOLATION_GAP_MS returns null when the fallback is null', () => {
    const idx = indexRoute(routeWithGap)!;
    const t = Date.UTC(2026, 3, 4, 15, 0, 30);
    expect(locationAt(t, idx, null)).toBeNull();
  });

  it('null route + null fallback returns null', () => {
    expect(locationAt(0, null, null)).toBeNull();
  });

  it('null route + non-null fallback returns the fallback', () => {
    expect(locationAt(0, null, { lat: 1, lng: 2 })).toEqual({
      lat: 1,
      lng: 2,
      source: 'fallback',
    });
  });

  it('exact hit on a duplicate-timestamp pair returns one of the duplicate points', () => {
    // GPX exporters occasionally emit two trackpoints sharing the same
    // timestamp. indexRoute keeps both. locationAt's bisectLeft + exact-hit
    // path resolves the query to the first matching point rather than
    // dividing by zero. (The internal `gap === 0` branch is defensive — it
    // can't be reached through the public API because bisectLeft always
    // lands on the first equal element.)
    const dup: Route = {
      source_path: '',
      format: 'gpx',
      trackpoints: [
        mkPoint(37.0, -122.0, '2026-04-04T15:00:00Z'),
        mkPoint(37.5, -122.5, '2026-04-04T15:00:01Z'),
        mkPoint(37.9, -122.9, '2026-04-04T15:00:01Z'),
        mkPoint(38.0, -123.0, '2026-04-04T15:00:02Z'),
      ],
    };
    const idx = indexRoute(dup)!;
    const t = Date.UTC(2026, 3, 4, 15, 0, 1);
    const loc = locationAt(t, idx, null);
    expect(loc).not.toBeNull();
    expect(loc!.source).toBe('gpx');
    // bisectLeft returns the first equal element, so we expect the lat/lng
    // of the first duplicate.
    expect(loc!.lat).toBe(37.5);
    expect(loc!.lng).toBe(-122.5);
  });
});

describe('trailUpTo', () => {
  it('before route start returns empty coordinates', () => {
    const idx = indexRoute(linearRoute)!;
    const feat = trailUpTo(idx.minTimeMs - 1, idx);
    expect(feat.geometry.coordinates).toEqual([]);
  });

  it('exactly at route start returns empty coordinates', () => {
    // bisectLeft returns 0 → strict-before loop emits nothing; head check
    // fails because i === 0. The slime trail starts the moment we *pass*
    // the first point.
    const idx = indexRoute(linearRoute)!;
    const feat = trailUpTo(idx.minTimeMs, idx);
    expect(feat.geometry.coordinates).toEqual([]);
  });

  it('after route end returns all coordinates with no interpolated head', () => {
    const idx = indexRoute(linearRoute)!;
    const feat = trailUpTo(idx.maxTimeMs + 5_000, idx);
    expect(feat.geometry.coordinates).toHaveLength(idx.points.length);
    // GeoJSON ordering is [lng, lat]
    expect(feat.geometry.coordinates[0]).toEqual([-122.0, 37.0]);
    expect(feat.geometry.coordinates.at(-1)).toEqual([-122.0, 37.004]);
  });

  it('exactly at route end returns all coordinates', () => {
    const idx = indexRoute(linearRoute)!;
    const feat = trailUpTo(idx.maxTimeMs, idx);
    expect(feat.geometry.coordinates).toHaveLength(5);
  });

  it('mid-route returns strict-before points plus an interpolated head', () => {
    const idx = indexRoute(linearRoute)!;
    // 1.5 s in: strict-before points are pts[0] (15:00:00) and pts[1]
    // (15:00:01); interpolated head sits halfway between pts[1] and pts[2].
    const t = Date.UTC(2026, 3, 4, 15, 0, 1) + 500;
    const feat = trailUpTo(t, idx);
    const coords = feat.geometry.coordinates;
    expect(coords).toHaveLength(3);
    expect(coords[0]).toEqual([-122.0, 37.0]);
    expect(coords[1]).toEqual([-122.0, 37.001]);
    // Interpolated head: lng=-122, lat halfway between 37.001 and 37.002
    expect(coords[2][0]).toBeCloseTo(-122.0, 12);
    expect(coords[2][1]).toBeCloseTo(0.5 * (37.001 + 37.002), 12);
  });

  it('big gap straddling t omits the interpolated head', () => {
    const idx = indexRoute(routeWithGap)!;
    // Inside the 89-second gap between pts[1] (15:00:01) and pts[2] (15:01:30).
    const t = Date.UTC(2026, 3, 4, 15, 0, 30);
    const feat = trailUpTo(t, idx);
    const coords = feat.geometry.coordinates;
    // Strict-before points are pts[0] and pts[1]; no interpolated head.
    expect(coords).toHaveLength(2);
    expect(coords[0]).toEqual([-122.0, 37.0]);
    expect(coords[1]).toEqual([-122.0, 37.001]);
  });
});

describe('clipWaypointLocation', () => {
  it('with no created_at and no gps falls back to null', () => {
    const clip = mkClip({ created_at: null, gps: null });
    expect(clipWaypointLocation(clip, indexRoute(linearRoute))).toBeNull();
  });

  it('with no created_at but a gps fallback returns the fallback', () => {
    const clip = mkClip({ created_at: null, gps: { lat: 1.5, lng: 2.5 } });
    const loc = clipWaypointLocation(clip, indexRoute(linearRoute));
    expect(loc).toEqual({ lat: 1.5, lng: 2.5, source: 'fallback' });
  });

  it('with an unparseable created_at falls back to clip.gps', () => {
    const clip = mkClip({ created_at: 'not a date', gps: { lat: 9, lng: 8 } });
    const loc = clipWaypointLocation(clip, indexRoute(linearRoute));
    expect(loc).toEqual({ lat: 9, lng: 8, source: 'fallback' });
  });

  it('anchors at created_at when trim is null (defaults to 0)', () => {
    const clip = mkClip({
      created_at: '2026-04-04T15:00:00Z',
      trim: null,
      gps: null,
    });
    const loc = clipWaypointLocation(clip, indexRoute(longLinearRoute));
    expect(loc).toEqual({ lat: 37.0, lng: -122.0, source: 'gpx' });
  });

  it('split-clip semantics: same created_at + different trim.in_ms → different positions', () => {
    // Both halves of a split clip share created_at = 15:00:00. The left
    // half has trim.in_ms = 0 (anchor at 15:00:00 → lat 37.000). The right
    // half has trim.in_ms = 5000 (anchor at 15:00:05 → lat 37.005). Without
    // the trim.in_ms offset, both halves would resolve to the same point.
    const created = '2026-04-04T15:00:00Z';
    const idx = indexRoute(longLinearRoute);
    const left = mkClip({
      id: 'left',
      created_at: created,
      trim: { in_ms: 0, out_ms: 5_000 },
    });
    const right = mkClip({
      id: 'right',
      created_at: created,
      trim: { in_ms: 5_000, out_ms: 10_000 },
    });
    const lLoc = clipWaypointLocation(left, idx)!;
    const rLoc = clipWaypointLocation(right, idx)!;
    expect(lLoc.source).toBe('gpx');
    expect(rLoc.source).toBe('gpx');
    expect(lLoc.lat).toBeCloseTo(37.0, 12);
    expect(rLoc.lat).toBeCloseTo(37.005, 12);
    // Same lng, different lat → demonstrably different positions.
    expect(rLoc.lat).not.toBeCloseTo(lLoc.lat, 6);
  });
});

describe('forwardAzimuth', () => {
  // Cardinals are exact at the equator: parallels are great circles there,
  // and any meridian segment is a great circle everywhere. Mid-latitude
  // east/west bearings have a tiny great-circle curvature offset (~0.0003°
  // for a 0.001° step), so we use lat=0 to get crisp cardinal outputs.
  const STEP = 0.001;

  it('due north (along a meridian at mid-latitude) → 0°', () => {
    expect(forwardAzimuth(37, -122, 37 + STEP, -122)).toBeCloseTo(0, 6);
  });

  it('due east at the equator → 90°', () => {
    expect(forwardAzimuth(0, 0, 0, STEP)).toBeCloseTo(90, 6);
  });

  it('due south (along a meridian at mid-latitude) → 180°', () => {
    expect(forwardAzimuth(37, -122, 37 - STEP, -122)).toBeCloseTo(180, 6);
  });

  it('due west at the equator → 270°', () => {
    expect(forwardAzimuth(0, 0, 0, -STEP)).toBeCloseTo(270, 6);
  });

  it('output is always in [0, 360)', () => {
    // Sweep four diagonals; each must normalize into [0, 360).
    const cases = [
      [37 + STEP, -122 + STEP],
      [37 - STEP, -122 + STEP],
      [37 - STEP, -122 - STEP],
      [37 + STEP, -122 - STEP],
    ] as const;
    for (const [lat2, lng2] of cases) {
      const az = forwardAzimuth(37, -122, lat2, lng2);
      expect(az).toBeGreaterThanOrEqual(0);
      expect(az).toBeLessThan(360);
    }
  });

  it('antipodal points (180° lng apart, same non-equator lat) return 0° — great circle goes over the pole', () => {
    // For two points at the same latitude separated by exactly 180° of
    // longitude, the shortest great-circle path runs directly over the
    // pole, which is "due north" (azimuth 0°). This is a defined output
    // (not NaN) — capturing it here so future refactors notice if it changes.
    expect(forwardAzimuth(37, 0, 37, 180)).toBeCloseTo(0, 6);
  });
});

describe('bearingAt', () => {
  it('returns null for a null route', () => {
    expect(bearingAt(0, null)).toBeNull();
  });

  it('returns null for a single-point route (no second point to sample)', () => {
    const single: Route = {
      source_path: '',
      format: 'gpx',
      trackpoints: [mkPoint(37, -122, '2026-04-04T15:00:00Z')],
    };
    expect(bearingAt(0, indexRoute(single))).toBeNull();
  });

  it('returns null for a non-positive windowMs', () => {
    const idx = indexRoute(linearRoute)!;
    expect(bearingAt(idx.minTimeMs, idx, 0)).toBeNull();
    expect(bearingAt(idx.minTimeMs, idx, -1000)).toBeNull();
  });

  it('two-point linear route moving north returns a constant ~0° bearing', () => {
    const idx = indexRoute(linearRoute)!;
    const tMid = (idx.minTimeMs + idx.maxTimeMs) / 2;
    const az = bearingAt(tMid, idx)!;
    expect(az).not.toBeNull();
    expect(az).toBeCloseTo(0, 6);
  });

  it('out-of-range t before the route start clamps the window inside [min,max]', () => {
    const idx = indexRoute(linearRoute)!;
    // t well before minTimeMs — the function should still return a defined
    // bearing using the clamped sample window starting at minTimeMs.
    const az = bearingAt(idx.minTimeMs - 60_000, idx);
    expect(az).not.toBeNull();
    expect(az).toBeCloseTo(0, 6);
  });

  it('out-of-range t after the route end clamps the window inside [min,max]', () => {
    const idx = indexRoute(linearRoute)!;
    const az = bearingAt(idx.maxTimeMs + 60_000, idx);
    expect(az).not.toBeNull();
    expect(az).toBeCloseTo(0, 6);
  });

  it('stationary segment returns null (a equals b)', () => {
    // Two trackpoints at the exact same lat/lng but different timestamps.
    const stationary: Route = {
      source_path: '',
      format: 'gpx',
      trackpoints: [
        mkPoint(37, -122, '2026-04-04T15:00:00Z'),
        mkPoint(37, -122, '2026-04-04T15:00:04Z'),
      ],
    };
    const idx = indexRoute(stationary)!;
    const tMid = (idx.minTimeMs + idx.maxTimeMs) / 2;
    expect(bearingAt(tMid, idx)).toBeNull();
  });

  it('returns null when the gap between samples falls in a > 60s GPX gap and locationAt fails', () => {
    // routeWithGap has an 89-second gap. With the default 4-second window
    // centered inside that gap, both locationAt samples will fall in the
    // gap → both return the (null) fallback → bearingAt returns null.
    const idx = indexRoute(routeWithGap)!;
    const tInGap = Date.UTC(2026, 3, 4, 15, 0, 30);
    expect(bearingAt(tInGap, idx)).toBeNull();
  });
});

describe('circularLerp', () => {
  it('350° → 10° at t=0.5 returns 0° (short arc through 0)', () => {
    expect(circularLerp(350, 10, 0.5)).toBeCloseTo(0, 6);
  });

  it('10° → 350° at t=0.5 returns 0° (short arc the other way)', () => {
    // The shortest path from 10° to 350° goes counterclockwise through 0°
    // — diff = -20°, not +340°. Halfway is 0°.
    expect(circularLerp(10, 350, 0.5)).toBeCloseTo(0, 6);
  });

  it('0° → 180° at t=0.5 returns 90° (clockwise arc — convention)', () => {
    // 0° → 180° is the ambiguous case: both arcs are 180° long, so the
    // function picks one by convention. With the source's `if (diff > 180)
    // diff -= 360` (strict greater), diff stays at +180 and the result is
    // 90°. This test codifies that choice — if the function ever flips to
    // the counterclockwise arc (270°) we'll know.
    expect(circularLerp(0, 180, 0.5)).toBeCloseTo(90, 6);
  });

  it('t=0 returns the start angle, t=1 returns the end angle', () => {
    expect(circularLerp(123, 45, 0)).toBeCloseTo(123, 6);
    expect(circularLerp(123, 45, 1)).toBeCloseTo(45, 6);
  });

  it('normalizes negative inputs into [0, 360)', () => {
    // -10° normalizes to 350°, and 350° → 10° at 0.5 → 0°.
    expect(circularLerp(-10, 10, 0.5)).toBeCloseTo(0, 6);
  });

  it('returns a value in [0, 360) for any t', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const v = circularLerp(350, 10, t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(360);
    }
  });
});

describe('computeBearingKeyframes', () => {
  it('returns null for a null route', () => {
    expect(computeBearingKeyframes(0, 1000, null, 1)).toBeNull();
  });

  it('returns null when the route has fewer than 2 points', () => {
    const single: Route = {
      source_path: '',
      format: 'gpx',
      trackpoints: [mkPoint(37, -122, '2026-04-04T15:00:00Z')],
    };
    expect(computeBearingKeyframes(0, 1000, indexRoute(single), 1)).toBeNull();
  });

  it('returns null when clipEndMs <= clipStartMs', () => {
    const idx = indexRoute(linearRoute);
    expect(computeBearingKeyframes(1000, 1000, idx, 1)).toBeNull();
    expect(computeBearingKeyframes(2000, 1000, idx, 1)).toBeNull();
  });

  it('returns null when stops < 1', () => {
    const idx = indexRoute(linearRoute);
    expect(computeBearingKeyframes(0, 1000, idx, 0)).toBeNull();
    expect(computeBearingKeyframes(0, 1000, idx, -3)).toBeNull();
  });

  it('returns null when locationAt fails inside a segment (e.g. gap fallthrough)', () => {
    // routeWithGap has a 89s gap; if a segment lands entirely inside the
    // gap, locationAt returns null and computeBearingKeyframes bails.
    const idx = indexRoute(routeWithGap)!;
    const tStart = Date.UTC(2026, 3, 4, 15, 0, 20);
    const tEnd = Date.UTC(2026, 3, 4, 15, 0, 50);
    expect(computeBearingKeyframes(tStart, tEnd, idx, 1)).toBeNull();
  });

  it('stops=1 returns a single keyframe at the midpoint of the clip', () => {
    const idx = indexRoute(linearRoute)!;
    const start = idx.minTimeMs;
    const end = idx.maxTimeMs;
    const kfs = computeBearingKeyframes(start, end, idx, 1)!;
    expect(kfs).toHaveLength(1);
    expect(kfs[0].timeMs).toBe((start + end) / 2);
    // Linear-north route → bearing ~0°
    expect(kfs[0].bearing).toBeCloseTo(0, 6);
  });

  it('stops=N returns N keyframes at segment midpoints', () => {
    const idx = indexRoute(linearRoute)!;
    const start = idx.minTimeMs;
    const end = idx.maxTimeMs;
    const stops = 4;
    const kfs = computeBearingKeyframes(start, end, idx, stops)!;
    expect(kfs).toHaveLength(stops);
    const segLen = (end - start) / stops;
    for (let i = 0; i < stops; i++) {
      expect(kfs[i].timeMs).toBeCloseTo(start + (i + 0.5) * segLen, 6);
      expect(kfs[i].bearing).toBeCloseTo(0, 6);
    }
  });

  it('stationary first segment falls back to a windowed bearing rather than null', () => {
    // routeWithStationarySegment: first ~half stationary, second half north.
    // With stops=4 the first segment is in the stationary half; the function
    // must use bearingAt's windowed fallback (which sweeps farther than the
    // single segment) to produce a defined bearing.
    const idx = indexRoute(routeWithStationarySegment)!;
    const start = idx.minTimeMs;
    const end = idx.maxTimeMs;
    const kfs = computeBearingKeyframes(start, end, idx, 4)!;
    expect(kfs).toHaveLength(4);
    for (const k of kfs) {
      expect(Number.isFinite(k.bearing)).toBe(true);
      expect(k.bearing).toBeGreaterThanOrEqual(0);
      expect(k.bearing).toBeLessThan(360);
    }
    // The non-stationary segments should still report ~0° (north).
    expect(kfs.at(-1)!.bearing).toBeCloseTo(0, 6);
  });
});

describe('bearingFromKeyframes', () => {
  it('empty keyframes returns 0', () => {
    expect(bearingFromKeyframes(0, [])).toBe(0);
  });

  it('single keyframe holds its bearing for any t', () => {
    expect(bearingFromKeyframes(0, [{ timeMs: 1000, bearing: 42 }])).toBe(42);
    expect(bearingFromKeyframes(99_999, [{ timeMs: 1000, bearing: 42 }])).toBe(42);
  });

  it('before the first keyframe holds first.bearing', () => {
    const kfs = [
      { timeMs: 1000, bearing: 30 },
      { timeMs: 2000, bearing: 90 },
    ];
    expect(bearingFromKeyframes(0, kfs)).toBe(30);
    expect(bearingFromKeyframes(1000, kfs)).toBe(30);
  });

  it('after the last keyframe holds last.bearing', () => {
    const kfs = [
      { timeMs: 1000, bearing: 30 },
      { timeMs: 2000, bearing: 90 },
    ];
    expect(bearingFromKeyframes(2000, kfs)).toBe(90);
    expect(bearingFromKeyframes(5000, kfs)).toBe(90);
  });

  it('between two keyframes circular-lerps', () => {
    const kfs = [
      { timeMs: 1000, bearing: 350 },
      { timeMs: 2000, bearing: 10 },
    ];
    // Halfway between → short arc through 0
    expect(bearingFromKeyframes(1500, kfs)).toBeCloseTo(0, 6);
  });

  it('lerps between intermediate keyframes (not just the first pair)', () => {
    const kfs = [
      { timeMs: 1000, bearing: 0 },
      { timeMs: 2000, bearing: 30 },
      { timeMs: 3000, bearing: 90 },
    ];
    // Halfway between kfs[1] and kfs[2]: shortest arc 30→90 at 0.5 = 60°.
    expect(bearingFromKeyframes(2500, kfs)).toBeCloseTo(60, 6);
  });
});

// ---- Coverage backfill ----
// Minimal targeted tests for the helpers below to keep routeLocation.ts at
// the ≥90% line-coverage gate without adding redundant cases.

describe('clipWallClockMs (coverage backfill)', () => {
  it('returns null when clip is null', () => {
    expect(clipWallClockMs(null, 0)).toBeNull();
  });

  it('returns null when clip.created_at is null', () => {
    const clip: Clip = mkClip({
      id: 'c',
      path: '',
      filename: '',
      created_at: null,
      duration_ms: null,
    });
    expect(clipWallClockMs(clip, 0)).toBeNull();
  });

  it('returns null when created_at is unparseable', () => {
    const clip: Clip = mkClip({
      id: 'c',
      path: '',
      filename: '',
      created_at: 'gibberish',
      duration_ms: null,
    });
    expect(clipWallClockMs(clip, 0)).toBeNull();
  });

  it('adds mediaSeconds * 1000 to the parsed start', () => {
    const clip: Clip = mkClip({
      id: 'c',
      path: '',
      filename: '',
      created_at: '2026-04-04T15:00:00Z',
      duration_ms: null,
    });
    expect(clipWallClockMs(clip, 2.5)).toBe(Date.UTC(2026, 3, 4, 15, 0, 0) + 2500);
  });
});

describe('cardinalFromBearing (coverage backfill)', () => {
  it('quantizes to N/E/S/W at exact cardinals', () => {
    expect(cardinalFromBearing(0)).toBe('N');
    expect(cardinalFromBearing(90)).toBe('E');
    expect(cardinalFromBearing(180)).toBe('S');
    expect(cardinalFromBearing(270)).toBe('W');
  });

  it('quantizes to NE/SE/SW/NW at intercardinals', () => {
    expect(cardinalFromBearing(45)).toBe('NE');
    expect(cardinalFromBearing(135)).toBe('SE');
    expect(cardinalFromBearing(225)).toBe('SW');
    expect(cardinalFromBearing(315)).toBe('NW');
  });

  it('normalizes negative or out-of-range bearings before quantizing', () => {
    expect(cardinalFromBearing(360)).toBe('N');
    expect(cardinalFromBearing(-90)).toBe('W');
  });
});

describe('progressUpTo', () => {
  const idx = indexRoute(linearRoute)!;
  const t0 = Date.parse('2026-04-04T15:00:00Z');

  it('returns 0 before the route start', () => {
    expect(progressUpTo(t0 - 1000, idx)).toBe(0);
  });

  it('returns 0 exactly at the route start', () => {
    expect(progressUpTo(t0, idx)).toBe(0);
  });

  it('returns 1 at and after the route end', () => {
    expect(progressUpTo(t0 + 4000, idx)).toBe(1);
    expect(progressUpTo(t0 + 99_999, idx)).toBe(1);
  });

  it('hits near-exact fraction values at trackpoint boundaries (uniform-speed route)', () => {
    // linearRoute has 5 evenly-spaced trackpoints over 4 seconds, all
    // moving due north at constant speed. `progressUpTo` is parameterized
    // in Web Mercator length (to agree with MapLibre's `line-progress`),
    // and Mercator stretches the y-axis non-linearly with latitude, so
    // equal lat steps don't quite produce equal Mercator-length steps.
    // The deviation is ~7e-6 in fraction over a 0.004° lat span at lat 37°
    // — sub-pixel even at zoom 22. Tolerance loosened from 5 → 3 decimals.
    expect(progressUpTo(t0 + 1000, idx)).toBeCloseTo(0.25, 3);
    expect(progressUpTo(t0 + 2000, idx)).toBeCloseTo(0.5, 3);
    expect(progressUpTo(t0 + 3000, idx)).toBeCloseTo(0.75, 3);
  });

  it('lerps inside a tractable gap', () => {
    expect(progressUpTo(t0 + 500, idx)).toBeCloseTo(0.125, 3);
  });

  it('snaps to the previous point inside an over-MAX_INTERPOLATION_GAP_MS gap', () => {
    const gappy = indexRoute(routeWithGap)!;
    // routeWithGap: t=0,1 then 89s gap then t=90,91. Halfway through the gap
    // must NOT pretend to interpolate — it should hold at the previous point.
    const tHalf = Date.parse('2026-04-04T15:00:45Z');
    const prog = progressUpTo(tHalf, gappy);
    const expected = gappy.cumulativeDistMeters[1] / gappy.totalDistMeters;
    expect(prog).toBeCloseTo(expected, 5);
  });

  it('returns 0 for a degenerate route with no movement', () => {
    const flat = indexRoute({
      source_path: '/fixtures/flat.gpx',
      format: 'gpx',
      trackpoints: [
        mkPoint(37.0, -122.0, '2026-04-04T15:00:00Z'),
        mkPoint(37.0, -122.0, '2026-04-04T15:00:01Z'),
      ],
    })!;
    expect(flat.totalDistMeters).toBe(0);
    expect(progressUpTo(Date.parse('2026-04-04T15:00:00.5Z'), flat)).toBe(0);
  });
});

describe('distanceAtWallClock / wallClockAtDistance (travel-transition inversion)', () => {
  const idx = indexRoute(linearRoute)!;
  const t0 = Date.parse('2026-04-04T15:00:00Z');

  it('distanceAtWallClock clamps outside the route range', () => {
    expect(distanceAtWallClock(t0 - 5000, idx)).toBe(0);
    expect(distanceAtWallClock(t0 + 99_999, idx)).toBe(idx.totalDistMeters);
  });

  it('distanceAtWallClock lerps time-linearly within a segment', () => {
    const half = distanceAtWallClock(t0 + 500, idx);
    expect(half).toBeCloseTo(idx.cumulativeDistMeters[1] / 2, 6);
    expect(distanceAtWallClock(t0 + 1000, idx)).toBeCloseTo(
      idx.cumulativeDistMeters[1],
      6,
    );
  });

  it('distanceAtWallClock snaps to the previous point inside an over-gap hole', () => {
    const gappy = indexRoute(routeWithGap)!;
    const tHalf = Date.parse('2026-04-04T15:00:45Z');
    expect(distanceAtWallClock(tHalf, gappy)).toBe(gappy.cumulativeDistMeters[1]);
  });

  it('round-trips through wallClockAtDistance on a uniformly-moving route', () => {
    for (const ms of [t0, t0 + 500, t0 + 1000, t0 + 2750, t0 + 4000]) {
      const d = distanceAtWallClock(ms, idx);
      expect(wallClockAtDistance(d, idx)).toBeCloseTo(ms, 3);
    }
  });

  it('wallClockAtDistance clamps past both ends', () => {
    expect(wallClockAtDistance(-10, idx)).toBe(idx.minTimeMs);
    expect(wallClockAtDistance(idx.totalDistMeters + 10, idx)).toBe(
      idx.maxTimeMs,
    );
  });

  it('wallClockAtDistance is monotone non-decreasing in distance', () => {
    let prev = -Infinity;
    for (let k = 0; k <= 20; k++) {
      const t = wallClockAtDistance((idx.totalDistMeters * k) / 20, idx);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it('returns the EARLIEST time on a stationary plateau', () => {
    // routeWithStationarySegment: three coincident points at t=0,1,2 then
    // movement. Distance 0 spans t=0..2 — inversion must pick t=0.
    const stat = indexRoute(routeWithStationarySegment)!;
    expect(wallClockAtDistance(0, stat)).toBe(stat.minTimeMs);
    // Just past the plateau, time jumps to inside the first moving segment
    // (t=2..3), never into the plateau interior.
    const eps = stat.totalDistMeters * 0.01;
    const tEps = wallClockAtDistance(eps, stat);
    expect(tEps).toBeGreaterThanOrEqual(Date.parse('2026-04-04T15:00:02Z'));
    expect(tEps).toBeLessThan(Date.parse('2026-04-04T15:00:03Z'));
  });

  it('handles duplicate (zero-length-segment) points without NaN', () => {
    const stat = indexRoute(routeWithStationarySegment)!;
    for (let k = 0; k <= 10; k++) {
      const t = wallClockAtDistance((stat.totalDistMeters * k) / 10, stat);
      expect(Number.isFinite(t)).toBe(true);
    }
  });
});

describe('indexRoute cumulative distances', () => {
  it('starts at 0 and is monotonically non-decreasing', () => {
    const idx = indexRoute(linearRoute)!;
    expect(idx.cumulativeDistMeters[0]).toBe(0);
    for (let i = 1; i < idx.cumulativeDistMeters.length; i++) {
      expect(idx.cumulativeDistMeters[i]).toBeGreaterThanOrEqual(
        idx.cumulativeDistMeters[i - 1],
      );
    }
  });

  it('totalDistMeters equals the last cumulative entry', () => {
    const idx = indexRoute(linearRoute)!;
    expect(idx.totalDistMeters).toBe(
      idx.cumulativeDistMeters[idx.cumulativeDistMeters.length - 1],
    );
  });
});

// Reference imports — these are exported and used elsewhere in the codebase
// but the linter would otherwise flag them as unused if a test ever drops the
// describe block above. Keeping a touch-test ensures we don't accidentally
// break the public surface.
describe('module exports surface', () => {
  it('DEFAULT_BEARING_WINDOW_MS is a positive number', () => {
    expect(DEFAULT_BEARING_WINDOW_MS).toBeGreaterThan(0);
  });

  it('IndexedRoute is the type returned by indexRoute', () => {
    const idx: IndexedRoute | null = indexRoute(linearRoute);
    expect(idx).not.toBeNull();
  });
});
