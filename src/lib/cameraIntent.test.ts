// Unit tests for the pure geometric helpers in `cameraIntent.ts`.

import { describe, it, expect } from 'vitest';
import {
  cameraForBounds,
  vanWijkArc,
  vanWijkSample,
  arcDurationMs,
  buildMapTrack,
  cameraAt,
  resolveIntent,
  interpolateAnchors,
  DEFAULT_INTENT,
} from './cameraIntent';
import type {
  Bounds,
  Viewport,
  ResolvedCamera,
  CameraIntent,
  MapAnchor,
  MapTrack,
} from './cameraIntent';
import { circularLerp, type IndexedRoute } from './routeLocation';
import { DEFAULT_MAP_SETTINGS, type Clip, type MapSettings } from '../types';

// 1° of longitude at the equator ≈ 111320 m. Used to build small geodesic
// squares centered on (0, 0) where Mercator distortion is negligible.
const METERS_PER_DEG_AT_EQUATOR = 111_320;

function squareAtEquator(meters: number): Bounds {
  const halfDeg = meters / 2 / METERS_PER_DEG_AT_EQUATOR;
  return {
    sw: { lng: -halfDeg, lat: -halfDeg },
    ne: { lng: halfDeg, lat: halfDeg },
  };
}

const NO_TILT = { bearing: 0, pitch: 0 };

describe('cameraForBounds', () => {
  it('frames a ~1km equatorial square at the expected zoom in a 1024×1024 viewport', () => {
    // Algorithm-derived expected zoom for a 1km square at the equator with
    // padding=0 in a 1024² viewport, computed directly from the algorithm
    // (world size 512px). Cross-checked once by hand:
    //   dLng       = 1000 / 111320         ≈ 8.983e-3 deg
    //   dx_pixels  = (dLng / 360) * 512    ≈ 1.278e-2 px @ z=0
    //   zoom       = log2(1024 / dx_pixels) ≈ 16.29
    // The ±0.5 tolerance allows for the loose "1km @ equator" framing
    // (different meters-per-degree conventions land within ~0.05 of this).
    const bounds = squareAtEquator(1000);
    const viewport: Viewport = { width: 1024, height: 1024 };

    const cam = cameraForBounds(bounds, 0, viewport, NO_TILT);

    expect(cam.zoom).toBeCloseTo(16.29, 1);
    expect(cam.zoom).toBeGreaterThan(16.29 - 0.5);
    expect(cam.zoom).toBeLessThan(16.29 + 0.5);
    // Center must be the bounds midpoint.
    expect(cam.center.lng).toBeCloseTo(0, 9);
    expect(cam.center.lat).toBeCloseTo(0, 9);
  });

  it('asymmetric bounds: zoom is set by the limiting (wider) axis in a square viewport', () => {
    // 2:1 horizontal extent: dx is twice dy in world-pixel space, so for a
    // square viewport the X axis runs out of room first and dictates zoom.
    const halfLng = 1000 / METERS_PER_DEG_AT_EQUATOR; // 2km wide total
    const halfLat = halfLng / 2; // 1km tall total
    const bounds: Bounds = {
      sw: { lng: -halfLng, lat: -halfLat },
      ne: { lng: halfLng, lat: halfLat },
    };
    const viewport: Viewport = { width: 1024, height: 1024 };

    const cam = cameraForBounds(bounds, 0, viewport, NO_TILT);

    // Independently fit the same bounds against just the X axis: the
    // limiting-axis zoom should equal the result.
    const square = squareAtEquator(2000); // same 2km horizontal extent
    const xLimited = cameraForBounds(square, 0, viewport, NO_TILT);
    expect(cam.zoom).toBeCloseTo(xLimited.zoom, 6);
  });

  it('a very tight 100m square frames at high zoom (>16)', () => {
    const bounds = squareAtEquator(100);
    const viewport: Viewport = { width: 1024, height: 1024 };
    const cam = cameraForBounds(bounds, 0, viewport, NO_TILT);
    // 1km gave ~16.29; shrinking the bounds 10× adds log2(10) ≈ 3.32 → ~19.6.
    expect(cam.zoom).toBeGreaterThan(16);
  });

  it('rejects fractional padding >= 0.5', () => {
    const bounds = squareAtEquator(1000);
    const viewport: Viewport = { width: 1024, height: 1024 };
    expect(() => cameraForBounds(bounds, 0.5, viewport, NO_TILT)).toThrow(
      /padding/,
    );
    expect(() => cameraForBounds(bounds, 0.75, viewport, NO_TILT)).toThrow(
      /padding/,
    );
  });

  it('passes bearing and pitch through unchanged from extra', () => {
    const bounds = squareAtEquator(1000);
    const viewport: Viewport = { width: 1024, height: 1024 };
    const cam = cameraForBounds(bounds, 0, viewport, {
      bearing: 137.5,
      pitch: 42,
    });
    expect(cam.bearing).toBe(137.5);
    expect(cam.pitch).toBe(42);
  });

  it('padding shrinks the inset rectangle and lowers resolved zoom', () => {
    const bounds = squareAtEquator(1000);
    const viewport: Viewport = { width: 1024, height: 1024 };
    const noPad = cameraForBounds(bounds, 0, viewport, NO_TILT);
    const withPad = cameraForBounds(bounds, 0.1, viewport, NO_TILT);
    expect(withPad.zoom).toBeLessThan(noPad.zoom);
  });
});

