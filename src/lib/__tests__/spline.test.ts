// Pure-math tests for the clip-group spline evaluator (docs/CLIP_GROUPS_HANDOFF.md
// §2 "Spline evaluator", §7 "Spline").
//
// Pins: C⁰ + C¹ at every interior knot (finite-difference velocity from the left
// and right agree); Fritsch–Carlson monotonicity (change-then-hold never
// bounces); degenerate-segment finiteness (no NaN); n=2 straight glide; endpoint
// exactness + clamping; short-way bearing unwrap; centripetal shape sanity on
// a sharp doubling-back.

import { describe, it, expect } from 'vitest';
import {
  buildMonotoneSpline1D,
  evalSpline1D,
  buildCentripetalSpline2D,
  evalSpline2D,
  unwrapDegrees,
  wrapDegrees,
  type Spline1D,
  type Spline2D,
  type Vec2,
} from '../spline';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Second-order one-sided finite-difference derivative from the LEFT of t. */
function fdLeft(f: (t: number) => number, t: number, h: number): number {
  return (3 * f(t) - 4 * f(t - h) + f(t - 2 * h)) / (2 * h);
}

/** Second-order one-sided finite-difference derivative from the RIGHT of t. */
function fdRight(f: (t: number) => number, t: number, h: number): number {
  return (-3 * f(t) + 4 * f(t + h) - f(t + 2 * h)) / (2 * h);
}

function expectClose(a: number, b: number, rel: number, abs = 1e-9): void {
  const tol = abs + rel * Math.max(Math.abs(a), Math.abs(b));
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
}

/** Assert C⁰ and C¹ at every interior knot of a 1-D spline. */
function assertC1_1D(s: Spline1D): void {
  const f = (t: number) => evalSpline1D(s, t);
  for (let i = 1; i < s.knots.length - 1; i++) {
    const t = s.knots[i];
    const segW = Math.min(t - s.knots[i - 1], s.knots[i + 1] - t);
    const h = 1e-4 * segW;
    // C⁰: value at knot equals the knot value, and both limits approach it
    // (a step of h moves the curve by at most ~|velocity|·h).
    expect(f(t)).toBe(s.values[i]);
    const step = 10 * h * Math.max(1, Math.abs(s.tangents[i]));
    expect(Math.abs(f(t - h) - f(t))).toBeLessThanOrEqual(step);
    expect(Math.abs(f(t + h) - f(t))).toBeLessThanOrEqual(step);
    // C¹: left/right derivative agree (and equal the stored tangent).
    const vl = fdLeft(f, t, h);
    const vr = fdRight(f, t, h);
    expectClose(vl, vr, 1e-3, 1e-6);
    expectClose(vl, s.tangents[i], 1e-3, 1e-6);
  }
}

/** Assert C⁰ and C¹ at every interior knot of a 2-D spline. */
function assertC1_2D(s: Spline2D): void {
  const fx = (t: number) => evalSpline2D(s, t).x;
  const fy = (t: number) => evalSpline2D(s, t).y;
  for (let i = 1; i < s.knots.length - 1; i++) {
    const t = s.knots[i];
    const segW = Math.min(t - s.knots[i - 1], s.knots[i + 1] - t);
    const h = 1e-4 * segW;
    const p = evalSpline2D(s, t);
    expect(p).toEqual(s.points[i]);
    const stepX = 10 * h * Math.max(1, Math.abs(s.tangents[i].x));
    const stepY = 10 * h * Math.max(1, Math.abs(s.tangents[i].y));
    expect(Math.abs(fx(t - h) - p.x)).toBeLessThanOrEqual(stepX);
    expect(Math.abs(fx(t + h) - p.x)).toBeLessThanOrEqual(stepX);
    expect(Math.abs(fy(t - h) - p.y)).toBeLessThanOrEqual(stepY);
    expect(Math.abs(fy(t + h) - p.y)).toBeLessThanOrEqual(stepY);
    const vlx = fdLeft(fx, t, h);
    const vrx = fdRight(fx, t, h);
    const vly = fdLeft(fy, t, h);
    const vry = fdRight(fy, t, h);
    expectClose(vlx, vrx, 1e-3, 1e-6);
    expectClose(vly, vry, 1e-3, 1e-6);
    expectClose(vlx, s.tangents[i].x, 1e-3, 1e-6);
    expectClose(vly, s.tangents[i].y, 1e-3, 1e-6);
  }
}

