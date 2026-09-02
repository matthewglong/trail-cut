// Spline evaluator for clip-group camera glides — pure math, standalone.
//
// Binding requirements: `docs/CLIP_GROUPS_HANDOFF.md` §2 "Spline evaluator" and
// §7 "Spline". Summary of the contract this module implements:
//
//   - Center (2-D): cubic Hermite on TIME knots through points, tangents from
//     centripetal Catmull-Rom (Yuksel α = 0.5), clamped one-sided chord tangents
//     at both ends → the curve starts/ends exactly on the boundary points with
//     finite velocity and no overshoot past the ends.
//   - Zoom / pitch / (unwrapped) bearing (1-D): cubic Hermite with Fritsch–Carlson
//     monotone-limited tangents → a value that changes then holds cannot bounce.
//   - NO easing anywhere: u is linear in t per segment, so evaluation is
//     monotone in t by construction. No caches, no side effects.
//   - Numerical robustness: equal adjacent knots / coincident adjacent points
//     never NaN or throw — degenerate segments early-out to endpoint values.
//
// Nothing here imports from the rest of the app; the glue that maps camera
// state onto these primitives lives in `cameraIntent.ts`.

export interface Vec2 {
  x: number;
  y: number;
}

/** 1-D cubic Hermite spline on strictly-increasing knots (handoff §2). */
export interface Spline1D {
  knots: number[];
  values: number[];
  /** Tangents per unit of knot-time (dv/dt at each knot). */
  tangents: number[];
}

/** 2-D cubic Hermite on TIME knots through points (handoff §2). */
export interface Spline2D {
  knots: number[];
  points: Vec2[];
  /** Tangents per unit of knot-time (dP/dt at each knot). */
  tangents: Vec2[];
}

/** Floor for a centripetal increment so coincident anchors never divide by zero (handoff §2). */
const CENTRIPETAL_EPS = 1e-9;

// ---------------------------------------------------------------------------
// Hermite basis + segment lookup (shared by 1-D and 2-D)
// ---------------------------------------------------------------------------

interface HermiteBasis {
  h00: number;
  h10: number;
  h01: number;
  h11: number;
}

function hermiteBasis(u: number): HermiteBasis {
  const u2 = u * u;
  const u3 = u2 * u;
  return {
    h00: 2 * u3 - 3 * u2 + 1,
    h10: u3 - 2 * u2 + u,
    h01: -2 * u3 + 3 * u2,
    h11: u3 - u2,
  };
}

/**
 * Locate the segment containing `t` (already clamped to the knot range) and
 * return its index `i` (segment spans `knots[i] .. knots[i+1]`) plus the
 * linear local parameter `u ∈ [0, 1]`. `u` is linear in `t` — NO easing
 * (handoff §2). A zero-width segment reports `u = 1` so the caller resolves to
 * the segment's end value; `i` is the largest index with `knots[i] <= t`,
 * capped so the segment is always well-formed.
 */
function locateSegment(knots: number[], t: number): { i: number; u: number } {
  const n = knots.length;
  // Binary search for the largest i with knots[i] <= t, i in [0, n-2].
  let lo = 0;
  let hi = n - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (knots[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  const width = knots[i + 1] - knots[i];
  if (!(width > 0)) return { i, u: 1 };
  const u = (t - knots[i]) / width;
  return { i, u: u < 0 ? 0 : u > 1 ? 1 : u };
}

function clampToRange(knots: number[], t: number): number {
  const first = knots[0];
  const last = knots[knots.length - 1];
  if (t <= first) return first;
  if (t >= last) return last;
  return t;
}

// ---------------------------------------------------------------------------
// 1-D: Fritsch–Carlson monotone Hermite
// ---------------------------------------------------------------------------

/**
 * Build a 1-D cubic Hermite spline with Fritsch–Carlson monotone-limited
 * tangents (handoff §2: zoom / pitch / unwrapped bearing). Interior tangents
 * start as secant averages, are zeroed where adjacent secants change sign or
 * either is zero (so a value that changes then holds cannot overshoot), then
 * pass through the α² + β² ≤ 9 circle limiter. End tangents are the one-sided
 * chord (or 0 with a single knot). n = 2 degenerates to a straight
 * constant-velocity line. A zero-width segment contributes a zero secant.
 */
export function buildMonotoneSpline1D(knots: number[], values: number[]): Spline1D {
  const n = Math.min(knots.length, values.length);
  const k = knots.slice(0, n);
  const v = values.slice(0, n);
  const m = new Array<number>(n).fill(0);
  if (n < 2) return { knots: k, values: v, tangents: m };

  // Secants per segment; a degenerate (zero / negative width) segment is flat.
  const d = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const h = k[i + 1] - k[i];
    d[i] = h > 0 ? (v[i + 1] - v[i]) / h : 0;
  }

  // Initial tangents: one-sided chord at the ends, secant average inside,
  // zeroed at sign changes / flats.
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    const a = d[i - 1];
    const b = d[i];
    m[i] = a === 0 || b === 0 || Math.sign(a) !== Math.sign(b) ? 0 : (a + b) / 2;
  }

  // Fritsch–Carlson circle limiter per segment.
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const alpha = m[i] / d[i];
    const beta = m[i + 1] / d[i];
    const r2 = alpha * alpha + beta * beta;
    if (r2 > 9) {
      const tau = 3 / Math.sqrt(r2);
      m[i] = tau * alpha * d[i];
      m[i + 1] = tau * beta * d[i];
    }
  }

  return { knots: k, values: v, tangents: m };
}

