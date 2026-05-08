// Pure FFmpeg argv builders for Channels B (map-only) and C (video-only)
// — tasks 060 and 070.
//
// LAYOUT.md §6 — masked positional export: full-aspect canvas, content at
// the channel's slot rect, alpha=0 elsewhere, ProRes 4444 in `.mov`. The
// filtergraphs this module emits are what enforce that invariant for both
// channels.
//
// Pure: same inputs → same argv. No IO. No side effects. Tested in isolation
// (see `tests` below); production use lives in `ffmpeg_sink.rs` (Channel B)
// and `ffmpeg_runner.rs` (Channel C) which spawn FFmpeg with the returned
// argv.

use std::path::{Path, PathBuf};

use crate::export::clip_chain::{
    build_clip_audio_subgraph, build_clip_video_subgraph, chain_atempo, ClipChainInputs, PixelDims,
};
use crate::export::encoder::EncoderChoice;
use crate::export::error::ClipChainError;
use crate::export::layout::{OutputDimensions, PixelRect};
use crate::models::Clip;

/// Argv chunks ready to splat into the full FFmpeg invocation, plus the
/// per-frame byte count the orchestrator's sink uses to validate frames.
#[derive(Debug, Clone)]
pub struct FiltergraphPlan {
    /// Full argv, sans the leading FFmpeg binary path. Caller passes this
    /// to `Command::new(ffmpeg_path).args(&plan.argv)`.
    pub argv: Vec<String>,
    /// Bytes per RGBA frame the orchestrator writes into stdin
    /// (`slot.w * slot.h * 4`). The sink uses this to assert frames match.
    pub frame_bytes_per_input: usize,
}

/// Build the FFmpeg argv for a Channel B (map-only) render.
///
/// The argv covers:
/// - rawvideo input on stdin sized to `slot` at `fps`,
/// - optional second input (the corner-mask PNG, looped), when
///   `corner_mask_png_path` is provided,
/// - `-frames:v {total_frames}` cap so both inputs stop together,
/// - filter_complex that:
///     * promotes the map stream to `yuva444p10le` (must run *before* `pad`
///       — the alpha channel must exist before `pad` adds the transparent
///       canvas, otherwise the canvas paints opaque black),
///     * (corner case) `alphamerge`s the mask onto the map's alpha,
///     * `pad`s onto the full output canvas at `(slot.x, slot.y)` with
///       transparent fill.
/// - `-an` — Channel B is silent (LAYOUT.md §8).
/// - `encoder.codec_args` spliced after `-map "[v]"` — ProRes 4444 with
///   alpha, `apl0` vendor tag.
/// - `-movflags +faststart` for QuickTime/NLE friendliness.
pub fn build_map_only_filtergraph(
    slot: PixelRect,
    output: OutputDimensions,
    corner_mask_png_path: Option<&Path>,
    fps: u32,
    total_frames: u32,
    encoder: &EncoderChoice,
    output_path: &Path,
) -> FiltergraphPlan {
    let mut argv: Vec<String> = Vec::new();
    push(&mut argv, ["-hide_banner", "-y"]);

    // Input 0: rawvideo on stdin sized to the slot (worker renders at slot dims).
    push(&mut argv, ["-f", "rawvideo", "-pix_fmt", "rgba"]);
    argv.push("-s".to_string());
    argv.push(format!("{}x{}", slot.w, slot.h));
    argv.push("-r".to_string());
    argv.push(fps.to_string());
    push(&mut argv, ["-i", "pipe:0"]);

    // Input 1 (optional): corner-mask PNG, looped.
    if let Some(mask) = corner_mask_png_path {
        push(&mut argv, ["-loop", "1"]);
        argv.push("-i".to_string());
        argv.push(mask.to_string_lossy().into_owned());
    }

    // Total-frames cap. Required because the looping mask input has no
    // intrinsic end; capping the output terminates both inputs cleanly.
    argv.push("-frames:v".to_string());
    argv.push(total_frames.to_string());

    // filter_complex
    argv.push("-filter_complex".to_string());
    argv.push(build_filter_complex(slot, output, corner_mask_png_path.is_some()));

    push(&mut argv, ["-map", "[v]", "-an"]);

    // ProRes codec args (carries `-c:v prores_ks` + profile + pix_fmt + vendor).
    for a in &encoder.codec_args {
        argv.push(a.clone());
    }

    push(&mut argv, ["-movflags", "+faststart"]);

    argv.push(output_path.to_string_lossy().into_owned());

    FiltergraphPlan {
        argv,
        frame_bytes_per_input: (slot.w as usize) * (slot.h as usize) * 4,
    }
}

fn build_filter_complex(slot: PixelRect, output: OutputDimensions, with_mask: bool) -> String {
    let pad = format!(
        "pad={out_w}:{out_h}:{x}:{y}:color=#00000000",
        out_w = output.w,
        out_h = output.h,
        x = slot.x,
        y = slot.y,
    );
    if with_mask {
        // [0:v] format=yuva444p10le → map (with alpha)
        // [1:v] format=gray         → mask (single-channel)
        // alphamerge replaces map's alpha with the mask's grayscale.
        // Final pad places the masked map at the slot rect on a transparent canvas.
        format!(
            "[0:v]format=yuva444p10le[map];\
             [1:v]format=gray[mask];\
             [map][mask]alphamerge[masked];\
             [masked]{pad}[v]"
        )
    } else {
        // No mask: pad the full slot at the right position. `format=yuva...`
        // before `pad` is load-bearing — see module docstring.
        format!("[0:v]format=yuva444p10le,{pad}[v]")
    }
}

fn push<const N: usize>(argv: &mut Vec<String>, parts: [&str; N]) {
    for p in parts {
        argv.push(p.to_string());
    }
}

// =====================================================================
// Channel C (video-only) filtergraph — task 070.
// =====================================================================

/// One row of input to `build_video_only_filtergraph`. The caller (the
/// `render_export` `video_only` branch) populates these by walking the
/// visible-clip list, validating source paths, and probing each via
/// `ffprobe::probe_clip`.
#[derive(Debug, Clone)]
pub struct VisibleClipInput {
    pub source_path: PathBuf,
    /// Owned because the request struct hands ownership over.
    pub clip: Clip,
    pub source_dims: PixelDims,
    pub has_audio: bool,
}