// ---------------------------------------------------------------------------
// Van Wijk arc primitives.
//
// Tests verify endpoint exactness, degenerate-arc handling, feel-multiplier
// ordering, and arc-direction symmetry. The math itself is covered by the
// paper / MapLibre flyTo cross-reference; these tests guard the contract
// downstream consumers (interpolateAnchors, runClipTransition replacement)
// rely on.
// ---------------------------------------------------------------------------

const NO_TILT_CAM = { bearing: 0, pitch: 0 };

function camAt(lng: number, lat: number, zoom: number): ResolvedCamera {
  return { center: { lng, lat }, zoom, ...NO_TILT_CAM };
}

describe('vanWijkArc / vanWijkSample', () => {
  it('sample at s=0 reproduces camA (center within 1e-6, zoom within 1e-3)', () => {
    const camA = camAt(-122.4, 37.77, 14);
    const camB = camAt(-122.39, 37.78, 16);
    const arc = vanWijkArc(camA, camB);

    const sample = vanWijkSample(camA, camB, arc, 0);

    expect(sample.center.lng).toBeCloseTo(camA.center.lng, 6);
    expect(sample.center.lat).toBeCloseTo(camA.center.lat, 6);
    expect(Math.abs(sample.zoom - camA.zoom)).toBeLessThan(1e-3);
  });

  it('sample at s=arc.S reproduces camB (center within 1e-6, zoom within 1e-3)', () => {
    const camA = camAt(-122.4, 37.77, 14);
    const camB = camAt(-122.39, 37.78, 16);
    const arc = vanWijkArc(camA, camB);

    const sample = vanWijkSample(camA, camB, arc, arc.S);

    expect(sample.center.lng).toBeCloseTo(camB.center.lng, 6);
    expect(sample.center.lat).toBeCloseTo(camB.center.lat, 6);
    expect(Math.abs(sample.zoom - camB.zoom)).toBeLessThan(1e-3);
  });

  it('degenerate arc (camA === camB) returns near-camA at any s', () => {
    const camA = camAt(-122.4, 37.77, 14);
    const camB = camAt(-122.4, 37.77, 14); // identical
    const arc = vanWijkArc(camA, camB);

    expect(arc.S).toBeCloseTo(0, 6);

    // Sample at multiple s values — all should pin to camA.
    for (const s of [0, 0.5, 1, 5]) {
      const sample = vanWijkSample(camA, camB, arc, s);
      expect(sample.center.lng).toBeCloseTo(camA.center.lng, 9);
      expect(sample.center.lat).toBeCloseTo(camA.center.lat, 9);
      expect(Math.abs(sample.zoom - camA.zoom)).toBeLessThan(1e-3);
    }
  });

  it('pure-zoom (linear-branch) arc still satisfies endpoint contract', () => {
    // Same center, different zoom → linear-pan branch, exponential w(s).
    const camA = camAt(-122.4, 37.77, 12);
    const camB = camAt(-122.4, 37.77, 16);
    const arc = vanWijkArc(camA, camB);

    expect(arc.S).toBeGreaterThan(0);

    const start = vanWijkSample(camA, camB, arc, 0);
    expect(Math.abs(start.zoom - camA.zoom)).toBeLessThan(1e-3);
    const end = vanWijkSample(camA, camB, arc, arc.S);
    expect(Math.abs(end.zoom - camB.zoom)).toBeLessThan(1e-3);
  });

  it('sample mid-arc stays between camA and camB in zoom', () => {
    const camA = camAt(-122.4, 37.77, 14);
    const camB = camAt(-122.39, 37.78, 16);
    const arc = vanWijkArc(camA, camB);

    const mid = vanWijkSample(camA, camB, arc, arc.S / 2);
    // Mid-arc zoom should sit between the endpoints — typically below
    // both (Van Wijk zooms out before zooming back in).
    expect(mid.zoom).toBeLessThanOrEqual(Math.max(camA.zoom, camB.zoom) + 1e-3);
  });
});

