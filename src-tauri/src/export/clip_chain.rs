// Pure per-clip video / audio sub-graph builders for Channel C (video-only)
// and Channel A (composite) exports — task 070.
//
// LAYOUT.md §7 spec: the per-clip chain is `trim → setpts → focal-crop →
// scale → format` for video and `atrim → asetpts → atempo*` for audio. This
// builder emits the FFmpeg `filter_complex` fragment for one clip, ending in
// the output stream labels `[v{idx}]` / `[a{idx}]` so a downstream `concat`
// filter can pick them up.
//
// Pure: same inputs → byte-identical strings. No IO, no FFmpeg invocation.
// Used verbatim by Channel A (090) — `clip_chain` is the structural seam that
// keeps "C's video pipeline" and "A's video pipeline" from drifting (LAYOUT.md
// §7 invariant).

use crate::export::error::ClipChainError;
use crate::export::layout::PixelRect;
use crate::models::{Clip, FocalPoint};

/// Source pixel dimensions, distinct from `OutputDimensions` so call sites
/// don't accidentally pass the export dims where the source dims are needed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelDims {
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct ClipChainInputs<'a> {
    /// FFmpeg input index (0-based, in the order inputs are listed on argv).
    /// The label `[N:v]` references this index.
    pub input_index: u32,
    pub clip: &'a Clip,
    /// Probed source dims; required, errors if 0×0.
    pub source_dims: PixelDims,
    /// Target slot dims, taken from `layout.resolved.video_slot`.
    pub video_slot: PixelRect,
    pub fps: u32,
}

#[derive(Debug, Clone)]
pub struct ClipChainOutput {
    /// Filter sub-graph fragment for this clip's video. Ends with `[v{idx}]`.
    pub video_subgraph: String,
    /// Filter sub-graph fragment for this clip's audio. Ends with `[a{idx}]`.
    /// `None` only when the caller has explicitly opted into a different audio
    /// strategy (e.g. `aevalsrc=0` for a clip without a source audio stream);
    /// the caller — not this module — handles that branch.
    pub audio_subgraph: Option<String>,
    /// The output-stream label without brackets (e.g. `"v0"`).
    pub video_label: String,
    pub audio_label: Option<String>,
}

/// Inclusive crop rectangle in source-pixel space. All values are integer
/// pixels (FFmpeg's `crop` filter rejects subpixel values).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// Build the video sub-graph for one clip. Emits exactly:
///
/// ```text
/// [{idx}:v]trim=start={in_s}:end={out_s},setpts=(PTS-STARTPTS)/{speed},crop={cw}:{ch}:{cx}:{cy},scale={vw}:{vh},format=yuva444p10le[v{idx}]
/// ```
///
/// Floats are serialized with 6 decimal places (FFmpeg's parser rejects
/// scientific notation). `format=yuva444p10le` is load-bearing — concat
/// requires uniform pixel formats across inputs, and the downstream pad with
/// `color=#00000000` only produces transparent fill on a stream that already
/// carries alpha.
pub fn build_clip_video_subgraph(inputs: &ClipChainInputs) -> Result<String, ClipChainError> {
    let clip_id = clip_id(inputs.clip);
    let (in_s, out_s) = trim_seconds(inputs.clip)?;
    let speed = clip_speed(inputs.clip)?;
    let crop = compute_focal_crop(
        inputs.source_dims,
        PixelDims {
            w: inputs.video_slot.w,
            h: inputs.video_slot.h,
        },
        &inputs.clip.focal_point,
        clip_id.as_str(),
    )?;

    Ok(format!(
        "[{idx}:v]trim=start={in_s:.6}:end={out_s:.6},setpts=(PTS-STARTPTS)/{speed:.6},crop={cw}:{ch}:{cx}:{cy},scale={vw}:{vh},format=yuva444p10le[v{idx}]",
        idx = inputs.input_index,
        in_s = in_s,
        out_s = out_s,
        speed = speed,
        cw = crop.w,
        ch = crop.h,
        cx = crop.x,
        cy = crop.y,
        vw = inputs.video_slot.w,
        vh = inputs.video_slot.h,
    ))
}

