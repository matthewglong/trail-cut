// Tests for the project-time-driven `pulseAt` animation. Pure-function tests
// covering boundary, periodicity, monotonicity within a period, negative-t
// safety, and end-of-period values. The export worker and preview both rely
// on this being deterministic at any sampled t.

import { describe, it, expect } from 'vitest';
import { pulseAt, pulseAtScaled, PULSE_PERIOD_MS } from '../animations';
import { PAINT_SIZE_FRACTIONS } from '../styleSpec';

const FLOAT_EPS = 1e-9;
const START_R = PAINT_SIZE_FRACTIONS.pulseStartRadius * 1080;
const END_R = PAINT_SIZE_FRACTIONS.pulseEndRadius * 1080;

describe('pulseAt', () => {
  it('boundary at t=0: radius=pulseStartRadius × PAINT_REFERENCE_WIDTH and opacity=0.55', () => {
    const v = pulseAt(0);
    expect(Math.abs(v.radius - START_R)).toBeLessThan(FLOAT_EPS);
    expect(Math.abs(v.opacity - 0.55)).toBeLessThan(FLOAT_EPS);
  });

  it('periodicity: pulseAt(t) === pulseAt(t + PULSE_PERIOD_MS) for several t', () => {
    for (const t of [0, 100, 800, 1599, 12345]) {
      const a = pulseAt(t);
      const b = pulseAt(t + PULSE_PERIOD_MS);
      expect(Math.abs(a.radius - b.radius)).toBeLessThan(FLOAT_EPS);
      expect(Math.abs(a.opacity - b.opacity)).toBeLessThan(FLOAT_EPS);
    }
  });

  it('radius is monotonically non-decreasing across one period', () => {
    const N = 50;
    let prev = -Infinity;
    for (let i = 0; i < N; i++) {
      const t = (i / N) * PULSE_PERIOD_MS;
      const r = pulseAt(t).radius;
      expect(r).toBeGreaterThanOrEqual(prev - FLOAT_EPS);
      prev = r;
    }
  });

  it('opacity is monotonically non-increasing across one period', () => {
    const N = 50;
    let prev = Infinity;
    for (let i = 0; i < N; i++) {
      const t = (i / N) * PULSE_PERIOD_MS;
      const o = pulseAt(t).opacity;
      expect(o).toBeLessThanOrEqual(prev + FLOAT_EPS);
      prev = o;
    }
  });

  it('negative t: pulseAt(-100) matches pulseAt(PULSE_PERIOD_MS - 100) and stays in valid range', () => {
    const a = pulseAt(-100);
    const b = pulseAt(PULSE_PERIOD_MS - 100);
    expect(Math.abs(a.radius - b.radius)).toBeLessThan(FLOAT_EPS);
    expect(Math.abs(a.opacity - b.opacity)).toBeLessThan(FLOAT_EPS);
    // Range check (radius bounded by start and end fractions × PAINT_REFERENCE_WIDTH).
    expect(a.radius).toBeGreaterThanOrEqual(START_R - FLOAT_EPS);
    expect(a.radius).toBeLessThanOrEqual(END_R + FLOAT_EPS);
    expect(a.opacity).toBeGreaterThanOrEqual(0);
    expect(a.opacity).toBeLessThanOrEqual(0.55);
  });

  it('end of period: t = PULSE_PERIOD_MS - 0.001 → radius ≈ pulseEndRadius × 1080, opacity ≈ 0', () => {
    const v = pulseAt(PULSE_PERIOD_MS - 0.001);
    expect(Math.abs(v.radius - END_R)).toBeLessThan(0.01);
    expect(v.opacity).toBeLessThan(0.01);
  });
});

describe('pulseAtScaled', () => {
  // Preview composition: scaled reference width drives radius linearly,
  // opacity is invariant.
  it('boundary at t=0 with width 540: radius=pulseStartRadius × 540', () => {
    const v = pulseAtScaled(0, 540);
    expect(Math.abs(v.radius - PAINT_SIZE_FRACTIONS.pulseStartRadius * 540)).toBeLessThan(
      FLOAT_EPS,
    );
    expect(Math.abs(v.opacity - 0.55)).toBeLessThan(FLOAT_EPS);
  });

  it('scales linearly with the scaledRefWidth argument', () => {
    const a = pulseAtScaled(400, 1080);
    const b = pulseAtScaled(400, 540);
    expect(b.radius).toBeCloseTo(a.radius * 0.5, 9);
    // Opacity is width-independent.
    expect(b.opacity).toBeCloseTo(a.opacity, 9);
  });

  it('at scaledRefWidth=1080 matches pulseAt() exactly', () => {
    for (const t of [0, 250, 800, 1599]) {
      const a = pulseAt(t);
      const b = pulseAtScaled(t, 1080);
      expect(Math.abs(a.radius - b.radius)).toBeLessThan(FLOAT_EPS);
      expect(Math.abs(a.opacity - b.opacity)).toBeLessThan(FLOAT_EPS);
    }
  });
});