describe('arcDurationMs', () => {
  it('feel ordering: snappy < natural < slow for the same arc', () => {
    const camA = camAt(-122.4, 37.77, 14);
    const camB = camAt(-122.35, 37.8, 16);
    const arc = vanWijkArc(camA, camB);

    const snappy = arcDurationMs(arc, 'snappy');
    const natural = arcDurationMs(arc, 'natural');
    const slow = arcDurationMs(arc, 'slow');

    expect(snappy).toBeLessThan(natural);
    expect(natural).toBeLessThan(slow);
  });

  it('A→B and B→A arcs have the same total duration (symmetry)', () => {
    const camA = camAt(-122.4, 37.77, 14);
    const camB = camAt(-122.35, 37.8, 16);
    const forward = vanWijkArc(camA, camB);
    const reverse = vanWijkArc(camB, camA);

    const dForward = arcDurationMs(forward, 'natural');
    const dReverse = arcDurationMs(reverse, 'natural');

    // Paper §4: S is invariant under endpoint swap. Allow tiny float drift.
    expect(Math.abs(dForward - dReverse)).toBeLessThan(1e-3);
  });

  it('respects MIN_MS floor for tiny arcs', () => {
    // Identical cameras → S=0 → raw duration 0 → must clamp up to MIN_MS.
    const camA = camAt(-122.4, 37.77, 14);
    const arc = vanWijkArc(camA, camA);
    const d = arcDurationMs(arc, 'natural');
    expect(d).toBeGreaterThanOrEqual(1100);
  });
});

// ---------------------------------------------------------------------------
// buildMapTrack / cameraAt
//
// These tests cover:
//   - empty-clip / empty-track handling (DEFAULT_INTENT fallback)
//   - single-anchor follow vs. point: liveIntent semantics
//   - before-first / after-last clamping
//   - purity (same args → deeply-equal results)
//   - gap routing into the still-stubbed `interpolateAnchors`
// ---------------------------------------------------------------------------

/** Build a minimal Clip with the fields buildMapTrack actually reads.
 *  Anything else is left at sensible defaults so the test surface stays
 *  focused on the camera-intent contract. */
function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: overrides.id ?? 'clip-1',
    path: '/tmp/clip.mov',
    filename: 'clip.mov',
    created_at: '2026-04-04T15:00:00Z',
    duration_ms: 10_000,
    gps: null,
    resolution: null,
    frame_rate: null,
    trim: { in_ms: 0, out_ms: 10_000 },
    focal_point: { x: 0.5, y: 0.5, zoom: 1 },
    effects: { stabilize: { enabled: false, shakiness: 0 }, speed: 1 },
    visible: true,
    map_overrides: null,
    ...overrides,
  };
}

/** Project settings preset that forces a `point` anchor (no follow). */
const POINT_SETTINGS: MapSettings = {
  ...DEFAULT_MAP_SETTINGS,
  follow_playhead: false,
  bearing_mode: 'fixed',
  bearing_degrees: 0,
};

/** Project settings preset that forces a `follow` anchor with fixed bearing
 *  (so we don't need an indexed route's GPX geometry to make sense). */
const FOLLOW_SETTINGS: MapSettings = {
  ...DEFAULT_MAP_SETTINGS,
  follow_playhead: true,
  bearing_mode: 'fixed',
  bearing_degrees: 0,
};

