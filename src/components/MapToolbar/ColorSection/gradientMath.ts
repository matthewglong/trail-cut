// Pure math + invariants helpers for the gradient editor.
//
// Lives apart from `GradientEditor.tsx` so the math is unit-testable without
// pulling in React, and so `react-refresh/only-export-components` stays happy
// (the editor file then only exports React components).
//
// Stop fractions are Web Mercator line-progress fractions in [0, 1], per
// `color-gradient.md` §1. The distance label `0.0 km` is display-only and
// derived linearly from `totalDistMeters * fraction`.

import type { GradientStop } from '../../../types';

/** Minimum fractional separation between adjacent stops, enforced by the
 *  drag-collision guard and mirrored by `validateGradient` in `types.ts`. */
export const MIN_STOP_SEPARATION = 0.005;

/** Hard cap on stop count (`color-gradient.md` §7b). */
export const MAX_STOPS = 8;

/** Snap-to-waypoint-tick threshold, expressed in pixels — converted to a
 *  fraction at the drag call site since the editor knows its bar width. */
export const SNAP_PX = 6;

/** Round a fraction to the storage precision used by the editor. The
 *  4-decimal rounding pairs with `MIN_STOP_SEPARATION = 0.005` so stop
 *  fractions never collide after rounding. */
export function roundFraction(f: number): number {
  return Math.round(f * 10_000) / 10_000;
}

/** Parse a hex string (with or without leading `#`) to [r, g, b] in [0, 255].
 *  Returns null for malformed input. */
export function hexToRgb(hex: string): [number, number, number] | null {
  const trimmed = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(trimmed)) return null;
  const r = parseInt(trimmed.slice(0, 2), 16);
  const g = parseInt(trimmed.slice(2, 4), 16);
  const b = parseInt(trimmed.slice(4, 6), 16);
  return [r, g, b];
}

/** Format [r, g, b] back to a 7-char lowercase `#rrggbb` hex. */
export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const h = (v: number) => clamp(v).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Linear-in-sRGB interpolation between two hex colors at `t` in [0, 1].
 *  Falls back to `a` on malformed input — defensive, never throws. The
 *  click-to-add-stop behavior in `color-gradient.md` §7c uses this to seed
 *  a new stop's color from the surrounding gradient samples. */
export function interpolateSrgb(a: string, b: string, t: number): string {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return a;
  const k = Math.max(0, Math.min(1, t));
  return rgbToHex(
    ra[0] + (rb[0] - ra[0]) * k,
    ra[1] + (rb[1] - ra[1]) * k,
    ra[2] + (rb[2] - ra[2]) * k,
  );
}

/** Sample a stop array at a target fraction by sRGB-interpolating between
 *  the two bounding stops. Assumes `stops` is sorted ascending and has at
 *  least two entries (the editor always has 2+ endpoints). */
export function sampleStopsAt(stops: GradientStop[], fraction: number): string {
  if (stops.length === 0) return '#bced09';
  if (stops.length === 1) return stops[0].color;
  if (fraction <= stops[0].fraction) return stops[0].color;
  if (fraction >= stops[stops.length - 1].fraction) {
    return stops[stops.length - 1].color;
  }
  for (let i = 1; i < stops.length; i++) {
    if (stops[i].fraction >= fraction) {
      const prev = stops[i - 1];
      const cur = stops[i];
      const span = cur.fraction - prev.fraction;
      const t = span === 0 ? 0 : (fraction - prev.fraction) / span;
      return interpolateSrgb(prev.color, cur.color, t);
    }
  }
  return stops[stops.length - 1].color;
}

/** Insert a new stop at `fraction`, with its color sRGB-interpolated from
 *  the bounding stops. Returns the new array (sorted, rounded fractions).
 *  No-op if the insert would violate `MIN_STOP_SEPARATION` against any
 *  existing stop — the caller's UI logic should already guard, this is a
 *  belt-and-braces check.
 *
 *  Returns the new stops array on success, or the original array on rejection. */
export function insertStop(
  stops: GradientStop[],
  fraction: number,
): GradientStop[] {
  if (stops.length >= MAX_STOPS) return stops;
  const f = roundFraction(Math.max(0, Math.min(1, fraction)));
  // Reject if too close to any existing stop OR if the rounded fraction is
  // 0 or 1 (endpoints already exist and are pinned).
  if (f <= 0 || f >= 1) return stops;
  for (const s of stops) {
    if (Math.abs(s.fraction - f) < MIN_STOP_SEPARATION) return stops;
  }
  const color = sampleStopsAt(stops, f);
  const next = [...stops, { fraction: f, color }];
  next.sort((a, b) => a.fraction - b.fraction);
  return next;
}

/** Largest-gap insert (the `+ Stop` button affordance). Adds a stop at the
 *  midpoint of the widest fractional gap between adjacent stops. Returns
 *  the new array, or the original if no insert is possible. */
export function insertStopAtLargestGap(stops: GradientStop[]): GradientStop[] {
  if (stops.length >= MAX_STOPS) return stops;
  if (stops.length < 2) return stops;
  let bestGap = -Infinity;
  let bestMid = 0.5;
  for (let i = 1; i < stops.length; i++) {
    const gap = stops[i].fraction - stops[i - 1].fraction;
    if (gap > bestGap) {
      bestGap = gap;
      bestMid = (stops[i - 1].fraction + stops[i].fraction) / 2;
    }
  }
  return insertStop(stops, bestMid);
}