/// Build the FFmpeg argv for a Channel C (video-only) render.
///
/// The argv covers, for every visible clip:
/// - one `-i {source_path}` input (in timeline order),
/// - per-clip video sub-graph: `trim → setpts → focal-crop → scale →
///   format=yuva444p10le[vN]`,
/// - per-clip audio sub-graph: `atrim → asetpts → atempo*[aN]`, or, if
///   the source has no audio stream, `aevalsrc=0:duration=...[aN]` so the
///   audio-side `concat` filter's `n` count matches the video side,
/// - a video `concat=n=N:v=1:a=0[vc]` and a parallel audio
///   `concat=n=N:v=0:a=1[aout]`,
/// - optional `alphamerge` pass with a corner-mask PNG (when the layout
///   has a non-zero corner radius and the radius applies to the *video*
///   slot, mirroring Channel B's behavior on the map slot),
/// - a final `pad={out.w}:{out.h}:{slot.x}:{slot.y}:color=#00000000[vout]`
///   that positions the concatenated (and possibly masked) video on a
///   full-aspect transparent canvas at the slot rect.
///
/// `-c:v` flags come from `encoder.codec_args` (ProRes 4444). `-c:a`
/// flags come from `audio_encoder_args` (`-c:a pcm_s16le` per LAYOUT.md
/// §8 / task 070 spec).
///
/// `frame_bytes_per_input` is 0 — Channel C reads source files directly,
/// no rawvideo input.
#[allow(clippy::too_many_arguments)]
pub fn build_video_only_filtergraph(
    visible_clips: &[VisibleClipInput],
    slot: PixelRect,
    output: OutputDimensions,
    corner_mask_png_path: Option<&Path>,
    fps: u32,
    encoder: &EncoderChoice,
    audio_encoder_args: &[&str],
    output_path: &Path,
) -> Result<FiltergraphPlan, ClipChainError> {
    assert!(
        !visible_clips.is_empty(),
        "build_video_only_filtergraph requires at least one visible clip; \
         the caller (`render_export`) is expected to error on empty timelines",
    );

    let mut argv: Vec<String> = Vec::new();
    push(&mut argv, ["-hide_banner", "-y"]);

    // One `-i {path}` per clip, in timeline order.
    for vc in visible_clips {
        argv.push("-i".to_string());
        argv.push(vc.source_path.to_string_lossy().into_owned());
    }

    // Optional last input: corner-mask PNG, looped. The mask input index
    // is `visible_clips.len()` — load-bearing for the filter_complex; a
    // future refactor that reorders inputs MUST update the mask reference.
    if let Some(mask) = corner_mask_png_path {
        push(&mut argv, ["-loop", "1"]);
        argv.push("-i".to_string());
        argv.push(mask.to_string_lossy().into_owned());
    }

    // -filter_complex
    let fc = build_video_only_filter_complex(visible_clips, slot, output, fps, corner_mask_png_path.is_some())?;
    argv.push("-filter_complex".to_string());
    argv.push(fc);

    push(&mut argv, ["-map", "[vout]", "-map", "[aout]"]);

    // ProRes codec args (carries `-c:v prores_ks` + profile + pix_fmt + vendor).
    for a in &encoder.codec_args {
        argv.push(a.clone());
    }

    // Audio codec — typically `-c:a pcm_s16le`.
    for a in audio_encoder_args {
        argv.push((*a).to_string());
    }

    push(&mut argv, ["-movflags", "+faststart"]);

    argv.push(output_path.to_string_lossy().into_owned());

    Ok(FiltergraphPlan {
        argv,
        // Channel C has no rawvideo input — used as a flag by the runner.
        frame_bytes_per_input: 0,
    })
}

fn build_video_only_filter_complex(
    visible_clips: &[VisibleClipInput],
    slot: PixelRect,
    output: OutputDimensions,
    fps: u32,
    with_mask: bool,
) -> Result<String, ClipChainError> {
    let n = visible_clips.len();
    let mut parts: Vec<String> = Vec::with_capacity(n * 2 + 4);

    // Per-clip video subgraphs.
    for (idx, vc) in visible_clips.iter().enumerate() {
        let inputs = ClipChainInputs {
            input_index: idx as u32,
            clip: &vc.clip,
            source_dims: vc.source_dims,
            video_slot: slot,
            fps,
        };
        parts.push(build_clip_video_subgraph(&inputs)?);
    }

    // Video-side concat: [v0][v1]...concat=n=N:v=1:a=0[vc].
    let video_inputs: String = (0..n).map(|i| format!("[v{}]", i)).collect::<Vec<_>>().join("");
    parts.push(format!("{video_inputs}concat=n={n}:v=1:a=0[vc]"));

    // Optional alphamerge with the corner mask. Mask input index == n.
    // `shortest=1` ends the alphamerge filter when [vc] (the finite-duration
    // concat output) ends — without it, FFmpeg keeps reading frames from
    // the `-loop 1` mask input indefinitely and the encoder hangs. The
    // looped mask is necessary because `-loop 1` is the idiomatic way to
    // hold a single-frame PNG for the duration of a paired finite stream;
    // `shortest=1` is the dual half of that pattern.
    let pre_pad_label = if with_mask {
        parts.push(format!("[{n}:v]format=gray[mask]"));
        parts.push("[vc][mask]alphamerge=shortest=1[vmasked]".to_string());
        "[vmasked]"
    } else {
        "[vc]"
    };

    // Final pad onto full-aspect transparent canvas at slot rect.
    parts.push(format!(
        "{pre}pad={out_w}:{out_h}:{x}:{y}:color=#00000000[vout]",
        pre = pre_pad_label,
        out_w = output.w,
        out_h = output.h,
        x = slot.x,
        y = slot.y,
    ));

    // Per-clip audio subgraphs (or `aevalsrc=0` for clips without audio).
    for (idx, vc) in visible_clips.iter().enumerate() {
        if vc.has_audio {
            let inputs = ClipChainInputs {
                input_index: idx as u32,
                clip: &vc.clip,
                source_dims: vc.source_dims,
                video_slot: slot,
                fps,
            };
            parts.push(build_clip_audio_subgraph(&inputs)?);
        } else {
            // Synthesize silence matching the trimmed + speed-adjusted span
            // so audio-side concat's `n` count matches video-side. Without
            // this fallback FFmpeg's concat filter errors with "Input link
            // parameters do not match" when inputs have heterogeneous audio
            // presence. Rare in practice (iPhone videos always carry audio).
            let span_s = trimmed_audio_span_seconds(&vc.clip)?;
            parts.push(format!(
                "aevalsrc=0:duration={span_s:.6}:sample_rate=48000[a{idx}]",
                span_s = span_s,
                idx = idx,
            ));
        }
    }

    // Audio-side concat.
    let audio_inputs: String = (0..n).map(|i| format!("[a{}]", i)).collect::<Vec<_>>().join("");
    parts.push(format!("{audio_inputs}concat=n={n}:v=0:a=1[aout]"));

    Ok(parts.join(";"))
}

// =====================================================================
// Channel A (composite) filtergraph — task 090.
// =====================================================================

/// Composite mode discriminator. Picked by `render_export`'s composite
/// branch from `(layout.layout, resolved.corner_radius_slot)` and passed
/// into the builder as a pure value.
///
/// LAYOUT.md §1: PiP has a "background" source (full-bleed) and an
/// "inset" source (small, placed at a slot rect, optionally with rounded
/// corners). Split has two side-by-side slots, no overlap, no rounded
/// corners. The three variants here cover all current layouts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompositeMode {
    /// PiP, map is the inset (small), video is the full-bleed background.
    /// `corner_radius_slot == Map`.
    PipMapInset,
    /// PiP, video is the inset (small), map is the full-bleed background.
    /// `corner_radius_slot == Video`.
    PipVideoInset,
    /// Split — map and video tile the frame at their slots, no overlap, no
    /// corner radius (LAYOUT.md §1 — Split has no inset).
    Split,
}

