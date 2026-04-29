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
  MAX_INTERPOLATION_GAP_MS,
} from './routeLocation';
import type { Route } from '../types';
import { linearRoute, mkPoint, routeWithGap } from './__fixtures__/routes';

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
  it.todo('before route start returns empty coordinates');
  it.todo('after route end returns all coordinates');
  it.todo('mid-route returns strict-before points + interpolated head');
  it.todo('big gap straddling t omits the interpolated head');
});

describe('clipWaypointLocation', () => {
  it.todo('anchors at created_at + trim.in_ms (split-clip semantics)');
});

describe('forwardAzimuth', () => {
  it.todo('cardinal directions: N=0, E=90, S=180, W=270');
  it.todo('antipodal points have a defined output');
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
