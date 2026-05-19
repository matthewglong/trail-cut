// Tests for the project-time-driven pulse animations.

import { describe, it, expect } from 'vitest';
import {
  pulseAt,
  pulsePairAt,
  PULSE_PERIOD_MS,
  PULSE_RATE_MS,
} from '../animations';
import { PAINT_REFERENCE_WIDTH } from '../styleSpec';
import { DEFAULT_MAP_SETTINGS, type MapSettings } from '../../../types';

const FLOAT_EPS = 1e-9;
const START_R =
  DEFAULT_MAP_SETTINGS.pov.size.pulse_start_radius * PAINT_REFERENCE_WIDTH;
const END_R =
  DEFAULT_MAP_SETTINGS.pov.size.pulse_end_radius * PAINT_REFERENCE_WIDTH;
const SONAR_MEDIUM: MapSettings = DEFAULT_MAP_SETTINGS;

describe('pulseAt (sonar style)', () => {
  it('boundary at t=0: radius=start, opacity=0.55, dotOpacity=1', () => {
    const v = pulseAt(0, SONAR_MEDIUM);
    expect(Math.abs(v.radius - START_R)).toBeLessThan(FLOAT_EPS);
    expect(Math.abs(v.opacity - 0.55)).toBeLessThan(FLOAT_EPS);
    expect(v.dotOpacity).toBe(1);
  });

  it('dotOpacity is constant 1 across one period (sonar does not throb)', () => {
    for (let i = 0; i < 20; i++) {
      const t = (i / 20) * PULSE_PERIOD_MS;
      expect(pulseAt(t, SONAR_MEDIUM).dotOpacity).toBe(1);
    }
  });

  it('periodicity: pulseAt(t) === pulseAt(t + PULSE_PERIOD_MS)', () => {
    for (const t of [0, 100, 800, 1599, 12345]) {
      const a = pulseAt(t, SONAR_MEDIUM);
      const b = pulseAt(t + PULSE_PERIOD_MS, SONAR_MEDIUM);
      expect(Math.abs(a.radius - b.radius)).toBeLessThan(FLOAT_EPS);
      expect(Math.abs(a.opacity - b.opacity)).toBeLessThan(FLOAT_EPS);
    }
  });

  it('radius is monotonically non-decreasing across one period', () => {
    let prev = -Infinity;
    for (let i = 0; i < 50; i++) {
      const t = (i / 50) * PULSE_PERIOD_MS;
      const r = pulseAt(t, SONAR_MEDIUM).radius;
      expect(r).toBeGreaterThanOrEqual(prev - FLOAT_EPS);
      prev = r;
    }
  });

  it('opacity is monotonically non-increasing across one period', () => {
    let prev = Infinity;
    for (let i = 0; i < 50; i++) {
      const t = (i / 50) * PULSE_PERIOD_MS;
      const o = pulseAt(t, SONAR_MEDIUM).opacity;
      expect(o).toBeLessThanOrEqual(prev + FLOAT_EPS);
      prev = o;
    }
  });

  it('negative t wraps through the period', () => {
    const a = pulseAt(-100, SONAR_MEDIUM);
    const b = pulseAt(PULSE_PERIOD_MS - 100, SONAR_MEDIUM);
    expect(Math.abs(a.radius - b.radius)).toBeLessThan(FLOAT_EPS);
    expect(Math.abs(a.opacity - b.opacity)).toBeLessThan(FLOAT_EPS);
    expect(a.radius).toBeGreaterThanOrEqual(START_R - FLOAT_EPS);
    expect(a.radius).toBeLessThanOrEqual(END_R + FLOAT_EPS);
    expect(a.opacity).toBeGreaterThanOrEqual(0);
    expect(a.opacity).toBeLessThanOrEqual(0.55);
  });

  it('end of period: radius approaches end, opacity approaches 0', () => {
    const v = pulseAt(PULSE_PERIOD_MS - 0.001, SONAR_MEDIUM);
    expect(Math.abs(v.radius - END_R)).toBeLessThan(0.01);
    expect(v.opacity).toBeLessThan(0.01);
  });

  it('per-clip pulse-radius override flows through', () => {
    const wide: MapSettings = {
      ...SONAR_MEDIUM,
      pov: {
        ...SONAR_MEDIUM.pov,
        size: {
          ...SONAR_MEDIUM.pov.size,
          pulse_start_radius: 0.03,
          pulse_end_radius: 0.08,
        },
      },
    };
    const v = pulseAt(0, wide);
    expect(v.radius).toBeCloseTo(0.03 * PAINT_REFERENCE_WIDTH, 9);
    const end = pulseAt(PULSE_PERIOD_MS - 0.001, wide);
    expect(end.radius).toBeCloseTo(0.08 * PAINT_REFERENCE_WIDTH, 1);
  });
});

