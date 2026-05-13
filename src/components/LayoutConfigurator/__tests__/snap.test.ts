import { describe, it, expect } from 'vitest';
import {
  SNAP_THRESHOLD,
  EQUAL_MARGIN_PX_THRESHOLD,
  axisCaptureThreshold,
  snap,
  findActiveSnapTarget,
  matchLabeledStop,
  pipAspectTargets,
  matchActiveAspect,
  projectToAspect,
  pipAxisTargets,
  matchActiveAxis,
  matchEqualMargins,
  findActiveMarginPair,
  projectToEqualMargin,
  splitAspectFitTargets,
  splitProportionTargets,
  splitSnapTargets,
} from '../snap';
import { OUTPUT_DIMS } from '../../../lib/layout';
import type { PipLayout } from '../../../lib/layout';

function pipLayout(inset: { x: number; y: number; w: number; h: number }): PipLayout {
  return {
    mode: 'pip',
    inset_source: 'map',
    inset,
    corner_radius: 0,
  };
}

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

// ===========================================================================
// PiP — aspect (1)
// ===========================================================================

describe('pipAspectTargets', () => {
  it('returns the five canonical PiP aspects', () => {
    expect(pipAspectTargets('9_16').map((t) => t.label)).toEqual([
      '1:1', '4:3', '3:4', '16:9', '9:16',
    ]);
    expect(pipAspectTargets('16_9').map((t) => t.label)).toEqual([
      '1:1', '4:3', '3:4', '16:9', '9:16',
    ]);
    expect(pipAspectTargets('4_5').map((t) => t.label)).toEqual([
      '1:1', '4:3', '3:4', '16:9', '9:16',
    ]);
  });

  it('derives slope per output aspect: 1:1 on 9:16 is 1080/1920 = 0.5625', () => {
    const t = pipAspectTargets('9_16').find((t) => t.label === '1:1')!;
    expect(t.slope).toBeCloseTo(1080 / 1920, 6);
  });

  it('derives slope per output aspect: 1:1 on 16:9 is 1920/1080 = 16/9', () => {
    const t = pipAspectTargets('16_9').find((t) => t.label === '1:1')!;
    expect(t.slope).toBeCloseTo(16 / 9, 6);
  });

  it('derives slope per output aspect: 1:1 on 4:5 is 1080/1350 = 0.8', () => {
    const t = pipAspectTargets('4_5').find((t) => t.label === '1:1')!;
    expect(t.slope).toBeCloseTo(1080 / 1350, 6);
  });
});

describe('matchActiveAspect', () => {
  it('matches 1:1 when (w, h) sits exactly on the aspect line', () => {
    // 9:16 output, slope 0.5625. h = 0.5625 * w. Pick w=0.4 → h=0.225.
    const m = matchActiveAspect('9_16', 0.4, 0.225);
    expect(m?.label).toBe('1:1');
  });

  it('matches when within threshold of the aspect line', () => {
    // Slightly off the 1:1 line at 9:16.
    const m = matchActiveAspect('9_16', 0.4, 0.21);
    expect(m?.label).toBe('1:1');
  });

  it('returns null when (w, h) is degenerate', () => {
    expect(matchActiveAspect('9_16', 0, 0.5)).toBeNull();
    expect(matchActiveAspect('9_16', 0.5, 0)).toBeNull();
  });
});

describe('projectToAspect', () => {
  it('projects onto h = slope * w', () => {
    const slope = 0.5625;
    const { w, h } = projectToAspect(0.4, 0.3, slope);
    expect(h / w).toBeCloseTo(slope, 6);
  });

  it('keeps a point already on the line in place', () => {
    const slope = 1.5;
    const { w, h } = projectToAspect(0.2, 0.3, slope);
    expect(w).toBeCloseTo(0.2, 6);
    expect(h).toBeCloseTo(0.3, 6);
  });

  it('projects perpendicularly (closest point on the line)', () => {
    // (1, 0) projected onto h = w: closest is (0.5, 0.5).
    const { w, h } = projectToAspect(1, 0, 1);
    expect(w).toBeCloseTo(0.5, 6);
    expect(h).toBeCloseTo(0.5, 6);
  });
});

