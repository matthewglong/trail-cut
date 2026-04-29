// Unit tests for the pure helpers in `routeLocation.ts` — the timestamp,
// position, trail, and bearing pipeline that powers both the live preview and
// the future Rust exporter (see §6.2 of MAP_ARCHITECTURE_MIGRATION.md).
//
// Test bodies for parseTimestamp / indexRoute / locationAt land in task 210.
// trailUpTo / clipWaypointLocation / forwardAzimuth land in task 220.
// bearingAt / circularLerp / computeBearingKeyframes / bearingFromKeyframes
// land in task 230.

import { describe, it, expect } from 'vitest';
import {
  parseTimestamp,
  indexRoute,
  locationAt,
  trailUpTo,
  clipWaypointLocation,
  forwardAzimuth,
  MAX_INTERPOLATION_GAP_MS,
} from './routeLocation';
import type { Clip, Route } from '../types';
import {
  linearRoute,
  longLinearRoute,
  mkPoint,
  routeWithGap,
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
  it.todo('two-point linear route returns a constant bearing');
  it.todo('out-of-range t clamps the sample window inside the route');
  it.todo('stationary segment returns null');
});

describe('circularLerp', () => {
  it.todo('350° → 10° at t=0.5 returns 0° (short arc through 0)');
  it.todo('10° → 350° at t=0.5 returns 0° (short arc the other way)');
  it.todo('0° → 180° at t=0.5 returns the documented arc');
});

describe('computeBearingKeyframes', () => {
  it.todo('stops=1 returns one keyframe at the midpoint');
  it.todo('stops=N returns N keyframes at segment midpoints');
  it.todo('stationary first segment falls back to a windowed bearing');
});

describe('bearingFromKeyframes', () => {
  it.todo('before first keyframe holds first.bearing');
  it.todo('after last keyframe holds last.bearing');
  it.todo('between keyframes circular-lerps');
});
