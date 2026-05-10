import type { AspectRatio, PipLayout } from '../../lib/layout';

export const SNAP_THRESHOLD = 0.015;

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

export function snap(value: number, targets: number[], threshold = SNAP_THRESHOLD): number {
  let best = value;
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

export function splitSnapTargets(_aspect: AspectRatio): number[] {
  return [0.25, THIRD, 0.5, PHI_INV, TWO_THIRDS, 0.75];
}
