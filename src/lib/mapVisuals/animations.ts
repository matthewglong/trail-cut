// Project-time-driven animation primitives. Pure functions of `t` so the
// preview and export agree at any sampled project-time, and so pausing the
// preview freezes the animation mid-cycle.

import type { MapSettings } from '../../types';
import { PAINT_REFERENCE_WIDTH } from './styleSpec';
import type { PulseState } from './types';

/** Pulse period (ms). Matches the 1.6s `trailcut-pulse` CSS keyframe in the
 *  pre-refactor MapView. Exported because the periodicity test needs it
 *  (`pulseAt(t) ≈ pulseAt(t + PULSE_PERIOD_MS)`). */
export const PULSE_PERIOD_MS = 1600;

const PULSE_OPACITY_START = 0.55;

/** Sample the pulse animation at project-time `t`. Cubic ease-out on the
 *  normalized phase `[0, 1)`. Radius grows from
 *  `mapSettings.overlay_pulse_start_radius × PAINT_REFERENCE_WIDTH` to
 *  `mapSettings.overlay_pulse_end_radius × PAINT_REFERENCE_WIDTH` across one
 *  period; opacity fades from 0.55 → 0. Modulo wraps so any positive or
 *  negative `t` lands inside `[0, period)`.
 *
 *  Width-independent under the lever model: paints anchor to a constant
 *  reference width and the renderer's `pixelRatio` lever absorbs the
 *  resolution shift. */
export function pulseAt(
  projectTimeMs: number,
  mapSettings: MapSettings,
): PulseState {
  const wrapped =
    ((projectTimeMs % PULSE_PERIOD_MS) + PULSE_PERIOD_MS) % PULSE_PERIOD_MS;
  const phase = wrapped / PULSE_PERIOD_MS;
  const eased = 1 - Math.pow(1 - phase, 3); // cubic ease-out
  const startRadius =
    mapSettings.pov.size.pulse_start_radius * PAINT_REFERENCE_WIDTH;
  const endRadius =
    mapSettings.pov.size.pulse_end_radius * PAINT_REFERENCE_WIDTH;
  return {
    radius: startRadius + (endRadius - startRadius) * eased,
    opacity: PULSE_OPACITY_START * (1 - eased),
  };
}