/// Build the audio sub-graph for one clip. Emits:
///
/// ```text
/// [{idx}:a]atrim=start={in_s}:end={out_s},asetpts=PTS-STARTPTS[,atempo=…[,atempo=…]][a{idx}]
/// ```
///
/// For `speed == 1.0` no `atempo` filter is emitted (it would be a no-op pass).
/// For extreme speeds the `atempo` filter is chained per LAYOUT.md §7 (each
/// instance ∈ `[0.5, 2.0]`).
pub fn build_clip_audio_subgraph(inputs: &ClipChainInputs) -> Result<String, ClipChainError> {
    let (in_s, out_s) = trim_seconds(inputs.clip)?;
    let speed = clip_speed(inputs.clip)?;
    let factors = chain_atempo(speed);

    let mut chain = format!(
        "[{idx}:a]atrim=start={in_s:.6}:end={out_s:.6},asetpts=PTS-STARTPTS",
        idx = inputs.input_index,
        in_s = in_s,
        out_s = out_s,
    );
    for f in factors {
        if (f - 1.0).abs() < f64::EPSILON {
            // Skip identity factors — `atempo=1.0` is a no-op pass.
            continue;
        }
        chain.push_str(&format!(",atempo={f:.6}"));
    }
    chain.push_str(&format!("[a{idx}]", idx = inputs.input_index));
    Ok(chain)
}

/// Build both sub-graphs together. The audio sub-graph is `Some` for every
/// clip; callers that need to substitute `aevalsrc=0` for a clip without a
/// source audio stream do so on their side, since this module has no
/// knowledge of the probe result.
pub fn build_clip_chain(inputs: &ClipChainInputs) -> Result<ClipChainOutput, ClipChainError> {
    let video_subgraph = build_clip_video_subgraph(inputs)?;
    let audio_subgraph = build_clip_audio_subgraph(inputs)?;
    Ok(ClipChainOutput {
        video_subgraph,
        audio_subgraph: Some(audio_subgraph),
        video_label: format!("v{}", inputs.input_index),
        audio_label: Some(format!("a{}", inputs.input_index)),
    })
}

// ---------- focal crop math (LAYOUT.md §7) ----------

/// Compute the source-space integer crop rect that, when scaled to
/// `target_aspect_dims`, fills the slot at the focal-zoom level the user
/// authored. Pure: same inputs → identical output (round-half-away-from-zero
/// per `f64::round`).
pub fn compute_focal_crop(
    source_dims: PixelDims,
    target_aspect_dims: PixelDims,
    focal: &FocalPoint,
    clip_id: &str,
) -> Result<CropRect, ClipChainError> {
    if source_dims.w == 0 || source_dims.h == 0 {
        return Err(ClipChainError::MissingSourceDims {
            clip_id: clip_id.to_string(),
        });
    }
    if !focal.zoom.is_finite() || focal.zoom < 1.0 {
        return Err(ClipChainError::InvalidZoom {
            clip_id: clip_id.to_string(),
            zoom: focal.zoom,
        });
    }

    let src_w = source_dims.w as f64;
    let src_h = source_dims.h as f64;
    let target_aspect = (target_aspect_dims.w as f64) / (target_aspect_dims.h as f64);
    let src_aspect = src_w / src_h;

    // Aspect-fit: largest centered rect inside the source that matches the
    // target aspect. Source wider than target → match height, narrow width;
    // source taller → match width, narrow height.
    let (fit_w, fit_h) = if src_aspect > target_aspect {
        (src_h * target_aspect, src_h)
    } else {
        (src_w, src_w / target_aspect)
    };

    let crop_w_f = fit_w / focal.zoom;
    let crop_h_f = fit_h / focal.zoom;

    // Center alignment in source pixel space.
    let cx = focal.x * src_w;
    let cy = focal.y * src_h;

    // Top-left, clamped to source bounds.
    let raw_x = cx - crop_w_f / 2.0;
    let raw_y = cy - crop_h_f / 2.0;
    let max_x = (src_w - crop_w_f).max(0.0);
    let max_y = (src_h - crop_h_f).max(0.0);
    let clamped_x = raw_x.clamp(0.0, max_x);
    let clamped_y = raw_y.clamp(0.0, max_y);

    let cw = (crop_w_f.round() as i64).max(1).min(source_dims.w as i64) as u32;
    let ch = (crop_h_f.round() as i64).max(1).min(source_dims.h as i64) as u32;
    let cx_int = clamped_x.round().clamp(0.0, (source_dims.w - cw) as f64) as u32;
    let cy_int = clamped_y.round().clamp(0.0, (source_dims.h - ch) as f64) as u32;

    Ok(CropRect {
        x: cx_int,
        y: cy_int,
        w: cw,
        h: ch,
    })
}

