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

/** Per-aspect layout storage. `null` means "user has explicitly cleared this
 *  aspect" (post-100); fresh projects ship with all three aspects seeded by
 *  `defaultPipLayout(aspect)`. The configurator UI (110) lets the user mutate
 *  freely; the export pipeline falls back to `defaultLayout(aspect)` when an
 *  entry is null. */
export interface ProjectLayouts {
  '9_16': LayoutConfig | null;
  '4_5': LayoutConfig | null;
  '16_9': LayoutConfig | null;
}

/** Convenience alias — task 100's helpers and the configurator UI (110) read
 *  from `SplitLayout['video_side']`. Re-exported by name so consumer code
 *  doesn't need to index into the union type. */
export type SplitSide = SplitLayout['video_side'];

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

/** Reasonable starting PiP layout per aspect: video as background, map as
 *  bottom-right inset, ~28% width, ~12px-equivalent corner radius. These are
 *  starter values, not normative — the configurator UI (110) lets the user
 *  freely move the inset. */
export function defaultPipLayout(aspect: AspectRatio): PipLayout {
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

/** Reasonable starting Split layout per aspect, with the orientation locked
 *  per LAYOUT.md §3 (16:9 → vertical divider; 9:16 / 4:5 → horizontal). The
 *  user can flip `video_side` to the other legal side via the swap toggle in
 *  the configurator (110); inverse-orientation splits are forbidden and
 *  rejected by `validate_request` / `buildExportRequest`. */
export function defaultSplitLayout(aspect: AspectRatio): SplitLayout {
  switch (aspect) {
    case '9_16':
    case '4_5':
      return { mode: 'split', video_side: 'top', divider: 0.5 };
    case '16_9':
      return { mode: 'split', video_side: 'left', divider: 0.5 };
  }
}

/** Back-compat alias. Pre-100 callers imported `defaultLayout`; that name now
 *  delegates to `defaultPipLayout`. New code should use `defaultPipLayout`
 *  for clarity (`defaultLayout` reads ambiguously once Split exists). */
export function defaultLayout(aspect: AspectRatio): LayoutConfig {
  return defaultPipLayout(aspect);
}

/** The two `video_side` values legal for a given aspect's Split orientation.
 *  Per LAYOUT.md §3, inverse-orientation splits (e.g. `'left'` at 9:16) are
 *  forbidden. The configurator's swap toggle (110) constrains its choices to
 *  this subset; the validator (`buildExportRequest` / `validate_request`)
 *  rejects out-of-set values at the IPC boundary. */
export function legalSplitSides(aspect: AspectRatio): readonly SplitSide[] {
  return aspect === '16_9'
    ? (['left', 'right'] as const)
    : (['top', 'bottom'] as const);
}

/** Defensive clamp for live-edited layouts. Used by 110's drag hooks to keep
 *  intermediate values valid while the user drags; landed here so the helper
 *  lives next to the types it operates on. The export-time validator does
 *  *not* call this — bad descriptors are rejected, not silently clamped, so
 *  configurator bugs surface instead of producing degenerate output. Pure;
 *  returns a fresh object even when the input is already valid. */
export function clampLayout(
  layout: LayoutConfig,
  aspect: AspectRatio,
): LayoutConfig {
  if (layout.mode === 'split') {
    const divider = clamp(layout.divider, 0.05, 0.95);
    return { mode: 'split', video_side: layout.video_side, divider };
  }
  const out = OUTPUT_DIMS[aspect];
  // Clamp the rect into the frame: bound w/h to (0, 1], clamp x/y so x+w<=1
  // and y+h<=1. The minimum width/height (1px-equivalent in the output frame)
  // keeps `resolveSlots` from producing zero-area inset rects.
  const minW = 1 / out.w;
  const minH = 1 / out.h;
  const w = clamp(layout.inset.w, minW, 1);
  const h = clamp(layout.inset.h, minH, 1);
  const x = clamp(layout.inset.x, 0, 1 - w);
  const y = clamp(layout.inset.y, 0, 1 - h);
  const corner_radius = clamp(layout.corner_radius, 0, 0.5);
  return {
    mode: 'pip',
    inset_source: layout.inset_source,
    inset: { x, y, w, h },
    corner_radius,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/** Aspect-fit projection of `OUTPUT_DIMS[aspect]` into a CSS-pixel container.
 *  Mirrors the math in `LayoutPreview` so drag hooks can convert pointer-pixel
 *  deltas into normalized-coordinate deltas without re-deriving scale factors
 *  inside the configurator. Returns `(0, 0)` for non-positive containers. */
export function drawnAreaSize(
  aspect: AspectRatio,
  containerWidth: number,
  containerHeight: number,
): { width: number; height: number } {
  const out = OUTPUT_DIMS[aspect];
  if (containerWidth <= 0 || containerHeight <= 0) {
    return { width: 0, height: 0 };
  }
  const scaleFactor = Math.min(containerWidth / out.w, containerHeight / out.h);
  return { width: out.w * scaleFactor, height: out.h * scaleFactor };
}

/** Mode-flip dispatch consumed by the configurator (110). The `_hint` is
 *  reserved for a future "preserve approximate position across mode flips"
 *  feature and ignored in v1. */
export function synthesizeLayoutForMode(
  mode: 'pip' | 'split',
  aspect: AspectRatio,
  _hint?: LayoutConfig,
): LayoutConfig {
  return mode === 'pip' ? defaultPipLayout(aspect) : defaultSplitLayout(aspect);
}
