// Unit tests for the pure geometric helpers in `cameraIntent.ts`.
// Scope is intentionally narrow: this file covers the math added in
// migration task 100 (§5.2 of MAP_ARCHITECTURE_MIGRATION.md) — i.e. the
// `cameraForBounds` Web-Mercator port. Tests for `cameraAt`,
// `resolveIntent`, `vanWijkArc`, etc. land in tasks 110/120/130.

import { describe, it, expect } from 'vitest';
import { cameraForBounds } from './cameraIntent';
import type { Bounds, Viewport } from './cameraIntent';

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
