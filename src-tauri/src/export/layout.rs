// Layout descriptor types and pure slot-rect math (task 050).
//
// Rust mirror of `src/lib/layout.ts`. The TS module is the source of truth;
// this file is a structural mirror, kept honest by the parity test in
// `src-tauri/tests/layout_parity.rs` which loads
// `src-tauri/tests/fixtures/layout_parity.json` and asserts identical
// `SlotResolution` output for every case. Any change here MUST be mirrored
// in `layout.ts` (and vice versa).
//
// See `docs/export/LAYOUT.md` and `docs/export/tasks/050-layout-descriptor-types.md`.

use serde::{Deserialize, Serialize};

use crate::export::resolution::OutputResolution;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum AspectRatio {
    #[serde(rename = "9_16")]
    NineSixteen,
    #[serde(rename = "4_5")]
    FourFive,
    #[serde(rename = "16_9")]
    SixteenNine,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutputDimensions {
    pub w: u32,
    pub h: u32,
}

/// Output pixel dimensions per aspect and resolution.
///
/// The `resolution` selects the short edge (720/1080/1440/2160); the long
/// edge derives from the aspect. All twelve `(aspect, resolution)` results
/// are even on both axes, which yuv420p compositing requires.
pub fn output_dims(aspect: AspectRatio, resolution: OutputResolution) -> OutputDimensions {
    let short: u32 = match resolution {
        OutputResolution::P720 => 720,
        OutputResolution::P1080 => 1080,
        OutputResolution::P1440 => 1440,
        OutputResolution::P2160 => 2160,
    };
    match aspect {
        AspectRatio::NineSixteen => OutputDimensions { w: short, h: short * 16 / 9 },
        AspectRatio::FourFive => OutputDimensions { w: short, h: short * 5 / 4 },
        AspectRatio::SixteenNine => OutputDimensions { w: short * 16 / 9, h: short },
    }
}

/// Canonical CSS width (in pixels) at which `mapSettings.zoom` is interpreted
/// for a given export aspect in the **preview**. 1080p is the canonical map
/// zoom reference resolution: 1080 for 9_16 / 4_5, 1920 for 16_9. Mirror of
/// `canonicalMapCssWidth` in `src/lib/layout.ts`.
///
/// Under the multiplier-based viewport model this is **no longer** the CSS
/// width the renderer lays out at — that comes from
/// [`canonical_map_viewport`]. This helper survives because the preview's
/// zoom compensation (`displayZoom = camera.zoom + log2(paneCssWidth /
/// canonicalMapCssWidth(aspect))`) still consumes it as the per-aspect
/// reference width at which `mapSettings.zoom` is calibrated. See
/// MAP_RENDERING_PLAN.md §"Preview behavior".
pub fn canonical_map_css_width(aspect: AspectRatio) -> u32 {
    // 1080p is the canonical map zoom reference resolution.
    output_dims(aspect, OutputResolution::P1080).w
}

/// Result of [`canonical_map_viewport`]. `css_w`/`css_h` are integer CSS-pixel
/// dims the renderer page lays the map container out at; `pixel_ratio` is the
/// float scaling factor MapLibre applies to produce a
/// `css_w*pixel_ratio × css_h*pixel_ratio` framebuffer that matches the
/// export's `map_slot` pixel dims.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CanonicalMapViewport {
    pub css_w: u32,
    pub css_h: u32,
    pub pixel_ratio: f64,
}

/// Pure math for the renderer worker's three viewport-shape fields given the
/// export aspect, the map slot's pixel dims, and the output resolution. This
/// is the **lever model** described in MAP_RENDERING_PLAN.md §"The lever
/// model":
///
/// ```text
/// multiplier  = output_dims(aspect, output_resolution).w
///             / output_dims(aspect, P1080).w
/// css_w       = round(map_slot_w / multiplier)
/// css_h       = round(map_slot_h / multiplier)
/// pixel_ratio = multiplier
/// ```
///
/// Contract / invariants:
///
/// - **`cssViewport` aspect ≈ slot aspect.** MapLibre paints into the slot
///   shape directly — no "render-then-crop". The W and H axes each round
///   independently, so the resulting CSS aspect drifts from the slot's by at
///   most one CSS pixel.
/// - **`pixel_ratio ∈ {2/3, 1, 4/3, 2}`** for the four `OutputResolution`
///   variants the app exposes. The 720p value (2/3) is mathematically valid
///   here; the runtime pipeline promotes 720p deliverables to a 1080p render
///   + FFmpeg downsample elsewhere (MAP_RENDERING_PLAN.md Decision 1), so
///   `pixel_ratio >= 1` always holds at the render step in practice.
/// - **Resolution change keeps `cssViewport` fixed, shifts `pixel_ratio`
///   only.** Same MapLibre zoom Z across resolutions ⇒ same meters per CSS
///   pixel ⇒ same apparent scale on the output.
/// - **`(css_w * pixel_ratio - map_slot_w).abs() <= pixel_ratio * 0.5`** and
///   the same on H — round-trip drift is bounded by the rounding of
///   `slot / multiplier` to an integer (max error 0.5 in CSS pixels, scaled
///   back up by `multiplier` on the framebuffer axis). At 2160p (pr=2) the
///   bound is exactly 1.0 when `slot` is odd; the renderer page handles the
///   ≤1px drift via padding/cropping (init.ts captureFramebufferIntoBuf).
///
/// Mirror of `canonicalMapViewport` in `src/lib/layout.ts`. The renderer
/// worker setup payload and `build_setup_payload` both delegate here so
/// geographic framing stays identical across resolution + aspect + slot
/// shape. See MAP_RENDERING_PLAN.md §"The lever model" for the full
/// rationale.
pub fn canonical_map_viewport(
    aspect: AspectRatio,
    map_slot_w: u32,
    map_slot_h: u32,
    output_resolution: OutputResolution,
) -> CanonicalMapViewport {
    let multiplier = output_dims(aspect, output_resolution).w as f64
        / output_dims(aspect, OutputResolution::P1080).w as f64;
    let css_w = (map_slot_w as f64 / multiplier).round() as u32;
    let css_h = (map_slot_h as f64 / multiplier).round() as u32;
    CanonicalMapViewport {
        css_w,
        css_h,
        pixel_ratio: multiplier,
    }
}

