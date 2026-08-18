// Project-time-driven animation primitives. Pure functions of `t` so the
// preview and export agree at any sampled project-time, and so pausing the
// preview freezes the animation mid-cycle.

import type {
  EaseSpeed,
  EaseStyle,
  MapSettings,
  PovPulseRate,
  PovPulseStyle,
  SeamEase,
} from '../../types';
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

// -- Seam-ease envelope primitives -------------------------------------------
//
// The Transition decoration's ease_in / ease_out play as a pure ENVELOPE —
// scale and opacity multipliers over the whole POV marker stack (body,
// pulse, halo) — anchored at the instants where the marker visually jumps
// or swaps style. `buildPerFrameState` finds the instants (they depend on
// timeline + per-clip settings); this module owns the per-phase math so the
// curves live next to the pulse curves and can never fork per engine.

/** Per-phase ease duration (ms) for each speed bucket. FIXED duration —
 *  deliberately independent of the transition window's length so
 *  back-to-back short clips get the same snap as long ones (Matthew's
 *  anchoring pick, 2026-08-13). */
export const EASE_PHASE_MS: Record<EaseSpeed, number> = {
  slow: 650,
  medium: 400,
  fast: 250,
};

/** The largest phase duration — the prefilter horizon `buildPerFrameState`
 *  uses to skip resolving clips whose seams can't affect the current
 *  frame. */
export const EASE_MAX_PHASE_MS = EASE_PHASE_MS.slow;

/** Multiplicative envelope over the POV marker stack. Identity =
 *  `{ scale: 1, opacity: 1 }`. Scale multiplies every size-like POV value
 *  (dot/stroke/icon/halo/pulse radii); opacity multiplies the body opacity
 *  channel (`dotOpacity`), the pulse-ring opacities, and the live-marker
 *  halo composite's group opacity. */
export interface EaseEnvelope {
  scale: number;
  opacity: number;
}

export const IDENTITY_ENVELOPE: EaseEnvelope = { scale: 1, opacity: 1 };

/** Cubic ease-in-out on [0, 1] — the workhorse smoothing curve for the
 *  fade/grow styles. (The camera arc's `easeInOut` lives in cameraIntent
 *  and is parameterized by TransitionFeel; the seam eases deliberately use
 *  a fixed curve so a project's transition feel doesn't change how markers
 *  pop.) */
function easeInOutCubic(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

/** Ease-out-back on [0, 1]: overshoots ~1.1 near the end then settles at 1.
 *  The classic "pop" arrival. Played in reverse (v: 1 → 0) it reads as a
 *  small anticipation wind-up before the shrink. */
function easeOutBack(p: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
}

/** Sample one ease style at target visibility `v ∈ [0, 1]` (0 = fully
 *  hidden, 1 = fully shown). IN phases sweep v 0 → 1 after the instant;
 *  OUT phases sweep v 1 → 0 before it — one function serves both
 *  directions, so enter and exit are exact mirrors by construction. */
export function easeEnvelopeSample(style: EaseStyle, v: number): EaseEnvelope {
  const p = v < 0 ? 0 : v > 1 ? 1 : v;
  switch (style) {
    case 'fade':
      return { scale: 1, opacity: easeInOutCubic(p) };
    case 'grow':
      return { scale: easeInOutCubic(p), opacity: 1 };
    case 'pop':
    default: {
      const s = easeOutBack(p);
      return { scale: s < 0 ? 0 : s, opacity: 1 };
    }
  }
}

/** One seam-ease anchor: at project-time `t`, the marker jumps or swaps
 *  style. `out` governs the OUT phase over `[t − D_out, t)`; `in` governs
 *  the IN phase over `[t, t + D_in)`. Either side absent ⇒ that side keeps
 *  today's hard jump. */
export interface SeamInstant {
  t: number;
  out?: SeamEase;
  in?: SeamEase;
}

/** Evaluate the combined envelope at `t` against a set of seam instants.
 *  Overlapping phases (clips shorter than a phase, adjacent seams) combine
 *  multiplicatively — the layered-composition rule, no special cases. Pure
 *  function of (t, instants): pause freezes it, export reproduces it. */
export function seamEnvelopeAt(
  t: number,
  instants: readonly SeamInstant[],
): EaseEnvelope {
  let scale = 1;
  let opacity = 1;
  for (const inst of instants) {
    if (inst.out) {
      const d = EASE_PHASE_MS[inst.out.speed];
      if (t >= inst.t - d && t < inst.t) {
        const m = easeEnvelopeSample(inst.out.style, (inst.t - t) / d);
        scale *= m.scale;
        opacity *= m.opacity;
      }
    }
    if (inst.in) {
      const d = EASE_PHASE_MS[inst.in.speed];
      if (t >= inst.t && t < inst.t + d) {
        const m = easeEnvelopeSample(inst.in.style, (t - inst.t) / d);
        scale *= m.scale;
        opacity *= m.opacity;
      }
    }
  }
  return scale === 1 && opacity === 1 ? IDENTITY_ENVELOPE : { scale, opacity };
}
