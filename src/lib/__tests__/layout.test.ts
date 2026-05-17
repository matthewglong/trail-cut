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
  canonicalMapCssWidth,
  canonicalMapViewport,
  outputDims,
  resolveSlots,
  defaultLayout,
  defaultPipLayout,
  defaultSplitLayout,
  legalSplitSides,
  clampLayout,
  synthesizeLayoutForMode,
  type AspectRatio,
  type LayoutConfig,
  type OutputResolution,
  type SlotResolution,
  type SplitSide,
} from '../layout';
import rawFixture from '../../../src-tauri/tests/fixtures/layout_parity.json';

interface ExpectedCanonicalMapViewport {
  css_w: number;
  css_h: number;
  pixel_ratio: number;
}

interface FixtureCase {
  name: string;
  aspect: AspectRatio;
  /** Optional. Cases that omit it test the default-resolution path (1080p);
   *  cases that set it exercise the Phase 4 resolution-aware code. */
  resolution?: OutputResolution;
  layout: LayoutConfig;
  expected: SlotResolution;
  /** Optional in the schema (gracefully tolerates new cases that haven't been
   *  augmented yet) but every case currently carries it; the parity test below
   *  asserts presence. */
  expected_canonical_map_viewport?: ExpectedCanonicalMapViewport;
}

interface Fixture {
  doc: string;
  cases: FixtureCase[];
}

const fixture = rawFixture as unknown as Fixture;

describe('resolveSlots — shared parity fixture', () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      // Phase 5: cases now optionally carry a `resolution` field (mirrors the
      // Rust fixture loader's `#[serde(default)]`). Pre-Phase-5 cases omit it
      // and exercise the 1080p default path; the new non-1080p cases pin the
      // resolution-aware math against the same fixture.
      const got = resolveSlots(c.layout, c.aspect, c.resolution);
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
      expect(resolved.map_slot.w).toBeGreaterThan(0);
      expect(resolved.map_slot.h).toBeGreaterThan(0);
      expect(resolved.video_slot.w).toBeGreaterThan(0);
      expect(resolved.video_slot.h).toBeGreaterThan(0);
      expect(resolved.output).toEqual(OUTPUT_DIMS[aspect]);
    });

    it(`${aspect}: default layout's slots tile the output frame`, () => {
      const layout = defaultLayout(aspect);
      if (layout.mode !== 'split') throw new Error('expected Split default');
      const resolved = resolveSlots(layout, aspect);
      // Split slots partition the output: their combined area equals the
      // frame's area, and each individually fits inside the frame.
      const total = resolved.map_slot.w * resolved.map_slot.h
        + resolved.video_slot.w * resolved.video_slot.h;
      expect(total).toBeCloseTo(resolved.output.w * resolved.output.h, 5);
      for (const slot of [resolved.map_slot, resolved.video_slot]) {
        expect(slot.x + slot.w).toBeLessThanOrEqual(resolved.output.w);
        expect(slot.y + slot.h).toBeLessThanOrEqual(resolved.output.h);
      }
    });
  }
});