/// Build the FFmpeg argv for a Channel A (composite) render.
///
/// The argv covers, for every visible clip:
/// - one `-i {source_path}` input (timeline order, indices `0..N`),
/// - one rawvideo input on stdin sized to `map_slot` at `fps` (index `N`)
///   — fed by the orchestrator's renderer worker via `FFmpegSink`,
/// - optionally a corner-mask PNG, looped (index `N+1`),
/// - per-clip video sub-graph from `clip_chain` (`trim → setpts → crop →
///   scale → format=yuva444p10le[v{i}]`),
/// - per-clip audio sub-graph from `clip_chain` (`atrim → asetpts →
///   atempo*[a{i}]`), or `aevalsrc=0` silence for clips without audio,
/// - a video `concat=n=N:v=1:a=0[vc]` and an audio `concat=…[aout]`,
/// - mode-specific compositing:
///     * `PipMapInset`: `[vc][map]overlay=map_slot.x:map_slot.y` —
///       optionally with `[map][mask]alphamerge` first when masked.
///     * `PipVideoInset`: `[map][vc]overlay=video_slot.x:video_slot.y` —
///       optionally with `[vc][mask]alphamerge` first when masked.
///     * `Split`: synthesize an opaque black canvas at output size,
///       overlay the map at its slot, then the video at its slot. No
///       mask path — Split structurally has no corner radius.
/// - final `format=yuv420p[vout]` to strip alpha for H.265 4:2:0 output,
/// - `-map [vout] -map [aout]`, HEVC encoder spliced (`-c:v {name}` +
///   `codec_args`), AAC audio (`-c:a aac -b:a 256k`), `+faststart`.
///
/// `frame_bytes_per_input == map_slot.w * map_slot.h * 4` — the
/// orchestrator writes RGBA frames at the map slot dims.
///
/// Per-clip subgraphs are built via `clip_chain::build_clip_video_subgraph`
/// and `clip_chain::build_clip_audio_subgraph` — *not* re-derived inline.
/// LAYOUT.md §7's invariant: A's video pipeline equals C's, byte-for-byte.
#[allow(clippy::too_many_arguments)]
pub fn build_composite_filtergraph(
    visible_clips: &[VisibleClipInput],
    map_slot: PixelRect,
    video_slot: PixelRect,
    output: OutputDimensions,
    composite_mode: CompositeMode,
    corner_mask_png_path: Option<&Path>,
    fps: u32,
    total_frames: u32,
    video_encoder: &EncoderChoice,
    audio_encoder_args: &[&str],
    output_path: &Path,
) -> Result<FiltergraphPlan, ClipChainError> {
    assert!(
        !visible_clips.is_empty(),
        "build_composite_filtergraph requires at least one visible clip; \
         the caller (`render_export`) is expected to error on empty timelines",
    );

    let mut argv: Vec<String> = Vec::new();
    push(&mut argv, ["-hide_banner", "-y"]);

    // Inputs `0..N`: per-clip source files in timeline order.
    for vc in visible_clips {
        argv.push("-i".to_string());
        argv.push(vc.source_path.to_string_lossy().into_owned());
    }

    // Input `N`: rawvideo on stdin (map render stream from the worker)
    // sized to map_slot (the worker renders at slot dims).
    push(&mut argv, ["-f", "rawvideo", "-pix_fmt", "rgba"]);
    argv.push("-s".to_string());
    argv.push(format!("{}x{}", map_slot.w, map_slot.h));
    argv.push("-r".to_string());
    argv.push(fps.to_string());
    push(&mut argv, ["-i", "pipe:0"]);

    // Input `N+1` (optional): corner-mask PNG, looped. Only meaningful
    // for PipMapInset / PipVideoInset; Split callers pass `None`.
    if let Some(mask) = corner_mask_png_path {
        push(&mut argv, ["-loop", "1"]);
        argv.push("-i".to_string());
        argv.push(mask.to_string_lossy().into_owned());
    }

    // Total-frames cap. Required because the rawvideo input has no
    // intrinsic length and the optional looped mask is unbounded; the
    // concat output's duration may also disagree with `total_frames` by
    // a frame, and `-frames:v` caps the *output* so both inputs
    // terminate at the same point. Same role as Channel B.
    argv.push("-frames:v".to_string());
    argv.push(total_frames.to_string());

    let fc = build_composite_filter_complex(
        visible_clips,
        map_slot,
        video_slot,
        output,
        composite_mode,
        fps,
        corner_mask_png_path.is_some(),
    )?;
    argv.push("-filter_complex".to_string());
    argv.push(fc);

    push(&mut argv, ["-map", "[vout]", "-map", "[aout]"]);

    // HEVC encoder splice. Per encoder.rs: HEVC's `codec_args` does NOT
    // include the `-c:v` prefix (encoder::tests::hevc_codec_args_omit_c_v_prefix);
    // we prepend it here. ProRes is the dual case (its codec_args includes
    // the prefix); composite never uses ProRes — Channel A is HEVC.
    argv.push("-c:v".to_string());
    argv.push(video_encoder.name.clone());
    for a in &video_encoder.codec_args {
        argv.push(a.clone());
    }

    // Audio codec — typically `["-c:a", "aac", "-b:a", "256k"]`.
    for a in audio_encoder_args {
        argv.push((*a).to_string());
    }

    push(&mut argv, ["-movflags", "+faststart"]);

    argv.push(output_path.to_string_lossy().into_owned());

    Ok(FiltergraphPlan {
        argv,
        // RGBA frames at the map slot dims (the rawvideo input geometry).
        frame_bytes_per_input: (map_slot.w as usize) * (map_slot.h as usize) * 4,
    })
}

