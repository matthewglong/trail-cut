// Layout descriptor types and pure slot-rect math (task 050).
//
// Source of truth for the export layout data model. The Rust port lives in
// `src-tauri/src/export/layout.rs` and mirrors these shapes structurally; a
// shared JSON fixture (`src-tauri/tests/fixtures/layout_parity.json`) drives
// parity tests on both sides so drift surfaces at test time. See
// `docs/export/LAYOUT.md` and `docs/export/tasks/050-layout-descriptor-types.md`.

export type AspectRatio = '9_16' | '16_9' | '4_5';

export interface OutputDimensions {
  w: number;
  h: number;
}

/** Output pixel dimensions per aspect, fixed per LAYOUT.md §2. */
export const OUTPUT_DIMS: Record<AspectRatio, OutputDimensions> = {
  '9_16': { w: 1080, h: 1920 },
  '4_5': { w: 1080, h: 1350 },
  '16_9': { w: 1920, h: 1080 },
};

/** Normalized rect — frame is `(0,0)..(1,1)` regardless of aspect. */
export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** PiP layout: one source fills the frame, the other is an inset rect. */
export interface PipLayout {
  mode: 'pip';
  /** Which source is the inset; the other is the full-frame background. */
  inset_source: 'video' | 'map';
  /** Inset rect, normalized to the output frame: `(0,0)` = top-left. */
  inset: NormalizedRect;
  /** Corner radius as a fraction of `min(output.w, output.h)`; 0 = sharp. */
  corner_radius: number;
}

/** Split layout: one divider, two non-overlapping regions. */
export interface SplitLayout {
  mode: 'split';
  /** Side that holds the video. Orientation derives from the aspect:
   *  16:9 → `'left' | 'right'`; 9:16 / 4:5 → `'top' | 'bottom'`. */
  video_side: 'left' | 'right' | 'top' | 'bottom';
  /** Divider position normalized to the dividing axis (0..1). For
   *  `'left'`/`'right'` this is x; for `'top'`/`'bottom'` this is y. */
  divider: number;
}

export type LayoutConfig = PipLayout | SplitLayout;

/** Per-aspect layout storage. `null` means "user has not configured this
 *  aspect yet"; the configurator UI (110) seeds with `defaultLayout(aspect)`. */
export interface ProjectLayouts {
  '9_16': LayoutConfig | null;
  '4_5': LayoutConfig | null;
  '16_9': LayoutConfig | null;
}

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SlotResolution {
  output: OutputDimensions;
  map_slot: PixelRect;
  video_slot: PixelRect;
  /** Resolved corner radius in pixels (PiP only; 0 for Split). */
  corner_radius_px: number;
  /** Which slot the corner radius applies to. */
  corner_radius_slot: 'video' | 'map' | 'none';
}

/** Wire payload consumed by `render_export` (Tauri command shipping in 060/090).
 *  Carries both the user's raw config (for archival round-trip) and resolved
 *  pixel rects; Rust re-runs `resolve_slots` and asserts equality. */
export interface LayoutDescriptor {
  aspect: AspectRatio;
  layout: LayoutConfig;
  resolved: SlotResolution;
}

// --- helpers ----------------------------------------------------------------

/** Half-away-from-zero rounding. Matches Rust's `f64::round`. Both ports use
 *  this for parity; do not replace with `Math.floor` / `Math.trunc`. */
function roundHalfAway(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n));
}

function pipSlots(
  layout: PipLayout,
  out: OutputDimensions,
): { map_slot: PixelRect; video_slot: PixelRect } {
  const inset: PixelRect = {
    x: roundHalfAway(layout.inset.x * out.w),
    y: roundHalfAway(layout.inset.y * out.h),
    w: roundHalfAway(layout.inset.w * out.w),
    h: roundHalfAway(layout.inset.h * out.h),
  };
  const background: PixelRect = { x: 0, y: 0, w: out.w, h: out.h };
  if (layout.inset_source === 'video') {
    return { video_slot: inset, map_slot: background };
  }
  return { map_slot: inset, video_slot: background };
}

function splitSlots(
  layout: SplitLayout,
  out: OutputDimensions,
): { map_slot: PixelRect; video_slot: PixelRect } {
  switch (layout.video_side) {
    case 'left': {
      const dx = roundHalfAway(layout.divider * out.w);
      return {
        video_slot: { x: 0, y: 0, w: dx, h: out.h },
        map_slot: { x: dx, y: 0, w: out.w - dx, h: out.h },
      };
    }
    case 'right': {
      const dx = roundHalfAway(layout.divider * out.w);
      return {
        map_slot: { x: 0, y: 0, w: dx, h: out.h },
        video_slot: { x: dx, y: 0, w: out.w - dx, h: out.h },
      };
    }
    case 'top': {
      const dy = roundHalfAway(layout.divider * out.h);
      return {
        video_slot: { x: 0, y: 0, w: out.w, h: dy },
        map_slot: { x: 0, y: dy, w: out.w, h: out.h - dy },
      };
    }
    case 'bottom': {
      const dy = roundHalfAway(layout.divider * out.h);
      return {
        map_slot: { x: 0, y: 0, w: out.w, h: dy },
        video_slot: { x: 0, y: dy, w: out.w, h: out.h - dy },
      };
    }
  }
}

/** Pure: identical Rust port asserts byte-equal output via the parity fixture.
 *  Does not mutate inputs; out-of-range coords produce out-of-range rects (the
 *  configurator UI in 110 owns input validation). */
export function resolveSlots(
  layout: LayoutConfig,
  aspect: AspectRatio,
): SlotResolution {
  const output = OUTPUT_DIMS[aspect];
  if (layout.mode === 'pip') {
    const { map_slot, video_slot } = pipSlots(layout, output);
    return {
      output,
      map_slot,
      video_slot,
      corner_radius_px: roundHalfAway(
        layout.corner_radius * Math.min(output.w, output.h),
      ),
      corner_radius_slot: layout.inset_source,
    };
  }
  const { map_slot, video_slot } = splitSlots(layout, output);
  return {
    output,
    map_slot,
    video_slot,
    corner_radius_px: 0,
    corner_radius_slot: 'none',
  };
}

/** Reasonable starting layout per aspect: PiP, video as background, map as
 *  bottom-right inset, ~28% width, ~12px-equivalent corner radius. These are
 *  starter values, not normative — the configurator UI (110) lets the user
 *  freely move the inset. */
export function defaultLayout(aspect: AspectRatio): LayoutConfig {
  switch (aspect) {
    case '9_16':
      return {
        mode: 'pip',
        inset_source: 'map',
        inset: { x: 0.65, y: 0.78, w: 0.32, h: 0.18 },
        corner_radius: 0.012,
      };
    case '16_9':
      return {
        mode: 'pip',
        inset_source: 'map',
        inset: { x: 0.72, y: 0.68, w: 0.25, h: 0.27 },
        corner_radius: 0.012,
      };
    case '4_5':
      return {
        mode: 'pip',
        inset_source: 'map',
        inset: { x: 0.65, y: 0.74, w: 0.32, h: 0.22 },
        corner_radius: 0.012,
      };
  }
}