// ---------- atempo chain (LAYOUT.md §7) ----------

/// Decompose a speed factor into a chain of `atempo` factors each in
/// `[0.5, 2.0]`. FFmpeg's `atempo` filter is bounded; chaining lets the
/// effective speed extend past those bounds without losing the filter's
/// pitch-preserving time-stretch.
///
/// Algorithm: while `speed > 2.0`, push `2.0` and divide; while `speed <
/// 0.5`, push `0.5` and divide; push the remainder.
///
/// Test cases (matches LAYOUT.md §7 reference):
/// - `1.0` → `[1.0]` (no-op identity; the audio subgraph builder filters
///   1.0 factors out before emitting the `atempo` chain).
/// - `2.0` → `[2.0]`
/// - `4.0` → `[2.0, 2.0]`
/// - `5.0` → `[2.0, 2.0, 1.25]`
/// - `0.5` → `[0.5]`
/// - `0.25` → `[0.5, 0.5]`
/// - `0.1` → `[0.5, 0.5, 0.5, 0.8]`
pub fn chain_atempo(speed: f64) -> Vec<f64> {
    let mut factors = Vec::new();
    let mut remaining = speed;
    while remaining > 2.0 {
        factors.push(2.0);
        remaining /= 2.0;
    }
    while remaining < 0.5 {
        factors.push(0.5);
        remaining /= 0.5; // i.e. *2
    }
    factors.push(remaining);
    factors
}

// ---------- helpers ----------

fn clip_id(clip: &Clip) -> String {
    clip.id.clone()
}

fn trim_seconds(clip: &Clip) -> Result<(f64, f64), ClipChainError> {
    let (in_ms, out_ms) = match (&clip.trim, clip.duration_ms) {
        (Some(t), _) => (t.in_ms, t.out_ms),
        (None, Some(d)) => (0u64, d),
        (None, None) => {
            return Err(ClipChainError::InvalidTrim {
                clip_id: clip.id.clone(),
                in_ms: 0,
                out_ms: 0,
            });
        }
    };
    if out_ms <= in_ms {
        return Err(ClipChainError::InvalidTrim {
            clip_id: clip.id.clone(),
            in_ms,
            out_ms,
        });
    }
    Ok((in_ms as f64 / 1000.0, out_ms as f64 / 1000.0))
}

