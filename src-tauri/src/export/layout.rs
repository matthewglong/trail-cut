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

/// Output pixel dimensions per aspect, fixed per LAYOUT.md §2.
pub fn output_dims(aspect: AspectRatio) -> OutputDimensions {
    match aspect {
        AspectRatio::NineSixteen => OutputDimensions { w: 1080, h: 1920 },
        AspectRatio::FourFive => OutputDimensions { w: 1080, h: 1350 },
        AspectRatio::SixteenNine => OutputDimensions { w: 1920, h: 1080 },
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

fn pip_slots(
    inset_source: PipInsetSource,
    inset: NormalizedRect,
    out: OutputDimensions,
) -> (PixelRect, PixelRect) {
    let inset_rect = PixelRect {
        x: round_to_u32(inset.x * out.w as f64),
        y: round_to_u32(inset.y * out.h as f64),
        w: round_to_u32(inset.w * out.w as f64),
        h: round_to_u32(inset.h * out.h as f64),
    };
    let background = PixelRect { x: 0, y: 0, w: out.w, h: out.h };
    match inset_source {
        // (map_slot, video_slot)
        PipInsetSource::Video => (background, inset_rect),
        PipInsetSource::Map => (inset_rect, background),
    }
}

fn split_slots(side: SplitSide, divider: f64, out: OutputDimensions) -> (PixelRect, PixelRect) {
    match side {
        SplitSide::Left => {
            let dx = round_to_u32(divider * out.w as f64);
            let video = PixelRect { x: 0, y: 0, w: dx, h: out.h };
            let map = PixelRect { x: dx, y: 0, w: out.w.saturating_sub(dx), h: out.h };
            (map, video)
        }
        SplitSide::Right => {
            let dx = round_to_u32(divider * out.w as f64);
            let map = PixelRect { x: 0, y: 0, w: dx, h: out.h };
            let video = PixelRect { x: dx, y: 0, w: out.w.saturating_sub(dx), h: out.h };
            (map, video)
        }
        SplitSide::Top => {
            let dy = round_to_u32(divider * out.h as f64);
            let video = PixelRect { x: 0, y: 0, w: out.w, h: dy };
            let map = PixelRect { x: 0, y: dy, w: out.w, h: out.h.saturating_sub(dy) };
            (map, video)
        }
        SplitSide::Bottom => {
            let dy = round_to_u32(divider * out.h as f64);
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
pub fn resolve_slots(layout: &LayoutConfig, aspect: AspectRatio) -> SlotResolution {
    let output = output_dims(aspect);
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

/// Back-compat alias. Pre-100 callers imported `default_layout`; that name now
/// delegates to `default_pip_layout`. New code should prefer the explicit
/// name (`default_layout` reads ambiguously once Split exists).
pub fn default_layout(aspect: AspectRatio) -> LayoutConfig {
    default_pip_layout(aspect)
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
pub fn clamp_layout(layout: &LayoutConfig, aspect: AspectRatio) -> LayoutConfig {
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
            let out = output_dims(aspect);
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
