// Tests for the project-time-driven `pulseAt` animation. Pure-function tests
// covering boundary, periodicity, monotonicity within a period, negative-t
// safety, and end-of-period values. The export worker and preview both rely
// on this being deterministic at any sampled t.

import { describe, it, expect } from 'vitest';
import { pulseAt, PULSE_PERIOD_MS } from '../animations';

const FLOAT_EPS = 1e-9;

describe('pulseAt', () => {
  it('boundary at t=0: radius=8 and opacity=0.55', () => {
    const v = pulseAt(0);
    expect(Math.abs(v.radius - 8)).toBeLessThan(FLOAT_EPS);
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
    // Range check.
    expect(a.radius).toBeGreaterThanOrEqual(8);
    expect(a.radius).toBeLessThanOrEqual(22);
    expect(a.opacity).toBeGreaterThanOrEqual(0);
    expect(a.opacity).toBeLessThanOrEqual(0.55);
  });

  it('end of period: t = PULSE_PERIOD_MS - 0.001 → radius ≈ 22, opacity ≈ 0', () => {
    const v = pulseAt(PULSE_PERIOD_MS - 0.001);
    expect(Math.abs(v.radius - 22)).toBeLessThan(0.01);
    expect(v.opacity).toBeLessThan(0.01);
  });
});
