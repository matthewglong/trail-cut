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
  type AspectRatio,
  type LayoutConfig,
  type SlotResolution,
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
