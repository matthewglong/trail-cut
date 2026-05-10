import { describe, it, expect } from 'vitest';
import {
  SNAP_THRESHOLD,
  snap,
  findActiveSnapTarget,
  pipSnapTargets,
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
  it('includes the spec set for 16_9', () => {
    const t = splitSnapTargets('16_9');
    expect(t).toEqual([0.25, 1 / 3, 0.5, 0.618, 2 / 3, 0.75]);
  });

  it('includes the same set for 9_16', () => {
    expect(splitSnapTargets('9_16')).toEqual([0.25, 1 / 3, 0.5, 0.618, 2 / 3, 0.75]);
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