/** Remove the stop at `index`. No-op for endpoints (index 0 or last) or if
 *  the result would drop below 2 stops. */
export function removeStop(stops: GradientStop[], index: number): GradientStop[] {
  if (index <= 0 || index >= stops.length - 1) return stops;
  if (stops.length <= 2) return stops;
  const next = [...stops];
  next.splice(index, 1);
  return next;
}

/** Move the stop at `index` to `targetFraction`, with collision guard. Used
 *  by the stop-rail drag handler. Endpoints (index 0 and last) are
 *  position-locked — calling with them is a no-op on fraction (color edits
 *  go through `setStopColor`).
 *
 *  The collision guard clamps the new fraction to `neighbor ± MIN_STOP_SEPARATION`
 *  so two stops can never share a fraction. Endpoint fractions (0 and 1)
 *  themselves count as immovable neighbors.
 *
 *  Returns a new array; preserves the input order so the moved handle keeps
 *  its identity even when dragged past a sibling (the editor's selectedIndex
 *  state is index-based — sorting here would invalidate it). */
export function moveStop(
  stops: GradientStop[],
  index: number,
  targetFraction: number,
): GradientStop[] {
  if (index < 0 || index >= stops.length) return stops;
  if (index === 0 || index === stops.length - 1) return stops; // endpoints locked
  const f = roundFraction(Math.max(0, Math.min(1, targetFraction)));
  // Collision guard against all other stops (NOT just immediate neighbors —
  // a fast drag can cross multiple siblings in one frame).
  let clamped = f;
  let collided = false;
  do {
    collided = false;
    for (let i = 0; i < stops.length; i++) {
      if (i === index) continue;
      const other = stops[i].fraction;
      if (Math.abs(other - clamped) < MIN_STOP_SEPARATION) {
        // Push away from the collision in the direction the user is dragging.
        clamped = clamped < other ? other - MIN_STOP_SEPARATION : other + MIN_STOP_SEPARATION;
        collided = true;
        break;
      }
    }
  } while (collided);
  // Also clamp to the [0, 1] interior (endpoints are at 0 and 1).
  clamped = Math.max(MIN_STOP_SEPARATION, Math.min(1 - MIN_STOP_SEPARATION, clamped));
  const next = [...stops];
  next[index] = { ...next[index], fraction: roundFraction(clamped) };
  return next;
}

/** Update only the color of the stop at `index`. Endpoints participate
 *  (color is editable; only position is locked for endpoints). */
export function setStopColor(
  stops: GradientStop[],
  index: number,
  color: string,
): GradientStop[] {
  if (index < 0 || index >= stops.length) return stops;
  const next = [...stops];
  next[index] = { ...next[index], color: color.toLowerCase() };
  return next;
}

/** Snap `targetFraction` to the nearest entry in `snapFractions` if it's
 *  within `snapThresholdFraction`. Returns the snapped fraction, or the
 *  input fraction if nothing is in range. Also reports which snap target
 *  was used so the bar can highlight that tick. */
export function snapToTicks(
  targetFraction: number,
  snapFractions: number[],
  snapThresholdFraction: number,
): { fraction: number; snappedTo: number | null } {
  let best = -1;
  let bestDist = snapThresholdFraction;
  for (let i = 0; i < snapFractions.length; i++) {
    const d = Math.abs(snapFractions[i] - targetFraction);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  if (best === -1) return { fraction: targetFraction, snappedTo: null };
  return {
    fraction: snapFractions[best],
    snappedTo: snapFractions[best],
  };
}

/** Render the editor's stops as a CSS `linear-gradient` string for the
 *  preview bar. Assumes stops are sorted ascending. */
export function stopsToCssLinearGradient(stops: GradientStop[]): string {
  if (stops.length === 0) return '#bced09';
  if (stops.length === 1) return stops[0].color;
  const parts = stops.map(
    (s) => `${s.color} ${(s.fraction * 100).toFixed(2)}%`,
  );
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

/** Display string for a route-distance label.
 *  - < 1 km: integer meters, e.g. `"840 m"`.
 *  - ≥ 1 km: one-decimal kilometers, e.g. `"12.4 km"`.
 *
 *  `totalMeters * fraction` is the linear approximation per
 *  `color-gradient.md` §1. */
export function formatDistanceLabel(
  fraction: number,
  totalMeters: number,
): string {
  const m = totalMeters * fraction;
  if (totalMeters < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

/** Total-distance display string for the header row of the preview block. */
export function formatTotalDistance(totalMeters: number): string {
  if (totalMeters < 1000) return `${Math.round(totalMeters)} m`;
  return `${(totalMeters / 1000).toFixed(1)} km`;
}

/** Build two endpoint stops (fraction 0 and 1) both at the same color.
 *  Used when toggling solid → gradient for the first time. */
export function initialGradientFromSolid(solidHex: string): GradientStop[] {
  const c = solidHex.toLowerCase();
  return [
    { fraction: 0, color: c },
    { fraction: 1, color: c },
  ];
}

/** Deep clone of a stops array — used by the Copy buttons so the two
 *  decorations' arrays are immediately independent. */
export function cloneStops(stops: GradientStop[]): GradientStop[] {
  return stops.map((s) => ({ fraction: s.fraction, color: s.color }));
}