fn build_composite_filter_complex(
    visible_clips: &[VisibleClipInput],
    map_slot: PixelRect,
    video_slot: PixelRect,
    output: OutputDimensions,
    composite_mode: CompositeMode,
    fps: u32,
    with_mask: bool,
) -> Result<String, ClipChainError> {
    let n = visible_clips.len();
    let mut parts: Vec<String> = Vec::with_capacity(n * 2 + 8);

    // Per-clip video subgraphs. NOTE — the slot passed here is the
    // *video* slot, not the map slot. Channel A's per-clip video chain
    // is identical to Channel C's (LAYOUT.md §7 invariant); both feed
    // the video stream into the video slot's pixel dims regardless of
    // whether that slot is full-bleed (PipMapInset) or inset
    // (PipVideoInset).
    for (idx, vc) in visible_clips.iter().enumerate() {
        let inputs = ClipChainInputs {
            input_index: idx as u32,
            clip: &vc.clip,
            source_dims: vc.source_dims,
            video_slot,
            fps,
        };
        parts.push(build_clip_video_subgraph(&inputs)?);
    }

    // Video-side concat: `[v0][v1]...concat=n=N:v=1:a=0[vc]`.
    let video_inputs: String = (0..n).map(|i| format!("[v{}]", i)).collect::<Vec<_>>().join("");
    parts.push(format!("{video_inputs}concat=n={n}:v=1:a=0[vc]"));

    // Map stream — rawvideo input at index N. Promote to yuva444p10le
    // so `alphamerge` (when masked) and `overlay` see uniform pix_fmts.
    parts.push(format!("[{n}:v]format=yuva444p10le[map]"));

    // Mode-specific composite chain.
    match composite_mode {
        CompositeMode::PipMapInset => {
            // Video full-bleed background; map (optionally masked) overlaid
            // at the map slot's `(x, y)`.
            if with_mask {
                let mask_idx = n + 1;
                parts.push(format!("[{mask_idx}:v]format=gray[mask]"));
                parts.push("[map][mask]alphamerge[map_masked]".to_string());
                parts.push(format!(
                    "[vc][map_masked]overlay={x}:{y}:format=auto[vout_alpha]",
                    x = map_slot.x,
                    y = map_slot.y,
                ));
            } else {
                parts.push(format!(
                    "[vc][map]overlay={x}:{y}:format=auto[vout_alpha]",
                    x = map_slot.x,
                    y = map_slot.y,
                ));
            }
            parts.push("[vout_alpha]format=yuv420p[vout]".to_string());
        }
        CompositeMode::PipVideoInset => {
            // Map full-bleed background; video (optionally masked) overlaid
            // at the video slot's `(x, y)`.
            if with_mask {
                let mask_idx = n + 1;
                parts.push(format!("[{mask_idx}:v]format=gray[mask]"));
                parts.push("[vc][mask]alphamerge[vc_masked]".to_string());
                parts.push(format!(
                    "[map][vc_masked]overlay={x}:{y}:format=auto[vout_alpha]",
                    x = video_slot.x,
                    y = video_slot.y,
                ));
            } else {
                parts.push(format!(
                    "[map][vc]overlay={x}:{y}:format=auto[vout_alpha]",
                    x = video_slot.x,
                    y = video_slot.y,
                ));
            }
            parts.push("[vout_alpha]format=yuv420p[vout]".to_string());
        }
        CompositeMode::Split => {
            // Split has no inset and (per resolve_slots) zero corner
            // radius. Synthesize an opaque black canvas at output size,
            // overlay map at its slot, then video at its slot. The two
            // slots don't overlap — order is structurally irrelevant
            // (map first by convention).
            parts.push(format!(
                "color=c=black:s={out_w}x{out_h}:r={fps},format=yuv444p10le[bg]",
                out_w = output.w,
                out_h = output.h,
                fps = fps,
            ));
            parts.push(format!(
                "[bg][map]overlay={x}:{y}[bg_with_map]",
                x = map_slot.x,
                y = map_slot.y,
            ));
            parts.push(format!(
                "[bg_with_map][vc]overlay={x}:{y}:format=auto[vout_alpha]",
                x = video_slot.x,
                y = video_slot.y,
            ));
            parts.push("[vout_alpha]format=yuv420p[vout]".to_string());
        }
    }

    // Per-clip audio subgraphs (or `aevalsrc=0` for clips without audio).
    // Identical shape to Channel C — re-encoded as AAC at the encoder
    // splice rather than passed through as PCM, but the filter chain is
    // the same.
    for (idx, vc) in visible_clips.iter().enumerate() {
        if vc.has_audio {
            let inputs = ClipChainInputs {
                input_index: idx as u32,
                clip: &vc.clip,
                source_dims: vc.source_dims,
                video_slot,
                fps,
            };
            parts.push(build_clip_audio_subgraph(&inputs)?);
        } else {
            let span_s = trimmed_audio_span_seconds(&vc.clip)?;
            parts.push(format!(
                "aevalsrc=0:duration={span_s:.6}:sample_rate=48000[a{idx}]",
                span_s = span_s,
                idx = idx,
            ));
        }
    }

    // Audio-side concat.
    let audio_inputs: String = (0..n).map(|i| format!("[a{}]", i)).collect::<Vec<_>>().join("");
    parts.push(format!("{audio_inputs}concat=n={n}:v=0:a=1[aout]"));

    Ok(parts.join(";"))
}

