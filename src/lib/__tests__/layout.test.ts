// Pure-geometry tests for the layout descriptor module (task 050).
//
// The shared fixture at `src-tauri/tests/fixtures/layout_parity.json` is
// loaded here AND by `src-tauri/tests/layout_parity.rs`; both ports compute
// `resolveSlots` / `resolve_slots` against the same `(layout, aspect)` cases
// and assert identical `SlotResolution`. Drift between the TS source-of-truth
// and the Rust mirror surfaces as a fixture-driven test failure.

import { describe, it, expect } from 'vitest';
import {
  OUTPUT_DIMS,
  resolveSlots,
  defaultLayout,
  defaultPipLayout,
  defaultSplitLayout,
  legalSplitSides,
  clampLayout,
  synthesizeLayoutForMode,
  type AspectRatio,
  type LayoutConfig,
  type SlotResolution,
  type SplitSide,
} from '../layout';
import rawFixture from '../../../src-tauri/tests/fixtures/layout_parity.json';

interface FixtureCase {
  name: string;
  aspect: AspectRatio;
  layout: LayoutConfig;
  expected: SlotResolution;
}

interface Fixture {
  doc: string;
  cases: FixtureCase[];
}

const fixture = rawFixture as unknown as Fixture;

describe('resolveSlots — shared parity fixture', () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const got = resolveSlots(c.layout, c.aspect);
      expect(got).toEqual(c.expected);
    });
  }
});

describe('resolveSlots — purity contract', () => {
  it('returns identical output across repeated calls', () => {
    const layout: LayoutConfig = {
      mode: 'pip',
      inset_source: 'map',
      inset: { x: 0.5, y: 0.5, w: 0.3, h: 0.3 },
      corner_radius: 0.01,
    };
    const a = resolveSlots(layout, '9_16');
    const b = resolveSlots(layout, '9_16');
    expect(a).toEqual(b);
  });

  it('does not mutate a frozen input', () => {
    const layout = Object.freeze({
      mode: 'pip',
      inset_source: 'video',
      inset: Object.freeze({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }),
      corner_radius: 0.02,
    }) as LayoutConfig;
    expect(() => resolveSlots(layout, '16_9')).not.toThrow();
  });
});

describe('defaultLayout — sanity', () => {
  const aspects: AspectRatio[] = ['9_16', '16_9', '4_5'];

  for (const aspect of aspects) {
    it(`${aspect}: produces a non-degenerate slot rect`, () => {
      const layout = defaultLayout(aspect);
      const resolved = resolveSlots(layout, aspect);
      // Both slots must have positive area; corner radius must be positive
      // (defaults are PiP with a small rounded corner).
      expect(resolved.map_slot.w).toBeGreaterThan(0);
      expect(resolved.map_slot.h).toBeGreaterThan(0);
      expect(resolved.video_slot.w).toBeGreaterThan(0);
      expect(resolved.video_slot.h).toBeGreaterThan(0);
      expect(resolved.corner_radius_px).toBeGreaterThan(0);
      expect(resolved.output).toEqual(OUTPUT_DIMS[aspect]);
    });

    it(`${aspect}: default layout's inset stays inside the output frame`, () => {
      const layout = defaultLayout(aspect);
      // defaultLayout currently returns PiP only — guard, then check bounds.
      if (layout.mode !== 'pip') throw new Error('expected PiP default');
      const resolved = resolveSlots(layout, aspect);
      const inset =
        layout.inset_source === 'map' ? resolved.map_slot : resolved.video_slot;
      expect(inset.x + inset.w).toBeLessThanOrEqual(resolved.output.w);
      expect(inset.y + inset.h).toBeLessThanOrEqual(resolved.output.h);
    });
  }
});

describe('defaultPipLayout — agreement with defaultLayout', () => {
  const aspects: AspectRatio[] = ['9_16', '16_9', '4_5'];
  for (const aspect of aspects) {
    it(`${aspect}: defaultPipLayout and defaultLayout return identical layouts`, () => {
      // Back-compat contract: every call site that uses `defaultLayout` today
      // gets the same PiP starter when 110's mode toggle synthesizes via
      // `defaultPipLayout`.
      expect(defaultPipLayout(aspect)).toEqual(defaultLayout(aspect));
    });
  }
});

describe('defaultSplitLayout — aspect-locked orientation', () => {
  it('9:16 starts with video on top, divider 0.5', () => {
    expect(defaultSplitLayout('9_16')).toEqual({
      mode: 'split',
      video_side: 'top',
      divider: 0.5,
    });
  });

  it('4:5 starts with video on top, divider 0.5', () => {
    expect(defaultSplitLayout('4_5')).toEqual({
      mode: 'split',
      video_side: 'top',
      divider: 0.5,
    });
  });

  it('16:9 starts with video on left, divider 0.5', () => {
    expect(defaultSplitLayout('16_9')).toEqual({
      mode: 'split',
      video_side: 'left',
      divider: 0.5,
    });
  });

  const aspects: AspectRatio[] = ['9_16', '16_9', '4_5'];
  for (const aspect of aspects) {
    it(`${aspect}: produces non-degenerate slot rects`, () => {
      const resolved = resolveSlots(defaultSplitLayout(aspect), aspect);
      expect(resolved.map_slot.w * resolved.map_slot.h).toBeGreaterThan(0);
      expect(resolved.video_slot.w * resolved.video_slot.h).toBeGreaterThan(0);
      expect(resolved.corner_radius_px).toBe(0);
      expect(resolved.corner_radius_slot).toBe('none');
    });
  }
});