describe('defaultSplitLayout — agreement with defaultLayout', () => {
  const aspects: AspectRatio[] = ['9_16', '16_9', '4_5'];
  for (const aspect of aspects) {
    it(`${aspect}: defaultSplitLayout and defaultLayout return identical layouts`, () => {
      // Contract: `defaultLayout` is the alias every "give me a starter"
      // call site uses; it must agree with the canonical split factory.
      expect(defaultSplitLayout(aspect)).toEqual(defaultLayout(aspect));
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

describe('canonicalMapCssWidth', () => {
  // The canonical CSS width for `mapSettings.zoom` interpretation is the width
  // of the 1080p output for the selected export aspect. These values MUST
  // match the Rust port's `canonical_map_css_width` (parity test hardcoded in
  // `src-tauri/src/export/layout.rs`'s `#[cfg(test)] mod tests`).
  it('9_16 → 1080', () => {
    expect(canonicalMapCssWidth('9_16')).toBe(1080);
  });

  it('4_5 → 1080', () => {
    expect(canonicalMapCssWidth('4_5')).toBe(1080);
  });

  it('16_9 → 1920', () => {
    expect(canonicalMapCssWidth('16_9')).toBe(1920);
  });

  it('tracks outputDims(aspect, "1080p").w for every aspect', () => {
    // The helper must literally call `outputDims(aspect, '1080p').w`; this
    // test pins that contract so a future refactor can't silently drift from
    // the single source of truth.
    const aspects: AspectRatio[] = ['9_16', '4_5', '16_9'];
    for (const aspect of aspects) {
      expect(canonicalMapCssWidth(aspect)).toBe(outputDims(aspect, '1080p').w);
    }
  });
});

// ---------------------------------------------------------------------------
// canonicalMapViewport — pure render-viewport math
// ---------------------------------------------------------------------------
//
// `canonicalMapViewport` is the pure function the renderer worker, the Rust
// orchestrator's `build_setup_payload`, and the TS↔Rust parity tests all share
// for deriving `(cssW, cssH, pixelRatio)` from `(aspect, mapSlotW, mapSlotH)`.
// The contract is documented on the helper itself; these tests pin it:
//
//   - `cssW === canonicalMapCssWidth(aspect)` (exact integer; independent of
//     export resolution, because `mapSettings.zoom` is interpreted there).
//   - `|cssW * pixelRatio - mapSlotW| < 1` (the slot's W axis round-trips
//     within sub-pixel; for full-frame slots this is exact, for insets it can
//     be ε due to integer rounding in `resolve_slots`).
//   - `|cssH * pixelRatio - mapSlotH| < 1` (same on the H axis).
//   - `pixelRatio > 0` and finite.

describe('canonicalMapViewport — full-frame across all (aspect, resolution)', () => {
  const aspects: AspectRatio[] = ['9_16', '4_5', '16_9'];
  const resolutions: OutputResolution[] = ['720p', '1080p', '1440p', '2160p'];

  for (const aspect of aspects) {
    for (const resolution of resolutions) {
      it(`${aspect} @ ${resolution}: full-frame map slot satisfies the invariants`, () => {
        const out = outputDims(aspect, resolution);
        const got = canonicalMapViewport(aspect, out.w, out.h, resolution);
        // pixelRatio is the multiplier = outputDims(aspect, res).w /
        // outputDims(aspect, '1080p').w — exactly.
        const expectedMultiplier =
          outputDims(aspect, resolution).w / outputDims(aspect, '1080p').w;
        expect(got.pixelRatio).toBe(expectedMultiplier);
        // pixelRatio is positive and finite.
        expect(Number.isFinite(got.pixelRatio)).toBe(true);
        expect(got.pixelRatio).toBeGreaterThan(0);
        // W-axis epsilon round-trip.
        expect(Math.abs(got.cssW * got.pixelRatio - out.w)).toBeLessThan(1);
        // H-axis epsilon round-trip.
        expect(Math.abs(got.cssH * got.pixelRatio - out.h)).toBeLessThan(1);
      });
    }
  }

  // Decision 1 (plan §"Decisions"): no sub-1080p rendering. 720p deliverables
  // go through 1080p render + FFmpeg downsample in the runtime pipeline; the
  // pure-math helper itself is exposed at sub-1 for 720p by construction.
  const supportedExportRes: OutputResolution[] = ['1080p', '1440p', '2160p'];
  for (const aspect of aspects) {
    for (const resolution of supportedExportRes) {
      it(`${aspect} @ ${resolution}: pixelRatio >= 1`, () => {
        const out = outputDims(aspect, resolution);
        const got = canonicalMapViewport(aspect, out.w, out.h, resolution);
        expect(got.pixelRatio).toBeGreaterThanOrEqual(1);
      });
    }
  }
});

describe('canonicalMapViewport — composite slot shapes (PiP inset + Split halves)', () => {
  const aspects: AspectRatio[] = ['9_16', '4_5', '16_9'];

  for (const aspect of aspects) {
    it(`${aspect}: defaultPipLayout's resolved map-slot satisfies the invariants`, () => {
      const layout = defaultPipLayout(aspect);
      const resolved = resolveSlots(layout, aspect);
      const slot = resolved.map_slot;
      const got = canonicalMapViewport(aspect, slot.w, slot.h, '1080p');
      expect(Number.isFinite(got.pixelRatio)).toBe(true);
      expect(got.pixelRatio).toBeGreaterThan(0);
      expect(Math.abs(got.cssW * got.pixelRatio - slot.w)).toBeLessThan(1);
      expect(Math.abs(got.cssH * got.pixelRatio - slot.h)).toBeLessThan(1);
    });

    it(`${aspect}: defaultSplitLayout's resolved map-slot satisfies the invariants`, () => {
      const layout = defaultSplitLayout(aspect);
      const resolved = resolveSlots(layout, aspect);
      const slot = resolved.map_slot;
      const got = canonicalMapViewport(aspect, slot.w, slot.h, '1080p');
      expect(Number.isFinite(got.pixelRatio)).toBe(true);
      expect(got.pixelRatio).toBeGreaterThan(0);
      expect(Math.abs(got.cssW * got.pixelRatio - slot.w)).toBeLessThan(1);
      expect(Math.abs(got.cssH * got.pixelRatio - slot.h)).toBeLessThan(1);
    });
  }
});

describe('canonicalMapViewport — TS↔Rust parity from shared fixture', () => {
  // Every fixture case carries an `expected_canonical_map_viewport`. Both
  // ports (this TS test and `src-tauri/tests/layout_parity.rs`) call the
  // helper against the resolved `map_slot` and assert the same values. Float
  // `pixel_ratio` uses an epsilon (`toBeCloseTo(_, 9)` ≈ 5e-10 tolerance),
  // because legitimate non-integer ratios like 0.32037037... don't survive
  // strict equality across JSON-round-trip.
  for (const c of fixture.cases) {
    it(c.name, () => {
      const expectedCMV = c.expected_canonical_map_viewport;
      expect(
        expectedCMV,
        `fixture case ${c.name} missing expected_canonical_map_viewport`,
      ).toBeDefined();
      if (!expectedCMV) return;
      const slot = c.expected.map_slot;
      const got = canonicalMapViewport(
        c.aspect,
        slot.w,
        slot.h,
        c.resolution ?? '1080p',
      );
      expect(got.cssW).toBe(expectedCMV.css_w);
      expect(got.cssH).toBe(expectedCMV.css_h);
      expect(got.pixelRatio).toBeCloseTo(expectedCMV.pixel_ratio, 9);
    });
  }
});

describe('canonicalMapViewport — geographic invariance across resolutions', () => {
  // Under the lever model the cssViewport is no longer constant across
  // resolutions; what IS constant is the product `cssW × pixelRatio` (which
  // equals the framebuffer width within < 1 px on both axes). Holding
  // `mapSettings.zoom` constant, rendering the same aspect at different
  // export resolutions still produces the SAME geographic framing — same
  // meters-per-CSS-pixel at fixed Z under the multiplier model.
  const aspects: AspectRatio[] = ['9_16', '4_5', '16_9'];
  const resolutions: OutputResolution[] = ['720p', '1080p', '1440p', '2160p'];

  for (const aspect of aspects) {
    for (const resolution of resolutions) {
      it(`${aspect} @ ${resolution}: cssW * pixelRatio ≈ output.w (within 1px)`, () => {
        const out = outputDims(aspect, resolution);
        const got = canonicalMapViewport(aspect, out.w, out.h, resolution);
        expect(Math.abs(got.cssW * got.pixelRatio - out.w)).toBeLessThan(1);
        expect(Math.abs(got.cssH * got.pixelRatio - out.h)).toBeLessThan(1);
      });
    }
  }

  it('9_16 1080p slot 1080×1920: cssW=1080, cssH=1920, pixelRatio=1.0', () => {
    const got = canonicalMapViewport('9_16', 1080, 1920, '1080p');
    expect(got.cssW).toBe(1080);
    expect(got.cssH).toBe(1920);
    expect(got.pixelRatio).toBeCloseTo(1.0, 10);
  });

  it('9_16 1440p slot 1440×2560: cssW=1080, cssH=1920, pixelRatio=4/3', () => {
    const got = canonicalMapViewport('9_16', 1440, 2560, '1440p');
    expect(got.cssW).toBe(1080);
    expect(got.cssH).toBe(1920);
    expect(got.pixelRatio).toBeCloseTo(4 / 3, 10);
  });

  it('9_16 2160p slot 2160×3840: cssW=1080, cssH=1920, pixelRatio=2.0', () => {
    const got = canonicalMapViewport('9_16', 2160, 3840, '2160p');
    expect(got.cssW).toBe(1080);
    expect(got.cssH).toBe(1920);
    expect(got.pixelRatio).toBeCloseTo(2.0, 10);
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