describe('PULSE_RATE_MS lookup', () => {
  it('matches the documented rate buckets', () => {
    expect(PULSE_RATE_MS.fast).toBe(800);
    expect(PULSE_RATE_MS.medium).toBe(1600);
    expect(PULSE_RATE_MS.slow).toBe(2400);
  });

  it('PULSE_PERIOD_MS aliases the medium bucket', () => {
    expect(PULSE_PERIOD_MS).toBe(PULSE_RATE_MS.medium);
  });
});

describe('pulse_rate periodicity', () => {
  it('fast rate (800ms) periodicity', () => {
    const fast: MapSettings = {
      ...SONAR_MEDIUM,
      pov: { ...SONAR_MEDIUM.pov, pulse_rate: 'fast' },
    };
    for (const t of [0, 100, 500]) {
      const a = pulsePairAt(t, fast);
      const b = pulsePairAt(t + PULSE_RATE_MS.fast, fast);
      expect(a.a.radius).toBeCloseTo(b.a.radius, 9);
      expect(a.a.opacity).toBeCloseTo(b.a.opacity, 9);
    }
  });

  it('slow rate (2400ms) periodicity', () => {
    const slow: MapSettings = {
      ...SONAR_MEDIUM,
      pov: { ...SONAR_MEDIUM.pov, pulse_rate: 'slow' },
    };
    for (const t of [0, 100, 1500]) {
      const a = pulsePairAt(t, slow);
      const b = pulsePairAt(t + PULSE_RATE_MS.slow, slow);
      expect(a.a.radius).toBeCloseTo(b.a.radius, 9);
      expect(a.a.opacity).toBeCloseTo(b.a.opacity, 9);
    }
  });
});

describe('pulsePairAt — steady', () => {
  const steady: MapSettings = {
    ...SONAR_MEDIUM,
    pov: { ...SONAR_MEDIUM.pov, pulse_style: 'steady' },
  };

  it('both rings invisible across the whole period', () => {
    for (const t of [0, 400, 800, 1200, 1599]) {
      const v = pulsePairAt(t, steady);
      expect(v.a.opacity).toBe(0);
      expect(v.b.opacity).toBe(0);
    }
  });

  it('dotOpacity held at 1 across the whole period (steady = dot is the constant)', () => {
    for (const t of [0, 400, 800, 1200, 1599]) {
      const v = pulsePairAt(t, steady);
      expect(v.a.dotOpacity).toBe(1);
      expect(v.b.dotOpacity).toBe(1);
    }
  });
});

describe('pulsePairAt — sonar', () => {
  // Sonar was previously only exercised via the pulseAt shim above (which
  // happens to use DEFAULT_MAP_SETTINGS = sonar). This block exists so a
  // future MapSettings default change can't silently drop sonar coverage,
  // and to lock in the dotOpacity / B-ring contract on the canonical path.
  const sonar: MapSettings = {
    ...SONAR_MEDIUM,
    pov: { ...SONAR_MEDIUM.pov, pulse_style: 'sonar' },
  };

  it('boundary at t=0: A-ring starts at start radius / opacity 0.55', () => {
    const v = pulsePairAt(0, sonar);
    expect(v.a.radius).toBeCloseTo(START_R, 9);
    expect(v.a.opacity).toBeCloseTo(0.55, 9);
  });

  it('end of period: A-ring radius -> end, opacity -> 0', () => {
    const v = pulsePairAt(PULSE_PERIOD_MS - 0.001, sonar);
    expect(v.a.radius).toBeCloseTo(END_R, 1);
    expect(v.a.opacity).toBeLessThan(0.01);
  });

  it('ring B held invisible in sonar mode', () => {
    for (const t of [0, 400, 800, 1599]) {
      expect(pulsePairAt(t, sonar).b.opacity).toBe(0);
    }
  });

  it('dotOpacity held at 1 across the whole period', () => {
    for (const t of [0, 400, 800, 1200, 1599]) {
      const v = pulsePairAt(t, sonar);
      expect(v.a.dotOpacity).toBe(1);
      expect(v.b.dotOpacity).toBe(1);
    }
  });
});

