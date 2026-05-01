// Unit tests for the pure geometric helpers in `cameraIntent.ts`.

import { describe, it, expect } from 'vitest';
import {
  cameraForBounds,
  vanWijkArc,
  vanWijkSample,
  arcDurationMs,
  buildMapTrack,
  cameraAt,
  cameraAtWallClock,
  resolveIntent,
  interpolateAnchors,
  compileTimeline,
  resolveProjectStartCamera,
  activeClipIdAt,
  DEFAULT_INTENT,
} from './cameraIntent';
import type {
  Bounds,
  Viewport,
  ResolvedCamera,
  CameraIntent,
  MapAnchor,
  MapTrack,
  CompileTimelineProjectSettings,
  CompiledTimeline,
} from './cameraIntent';
import { circularLerp, type IndexedRoute } from './routeLocation';
import {
  DEFAULT_MAP_SETTINGS,
  type Clip,
  type ClipEntryTransition,
  type MapSettings,
} from '../types';

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

describe('buildMapTrack + cameraAtWallClock', () => {
  it('empty clips → empty track → cameraAt returns DEFAULT_INTENT', () => {
    const track = buildMapTrack([], null, DEFAULT_MAP_SETTINGS, 'natural');
    expect(track.anchors).toHaveLength(0);
    expect(track.transitionFeel).toBe('natural');

    const intent = cameraAtWallClock(track, 0);
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
    const intent = cameraAtWallClock(track, probeT);
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
      const intent = cameraAtWallClock(track, t);
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
    const intent = cameraAtWallClock(track, probeT);
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
    const intent = cameraAtWallClock(track, last.endTimeMs + 60_000);
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
    const intent = cameraAtWallClock(track, last.endTimeMs + 60_000);
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
    const a = cameraAtWallClock(track, probeT);
    const b = cameraAtWallClock(track, probeT);
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
    const intent = cameraAtWallClock(track, gapMidT);
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

// ---------------------------------------------------------------------------
// compileTimeline + resolveProjectStartCamera (task 520)
//
// Tests the pure compiler that walks the ordered clip list, applies authored
// entry-transition settings, and produces a CompiledTimeline. Coverage:
//
//   - empty clip list → empty timeline with a non-null startCamera
//   - skip rules (invisible / missing or unparseable created_at / degenerate
//     trim) match buildMapTrack
//   - clip span tiling (no project-time gaps, lengths derived from media +
//     speed)
//   - boundary formula at entryBias = -1, 0, +1 (no clamp, both clips long)
//   - clamping when one or both sides overrun the available media
//   - first-clip clamping (always post-cut only, since availablePreCut == 0)
//   - authored durationMs respected literally (transitionFeel ignored)
//   - feel: per-clip override beats project default; project default beats
//     'natural'
//   - resolveProjectStartCamera: override wins; default centroid + zoom 12 +
//     bearing 0 + pitch by style
//   - purity: same input → deeply-equal output across two calls
// ---------------------------------------------------------------------------

const COMPILER_POINT_SETTINGS: MapSettings = {
  ...DEFAULT_MAP_SETTINGS,
  follow_playhead: false,
  bearing_mode: 'fixed',
  bearing_degrees: 0,
};

/** Build a Clip for compileTimeline tests. Provides a full record so the
 *  helper can override individual fields without TypeScript noise. */
function compilerClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c',
    path: '/tmp/c.mov',
    filename: 'c.mov',
    created_at: '2026-04-04T15:00:00Z',
    duration_ms: 10_000,
    gps: { lat: 37.77, lng: -122.4 },
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

const NO_PROJECT_SETTINGS: CompileTimelineProjectSettings = {};

describe('resolveProjectStartCamera', () => {
  it('honors explicit override on the project', () => {
    const settings: CompileTimelineProjectSettings = {
      start_camera: {
        center: { lng: -120.0, lat: 35.0 },
        zoom: 14.5,
        bearing: 90,
        pitch: 30,
      },
    };
    const cam = resolveProjectStartCamera(
      [compilerClip()],
      settings,
      DEFAULT_MAP_SETTINGS,
      null,
    );
    expect(cam).toEqual({
      center: { lng: -120.0, lat: 35.0 },
      zoom: 14.5,
      bearing: 90,
      pitch: 30,
    });
  });

  it('default centroid camera averages clip waypoint locations', () => {
    const clips = [
      compilerClip({ id: 'a', gps: { lat: 30, lng: -120 } }),
      compilerClip({ id: 'b', gps: { lat: 40, lng: -100 } }),
    ];
    const cam = resolveProjectStartCamera(
      clips,
      NO_PROJECT_SETTINGS,
      DEFAULT_MAP_SETTINGS,
      null,
    );
    expect(cam.center.lng).toBeCloseTo(-110, 6);
    expect(cam.center.lat).toBeCloseTo(35, 6);
    expect(cam.zoom).toBe(12);
    expect(cam.bearing).toBe(0);
    expect(cam.pitch).toBe(0);
  });

  it('default pitch is 60 for 3d style, 0 otherwise', () => {
    const clips = [compilerClip()];
    const settings3d: MapSettings = { ...DEFAULT_MAP_SETTINGS, map_style: '3d' };
    const sat: MapSettings = { ...DEFAULT_MAP_SETTINGS, map_style: 'satellite' };
    const cam3d = resolveProjectStartCamera(clips, NO_PROJECT_SETTINGS, settings3d, null);
    const camSat = resolveProjectStartCamera(clips, NO_PROJECT_SETTINGS, sat, null);
    expect(cam3d.pitch).toBe(60);
    expect(camSat.pitch).toBe(0);
  });

  it('falls back to {0,0} when no clip resolves a location', () => {
    // No GPS, no route → clipWaypointLocation returns null, centroid count 0.
    const clip = compilerClip({ id: 'no-loc', gps: null, created_at: null });
    const cam = resolveProjectStartCamera(
      [clip],
      NO_PROJECT_SETTINGS,
      DEFAULT_MAP_SETTINGS,
      null,
    );
    expect(cam.center).toEqual({ lng: 0, lat: 0 });
    expect(cam.zoom).toBe(12);
  });
});

describe('compileTimeline', () => {
  it('empty clip list → empty timeline with valid startCamera', () => {
    const tl = compileTimeline([], null, DEFAULT_MAP_SETTINGS, NO_PROJECT_SETTINGS);
    expect(tl.clipSpans).toHaveLength(0);
    expect(tl.transitionSpans).toHaveLength(0);
    expect(tl.totalDurationMs).toBe(0);
    expect(tl.transitionFeel).toBe('natural');
    expect(tl.startCamera.zoom).toBe(12);
  });

  it('passes transition_feel through from project settings', () => {
    const tl = compileTimeline([], null, DEFAULT_MAP_SETTINGS, {
      transition_feel: 'snappy',
    });
    expect(tl.transitionFeel).toBe('snappy');
  });

  it('skip rules: invisible, missing/unparseable created_at, degenerate trim', () => {
    const clips: Clip[] = [
      compilerClip({ id: 'invisible', visible: false }),
      compilerClip({ id: 'no-ts', created_at: null }),
      compilerClip({ id: 'bad-ts', created_at: 'not-a-date' }),
      compilerClip({ id: 'zero-trim', trim: { in_ms: 1000, out_ms: 1000 } }),
      compilerClip({ id: 'inverted-trim', trim: { in_ms: 5000, out_ms: 1000 } }),
      compilerClip({ id: 'good' }),
    ];
    const tl = compileTimeline(clips, null, COMPILER_POINT_SETTINGS, NO_PROJECT_SETTINGS);
    expect(tl.clipSpans.map((s) => s.clipId)).toEqual(['good']);
    expect(tl.transitionSpans.map((t) => t.toClipId)).toEqual(['good']);
  });

  it('clip span tiling: no gaps, lengths from (out-in)/speed', () => {
    const clips = [
      compilerClip({
        id: 'a',
        trim: { in_ms: 1000, out_ms: 5000 },
        effects: { stabilize: { enabled: false, shakiness: 0 }, speed: 2 },
      }),
      compilerClip({ id: 'b', trim: { in_ms: 0, out_ms: 6000 } }),
      compilerClip({
        id: 'c',
        trim: { in_ms: 0, out_ms: 9000 },
        effects: { stabilize: { enabled: false, shakiness: 0 }, speed: 0.5 },
      }),
    ];
    const tl = compileTimeline(clips, null, COMPILER_POINT_SETTINGS, NO_PROJECT_SETTINGS);
    expect(tl.clipSpans).toHaveLength(3);
    // a: (5000-1000)/2 = 2000
    expect(tl.clipSpans[0].startMs).toBe(0);
    expect(tl.clipSpans[0].endMs).toBe(2000);
    // b: 6000/1 = 6000
    expect(tl.clipSpans[1].startMs).toBe(2000);
    expect(tl.clipSpans[1].endMs).toBe(8000);
    // c: 9000/0.5 = 18000
    expect(tl.clipSpans[2].startMs).toBe(8000);
    expect(tl.clipSpans[2].endMs).toBe(26000);
    expect(tl.totalDurationMs).toBe(26000);
    // Tiling: each span starts where the previous one ended.
    for (let i = 1; i < tl.clipSpans.length; i++) {
      expect(tl.clipSpans[i].startMs).toBe(tl.clipSpans[i - 1].endMs);
    }
    // canonicalSeekMs == clipSpan.startMs.
    for (const span of tl.clipSpans) {
      expect(span.canonicalSeekMs).toBe(span.startMs);
    }
    // mediaIn/Out match the trim.
    expect(tl.clipSpans[0].mediaInMs).toBe(1000);
    expect(tl.clipSpans[0].mediaOutMs).toBe(5000);
  });

  it('boundary formula: bias=-1 places transition entirely pre-cut', () => {
    const settings: CompileTimelineProjectSettings = {
      default_entry_transition: { duration_ms: 600, entry_bias: -1 },
    };
    const clips = [
      compilerClip({
        id: 'a',
        created_at: '2026-04-04T15:00:00Z',
        trim: { in_ms: 0, out_ms: 10_000 },
      }),
      compilerClip({
        id: 'b',
        created_at: '2026-04-04T15:00:30Z',
        trim: { in_ms: 0, out_ms: 10_000 },
      }),
    ];
    const tl = compileTimeline(clips, null, COMPILER_POINT_SETTINGS, settings);
    // The cut between a and b is at project-time 10000.
    const t0 = tl.transitionSpans[0]; // project-start → a (clip 1)
    const t1 = tl.transitionSpans[1]; // a → b
    expect(t0.fromClipId).toBeNull();
    expect(t1.fromClipId).toBe('a');
    expect(t1.toClipId).toBe('b');
    // bias=-1: requestedPreCut=600, requestedPostCut=0. Both available.
    expect(t1.startMs).toBe(10_000 - 600);
    expect(t1.endMs).toBe(10_000);
    expect(t1.effectiveDurationMs).toBe(600);
  });

  it('boundary formula: bias=+1 places transition entirely post-cut', () => {
    const settings: CompileTimelineProjectSettings = {
      default_entry_transition: { duration_ms: 600, entry_bias: 1 },
    };
    const clips = [
      compilerClip({
        id: 'a',
        created_at: '2026-04-04T15:00:00Z',
        trim: { in_ms: 0, out_ms: 10_000 },
      }),
      compilerClip({
        id: 'b',
        created_at: '2026-04-04T15:00:30Z',
        trim: { in_ms: 0, out_ms: 10_000 },
      }),
    ];
    const tl = compileTimeline(clips, null, COMPILER_POINT_SETTINGS, settings);
    const t1 = tl.transitionSpans[1]; // a → b
    expect(t1.startMs).toBe(10_000);
    expect(t1.endMs).toBe(10_000 + 600);
    expect(t1.effectiveDurationMs).toBe(600);
  });

  it('boundary formula: bias=0 centers transition on the cut', () => {
    const settings: CompileTimelineProjectSettings = {
      default_entry_transition: { duration_ms: 600, entry_bias: 0 },
    };
    const clips = [
      compilerClip({
        id: 'a',
        created_at: '2026-04-04T15:00:00Z',
        trim: { in_ms: 0, out_ms: 10_000 },
      }),
      compilerClip({
        id: 'b',
        created_at: '2026-04-04T15:00:30Z',
        trim: { in_ms: 0, out_ms: 10_000 },
      }),
    ];
    const tl = compileTimeline(clips, null, COMPILER_POINT_SETTINGS, settings);
    const t1 = tl.transitionSpans[1];
    expect(t1.startMs).toBe(10_000 - 300);
    expect(t1.endMs).toBe(10_000 + 300);
    expect(t1.effectiveDurationMs).toBe(600);
  });

  it('first-clip clamp: pre-cut clamps to 0 regardless of bias', () => {
    const settings: CompileTimelineProjectSettings = {
      default_entry_transition: { duration_ms: 600, entry_bias: 0 },
    };
    const clips = [
      compilerClip({
        id: 'only',
        trim: { in_ms: 0, out_ms: 10_000 },
      }),
    ];
    const tl = compileTimeline(clips, null, COMPILER_POINT_SETTINGS, settings);
    const t0 = tl.transitionSpans[0];
    expect(t0.fromClipId).toBeNull();
    expect(t0.startMs).toBe(0);
    // bias=0 requested 300ms post-cut and 300ms pre-cut. Pre-cut clamps
    // to 0; post-cut survives.
    expect(t0.endMs).toBe(300);
    expect(t0.effectiveDurationMs).toBe(300);
  });

  it('first-clip clamp: bias=+1 with duration shorter than clip yields full transition', () => {
    const settings: CompileTimelineProjectSettings = {
      default_entry_transition: { duration_ms: 600, entry_bias: 1 },
    };
    const clips = [
      compilerClip({
        id: 'only',
        trim: { in_ms: 0, out_ms: 10_000 },
      }),
    ];
    const tl = compileTimeline(clips, null, COMPILER_POINT_SETTINGS, settings);
    const t0 = tl.transitionSpans[0];
    expect(t0.startMs).toBe(0);
    expect(t0.endMs).toBe(600);
  });

  it('both-sides overrun: 10s transition between two 1s clips clamps to 2s', () => {
    const settings: CompileTimelineProjectSettings = {
      default_entry_transition: { duration_ms: 10_000, entry_bias: 0 },
    };
    // A 1s clip A then a 1s clip B.
    const clips = [
      compilerClip({
        id: 'a',
        trim: { in_ms: 0, out_ms: 1_000 },
      }),
      compilerClip({
        id: 'b',
        created_at: '2026-04-04T15:00:30Z',
        trim: { in_ms: 0, out_ms: 1_000 },
      }),
    ];
    const tl = compileTimeline(clips, null, COMPILER_POINT_SETTINGS, settings);
    const t1 = tl.transitionSpans[1];
    // Effective duration = sum of available media on both sides.
    expect(t1.effectiveDurationMs).toBe(2_000);
    expect(t1.startMs).toBe(0); // cut at 1000, pre-cut clamped from 5000 to 1000
    expect(t1.endMs).toBe(2_000); // post-cut clamped from 5000 to 1000
  });

  it('single-side overrun: longer clip survives, shorter side clamps', () => {
    const settings: CompileTimelineProjectSettings = {
      default_entry_transition: { duration_ms: 10_000, entry_bias: 0 },
    };
    const clips = [
      compilerClip({
        id: 'a',
        trim: { in_ms: 0, out_ms: 1_000 }, // short
      }),
      compilerClip({
        id: 'b',
        created_at: '2026-04-04T15:00:30Z',
        trim: { in_ms: 0, out_ms: 100_000 }, // very long
      }),
    ];
    const tl = compileTimeline(clips, null, COMPILER_POINT_SETTINGS, settings);
    const t1 = tl.transitionSpans[1];
    // Pre-cut requested 5000 ms, only 1000 available → clamps to 1000.
    // Post-cut requested 5000 ms, plenty available → 5000.
    expect(t1.startMs).toBe(0);
    expect(t1.endMs).toBe(6_000); // 1000 + 5000
    expect(t1.effectiveDurationMs).toBe(6_000);
  });

  it('authored durationMs is respected literally regardless of feel', () => {
    // Two distinct cameras (point intents) so the auto-derived path would
    // produce a non-trivial duration. Authored value must win anyway.
    const clipA = compilerClip({
      id: 'a',
      gps: { lat: 37.77, lng: -122.4 },
      trim: { in_ms: 0, out_ms: 10_000 },
    });
    const clipB = compilerClip({
      id: 'b',
      created_at: '2026-04-04T15:01:00Z',
      gps: { lat: 38.0, lng: -120.0 },
      trim: { in_ms: 0, out_ms: 10_000 },
    });

    const literal = compileTimeline([clipA, clipB], null, COMPILER_POINT_SETTINGS, {
      transition_feel: 'slow',
      default_entry_transition: { duration_ms: 750, entry_bias: 1 },
    });
    expect(literal.transitionSpans[1].effectiveDurationMs).toBe(750);

    const sameLiteralWithDifferentFeel = compileTimeline(
      [clipA, clipB],
      null,
      COMPILER_POINT_SETTINGS,
      {
        transition_feel: 'snappy',
        default_entry_transition: { duration_ms: 750, entry_bias: 1 },
      },
    );
    expect(sameLiteralWithDifferentFeel.transitionSpans[1].effectiveDurationMs).toBe(
      750,
    );
  });

  it('auto-derived duration uses transitionFeel; per-clip feel beats project default', () => {
    const clipA = compilerClip({
      id: 'a',
      gps: { lat: 37.77, lng: -122.4 },
      trim: { in_ms: 0, out_ms: 10_000 },
    });
    const clipBProject: Clip = compilerClip({
      id: 'b',
      created_at: '2026-04-04T15:01:00Z',
      gps: { lat: 38.0, lng: -120.0 },
      trim: { in_ms: 0, out_ms: 10_000 },
    });
    const clipBOverride: Clip = {
      ...clipBProject,
      entry_transition: { feel: 'snappy' },
    };

    const projectSlow: CompileTimelineProjectSettings = {
      transition_feel: 'slow',
    };
    const projectSnappy: CompileTimelineProjectSettings = {
      transition_feel: 'snappy',
    };

    const slow = compileTimeline(
      [clipA, clipBProject],
      null,
      COMPILER_POINT_SETTINGS,
      projectSlow,
    );
    const snappy = compileTimeline(
      [clipA, clipBProject],
      null,
      COMPILER_POINT_SETTINGS,
      projectSnappy,
    );
    // Different feels must yield different auto-derived durations.
    expect(slow.transitionSpans[1].effectiveDurationMs).not.toBe(
      snappy.transitionSpans[1].effectiveDurationMs,
    );

    // Per-clip feel='snappy' under a project default of 'slow' should
    // match the project default of 'snappy' for the same clips.
    const overridden = compileTimeline(
      [clipA, clipBOverride],
      null,
      COMPILER_POINT_SETTINGS,
      projectSlow,
    );
    expect(overridden.transitionSpans[1].effectiveDurationMs).toBeCloseTo(
      snappy.transitionSpans[1].effectiveDurationMs,
      6,
    );
  });

  it('disabled transition collapses to a zero-length window at the cut', () => {
    const disabled: ClipEntryTransition = { enabled: false };
    const clips = [
      compilerClip({
        id: 'a',
        trim: { in_ms: 0, out_ms: 10_000 },
      }),
      compilerClip({
        id: 'b',
        created_at: '2026-04-04T15:00:30Z',
        trim: { in_ms: 0, out_ms: 10_000 },
        entry_transition: disabled,
      }),
    ];
    const tl = compileTimeline(clips, null, COMPILER_POINT_SETTINGS, NO_PROJECT_SETTINGS);
    const t1 = tl.transitionSpans[1];
    expect(t1.startMs).toBe(10_000);
    expect(t1.endMs).toBe(10_000);
    expect(t1.effectiveDurationMs).toBe(0);
  });

  it('per-clip entry_transition overrides project default per-field', () => {
    const projectDefault: ClipEntryTransition = { duration_ms: 600, entry_bias: 0 };
    const clipB: Clip = compilerClip({
      id: 'b',
      created_at: '2026-04-04T15:00:30Z',
      trim: { in_ms: 0, out_ms: 10_000 },
      // Override only entry_bias; duration_ms inherits.
      entry_transition: { entry_bias: -1 },
    });
    const clips = [compilerClip({ id: 'a', trim: { in_ms: 0, out_ms: 10_000 } }), clipB];
    const tl = compileTimeline(clips, null, COMPILER_POINT_SETTINGS, {
      default_entry_transition: projectDefault,
    });
    const t1 = tl.transitionSpans[1];
    // Inherited 600ms duration, overridden bias=-1 → entirely pre-cut.
    expect(t1.startMs).toBe(10_000 - 600);
    expect(t1.endMs).toBe(10_000);
  });

  it('purity: same input → deeply-equal output across two calls', () => {
    const clips = [
      compilerClip({ id: 'a', gps: { lat: 37.77, lng: -122.4 } }),
      compilerClip({
        id: 'b',
        created_at: '2026-04-04T15:01:00Z',
        gps: { lat: 38.0, lng: -120.0 },
      }),
    ];
    const settings: CompileTimelineProjectSettings = {
      transition_feel: 'natural',
      default_entry_transition: { duration_ms: 800, entry_bias: 0 },
    };
    const a = compileTimeline(clips, null, COMPILER_POINT_SETTINGS, settings);
    const b = compileTimeline(clips, null, COMPILER_POINT_SETTINGS, settings);
    expect(a).toEqual(b);
  });

  it('no inverted spans: every span has start <= end', () => {
    const clips = [
      compilerClip({ id: 'a', trim: { in_ms: 0, out_ms: 1_000 } }),
      compilerClip({
        id: 'b',
        created_at: '2026-04-04T15:00:30Z',
        trim: { in_ms: 0, out_ms: 1_000 },
      }),
      compilerClip({
        id: 'c',
        created_at: '2026-04-04T15:01:00Z',
        trim: { in_ms: 0, out_ms: 1_000 },
      }),
    ];
    const tl = compileTimeline(clips, null, COMPILER_POINT_SETTINGS, {
      default_entry_transition: { duration_ms: 5_000, entry_bias: 0 },
    });
    for (const cs of tl.clipSpans) {
      expect(cs.endMs).toBeGreaterThanOrEqual(cs.startMs);
    }
    for (const ts of tl.transitionSpans) {
      expect(ts.endMs).toBeGreaterThanOrEqual(ts.startMs);
    }
  });

  it('one transition span per visible clip; clip 1 has fromClipId === null', () => {
    const clips = [
      compilerClip({ id: 'a', trim: { in_ms: 0, out_ms: 5_000 } }),
      compilerClip({
        id: 'b',
        created_at: '2026-04-04T15:00:30Z',
        trim: { in_ms: 0, out_ms: 5_000 },
      }),
      compilerClip({
        id: 'c',
        created_at: '2026-04-04T15:01:00Z',
        trim: { in_ms: 0, out_ms: 5_000 },
      }),
    ];
    const tl = compileTimeline(clips, null, COMPILER_POINT_SETTINGS, NO_PROJECT_SETTINGS);
    expect(tl.transitionSpans).toHaveLength(3);
    expect(tl.transitionSpans[0].fromClipId).toBeNull();
    expect(tl.transitionSpans[0].toClipId).toBe('a');
    expect(tl.transitionSpans[1].fromClipId).toBe('a');
    expect(tl.transitionSpans[1].toClipId).toBe('b');
    expect(tl.transitionSpans[2].fromClipId).toBe('b');
    expect(tl.transitionSpans[2].toClipId).toBe('c');
  });

  it('preserves order of valid clips after skip filtering', () => {
    const clips = [
      compilerClip({ id: 'first' }),
      compilerClip({ id: 'skipme', visible: false }),
      compilerClip({
        id: 'second',
        created_at: '2026-04-04T15:00:30Z',
      }),
    ];
    const tl = compileTimeline(clips, null, COMPILER_POINT_SETTINGS, NO_PROJECT_SETTINGS);
    expect(tl.clipSpans.map((s) => s.clipId)).toEqual(['first', 'second']);
  });
});

// ---------------------------------------------------------------------------
// cameraAt(timeline, t) — task 530.
//
// The new project-time evaluator. Both preview and export consume this. The
// continuity invariants are the gating contract; the rest of the suite
// exercises region routing (before-zero, in-clip, in-transition, after-end),
// follow-intent project-time → wall-clock translation, and purity.
//
// Synthetic input: 3-clip point-intent timelines so canonical resolution is
// deterministic and viewport-free (point intents pass straight through
// resolveCanonical without going through cameraForBounds).
// ---------------------------------------------------------------------------

const TEN_S = 10_000;

/** Three point-intent clips with distinct GPS for distinct canonical
 *  cameras. Each clip is 10s of media at speed=1, so project-time spans
 *  are 10s each. Matching `created_at` spacing is intentional — the
 *  compiler does not depend on it (project-time is derived) but it makes
 *  any wall-clock translation easier to reason about. */
function threeClipPointTimeline(
  settings: CompileTimelineProjectSettings = {},
): { timeline: CompiledTimeline; clips: Clip[] } {
  const clips = [
    compilerClip({
      id: 'a',
      created_at: '2026-04-04T15:00:00Z',
      gps: { lat: 37.77, lng: -122.40 },
      trim: { in_ms: 0, out_ms: TEN_S },
    }),
    compilerClip({
      id: 'b',
      created_at: '2026-04-04T15:00:30Z',
      gps: { lat: 37.80, lng: -122.35 },
      trim: { in_ms: 0, out_ms: TEN_S },
    }),
    compilerClip({
      id: 'c',
      created_at: '2026-04-04T15:01:00Z',
      gps: { lat: 37.83, lng: -122.30 },
      trim: { in_ms: 0, out_ms: TEN_S },
    }),
  ];
  const timeline = compileTimeline(clips, null, COMPILER_POINT_SETTINGS, settings);
  return { timeline, clips };
}

describe('cameraAt(timeline, t)', () => {
  it('empty timeline: returns startCamera as a point intent for any t', () => {
    const tl = compileTimeline([], null, DEFAULT_MAP_SETTINGS, {});
    for (const t of [-1000, 0, 5000, 1_000_000]) {
      const intent = cameraAt(tl, t);
      expect(intent.kind).toBe('point');
      if (intent.kind === 'point') {
        expect(intent.center).toEqual(tl.startCamera.center);
        expect(intent.zoom).toBe(tl.startCamera.zoom);
        expect(intent.bearing).toBe(tl.startCamera.bearing);
        expect(intent.pitch).toBe(tl.startCamera.pitch);
      }
    }
  });

  it('t < 0: holds startCamera as a point intent', () => {
    const { timeline } = threeClipPointTimeline();
    const intent = cameraAt(timeline, -5_000);
    expect(intent.kind).toBe('point');
    if (intent.kind === 'point') {
      expect(intent.center).toEqual(timeline.startCamera.center);
      expect(intent.zoom).toBe(timeline.startCamera.zoom);
    }
  });

  it('t >= totalDurationMs: returns last clip intent (point intents pass through unchanged)', () => {
    const { timeline } = threeClipPointTimeline();
    const intent = cameraAt(timeline, timeline.totalDurationMs + 60_000);
    // Last clip is 'c' with point intent at gps c. Point intent passes
    // through liveIntentForClipSpan unchanged → identity with the span's
    // intent reference.
    const lastSpan = timeline.clipSpans[timeline.clipSpans.length - 1];
    expect(intent).toBe(lastSpan.intent);
  });

  it('inside a clip span (point intent): returns the clip intent unchanged (identity)', () => {
    const { timeline } = threeClipPointTimeline();
    const middleSpan = timeline.clipSpans[1];
    // Probe the middle of clip B's span. Choose a t safely inside the
    // clip's media — past any post-cut transition overrun. With default
    // (no settings) the auto-derived transitions clamp small relative to
    // a 10s clip, so the strict middle is in-clip.
    const midT = (middleSpan.startMs + middleSpan.endMs) / 2;
    const intent = cameraAt(timeline, midT);
    expect(intent).toBe(middleSpan.intent);
  });

  it('inside a clip span (follow intent): translates project-time → wall-clock per the plan', () => {
    // Use FOLLOW_SETTINGS (defined for the legacy buildMapTrack tests
    // above) and a route so anchorIntentForClip emits a follow intent.
    const t0 = Date.parse('2026-04-04T15:00:00Z');
    const route: import('./routeLocation').IndexedRoute = {
      points: [
        { lat: 37.77, lng: -122.40, timeMs: t0 },
        { lat: 37.78, lng: -122.39, timeMs: t0 + TEN_S },
      ],
      minTimeMs: t0,
      maxTimeMs: t0 + TEN_S,
    };
    const clips = [
      compilerClip({
        id: 'follow-clip',
        created_at: '2026-04-04T15:00:00Z',
        trim: { in_ms: 1000, out_ms: 5000 },
        // 2× speed → project-time span = (5000-1000)/2 = 2000 ms.
        effects: { stabilize: { enabled: false, shakiness: 0 }, speed: 2 },
        // Disable the entry transition so the entire span is in-clip and
        // the project-time → wall-clock translation is the only path
        // exercised at the probe.
        entry_transition: { enabled: false },
      }),
    ];
    const followSettings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      follow_playhead: true,
      bearing_mode: 'fixed',
      bearing_degrees: 0,
    };
    const timeline = compileTimeline(clips, route, followSettings, {});
    const span = timeline.clipSpans[0];
    expect(span.intent.kind).toBe('follow');

    // Probe at project-time = startMs + 500 (ms). Per §"Time-Axis
    // Translation": clipLocalMs = 500*2 + 1000 = 2000; wallClockMs =
    // parseTimestamp(created_at) + 2000.
    const t = span.startMs + 500;
    const intent = cameraAt(timeline, t);
    expect(intent.kind).toBe('follow');
    if (intent.kind === 'follow') {
      expect(intent.playheadMs).toBe(t0 + 2000);
      // Other follow fields preserved.
      expect(intent.route).toBe(route);
      expect(intent.bearingMode).toBe('fixed');
    }
  });

  it('continuity invariant: cameraAt(transitionSpan.startMs) ≈ previous canonical (or startCamera)', () => {
    // Use authored durations that don't extend into adjacent clips so the
    // invariant test is unambiguous (no overlap with the next transition).
    const { timeline } = threeClipPointTimeline({
      default_entry_transition: { duration_ms: 600, entry_bias: 0 },
    });
    const viewport: Viewport = { width: 1024, height: 1024, dpr: 1 };

    for (const tspan of timeline.transitionSpans) {
      if (tspan.effectiveDurationMs <= 0) continue;
      const intent = cameraAt(timeline, tspan.startMs);
      const cam = resolveIntent(intent, viewport);

      // Expected fromCamera: previous clip's terminal canonical, or
      // startCamera for clip 1.
      let expected: ResolvedCamera;
      if (tspan.fromClipId == null) {
        expected = timeline.startCamera;
      } else {
        const fromSpan = timeline.clipSpans.find((s) => s.clipId === tspan.fromClipId)!;
        expected = resolveIntent(fromSpan.intent, viewport);
      }
      expect(cam.center.lng).toBeCloseTo(expected.center.lng, 6);
      expect(cam.center.lat).toBeCloseTo(expected.center.lat, 6);
      expect(Math.abs(cam.zoom - expected.zoom)).toBeLessThan(1e-3);
      expect(cam.bearing).toBeCloseTo(expected.bearing, 6);
      expect(cam.pitch).toBeCloseTo(expected.pitch, 9);
    }
  });

  it('continuity invariant: cameraAt(transitionSpan.endMs) ≈ destination clip initial canonical', () => {
    const { timeline } = threeClipPointTimeline({
      default_entry_transition: { duration_ms: 600, entry_bias: 0 },
    });
    const viewport: Viewport = { width: 1024, height: 1024, dpr: 1 };

    for (const tspan of timeline.transitionSpans) {
      if (tspan.effectiveDurationMs <= 0) continue;
      const intent = cameraAt(timeline, tspan.endMs);
      const cam = resolveIntent(intent, viewport);

      const toSpan = timeline.clipSpans.find((s) => s.clipId === tspan.toClipId)!;
      const expected = resolveIntent(toSpan.intent, viewport);
      expect(cam.center.lng).toBeCloseTo(expected.center.lng, 6);
      expect(cam.center.lat).toBeCloseTo(expected.center.lat, 6);
      expect(Math.abs(cam.zoom - expected.zoom)).toBeLessThan(1e-3);
      expect(cam.bearing).toBeCloseTo(expected.bearing, 6);
      expect(cam.pitch).toBeCloseTo(expected.pitch, 9);
    }
  });

  it('continuity invariant: smooth across every span boundary (no jumps)', () => {
    const { timeline } = threeClipPointTimeline({
      default_entry_transition: { duration_ms: 600, entry_bias: 0 },
    });
    const viewport: Viewport = { width: 1024, height: 1024, dpr: 1 };
    const eps = 0.5; // half a millisecond — well below any STEP_MS

    // Collect every distinct boundary t in the timeline.
    const boundaries = new Set<number>();
    for (const s of timeline.clipSpans) {
      boundaries.add(s.startMs);
      boundaries.add(s.endMs);
    }
    for (const s of timeline.transitionSpans) {
      if (s.effectiveDurationMs <= 0) continue;
      boundaries.add(s.startMs);
      boundaries.add(s.endMs);
    }

    for (const t of boundaries) {
      // Skip 0 (no t-eps neighborhood) and totalDurationMs (clamp boundary).
      if (t <= 0 || t >= timeline.totalDurationMs) continue;
      const before = resolveIntent(cameraAt(timeline, t - eps), viewport);
      const after = resolveIntent(cameraAt(timeline, t + eps), viewport);
      // 1e-3 tolerance: ½-ms steps near the boundary, so easeInOut should
      // not move the camera measurably. Tighter would catch float drift;
      // looser would miss real seams.
      expect(Math.abs(before.center.lng - after.center.lng)).toBeLessThan(1e-3);
      expect(Math.abs(before.center.lat - after.center.lat)).toBeLessThan(1e-3);
      expect(Math.abs(before.zoom - after.zoom)).toBeLessThan(1e-3);
      expect(Math.abs(before.bearing - after.bearing)).toBeLessThan(1e-3);
      expect(Math.abs(before.pitch - after.pitch)).toBeLessThan(1e-3);
    }
  });

  it('purity: same (timeline, t) produces deeply-equal output', () => {
    const { timeline } = threeClipPointTimeline({
      default_entry_transition: { duration_ms: 600, entry_bias: 0 },
    });
    for (const t of [0, 5_000, 10_300, 15_500, 20_000, 25_000]) {
      const a = cameraAt(timeline, t);
      const b = cameraAt(timeline, t);
      expect(a).toEqual(b);
    }
  });

  it('mid-transition: returns a point intent strictly between the boundary cameras', () => {
    const { timeline } = threeClipPointTimeline({
      default_entry_transition: { duration_ms: 600, entry_bias: 0 },
    });
    // Mid of the a→b transition (transitionSpans[1]).
    const tspan = timeline.transitionSpans[1];
    expect(tspan.fromClipId).toBe('a');
    expect(tspan.toClipId).toBe('b');
    const midT = (tspan.startMs + tspan.endMs) / 2;
    const intent = cameraAt(timeline, midT);
    expect(intent.kind).toBe('point');
    if (intent.kind === 'point') {
      // Point a is at (-122.40, 37.77); b at (-122.35, 37.80). Mid-arc
      // sits between in lng/lat (Van Wijk's u-fraction at eased=0.5 is
      // strictly in (0, 1)).
      expect(intent.center.lng).toBeGreaterThan(-122.40);
      expect(intent.center.lng).toBeLessThan(-122.35);
      expect(intent.center.lat).toBeGreaterThan(37.77);
      expect(intent.center.lat).toBeLessThan(37.80);
    }
  });

  it('disabled transition: zero-length window falls through to clip span intent', () => {
    const clips = [
      compilerClip({ id: 'a', trim: { in_ms: 0, out_ms: TEN_S } }),
      compilerClip({
        id: 'b',
        created_at: '2026-04-04T15:00:30Z',
        gps: { lat: 37.80, lng: -122.35 },
        trim: { in_ms: 0, out_ms: TEN_S },
        entry_transition: { enabled: false },
      }),
    ];
    const timeline = compileTimeline(clips, null, COMPILER_POINT_SETTINGS, {});
    const tspan = timeline.transitionSpans[1];
    expect(tspan.effectiveDurationMs).toBe(0);
    // At the cut t, the disabled span is skipped and clip B's span owns t.
    const intent = cameraAt(timeline, tspan.startMs);
    const bSpan = timeline.clipSpans[1];
    expect(intent).toBe(bSpan.intent);
  });

  it('continuity invariant: cameraAt(clipSpan.startMs) and cameraAt(clipSpan.endMs) match the clip canonical', () => {
    // Pick a setup where transitions don't extend into the clip span (use
    // tiny authored durations + bias=-1 so transitions sit purely pre-cut).
    const { timeline } = threeClipPointTimeline({
      default_entry_transition: { duration_ms: 200, entry_bias: -1 },
    });
    const viewport: Viewport = { width: 1024, height: 1024, dpr: 1 };

    for (const span of timeline.clipSpans) {
      const expected = resolveIntent(span.intent, viewport);

      // span.startMs may sit at the previous transition's endMs (for
      // bias=-1, transition ends at cut == span.startMs). The transition
      // span's endMs is still INCLUSIVE in our routing, so cameraAt at
      // span.startMs may return the transition's localT=1 sample (=
      // canonical for THIS clip). Either way, the resolved camera matches.
      const startCam = resolveIntent(cameraAt(timeline, span.startMs), viewport);
      expect(startCam.center.lng).toBeCloseTo(expected.center.lng, 6);
      expect(startCam.center.lat).toBeCloseTo(expected.center.lat, 6);
      expect(Math.abs(startCam.zoom - expected.zoom)).toBeLessThan(1e-3);

      // span.endMs (last span uses inclusive right). For non-last spans,
      // span.endMs == next span.startMs which goes to the next clip — skip.
      const isLast = span === timeline.clipSpans[timeline.clipSpans.length - 1];
      if (isLast) {
        const endCam = resolveIntent(cameraAt(timeline, span.endMs), viewport);
        expect(endCam.center.lng).toBeCloseTo(expected.center.lng, 6);
        expect(endCam.center.lat).toBeCloseTo(expected.center.lat, 6);
        expect(Math.abs(endCam.zoom - expected.zoom)).toBeLessThan(1e-3);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// activeClipIdAt — task 560.
//
// Identifies which clip is "active" for UI highlighting at a given project-
// time. Mirrors `cameraAt` routing: transitions win at the seam so the
// destination clip is highlighted the moment project-time enters the
// transition window.
// ---------------------------------------------------------------------------

describe('activeClipIdAt(timeline, t)', () => {
  it('empty timeline: returns null at any t', () => {
    const tl = compileTimeline([], null, DEFAULT_MAP_SETTINGS, {});
    expect(activeClipIdAt(tl, -1)).toBeNull();
    expect(activeClipIdAt(tl, 0)).toBeNull();
    expect(activeClipIdAt(tl, 5_000)).toBeNull();
  });

  it('out of range: t < 0 and t > totalDurationMs return null', () => {
    const { timeline } = threeClipPointTimeline();
    expect(activeClipIdAt(timeline, -1)).toBeNull();
    expect(activeClipIdAt(timeline, timeline.totalDurationMs + 1)).toBeNull();
  });

  it('inside a clip span: returns that clip id', () => {
    const { timeline } = threeClipPointTimeline();
    for (const span of timeline.clipSpans) {
      // Strict middle of the clip — past any post-cut transition overrun.
      const midT = (span.startMs + span.endMs) / 2;
      expect(activeClipIdAt(timeline, midT)).toBe(span.clipId);
    }
  });

  it('post-cut window of a transition span: returns the destination clip id', () => {
    // Force a non-zero transition span by authoring a duration on every clip.
    const { timeline } = threeClipPointTimeline({
      default_entry_transition: { duration_ms: 600, entry_bias: 0 },
    });
    // The clip-1 transition starts at project-time 0 (no pre-cut available
    // for the first clip), so probe a later transition where entryBias=0
    // splits the window across the cut. With entry_bias=0 the cut sits at
    // the midpoint, and `(startMs + endMs) / 2 == cutMs`, where the active
    // clip flips to the destination.
    const midTransition = timeline.transitionSpans.find(
      (ts) => ts.fromClipId !== null && ts.effectiveDurationMs > 0,
    );
    expect(midTransition).toBeDefined();
    if (midTransition) {
      // Probe strictly after the cut so we're unambiguously in the post-cut
      // half (the cut itself is the flip threshold).
      const postCutT =
        midTransition.cutMs + (midTransition.endMs - midTransition.cutMs) * 0.5;
      expect(activeClipIdAt(timeline, postCutT)).toBe(midTransition.toClipId);
    }
  });

  it('pre-cut window of a transition span: source clip stays active', () => {
    // A non-zero transition straddling a cut means project-time before the
    // cut sits inside both the previous clip span (closed-right at endMs)
    // and the transition span. The pre-cut half belongs to the source clip
    // (its media is still playing), so active should remain on fromClipId.
    const { timeline } = threeClipPointTimeline({
      default_entry_transition: { duration_ms: 600, entry_bias: 0 },
    });
    const transition = timeline.transitionSpans.find(
      (ts) => ts.fromClipId !== null && ts.effectiveDurationMs > 0,
    );
    expect(transition).toBeDefined();
    if (transition) {
      const beforeCut =
        transition.startMs +
        (transition.cutMs - transition.startMs) * 0.5;
      // Sanity: must be inside the previous clip span and inside the
      // transition window.
      const prevSpan = timeline.clipSpans.find(
        (s) => s.clipId === transition.fromClipId,
      )!;
      expect(beforeCut).toBeGreaterThan(prevSpan.startMs);
      expect(beforeCut).toBeLessThan(prevSpan.endMs);
      expect(beforeCut).toBeGreaterThan(transition.startMs);
      expect(beforeCut).toBeLessThan(transition.cutMs);
      // Source clip stays active during pre-cut.
      expect(activeClipIdAt(timeline, beforeCut)).toBe(transition.fromClipId);
    }
  });

  it('flip happens at cutMs: t = startMs+1 → fromClipId, t = cutMs → toClipId', () => {
    const { timeline } = threeClipPointTimeline({
      default_entry_transition: { duration_ms: 600, entry_bias: 0 },
    });
    const transition = timeline.transitionSpans.find(
      (ts) => ts.fromClipId !== null && ts.effectiveDurationMs > 0,
    );
    expect(transition).toBeDefined();
    if (transition) {
      expect(activeClipIdAt(timeline, transition.startMs + 1)).toBe(
        transition.fromClipId,
      );
      expect(activeClipIdAt(timeline, transition.cutMs)).toBe(
        transition.toClipId,
      );
    }
  });

  it('zero-duration transitions are ignored: clip-span lookup wins at the seam', () => {
    // Default settings produce auto-derived transition durations on the
    // three-clip point timeline. Override with explicit-disabled transitions
    // so the only routing left is clip-span lookup.
    const settings: CompileTimelineProjectSettings = {
      default_entry_transition: { enabled: false },
    };
    const { timeline } = threeClipPointTimeline(settings);
    // At each clip's startMs (== previous clip's endMs for clips 2+), the
    // half-open clip-span policy means the next clip wins.
    for (let i = 1; i < timeline.clipSpans.length; i++) {
      const span = timeline.clipSpans[i];
      expect(activeClipIdAt(timeline, span.startMs)).toBe(span.clipId);
    }
  });

  it('boundary at totalDurationMs: returns the last clip id', () => {
    const { timeline } = threeClipPointTimeline();
    const last = timeline.clipSpans[timeline.clipSpans.length - 1];
    expect(activeClipIdAt(timeline, timeline.totalDurationMs)).toBe(
      last.clipId,
    );
  });
});