/// Hard upper bound on the supersampled map render's longest edge, in pixels.
///
/// Caps `slot_edge * factor` so the WebGL drawing buffer the headless renderer
/// allocates stays within the `MAX_TEXTURE_SIZE` / `MAX_RENDERBUFFER_SIZE`
/// budget of the GPUs we ship to. 8192 is a safe floor on the macOS ship
/// target (Apple GPUs report 16384; modern Intel Macs ≥ 8192) and on
/// near-term Windows discrete/integrated GPUs; 7680 (= 2× a 4K-wide slot)
/// leaves headroom under that floor.
pub const MAP_SUPERSAMPLE_MAX_EDGE: u32 = 7680;

/// `3×` is reserved for slots whose supersampled render stays within this
/// longest-edge budget — i.e. small/inset map slots, where the extra
/// supersampling is cheap. Full-frame exports (whose 3× would blow past this)
/// fall back to `2×`. Set to 4320 (a 4K *short* edge) so a full-frame 1440p
/// or 2160p slot lands on 2×, but PiP insets up to ~1440 px get 3×.
pub const MAP_SUPERSAMPLE_TRIPLE_MAX_EDGE: u32 = 4320;

/// Supersampling (SSAA) factor for the export map render.
///
/// The headless renderer paints the map at `slot_dims * factor` on the GPU,
/// then downsamples back to `slot_dims` **inside the renderer** (gamma-space,
/// matching the preview's compositor) before the frame ever crosses the wire
/// — so supersampling costs GPU render time but does NOT inflate the
/// frame-transport bytes (see the renderer's `captureFramebufferIntoBuf`).
/// This closes the preview/export crispness gap: the **live preview** is
/// already supersampled for free on a Retina display (MapLibre renders into a
/// `devicePixelRatio≈2` framebuffer the OS downsamples), which is exactly what
/// left export decoration edges aliased — and, after the final 4:2:0 chroma
/// subsampling, "grainy" and color-muted.
///
/// Tiers (bounded by GPU render cost, not transport):
/// - **2×** for full-frame 1080p/1440p/2160p — matches the Retina preview at
///   a sensible render cost; every supported export is supersampled ≥2×.
/// - **3×** for small/inset slots (`edge*3 <= `[`MAP_SUPERSAMPLE_TRIPLE_MAX_EDGE`])
///   where the extra detail is cheap.
/// - **1×** only for hypothetical slots wider than 4K (`edge*2 > `
///   [`MAP_SUPERSAMPLE_MAX_EDGE`]), which the app does not expose.
pub fn map_supersample_factor(slot_w: u32, slot_h: u32) -> u32 {
    let edge = slot_w.max(slot_h).max(1);
    if edge.saturating_mul(3) <= MAP_SUPERSAMPLE_TRIPLE_MAX_EDGE {
        3
    } else if edge.saturating_mul(2) <= MAP_SUPERSAMPLE_MAX_EDGE {
        2
    } else {
        1
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct NormalizedRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PipInsetSource {
    Video,
    Map,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SplitSide {
    Left,
    Right,
    Top,
    Bottom,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum LayoutConfig {
    Pip {
        inset_source: PipInsetSource,
        inset: NormalizedRect,
        corner_radius: f64,
    },
    Split {
        video_side: SplitSide,
        divider: f64,
    },
}

/// Per-aspect layout storage. `None` means "user has explicitly cleared this
/// aspect" (post-100); fresh projects ship with all three aspects seeded by
/// `default_pip_layout(aspect)`. The configurator UI (110) lets the user
/// mutate freely; the export pipeline falls back to `default_layout(aspect)`
/// when an entry is null.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ProjectLayouts {
    #[serde(rename = "9_16", default, skip_serializing_if = "Option::is_none")]
    pub aspect_9_16: Option<LayoutConfig>,
    #[serde(rename = "4_5", default, skip_serializing_if = "Option::is_none")]
    pub aspect_4_5: Option<LayoutConfig>,
    #[serde(rename = "16_9", default, skip_serializing_if = "Option::is_none")]
    pub aspect_16_9: Option<LayoutConfig>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct PixelRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CornerRadiusSlot {
    Video,
    Map,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SlotResolution {
    pub output: OutputDimensions,
    pub map_slot: PixelRect,
    pub video_slot: PixelRect,
    pub corner_radius_px: u32,
    pub corner_radius_slot: CornerRadiusSlot,
}

/// Wire payload consumed by `render_export` (Tauri command shipping in 060/090).
/// Carries both the user's raw config (for archival round-trip) and resolved
/// pixel rects; Rust re-runs `resolve_slots` against the carried `aspect` and
/// asserts equality so frontend-Rust drift surfaces immediately.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LayoutDescriptor {
    pub aspect: AspectRatio,
    /// Output resolution. Phase 1 scaffolding — round-trips through serde
    /// but is **not** consumed by `output_dims` / `resolve_slots` yet. Phase 4
    /// makes those helpers resolution-aware and threads this value into them.
    /// `#[serde(default)]` keeps pre-controls wire data deserializing cleanly.
    #[serde(default)]
    pub resolution: OutputResolution,
    pub layout: LayoutConfig,
    pub resolved: SlotResolution,
}

// --- helpers ----------------------------------------------------------------

/// Half-away-from-zero rounding. Matches `Math.round(Math.abs(n)) *
/// Math.sign(n)` in the TS port. Both ports document the rounding choice;
/// do not replace with `floor` / `trunc` — parity with TS depends on this.
fn round_to_u32(v: f64) -> u32 {
    let r = v.round();
    if r <= 0.0 {
        0
    } else {
        // saturating cast — out-of-range inputs produce broken slots, per the
        // intentional no-clamping contract documented in task 050.
        r as u32
    }
}

/// Round down to the nearest even u32. Slot W/H must be even so the
/// composite filtergraph's yuv420p chroma subsampling (delivery target for
/// H.264 / H.265 SDR) is well-defined: `zscale` errors with code 1027
/// ("image dimensions must be divisible by subsampling factor") when asked
/// to subsample an odd dimension. Mirror of TS `evenFloor` in
/// `src/lib/layout.ts`.
fn even_floor(v: u32) -> u32 {
    v & !1
}

fn pip_slots(
    inset_source: PipInsetSource,
    inset: NormalizedRect,
    out: OutputDimensions,
) -> (PixelRect, PixelRect) {
    // PiP background is full canvas (always even per `output_dims`); the
    // inset just overlays. Snap inset W/H to even so the rawvideo piped to
    // ffmpeg has yuv420p-compatible dims. X/Y are positions and don't affect
    // codec compatibility, so they keep half-away rounding. Map and video
    // slots don't tile against each other in PiP (one overlays the other),
    // so rounding W/H independently can't break a sum invariant.
    let inset_rect = PixelRect {
        x: round_to_u32(inset.x * out.w as f64),
        y: round_to_u32(inset.y * out.h as f64),
        w: even_floor(round_to_u32(inset.w * out.w as f64)),
        h: even_floor(round_to_u32(inset.h * out.h as f64)),
    };
    let background = PixelRect { x: 0, y: 0, w: out.w, h: out.h };
    match inset_source {
        // (map_slot, video_slot)
        PipInsetSource::Video => (background, inset_rect),
        PipInsetSource::Map => (inset_rect, background),
    }
}

fn split_slots(side: SplitSide, divider: f64, out: OutputDimensions) -> (PixelRect, PixelRect) {
    // Snap the divider position to even BEFORE deriving the two slots so the
    // sum invariant holds: `map_slot.w + video_slot.w == out.w` (and likewise
    // for h on horizontal splits). Because `output_dims` is even on both
    // axes, an even `dx`/`dy` implies the other slot's dim is also even
    // (`even - even = even`). Rounding each slot's dim independently would
    // leak or steal a pixel between the two halves; rounding the divider
    // preserves the invariant by construction. When the float divider lands
    // on an odd pixel, the half-pixel of width is handed to the slot
    // opposite the divider — sub-perceptible at any reasonable resolution.
    match side {
        SplitSide::Left => {
            let dx = even_floor(round_to_u32(divider * out.w as f64));
            let video = PixelRect { x: 0, y: 0, w: dx, h: out.h };
            let map = PixelRect { x: dx, y: 0, w: out.w.saturating_sub(dx), h: out.h };
            (map, video)
        }
        SplitSide::Right => {
            let dx = even_floor(round_to_u32(divider * out.w as f64));
            let map = PixelRect { x: 0, y: 0, w: dx, h: out.h };
            let video = PixelRect { x: dx, y: 0, w: out.w.saturating_sub(dx), h: out.h };
            (map, video)
        }
        SplitSide::Top => {
            let dy = even_floor(round_to_u32(divider * out.h as f64));
            let video = PixelRect { x: 0, y: 0, w: out.w, h: dy };
            let map = PixelRect { x: 0, y: dy, w: out.w, h: out.h.saturating_sub(dy) };
            (map, video)
        }
        SplitSide::Bottom => {
            let dy = even_floor(round_to_u32(divider * out.h as f64));
            let map = PixelRect { x: 0, y: 0, w: out.w, h: dy };
            let video = PixelRect { x: 0, y: dy, w: out.w, h: out.h.saturating_sub(dy) };
            (map, video)
        }
    }
}

/// Pure: identical TS port asserts byte-equal output via the parity fixture.
/// Out-of-range inputs produce broken slots — the configurator UI (110) owns
/// validation. See task 050's "Numeric clamping at the type boundary
/// (intentionally absent)" note.
pub fn resolve_slots(
    layout: &LayoutConfig,
    aspect: AspectRatio,
    resolution: OutputResolution,
) -> SlotResolution {
    let output = output_dims(aspect, resolution);
    match layout {
        LayoutConfig::Pip {
            inset_source,
            inset,
            corner_radius,
        } => {
            let (map_slot, video_slot) = pip_slots(*inset_source, *inset, output);
            let min_dim = output.w.min(output.h) as f64;
            SlotResolution {
                output,
                map_slot,
                video_slot,
                corner_radius_px: round_to_u32(corner_radius * min_dim),
                corner_radius_slot: match inset_source {
                    PipInsetSource::Video => CornerRadiusSlot::Video,
                    PipInsetSource::Map => CornerRadiusSlot::Map,
                },
            }
        }
        LayoutConfig::Split {
            video_side,
            divider,
        } => {
            let (map_slot, video_slot) = split_slots(*video_side, *divider, output);
            SlotResolution {
                output,
                map_slot,
                video_slot,
                corner_radius_px: 0,
                corner_radius_slot: CornerRadiusSlot::None,
            }
        }
    }
}

/// Reasonable starting PiP layout per aspect: video as background, map as
/// bottom-right inset. Starter values, not normative — the configurator UI
/// (110) lets the user freely move the inset.
pub fn default_pip_layout(aspect: AspectRatio) -> LayoutConfig {
    match aspect {
        AspectRatio::NineSixteen => LayoutConfig::Pip {
            inset_source: PipInsetSource::Map,
            inset: NormalizedRect { x: 0.65, y: 0.78, w: 0.32, h: 0.18 },
            corner_radius: 0.012,
        },
        AspectRatio::SixteenNine => LayoutConfig::Pip {
            inset_source: PipInsetSource::Map,
            inset: NormalizedRect { x: 0.72, y: 0.68, w: 0.25, h: 0.27 },
            corner_radius: 0.012,
        },
        AspectRatio::FourFive => LayoutConfig::Pip {
            inset_source: PipInsetSource::Map,
            inset: NormalizedRect { x: 0.65, y: 0.74, w: 0.32, h: 0.22 },
            corner_radius: 0.012,
        },
    }
}

/// Reasonable starting Split layout per aspect, with the orientation locked
/// per LAYOUT.md §3 (16:9 → vertical divider; 9:16 / 4:5 → horizontal). The
/// user can flip `video_side` to the other legal side via the configurator's
/// swap toggle (110); inverse-orientation splits are forbidden and rejected
/// by `validate_request`.
pub fn default_split_layout(aspect: AspectRatio) -> LayoutConfig {
    match aspect {
        AspectRatio::NineSixteen | AspectRatio::FourFive => LayoutConfig::Split {
            video_side: SplitSide::Top,
            divider: 0.5,
        },
        AspectRatio::SixteenNine => LayoutConfig::Split {
            video_side: SplitSide::Left,
            divider: 0.5,
        },
    }
}

/// The starting layout for a new aspect: Split. Callers that want the
/// unambiguous form should use `default_split_layout` directly.
pub fn default_layout(aspect: AspectRatio) -> LayoutConfig {
    default_split_layout(aspect)
}

/// The two `video_side` values legal for a given aspect's Split orientation.
/// Per LAYOUT.md §3, inverse-orientation splits (e.g. `'left'` at 9:16) are
/// forbidden. The configurator's swap toggle (110) constrains its choices to
/// this subset; `validate_request` rejects out-of-set values at the IPC
/// boundary so bad project files surface instead of producing nonsense
/// layouts the UX disallows.
pub fn legal_split_sides(aspect: AspectRatio) -> &'static [SplitSide] {
    match aspect {
        AspectRatio::SixteenNine => &[SplitSide::Left, SplitSide::Right],
        AspectRatio::NineSixteen | AspectRatio::FourFive => &[SplitSide::Top, SplitSide::Bottom],
    }
}

/// Defensive clamp for live-edited layouts. Mirrors `clampLayout` in
/// `src/lib/layout.ts`; landed here so the helper lives next to the types it
/// operates on. The export-time validator does *not* call this — bad
/// descriptors are rejected, not silently clamped. Pure; always returns a
/// fresh value.
pub fn clamp_layout(
    layout: &LayoutConfig,
    aspect: AspectRatio,
    resolution: OutputResolution,
) -> LayoutConfig {
    match layout {
        LayoutConfig::Split { video_side, divider } => LayoutConfig::Split {
            video_side: *video_side,
            divider: clamp_f64(*divider, 0.05, 0.95),
        },
        LayoutConfig::Pip {
            inset_source,
            inset,
            corner_radius,
        } => {
            let out = output_dims(aspect, resolution);
            let min_w = 1.0 / out.w as f64;
            let min_h = 1.0 / out.h as f64;
            let w = clamp_f64(inset.w, min_w, 1.0);
            let h = clamp_f64(inset.h, min_h, 1.0);
            let x = clamp_f64(inset.x, 0.0, 1.0 - w);
            let y = clamp_f64(inset.y, 0.0, 1.0 - h);
            LayoutConfig::Pip {
                inset_source: *inset_source,
                inset: NormalizedRect { x, y, w, h },
                corner_radius: clamp_f64(*corner_radius, 0.0, 0.5),
            }
        }
    }
}

fn clamp_f64(n: f64, lo: f64, hi: f64) -> f64 {
    if n.is_nan() || n < lo {
        lo
    } else if n > hi {
        hi
    } else {
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- SSAA supersample factor -----------------------------------------

    /// The supersampled GPU framebuffer must never exceed the WebGL
    /// edge budget on any (aspect, resolution, layout) the app exposes.
    #[test]
    fn supersample_factor_never_exceeds_gpu_edge_budget() {
        for &(w, h) in &[
            (1080u32, 1920u32),
            (1920, 1080),
            (2560, 1440),
            (3840, 2160),
            (2160, 3840),
            (480, 270),
            (960, 1080),
            (1, 1),
        ] {
            let f = map_supersample_factor(w, h);
            assert!(
                w.max(h) * f <= MAP_SUPERSAMPLE_MAX_EDGE,
                "({w}x{h}) factor {f} exceeds GPU edge budget",
            );
            // Every supported export is supersampled (≥2×).
            assert!(f >= 2, "({w}x{h}) should be supersampled, got {f}");
        }
    }

    #[test]
    fn supersample_factor_tiers() {
        // Full-frame 1080p / 1440p / 2160p → 2× (matches the Retina preview;
        // the renderer downsamples on-GPU so this no longer touches the wire).
        assert_eq!(map_supersample_factor(1920, 1080), 2);
        assert_eq!(map_supersample_factor(1080, 1920), 2);
        assert_eq!(map_supersample_factor(2560, 1440), 2);
        assert_eq!(map_supersample_factor(3840, 2160), 2);
        // Small inset slots → 3× (cheap supersampling headroom).
        assert_eq!(map_supersample_factor(480, 270), 3);
        assert_eq!(map_supersample_factor(1280, 720), 3);
    }

    // Output-dimension math per the Phase 4 short-edge table (export-controls
    // plan). Every (aspect, resolution) pair must produce even W and H so the
    // composite filtergraph's yuv420p chroma subsampling stays well-defined.

    #[test]
    fn output_dims_9_16_p720() {
        assert_eq!(
            output_dims(AspectRatio::NineSixteen, OutputResolution::P720),
            OutputDimensions { w: 720, h: 1280 },
        );
    }

    #[test]
    fn output_dims_4_5_p2160() {
        assert_eq!(
            output_dims(AspectRatio::FourFive, OutputResolution::P2160),
            OutputDimensions { w: 2160, h: 2700 },
        );
    }

    #[test]
    fn output_dims_16_9_p1440() {
        assert_eq!(
            output_dims(AspectRatio::SixteenNine, OutputResolution::P1440),
            OutputDimensions { w: 2560, h: 1440 },
        );
    }

    #[test]
    fn output_dims_default_resolution_preserves_legacy_canvas() {
        // P1080 must match the pre-Phase-4 hard-coded table so existing
        // exports keep producing the same dimensions when no resolution is
        // explicitly chosen (LayoutDescriptor.resolution defaults to P1080).
        assert_eq!(
            output_dims(AspectRatio::NineSixteen, OutputResolution::P1080),
            OutputDimensions { w: 1080, h: 1920 },
        );
        assert_eq!(
            output_dims(AspectRatio::FourFive, OutputResolution::P1080),
            OutputDimensions { w: 1080, h: 1350 },
        );
        assert_eq!(
            output_dims(AspectRatio::SixteenNine, OutputResolution::P1080),
            OutputDimensions { w: 1920, h: 1080 },
        );
    }

    #[test]
    fn canonical_map_css_width_matches_1080p_output_width_per_aspect() {
        // The canonical CSS width for mapSettings.zoom interpretation is the
        // width of the 1080p output for the selected export aspect. These
        // values MUST match the TS port's `canonicalMapCssWidth` (parity test
        // hardcoded in `src/lib/__tests__/layout.test.ts`).
        assert_eq!(canonical_map_css_width(AspectRatio::NineSixteen), 1080);
        assert_eq!(canonical_map_css_width(AspectRatio::FourFive), 1080);
        assert_eq!(canonical_map_css_width(AspectRatio::SixteenNine), 1920);
    }

    #[test]
    fn canonical_map_css_width_tracks_output_dims_1080p() {
        // The helper must literally call `output_dims(aspect, P1080).w`; this
        // test pins that contract so a future refactor can't silently drift
        // from the single source of truth.
        for aspect in [
            AspectRatio::NineSixteen,
            AspectRatio::FourFive,
            AspectRatio::SixteenNine,
        ] {
            assert_eq!(
                canonical_map_css_width(aspect),
                output_dims(aspect, OutputResolution::P1080).w,
            );
        }
    }

    #[test]
    fn output_dims_all_combinations_are_even() {
        // yuv420p requires even W and H. If the short-edge / long-edge math
        // ever produces an odd dimension, FFmpeg will reject the canvas.
        let aspects = [
            AspectRatio::NineSixteen,
            AspectRatio::FourFive,
            AspectRatio::SixteenNine,
        ];
        let resolutions = [
            OutputResolution::P720,
            OutputResolution::P1080,
            OutputResolution::P1440,
            OutputResolution::P2160,
        ];
        for aspect in aspects {
            for resolution in resolutions {
                let d = output_dims(aspect, resolution);
                assert_eq!(d.w % 2, 0, "{:?} {:?} → w={} is odd", aspect, resolution, d.w);
                assert_eq!(d.h % 2, 0, "{:?} {:?} → h={} is odd", aspect, resolution, d.h);
            }
        }
    }

    // ---- Slot W/H even-dim + Split sum invariants ----
    //
    // The composite filtergraph routes the per-clip stream through
    // `scale={video_slot.w}:{video_slot.h}` and the rawvideo map stream into
    // `format=yuv420p` at the finishing tail. yuv420p (4:2:0 chroma
    // subsampling) requires both dims to be even — `zscale` errors with code
    // 1027 ("image dimensions must be divisible by subsampling factor") on
    // odd input. `resolve_slots` must therefore produce even W/H for both
    // slots regardless of layout / aspect / resolution. For Split layouts
    // the divider snap to even must also preserve the tiling invariant
    // `map_slot.dim + video_slot.dim == output.dim` so we never leak or
    // overlap a pixel between the two halves.

    fn all_aspects() -> [AspectRatio; 3] {
        [
            AspectRatio::NineSixteen,
            AspectRatio::FourFive,
            AspectRatio::SixteenNine,
        ]
    }

    fn all_resolutions() -> [OutputResolution; 4] {
        [
            OutputResolution::P720,
            OutputResolution::P1080,
            OutputResolution::P1440,
            OutputResolution::P2160,
        ]
    }

    #[test]
    fn resolve_slots_dims_are_even_for_default_layouts_at_every_resolution() {
        for aspect in all_aspects() {
            for resolution in all_resolutions() {
                for layout in [default_pip_layout(aspect), default_split_layout(aspect)] {
                    let r = resolve_slots(&layout, aspect, resolution);
                    assert_eq!(
                        r.map_slot.w % 2, 0,
                        "map_slot.w is odd ({}) for {:?} {:?} {:?}",
                        r.map_slot.w, aspect, resolution, layout,
                    );
                    assert_eq!(
                        r.map_slot.h % 2, 0,
                        "map_slot.h is odd ({}) for {:?} {:?} {:?}",
                        r.map_slot.h, aspect, resolution, layout,
                    );
                    assert_eq!(
                        r.video_slot.w % 2, 0,
                        "video_slot.w is odd ({}) for {:?} {:?} {:?}",
                        r.video_slot.w, aspect, resolution, layout,
                    );
                    assert_eq!(
                        r.video_slot.h % 2, 0,
                        "video_slot.h is odd ({}) for {:?} {:?} {:?}",
                        r.video_slot.h, aspect, resolution, layout,
                    );
                }
            }
        }
    }

    #[test]
    fn resolve_slots_pip_inset_is_even_for_pathological_normalized_dims() {
        // A normalized fraction that's deliberately chosen so the raw float
        // math lands on an odd pixel for the 4_5 P2160 canvas (2160 × 2700):
        // 0.5625 * 2160 = 1215 (odd); 0.4503... * 2700 = 1216 (odd-adjacent).
        // The bug report case — a real-world layout that produces an odd-W
        // slot and triggers `zscale` code 1027. Both inset variants must
        // resolve to even W/H after the fix.
        let layout = LayoutConfig::Pip {
            inset_source: PipInsetSource::Map,
            inset: NormalizedRect { x: 0.2, y: 0.2, w: 0.5625, h: 0.45 },
            corner_radius: 0.0,
        };
        let r = resolve_slots(&layout, AspectRatio::FourFive, OutputResolution::P2160);
        assert_eq!(r.map_slot.w % 2, 0, "map_slot.w must be even, got {}", r.map_slot.w);
        assert_eq!(r.map_slot.h % 2, 0, "map_slot.h must be even, got {}", r.map_slot.h);
    }

    #[test]
    fn resolve_slots_split_preserves_sum_invariant_across_divider_sweep() {
        // For Split layouts, `map_slot + video_slot` must equal the output
        // canvas on the axis being split — even when the raw divider lands
        // on an odd pixel. Sweep a handful of dividers including ones that
        // bisect into odd pixel counts pre-snap.
        let dividers = [0.1, 0.25, 0.3, 0.31640625, 0.5, 0.5625, 0.7, 0.9];
        // Each (aspect, side) pair the configurator allows.
        let cases: &[(AspectRatio, SplitSide)] = &[
            (AspectRatio::SixteenNine, SplitSide::Left),
            (AspectRatio::SixteenNine, SplitSide::Right),
            (AspectRatio::NineSixteen, SplitSide::Top),
            (AspectRatio::NineSixteen, SplitSide::Bottom),
            (AspectRatio::FourFive, SplitSide::Top),
            (AspectRatio::FourFive, SplitSide::Bottom),
        ];
        for &(aspect, video_side) in cases {
            for resolution in all_resolutions() {
                for &divider in &dividers {
                    let layout = LayoutConfig::Split { video_side, divider };
                    let r = resolve_slots(&layout, aspect, resolution);
                    let vertical = matches!(video_side, SplitSide::Left | SplitSide::Right);
                    let (sum, expected, axis) = if vertical {
                        (r.map_slot.w + r.video_slot.w, r.output.w, "W")
                    } else {
                        (r.map_slot.h + r.video_slot.h, r.output.h, "H")
                    };
                    assert_eq!(
                        sum, expected,
                        "{} sum invariant broken: map + video = {} != output {} \
                         (aspect={:?} side={:?} res={:?} divider={})",
                        axis, sum, expected, aspect, video_side, resolution, divider,
                    );
                    assert_eq!(r.map_slot.w % 2, 0, "map.w odd at divider {}", divider);
                    assert_eq!(r.map_slot.h % 2, 0, "map.h odd at divider {}", divider);
                    assert_eq!(r.video_slot.w % 2, 0, "video.w odd at divider {}", divider);
                    assert_eq!(r.video_slot.h % 2, 0, "video.h odd at divider {}", divider);
                }
            }
        }
    }

    // ---- canonical_map_viewport: render-viewport math (multiplier model) ----
    //
    // The helper is the single source of truth for the renderer worker's
    // `(cssViewport, framebuffer, pixelRatio)` setup; `build_setup_payload`
    // (in `src-tauri/src/export/mod.rs`) delegates to it, and the TS port
    // (`canonicalMapViewport` in `src/lib/layout.ts`) is asserted to produce
    // identical values via the shared parity fixture.
    //
    // Under the new multiplier model: pixel_ratio is purely a function of
    // (aspect, output_resolution) — slot dims only affect css_w / css_h. See
    // MAP_RENDERING_PLAN.md §"The lever model".

    fn cmv_invariants(
        aspect: AspectRatio,
        slot_w: u32,
        slot_h: u32,
        resolution: OutputResolution,
    ) {
        let cmv = canonical_map_viewport(aspect, slot_w, slot_h, resolution);
        let expected_pr = output_dims(aspect, resolution).w as f64
            / output_dims(aspect, OutputResolution::P1080).w as f64;
        // pixel_ratio is a pure function of (aspect, resolution) — exact
        // equality, no tolerance.
        assert_eq!(
            cmv.pixel_ratio, expected_pr,
            "pixel_ratio must equal output_dims(aspect, res).w / output_dims(aspect, P1080).w \
             exactly (got {} vs {} for aspect={:?} res={:?})",
            cmv.pixel_ratio, expected_pr, aspect, resolution,
        );
        assert!(
            cmv.pixel_ratio.is_finite() && cmv.pixel_ratio > 0.0,
            "pixel_ratio is finite and positive: {}",
            cmv.pixel_ratio,
        );
        let w_err = (cmv.css_w as f64 * cmv.pixel_ratio - slot_w as f64).abs();
        let h_err = (cmv.css_h as f64 * cmv.pixel_ratio - slot_h as f64).abs();
        // Bound is `pr * 0.5` (max error of rounding `slot/multiplier` to an
        // integer, multiplied back up by `multiplier`). At pr=2 the bound is
        // exactly 1.0, hit when the slot dim is odd; small epsilon absorbs
        // float jitter.
        let bound = cmv.pixel_ratio * 0.5 + 1e-9;
        assert!(
            w_err <= bound,
            "W-axis round-trip drift {} exceeds bound {} (css_w={}, pr={}, slot_w={})",
            w_err, bound, cmv.css_w, cmv.pixel_ratio, slot_w,
        );
        assert!(
            h_err <= bound,
            "H-axis round-trip drift {} exceeds bound {} (css_h={}, pr={}, slot_h={})",
            h_err, bound, cmv.css_h, cmv.pixel_ratio, slot_h,
        );
    }

    #[test]
    fn canonical_map_viewport_full_frame_sweep() {
        // (aspect × resolution) at full-frame map slot: the invariants must
        // hold for every combination.
        let aspects = [
            AspectRatio::NineSixteen,
            AspectRatio::FourFive,
            AspectRatio::SixteenNine,
        ];
        let resolutions = [
            OutputResolution::P720,
            OutputResolution::P1080,
            OutputResolution::P1440,
            OutputResolution::P2160,
        ];
        for aspect in aspects {
            for resolution in resolutions {
                let out = output_dims(aspect, resolution);
                cmv_invariants(aspect, out.w, out.h, resolution);
            }
        }
    }

    #[test]
    fn canonical_map_viewport_default_pip_layout_satisfies_invariants() {
        // PiP-with-map-as-inset produces a small slot. With explicit 1080p
        // resolution the invariants must hold; pixel_ratio == 1.0.
        for aspect in [
            AspectRatio::NineSixteen,
            AspectRatio::FourFive,
            AspectRatio::SixteenNine,
        ] {
            let layout = default_pip_layout(aspect);
            let resolved = resolve_slots(&layout, aspect, OutputResolution::P1080);
            cmv_invariants(
                aspect,
                resolved.map_slot.w,
                resolved.map_slot.h,
                OutputResolution::P1080,
            );
        }
    }

    #[test]
    fn canonical_map_viewport_default_split_layout_satisfies_invariants() {
        for aspect in [
            AspectRatio::NineSixteen,
            AspectRatio::FourFive,
            AspectRatio::SixteenNine,
        ] {
            let layout = default_split_layout(aspect);
            let resolved = resolve_slots(&layout, aspect, OutputResolution::P1080);
            cmv_invariants(
                aspect,
                resolved.map_slot.w,
                resolved.map_slot.h,
                OutputResolution::P1080,
            );
        }
    }

    #[test]
    fn canonical_map_viewport_pixel_ratio_is_1_at_1080p() {
        // At 1080p — the canonical reference resolution — pixel_ratio is
        // exactly 1.0 for every aspect and slot dim.
        let aspects = [
            AspectRatio::NineSixteen,
            AspectRatio::FourFive,
            AspectRatio::SixteenNine,
        ];
        // A handful of slot shapes spanning full-frame and small inset.
        let slots: &[(u32, u32)] = &[
            (1080, 1920),
            (1920, 1080),
            (1080, 1350),
            (346, 346),
            (480, 292),
            (960, 1080),
        ];
        for aspect in aspects {
            for &(w, h) in slots {
                let cmv = canonical_map_viewport(aspect, w, h, OutputResolution::P1080);
                assert_eq!(
                    cmv.pixel_ratio, 1.0,
                    "1080p must yield pixel_ratio == 1.0 exactly (aspect={:?} slot={}×{})",
                    aspect, w, h,
                );
                assert_eq!(cmv.css_w, w, "css_w == slot_w at 1080p");
                assert_eq!(cmv.css_h, h, "css_h == slot_h at 1080p");
            }
        }
    }

    #[test]
    fn canonical_map_viewport_pixel_ratio_at_1440p_is_4_over_3() {
        // 1440p: multiplier = 4/3 for every aspect (short edge 1440/1080
        // and long edge math both reduce to 4/3 exactly).
        let expected = 4.0 / 3.0;
        for aspect in [
            AspectRatio::NineSixteen,
            AspectRatio::FourFive,
            AspectRatio::SixteenNine,
        ] {
            let out = output_dims(aspect, OutputResolution::P1440);
            let cmv = canonical_map_viewport(aspect, out.w, out.h, OutputResolution::P1440);
            assert!(
                (cmv.pixel_ratio - expected).abs() < 1e-12,
                "1440p pixel_ratio should be 4/3 (aspect={:?}, got {})",
                aspect, cmv.pixel_ratio,
            );
        }
    }

    #[test]
    fn canonical_map_viewport_pixel_ratio_at_2160p_is_2() {
        // 2160p: multiplier = 2 exactly for every aspect.
        for aspect in [
            AspectRatio::NineSixteen,
            AspectRatio::FourFive,
            AspectRatio::SixteenNine,
        ] {
            let out = output_dims(aspect, OutputResolution::P2160);
            let cmv = canonical_map_viewport(aspect, out.w, out.h, OutputResolution::P2160);
            assert_eq!(
                cmv.pixel_ratio, 2.0,
                "2160p pixel_ratio must be 2.0 exactly (aspect={:?})",
                aspect,
            );
        }
    }

    #[test]
    fn canonical_map_viewport_odd_slot_at_2160p_drift_is_within_bound() {
        // Regression: a real-world 4K composite produced an odd map_slot
        // width (e.g. 1215). At pr=2 that gives css_w=608, css_w*pr=1216,
        // drift=1.0 — which the renderer page absorbs via padding, but
        // `build_setup_payload`'s sanity check used to be `< 1.0` (strict),
        // panicking and leaking the spawned ffmpeg child. The bound must
        // tolerate any odd slot dim at 2160p.
        for &(slot_w, slot_h) in &[(1215_u32, 3840_u32), (2160, 1351), (1, 1), (3, 5)] {
            cmv_invariants(AspectRatio::NineSixteen, slot_w, slot_h, OutputResolution::P2160);
        }
    }

    #[test]
    fn canonical_map_viewport_pixel_ratio_at_720p_is_2_over_3() {
        // 720p is mathematically permitted here (multiplier = 2/3). The
        // runtime pipeline promotes 720p deliverables to a 1080p render
        // followed by FFmpeg downsample (MAP_RENDERING_PLAN.md Decision 1),
        // so this branch is not exercised in production rendering. The math
        // still has to be well-defined for fixture / parity tests.
        let expected = 2.0 / 3.0;
        for aspect in [
            AspectRatio::NineSixteen,
            AspectRatio::FourFive,
            AspectRatio::SixteenNine,
        ] {
            let out = output_dims(aspect, OutputResolution::P720);
            let cmv = canonical_map_viewport(aspect, out.w, out.h, OutputResolution::P720);
            assert!(
                (cmv.pixel_ratio - expected).abs() < 1e-12,
                "720p pixel_ratio should be 2/3 (aspect={:?}, got {})",
                aspect, cmv.pixel_ratio,
            );
        }
    }

    #[test]
    fn canonical_map_viewport_9_16_numerical_anchors() {
        // Concrete numerical anchor cases: at 9_16 full-frame slots the
        // cssViewport stays 1080×1920 across resolutions; only pixel_ratio
        // shifts.
        let cmv1080 = canonical_map_viewport(
            AspectRatio::NineSixteen,
            1080,
            1920,
            OutputResolution::P1080,
        );
        assert_eq!(cmv1080.css_w, 1080);
        assert_eq!(cmv1080.css_h, 1920);
        assert_eq!(cmv1080.pixel_ratio, 1.0);

        let cmv1440 = canonical_map_viewport(
            AspectRatio::NineSixteen,
            1440,
            2560,
            OutputResolution::P1440,
        );
        assert_eq!(cmv1440.css_w, 1080);
        assert_eq!(cmv1440.css_h, 1920);
        assert!((cmv1440.pixel_ratio - 4.0 / 3.0).abs() < 1e-12);

        let cmv2160 = canonical_map_viewport(
            AspectRatio::NineSixteen,
            2160,
            3840,
            OutputResolution::P2160,
        );
        assert_eq!(cmv2160.css_w, 1080);
        assert_eq!(cmv2160.css_h, 1920);
        assert_eq!(cmv2160.pixel_ratio, 2.0);
    }
}
