// Unit tests for the pure geometric helpers in `cameraIntent.ts`.
// Scope is intentionally narrow: this file covers the math added in
// migration task 100 (§5.2 of MAP_ARCHITECTURE_MIGRATION.md) — i.e. the
// `cameraForBounds` Web-Mercator port. Tests for `cameraAt`,
// `resolveIntent`, `vanWijkArc`, etc. land in tasks 110/120/130.

import { describe, it, expect } from 'vitest';
import {
  cameraForBounds,
  vanWijkArc,
  vanWijkSample,
  arcDurationMs,
} from './cameraIntent';
import type { Bounds, Viewport, ResolvedCamera } from './cameraIntent';

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
    // padding=0 in a 1024² viewport, computed directly from §5.2 (world
    // size 512px). Cross-checked once by hand:
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
// Van Wijk arc primitives — task 110.
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