/**
 * Evaluate a 1-D spline at `t`, clamped to `[knots[0], knots[last]]`. `u` is
 * linear in `t` per segment — NO easing (handoff §2). A zero-width segment
 * returns its end value. Returns `NaN` only for an empty spline.
 */
export function evalSpline1D(s: Spline1D, t: number): number {
  const n = s.knots.length;
  if (n === 0) return NaN;
  if (n === 1) return s.values[0];
  const tc = clampToRange(s.knots, t);
  const { i, u } = locateSegment(s.knots, tc);
  if (u >= 1) return s.values[i + 1];
  if (u <= 0) return s.values[i];
  const h = s.knots[i + 1] - s.knots[i];
  const b = hermiteBasis(u);
  return (
    b.h00 * s.values[i] +
    b.h10 * h * s.tangents[i] +
    b.h01 * s.values[i + 1] +
    b.h11 * h * s.tangents[i + 1]
  );
}

// ---------------------------------------------------------------------------
// 2-D: centripetal Catmull-Rom tangents on time knots
// ---------------------------------------------------------------------------

/**
 * Build a 2-D cubic Hermite spline on TIME knots through `points` (handoff §2:
 * the camera center glide). Tangent construction:
 *
 *   - Centripetal parameter `s` with increments `Δ_i = max(|P_{i+1} − P_i|^0.5,
 *     1e-9)` (Yuksel α = 0.5 — cusp/loop-proof under uneven spacing, and the ε
 *     floor keeps stationary-hiker duplicate anchors finite).
 *   - Interior knots: the non-uniform Catmull-Rom tangent in `s` (derivative of
 *     the quadratic through the three neighbouring points), converted to a
 *     per-unit-TIME tangent via the chain rule with `ds/dt` ≈ the central
 *     difference at that knot, so the Hermite basis on time knots is C¹ in t.
 *   - End knots: clamped one-sided chord tangents `(P1−P0)/(t1−t0)` and
 *     `(Pn−Pn−1)/(tn−tn−1)` so the curve starts/ends exactly on the boundary
 *     points with finite velocity and no overshoot past the ends.
 *
 * n = 1 → constant; n = 2 → straight constant-velocity glide in time. A
 * zero-width time span anywhere yields a zero tangent rather than NaN.
 */
