import { OUTPUT_DIMS, type AspectRatio, type PipLayout } from '../../lib/layout';

export const SNAP_THRESHOLD = 0.05;

const PHI_INV = 0.618;
const ONE_MINUS_PHI_INV = 0.382;
const THIRD = 1 / 3;
const TWO_THIRDS = 2 / 3;

/** Returns the closest target within `threshold` of `value`, or `null` when
 *  no target is in range. Visual-feedback overlays read this to know which
 *  guide line to highlight. */
export function findActiveSnapTarget(
  value: number,
  targets: number[],
  threshold = SNAP_THRESHOLD,
): number | null {
  let best: number | null = null;
  let bestDist = threshold;
  for (const t of targets) {
    const d = Math.abs(value - t);
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return best;
}

export function snap(value: number, targets: number[], threshold = SNAP_THRESHOLD): number {
  const active = findActiveSnapTarget(value, targets, threshold);
  return active ?? value;
}

// ============================================================================
// PiP snap model — Figma-style alignment + aspect + equal margins.
//
// Three concerns, all independent:
//
//   1. Aspect.   Magnetic ratio snap on (w, h). Five canonical PiP aspects.
//                Engages on corner drag (and Shift-locked edge drag); couples
//                w and h together by projecting onto the aspect line.
//
//   2. Position. Per-axis snap on x and y. Stops are edge-flush, centered,
//                and rule-of-thirds / golden-ratio "center-on-line" anchors.
//                Each axis is independent.
//
//   3. Margins.  Equal-margin matching is the iconic PiP move ("if right is
//                25, bottom should also be 25"). Four adjacent-corner pair-
//                equalities (right=bottom, right=top, left=bottom, left=top)
//                pull the inset onto the equality diagonal in (x, y) space.
//                Centered-axis (left=right, top=bottom) and fully-symmetric
//                (all four equal) are recognition states, not separate snaps.
// ============================================================================

// ---- 1. Aspect ------------------------------------------------------------

const CANONICAL_PIP_ASPECTS: readonly { label: string; ratio: number }[] = [
  { label: '1:1', ratio: 1 },
  { label: '4:3', ratio: 4 / 3 },
  { label: '3:4', ratio: 3 / 4 },
  { label: '16:9', ratio: 16 / 9 },
  { label: '9:16', ratio: 9 / 16 },
];

export interface PipAspectTarget {
  /** Display label, e.g. `"1:1"`, `"16:9"`. */
  label: string;
  /** w / h as it appears on screen (i.e. in actual pixels). */
  ratio: number;
  /** Slope on the (w_norm, h_norm) plane: h_norm = slope * w_norm.
   *  Derived from `ratio = (w_norm * out.w) / (h_norm * out.h)`. */
  slope: number;
}

/** Canonical aspect lines for the given output aspect. The set is fixed
 *  (1:1, 4:3, 3:4, 16:9, 9:16); the `slope` differs per output because the
 *  normalized coordinate space has the output's aspect ratio baked in. */
export function pipAspectTargets(aspect: AspectRatio): PipAspectTarget[] {
  const out = OUTPUT_DIMS[aspect];
  return CANONICAL_PIP_ASPECTS.map(({ label, ratio }) => ({
    label,
    ratio,
    slope: out.w / (out.h * ratio),
  }));
}

/** Perpendicular distance from `(w, h)` to the line `h = slope * w`. */
function aspectDistance(w: number, h: number, slope: number): number {
  return Math.abs(slope * w - h) / Math.sqrt(slope * slope + 1);
}

/** The aspect-fit target (if any) within snap range of the current `(w, h)`.
 *  Tie-break is closest line. Returns `null` when no canonical aspect is in
 *  range or when (w, h) is degenerate. */
export function matchActiveAspect(
  aspect: AspectRatio,
  w: number,
  h: number,
  threshold = SNAP_THRESHOLD,
): PipAspectTarget | null {
  if (w <= 0 || h <= 0) return null;
  let best: { target: PipAspectTarget; dist: number } | null = null;
  for (const target of pipAspectTargets(aspect)) {
    const dist = aspectDistance(w, h, target.slope);
    if (dist >= threshold) continue;
    if (!best || dist < best.dist) best = { target, dist };
  }
  return best?.target ?? null;
}

/** Project `(w, h)` perpendicularly onto the line `h = slope * w`. Used
 *  during corner drag (and Shift-locked edge drag) to couple `w` and `h`
 *  onto an engaged aspect line. */
export function projectToAspect(
  w: number,
  h: number,
  slope: number,
): { w: number; h: number } {
  const k = slope;
  const wp = (w + k * h) / (1 + k * k);
  return { w: wp, h: k * wp };
}

// ---- 2. Position ----------------------------------------------------------

export type PipAxisLabel = 'flush' | 'center' | '⅓' | '⅔' | 'φ';

/** Priority for tie-breaking when two targets sit at the same value within
 *  the snap threshold. Lower wins. `flush > center > gridline` reflects the
 *  precedence rule in the plan: flush disappears the margin (most decisive),
 *  centered balances it, gridline composes it. */
const AXIS_PRIORITY: Record<PipAxisLabel, number> = {
  flush: 0,
  center: 1,
  '⅓': 2,
  '⅔': 2,
  φ: 2,
};

// Tiered capture distances: flush stays grabby (you want to land on an edge),
// center is moderate, gridlines are a deliberate catch — present, but not
// yanking the inset around in normal drag.
const AXIS_CAPTURE_BY_LABEL: Record<PipAxisLabel, number> = {
  flush: 0.035,
  center: 0.025,
  '⅓': 0.015,
  '⅔': 0.015,
  φ: 0.015,
};

/** Per-label capture threshold for the position-axis snap. Exposed so the
 *  drag hook can compute the matching release threshold for hysteresis. */
export function axisCaptureThreshold(label: PipAxisLabel): number {
  return AXIS_CAPTURE_BY_LABEL[label];
}

export interface PipAxisTarget {
  value: number;
  label: PipAxisLabel;
  /** `'leading'` = left-flush / top-flush; `'trailing'` = right-flush /
   *  bottom-flush. Always `'leading'` for non-flush stops. Used by the
   *  overlay to know which edge to paint a guide along. */
  side: 'leading' | 'trailing' | 'center';
}

/** Single-axis snap stops for the inset position along one axis. `extent` is
 *  the inset's size along that axis (`w` for x, `h` for y). Returns:
 *
 *  - 2 edge-flush stops (`value = 0` and `value = 1 - extent`)
 *  - 1 centered stop (`value = 0.5 - extent / 2`)
 *  - 4 compositional gridline center-on-line stops (⅓, ⅔, φ⁻¹, 1−φ⁻¹)
 *
 *  Total: 7 stops per axis. */
export function pipAxisTargets(extent: number): PipAxisTarget[] {
  return [
    { value: 0, label: 'flush', side: 'leading' },
    { value: 1 - extent, label: 'flush', side: 'trailing' },
    { value: 0.5 - extent / 2, label: 'center', side: 'center' },
    { value: THIRD - extent / 2, label: '⅓', side: 'center' },
    { value: TWO_THIRDS - extent / 2, label: '⅔', side: 'center' },
    { value: ONE_MINUS_PHI_INV - extent / 2, label: 'φ', side: 'center' },
    { value: PHI_INV - extent / 2, label: 'φ', side: 'center' },
  ];
}

/** Active snap stop (if any) for one axis. Resolves precedence with
 *  `AXIS_PRIORITY`: when two stops are within threshold at near-equal
 *  distance, the higher-priority (lower number) wins.
 *
 *  Capture distance is per-label (see `AXIS_CAPTURE_BY_LABEL`) so flush is
 *  grabby, gridlines are a deliberate catch. Pass an explicit `threshold` to
 *  override uniformly (used by tests and for the hysteresis release window). */
export function matchActiveAxis(
  value: number,
  extent: number,
  threshold?: number,
): PipAxisTarget | null {
  let best: { target: PipAxisTarget; dist: number } | null = null;
  for (const target of pipAxisTargets(extent)) {
    const dist = Math.abs(value - target.value);
    const cap = threshold ?? AXIS_CAPTURE_BY_LABEL[target.label];
    if (dist >= cap) continue;
    if (!best) {
      best = { target, dist };
      continue;
    }
    const bp = AXIS_PRIORITY[best.target.label];
    const tp = AXIS_PRIORITY[target.label];
    if (tp < bp || (tp === bp && dist < best.dist)) {
      best = { target, dist };
    }
  }
  return best?.target ?? null;
}

// ---- 3. Margins ----------------------------------------------------------

// Margin equality is measured in output pixels, not fractions. On a 9:16 frame
// a 5% right margin (36px) and a 5% bottom margin (64px) look nothing alike —
// users say "150px from the corner" and expect an L-shape. The threshold is a
// pixel distance so it reads the same regardless of frame aspect.
export const EQUAL_MARGIN_PX_THRESHOLD = 24;

export type PipMarginPair = 'right=bottom' | 'right=top' | 'left=bottom' | 'left=top';

export interface PipEqualMarginsMatch {
  /** Adjacent-corner pair-equalities engaged (within threshold). */
  pairs: PipMarginPair[];
  /** True when `left ≈ right` — equivalent to centered-x. */
  centeredX: boolean;
  /** True when `top ≈ bottom` — equivalent to centered-y. */
  centeredY: boolean;
  /** True when all four margins are within threshold of each other. */
  fullySymmetric: boolean;
}

const NO_EQUAL_MARGINS: PipEqualMarginsMatch = {
  pairs: [],
  centeredX: false,
  centeredY: false,
  fullySymmetric: false,
};

function marginPixelsFromLayout(
  layout: PipLayout,
  aspect: AspectRatio,
): { left: number; right: number; top: number; bottom: number } {
  const out = OUTPUT_DIMS[aspect];
  return {
    left: layout.inset.x * out.w,
    right: (1 - layout.inset.x - layout.inset.w) * out.w,
    top: layout.inset.y * out.h,
    bottom: (1 - layout.inset.y - layout.inset.h) * out.h,
  };
}

/** Recognition state for margin equalities on a layout. Computed post-snap
 *  so the overlay can light up matching chips whenever margins land equal —
 *  whether via active pull or coincidence. Equality is in output pixels
 *  (see {@link EQUAL_MARGIN_PX_THRESHOLD}). */
export function matchEqualMargins(
  layout: PipLayout,
  aspect: AspectRatio,
  threshold = EQUAL_MARGIN_PX_THRESHOLD,
): PipEqualMarginsMatch {
  const { left, right, top, bottom } = marginPixelsFromLayout(layout, aspect);
  const eq = (a: number, b: number) => Math.abs(a - b) < threshold;

  const centeredX = eq(left, right);
  const centeredY = eq(top, bottom);

  const pairs: PipMarginPair[] = [];
  if (eq(right, bottom)) pairs.push('right=bottom');
  if (eq(right, top)) pairs.push('right=top');
  if (eq(left, bottom)) pairs.push('left=bottom');
  if (eq(left, top)) pairs.push('left=top');

  const fullySymmetric = centeredX && centeredY && eq(left, top);

  return { pairs, centeredX, centeredY, fullySymmetric };
}

/** Find the adjacent-corner margin pair (if any) that the current layout is
 *  closest to within threshold (in output pixels). Only the four adjacent-
 *  corner pairs are considered — opposing pairs (left=right, top=bottom) are
 *  handled by the centered-axis position snap, not by equal-margin pull. */
export function findActiveMarginPair(
  layout: PipLayout,
  aspect: AspectRatio,
  threshold = EQUAL_MARGIN_PX_THRESHOLD,
): PipMarginPair | null {
  const { left, right, top, bottom } = marginPixelsFromLayout(layout, aspect);
  const candidates: { pair: PipMarginPair; diff: number }[] = [
    { pair: 'right=bottom', diff: Math.abs(right - bottom) },
    { pair: 'right=top', diff: Math.abs(right - top) },
    { pair: 'left=bottom', diff: Math.abs(left - bottom) },
    { pair: 'left=top', diff: Math.abs(left - top) },
  ];
  let best: { pair: PipMarginPair; diff: number } | null = null;
  for (const c of candidates) {
    if (c.diff >= threshold) continue;
    if (!best || c.diff < best.diff) best = c;
  }
  return best?.pair ?? null;
}

/** Project `(x, y)` perpendicularly onto the equality line for the given
 *  adjacent-corner margin pair. The constraint is pixel-equality, so the
 *  line lives in fraction space with coefficients scaled by output pixel
 *  dimensions — that's what makes the pull match "150px from the corner"
 *  intuition rather than "5% of each axis." */
export function projectToEqualMargin(
  pair: PipMarginPair,
  x: number,
  y: number,
  w: number,
  h: number,
  aspect: AspectRatio,
): { x: number; y: number } {
  const out = OUTPUT_DIMS[aspect];
  const outW = out.w;
  const outH = out.h;
  let a: number;
  let b: number;
  let c: number;
  switch (pair) {
    case 'left=top':
      a = outW;
      b = -outH;
      c = 0;
      break;
    case 'right=bottom':
      a = outW;
      b = -outH;
      c = outW * (1 - w) - outH * (1 - h);
      break;
    case 'right=top':
      a = outW;
      b = outH;
      c = outW * (1 - w);
      break;
    case 'left=bottom':
      a = outW;
      b = outH;
      c = outH * (1 - h);
      break;
  }
  const t = (a * x + b * y - c) / (a * a + b * b);
  return { x: x - a * t, y: y - b * t };
}

export { NO_EQUAL_MARGINS };

// ============================================================================
// Split snap model — unchanged from the prior pass. Aspect-fit / proportion /
// unlabeled-geometric buckets; per-pane labels exposed via matchLabeledStop.
// ============================================================================

// Aspect-fit dividers, by output aspect. Each entry is the "leading-pane
// lands on this aspect" form; the trailing-pane mirror is auto-derived at
// `1 - divider`. Only the *leading-pane* case appears here — listing the
// trailing case as well would double-count once mirroring runs.
//   leading = left for 16:9, top for 9:16 / 4:5.
const ASPECT_FIT_LEADING: Record<AspectRatio, { divider: number; label: string }[]> = {
  '16_9': [
    { divider: (9 / 16) * (9 / 16), label: '9:16' }, // ≈ 0.3164 — left = 9:16
    { divider: 9 / 16, label: '1:1' },               //   0.5625 — left = square
    { divider: 0.75, label: '4:3' },                 //   0.75   — left = 4:3
  ],
  '9_16': [
    { divider: (9 / 16) * (9 / 16), label: '16:9' }, // ≈ 0.3164 — top = 16:9
    { divider: 9 / 16, label: '1:1' },               //   0.5625 — top = square
    { divider: 0.75, label: '3:4' },                 //   0.75   — top = 3:4
  ],
  '4_5': [
    { divider: (4 / 5) / (16 / 9), label: '16:9' },  //   0.45   — top = 16:9
    { divider: 0.6, label: '4:3' },                  //   0.6    — top = 4:3
    { divider: 0.8, label: '1:1' },                  //   0.8    — top = square
  ],
};

// Proportion stops are output-aspect-independent — they're properties of the
// divider position, not of either pane's aspect. Each stop carries explicit
// per-pane labels: thirds get the pane's own fraction (⅓ / ⅔), φ stops share
// the same name on both panes since the relationship is mutual.
const PROPORTION_TARGETS: readonly {
  divider: number;
  leading: string;
  trailing: string;
}[] = [
  { divider: THIRD, leading: '⅓', trailing: '⅔' },
  { divider: ONE_MINUS_PHI_INV, leading: 'φ', trailing: 'φ' },
  { divider: PHI_INV, leading: 'φ', trailing: 'φ' },
  { divider: TWO_THIRDS, leading: '⅔', trailing: '⅓' },
];

// Unlabeled geometric stops. For 16:9 / 9:16, 0.25 and 0.75 are aspect-fit
// (4:3 / 3:4 panes) so they're hoisted into ASPECT_FIT_LEADING above; for
// 4:5 they're plain quarters (top pane = 16:5 strip — not standard).
const UNLABELED_GEOMETRIC: Record<AspectRatio, readonly number[]> = {
  '16_9': [0.5],
  '9_16': [0.5],
  '4_5': [0.25, 0.5, 0.75],
};

/** A divider position that yields a nameable pane aspect on one side. */
export interface SplitAspectFit {
  divider: number;
  /** Which pane lands on the named aspect. `leading` = left for 16:9, top for
   *  9:16 / 4:5; `trailing` is the opposite pane. */
  side: 'leading' | 'trailing';
  /** Display label, e.g. `"9:16"`, `"1:1"`. */
  label: string;
}

/** A divider position that has a name in its own right (golden ratio, rule of
 *  thirds) but where neither pane lands on a standard aspect. Carries per-pane
 *  labels so the readout can read "33% · ⅓" on one side and "67% · ⅔" on the
 *  other at thirds stops, while still showing "φ" on both at golden ones. */
export interface SplitProportion {
  divider: number;
  leading: string;
  trailing: string;
}

/** Tagged union returned by {@link matchLabeledStop}. The overlay reads `kind`
 *  to pick the visual treatment — pane outline + chip for aspect-fit, plain
 *  chip on each pane for proportion. */
export type LabeledSplitStop =
  | ({ kind: 'aspect-fit' } & SplitAspectFit)
  | ({ kind: 'proportion' } & SplitProportion);

/** Aspect-fit stops for a given output aspect. Symmetric: every leading-side
 *  stop has a `1 - d` trailing-side mirror. Pure; safe to call from render. */
export function splitAspectFitTargets(aspect: AspectRatio): SplitAspectFit[] {
  const out: SplitAspectFit[] = [];
  for (const { divider, label } of ASPECT_FIT_LEADING[aspect]) {
    out.push({ divider, side: 'leading', label });
    out.push({ divider: 1 - divider, side: 'trailing', label });
  }
  return out;
}

/** Output-aspect-independent proportion stops (φ, thirds). */
export function splitProportionTargets(): SplitProportion[] {
  return PROPORTION_TARGETS.map((t) => ({
    divider: t.divider,
    leading: t.leading,
    trailing: t.trailing,
  }));
}

export function splitSnapTargets(aspect: AspectRatio): number[] {
  const aspectFit = splitAspectFitTargets(aspect).map((t) => t.divider);
  const proportion = PROPORTION_TARGETS.map((t) => t.divider);
  return [...UNLABELED_GEOMETRIC[aspect], ...proportion, ...aspectFit];
}

/** Match a snapped divider back to its label, if any. Aspect-fit wins ties:
 *  a pane-anchored aspect chip is more informative than a shared proportion
 *  chip. Returns `null` for unlabeled geometric stops. Equality is exact —
 *  callers pass the canonical value from {@link findActiveSnapTarget}, not
 *  raw drag values. */
export function matchLabeledStop(
  aspect: AspectRatio,
  divider: number,
): LabeledSplitStop | null {
  for (const t of splitAspectFitTargets(aspect)) {
    if (t.divider === divider) return { kind: 'aspect-fit', ...t };
  }
  for (const t of PROPORTION_TARGETS) {
    if (t.divider === divider) {
      return {
        kind: 'proportion',
        divider: t.divider,
        leading: t.leading,
        trailing: t.trailing,
      };
    }
  }
  return null;
}