/// Trimmed-and-speed-adjusted audio span in seconds. For the silence
/// fallback when a clip lacks an audio stream — must match the video
/// side's effective duration so concat lines up.
fn trimmed_audio_span_seconds(clip: &Clip) -> Result<f64, ClipChainError> {
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
    let speed = clip.effects.speed;
    if !speed.is_finite() || speed <= 0.0 {
        return Err(ClipChainError::InvalidSpeed {
            clip_id: clip.id.clone(),
            speed,
        });
    }
    // Sanity: chain_atempo produces a valid factor list for the speed —
    // call to keep parity with the audio subgraph builder, but the
    // returned span_s is just (out-in)/speed regardless of how atempo is
    // chained.
    let _ = chain_atempo(speed);
    Ok((out_ms - in_ms) as f64 / 1000.0 / speed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::encoder::{EncoderClass, EncoderKind};

    fn prores_choice() -> EncoderChoice {
        EncoderChoice {
            class: EncoderClass::ProResAlpha,
            name: "prores_ks".to_string(),
            kind: EncoderKind::Software,
            codec_args: vec![
                "-c:v".into(),
                "prores_ks".into(),
                "-profile:v".into(),
                "4444".into(),
                "-pix_fmt".into(),
                "yuva444p10le".into(),
                "-vendor".into(),
                "apl0".into(),
            ],
            probe_wall_clock_ms: 12,
        }
    }

    fn out_path() -> &'static Path {
        Path::new("/tmp/out.mov")
    }

    fn argv_to_string(argv: &[String]) -> String {
        argv.join(" ")
    }

    #[test]
    fn no_corner_radius_full_bleed_map() {
        // Full-bleed map: slot fills the output. (PiP-with-map-as-background.)
        let slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let plan = build_map_only_filtergraph(
            slot,
            output,
            None,
            30,
            60,
            &prores_choice(),
            out_path(),
        );
        let joined = argv_to_string(&plan.argv);

        // Exactly one stdin input, no looped mask.
        assert_eq!(plan.argv.iter().filter(|a| *a == "-i").count(), 1);
        assert!(!plan.argv.iter().any(|a| a == "-loop"));
        // pipe:0 is the input.
        assert!(joined.contains("-i pipe:0"));

        // filter_complex contains format=yuva… BEFORE pad (load-bearing).
        let fc = plan
            .argv
            .iter()
            .position(|a| a == "-filter_complex")
            .map(|i| &plan.argv[i + 1])
            .expect("filter_complex argument");
        let fmt_pos = fc.find("format=yuva444p10le").expect("yuva format in chain");
        let pad_pos = fc.find("pad=").expect("pad in chain");
        assert!(fmt_pos < pad_pos, "format=yuva… must precede pad: {}", fc);

        // pad geometry encodes (W:H:X:Y).
        assert!(fc.contains("pad=1080:1920:0:0:color=#00000000"), "fc was: {}", fc);

        // Frames cap and silence.
        assert!(joined.contains("-frames:v 60"));
        assert!(joined.contains("-an"));

        // ProRes args present.
        assert!(joined.contains("-c:v prores_ks"));
        assert!(joined.contains("yuva444p10le"));
        assert!(joined.contains("apl0"));

        // Output path at the tail.
        assert_eq!(plan.argv.last().unwrap(), "/tmp/out.mov");

        assert_eq!(plan.frame_bytes_per_input, 1080 * 1920 * 4);
    }

    #[test]
    fn no_corner_radius_pip_bottom_right_9_16() {
        // Map-as-inset is impossible without a mask in this code path, but
        // the spec lists "PiP-bottom-right at 9:16" as a representative case
        // for the no-mask branch (i.e., zero corner radius). Validate the
        // (W:H:X:Y) numbers come through correctly.
        let slot = PixelRect { x: 702, y: 1497, w: 346, h: 346 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let plan = build_map_only_filtergraph(
            slot,
            output,
            None,
            30,
            120,
            &prores_choice(),
            out_path(),
        );
        let fc = plan
            .argv
            .iter()
            .position(|a| a == "-filter_complex")
            .map(|i| &plan.argv[i + 1])
            .unwrap();
        assert!(
            fc.contains("pad=1080:1920:702:1497:color=#00000000"),
            "fc was: {}",
            fc,
        );
        assert_eq!(plan.frame_bytes_per_input, 346 * 346 * 4);
    }

    #[test]
    fn no_corner_radius_split_left_16_9() {
        // Split-left at 16:9: map slot is the right half.
        let slot = PixelRect { x: 960, y: 0, w: 960, h: 1080 };
        let output = OutputDimensions { w: 1920, h: 1080 };
        let plan = build_map_only_filtergraph(
            slot,
            output,
            None,
            30,
            90,
            &prores_choice(),
            out_path(),
        );
        let fc = plan
            .argv
            .iter()
            .position(|a| a == "-filter_complex")
            .map(|i| &plan.argv[i + 1])
            .unwrap();
        assert!(
            fc.contains("pad=1920:1080:960:0:color=#00000000"),
            "fc was: {}",
            fc,
        );
    }

    #[test]
    fn corner_radius_uses_alphamerge_with_loop_1() {
        let slot = PixelRect { x: 702, y: 1497, w: 346, h: 346 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let mask_path = Path::new("/tmp/mask.png");
        let plan = build_map_only_filtergraph(
            slot,
            output,
            Some(mask_path),
            30,
            60,
            &prores_choice(),
            out_path(),
        );

        // Two inputs.
        assert_eq!(plan.argv.iter().filter(|a| *a == "-i").count(), 2);
        // -loop 1 immediately precedes the mask path. Find the mask path
        // index, then inspect the two argv entries that precede it.
        let mask_idx = plan
            .argv
            .iter()
            .position(|a| a == "/tmp/mask.png")
            .expect("mask path in argv");
        assert!(mask_idx >= 3, "expected -loop 1 -i <mask> chain");
        assert_eq!(plan.argv[mask_idx - 1], "-i");
        assert_eq!(plan.argv[mask_idx - 3], "-loop");
        assert_eq!(plan.argv[mask_idx - 2], "1");

        let fc = plan
            .argv
            .iter()
            .position(|a| a == "-filter_complex")
            .map(|i| &plan.argv[i + 1])
            .unwrap();
        assert!(fc.contains("alphamerge"), "fc was: {}", fc);
        assert!(fc.contains("[1:v]format=gray"), "fc was: {}", fc);
        assert!(fc.contains("format=yuva444p10le"), "fc was: {}", fc);
        assert!(
            fc.contains("pad=1080:1920:702:1497:color=#00000000"),
            "fc was: {}",
            fc,
        );

        assert_eq!(plan.frame_bytes_per_input, 346 * 346 * 4);
    }

    #[test]
    fn frame_bytes_matches_slot_area_x4() {
        for (w, h) in &[(540u32, 960u32), (1080, 1920), (1920, 1080), (1, 1)] {
            let slot = PixelRect { x: 0, y: 0, w: *w, h: *h };
            let output = OutputDimensions { w: *w, h: *h };
            let plan = build_map_only_filtergraph(
                slot,
                output,
                None,
                30,
                1,
                &prores_choice(),
                out_path(),
            );
            assert_eq!(plan.frame_bytes_per_input, (*w as usize) * (*h as usize) * 4);
        }
    }

    #[test]
    fn argv_starts_with_hide_banner_and_y() {
        let slot = PixelRect { x: 0, y: 0, w: 100, h: 100 };
        let output = OutputDimensions { w: 100, h: 100 };
        let plan = build_map_only_filtergraph(
            slot,
            output,
            None,
            30,
            10,
            &prores_choice(),
            out_path(),
        );
        assert_eq!(plan.argv[0], "-hide_banner");
        assert_eq!(plan.argv[1], "-y");
    }

    #[test]
    fn faststart_is_set() {
        let slot = PixelRect { x: 0, y: 0, w: 100, h: 100 };
        let output = OutputDimensions { w: 100, h: 100 };
        let plan = build_map_only_filtergraph(
            slot,
            output,
            None,
            30,
            10,
            &prores_choice(),
            out_path(),
        );
        let joined = argv_to_string(&plan.argv);
        assert!(joined.contains("-movflags +faststart"));
    }

    // -----------------------------------------------------------------
    // Channel C (video-only) — build_video_only_filtergraph tests
    // -----------------------------------------------------------------

    use crate::export::clip_chain::PixelDims;
    use crate::models::{Clip, Effects, FocalPoint, StabilizeSettings, TrimRange};

    fn make_video_clip(id: &str, dur_ms: u64) -> Clip {
        Clip {
            id: id.to_string(),
            path: format!("/dev/null/{}.mov", id),
            filename: format!("{}.mov", id),
            created_at: None,
            duration_ms: Some(dur_ms),
            gps: None,
            resolution: Some("1920x1080".to_string()),
            frame_rate: Some(30.0),
            trim: Some(TrimRange { in_ms: 0, out_ms: dur_ms }),
            focal_point: FocalPoint { x: 0.5, y: 0.5, zoom: 1.0 },
            effects: Effects {
                stabilize: StabilizeSettings {
                    enabled: false,
                    shakiness: 5,
                },
                speed: 1.0,
            },
            visible: true,
            map_overrides: None,
            entry_transition: None,
        }
    }

    fn vc(id: &str, dur_ms: u64, has_audio: bool) -> VisibleClipInput {
        let clip = make_video_clip(id, dur_ms);
        VisibleClipInput {
            source_path: PathBuf::from(format!("/srcs/{}.mov", id)),
            clip,
            source_dims: PixelDims { w: 1920, h: 1080 },
            has_audio,
        }
    }

    #[test]
    fn video_only_single_clip_no_corner_full_bleed() {
        let slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true)];
        let plan = build_video_only_filtergraph(
            &inputs,
            slot,
            output,
            None,
            30,
            &prores_choice(),
            &["-c:a", "pcm_s16le"],
            out_path(),
        )
        .unwrap();
        assert_eq!(plan.frame_bytes_per_input, 0, "Channel C has no rawvideo input");
        assert_eq!(
            plan.argv.iter().filter(|a| *a == "-i").count(),
            1,
            "expected 1 input (no mask)",
        );
        assert!(!plan.argv.iter().any(|a| a == "-loop"));
        let fc = plan
            .argv
            .iter()
            .position(|a| a == "-filter_complex")
            .map(|i| &plan.argv[i + 1])
            .expect("filter_complex argument");
        assert!(fc.contains("[v0]"), "fc: {}", fc);
        assert!(fc.contains("concat=n=1:v=1:a=0[vc]"), "fc: {}", fc);
        assert!(!fc.contains("alphamerge"), "single-clip no-mask should not alphamerge");
        assert!(fc.contains("pad=1080:1920:0:0:color=#00000000[vout]"), "fc: {}", fc);
        // Audio side
        assert!(fc.contains("[a0]"), "fc: {}", fc);
        assert!(fc.contains("concat=n=1:v=0:a=1[aout]"), "fc: {}", fc);
        // -map [vout] [aout], -c:a pcm_s16le.
        let joined = argv_to_string(&plan.argv);
        assert!(joined.contains("-map [vout]"), "joined: {}", joined);
        assert!(joined.contains("-map [aout]"), "joined: {}", joined);
        assert!(joined.contains("-c:a pcm_s16le"), "joined: {}", joined);
        assert!(joined.contains("-c:v prores_ks"), "joined: {}", joined);
        assert!(joined.contains("-movflags +faststart"));
    }

    #[test]
    fn video_only_two_clips_no_corner() {
        let slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true), vc("b", 1500, true)];
        let plan = build_video_only_filtergraph(
            &inputs,
            slot,
            output,
            None,
            30,
            &prores_choice(),
            &["-c:a", "pcm_s16le"],
            out_path(),
        )
        .unwrap();
        assert_eq!(plan.argv.iter().filter(|a| *a == "-i").count(), 2);
        let fc = plan
            .argv
            .iter()
            .position(|a| a == "-filter_complex")
            .map(|i| &plan.argv[i + 1])
            .unwrap();
        assert!(fc.contains("[v0]"));
        assert!(fc.contains("[v1]"));
        assert!(fc.contains("[v0][v1]concat=n=2:v=1:a=0[vc]"), "fc: {}", fc);
        assert!(fc.contains("[a0][a1]concat=n=2:v=0:a=1[aout]"), "fc: {}", fc);
        assert!(!fc.contains("alphamerge"));
        assert!(!fc.contains("aevalsrc"));
    }

    #[test]
    fn video_only_two_clips_with_corner_mask_uses_alphamerge() {
        let slot = PixelRect { x: 50, y: 100, w: 400, h: 300 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true), vc("b", 1500, true)];
        let mask_path = Path::new("/tmp/mask.png");
        let plan = build_video_only_filtergraph(
            &inputs,
            slot,
            output,
            Some(mask_path),
            30,
            &prores_choice(),
            &["-c:a", "pcm_s16le"],
            out_path(),
        )
        .unwrap();
        // 2 clip inputs + 1 mask input.
        assert_eq!(plan.argv.iter().filter(|a| *a == "-i").count(), 3);
        // -loop 1 immediately precedes mask path.
        let mask_idx = plan
            .argv
            .iter()
            .position(|a| a == "/tmp/mask.png")
            .expect("mask path in argv");
        assert_eq!(plan.argv[mask_idx - 1], "-i");
        assert_eq!(plan.argv[mask_idx - 2], "1");
        assert_eq!(plan.argv[mask_idx - 3], "-loop");
        // Mask is the last input — its index in filter_complex is 2 (= visible_clips.len()).
        let fc = plan
            .argv
            .iter()
            .position(|a| a == "-filter_complex")
            .map(|i| &plan.argv[i + 1])
            .unwrap();
        assert!(fc.contains("[2:v]format=gray[mask]"), "fc: {}", fc);
        assert!(
            fc.contains("[vc][mask]alphamerge=shortest=1[vmasked]"),
            "fc: {}",
            fc,
        );
        assert!(
            fc.contains("[vmasked]pad=1080:1920:50:100:color=#00000000[vout]"),
            "fc: {}",
            fc,
        );
    }

    #[test]
    fn video_only_clip_without_audio_uses_aevalsrc() {
        let slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        // 2-second clip at speed 1.0 → silence span = 2.0s.
        let inputs = vec![vc("a", 2000, false)];
        let plan = build_video_only_filtergraph(
            &inputs,
            slot,
            output,
            None,
            30,
            &prores_choice(),
            &["-c:a", "pcm_s16le"],
            out_path(),
        )
        .unwrap();
        let fc = plan
            .argv
            .iter()
            .position(|a| a == "-filter_complex")
            .map(|i| &plan.argv[i + 1])
            .unwrap();
        assert!(
            fc.contains("aevalsrc=0:duration=2.000000:sample_rate=48000[a0]"),
            "fc: {}",
            fc,
        );
        // No `[0:a]atrim` — that's the source-stream branch.
        assert!(!fc.contains("[0:a]atrim"), "fc: {}", fc);
    }

    #[test]
    fn video_only_frame_bytes_per_input_is_zero() {
        let slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        for n in 1..=3 {
            let inputs: Vec<VisibleClipInput> = (0..n)
                .map(|i| vc(&format!("c{}", i), 1500, true))
                .collect();
            let plan = build_video_only_filtergraph(
                &inputs,
                slot,
                output,
                None,
                30,
                &prores_choice(),
                &["-c:a", "pcm_s16le"],
                out_path(),
            )
            .unwrap();
            assert_eq!(plan.frame_bytes_per_input, 0, "n={}", n);
        }
    }

    #[test]
    fn video_only_argv_starts_with_hide_banner_and_y() {
        let slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true)];
        let plan = build_video_only_filtergraph(
            &inputs,
            slot,
            output,
            None,
            30,
            &prores_choice(),
            &["-c:a", "pcm_s16le"],
            out_path(),
        )
        .unwrap();
        assert_eq!(plan.argv[0], "-hide_banner");
        assert_eq!(plan.argv[1], "-y");
        // Output path tail.
        assert_eq!(plan.argv.last().unwrap(), "/tmp/out.mov");
    }

    // -----------------------------------------------------------------
    // Channel A (composite) — build_composite_filtergraph tests
    // -----------------------------------------------------------------

    /// HEVC `EncoderChoice` analog of `prores_choice`. Per encoder.rs,
    /// HEVC's `codec_args` does NOT include the `-c:v` prefix — the
    /// composite builder prepends `-c:v {name}` when splicing.
    fn hevc_choice() -> EncoderChoice {
        EncoderChoice {
            class: EncoderClass::Hevc,
            name: "libx265".to_string(),
            kind: EncoderKind::Software,
            codec_args: vec![
                "-crf".into(),
                "17".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                "-tag:v".into(),
                "hvc1".into(),
            ],
            probe_wall_clock_ms: 0,
        }
    }

    fn aac_args() -> &'static [&'static str] {
        &["-c:a", "aac", "-b:a", "256k"]
    }

    fn fc_of(plan: &FiltergraphPlan) -> &str {
        plan.argv
            .iter()
            .position(|a| a == "-filter_complex")
            .map(|i| plan.argv[i + 1].as_str())
            .expect("filter_complex argument")
    }

    /// Position of the first `-i {needle}` pair in argv (the `-i`'s index).
    fn input_pos_for(argv: &[String], needle: &str) -> usize {
        for (i, a) in argv.iter().enumerate() {
            if a == "-i" && argv.get(i + 1).map(|v| v.as_str()) == Some(needle) {
                return i;
            }
        }
        panic!("input `-i {needle}` not found in argv: {:?}", argv);
    }

    #[test]
    fn composite_pip_map_inset_no_corner_mask() {
        // 9:16 PiP with map-as-inset at bottom-right; no corner mask.
        let map_slot = PixelRect { x: 702, y: 1497, w: 346, h: 346 };
        let video_slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true), vc("b", 1500, true)];
        let plan = build_composite_filtergraph(
            &inputs,
            map_slot,
            video_slot,
            output,
            CompositeMode::PipMapInset,
            None,
            30,
            105,
            &hevc_choice(),
            aac_args(),
            out_path(),
        )
        .unwrap();

        // Clip inputs come before the rawvideo input.
        let clip_a_pos = input_pos_for(&plan.argv, "/srcs/a.mov");
        let clip_b_pos = input_pos_for(&plan.argv, "/srcs/b.mov");
        let pipe_pos = input_pos_for(&plan.argv, "pipe:0");
        assert!(clip_a_pos < pipe_pos, "clip a before pipe");
        assert!(clip_b_pos < pipe_pos, "clip b before pipe");

        // Rawvideo geometry on the input definition.
        let joined = argv_to_string(&plan.argv);
        assert!(joined.contains("-f rawvideo"), "joined: {}", joined);
        assert!(joined.contains("-pix_fmt rgba"), "joined: {}", joined);
        // Rawvideo geometry matches the map slot dims.
        assert!(joined.contains("-s 346x346"), "joined: {}", joined);
        assert!(joined.contains("-r 30"), "joined: {}", joined);
        assert!(joined.contains("-i pipe:0"), "joined: {}", joined);

        // No looped mask.
        assert!(!plan.argv.iter().any(|a| a == "-loop"));

        // filter_complex assertions.
        let fc = fc_of(&plan);
        assert!(fc.contains("concat=n=2:v=1:a=0[vc]"), "fc: {}", fc);
        assert!(
            fc.contains("[2:v]format=yuva444p10le[map]"),
            "fc: {}",
            fc,
        );
        assert!(
            fc.contains("[vc][map]overlay=702:1497:format=auto[vout_alpha]"),
            "fc: {}",
            fc,
        );
        assert!(
            fc.contains("[vout_alpha]format=yuv420p[vout]"),
            "fc: {}",
            fc,
        );
        assert!(!fc.contains("alphamerge"), "no-mask path must not alphamerge: {}", fc);
        assert!(!fc.contains("pad="), "composite must use overlay, not pad: {}", fc);

        // Audio chain.
        assert!(fc.contains("concat=n=2:v=0:a=1[aout]"), "fc: {}", fc);

        // -frames:v cap.
        assert!(joined.contains("-frames:v 105"), "joined: {}", joined);

        // Audio encoder splice.
        assert!(joined.contains("-c:a aac -b:a 256k"), "joined: {}", joined);
        assert!(!plan.argv.iter().any(|a| a == "-an"), "composite must not silence audio");

        // Exactly one `-c:v` pair (HEVC prepended; codec_args does not double-prefix).
        let cv_count = plan
            .argv
            .windows(2)
            .filter(|w| w[0] == "-c:v")
            .count();
        assert_eq!(cv_count, 1, "expected exactly one -c:v pair, argv: {:?}", plan.argv);

        // The single `-c:v` is followed by the encoder name.
        let cv_idx = plan.argv.iter().position(|a| a == "-c:v").unwrap();
        assert_eq!(plan.argv[cv_idx + 1], "libx265");

        // -movflags +faststart.
        assert!(joined.contains("-movflags +faststart"), "joined: {}", joined);

        // frame_bytes_per_input matches map_slot area × 4 (RGBA).
        assert_eq!(
            plan.frame_bytes_per_input,
            (map_slot.w as usize) * (map_slot.h as usize) * 4,
        );

        // Output path at the tail.
        assert_eq!(plan.argv.last().unwrap(), "/tmp/out.mov");
    }

    #[test]
    fn composite_pip_map_inset_with_corner_radius() {
        let map_slot = PixelRect { x: 702, y: 1497, w: 346, h: 346 };
        let video_slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true), vc("b", 1500, true)];
        let mask_path = Path::new("/tmp/mask.png");
        let plan = build_composite_filtergraph(
            &inputs,
            map_slot,
            video_slot,
            output,
            CompositeMode::PipMapInset,
            Some(mask_path),
            30,
            105,
            &hevc_choice(),
            aac_args(),
            out_path(),
        )
        .unwrap();

        // -loop 1 immediately precedes the mask path.
        let mask_idx = plan
            .argv
            .iter()
            .position(|a| a == "/tmp/mask.png")
            .expect("mask path in argv");
        assert_eq!(plan.argv[mask_idx - 1], "-i");
        assert_eq!(plan.argv[mask_idx - 2], "1");
        assert_eq!(plan.argv[mask_idx - 3], "-loop");

        // Input ordering: clips → rawvideo → mask.
        let pipe_pos = input_pos_for(&plan.argv, "pipe:0");
        let mask_input_pos = input_pos_for(&plan.argv, "/tmp/mask.png");
        assert!(pipe_pos < mask_input_pos, "rawvideo before mask");

        let fc = fc_of(&plan);
        // Mask is at index N+1 = 3 (2 clips + rawvideo).
        assert!(fc.contains("[3:v]format=gray[mask]"), "fc: {}", fc);
        assert!(fc.contains("[map][mask]alphamerge[map_masked]"), "fc: {}", fc);
        assert!(
            fc.contains("[vc][map_masked]overlay=702:1497:format=auto[vout_alpha]"),
            "fc: {}",
            fc,
        );
    }

    #[test]
    fn composite_pip_video_inset_with_corner_radius() {
        let map_slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let video_slot = PixelRect { x: 60, y: 80, w: 400, h: 720 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true), vc("b", 1500, true)];
        let mask_path = Path::new("/tmp/mask.png");
        let plan = build_composite_filtergraph(
            &inputs,
            map_slot,
            video_slot,
            output,
            CompositeMode::PipVideoInset,
            Some(mask_path),
            30,
            105,
            &hevc_choice(),
            aac_args(),
            out_path(),
        )
        .unwrap();

        let fc = fc_of(&plan);
        assert!(fc.contains("[3:v]format=gray[mask]"), "fc: {}", fc);
        // Video stream (concat output) is what gets masked here.
        assert!(fc.contains("[vc][mask]alphamerge[vc_masked]"), "fc: {}", fc);
        // Background is the map; inset is the masked video at video_slot.
        assert!(
            fc.contains("[map][vc_masked]overlay=60:80:format=auto[vout_alpha]"),
            "fc: {}",
            fc,
        );
    }

    #[test]
    fn composite_split_no_mask() {
        // Split layout — left half map, right half video. No corner mask.
        let map_slot = PixelRect { x: 0, y: 0, w: 540, h: 1920 };
        let video_slot = PixelRect { x: 540, y: 0, w: 540, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true), vc("b", 1500, true)];
        let plan = build_composite_filtergraph(
            &inputs,
            map_slot,
            video_slot,
            output,
            CompositeMode::Split,
            None,
            30,
            105,
            &hevc_choice(),
            aac_args(),
            out_path(),
        )
        .unwrap();

        // N+1 inputs = 2 clips + rawvideo. No mask, no -loop.
        assert_eq!(plan.argv.iter().filter(|a| *a == "-i").count(), 3);
        assert!(!plan.argv.iter().any(|a| a == "-loop"));

        let fc = fc_of(&plan);
        assert!(
            fc.contains("color=c=black:s=1080x1920:r=30"),
            "fc: {}",
            fc,
        );
        // Two overlays: map at map_slot, then video at video_slot.
        assert!(fc.contains("[bg][map]overlay=0:0[bg_with_map]"), "fc: {}", fc);
        assert!(
            fc.contains("[bg_with_map][vc]overlay=540:0:format=auto[vout_alpha]"),
            "fc: {}",
            fc,
        );
        let overlay_count = fc.matches("overlay=").count();
        assert_eq!(overlay_count, 2, "split should have 2 overlay calls, got {}: {}", overlay_count, fc);
        assert!(!fc.contains("alphamerge"), "split has no corner radius: {}", fc);
    }

    #[test]
    fn composite_audio_chain_present_for_each_clip() {
        // For every fixture's filter_complex, assert per-clip audio
        // sub-graph and audio concat are emitted (mirrors 070's chain).
        let map_slot = PixelRect { x: 702, y: 1497, w: 346, h: 346 };
        let video_slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true), vc("b", 1500, true)];

        for mode in [
            CompositeMode::PipMapInset,
            CompositeMode::PipVideoInset,
            CompositeMode::Split,
        ] {
            let plan = build_composite_filtergraph(
                &inputs,
                map_slot,
                video_slot,
                output,
                mode,
                None,
                30,
                105,
                &hevc_choice(),
                aac_args(),
                out_path(),
            )
            .unwrap();
            let fc = fc_of(&plan);
            // Each clip's audio sub-graph terminates in `[a{idx}]`.
            assert!(fc.contains("[0:a]atrim="), "mode {:?} fc: {}", mode, fc);
            assert!(fc.contains("[1:a]atrim="), "mode {:?} fc: {}", mode, fc);
            assert!(fc.contains("[a0]"), "mode {:?} fc: {}", mode, fc);
            assert!(fc.contains("[a1]"), "mode {:?} fc: {}", mode, fc);
            assert!(
                fc.contains("[a0][a1]concat=n=2:v=0:a=1[aout]"),
                "mode {:?} fc: {}",
                mode,
                fc,
            );
        }
    }

    #[test]
    fn composite_frame_bytes_matches_map_slot_area_x4() {
        let video_slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true)];
        for (w, h) in &[(346u32, 346u32), (540, 960), (1080, 1920), (1, 1)] {
            let map_slot = PixelRect { x: 0, y: 0, w: *w, h: *h };
            let plan = build_composite_filtergraph(
                &inputs,
                map_slot,
                video_slot,
                output,
                CompositeMode::PipMapInset,
                None,
                30,
                60,
                &hevc_choice(),
                aac_args(),
                out_path(),
            )
            .unwrap();
            assert_eq!(
                plan.frame_bytes_per_input,
                (*w as usize) * (*h as usize) * 4,
                "(w, h) = ({}, {})",
                w,
                h,
            );
        }
    }

    #[test]
    fn composite_argv_starts_with_hide_banner_and_y() {
        let map_slot = PixelRect { x: 0, y: 0, w: 100, h: 100 };
        let video_slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true)];
        let plan = build_composite_filtergraph(
            &inputs,
            map_slot,
            video_slot,
            output,
            CompositeMode::PipMapInset,
            None,
            30,
            10,
            &hevc_choice(),
            aac_args(),
            out_path(),
        )
        .unwrap();
        assert_eq!(plan.argv[0], "-hide_banner");
        assert_eq!(plan.argv[1], "-y");
    }

    #[test]
    fn composite_input_ordering_clips_before_rawvideo_before_mask() {
        let map_slot = PixelRect { x: 100, y: 200, w: 346, h: 346 };
        let video_slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true), vc("b", 1500, true)];

        // Each (mode, mask) fixture asserts the same ordering rule.
        let fixtures: [(CompositeMode, Option<&Path>); 5] = [
            (CompositeMode::PipMapInset, None),
            (CompositeMode::PipMapInset, Some(Path::new("/tmp/mask.png"))),
            (CompositeMode::PipVideoInset, None),
            (CompositeMode::PipVideoInset, Some(Path::new("/tmp/mask.png"))),
            (CompositeMode::Split, None),
        ];
        for (mode, mask) in fixtures {
            let plan = build_composite_filtergraph(
                &inputs,
                map_slot,
                video_slot,
                output,
                mode,
                mask,
                30,
                60,
                &hevc_choice(),
                aac_args(),
                out_path(),
            )
            .unwrap();
            let pipe_pos = input_pos_for(&plan.argv, "pipe:0");
            // All clip inputs precede the rawvideo input.
            for path in ["/srcs/a.mov", "/srcs/b.mov"] {
                let p = input_pos_for(&plan.argv, path);
                assert!(p < pipe_pos, "{:?} mask={:?}: clip {} pos {} >= pipe {}", mode, mask, path, p, pipe_pos);
            }
            // Mask, when present, comes after rawvideo.
            if let Some(m) = mask {
                let mask_pos = input_pos_for(&plan.argv, m.to_str().unwrap());
                assert!(pipe_pos < mask_pos, "{:?}: pipe {} >= mask {}", mode, pipe_pos, mask_pos);
            }
        }
    }

    #[test]
    fn composite_clip_input_uses_video_slot_dims() {
        // Per-clip subgraphs scale to video_slot dims, NOT map_slot dims.
        // This proves the builder hands `video_slot` to ClipChainInputs,
        // not the map slot — load-bearing for LAYOUT.md §7's "A's video
        // pipeline equals C's" invariant.
        let map_slot = PixelRect { x: 200, y: 300, w: 320, h: 568 };
        let video_slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true)];
        let plan = build_composite_filtergraph(
            &inputs,
            map_slot,
            video_slot,
            output,
            CompositeMode::PipMapInset,
            None,
            30,
            60,
            &hevc_choice(),
            aac_args(),
            out_path(),
        )
        .unwrap();
        let fc = fc_of(&plan);
        // The per-clip chain pattern is `crop=...,scale=W:H,format=yuva...`
        // (scale BEFORE format). Assert the video_slot dims appear in that
        // pattern, and the map_slot dims do NOT — `scale=320:568,format=yuva`
        // would be the bug.
        assert!(
            fc.contains("scale=1080:1920,format=yuva"),
            "expected per-clip scale to video_slot dims; fc: {}",
            fc,
        );
        assert!(
            !fc.contains("scale=320:568,format=yuva"),
            "per-clip scale should use video_slot, not map_slot; fc: {}",
            fc,
        );
    }
}
