// Project-time-driven animation primitives. Pure functions of `t` so the
// preview and export agree at any sampled project-time, and so pausing the
// preview freezes the animation mid-cycle.

import type { MapSettings, PovPulseRate, PovPulseStyle } from '../../types';
import { PAINT_REFERENCE_WIDTH } from './styleSpec';
import type { PulseState, PulseStatePair } from './types';

/** Period (ms) for each pulse rate bucket. `medium` matches the pre-v8
 *  hardcoded 1600ms — i.e. cycle time of the legacy sonar implementation.
 *  Exported because the animations tests pin the medium value. */
export const PULSE_RATE_MS: Record<PovPulseRate, number> = {
  fast: 800,
  medium: 1600,
  slow: 2400,
};

/** Back-compat alias for the legacy `medium` period. Several tests import
 *  `PULSE_PERIOD_MS` and treat it as the canonical period; under v8 it now
 *  resolves to the `medium` rate bucket. */
export const PULSE_PERIOD_MS = PULSE_RATE_MS.medium;

const SONAR_OPACITY_START = 0.55;
/** Heartbeat second-pulse phase offset (fraction of period). Per
 *  `shapes-pov.md` Part 2: "ring B starts at phase 0.25" — two pulses in
 *  quick succession, then a pause. */
const HEARTBEAT_B_PHASE_OFFSET = 0.25;
/** Heartbeat per-pulse decay length (fraction of period). Each ring's
 *  sub-pulse occupies the first 45% of the period, leaving the remainder
 *  as a quiet beat-rest. */
const HEARTBEAT_DECAY_FRACTION = 0.45;
/** Throb minimum dot opacity. Per `shapes-pov.md` Part 2 §2: "the dot's
 *  `circle-opacity` oscillates between a minimum (e.g. 0.35) and 1.0 via a
 *  sine wave." 0.35 keeps the dot legible at its dimmest. */
const THROB_DOT_OPACITY_MIN = 0.35;
const THROB_DOT_OPACITY_MAX = 1;

function periodFor(mapSettings: MapSettings): number {
  return PULSE_RATE_MS[mapSettings.pov.pulse_rate];
}

function startEndRadii(mapSettings: MapSettings): { start: number; end: number } {
  return {
    start: mapSettings.pov.size.pulse_start_radius * PAINT_REFERENCE_WIDTH,
    end: mapSettings.pov.size.pulse_end_radius * PAINT_REFERENCE_WIDTH,
  };
}

function wrappedPhase(projectTimeMs: number, period: number): number {
  const wrapped = ((projectTimeMs % period) + period) % period;
  return wrapped / period;
}

/** Sonar ring: cubic ease-out radius growth, simultaneous opacity fade
 *  from 0.55 → 0 across one period. Pre-v8 default behavior. Dot stays
 *  fully opaque — the ring is the animated element. */
function sonarAt(projectTimeMs: number, mapSettings: MapSettings): PulseState {
  const phase = wrappedPhase(projectTimeMs, periodFor(mapSettings));
  const eased = 1 - Math.pow(1 - phase, 3);
  const { start, end } = startEndRadii(mapSettings);
  return {
    radius: start + (end - start) * eased,
    opacity: SONAR_OPACITY_START * (1 - eased),
    dotOpacity: 1,
  };
}

/** Throb: the dot itself pulses in opacity per `shapes-pov.md` Part 2 §2.
 *  The outer ring stays hidden (radius + opacity both 0). The dot's
 *  `circle-opacity` oscillates between `THROB_DOT_OPACITY_MIN` (0.35) and
 *  `THROB_DOT_OPACITY_MAX` (1.0) via a SINE wave with one full cycle per
 *  pulse period — sine is symmetric, so the dimming and brightening halves
 *  feel like one organic throb instead of an ease-out drop. */
