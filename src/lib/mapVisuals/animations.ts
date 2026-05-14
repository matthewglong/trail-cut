// Project-time-driven animation primitives. Pure functions of `t` so the
// preview and export agree at any sampled project-time, and so pausing the
// preview freezes the animation mid-cycle.

import { PAINT_REFERENCE_WIDTH, PAINT_SIZE_FRACTIONS } from './styleSpec';
import type { PulseState } from './types';

/** Pulse period (ms). Matches the 1.6s `trailcut-pulse` CSS keyframe in the
 *  pre-refactor MapView. Exported because the periodicity test needs it
 *  (`pulseAt(t) ≈ pulseAt(t + PULSE_PERIOD_MS)`). */
export const PULSE_PERIOD_MS = 1600;

const PULSE_OPACITY_START = 0.55;

/** Sample the pulse animation at project-time `t`. Cubic ease-out on the
 *  normalized phase `[0, 1)`. Radius grows from
 *  `PAINT_SIZE_FRACTIONS.pulseStartRadius × PAINT_REFERENCE_WIDTH` to
 *  `PAINT_SIZE_FRACTIONS.pulseEndRadius × PAINT_REFERENCE_WIDTH` across one
 *  period; opacity fades from 0.55 → 0. Modulo wraps so any positive or
 *  negative `t` lands inside `[0, period)`.
 *
 *  Width-independent under the lever model: paints anchor to a constant
 *  reference width and the renderer's `pixelRatio` lever absorbs the
 *  resolution shift. Preview composition uses `pulseAtScaled`. */
export function pulseAt(projectTimeMs: number): PulseState {
  return pulseAtScaled(projectTimeMs, PAINT_REFERENCE_WIDTH);
}

/** Internal helper: sample the pulse at `projectTimeMs` with the radii
 *  scaled by an arbitrary reference width. The preview's per-frame paint
 *  builder feeds `PAINT_REFERENCE_WIDTH × paneCssWidth /
 *  canonicalMapCssWidth(aspect)` so the pulse composes with the pane
 *  reshape factor exactly like the static paints. Opacity is width-
 *  independent. */
export function pulseAtScaled(
  projectTimeMs: number,
  scaledRefWidth: number,
): PulseState {
  const wrapped =
    ((projectTimeMs % PULSE_PERIOD_MS) + PULSE_PERIOD_MS) % PULSE_PERIOD_MS;
  const phase = wrapped / PULSE_PERIOD_MS;
  const eased = 1 - Math.pow(1 - phase, 3); // cubic ease-out
  const startRadius = PAINT_SIZE_FRACTIONS.pulseStartRadius * scaledRefWidth;
  const endRadius = PAINT_SIZE_FRACTIONS.pulseEndRadius * scaledRefWidth;
  return {
    radius: startRadius + (endRadius - startRadius) * eased,
    opacity: PULSE_OPACITY_START * (1 - eased),
  };
}