describe('legalSplitSides — aspect orientation lock', () => {
  it('9:16 returns [top, bottom]', () => {
    expect(legalSplitSides('9_16')).toEqual(['top', 'bottom']);
  });

  it('4:5 returns [top, bottom]', () => {
    expect(legalSplitSides('4_5')).toEqual(['top', 'bottom']);
  });

  it('16:9 returns [left, right]', () => {
    expect(legalSplitSides('16_9')).toEqual(['left', 'right']);
  });

  it("defaultSplitLayout's video_side is in legalSplitSides for every aspect", () => {
    const aspects: AspectRatio[] = ['9_16', '16_9', '4_5'];
    for (const aspect of aspects) {
      const layout = defaultSplitLayout(aspect);
      const legal = legalSplitSides(aspect);
      expect(legal.includes(layout.video_side as SplitSide)).toBe(true);
    }
  });
});

describe('clampLayout', () => {
  it('passes through a valid PiP layout unchanged', () => {
    const layout: LayoutConfig = {
      mode: 'pip',
      inset_source: 'map',
      inset: { x: 0.65, y: 0.78, w: 0.32, h: 0.18 },
      corner_radius: 0.012,
    };
    expect(clampLayout(layout, '9_16')).toEqual(layout);
  });

  it('clamps PiP coordinates so the inset stays inside the frame', () => {
    const out = clampLayout(
      {
        mode: 'pip',
        inset_source: 'map',
        inset: { x: 0.9, y: 0.95, w: 0.4, h: 0.3 },
        corner_radius: 0.01,
      },
      '9_16',
    );
    if (out.mode !== 'pip') throw new Error('expected PiP');
    expect(out.inset.x + out.inset.w).toBeLessThanOrEqual(1);
    expect(out.inset.y + out.inset.h).toBeLessThanOrEqual(1);
    expect(out.inset.w).toBeGreaterThan(0);
    expect(out.inset.h).toBeGreaterThan(0);
  });

  it('clamps PiP coordinates that go negative back to zero', () => {
    const out = clampLayout(
      {
        mode: 'pip',
        inset_source: 'video',
        inset: { x: -0.2, y: -0.3, w: 0.3, h: 0.3 },
        corner_radius: 0.01,
      },
      '4_5',
    );
    if (out.mode !== 'pip') throw new Error('expected PiP');
    expect(out.inset.x).toBe(0);
    expect(out.inset.y).toBe(0);
  });

  it('clamps a PiP corner_radius outside [0, 0.5] back to range', () => {
    const a = clampLayout(
      {
        mode: 'pip',
        inset_source: 'map',
        inset: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        corner_radius: -0.5,
      },
      '9_16',
    );
    if (a.mode !== 'pip') throw new Error('expected PiP');
    expect(a.corner_radius).toBe(0);

    const b = clampLayout(
      {
        mode: 'pip',
        inset_source: 'map',
        inset: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        corner_radius: 99,
      },
      '9_16',
    );
    if (b.mode !== 'pip') throw new Error('expected PiP');
    expect(b.corner_radius).toBe(0.5);
  });

  it('clamps Split divider outside [0.05, 0.95] back to the boundary', () => {
    expect(
      clampLayout({ mode: 'split', video_side: 'top', divider: 0.0 }, '9_16'),
    ).toEqual({ mode: 'split', video_side: 'top', divider: 0.05 });
    expect(
      clampLayout({ mode: 'split', video_side: 'left', divider: 1.5 }, '16_9'),
    ).toEqual({ mode: 'split', video_side: 'left', divider: 0.95 });
  });

  it('passes through a valid Split layout unchanged', () => {
    const layout: LayoutConfig = {
      mode: 'split',
      video_side: 'top',
      divider: 0.5,
    };
    expect(clampLayout(layout, '4_5')).toEqual(layout);
  });
});

describe('synthesizeLayoutForMode', () => {
  const aspects: AspectRatio[] = ['9_16', '16_9', '4_5'];
  for (const aspect of aspects) {
    it(`${aspect}: pip mode delegates to defaultPipLayout`, () => {
      expect(synthesizeLayoutForMode('pip', aspect)).toEqual(defaultPipLayout(aspect));
    });
    it(`${aspect}: split mode delegates to defaultSplitLayout`, () => {
      expect(synthesizeLayoutForMode('split', aspect)).toEqual(defaultSplitLayout(aspect));
    });
  }

  it('ignores the hint parameter in v1', () => {
    const hint: LayoutConfig = {
      mode: 'pip',
      inset_source: 'video',
      inset: { x: 0.5, y: 0.5, w: 0.4, h: 0.4 },
      corner_radius: 0.04,
    };
    expect(synthesizeLayoutForMode('split', '9_16', hint)).toEqual(
      defaultSplitLayout('9_16'),
    );
  });
});
