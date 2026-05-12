import { describe, it, expect } from 'vitest';
import {
  SNAP_THRESHOLD,
  snap,
  findActiveSnapTarget,
  matchLabeledStop,
  pipSnapTargets,
  splitAspectFitTargets,
  splitProportionTargets,
  splitSnapTargets,
} from '../snap';
import type { PipLayout } from '../../../lib/layout';

describe('SNAP_THRESHOLD', () => {
  it('is 0.05 (5%) for user-facing UX', () => {
    expect(SNAP_THRESHOLD).toBe(0.05);
  });
});

describe('snap helper', () => {
  it('snaps to a target within threshold', () => {
    expect(snap(0.495, [0.5], 0.015)).toBe(0.5);
  });

  it('returns the original value when no target is within threshold', () => {
    expect(snap(0.48, [0.5], 0.015)).toBe(0.48);
  });

  it('chooses the closest target when multiple targets are present', () => {
    expect(snap(0.5, [1 / 3, 0.5, 2 / 3], 0.015)).toBe(0.5);
  });

  it('keeps the original value when the closest target is outside the threshold', () => {
    expect(snap(0.6, [0.5, 0.7], 0.015)).toBe(0.6);
  });

  it('uses SNAP_THRESHOLD when no threshold is passed', () => {
    expect(snap(0.5 - SNAP_THRESHOLD / 2, [0.5])).toBe(0.5);
    expect(snap(0.5 - SNAP_THRESHOLD * 2, [0.5])).toBe(0.5 - SNAP_THRESHOLD * 2);
  });
});

describe('pipSnapTargets', () => {
  const layout: PipLayout = {
    mode: 'pip',
    inset_source: 'map',
    inset: { x: 0.65, y: 0.78, w: 0.32, h: 0.18 },
    corner_radius: 0.012,
  };

  it("includes anchor and rect-extent variants on the x axis at 9_16", () => {
    const t = pipSnapTargets('9_16', layout);
    expect(t.x).toContain(0);
    expect(t.x).toContain(1 - layout.inset.w);
    expect(t.x).toContain(1 / 3);
    expect(t.x).toContain(0.5);
    expect(t.x).toContain(0.618);
    expect(t.x).toContain(2 / 3);
    expect(t.x).toContain(0.382);
  });

  it('y targets mirror x targets but use inset.h', () => {
    const t = pipSnapTargets('9_16', layout);
    expect(t.y).toContain(0);
    expect(t.y).toContain(1 - layout.inset.h);
  });

  it('w / h target arrays include centers and golden-ratio sizes', () => {
    const t = pipSnapTargets('9_16', layout);
    for (const arr of [t.w, t.h]) {
      expect(arr).toContain(1 / 3);
      expect(arr).toContain(0.5);
      expect(arr).toContain(2 / 3);
      expect(arr).toContain(0.618);
      expect(arr).toContain(0.382);
    }
  });
});

describe('splitSnapTargets', () => {
  it('includes every aspect-fit + proportion + unlabeled stop for 16_9', () => {
    const targets = splitSnapTargets('16_9').sort((a, b) => a - b);
    const fit9_16 = (9 / 16) * (9 / 16);
    expect(targets).toEqual(
      [
        0.5,                              // unlabeled
        1 / 3, 0.382, 0.618, 2 / 3,       // proportions
        fit9_16, 1 - fit9_16,             // 9:16 fit pair
        9 / 16, 7 / 16,                   // 1:1 fit pair (leading=9/16, mirror=7/16)
        0.75, 0.25,                       // 4:3 fit pair
      ].sort((a, b) => a - b),
    );
  });

  it('includes 4:5-specific aspect-fit stops (1:1, 4:3, 16:9) for 4_5', () => {
    const targets = splitSnapTargets('4_5');
    // 1 - x in IEEE-754 doesn't always equal the simple decimal mirror
    // (1 - 0.8 = 0.19999…), so compare via closeTo against the canonical set.
    const fit16_9 = (4 / 5) / (16 / 9);
    const expected = [
      0.25, 0.5, 0.75,
      1 / 3, 0.382, 0.618, 2 / 3,
      fit16_9, 1 - fit16_9,
      0.6, 1 - 0.6,
      0.8, 1 - 0.8,
    ].sort((a, b) => a - b);
    const sorted = [...targets].sort((a, b) => a - b);
    expect(sorted).toHaveLength(expected.length);
    sorted.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 10));
  });
});