export function buildCentripetalSpline2D(knots: number[], points: Vec2[]): Spline2D {
  const n = Math.min(knots.length, points.length);
  const k = knots.slice(0, n);
  const p = points.slice(0, n).map((q) => ({ x: q.x, y: q.y }));
  const m: Vec2[] = [];
  for (let i = 0; i < n; i++) m.push({ x: 0, y: 0 });
  if (n < 2) return { knots: k, points: p, tangents: m };

  const chordOverTime = (a: number, b: number): Vec2 => {
    const h = k[b] - k[a];
    if (!(h > 0)) return { x: 0, y: 0 };
    return { x: (p[b].x - p[a].x) / h, y: (p[b].y - p[a].y) / h };
  };

  // Clamped one-sided chord tangents at the ends (n = 2 → both ends = chord/Δt).
  m[0] = chordOverTime(0, 1);
  m[n - 1] = chordOverTime(n - 2, n - 1);

  if (n > 2) {
    // Centripetal increments Δ_i = max(dist^0.5, ε).
    const delta = new Array<number>(n - 1);
    for (let i = 0; i < n - 1; i++) {
      const dx = p[i + 1].x - p[i].x;
      const dy = p[i + 1].y - p[i].y;
      delta[i] = Math.max(Math.sqrt(Math.sqrt(dx * dx + dy * dy)), CENTRIPETAL_EPS);
    }

    for (let i = 1; i < n - 1; i++) {
      const a = delta[i - 1];
      const b = delta[i];
      // Non-uniform Catmull-Rom tangent in s: weighted average of the two
      // chord slopes (each chord weighted by the OTHER interval's width).
      const wPrev = b / (a + b);
      const wNext = a / (a + b);
      const dsX = (wPrev * (p[i].x - p[i - 1].x)) / a + (wNext * (p[i + 1].x - p[i].x)) / b;
      const dsY = (wPrev * (p[i].y - p[i - 1].y)) / a + (wNext * (p[i + 1].y - p[i].y)) / b;
      // Chain rule: dP/dt = dP/ds · ds/dt, ds/dt ≈ central difference at knot i.
      const dt = k[i + 1] - k[i - 1];
      const dsdt = dt > 0 ? (a + b) / dt : 0;
      m[i] = { x: dsX * dsdt, y: dsY * dsdt };
    }
  }

  return { knots: k, points: p, tangents: m };
}

/**
 * Evaluate a 2-D spline at `t`, clamped to `[knots[0], knots[last]]`. `u` is
 * linear in `t` per segment — NO easing (handoff §2). A zero-width segment
 * returns its end point; a coincident-point segment with finite tangents
 * evaluates normally (and stays finite). Returns `{NaN, NaN}` only for an
 * empty spline.
 */
export function evalSpline2D(s: Spline2D, t: number): Vec2 {
  const n = s.knots.length;
  if (n === 0) return { x: NaN, y: NaN };
  if (n === 1) return { x: s.points[0].x, y: s.points[0].y };
  const tc = clampToRange(s.knots, t);
  const { i, u } = locateSegment(s.knots, tc);
  if (u >= 1) return { x: s.points[i + 1].x, y: s.points[i + 1].y };
  if (u <= 0) return { x: s.points[i].x, y: s.points[i].y };
  const h = s.knots[i + 1] - s.knots[i];
  const b = hermiteBasis(u);
  const p0 = s.points[i];
  const p1 = s.points[i + 1];
  const m0 = s.tangents[i];
  const m1 = s.tangents[i + 1];
  return {
    x: b.h00 * p0.x + b.h10 * h * m0.x + b.h01 * p1.x + b.h11 * h * m1.x,
    y: b.h00 * p0.y + b.h10 * h * m0.y + b.h01 * p1.y + b.h11 * h * m1.y,
  };
}

// ---------------------------------------------------------------------------
// Bearing helpers
// ---------------------------------------------------------------------------

/**
 * Cumulative short-way unwrap of a bearing sequence (handoff §2: the
 * `circularLerp` convention). The first value is kept as-is; each subsequent
 * value is shifted by a multiple of 360 so it lies within ±180° of the
 * previous unwrapped value. Feed the result to `buildMonotoneSpline1D` and
 * re-wrap the evaluated output with `wrapDegrees`.
 */
export function unwrapDegrees(deg: number[]): number[] {
  const out = new Array<number>(deg.length);
  if (deg.length === 0) return out;
  out[0] = deg[0];
  for (let i = 1; i < deg.length; i++) {
    const raw = deg[i] - deg[i - 1];
    // Fold the delta into [-180, 180).
    const d = ((((raw + 180) % 360) + 360) % 360) - 180;
    out[i] = out[i - 1] + d;
  }
  return out;
}

/** Wrap a bearing to `[0, 360)` (handoff §2: re-wrap mod 360 on output). */
export function wrapDegrees(d: number): number {
  const w = ((d % 360) + 360) % 360;
  // Guard against -0 and the rare `w === 360` from floating-point rounding.
  return w >= 360 ? 0 : w === 0 ? 0 : w;
}
