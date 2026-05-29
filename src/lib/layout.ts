// Layout descriptor types and pure slot-rect math (task 050).
//
// Source of truth for the export layout data model. The Rust port lives in
// `src-tauri/src/export/layout.rs` and mirrors these shapes structurally; a
// shared JSON fixture (`src-tauri/tests/fixtures/layout_parity.json`) drives
// parity tests on both sides so drift surfaces at test time. See
// `docs/export/LAYOUT.md` and `docs/export/tasks/050-layout-descriptor-types.md`.

export type AspectRatio = '9_16' | '16_9' | '4_5';

/** Output video resolution. Phase 1 scaffolding — rides on `LayoutDescriptor`
 *  (mirrors `OutputResolution` in `src-tauri/src/export/resolution.rs`). The
 *  pipeline does not yet consume the value; Phase 4 wires it into
 *  `outputDims` / `resolveSlots` to make the canvas size variable. The string
 *  tags match the Rust enum's `#[serde(rename = "Np")]` shape. */
export type OutputResolution = '720p' | '1080p' | '1440p' | '2160p';

export interface OutputDimensions {
  w: number;
  h: number;
}

/** Output pixel dimensions per aspect and resolution. The short edge is
 *  determined by `resolution` (720/1080/1440/2160); the long edge derives from
 *  the aspect. All twelve `(aspect, resolution)` results are even on both
 *  axes — required by yuv420p compositing. Mirror of `output_dims` in
 *  `src-tauri/src/export/layout.rs`. */
export function outputDims(
  aspect: AspectRatio,
  resolution: OutputResolution = '1080p',
): OutputDimensions {
  const short =
    resolution === '720p' ? 720
    : resolution === '1080p' ? 1080
    : resolution === '1440p' ? 1440
    : 2160;
  switch (aspect) {
    case '9_16':
      return { w: short, h: Math.trunc((short * 16) / 9) };
    case '4_5':
      return { w: short, h: Math.trunc((short * 5) / 4) };
    case '16_9':
      return { w: Math.trunc((short * 16) / 9), h: short };
  }
}

/** Legacy 1080p table preserved for UI callers (layout configurator preview,
 *  channel schematic) that show the canonical layout shape, not the export
 *  pixels. New code should call `outputDims(aspect, resolution)`. */
export const OUTPUT_DIMS: Record<AspectRatio, OutputDimensions> = {
  '9_16': outputDims('9_16', '1080p'),
  '4_5': outputDims('4_5', '1080p'),
  '16_9': outputDims('16_9', '1080p'),
};

/** The CSS width at which `mapSettings.zoom` is calibrated in the preview UI.
 *  1080 for 9_16 / 4_5, 1920 for 16_9. The preview's `MapView` compensates a
 *  pane that is not this width by `+ log2(paneCssWidth / canonicalMapCssWidth)`
 *  so the framing matches what the 1080p export of that aspect produces — see
 *  `src/components/MapView.tsx` (the `displayZoom` write near the per-frame
 *  loop). The renderer worker no longer lays the map out at this width; under
 *  the lever model (see `canonicalMapViewport`) the renderer's cssViewport
 *  matches the slot shape, and the resolution shift rides on `pixelRatio`.
 *  Mirror of `canonical_map_css_width` in `src-tauri/src/export/layout.rs`. */
export function canonicalMapCssWidth(aspect: AspectRatio): number {
  // 1080p is the canonical map zoom reference resolution.
  return outputDims(aspect, '1080p').w;
}

/** Result of `canonicalMapViewport`. `cssW`/`cssH` are integer CSS-pixel dims
 *  the renderer page lays the map container out at; `pixelRatio` is the float
 *  scaling factor MapLibre applies to produce a `cssW*pixelRatio × cssH*pixelRatio`
 *  framebuffer that matches the export's `map_slot` pixel dims. */
export interface CanonicalMapViewport {
  cssW: number;
  cssH: number;
  pixelRatio: number;
}

/** Pure math for the renderer worker's three viewport-shape fields given the
 *  export aspect, the map slot's pixel dims, and the export resolution. The
 *  lever model — see `MAP_RENDERING_PLAN.md` §"The lever model":
 *
 *  - `multiplier = outputDims(aspect, outputRes).w / outputDims(aspect, '1080p').w`
 *    — the output resolution lever. 1.0 at 1080p, 4/3 at 1440p, 2.0 at 2160p
 *    (Decision 1: no sub-1080p; 720p deliverables go through 1080p render +
 *    FFmpeg downsample, so `multiplier >= 1` always).
 *  - `cssW = round(mapSlotW / multiplier)` — the CSS-pixel width MapLibre
 *    lays the world out at. The cssViewport's aspect matches the slot's
 *    aspect; the renderer never lays out at the per-aspect canonical width
 *    anymore.
 *  - `cssH = round(mapSlotH / multiplier)` — same on the H axis.
 *  - `pixelRatio = multiplier` — the framebuffer density lever. Crisp at
 *    1080p (1.0), fractional but well-defined at 1440p (4/3), sharper at
 *    2160p (2.0).
 *
 *  At fixed `pixelRatio`, fixed MapLibre zoom Z gives fixed meters-per-CSS-
 *  pixel. Same Z across exports = same scale. Resolution change shifts only
 *  `pixelRatio`; cssViewport is identical across resolutions (modulo the
 *  rounding behavior). Mirror of `canonical_map_viewport` in
 *  `src-tauri/src/export/layout.rs`; `build_setup_payload` (in
 *  `src-tauri/src/export/mod.rs`) and the renderer worker both rely on this
 *  single derivation so geographic framing stays identical across export
 *  resolutions. */