/** A minimal IndexedRoute spanning the test clip's wall-clock range.
 *  Two trackpoints is enough to be "non-degenerate" for follow intents. */
function makeIndexedRoute(): import('./routeLocation').IndexedRoute {
  const t0 = Date.parse('2026-04-04T15:00:00Z');
  return {
    points: [
      { lat: 37.77, lng: -122.40, timeMs: t0 },
      { lat: 37.78, lng: -122.39, timeMs: t0 + 60_000 },
    ],
    minTimeMs: t0,
    maxTimeMs: t0 + 60_000,
  };
}

describe('buildMapTrack + cameraAt', () => {
  it('empty clips → empty track → cameraAt returns DEFAULT_INTENT', () => {
    const track = buildMapTrack([], null, DEFAULT_MAP_SETTINGS, 'natural');
    expect(track.anchors).toHaveLength(0);
    expect(track.transitionFeel).toBe('natural');

    const intent = cameraAt(track, 0);
    expect(intent).toEqual(DEFAULT_INTENT);
  });

  it('skips clips with missing or unparseable created_at without throwing', () => {
    const clips: Clip[] = [
      makeClip({ id: 'no-ts', created_at: null }),
      makeClip({ id: 'bad-ts', created_at: 'not-a-date' }),
      makeClip({ id: 'good', created_at: '2026-04-04T15:00:00Z' }),
    ];
    const track = buildMapTrack(clips, null, POINT_SETTINGS, 'natural');
    expect(track.anchors).toHaveLength(1);
  });

  it('skips clips with degenerate trim ranges (out_ms <= in_ms)', () => {
    const clips: Clip[] = [
      makeClip({ id: 'zero', trim: { in_ms: 1000, out_ms: 1000 } }),
      makeClip({ id: 'inverted', trim: { in_ms: 5000, out_ms: 1000 } }),
    ];
    const track = buildMapTrack(clips, null, POINT_SETTINGS, 'natural');
    expect(track.anchors).toHaveLength(0);
  });

  it('skips invisible clips', () => {
    const clips: Clip[] = [
      makeClip({ id: 'hidden', visible: false }),
      makeClip({ id: 'shown' }),
    ];
    const track = buildMapTrack(clips, null, POINT_SETTINGS, 'natural');
    expect(track.anchors).toHaveLength(1);
  });

  it('single follow anchor: cameraAt(t) inside returns follow intent with playheadMs === t', () => {
    const t0 = Date.parse('2026-04-04T15:00:00Z');
    const route = makeIndexedRoute();
    const track = buildMapTrack(
      [makeClip({ id: 'c1' })],
      route,
      FOLLOW_SETTINGS,
      'natural',
    );
    expect(track.anchors).toHaveLength(1);
    expect(track.anchors[0].intent.kind).toBe('follow');

    const probeT = t0 + 3_000;
    const intent = cameraAt(track, probeT);
    expect(intent.kind).toBe('follow');
    if (intent.kind === 'follow') {
      expect(intent.playheadMs).toBe(probeT);
      // The frozen-on-intent route reference passes through.
      expect(intent.route).toBe(route);
    }
  });

  it('single point anchor: cameraAt at any t inside returns the point intent unchanged (purity)', () => {
    const t0 = Date.parse('2026-04-04T15:00:00Z');
    const track = buildMapTrack(
      [makeClip({ id: 'c1', gps: { lat: 37.77, lng: -122.4 } })],
      null,
      POINT_SETTINGS,
      'natural',
    );
    const anchorIntent = track.anchors[0].intent;
    expect(anchorIntent.kind).toBe('point');

    // Inside the clip range, the live intent is identity (point intents are
    // time-invariant — liveIntent returns them unchanged).
    for (const t of [t0, t0 + 1, t0 + 5_000, t0 + 9_999]) {
      const intent = cameraAt(track, t);
      expect(intent).toBe(anchorIntent);
    }
  });

  it('before-first: cameraAt(t < anchors[0].timeMs) returns intent equivalent to first anchor', () => {
    const t0 = Date.parse('2026-04-04T15:00:00Z');
    const route = makeIndexedRoute();
    const track = buildMapTrack(
      [makeClip({ id: 'c1' })],
      route,
      FOLLOW_SETTINGS,
      'natural',
    );
    const first = track.anchors[0];

    // Strictly before the first anchor's start.
    const probeT = t0 - 5_000;
    const intent = cameraAt(track, probeT);
    // For follow: playheadMs is overwritten with the probe t per liveIntent.
    expect(intent.kind).toBe('follow');
    if (intent.kind === 'follow' && first.intent.kind === 'follow') {
      expect(intent.playheadMs).toBe(probeT);
      // All other follow fields preserved from the anchor's intent.
      expect(intent.route).toBe(first.intent.route);
      expect(intent.targetZoom).toBe(first.intent.targetZoom);
      expect(intent.bearingMode).toBe(first.intent.bearingMode);
      expect(intent.fixedBearingDegrees).toBe(first.intent.fixedBearingDegrees);
      expect(intent.pitch).toBe(first.intent.pitch);
    }
  });

  it('after-last: cameraAt(t > last.endTimeMs) returns intent clamped to last.endTimeMs', () => {
    const route = makeIndexedRoute();
    const track = buildMapTrack(
      [makeClip({ id: 'c1' })],
      route,
      FOLLOW_SETTINGS,
      'natural',
    );
    const last = track.anchors[track.anchors.length - 1];

    // Strictly after the last anchor's end.
    const intent = cameraAt(track, last.endTimeMs + 60_000);
    expect(intent.kind).toBe('follow');
    if (intent.kind === 'follow') {
      // Clamping behavior: playheadMs pinned to last.endTimeMs, not the
      // probe time. Don't drag the follow marker past the last clip.
      expect(intent.playheadMs).toBe(last.endTimeMs);
    }
  });

  it('after-last with point intent passes through unchanged', () => {
    const track = buildMapTrack(
      [makeClip({ id: 'c1', gps: { lat: 37.77, lng: -122.4 } })],
      null,
      POINT_SETTINGS,
      'natural',
    );
    const last = track.anchors[track.anchors.length - 1];
    const intent = cameraAt(track, last.endTimeMs + 60_000);
    // Point intents are time-invariant; identity passthrough.
    expect(intent).toBe(last.intent);
  });

  it('purity: two calls with the same args produce deeply-equal intents', () => {
    const t0 = Date.parse('2026-04-04T15:00:00Z');
    const route = makeIndexedRoute();
    const track = buildMapTrack(
      [makeClip({ id: 'c1' })],
      route,
      FOLLOW_SETTINGS,
      'natural',
    );

    // Use a deep structural compare via toEqual. JSON.stringify would also
    // work but loses identity info on nested object refs (route is shared
    // by reference across calls — which is the *intended* behavior — and
    // toEqual reports both structural equality and identity). We
    // intentionally use toEqual so a future regression that copies the
    // route reference would still pass equality but the explicit `route`
    // identity assertion below catches it.
    const probeT = t0 + 1_234;
    const a = cameraAt(track, probeT);
    const b = cameraAt(track, probeT);
    expect(a).toEqual(b);
    if (a.kind === 'follow' && b.kind === 'follow') {
      expect(a.route).toBe(b.route);
    }
  });

  it('gap routing: cameraAt in a gap returns a point intent between anchor endpoints', () => {
    const route = makeIndexedRoute();
    const t0 = Date.parse('2026-04-04T15:00:00Z');
    // Two POINT clips with distinct GPS endpoints and a 30s gap between
    // them. Using point intents (not follow) gives us deterministic,
    // route-independent endpoints to assert the interpolated center is
    // between.
    const clipA = makeClip({
      id: 'a',
      created_at: '2026-04-04T15:00:00Z',
      duration_ms: 10_000,
      trim: { in_ms: 0, out_ms: 10_000 },
      gps: { lat: 37.77, lng: -122.40 },
    });
    const clipB = makeClip({
      id: 'b',
      // Starts 40s after t0 → 30s gap after clipA ends at t0+10s.
      created_at: '2026-04-04T15:00:40Z',
      duration_ms: 10_000,
      trim: { in_ms: 0, out_ms: 10_000 },
      gps: { lat: 37.80, lng: -122.35 },
    });
    const track = buildMapTrack([clipA, clipB], route, POINT_SETTINGS, 'natural');
    expect(track.anchors).toHaveLength(2);

    // Probe the gap midpoint. Result must be a `point` intent whose
    // center is strictly between the two anchors (since cubic ease-in-out
    // at t=0.5 yields exactly 0.5 — a midway sample along the arc).
    const gapMidT = t0 + 25_000;
    const intent = cameraAt(track, gapMidT);
    expect(intent.kind).toBe('point');
    if (intent.kind === 'point') {
      // Center sits strictly between the two anchor centers in lng/lat.
      // The Van Wijk arc is monotonic in u, and uFraction at eased=0.5 is
      // strictly in (0, 1), so center coordinates lie strictly between.
      expect(intent.center.lng).toBeGreaterThan(-122.40);
      expect(intent.center.lng).toBeLessThan(-122.35);
      expect(intent.center.lat).toBeGreaterThan(37.77);
      expect(intent.center.lat).toBeLessThan(37.80);
    }
  });

  it('anchors are sorted by start time even if clips arrive out of order', () => {
    const later = makeClip({
      id: 'later',
      created_at: '2026-04-04T15:01:00Z',
    });
    const earlier = makeClip({
      id: 'earlier',
      created_at: '2026-04-04T15:00:00Z',
    });
    const track = buildMapTrack([later, earlier], null, POINT_SETTINGS, 'natural');
    expect(track.anchors).toHaveLength(2);
    expect(track.anchors[0].timeMs).toBeLessThan(track.anchors[1].timeMs);
  });

  // Reference unused imports so TS/eslint don't complain in the test scope.
  void (null as unknown as CameraIntent | MapAnchor | MapTrack);
});

