// Project-time-driven animation primitives. Pure functions of `t` so the
// preview and export agree at any sampled project-time, and so pausing the
// preview freezes the animation mid-cycle.

import type { PulseState } from './types';

/** Pulse period (ms). Matches the 1.6s `trailcut-pulse` CSS keyframe in the
 *  pre-refactor MapView. Exported because the periodicity test needs it
 *  (`pulseAt(t) ≈ pulseAt(t + PULSE_PERIOD_MS)`). */
export const PULSE_PERIOD_MS = 1600;

const PULSE_RADIUS_START = 8;
const PULSE_RADIUS_END = 22;
const PULSE_OPACITY_START = 0.55;

/** Sample the pulse animation at project-time `t`. Cubic ease-out on the
 *  normalized phase `[0, 1)` — radius grows from 8→22 px, opacity fades
 *  from 0.55→0 across one period. Modulo wraps so any positive or negative
 *  `t` lands inside `[0, period)`. */
export function pulseAt(projectTimeMs: number): PulseState {
  const wrapped =
    ((projectTimeMs % PULSE_PERIOD_MS) + PULSE_PERIOD_MS) % PULSE_PERIOD_MS;
  const phase = wrapped / PULSE_PERIOD_MS;
  const eased = 1 - Math.pow(1 - phase, 3); // cubic ease-out
  return {
    radius: PULSE_RADIUS_START + (PULSE_RADIUS_END - PULSE_RADIUS_START) * eased,
    opacity: PULSE_OPACITY_START * (1 - eased),
  };
}
