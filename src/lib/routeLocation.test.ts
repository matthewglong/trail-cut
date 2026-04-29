// Unit tests for the pure helpers in `routeLocation.ts` — the timestamp,
// position, trail, and bearing pipeline that powers both the live preview and
// the future Rust exporter (see §6.2 of MAP_ARCHITECTURE_MIGRATION.md).
//
// This file is the scaffold landed by migration task 200. Test bodies are
// added by tasks 210 (parseTimestamp / indexRoute / locationAt), 220
// (trailUpTo / clipWaypointLocation / forwardAzimuth), and 230 (bearingAt /
// circularLerp / computeBearingKeyframes / bearingFromKeyframes). Keep the
// `it.todo` placeholders as a per-block checklist until those tasks fill them.

import { describe, it } from 'vitest';

describe('parseTimestamp', () => {
  it.todo('parses ISO 8601 ("2026-04-04T15:13:00Z")');
  it.todo('parses ExifTool format ("2026:04:04 12:49:25-07:00")');
  it.todo('returns NaN for null / undefined / garbage');
});

describe('indexRoute', () => {
  it.todo('returns null for an empty route');
  it.todo('drops trackpoints without timestamps');
  it.todo('sorts out-of-order trackpoints ascending by timeMs');
  it.todo('reports correct minTimeMs / maxTimeMs');
});

describe('locationAt', () => {
  it.todo('exact hit on a trackpoint returns that point with source=gpx');
  it.todo('strict-before-first returns fallback (or null)');
  it.todo('strict-after-last returns fallback (or null)');
  it.todo('linear-interp midpoint between two close trackpoints');
  it.todo('gap > MAX_INTERPOLATION_GAP_MS falls back instead of interpolating');
  it.todo('null route + null fallback returns null');
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