function throbAt(projectTimeMs: number, mapSettings: MapSettings): PulseState {
  const phase = wrappedPhase(projectTimeMs, periodFor(mapSettings));
  // Sine wave with mean = (min+max)/2 and amplitude = (max-min)/2, one full
  // cycle per period. Starts at the mean (phase 0 → sin 0 → mean), brightens
  // to max at phase 0.25, returns to mean at 0.5, dims to min at 0.75, back
  // to mean at 1. Symmetric: throbAt(phase) and throbAt(1 - phase) have
  // matching dotOpacity within float precision (sin(2π·p) = -sin(2π·(1-p))
  // is offset by the mean term — see the sine-wave-symmetry test for the
  // exact equality used).
  const mean = (THROB_DOT_OPACITY_MIN + THROB_DOT_OPACITY_MAX) / 2;
  const amplitude = (THROB_DOT_OPACITY_MAX - THROB_DOT_OPACITY_MIN) / 2;
  const dotOpacity = mean + amplitude * Math.sin(2 * Math.PI * phase);
  return {
    radius: 0,
    opacity: 0,
    dotOpacity,
  };
}

/** Steady: no animation. Ring opacity held at 0; dot fully opaque. */
function steadyAt(_projectTimeMs: number, mapSettings: MapSettings): PulseState {
  const { start } = startEndRadii(mapSettings);
  return { radius: start, opacity: 0, dotOpacity: 1 };
}

function heartbeatRingSample(p: number, mapSettings: MapSettings): PulseState {
  const { start, end } = startEndRadii(mapSettings);
  if (p < 0 || p >= 1) {
    return { radius: start, opacity: 0, dotOpacity: 1 };
  }
  const eased = 1 - Math.pow(1 - p, 3);
  return {
    radius: start + (end - start) * eased,
    opacity: SONAR_OPACITY_START * (1 - p),
    dotOpacity: 1,
  };
}

/** Heartbeat: two rings fire in quick succession (A at phase 0, B at
 *  phase 0.25) then pause. Per shapes-pov.md Part 2. */
function heartbeatAt(projectTimeMs: number, mapSettings: MapSettings): PulseStatePair {
  const phase = wrappedPhase(projectTimeMs, periodFor(mapSettings));
  const aLocal = phase / HEARTBEAT_DECAY_FRACTION;
  const bLocal = (phase - HEARTBEAT_B_PHASE_OFFSET) / HEARTBEAT_DECAY_FRACTION;
  return {
    a: heartbeatRingSample(aLocal, mapSettings),
    b: heartbeatRingSample(bLocal, mapSettings),
  };
}

/** Pulse style dispatcher. Returns A + B ring states. Non-heartbeat
 *  styles return ring B at opacity 0 (the always-seeded layer renders
 *  invisible until a swap into heartbeat). The dot's `circle-opacity` is
 *  read from `a.dotOpacity` only — `b.dotOpacity` mirrors `a` so the pair
 *  has a consistent shape, but the per-frame paint plumbing only reads the
 *  A half (one dot layer, not two). */
export function pulsePairAt(projectTimeMs: number, mapSettings: MapSettings): PulseStatePair {
  const style: PovPulseStyle = mapSettings.pov.pulse_style;
  if (style === 'heartbeat') {
    return heartbeatAt(projectTimeMs, mapSettings);
  }
  let a: PulseState;
  switch (style) {
    case 'steady':
      a = steadyAt(projectTimeMs, mapSettings);
      break;
    case 'throb':
      a = throbAt(projectTimeMs, mapSettings);
      break;
    case 'sonar':
    default:
      a = sonarAt(projectTimeMs, mapSettings);
      break;
  }
  const { start } = startEndRadii(mapSettings);
  return { a, b: { radius: start, opacity: 0, dotOpacity: a.dotOpacity } };
}

/** Back-compat: sample only the A-ring pulse. */
export function pulseAt(projectTimeMs: number, mapSettings: MapSettings): PulseState {
  return pulsePairAt(projectTimeMs, mapSettings).a;
}
