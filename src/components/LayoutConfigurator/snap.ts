import type { AspectRatio, PipLayout } from '../../lib/layout';

export const SNAP_THRESHOLD = 0.05;

export interface PipSnapTargets {
  x: number[];
  y: number[];
  w: number[];
  h: number[];
}

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

function positionTargetsFor(rectExtent: number): number[] {
  return [
    0,
    1 - rectExtent,
    0.5,
    0.5 - rectExtent / 2,
    THIRD,
    THIRD - rectExtent,
    TWO_THIRDS,
    TWO_THIRDS - rectExtent,
    ONE_MINUS_PHI_INV,
    ONE_MINUS_PHI_INV - rectExtent,
    PHI_INV,
    PHI_INV - rectExtent,
  ];
}

function sizeTargets(): number[] {
  return [THIRD, 0.5, TWO_THIRDS, ONE_MINUS_PHI_INV, PHI_INV];
}

export function pipSnapTargets(_aspect: AspectRatio, layout: PipLayout): PipSnapTargets {
  return {
    x: positionTargetsFor(layout.inset.w),
    y: positionTargetsFor(layout.inset.h),
    w: sizeTargets(),
    h: sizeTargets(),
  };
}

// Split snap stops fall into three buckets:
//   - aspect-fit:    one pane lands on a nameable source aspect (9:16, 16:9,
//                    4:3, 3:4, 1:1). That pane gets the aspect chip.
//   - proportion:    the cut sits at a named proportion (φ, 1/3, 2/3). Both
//                    panes share the label since the relationship is mutual.
//   - unlabeled:     self-evident positions (0.5; 0.25/0.75 where they don't
//                    yield a standard aspect). Snap, no label.
//
// `splitSnapTargets` returns the flat numeric union for `findActiveSnapTarget`;
// `matchLabeledStop` runs after a snap engages to figure out what to render.

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