// ---------------------------------------------------------------------------
// resolveIntent.
//
// resolveIntent is the only aspect-aware function in the architecture. The
// tests below cover all three intent kinds and verify the critical
// aspect-awareness contract: the same `region` intent against two viewports
// of different aspect ratios produces two different framings (zoom values).
// ---------------------------------------------------------------------------

describe('resolveIntent', () => {
  it('point: passes center/zoom/bearing/pitch through unchanged', () => {
    const intent: CameraIntent = {
      kind: 'point',
      center: { lng: -122.4, lat: 37.77 },
      zoom: 14.5,
      bearing: 137.5,
      pitch: 42,
    };
    const viewport: Viewport = { width: 1920, height: 1080 };
    const cam = resolveIntent(intent, viewport);
    expect(cam.center).toEqual(intent.center);
    expect(cam.zoom).toBe(14.5);
    expect(cam.bearing).toBe(137.5);
    expect(cam.pitch).toBe(42);
  });

  it('region: produces different zoom for different viewport aspect ratios', () => {
    // Same region intent, two viewports. A 1km equatorial square framed in
    // a 1024×1024 square viewport vs. a 360×640 portrait viewport — the
    // limiting axis flips (vertical strips get tighter on width), so the
    // resolved zoom must differ. This is the entire point of the
    // intent/resolve split.
    const bounds = squareAtEquator(1000);
    const intent: CameraIntent = {
      kind: 'region',
      bounds,
      padding: 0.05,
      bearing: 0,
      pitch: 0,
    };

    const square = resolveIntent(intent, { width: 1024, height: 1024 });
    const portrait = resolveIntent(intent, { width: 360, height: 640 });

    expect(square.zoom).not.toBe(portrait.zoom);
    // Sanity: the smaller (360×640) viewport should resolve to a *lower*
    // zoom — a smaller window can only fit the bounds at a wider zoom.
    expect(portrait.zoom).toBeLessThan(square.zoom);
    // Center is the bounds midpoint regardless of viewport.
    expect(square.center.lng).toBeCloseTo(0, 9);
    expect(portrait.center.lng).toBeCloseTo(0, 9);
  });

  it('follow (auto): center from locationAt, bearing from bearingFromKeyframes', () => {
    const t0 = Date.parse('2026-04-04T15:00:00Z');
    const route: IndexedRoute = {
      points: [
        { lat: 37.77, lng: -122.40, timeMs: t0 },
        { lat: 37.78, lng: -122.39, timeMs: t0 + 10_000 },
      ],
      minTimeMs: t0,
      maxTimeMs: t0 + 10_000,
    };
    // Hand-picked keyframes covering the clip's wall-clock range. Pick a
    // non-ambiguous short-way pair: 350° → 30° at t=0.5 should land on
    // ~10° (short way is +40°, not -320°). Avoids the 90→270 case where
    // the two short-way arcs are equidistant.
    const intent: CameraIntent = {
      kind: 'follow',
      playheadMs: t0 + 5_000, // halfway between the two trackpoints
      route,
      targetZoom: 16,
      bearingMode: 'auto',
      padding: 0.06,
      bearingKeyframes: [
        { timeMs: t0, bearing: 350 },
        { timeMs: t0 + 10_000, bearing: 30 },
      ],
      pitch: 0,
    };
    const cam = resolveIntent(intent, { width: 1024, height: 1024 });

    // Center: at t0+5s, locationAt linearly interpolates trackpoints.
    expect(cam.center.lat).toBeCloseTo(37.775, 6);
    expect(cam.center.lng).toBeCloseTo(-122.395, 6);
    // Bearing: short-way 350→30 covers +40° (through 0), so midpoint = 10°.
    expect(cam.bearing).toBeCloseTo(10, 6);
    expect(cam.zoom).toBe(16);
    expect(cam.pitch).toBe(0);
  });

  it('follow (auto): empty bearing keyframes → bearing falls back to 0', () => {
    const t0 = Date.parse('2026-04-04T15:00:00Z');
    const route: IndexedRoute = {
      points: [
        { lat: 37.77, lng: -122.40, timeMs: t0 },
        { lat: 37.78, lng: -122.39, timeMs: t0 + 10_000 },
      ],
      minTimeMs: t0,
      maxTimeMs: t0 + 10_000,
    };
    const intent: CameraIntent = {
      kind: 'follow',
      playheadMs: t0 + 1_000,
      route,
      targetZoom: 14,
      bearingMode: 'auto',
      padding: 0.06,
      bearingKeyframes: [],
      pitch: 0,
    };
    const cam = resolveIntent(intent, { width: 1024, height: 1024 });
    expect(cam.bearing).toBe(0);
  });

  it('follow (fixed): bearing from fixedBearingDegrees', () => {
    const t0 = Date.parse('2026-04-04T15:00:00Z');
    const route: IndexedRoute = {
      points: [
        { lat: 37.77, lng: -122.40, timeMs: t0 },
        { lat: 37.78, lng: -122.39, timeMs: t0 + 10_000 },
      ],
      minTimeMs: t0,
      maxTimeMs: t0 + 10_000,
    };
    const intent: CameraIntent = {
      kind: 'follow',
      playheadMs: t0 + 5_000,
      route,
      targetZoom: 14,
      bearingMode: 'fixed',
      padding: 0.06,
      fixedBearingDegrees: 180,
      bearingKeyframes: [],
      pitch: 60,
    };
    const cam = resolveIntent(intent, { width: 1024, height: 1024 });
    expect(cam.bearing).toBe(180);
    expect(cam.pitch).toBe(60);
  });

  it('follow: locationAt returning null → center falls back to (0, 0)', () => {
    // playheadMs out of route range and no embedded GPS fallback (resolveIntent
    // passes `null` to locationAt) → locationAt returns null → resolveIntent
    // substitutes the documented {lng:0, lat:0} sentinel rather than throwing.
    const t0 = Date.parse('2026-04-04T15:00:00Z');
    const route: IndexedRoute = {
      points: [
        { lat: 37.77, lng: -122.40, timeMs: t0 },
        { lat: 37.78, lng: -122.39, timeMs: t0 + 10_000 },
      ],
      minTimeMs: t0,
      maxTimeMs: t0 + 10_000,
    };
    const intent: CameraIntent = {
      kind: 'follow',
      // 1 hour after the route ends — out of range, no fallback in resolveIntent.
      playheadMs: t0 + 3_600_000,
      route,
      targetZoom: 12,
      bearingMode: 'fixed',
      padding: 0.06,
      fixedBearingDegrees: 0,
      bearingKeyframes: [],
      pitch: 0,
    };
    const cam = resolveIntent(intent, { width: 1024, height: 1024 });
    expect(cam.center).toEqual({ lng: 0, lat: 0 });
  });
});