// ===========================================================================
// PiP — single-axis position (2)
// ===========================================================================

describe('pipAxisTargets', () => {
  it('returns 7 stops per axis (2 flush + 1 center + 4 gridlines)', () => {
    const targets = pipAxisTargets(0.3);
    expect(targets).toHaveLength(7);
    expect(targets.filter((t) => t.label === 'flush')).toHaveLength(2);
    expect(targets.filter((t) => t.label === 'center')).toHaveLength(1);
    expect(targets.filter((t) => t.label === '⅓')).toHaveLength(1);
    expect(targets.filter((t) => t.label === '⅔')).toHaveLength(1);
    expect(targets.filter((t) => t.label === 'φ')).toHaveLength(2);
  });

  it('places flush stops at value=0 and value=1-extent', () => {
    const targets = pipAxisTargets(0.3);
    const flush = targets.filter((t) => t.label === 'flush').map((t) => t.value).sort();
    expect(flush).toEqual([0, 0.7]);
  });

  it('places center stop so the inset center sits at frame center', () => {
    const target = pipAxisTargets(0.3).find((t) => t.label === 'center')!;
    expect(target.value).toBeCloseTo(0.5 - 0.15, 6);
    expect(target.side).toBe('center');
  });

  it('places gridline stops so the inset center sits on the line', () => {
    const targets = pipAxisTargets(0.3);
    expect(targets.find((t) => t.label === '⅓')!.value).toBeCloseTo(1 / 3 - 0.15, 6);
    expect(targets.find((t) => t.label === '⅔')!.value).toBeCloseTo(2 / 3 - 0.15, 6);
  });

  it('tags flush leading/trailing for guide-line direction', () => {
    const flush = pipAxisTargets(0.3).filter((t) => t.label === 'flush');
    const leading = flush.find((t) => t.value === 0)!;
    const trailing = flush.find((t) => t.value === 0.7)!;
    expect(leading.side).toBe('leading');
    expect(trailing.side).toBe('trailing');
  });
});

describe('matchActiveAxis', () => {
  it('snaps to flush when value is within the flush capture (0.035)', () => {
    const m = matchActiveAxis(0.02, 0.3);
    expect(m?.label).toBe('flush');
    expect(m?.value).toBe(0);
  });

  it('does NOT snap to flush past the flush capture (0.035)', () => {
    // value=0.04 is outside the new flush capture (0.035) but would have been
    // inside the old uniform 0.05 threshold — the tightening kicks in here.
    const m = matchActiveAxis(0.04, 0.3);
    expect(m).toBeNull();
  });

  it('snaps to center when value is within the center capture (0.025)', () => {
    const m = matchActiveAxis(0.36, 0.3);
    expect(m?.label).toBe('center');
    expect(m?.value).toBeCloseTo(0.35, 6);
  });

  it('does NOT snap to center past the center capture (0.025)', () => {
    // center target = 0.35; value=0.38 is 0.03 away — outside new center capture.
    const m = matchActiveAxis(0.38, 0.3);
    expect(m).toBeNull();
  });

  it('snaps to a gridline (⅓) only within the tighter gridline capture (0.015)', () => {
    // extent=0.3, ⅓ stop = 1/3 - 0.15 ≈ 0.1833. value=0.18 → dist ≈ 0.0033.
    const m = matchActiveAxis(0.18, 0.3);
    expect(m?.label).toBe('⅓');
  });

  it('does NOT snap to a gridline past 0.015', () => {
    // ⅓ stop ≈ 0.1833; value=0.165 → dist ≈ 0.0183 > 0.015.
    const m = matchActiveAxis(0.165, 0.3);
    expect(m).toBeNull();
  });

  it('returns null when no stop is within threshold', () => {
    const m = matchActiveAxis(0.6, 0.3);
    expect(m).toBeNull();
  });

  it('prefers flush over gridline when both are within their respective captures', () => {
    // extent=0.4: gridline ⅓ stop = 1/3 - 0.2 ≈ 0.1333. flush=0.
    // value=0.01 → flush dist 0.01 (in 0.035), gridline dist 0.123 (out).
    // Only flush is in range; verifies priority short-circuits on the still-
    // tightened thresholds.
    const m = matchActiveAxis(0.01, 0.4);
    expect(m?.label).toBe('flush');
  });

  it('honors an explicit threshold override (uniform)', () => {
    // value=0.04 with extent=0.3 is 0.04 from flush — outside per-label cap,
    // but inside an override of 0.05.
    const m = matchActiveAxis(0.04, 0.3, 0.05);
    expect(m?.label).toBe('flush');
  });
});