describe('splitAspectFitTargets', () => {
  it('emits a leading + trailing entry for every aspect at 16_9', () => {
    const fit = (9 / 16) * (9 / 16);
    expect(splitAspectFitTargets('16_9')).toEqual([
      { divider: fit, side: 'leading', label: '9:16' },
      { divider: 1 - fit, side: 'trailing', label: '9:16' },
      { divider: 9 / 16, side: 'leading', label: '1:1' },
      { divider: 7 / 16, side: 'trailing', label: '1:1' },
      { divider: 0.75, side: 'leading', label: '4:3' },
      { divider: 0.25, side: 'trailing', label: '4:3' },
    ]);
  });

  it('emits 4:5-specific stops with 1:1, 16:9, 4:3 labels', () => {
    const fit16_9 = (4 / 5) / (16 / 9);
    const result = splitAspectFitTargets('4_5');
    expect(result.map(({ side, label }) => ({ side, label }))).toEqual([
      { side: 'leading', label: '16:9' },
      { side: 'trailing', label: '16:9' },
      { side: 'leading', label: '4:3' },
      { side: 'trailing', label: '4:3' },
      { side: 'leading', label: '1:1' },
      { side: 'trailing', label: '1:1' },
    ]);
    // Dividers checked individually for IEEE-754 tolerance on mirrored values.
    expect(result[0].divider).toBeCloseTo(fit16_9, 10);
    expect(result[1].divider).toBeCloseTo(1 - fit16_9, 10);
    expect(result[2].divider).toBeCloseTo(0.6, 10);
    expect(result[3].divider).toBeCloseTo(0.4, 10);
    expect(result[4].divider).toBeCloseTo(0.8, 10);
    expect(result[5].divider).toBeCloseTo(0.2, 10);
  });
});

describe('splitProportionTargets', () => {
  it('exposes per-pane labels (each pane gets its own fraction for thirds)', () => {
    expect(splitProportionTargets()).toEqual([
      { divider: 1 / 3, leading: '⅓', trailing: '⅔' },
      { divider: 0.382, leading: 'φ', trailing: 'φ' },
      { divider: 0.618, leading: 'φ', trailing: 'φ' },
      { divider: 2 / 3, leading: '⅔', trailing: '⅓' },
    ]);
  });
});

describe('matchLabeledStop', () => {
  it('returns an aspect-fit match for a named pane stop', () => {
    const fit = (9 / 16) * (9 / 16);
    expect(matchLabeledStop('16_9', fit)).toEqual({
      kind: 'aspect-fit',
      divider: fit,
      side: 'leading',
      label: '9:16',
    });
    expect(matchLabeledStop('16_9', 9 / 16)).toEqual({
      kind: 'aspect-fit',
      divider: 9 / 16,
      side: 'leading',
      label: '1:1',
    });
  });

  it('returns a proportion match with per-pane labels', () => {
    expect(matchLabeledStop('16_9', 1 / 3)).toEqual({
      kind: 'proportion',
      divider: 1 / 3,
      leading: '⅓',
      trailing: '⅔',
    });
    expect(matchLabeledStop('16_9', 0.618)).toEqual({
      kind: 'proportion',
      divider: 0.618,
      leading: 'φ',
      trailing: 'φ',
    });
  });

  it('returns null for unlabeled geometric dividers', () => {
    expect(matchLabeledStop('16_9', 0.5)).toBeNull();
    expect(matchLabeledStop('4_5', 0.25)).toBeNull();
    expect(matchLabeledStop('4_5', 0.75)).toBeNull();
  });
});

describe('findActiveSnapTarget', () => {
  it('returns the target when value is just inside the threshold', () => {
    expect(findActiveSnapTarget(0.5 - 0.04, [0.5], 0.05)).toBe(0.5);
    expect(findActiveSnapTarget(0.5 + 0.04, [0.5], 0.05)).toBe(0.5);
  });

  it('returns null when value is just outside the threshold', () => {
    expect(findActiveSnapTarget(0.5 - 0.06, [0.5], 0.05)).toBeNull();
    expect(findActiveSnapTarget(0.5 + 0.06, [0.5], 0.05)).toBeNull();
  });

  it('returns the closest target when multiple are within threshold', () => {
    expect(findActiveSnapTarget(0.5, [0.4, 0.5, 0.6], 0.05)).toBe(0.5);
    expect(findActiveSnapTarget(0.49, [0.4, 0.5, 0.6], 0.1)).toBe(0.5);
  });

  it('uses SNAP_THRESHOLD by default', () => {
    expect(findActiveSnapTarget(0.5 - SNAP_THRESHOLD / 2, [0.5])).toBe(0.5);
    expect(findActiveSnapTarget(0.5 - SNAP_THRESHOLD * 2, [0.5])).toBeNull();
  });

  it('returns null on an empty target array', () => {
    expect(findActiveSnapTarget(0.5, [], 0.05)).toBeNull();
  });
});