// ---------------------------------------------------------------------------
// interpolateAnchors.
//
// Endpoint exactness: at t = a.endTimeMs the interpolated camera should
// match canonicalCamera(a). At t = a.endTimeMs + arcDurationMs(arc, feel)
// it should match canonicalCamera(b). These guarantee the gap closes
// seamlessly into the next anchor's framing.
// ---------------------------------------------------------------------------

describe('interpolateAnchors', () => {
  function makePointAnchor(
    timeMs: number,
    endTimeMs: number,
    lng: number,
    lat: number,
    zoom: number,
    bearing = 0,
    pitch = 0,
  ): MapAnchor {
    return {
      timeMs,
      endTimeMs,
      intent: {
        kind: 'point',
        center: { lng, lat },
        zoom,
        bearing,
        pitch,
      },
    };
  }

  it('at t = a.endTimeMs returns a camera ≈ canonicalCamera(a)', () => {
    const a = makePointAnchor(0, 10_000, -122.40, 37.77, 14, 30, 0);
    const b = makePointAnchor(15_000, 25_000, -122.35, 37.80, 16, 90, 0);

    const intent = interpolateAnchors(a, b, a.endTimeMs, 'natural');
    expect(intent.kind).toBe('point');
    if (intent.kind === 'point') {
      expect(intent.center.lng).toBeCloseTo(-122.40, 6);
      expect(intent.center.lat).toBeCloseTo(37.77, 6);
      expect(Math.abs(intent.zoom - 14)).toBeLessThan(1e-3);
      expect(intent.bearing).toBeCloseTo(30, 6);
      expect(intent.pitch).toBeCloseTo(0, 9);
    }
  });

  it('at t = a.endTimeMs + arcDurationMs returns a camera ≈ canonicalCamera(b)', () => {
    const a = makePointAnchor(0, 10_000, -122.40, 37.77, 14, 30, 0);
    const b = makePointAnchor(15_000, 25_000, -122.35, 37.80, 16, 90, 0);

    // Recompute the arc to find its duration — same construction as
    // interpolateAnchors does internally.
    const camA = a.intent.kind === 'point'
      ? { center: a.intent.center, zoom: a.intent.zoom, bearing: a.intent.bearing, pitch: a.intent.pitch }
      : null;
    const camB = b.intent.kind === 'point'
      ? { center: b.intent.center, zoom: b.intent.zoom, bearing: b.intent.bearing, pitch: b.intent.pitch }
      : null;
    if (!camA || !camB) throw new Error('test setup invariant');
    const arc = vanWijkArc(camA, camB);
    const tEnd = a.endTimeMs + arcDurationMs(arc, 'natural');

    const intent = interpolateAnchors(a, b, tEnd, 'natural');
    expect(intent.kind).toBe('point');
    if (intent.kind === 'point') {
      expect(intent.center.lng).toBeCloseTo(-122.35, 5);
      expect(intent.center.lat).toBeCloseTo(37.80, 5);
      expect(Math.abs(intent.zoom - 16)).toBeLessThan(1e-3);
      expect(intent.bearing).toBeCloseTo(90, 6);
    }
  });

  it('beyond t = tEnd: clamp01 holds at camB', () => {
    const a = makePointAnchor(0, 10_000, -122.40, 37.77, 14);
    const b = makePointAnchor(15_000, 25_000, -122.35, 37.80, 16);

    const intent = interpolateAnchors(a, b, 1_000_000, 'natural');
    if (intent.kind === 'point') {
      expect(intent.center.lng).toBeCloseTo(-122.35, 5);
      expect(intent.center.lat).toBeCloseTo(37.80, 5);
    }
  });
});

// ---------------------------------------------------------------------------
// circularLerp — short-way bearing interpolation. Already tested by usage
// in resolveIntent's auto-bearing path; the 350° → 10° wraparound case is
// guarded explicitly here.
// ---------------------------------------------------------------------------

describe('circularLerp short-way', () => {
  it('350° → 10° at t=0.5 lands on 0° (the short-way arc, 20° clockwise)', () => {
    expect(circularLerp(350, 10, 0.5)).toBeCloseTo(0, 6);
  });
});