function sweep<T>(knots: number[], steps: number, f: (t: number) => T): T[] {
  const t0 = knots[0];
  const t1 = knots[knots.length - 1];
  const out: T[] = [];
  for (let i = 0; i <= steps; i++) out.push(f(t0 + ((t1 - t0) * i) / steps));
  return out;
}

// ---------------------------------------------------------------------------
// 1-D: Fritsch–Carlson monotone Hermite
// ---------------------------------------------------------------------------

describe('buildMonotoneSpline1D / evalSpline1D', () => {
  it('is C⁰ and C¹ at every interior knot on non-uniform knots', () => {
    const s = buildMonotoneSpline1D([0, 1, 3.5, 4, 7, 7.25], [10, 14, 13, 13, 18, 12]);
    assertC1_1D(s);
  });

  it('change-then-hold never bounces or overshoots (Fritsch–Carlson)', () => {
    const s = buildMonotoneSpline1D([0, 1, 2, 3], [10, 14, 14, 14]);
    const vals = sweep(s.knots, 4000, (t) => evalSpline1D(s, t));
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThanOrEqual(14 + 1e-12);
    }
    // Holds exactly on the flat run.
    expect(evalSpline1D(s, 1.5)).toBe(14);
    expect(evalSpline1D(s, 2.7)).toBe(14);
    // Interior tangent at the change→hold knot is zero.
    expect(s.tangents[1]).toBe(0);
  });

  it('a monotone increasing series stays monotone across a dense sweep', () => {
    const s = buildMonotoneSpline1D([0, 0.5, 1, 4, 4.2, 9], [1, 2, 2.1, 30, 30.5, 31]);
    const vals = sweep(s.knots, 5000, (t) => evalSpline1D(s, t));
    for (let i = 1; i < vals.length; i++) {
      expect(vals[i]).toBeGreaterThanOrEqual(vals[i - 1] - 1e-12);
    }
    expect(vals[0]).toBe(1);
    expect(vals[vals.length - 1]).toBe(31);
  });

  it('a monotone decreasing series stays monotone across a dense sweep', () => {
    const s = buildMonotoneSpline1D([0, 1, 2, 3], [16, 12, 11.9, 4]);
    const vals = sweep(s.knots, 3000, (t) => evalSpline1D(s, t));
    for (let i = 1; i < vals.length; i++) {
      expect(vals[i]).toBeLessThanOrEqual(vals[i - 1] + 1e-12);
    }
  });

  it('local extrema in the data get zero tangents (no overshoot past a peak)', () => {
    const s = buildMonotoneSpline1D([0, 1, 2], [0, 10, 0]);
    expect(s.tangents[1]).toBe(0);
    const vals = sweep(s.knots, 2000, (t) => evalSpline1D(s, t));
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(10);
    }
  });

  it('n=1 is constant; n=2 is exactly linear', () => {
    const one = buildMonotoneSpline1D([5], [42]);
    expect(evalSpline1D(one, -100)).toBe(42);
    expect(evalSpline1D(one, 5)).toBe(42);
    expect(evalSpline1D(one, 100)).toBe(42);

    const two = buildMonotoneSpline1D([2, 6], [10, 30]);
    expect(evalSpline1D(two, 3)).toBeCloseTo(15, 9);
    expect(evalSpline1D(two, 4)).toBeCloseTo(20, 9);
    expect(evalSpline1D(two, 5)).toBeCloseTo(25, 9);
  });

  it('endpoints are exact and t outside the range clamps', () => {
    const s = buildMonotoneSpline1D([1, 2, 4], [7, 9, 3]);
    expect(evalSpline1D(s, 1)).toBe(7);
    expect(evalSpline1D(s, 4)).toBe(3);
    expect(evalSpline1D(s, -50)).toBe(7);
    expect(evalSpline1D(s, 50)).toBe(3);
  });

  it('equal adjacent knots produce finite outputs everywhere', () => {
    const s = buildMonotoneSpline1D([0, 1, 1, 2], [0, 5, 6, 8]);
    expect(s.tangents.every(Number.isFinite)).toBe(true);
    for (const t of [-1, 0, 0.5, 0.999, 1, 1.001, 1.5, 2, 3]) {
      expect(Number.isFinite(evalSpline1D(s, t))).toBe(true);
    }
    // At the doubled knot the later value wins (largest knot index <= t).
    expect(evalSpline1D(s, 1)).toBe(6);
  });

  it('has no side effects on its inputs', () => {
    const knots = [0, 1, 2];
    const values = [1, 2, 3];
    const s = buildMonotoneSpline1D(knots, values);
    s.knots[0] = 99;
    s.values[0] = 99;
    expect(knots).toEqual([0, 1, 2]);
    expect(values).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// 2-D: centripetal Catmull-Rom on time knots
// ---------------------------------------------------------------------------

describe('buildCentripetalSpline2D / evalSpline2D', () => {
  const zigzag: Vec2[] = [
    { x: 0, y: 0 },
    { x: 3, y: 1 },
    { x: 3.5, y: 4 },
    { x: -2, y: 4.5 },
    { x: -2.2, y: 0.3 },
    { x: 6, y: -1 },
  ];
  const zigzagKnots = [0, 1, 3.5, 4, 7, 7.25];

  it('is C⁰ and C¹ at every interior knot on non-uniform time knots', () => {
    const s = buildCentripetalSpline2D(zigzagKnots, zigzag);
    assertC1_2D(s);
  });

  it('is C⁰ and C¹ at every interior knot on uniform time knots', () => {
    const s = buildCentripetalSpline2D([0, 1, 2, 3, 4, 5], zigzag);
    assertC1_2D(s);
  });

  it('n=2 is exactly linear interpolation (straight constant-velocity glide)', () => {
    const s = buildCentripetalSpline2D([0, 1], [{ x: 1, y: 2 }, { x: 5, y: -6 }]);
    const check = (t: number) => {
      const p = evalSpline2D(s, t);
      expect(Math.abs(p.x - (1 + 4 * t))).toBeLessThan(1e-9);
      expect(Math.abs(p.y - (2 - 8 * t))).toBeLessThan(1e-9);
    };
    check(0.25);
    check(0.5);
    check(0.75);
    // Tangents are chord / Δt at both ends.
    expect(s.tangents[0]).toEqual({ x: 4, y: -8 });
    expect(s.tangents[1]).toEqual({ x: 4, y: -8 });
  });

  it('n=2 stays linear when knots are offset and scaled', () => {
    const s = buildCentripetalSpline2D([10, 14], [{ x: 0, y: 0 }, { x: 8, y: 4 }]);
    const p = evalSpline2D(s, 11);
    expect(Math.abs(p.x - 2)).toBeLessThan(1e-9);
    expect(Math.abs(p.y - 1)).toBeLessThan(1e-9);
  });

  it('n=1 is constant', () => {
    const s = buildCentripetalSpline2D([3], [{ x: 7, y: -7 }]);
    expect(evalSpline2D(s, -1)).toEqual({ x: 7, y: -7 });
    expect(evalSpline2D(s, 3)).toEqual({ x: 7, y: -7 });
    expect(evalSpline2D(s, 10)).toEqual({ x: 7, y: -7 });
  });

  it('endpoints are exact and t outside the range clamps', () => {
    const s = buildCentripetalSpline2D(zigzagKnots, zigzag);
    expect(evalSpline2D(s, zigzagKnots[0])).toEqual(zigzag[0]);
    expect(evalSpline2D(s, zigzagKnots[zigzagKnots.length - 1])).toEqual(zigzag[zigzag.length - 1]);
    expect(evalSpline2D(s, -1e9)).toEqual(zigzag[0]);
    expect(evalSpline2D(s, 1e9)).toEqual(zigzag[zigzag.length - 1]);
  });

  it('end tangents are the clamped one-sided chords', () => {
    const s = buildCentripetalSpline2D(zigzagKnots, zigzag);
    const n = zigzag.length;
    expect(s.tangents[0]).toEqual({ x: 3 / 1, y: 1 / 1 });
    const dt = zigzagKnots[n - 1] - zigzagKnots[n - 2];
    expect(s.tangents[n - 1].x).toBeCloseTo((6 - -2.2) / dt, 9);
    expect(s.tangents[n - 1].y).toBeCloseTo((-1 - 0.3) / dt, 9);
  });

  it('duplicate consecutive points (stationary hiker) produce finite outputs', () => {
    const s = buildCentripetalSpline2D(
      [0, 1, 2, 3],
      [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 0 }],
    );
    for (const m of s.tangents) {
      expect(Number.isFinite(m.x)).toBe(true);
      expect(Number.isFinite(m.y)).toBe(true);
    }
    const pts = sweep(s.knots, 600, (t) => evalSpline2D(s, t));
    for (const p of pts) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    // The spline still passes through the duplicated point at both knots.
    expect(evalSpline2D(s, 1)).toEqual({ x: 1, y: 1 });
    expect(evalSpline2D(s, 2)).toEqual({ x: 1, y: 1 });
  });

  it('all points coincident produces a constant finite curve', () => {
    const p = { x: 4, y: 4 };
    const s = buildCentripetalSpline2D([0, 1, 2], [p, p, p]);
    for (const t of [0, 0.3, 1, 1.7, 2]) {
      expect(evalSpline2D(s, t)).toEqual(p);
    }
  });

  it('equal adjacent knots produce finite outputs everywhere', () => {
    const s = buildCentripetalSpline2D(
      [0, 1, 1, 2],
      [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 2 }, { x: 3, y: 3 }],
    );
    for (const m of s.tangents) {
      expect(Number.isFinite(m.x)).toBe(true);
      expect(Number.isFinite(m.y)).toBe(true);
    }
    for (const t of [-1, 0, 0.5, 0.999, 1, 1.001, 1.5, 2, 3]) {
      const p = evalSpline2D(s, t);
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('centripetal shape sanity: a sharp doubling-back stays inside the control bbox +25%', () => {
    const pts: Vec2[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10.5, y: 0.2 },
      { x: 0, y: 1 },
    ];
    const s = buildCentripetalSpline2D([0, 1, 2, 3], pts);
    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxY = Math.max(...pts.map((p) => p.y));
    const padX = 0.25 * (maxX - minX);
    const padY = 0.25 * (maxY - minY);
    const samples = sweep(s.knots, 3000, (t) => evalSpline2D(s, t));
    for (const p of samples) {
      expect(p.x).toBeGreaterThanOrEqual(minX - padX);
      expect(p.x).toBeLessThanOrEqual(maxX + padX);
      expect(p.y).toBeGreaterThanOrEqual(minY - padY);
      expect(p.y).toBeLessThanOrEqual(maxY + padY);
    }
  });

  it('evaluation is deterministic and has no side effects on inputs', () => {
    const knots = [0, 1, 2];
    const points: Vec2[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }];
    const s = buildCentripetalSpline2D(knots, points);
    const a = evalSpline2D(s, 0.7);
    const b = evalSpline2D(s, 0.7);
    expect(a).toEqual(b);
    s.points[0].x = 99;
    expect(points[0].x).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bearing helpers
// ---------------------------------------------------------------------------

describe('unwrapDegrees / wrapDegrees', () => {
  it('unwraps short-way across the 0/360 seam', () => {
    expect(unwrapDegrees([359, 1])).toEqual([359, 361]);
    expect(unwrapDegrees([10, 350])).toEqual([10, -10]);
  });

  it('accumulates across many turns', () => {
    expect(unwrapDegrees([350, 10, 30, 50])).toEqual([350, 370, 390, 410]);
    expect(unwrapDegrees([10, 350, 330])).toEqual([10, -10, -30]);
    expect(unwrapDegrees([0, 90, 180, 270, 0])).toEqual([0, 90, 180, 270, 360]);
  });

  it('keeps the first value as-is and handles empty / single inputs', () => {
    expect(unwrapDegrees([])).toEqual([]);
    expect(unwrapDegrees([725])).toEqual([725]);
  });

  it('wraps to [0, 360)', () => {
    expect(wrapDegrees(361)).toBe(1);
    expect(wrapDegrees(-10)).toBe(350);
    expect(wrapDegrees(360)).toBe(0);
    expect(wrapDegrees(0)).toBe(0);
    expect(wrapDegrees(-360)).toBe(0);
    expect(wrapDegrees(725)).toBe(5);
    expect(Object.is(wrapDegrees(-0), 0)).toBe(true);
  });

  it('bearing 359° → 1° glides the short way through 0 when splined', () => {
    const unwrapped = unwrapDegrees([359, 1]);
    const s = buildMonotoneSpline1D([0, 1], unwrapped);
    expect(wrapDegrees(evalSpline1D(s, 0.5))).toBeCloseTo(0, 9);
    expect(wrapDegrees(evalSpline1D(s, 0.25))).toBeCloseTo(359.5, 9);
    expect(wrapDegrees(evalSpline1D(s, 0.75))).toBeCloseTo(0.5, 9);
  });
});
