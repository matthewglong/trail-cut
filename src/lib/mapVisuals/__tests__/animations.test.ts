// Tests for the project-time-driven `pulseAt` animation. Pure-function tests
// covering boundary, periodicity, monotonicity within a period, negative-t
// safety, and end-of-period values. The export worker and preview both rely
// on this being deterministic at any sampled t.

import { describe, it, expect } from 'vitest';
import { pulseAt, PULSE_PERIOD_MS } from '../animations';
import { PAINT_REFERENCE_WIDTH } from '../styleSpec';
import { DEFAULT_MAP_SETTINGS } from '../../../types';

const FLOAT_EPS = 1e-9;
const START_R =
  DEFAULT_MAP_SETTINGS.overlay_pulse_start_radius * PAINT_REFERENCE_WIDTH;
const END_R =
  DEFAULT_MAP_SETTINGS.overlay_pulse_end_radius * PAINT_REFERENCE_WIDTH;

describe('pulseAt', () => {
  it('boundary at t=0: radius=overlay_pulse_start_radius × PAINT_REFERENCE_WIDTH and opacity=0.55', () => {
    const v = pulseAt(0, DEFAULT_MAP_SETTINGS);
    expect(Math.abs(v.radius - START_R)).toBeLessThan(FLOAT_EPS);
    expect(Math.abs(v.opacity - 0.55)).toBeLessThan(FLOAT_EPS);
  });

  it('periodicity: pulseAt(t) === pulseAt(t + PULSE_PERIOD_MS) for several t', () => {
    for (const t of [0, 100, 800, 1599, 12345]) {
      const a = pulseAt(t, DEFAULT_MAP_SETTINGS);
      const b = pulseAt(t + PULSE_PERIOD_MS, DEFAULT_MAP_SETTINGS);
      expect(Math.abs(a.radius - b.radius)).toBeLessThan(FLOAT_EPS);
      expect(Math.abs(a.opacity - b.opacity)).toBeLessThan(FLOAT_EPS);
    }
  });

  it('radius is monotonically non-decreasing across one period', () => {
    const N = 50;
    let prev = -Infinity;
    for (let i = 0; i < N; i++) {
      const t = (i / N) * PULSE_PERIOD_MS;
      const r = pulseAt(t, DEFAULT_MAP_SETTINGS).radius;
      expect(r).toBeGreaterThanOrEqual(prev - FLOAT_EPS);
      prev = r;
    }
  });

  it('opacity is monotonically non-increasing across one period', () => {
    const N = 50;
    let prev = Infinity;
    for (let i = 0; i < N; i++) {
      const t = (i / N) * PULSE_PERIOD_MS;
      const o = pulseAt(t, DEFAULT_MAP_SETTINGS).opacity;
      expect(o).toBeLessThanOrEqual(prev + FLOAT_EPS);
      prev = o;
    }
  });

  it('negative t: pulseAt(-100) matches pulseAt(PULSE_PERIOD_MS - 100) and stays in valid range', () => {
    const a = pulseAt(-100, DEFAULT_MAP_SETTINGS);
    const b = pulseAt(PULSE_PERIOD_MS - 100, DEFAULT_MAP_SETTINGS);
    expect(Math.abs(a.radius - b.radius)).toBeLessThan(FLOAT_EPS);
    expect(Math.abs(a.opacity - b.opacity)).toBeLessThan(FLOAT_EPS);
    // Range check (radius bounded by start and end fractions × PAINT_REFERENCE_WIDTH).
    expect(a.radius).toBeGreaterThanOrEqual(START_R - FLOAT_EPS);
    expect(a.radius).toBeLessThanOrEqual(END_R + FLOAT_EPS);
    expect(a.opacity).toBeGreaterThanOrEqual(0);
    expect(a.opacity).toBeLessThanOrEqual(0.55);
  });

  it('end of period: t = PULSE_PERIOD_MS - 0.001 → radius ≈ overlay_pulse_end_radius × 1080, opacity ≈ 0', () => {
    const v = pulseAt(PULSE_PERIOD_MS - 0.001, DEFAULT_MAP_SETTINGS);
    expect(Math.abs(v.radius - END_R)).toBeLessThan(0.01);
    expect(v.opacity).toBeLessThan(0.01);
  });

  it('overridden pulse radii: a clip override changes only that clip\'s pulse', () => {
    // Per-clip override flow: the resolved MapSettings for the active clip
    // carries an enlarged pulse end radius; pulseAt picks it up directly.
    const wide = {
      ...DEFAULT_MAP_SETTINGS,
      overlay_pulse_start_radius: 0.03,
      overlay_pulse_end_radius: 0.08,
    };
    const v = pulseAt(0, wide);
    expect(v.radius).toBeCloseTo(0.03 * PAINT_REFERENCE_WIDTH, 9);
    // At t=0 only start radius matters; end radius gates the bound check.
    const end = pulseAt(PULSE_PERIOD_MS - 0.001, wide);
    expect(end.radius).toBeCloseTo(0.08 * PAINT_REFERENCE_WIDTH, 1);
  });
});