describe('axisCaptureThreshold', () => {
  it('returns the tiered per-label capture distances', () => {
    expect(axisCaptureThreshold('flush')).toBe(0.035);
    expect(axisCaptureThreshold('center')).toBe(0.025);
    expect(axisCaptureThreshold('⅓')).toBe(0.015);
    expect(axisCaptureThreshold('⅔')).toBe(0.015);
    expect(axisCaptureThreshold('φ')).toBe(0.015);
  });
});

// ===========================================================================
// PiP — margins (3)
// ===========================================================================

describe('EQUAL_MARGIN_PX_THRESHOLD', () => {
  it('is a pixel-distance threshold (24px)', () => {
    expect(EQUAL_MARGIN_PX_THRESHOLD).toBe(24);
  });
});

describe('matchEqualMargins', () => {
  it('does NOT report right=bottom when fractions are equal but pixels are not (the bug)', () => {
    // x=0.1, y=0.1, w=0.3, h=0.3 → right_frac = bottom_frac = 0.6. On 9:16
    // that's right_px = 648, bottom_px = 1152 — 504px apart, miles from equal.
    const layout = pipLayout({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 });
    const r = matchEqualMargins(layout, '9_16');
    expect(r.pairs).not.toContain('right=bottom');
  });

  it('recognizes right=bottom equality in pixels on 9:16', () => {
    // right_px = (1 - 0.515 - 0.3)*1080 = 199.8; bottom_px = (1 - 0.596 - 0.3)*1920 = 199.68.
    // |R-B|_px ≈ 0.12px — well within 24px threshold.
    const layout = pipLayout({ x: 0.515, y: 0.596, w: 0.3, h: 0.3 });
    const r = matchEqualMargins(layout, '9_16');
    expect(r.pairs).toContain('right=bottom');
  });

  it('detects centered axes (left=right and top=bottom) regardless of aspect', () => {
    const layout = pipLayout({ x: 0.35, y: 0.35, w: 0.3, h: 0.3 });
    expect(matchEqualMargins(layout, '9_16').centeredX).toBe(true);
    expect(matchEqualMargins(layout, '9_16').centeredY).toBe(true);
    expect(matchEqualMargins(layout, '4_5').centeredX).toBe(true);
    expect(matchEqualMargins(layout, '16_9').centeredY).toBe(true);
  });

  it('detects fully-symmetric when all four margins equal in pixels on 9:16', () => {
    // Construct margins of 200px on every side.
    const out = OUTPUT_DIMS['9_16'];
    const layout = pipLayout({
      x: 200 / out.w,
      y: 200 / out.h,
      w: 1 - 400 / out.w,
      h: 1 - 400 / out.h,
    });
    const r = matchEqualMargins(layout, '9_16');
    expect(r.fullySymmetric).toBe(true);
  });

  it('does NOT report fully-symmetric on 9:16 when fractions are equal but pixels are not', () => {
    // x=0.35, y=0.35, w=0.3, h=0.3 — fraction-symmetric, but on 9:16
    // left_px=378, top_px=672, so vertical and horizontal margins differ.
    const layout = pipLayout({ x: 0.35, y: 0.35, w: 0.3, h: 0.3 });
    expect(matchEqualMargins(layout, '9_16').fullySymmetric).toBe(false);
  });

  it('returns no engagement when all four margins are distinct', () => {
    const layout = pipLayout({ x: 0.1, y: 0.7, w: 0.4, h: 0.1 });
    const r = matchEqualMargins(layout, '9_16');
    expect(r.pairs).toEqual([]);
    expect(r.centeredX).toBe(false);
    expect(r.centeredY).toBe(false);
    expect(r.fullySymmetric).toBe(false);
  });
});