export function canonicalMapViewport(
  aspect: AspectRatio,
  mapSlotW: number,
  mapSlotH: number,
  outputRes: OutputResolution,
): CanonicalMapViewport {
  const multiplier = outputDims(aspect, outputRes).w / outputDims(aspect, '1080p').w;
  const cssW = Math.round(mapSlotW / multiplier);
  const cssH = Math.round(mapSlotH / multiplier);
  return { cssW, cssH, pixelRatio: multiplier };
}

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
 *  pixel rects; Rust re-runs `resolve_slots` and asserts equality.
 *
 *  `resolution` is Phase 1 scaffolding (export-controls plan): the field
 *  round-trips through serde but is **not** consumed by `resolveSlots` /
 *  `output_dims` yet. Phase 4 makes the canvas size variable per resolution. */
export interface LayoutDescriptor {
  aspect: AspectRatio;
  resolution: OutputResolution;
  layout: LayoutConfig;
  resolved: SlotResolution;
}

// --- helpers ----------------------------------------------------------------

/** Half-away-from-zero rounding. Matches Rust's `f64::round`. Both ports use
 *  this for parity; do not replace with `Math.floor` / `Math.trunc`. */
function roundHalfAway(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n));
}

/** Round down to the nearest even integer. Slot W/H must be even so the
 *  composite filtergraph's yuv420p chroma subsampling (delivery target for
 *  H.264 / H.265 SDR) is well-defined: `zscale` errors with code 1027
 *  ("image dimensions must be divisible by subsampling factor") when asked
 *  to subsample an odd dimension. Mirror of Rust `even_floor` in
 *  `src-tauri/src/export/layout.rs`. */
function evenFloor(n: number): number {
  return n & ~1;
}

function pipSlots(
  layout: PipLayout,
  out: OutputDimensions,
): { map_slot: PixelRect; video_slot: PixelRect } {
  // PiP background is full canvas (always even per `outputDims`); the inset
  // just overlays. Snap inset W/H to even so the rawvideo piped to ffmpeg
  // has yuv420p-compatible dims. X/Y are positions and don't affect codec
  // compatibility. Map and video slots don't tile against each other in PiP
  // (one overlays the other), so rounding W/H independently is safe.
  const inset: PixelRect = {
    x: roundHalfAway(layout.inset.x * out.w),
    y: roundHalfAway(layout.inset.y * out.h),
    w: evenFloor(roundHalfAway(layout.inset.w * out.w)),
    h: evenFloor(roundHalfAway(layout.inset.h * out.h)),
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
  // Snap the divider position to even BEFORE deriving the two slots so the
  // sum invariant holds: `map_slot.w + video_slot.w === out.w` (likewise for
  // h on horizontal splits). Because `outputDims` is even on both axes, an
  // even `dx`/`dy` implies the other slot's dim is also even
  // (`even - even = even`). Rounding each slot's dim independently would
  // leak or steal a pixel between the two halves; rounding the divider
  // preserves the invariant by construction.
  switch (layout.video_side) {
    case 'left': {
      const dx = evenFloor(roundHalfAway(layout.divider * out.w));
      return {
        video_slot: { x: 0, y: 0, w: dx, h: out.h },
        map_slot: { x: dx, y: 0, w: out.w - dx, h: out.h },
      };
    }
    case 'right': {
      const dx = evenFloor(roundHalfAway(layout.divider * out.w));
      return {
        map_slot: { x: 0, y: 0, w: dx, h: out.h },
        video_slot: { x: dx, y: 0, w: out.w - dx, h: out.h },
      };
    }
    case 'top': {
      const dy = evenFloor(roundHalfAway(layout.divider * out.h));
      return {
        video_slot: { x: 0, y: 0, w: out.w, h: dy },
        map_slot: { x: 0, y: dy, w: out.w, h: out.h - dy },
      };
    }
    case 'bottom': {
      const dy = evenFloor(roundHalfAway(layout.divider * out.h));
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
  resolution: OutputResolution = '1080p',
): SlotResolution {
  const output = outputDims(aspect, resolution);
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

/** The starting layout for a new aspect: Split. Callers that want the
 *  unambiguous form should use `defaultSplitLayout` directly. */
export function defaultLayout(aspect: AspectRatio): LayoutConfig {
  return defaultSplitLayout(aspect);
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
  resolution: OutputResolution = '1080p',
): LayoutConfig {
  if (layout.mode === 'split') {
    const divider = clamp(layout.divider, 0.05, 0.95);
    return { mode: 'split', video_side: layout.video_side, divider };
  }
  const out = outputDims(aspect, resolution);
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