describe('pulsePairAt — throb', () => {
  const throb: MapSettings = {
    ...SONAR_MEDIUM,
    pov: { ...SONAR_MEDIUM.pov, pulse_style: 'throb' },
  };

  it('outer ring is hidden in throb (A ring zeroed; B ring opacity 0)', () => {
    // The A ring is the animated outer ring; in throb mode it's collapsed
    // to radius/opacity 0 since throb expresses itself entirely on the
    // dot. The B ring (always-seeded for the heartbeat style) stays at
    // its idle non-heartbeat values — invisible via opacity=0 alone.
    for (const t of [0, 200, 400, 800, 1200, 1599]) {
      const v = pulsePairAt(t, throb);
      expect(v.a.radius).toBe(0);
      expect(v.a.opacity).toBe(0);
      expect(v.b.opacity).toBe(0);
    }
  });

  it('dotOpacity at t=0 is the sine-wave mean (0.675)', () => {
    // mean = (0.35 + 1.0) / 2 = 0.675, sin(0) = 0 → dotOpacity = mean.
    const v = pulsePairAt(0, throb);
    expect(v.a.dotOpacity).toBeCloseTo(0.675, 9);
  });

  it('dotOpacity peaks at 1.0 at phase 0.25 (sin(π/2) = 1)', () => {
    const v = pulsePairAt(PULSE_PERIOD_MS * 0.25, throb);
    expect(v.a.dotOpacity).toBeCloseTo(1, 9);
  });

  it('dotOpacity bottoms at 0.35 at phase 0.75 (sin(3π/2) = -1)', () => {
    const v = pulsePairAt(PULSE_PERIOD_MS * 0.75, throb);
    expect(v.a.dotOpacity).toBeCloseTo(0.35, 9);
  });

  it('dotOpacity stays within [0.35, 1.0] across the period', () => {
    for (let i = 0; i < 100; i++) {
      const t = (i / 100) * PULSE_PERIOD_MS;
      const v = pulsePairAt(t, throb);
      expect(v.a.dotOpacity).toBeGreaterThanOrEqual(0.35 - FLOAT_EPS);
      expect(v.a.dotOpacity).toBeLessThanOrEqual(1 + FLOAT_EPS);
    }
  });

  it('sine-wave symmetry: throbAt(t) and throbAt(period/2 - t) match', () => {
    // sin(2π·p) = sin(π - 2π·p) = sin(2π·(0.5 - p)) — so dotOpacity is
    // symmetric about phase 0.25 across the brightening half of the cycle.
    // This locks in the sine vs ease-out distinction the spec calls out.
    for (const p of [0.05, 0.1, 0.15, 0.2]) {
      const t1 = p * PULSE_PERIOD_MS;
      const t2 = (0.5 - p) * PULSE_PERIOD_MS;
      const v1 = pulsePairAt(t1, throb);
      const v2 = pulsePairAt(t2, throb);
      expect(v1.a.dotOpacity).toBeCloseTo(v2.a.dotOpacity, 9);
    }
  });

  it('b.dotOpacity mirrors a.dotOpacity (single dot layer)', () => {
    for (const t of [0, 200, 800, 1200, 1599]) {
      const v = pulsePairAt(t, throb);
      expect(v.b.dotOpacity).toBeCloseTo(v.a.dotOpacity, 9);
    }
  });
});

describe('pulsePairAt — heartbeat', () => {
  const hb: MapSettings = {
    ...SONAR_MEDIUM,
    pov: { ...SONAR_MEDIUM.pov, pulse_style: 'heartbeat' },
  };

  it('at t=0 ring A starts firing, ring B has not started yet', () => {
    const v = pulsePairAt(0, hb);
    expect(v.a.radius).toBeCloseTo(START_R, 9);
    expect(v.a.opacity).toBeCloseTo(0.55, 9);
    expect(v.b.opacity).toBe(0);
  });

  it('past the B-offset (~25%), ring B has started', () => {
    const t = PULSE_PERIOD_MS * 0.25 + 1;
    const v = pulsePairAt(t, hb);
    expect(v.b.opacity).toBeGreaterThan(0);
    expect(v.a.opacity).toBeGreaterThan(0);
  });

  it('past active window (~85%), both rings quiescent', () => {
    const t = PULSE_PERIOD_MS * 0.85;
    const v = pulsePairAt(t, hb);
    expect(v.a.opacity).toBe(0);
    expect(v.b.opacity).toBe(0);
  });

  it('full period equality', () => {
    const a = pulsePairAt(0, hb);
    const b = pulsePairAt(PULSE_PERIOD_MS, hb);
    expect(a.a.radius).toBeCloseTo(b.a.radius, 6);
    expect(a.a.opacity).toBeCloseTo(b.a.opacity, 6);
    expect(a.b.radius).toBeCloseTo(b.b.radius, 6);
    expect(a.b.opacity).toBeCloseTo(b.b.opacity, 6);
  });

  it('dotOpacity held at 1 across the whole period (heartbeat is on rings, not the dot)', () => {
    for (const t of [0, 200, 400, 800, 1200, 1599]) {
      const v = pulsePairAt(t, hb);
      expect(v.a.dotOpacity).toBe(1);
      expect(v.b.dotOpacity).toBe(1);
    }
  });
});

describe('pulsePairAt — purity', () => {
  it('same inputs produce same outputs', () => {
    for (const style of ['steady', 'throb', 'sonar', 'heartbeat'] as const) {
      const settings: MapSettings = {
        ...SONAR_MEDIUM,
        pov: { ...SONAR_MEDIUM.pov, pulse_style: style },
      };
      for (const t of [0, 123, 800, 1234, 1599]) {
        expect(pulsePairAt(t, settings)).toEqual(pulsePairAt(t, settings));
      }
    }
  });
});