describe('findActiveMarginPair', () => {
  it('returns the closest adjacent-corner pair within threshold (pixel space)', () => {
    // 9:16 with right_px ≈ bottom_px ≈ 200; other pairs are far apart.
    const layout = pipLayout({ x: 0.515, y: 0.596, w: 0.3, h: 0.3 });
    expect(findActiveMarginPair(layout, '9_16')).toBe('right=bottom');
  });

  it('does NOT engage on 9:16 when only fractions are equal (the bug case)', () => {
    // Equal fractions but right_px=648, bottom_px=1152 — way past 24px.
    const layout = pipLayout({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 });
    expect(findActiveMarginPair(layout, '9_16')).toBeNull();
  });

  it('returns null when no adjacent pair is within threshold', () => {
    const layout = pipLayout({ x: 0.1, y: 0.7, w: 0.4, h: 0.1 });
    expect(findActiveMarginPair(layout, '9_16')).toBeNull();
  });
});

describe('projectToEqualMargin', () => {
  it('right=bottom on 9:16: post-projection right_px ≈ bottom_px', () => {
    const out = OUTPUT_DIMS['9_16'];
    const w = 0.3;
    const h = 0.3;
    const { x, y } = projectToEqualMargin('right=bottom', 0.4, 0.2, w, h, '9_16');
    const rightPx = (1 - x - w) * out.w;
    const bottomPx = (1 - y - h) * out.h;
    expect(rightPx).toBeCloseTo(bottomPx, 4);
  });

  it('left=top on 9:16: post-projection left_px ≈ top_px', () => {
    const out = OUTPUT_DIMS['9_16'];
    const { x, y } = projectToEqualMargin('left=top', 0.3, 0.1, 0.2, 0.2, '9_16');
    expect(x * out.w).toBeCloseTo(y * out.h, 4);
  });

  it('right=top on 9:16: post-projection right_px ≈ top_px', () => {
    const out = OUTPUT_DIMS['9_16'];
    const w = 0.3;
    const { x, y } = projectToEqualMargin('right=top', 0.6, 0.1, w, 0.2, '9_16');
    const rightPx = (1 - x - w) * out.w;
    expect(rightPx).toBeCloseTo(y * out.h, 4);
  });

  it('left=bottom on 9:16: post-projection left_px ≈ bottom_px', () => {
    const out = OUTPUT_DIMS['9_16'];
    const h = 0.3;
    const { x, y } = projectToEqualMargin('left=bottom', 0.1, 0.6, 0.2, h, '9_16');
    const bottomPx = (1 - y - h) * out.h;
    expect(x * out.w).toBeCloseTo(bottomPx, 4);
  });

  it('preserves a layout that already satisfies the pixel-equality', () => {
    // Construct (x, y) so right_px = bottom_px = 200 on 9:16.
    const out = OUTPUT_DIMS['9_16'];
    const w = 0.3;
    const h = 0.3;
    const x = 1 - w - 200 / out.w;
    const y = 1 - h - 200 / out.h;
    const r = projectToEqualMargin('right=bottom', x, y, w, h, '9_16');
    expect(r.x).toBeCloseTo(x, 6);
    expect(r.y).toBeCloseTo(y, 6);
  });

  it('left=top equality line tilts with output aspect (the cross-aspect fix)', () => {
    // On 9:16 the line is x*1080 = y*1920, i.e. y/x = 9/16. On 16:9 it
    // flips to y/x = 16/9. Same fraction-space input projects onto two
    // different lines because the pixel meaning differs.
    const r9 = projectToEqualMargin('left=top', 0.4, 0.2, 0.2, 0.2, '9_16');
    expect(r9.y / r9.x).toBeCloseTo(1080 / 1920, 4);
    const r16 = projectToEqualMargin('left=top', 0.4, 0.2, 0.2, 0.2, '16_9');
    expect(r16.y / r16.x).toBeCloseTo(1920 / 1080, 4);
  });
});

// ===========================================================================
// Split helpers (unchanged from prior pass)
// ===========================================================================

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