fn clip_speed(clip: &Clip) -> Result<f64, ClipChainError> {
    let s = clip.effects.speed;
    if !s.is_finite() || s <= 0.0 {
        return Err(ClipChainError::InvalidSpeed {
            clip_id: clip.id.clone(),
            speed: s,
        });
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Effects, FocalPoint, StabilizeSettings, TrimRange};

    fn make_clip(speed: f64, focal: FocalPoint, trim: Option<TrimRange>, dur: Option<u64>) -> Clip {
        Clip {
            id: "clip-test".to_string(),
            path: "/dev/null".to_string(),
            filename: "x.mov".to_string(),
            created_at: None,
            duration_ms: dur,
            gps: None,
            resolution: None,
            frame_rate: None,
            trim,
            focal_point: focal,
            effects: Effects {
                stabilize: StabilizeSettings {
                    enabled: false,
                    shakiness: 5,
                },
                speed,
            },
            visible: true,
            map_overrides: None,
            entry_transition: None,
        }
    }

    fn fp(x: f64, y: f64, zoom: f64) -> FocalPoint {
        FocalPoint { x, y, zoom }
    }

    fn slot(w: u32, h: u32) -> PixelRect {
        PixelRect { x: 0, y: 0, w, h }
    }

    // ---- chain_atempo ----

    #[test]
    fn chain_atempo_identity_returns_one_factor() {
        let f = chain_atempo(1.0);
        assert_eq!(f.len(), 1);
        assert!((f[0] - 1.0).abs() < 1e-9);
    }

    #[test]
    fn chain_atempo_two_returns_two() {
        let f = chain_atempo(2.0);
        assert_eq!(f, vec![2.0]);
    }

    #[test]
    fn chain_atempo_four_chains_two_twos() {
        let f = chain_atempo(4.0);
        assert_eq!(f, vec![2.0, 2.0]);
    }

    #[test]
    fn chain_atempo_five() {
        let f = chain_atempo(5.0);
        assert_eq!(f.len(), 3);
        assert!((f[0] - 2.0).abs() < 1e-9);
        assert!((f[1] - 2.0).abs() < 1e-9);
        assert!((f[2] - 1.25).abs() < 1e-9);
    }

    #[test]
    fn chain_atempo_half() {
        let f = chain_atempo(0.5);
        assert_eq!(f, vec![0.5]);
    }

    #[test]
    fn chain_atempo_quarter() {
        let f = chain_atempo(0.25);
        assert_eq!(f.len(), 2);
        assert!((f[0] - 0.5).abs() < 1e-9);
        assert!((f[1] - 0.5).abs() < 1e-9);
    }

    #[test]
    fn chain_atempo_tenth() {
        let f = chain_atempo(0.1);
        assert_eq!(f.len(), 4);
        assert!((f[0] - 0.5).abs() < 1e-9);
        assert!((f[1] - 0.5).abs() < 1e-9);
        assert!((f[2] - 0.5).abs() < 1e-9);
        assert!((f[3] - 0.8).abs() < 1e-12);
    }

    // ---- compute_focal_crop ----

    #[test]
    fn aspect_fit_zoom_one_landscape_to_portrait() {
        // Source 1920×1080 (16:9), target 1080×1920 (9:16). Source wider
        // than target → aspect-fit matches src height, narrow width.
        // fit_h = 1080, fit_w = 1080 * (1080/1920) = 607.5.
        // Centered, focal=(0.5, 0.5): crop_x = (1920 - 607.5)/2 = 656.25.
        let crop = compute_focal_crop(
            PixelDims { w: 1920, h: 1080 },
            PixelDims { w: 1080, h: 1920 },
            &fp(0.5, 0.5, 1.0),
            "clip",
        )
        .unwrap();
        assert_eq!(crop.h, 1080);
        // 607.5 rounds half-away-from-zero to 608; crop_x rounds 656.25 → 656.
        assert!(crop.w == 607 || crop.w == 608, "crop.w={}", crop.w);
        assert!(crop.x >= 655 && crop.x <= 657, "crop.x={}", crop.x);
        assert_eq!(crop.y, 0);
        // Result stays inside the source.
        assert!(crop.x as u64 + crop.w as u64 <= 1920);
        assert!(crop.y as u64 + crop.h as u64 <= 1080);
    }

    #[test]
    fn aspect_fit_target_4_5() {
        // Source 1920×1080, target 1080×1350 (4:5). target_aspect = 0.8;
        // src_aspect = 1.7777 > 0.8 → fit_h = 1080, fit_w = 1080*0.8 = 864.
        let crop = compute_focal_crop(
            PixelDims { w: 1920, h: 1080 },
            PixelDims { w: 1080, h: 1350 },
            &fp(0.5, 0.5, 1.0),
            "clip",
        )
        .unwrap();
        assert_eq!(crop.w, 864);
        assert_eq!(crop.h, 1080);
    }

    #[test]
    fn aspect_fit_target_16_9() {
        // Source 1920×1080, target 1920×1080 (16:9): full source.
        let crop = compute_focal_crop(
            PixelDims { w: 1920, h: 1080 },
            PixelDims { w: 1920, h: 1080 },
            &fp(0.5, 0.5, 1.0),
            "clip",
        )
        .unwrap();
        assert_eq!(crop.w, 1920);
        assert_eq!(crop.h, 1080);
        assert_eq!(crop.x, 0);
        assert_eq!(crop.y, 0);
    }

    #[test]
    fn punch_in_zoom_two_halves_dims() {
        // Source 1920×1080 → target 1080×1920 fit_w=607.5, fit_h=1080.
        // zoom=2 → crop_w ≈ 303.75, crop_h = 540.
        let crop = compute_focal_crop(
            PixelDims { w: 1920, h: 1080 },
            PixelDims { w: 1080, h: 1920 },
            &fp(0.5, 0.5, 2.0),
            "clip",
        )
        .unwrap();
        assert!(crop.w >= 303 && crop.w <= 304, "crop.w={}", crop.w);
        assert_eq!(crop.h, 540);
    }

    #[test]
    fn focal_top_left_clamps_to_zero() {
        let crop = compute_focal_crop(
            PixelDims { w: 1920, h: 1080 },
            PixelDims { w: 1080, h: 1920 },
            &fp(0.0, 0.0, 1.0),
            "clip",
        )
        .unwrap();
        assert_eq!(crop.x, 0);
        assert_eq!(crop.y, 0);
    }

    #[test]
    fn focal_bottom_right_clamps_to_max() {
        let crop = compute_focal_crop(
            PixelDims { w: 1920, h: 1080 },
            PixelDims { w: 1080, h: 1920 },
            &fp(1.0, 1.0, 1.0),
            "clip",
        )
        .unwrap();
        assert!(crop.x as u64 + crop.w as u64 == 1920);
        assert!(crop.y as u64 + crop.h as u64 == 1080);
    }

    #[test]
    fn invalid_zoom_below_one_rejected() {
        let err = compute_focal_crop(
            PixelDims { w: 1920, h: 1080 },
            PixelDims { w: 1080, h: 1920 },
            &fp(0.5, 0.5, 0.5),
            "bad-clip",
        )
        .unwrap_err();
        match err {
            ClipChainError::InvalidZoom { clip_id, zoom } => {
                assert_eq!(clip_id, "bad-clip");
                assert!((zoom - 0.5).abs() < 1e-9);
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn missing_source_dims_rejected() {
        let err = compute_focal_crop(
            PixelDims { w: 0, h: 0 },
            PixelDims { w: 1080, h: 1920 },
            &fp(0.5, 0.5, 1.0),
            "no-dims",
        )
        .unwrap_err();
        assert!(matches!(err, ClipChainError::MissingSourceDims { .. }));
    }

    // ---- video / audio subgraph string ----

    #[test]
    fn video_subgraph_speed_one_zoom_one() {
        let clip = make_clip(
            1.0,
            fp(0.5, 0.5, 1.0),
            Some(TrimRange { in_ms: 0, out_ms: 2000 }),
            Some(2000),
        );
        let inputs = ClipChainInputs {
            input_index: 0,
            clip: &clip,
            source_dims: PixelDims { w: 1920, h: 1080 },
            video_slot: slot(1080, 1920),
            fps: 30,
        };
        let s = build_clip_video_subgraph(&inputs).unwrap();
        assert!(s.starts_with("[0:v]trim=start=0.000000:end=2.000000,"), "got: {}", s);
        assert!(s.contains("setpts=(PTS-STARTPTS)/1.000000"), "got: {}", s);
        assert!(s.contains(",scale=1080:1920,format=yuva444p10le[v0]"), "got: {}", s);
        // Crop ints, not subpixel.
        assert!(!s.contains("crop=607.5"), "subpixel leaked: {}", s);
    }

    #[test]
    fn video_subgraph_speed_two_zoom_one_point_five() {
        let clip = make_clip(
            2.0,
            fp(0.5, 0.5, 1.5),
            Some(TrimRange { in_ms: 500, out_ms: 1500 }),
            Some(2000),
        );
        let inputs = ClipChainInputs {
            input_index: 1,
            clip: &clip,
            source_dims: PixelDims { w: 1920, h: 1080 },
            video_slot: slot(1080, 1920),
            fps: 30,
        };
        let s = build_clip_video_subgraph(&inputs).unwrap();
        assert!(s.contains("trim=start=0.500000:end=1.500000"), "got: {}", s);
        assert!(s.contains("setpts=(PTS-STARTPTS)/2.000000"), "got: {}", s);
        assert!(s.ends_with("[v1]"), "got: {}", s);
    }

    #[test]
    fn video_subgraph_4k_to_9_16() {
        let clip = make_clip(
            1.0,
            fp(0.5, 0.5, 1.0),
            Some(TrimRange { in_ms: 0, out_ms: 1000 }),
            Some(1000),
        );
        let inputs = ClipChainInputs {
            input_index: 2,
            clip: &clip,
            source_dims: PixelDims { w: 3840, h: 2160 },
            video_slot: slot(1080, 1920),
            fps: 30,
        };
        let s = build_clip_video_subgraph(&inputs).unwrap();
        // 3840×2160 → fit_h=2160, fit_w=2160*(1080/1920)=1215. Centered.
        assert!(s.contains("crop=1215:2160:"), "got: {}", s);
        assert!(s.contains(",scale=1080:1920,"), "got: {}", s);
    }

    #[test]
    fn audio_subgraph_speed_one_omits_atempo() {
        let clip = make_clip(
            1.0,
            fp(0.5, 0.5, 1.0),
            Some(TrimRange { in_ms: 0, out_ms: 2000 }),
            Some(2000),
        );
        let inputs = ClipChainInputs {
            input_index: 0,
            clip: &clip,
            source_dims: PixelDims { w: 1920, h: 1080 },
            video_slot: slot(1080, 1920),
            fps: 30,
        };
        let s = build_clip_audio_subgraph(&inputs).unwrap();
        assert!(!s.contains("atempo"), "speed=1.0 should not emit atempo: {}", s);
        assert!(s.starts_with("[0:a]atrim=start=0.000000:end=2.000000,asetpts=PTS-STARTPTS"));
        assert!(s.ends_with("[a0]"));
    }

    #[test]
    fn audio_subgraph_speed_two_emits_one_atempo() {
        let clip = make_clip(
            2.0,
            fp(0.5, 0.5, 1.0),
            Some(TrimRange { in_ms: 0, out_ms: 2000 }),
            Some(2000),
        );
        let inputs = ClipChainInputs {
            input_index: 0,
            clip: &clip,
            source_dims: PixelDims { w: 1920, h: 1080 },
            video_slot: slot(1080, 1920),
            fps: 30,
        };
        let s = build_clip_audio_subgraph(&inputs).unwrap();
        assert_eq!(
            s.matches("atempo=").count(),
            1,
            "expected one atempo, got: {}",
            s,
        );
        assert!(s.contains("atempo=2.000000"), "got: {}", s);
    }

    #[test]
    fn audio_subgraph_speed_four_chains_two_twos() {
        let clip = make_clip(
            4.0,
            fp(0.5, 0.5, 1.0),
            Some(TrimRange { in_ms: 0, out_ms: 1000 }),
            Some(1000),
        );
        let inputs = ClipChainInputs {
            input_index: 0,
            clip: &clip,
            source_dims: PixelDims { w: 1920, h: 1080 },
            video_slot: slot(1080, 1920),
            fps: 30,
        };
        let s = build_clip_audio_subgraph(&inputs).unwrap();
        assert_eq!(s.matches("atempo=2.000000").count(), 2, "got: {}", s);
    }

    #[test]
    fn audio_subgraph_speed_quarter_chains_two_halves() {
        let clip = make_clip(
            0.25,
            fp(0.5, 0.5, 1.0),
            Some(TrimRange { in_ms: 0, out_ms: 1000 }),
            Some(1000),
        );
        let inputs = ClipChainInputs {
            input_index: 0,
            clip: &clip,
            source_dims: PixelDims { w: 1920, h: 1080 },
            video_slot: slot(1080, 1920),
            fps: 30,
        };
        let s = build_clip_audio_subgraph(&inputs).unwrap();
        assert_eq!(s.matches("atempo=0.500000").count(), 2, "got: {}", s);
    }

    #[test]
    fn audio_subgraph_speed_five_chains_two_twos_and_one_quarter() {
        let clip = make_clip(
            5.0,
            fp(0.5, 0.5, 1.0),
            Some(TrimRange { in_ms: 0, out_ms: 1000 }),
            Some(1000),
        );
        let inputs = ClipChainInputs {
            input_index: 0,
            clip: &clip,
            source_dims: PixelDims { w: 1920, h: 1080 },
            video_slot: slot(1080, 1920),
            fps: 30,
        };
        let s = build_clip_audio_subgraph(&inputs).unwrap();
        assert_eq!(s.matches("atempo=2.000000").count(), 2, "got: {}", s);
        assert!(s.contains("atempo=1.250000"), "got: {}", s);
    }

    #[test]
    fn build_clip_chain_returns_labels() {
        let clip = make_clip(
            1.0,
            fp(0.5, 0.5, 1.0),
            Some(TrimRange { in_ms: 0, out_ms: 1000 }),
            Some(1000),
        );
        let inputs = ClipChainInputs {
            input_index: 3,
            clip: &clip,
            source_dims: PixelDims { w: 1920, h: 1080 },
            video_slot: slot(1080, 1920),
            fps: 30,
        };
        let out = build_clip_chain(&inputs).unwrap();
        assert_eq!(out.video_label, "v3");
        assert_eq!(out.audio_label.as_deref(), Some("a3"));
        assert!(out.video_subgraph.ends_with("[v3]"));
        assert!(out.audio_subgraph.as_ref().unwrap().ends_with("[a3]"));
    }

    #[test]
    fn invalid_speed_rejected() {
        let clip = make_clip(
            -1.0,
            fp(0.5, 0.5, 1.0),
            Some(TrimRange { in_ms: 0, out_ms: 1000 }),
            Some(1000),
        );
        let inputs = ClipChainInputs {
            input_index: 0,
            clip: &clip,
            source_dims: PixelDims { w: 1920, h: 1080 },
            video_slot: slot(1080, 1920),
            fps: 30,
        };
        let err = build_clip_video_subgraph(&inputs).unwrap_err();
        assert!(matches!(err, ClipChainError::InvalidSpeed { .. }));
    }

    #[test]
    fn invalid_trim_rejected() {
        let clip = make_clip(
            1.0,
            fp(0.5, 0.5, 1.0),
            Some(TrimRange { in_ms: 1000, out_ms: 1000 }), // empty trim
            Some(2000),
        );
        let inputs = ClipChainInputs {
            input_index: 0,
            clip: &clip,
            source_dims: PixelDims { w: 1920, h: 1080 },
            video_slot: slot(1080, 1920),
            fps: 30,
        };
        let err = build_clip_video_subgraph(&inputs).unwrap_err();
        assert!(matches!(err, ClipChainError::InvalidTrim { .. }));
    }
}
