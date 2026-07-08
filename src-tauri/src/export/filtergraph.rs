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
use crate::export::delivery::{delivery_encoder_args, delivery_finishing_filter, DeliveryTarget};
use crate::export::encoder::EncoderChoice;
use crate::export::error::ClipChainError;
use crate::export::layout::{OutputDimensions, PixelRect};
use crate::models::Clip;
use crate::export::delivery::push_color_flags_from_cs;
use crate::util::color::{map_ingest_filter, map_ingest_filter_for_delivery, WORKING_SPACE_PIX_FMT};
use crate::util::color_space::{
    composite_transport_decode, composite_transport_encode, delivery_zscale_chain, ColorSpace,
};

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
///     * brings the raw RGBA8 map canvas into WS3 working space (linear
///       light, BT.2020 primaries, gbrpf32le) via `map_ingest_filter()`,
///     * promotes back to `yuva444p10le` (must run *before* `pad` — the
///       alpha channel must exist before `pad` adds the transparent
///       canvas, otherwise the canvas paints opaque black; gbrpf32le has
///       no alpha so the round-trip is required for B's masked positional
///       output contract),
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

    // Input 0: rawvideo on stdin sized to the slot. The worker renders the map
    // supersampled and downsamples it back to slot dims on-GPU before sending,
    // so the frames arriving here are already slot-sized.
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
    argv.push(build_filter_complex(
        slot,
        output,
        corner_mask_png_path.is_some(),
    ));

    push(&mut argv, ["-map", "[v]", "-an"]);

    // ProRes codec args (carries `-c:v prores_ks` + profile + pix_fmt + vendor).
    for a in &encoder.codec_args {
        argv.push(a.clone());
    }

    // WS4: ProRes Master delivery — BT.709 limited color tags. Channel B
    // is locked to `ProresMaster`; the bt709 tag set matches what the
    // ProRes 4444 alpha-bearing intermediate carries on disk.
    push_prores_color_flags(&mut argv);

    push(&mut argv, ["-movflags", "+faststart"]);

    argv.push(output_path.to_string_lossy().into_owned());

    FiltergraphPlan {
        argv,
        frame_bytes_per_input: (slot.w as usize) * (slot.h as usize) * 4,
    }
}

/// Inject the BT.709 limited-range color tags expected by Channels B and C
/// (and the ProRes Master delivery target on Channel A). Mirrors the tags
/// produced by `delivery_encoder_args(ProresMaster, …)`'s color flag block.
/// Kept as a separate splice (rather than reusing `delivery_encoder_args`)
/// because B/C also need `-c:v prores_ks` + profile etc. emitted before the
/// color flags — and those come from the encoder's `codec_args` (which
/// already has them) — whereas `delivery_encoder_args` builds the full argv.
fn push_prores_color_flags(argv: &mut Vec<String>) {
    // ProRes intermediates (Channels B/C) are tagged BT.709 limited — the same
    // color flags any SDR delivery emits, generated from the registry so the
    // tag set lives in exactly one place (`push_color_flags_from_cs`).
    push_color_flags_from_cs(argv, &ColorSpace::SDR_BT709);
}

fn build_filter_complex(
    slot: PixelRect,
    output: OutputDimensions,
    with_mask: bool,
) -> String {
    let pad = format!(
        "pad={out_w}:{out_h}:{x}:{y}:color=#00000000",
        out_w = output.w,
        out_h = output.h,
        x = slot.x,
        y = slot.y,
    );
    let map_ingest = map_ingest_filter();
    // WS4 delivery transform for the map-only ProRes 4444 intermediate.
    // `map_ingest` lands the canvas in working space (linear-light BT.2020
    // primaries); this converts it to the BT.709 limited regime the encoder
    // tags it with (`push_prores_color_flags` → SDR_BT709). Without it the
    // pixels stay BT.2020-primaries but get tagged BT.709 — a gamut mismatch
    // any player/NLE reads as desaturated/muted decorations. Mirrors the
    // working→delivery hand-off the composite path does via
    // `delivery_finishing_filter`. (SSAA supersampling is downsampled on-GPU
    // in the renderer, so the map already arrives at slot dims here.)
    let deliver = delivery_zscale_chain(&ColorSpace::WORKING, &ColorSpace::SDR_BT709);
    if with_mask {
        // WS3: bring the raw RGBA8 map canvas into working space (linear
        // light, BT.2020 primaries, gbrpf32le) FIRST, apply the delivery
        // transform, then convert back to yuva444p10le so the downstream
        // `alphamerge` + `pad` chain composes alpha correctly (gbrpf32le has
        // no alpha channel; Channel B's masked positional output contract
        // requires alpha all the way through to the ProRes 4444 encoder).
        format!(
            "[0:v]{map_ingest},{deliver},format=yuva444p10le[map];\
             [1:v]format=gray[mask];\
             [map][mask]alphamerge[masked];\
             [masked]{pad}[v]"
        )
    } else {
        // No mask: working-space ingest, delivery transform, back to
        // yuva444p10le for the pad (alpha-bearing format required so
        // `color=#00000000` actually paints transparent — see module docstring).
        format!("[0:v]{map_ingest},{deliver},format=yuva444p10le,{pad}[v]")
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
///   F_ingest_{class} → format=gbrpf32le[vN]` — WS3 working-space ingest,
/// - per-clip audio sub-graph: `atrim → asetpts → atempo*[aN]`, or, if
///   the source has no audio stream, `aevalsrc=0:duration=...[aN]` so the
///   audio-side `concat` filter's `n` count matches the video side,
/// - a video `concat=n=N:v=1:a=0,fps={fps}[vc]` (fps normalization keeps
///   the export rate decoupled from the clips' native rates) and a parallel
///   audio `concat=n=N:v=0:a=1[aout]`,
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

    // WS4: ProRes Master delivery — BT.709 limited color tags. Channel C
    // is locked to `ProresMaster`; same color flag block as Channel B.
    push_prores_color_flags(&mut argv);

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

    // Per-clip video subgraphs. Channel C is always ProRes Master (SDR
    // BT.709) — the SDR delivery space means no SDR-origin anchor, so these
    // chains are byte-identical to pre-Phase-4.
    for (idx, vc) in visible_clips.iter().enumerate() {
        let inputs = ClipChainInputs {
            input_index: idx as u32,
            clip: &vc.clip,
            source_dims: vc.source_dims,
            video_slot: slot,
            fps,
            delivery: ColorSpace::SDR_BT709,
        };
        parts.push(build_clip_video_subgraph(&inputs)?);
    }

    // Video-side concat, then normalize to export fps. Per-clip subgraphs
    // preserve native source rates; without `fps={fps}` an export of N
    // seconds of 30-fps source content at `req.fps == 24` produces 30·N
    // output frames (longer-than-expected duration). Mirrors Channel A's
    // normalization for the same reason.
    //
    // WS3: `[vc]` is in working space (gbrpf32le) because every `[v{i}]`
    // input is, per `clip_chain::build_clip_video_subgraph`. The concat
    // and fps filters operate in working space — mixed-source timelines
    // (SDR + HLG) are uniformly normalized at this point.
    let video_inputs: String = (0..n).map(|i| format!("[v{}]", i)).collect::<Vec<_>>().join("");
    parts.push(format!("{video_inputs}concat=n={n}:v=1:a=0,fps={fps}[vc]"));

    // Convert from working space back to yuva444p10le for the alpha-bearing
    // mask + pad chain. gbrpf32le has no alpha channel; Channel C's masked
    // positional output contract (LAYOUT.md §6) requires alpha all the way
    // through to the ProRes 4444 encoder. WS4 will replace this with a
    // proper delivery transform.
    parts.push("[vc]format=yuva444p10le[vc_a]".to_string());

    // Optional alphamerge with the corner mask. Mask input index == n.
    // `shortest=1` ends the alphamerge filter when [vc_a] (the
    // finite-duration concat output) ends — without it, FFmpeg keeps
    // reading frames from the `-loop 1` mask input indefinitely and the
    // encoder hangs. The looped mask is necessary because `-loop 1` is the
    // idiomatic way to hold a single-frame PNG for the duration of a
    // paired finite stream; `shortest=1` is the dual half of that pattern.
    let pre_pad_label = if with_mask {
        parts.push(format!("[{n}:v]format=gray[mask]"));
        parts.push("[vc_a][mask]alphamerge=shortest=1[vmasked]".to_string());
        "[vmasked]"
    } else {
        "[vc_a]"
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
                delivery: ColorSpace::SDR_BT709,
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
///   scale → F_ingest_{class} → format=gbrpf32le[v{i}]` — WS3 per-clip
///   working-space ingest),
/// - per-clip audio sub-graph from `clip_chain` (`atrim → asetpts →
///   atempo*[a{i}]`), or `aevalsrc=0` silence for clips without audio,
/// - a video `concat=n=N:v=1:a=0,fps={fps}[vc]` (fps normalization is
///   load-bearing: `overlay`'s output rate equals its first input's rate,
///   so a clip-native `[vc]` would push the composite output off the
///   `-frames:v` cap's rhythm and slam the rawvideo stdin shut early —
///   see Channel A regression test `composite_fps_normalizes_concat_to_export_rate`)
///   and an audio `concat=…[aout]`,
/// - mode-specific compositing (no-mask overlays operate in working
///   space — `[vc]` and `[map]` are both `gbrpf32le`; masked PIP
///   branches round-trip through `yuva444p10le` so `overlay` sees one
///   pixel-format family — `overlay` has no float pixel-format support):
///     * `PipMapInset`: `[vc][map]overlay=map_slot.x:map_slot.y` — when
///       masked, BOTH sides are lifted to yuva444p10le first
///       (`[map]format=yuva444p10le,[mask]alphamerge` for the inset AND
///       `[vc]format=yuva444p10le` for the background), then the post-
///       overlay result is converted back to `gbrpf32le` so `[vout_w]`
///       still matches the working-space contract `delivery_finishing_filter`
///       consumes.
///     * `PipVideoInset`: symmetric to PipMapInset —
///       `[map][vc]overlay=video_slot.x:video_slot.y`, both sides
///       round-tripped through yuva444p10le when masked.
///     * `Split`: synthesize a black canvas at output size in working
///       space (`color=… format=gbrpf32le`), overlay the map at its slot,
///       then the video at its slot. No mask path — Split structurally
///       has no corner radius.
/// - final delivery finishing chain emitted by
///   `delivery::delivery_finishing_filter(target, output)` — working space
///   → target color regime (BT.709 limited yuv420p for SDR, HLG BT.2020
///   limited yuv420p10le for HDR, BT.709 limited yuva444p10le for ProRes
///   Master) plus the target-specific scale+pad to the social/HDR fixed
///   canvas dims.
/// - `-map [vout] -map [aout]`, encoder argv emitted by
///   `delivery::delivery_encoder_args(target, encoder)` — per-target codec
///   (libx264 for social, hevc_videotoolbox or libx265 for YouTube,
///   prores_ks for master), `-pix_fmt`, the global `-color_*` flags PLUS
///   (for software encoders) the encoder-params VUI duplicate
///   (`-x264-params colorprim=...` / `-x265-params colorprim=...`), AAC
///   audio (or PCM for ProRes), and `+faststart`.
///
/// `frame_bytes_per_input == map_slot.w * map_slot.h * 4` — the orchestrator
/// writes RGBA frames at the map slot dims. (The renderer supersamples then
/// downsamples to slot dims on-GPU, so the wire stays slot-sized.)
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
    audio_bitrate_kbps: u32,
    delivery_target: DeliveryTarget,
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

    // Input `N`: rawvideo on stdin (map render stream from the worker) sized
    // to map_slot. The worker renders the map supersampled and downsamples it
    // back to map_slot dims on-GPU before sending, so the frames arriving here
    // are already slot-sized.
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
        delivery_target,
    )?;
    argv.push("-filter_complex".to_string());
    argv.push(fc);

    push(&mut argv, ["-map", "[vout]", "-map", "[aout]"]);

    // WS4: encoder argv comes from `delivery_encoder_args` — per-target
    // codec + color flags + (for software encoders) the encoder-params
    // VUI duplicate. The `video_encoder` arg drives the hardware-vs-
    // software branch inside that helper (hevc_videotoolbox vs libx265 for
    // YouTube targets; libx264 for social targets; prores_ks for the
    // master). Audio is included in `delivery_encoder_args` for codec
    // targets that need AAC; ProResMaster gets `-c:a pcm_s16le`.
    //
    // The `audio_bitrate_kbps` knob (export-controls plan, Phase 3) is
    // currently fixed at 192k inside `delivery_encoder_args` per the WS4
    // brief — WS5 can re-introduce the user-controlled bitrate if needed.
    let _ = audio_bitrate_kbps; // accepted for API stability; see note above
    for a in delivery_encoder_args(delivery_target, video_encoder) {
        argv.push(a);
    }

    argv.push(output_path.to_string_lossy().into_owned());

    Ok(FiltergraphPlan {
        argv,
        // RGBA frames at the map slot dims (the rawvideo input geometry). The
        // renderer downsamples its supersampled buffer to slot dims on-GPU.
        frame_bytes_per_input: (map_slot.w as usize) * (map_slot.h as usize) * 4,
    })
}

/// Audio encoder flags for Channel A composites: `-c:a aac -b:a {kbps}k`.
/// Replaces the old test-only `aac_args()` const. Production callers thread
/// `audio_bitrate_kbps` from `RenderExportRequest`; the composite branch is
/// the only consumer (Channel C uses pcm_s16le, Channel B has no audio).
///
/// WS4: superseded by `delivery::delivery_encoder_args`, which embeds AAC
/// at 192 kbps per the WS4 brief's per-target argv table. Retained for
/// regression-coverage tests until WS5 lands a UI-driven bitrate.
#[allow(dead_code)]
fn aac_args(kbps: u32) -> Vec<String> {
    vec![
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        format!("{}k", kbps),
    ]
}

fn build_composite_filter_complex(
    visible_clips: &[VisibleClipInput],
    map_slot: PixelRect,
    video_slot: PixelRect,
    output: OutputDimensions,
    composite_mode: CompositeMode,
    fps: u32,
    with_mask: bool,
    delivery_target: DeliveryTarget,
) -> Result<String, ClipChainError> {
    let n = visible_clips.len();
    let mut parts: Vec<String> = Vec::with_capacity(n * 2 + 8);

    // Phase 4 (HDR port): the delivery target's output color space drives
    // (a) the SDR-origin BT.2408 reference-white anchor at every ingest
    // (fix B — clips below, map further down) and (b) the composite transport
    // curve (fix C′). For SDR delivery both collapse to no-ops and every chain
    // is byte-identical to pre-Phase-4.
    let delivery_cs = delivery_target.output_color_space();
    let hdr_delivery = delivery_cs.transfer.is_hdr();
    // Composite transport curve (fix C′ — supersedes the fix-C linear ÷32/×32
    // headroom; CANON §1.12). The 10-bit `yuva444p10le` lift around `overlay`
    // quantizes the working space onto a 10-bit INTEGER grid clamped to [0,1] —
    // HDR video (linear up to ~24.6 at npl=100) and the anchored 2.03 map white
    // both exceed 1.0 and would clip. Fix C used to scale DOWN by H=32 before
    // the lift and UP after, but that ÷32 ran in LINEAR light, crushing the
    // anchored SDR-origin map (linear 0–2.03) into the bottom ~6.3% of the grid:
    // a 256-step ramp collapsed to 66 distinct levels and flat decoration colors
    // shifted hue up to 12.5° — the HDR-only grit / wrong-hue / shimmer Matthew
    // saw (PQ worst; its EOTF stretches the bottom of the range hardest).
    //
    // Fix C′ wraps the SAME lift in a PQ TRANSPORT curve instead: `down` encodes
    // linear→PQ before the lift (PQ allocates 10-bit codes perceptually, so the
    // bottom of the range keeps its precision), `up` decodes PQ→linear (npl=100,
    // the absolute working convention) after. Measured 256/256 levels, ≤0.33°
    // hue vs pure float. The splice POINTS are unchanged from fix C: `down`
    // immediately before every COLOR-stream lift (map/vc/bg — never the gray
    // mask), `up` immediately after the post-overlay return to `gbrpf32le`.
    // HDR delivery only: SDR never exceeds 1.0, and a PQ round-trip there would
    // needlessly requantize the gradient (same regression H=32 caused on SDR).
    let down = if hdr_delivery {
        format!("{},", composite_transport_encode())
    } else {
        String::new()
    };
    let up = if hdr_delivery {
        format!(",{}", composite_transport_decode())
    } else {
        String::new()
    };

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
            delivery: delivery_cs,
        };
        parts.push(build_clip_video_subgraph(&inputs)?);
    }

    // Video-side concat, then normalize to export fps. The trailing
    // `fps={fps}` is load-bearing: per-clip subgraphs preserve each source's
    // native frame rate (typically 30 for iPhone), and `overlay`'s output
    // rate equals its first input's rate. For PipMapInset (`[vc][map]overlay`)
    // a mismatch between `[vc]`'s clip-native rate and the rawvideo input's
    // `-r {fps}` causes overlay to duplicate rawvideo frames, the `-frames:v`
    // cap to fire off-rhythm at `cap / clip_fps` seconds instead of
    // `cap / export_fps`, FFmpeg to close stdin, and the orchestrator's next
    // sink write to fail with `Broken pipe`. Normalizing here keeps `[vc]`,
    // `[map]`, and the cap on the same clock.
    let video_inputs: String = (0..n).map(|i| format!("[v{}]", i)).collect::<Vec<_>>().join("");
    parts.push(format!("{video_inputs}concat=n={n}:v=1:a=0,fps={fps}[vc]"));

    // Map stream — rawvideo input at index N. WS3: bring it into the
    // working space (linear-light, BT.2020 primaries, gbrpf32le) via
    // `map_ingest_filter()`. THIS — together with the per-clip ingest in
    // `clip_chain::build_clip_video_subgraph` — is what kills the PIP
    // saturation bug: every input to every `overlay` below now lives in
    // the same color regime, so overlay's pixel blend is mixing identical
    // primaries/transfer/range rather than silently fusing a full-range
    // sRGB map with limited-range Y'CbCr video. See
    // `docs/color-pipeline/background/investigation-findings.md`
    // §"PIP saturation (Symptom 2)" for the root cause.
    //
    // The map arrives at map_slot dims (the renderer supersamples then
    // downsamples to slot dims on-GPU), so `[map]` is slot-sized — exactly
    // what the overlay positions below expect.
    //
    // Phase 4 (fix B): the map is always sRGB (SDR-origin), so the delivery-
    // aware form appends the ×2.03 BT.2408 reference-white anchor when the
    // delivery is HDR; for SDR delivery it is byte-identical to
    // `map_ingest_filter()`.
    let map_ingest = map_ingest_filter_for_delivery(&delivery_cs);
    parts.push(format!("[{n}:v]{map_ingest}[map]"));

    // Mode-specific composite chain. All overlays operate in working
    // space — `[vc]` and `[map]` are both `gbrpf32le` at this point.
    // `format=auto` is removed from `overlay` calls because both inputs
    // are pre-normalized; no per-overlay negotiation is needed.
    //
    // Each branch terminates with the per-target delivery finishing chain
    // emitted by `delivery_finishing_filter(target, output)` — the
    // working-space-to-delivery transform is WS4's deliverable. The chain
    // does the BT.709 (or HLG BT.2020 for HDR, or BT.709 yuva for ProRes)
    // color conversion AND the target-canvas scale+pad, so the encoder
    // argv downstream only handles codec + color flags + audio.
    match composite_mode {
        CompositeMode::PipMapInset => {
            // Video full-bleed background; map (optionally masked) overlaid
            // at the map slot's `(x, y)`. BOTH the masked AND unmasked
            // branches explicitly lift `[vc]` and `[map]` to `yuva444p10le`
            // before `overlay` because `overlay` cannot consume `gbrpf32le`
            // (its supported `format` enum is yuv420/422/444 (incl. 10-bit),
            // rgb, gbrp — no float variants). Without the explicit lift,
            // FFmpeg's framework auto-inserts a swscale that drops to
            // yuv420 (4:2:0) BEFORE the overlay, subsampling chroma early
            // — visible as soft labels / edges in the final export. The
            // explicit lift to yuva444p10le preserves 4:4:4 chroma through
            // the composite all the way to the delivery finishing chain,
            // which is where (and only where) the target's pixel format
            // (e.g. yuv420p for SDR HEVC) is applied.
            if with_mask {
                let mask_idx = n + 1;
                parts.push(format!("[{mask_idx}:v]format=gray[mask]"));
                // Convert just the map to yuva for alphamerge; the masked
                // result and the background `[vc]` are both round-tripped
                // through yuva444p10le BEFORE overlay so the two overlay
                // inputs share a pixel format family (10-bit 4:4:4 with
                // alpha).
                //
                // WS3 contract: the per-clip ingest landed `[vc]` in
                // `gbrpf32le` with BT.2020 linear color tags. `overlay`
                // does NOT accept `gbrpf32le` natively (see `ffmpeg -h
                // filter=overlay` — the supported `format` enum covers
                // yuv420/422/444 (incl. 10-bit), rgb, gbrp, but no float
                // variants). Before this fix, the masked branch fed
                // `gbrpf32le` `[vc]` and `yuva444p10le` `[map_masked]`
                // directly into one `overlay` call; FFmpeg's framework
                // resolved the cross-family mismatch by silently inserting
                // a swscale that picked default colorspace tags, which
                // is exactly the PIP-saturation root cause WS3 is meant to
                // eliminate. Converting `[vc]` to yuva444p10le explicitly
                // makes the format hand-off deterministic and keeps the
                // BT.2020 linear tags on the frame so the downstream
                // `delivery_finishing_filter` zscale sees the right input
                // regime.
                //
                // After overlay we step back to `gbrpf32le` so the
                // `[vout_w]` label still matches the working-space
                // contract that `delivery_finishing_filter` expects.
                // Alpha is dropped on the return trip because every
                // delivery target's finishing chain either ignores alpha
                // (yuv420p / yuv420p10le for codec targets) or recovers
                // it by promoting to yuva444p10le (ProResMaster) — the
                // alpha was load-bearing for the overlay's blend, not
                // for anything past `[vout_w]`.
                parts.push(format!("[map]{down}format=yuva444p10le[map_a]"));
                parts.push("[map_a][mask]alphamerge[map_masked]".to_string());
                parts.push(format!("[vc]{down}format=yuva444p10le[vc_a]"));
                // `:format=yuv444p10` pins the overlay's internal working
                // pixel format. Without it `overlay` defaults to `yuv420`
                // and auto-inserts a swscale that downconverts BOTH inputs
                // from yuva444p10le to yuva420p before compositing —
                // silently subsampling chroma to 4:2:0 even though the
                // lift made them 4:4:4. The overlay `format` enum value
                // is `yuv444p10` (no `a`, no `le`); overlay infers alpha
                // presence from inputs and emits yuva444p10le here.
                parts.push(format!(
                    "[vc_a][map_masked]overlay={x}:{y}:format=yuv444p10[vout_masked]",
                    x = map_slot.x,
                    y = map_slot.y,
                ));
                parts.push(format!(
                    "[vout_masked]format={pix}{up}[vout_w]",
                    pix = WORKING_SPACE_PIX_FMT,
                ));
            } else {
                parts.push(format!("[vc]{down}format=yuva444p10le[vc_nm]"));
                parts.push(format!("[map]{down}format=yuva444p10le[map_nm]"));
                parts.push(format!(
                    "[vc_nm][map_nm]overlay={x}:{y}:format=yuv444p10[vout_lifted]",
                    x = map_slot.x,
                    y = map_slot.y,
                ));
                parts.push(format!(
                    "[vout_lifted]format={pix}{up}[vout_w]",
                    pix = WORKING_SPACE_PIX_FMT,
                ));
            }
            parts.push(format!(
                "[vout_w]{finishing}[vout]",
                finishing = delivery_finishing_filter(delivery_target),
            ));
        }
        CompositeMode::PipVideoInset => {
            // Map full-bleed background; video (optionally masked) overlaid
            // at the video slot's `(x, y)`. Symmetric to PipMapInset.
            if with_mask {
                let mask_idx = n + 1;
                parts.push(format!("[{mask_idx}:v]format=gray[mask]"));
                // Symmetric to the PipMapInset masked branch: convert the
                // video to yuva for alphamerge AND round-trip the map side
                // through yuva444p10le so both overlay inputs share a
                // pixel-format family. See the PipMapInset comment above
                // for the full root-cause writeup — same fix in reverse
                // (`[map]` is the gbrpf32le side that needs lifting).
                parts.push(format!("[vc]{down}format=yuva444p10le[vc_a]"));
                parts.push("[vc_a][mask]alphamerge[vc_masked]".to_string());
                parts.push(format!("[map]{down}format=yuva444p10le[map_a]"));
                parts.push(format!(
                    "[map_a][vc_masked]overlay={x}:{y}:format=yuv444p10[vout_masked]",
                    x = video_slot.x,
                    y = video_slot.y,
                ));
                parts.push(format!(
                    "[vout_masked]format={pix}{up}[vout_w]",
                    pix = WORKING_SPACE_PIX_FMT,
                ));
            } else {
                parts.push(format!("[map]{down}format=yuva444p10le[map_nm]"));
                parts.push(format!("[vc]{down}format=yuva444p10le[vc_nm]"));
                parts.push(format!(
                    "[map_nm][vc_nm]overlay={x}:{y}:format=yuv444p10[vout_lifted]",
                    x = video_slot.x,
                    y = video_slot.y,
                ));
                parts.push(format!(
                    "[vout_lifted]format={pix}{up}[vout_w]",
                    pix = WORKING_SPACE_PIX_FMT,
                ));
            }
            parts.push(format!(
                "[vout_w]{finishing}[vout]",
                finishing = delivery_finishing_filter(delivery_target),
            ));
        }
        CompositeMode::Split => {
            // Split has no inset and (per resolve_slots) zero corner
            // radius. Synthesize an opaque black canvas at output size in
            // working space, overlay map at its slot, then video at its
            // slot. The two slots don't overlap — order is structurally
            // irrelevant (map first by convention).
            //
            // The synthetic black base was originally what kept Split
            // unaffected by the PIP saturation bug (it forced FFmpeg to
            // pick full-range as the effective base for the overlays).
            // With WS3 the working-space ingest already normalizes both
            // sides; the base canvas is retained for layout simplicity.
            //
            // `setparams` is load-bearing: `color=c=black` emits frames
            // with **unspecified** color tags. Overlay propagates the
            // first input's tags, so without `setparams` the entire
            // composite carries unspecified primaries / transfer /
            // matrix. The downstream `delivery_finishing_filter` zscale
            // then has no input colorspace to convert FROM and errors
            // with code 3074 ("no path between colorspaces"). For SDR
            // sources the ambiguity sometimes resolves by falling back
            // to bt709 defaults; for HDR sources whose working-space
            // tags are `linear` transfer + `bt2020` primaries the
            // mismatch is fatal. Tagging the synthetic canvas to match
            // the working space invariant (BT.2020 primaries, linear
            // transfer, BT.2020 NC matrix, full range — RGB is full by
            // construction) makes the finishing chain deterministic
            // regardless of source class.
            parts.push(format!(
                "color=c=black:s={out_w}x{out_h}:r={fps},format={pix},\
                 setparams=range=pc:color_primaries={p}:color_trc=linear:colorspace={m}[bg]",
                out_w = output.w,
                out_h = output.h,
                fps = fps,
                pix = WORKING_SPACE_PIX_FMT,
                p = crate::util::color::WORKING_SPACE_PRIMARIES,
                m = crate::util::color::WORKING_SPACE_MATRIX,
            ));
            // Lift `[bg]`, `[map]`, `[vc]` to `yuva444p10le` before the
            // overlays. `overlay` cannot consume `gbrpf32le`; without these
            // explicit conversions FFmpeg auto-inserts a swscale that drops
            // to yuv420 (4:2:0) BEFORE the first overlay, subsampling chroma
            // early and softening labels/edges. The `format=` filter changes
            // only the pixel layout — the `setparams` color tags survive
            // the conversion. Both overlays then operate in 4:4:4 10-bit
            // with alpha; we convert back to `WORKING_SPACE_PIX_FMT` so
            // `[vout_w]` honours the working-space contract that
            // `delivery_finishing_filter` consumes.
            // ÷H on `[bg]` is mathematically a no-op (black = linear 0) but
            // is applied uniformly so the single post-overlay ×H is exact.
            parts.push(format!("[bg]{down}format=yuva444p10le[bg_a]"));
            parts.push(format!("[map]{down}format=yuva444p10le[map_a]"));
            parts.push(format!("[vc]{down}format=yuva444p10le[vc_a]"));
            parts.push(format!(
                "[bg_a][map_a]overlay={x}:{y}:format=yuv444p10[bg_with_map]",
                x = map_slot.x,
                y = map_slot.y,
            ));
            parts.push(format!(
                "[bg_with_map][vc_a]overlay={x}:{y}:format=yuv444p10[vout_lifted]",
                x = video_slot.x,
                y = video_slot.y,
            ));
            parts.push(format!(
                "[vout_lifted]format={pix}{up}[vout_w]",
                pix = WORKING_SPACE_PIX_FMT,
            ));
            parts.push(format!(
                "[vout_w]{finishing}[vout]",
                finishing = delivery_finishing_filter(delivery_target),
            ));
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
                delivery: delivery_cs,
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

    /// Expected per-frame RGBA byte count for a map slot. The renderer
    /// supersamples but downsamples to slot dims on-GPU before sending, so the
    /// rawvideo frames the orchestrator feeds are slot-sized.
    fn expected_map_frame_bytes(w: u32, h: u32) -> usize {
        (w as usize) * (h as usize) * 4
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

        assert_eq!(plan.frame_bytes_per_input, expected_map_frame_bytes(1080, 1920));
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
        assert_eq!(plan.frame_bytes_per_input, expected_map_frame_bytes(346, 346));
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

        assert_eq!(plan.frame_bytes_per_input, expected_map_frame_bytes(346, 346));
    }

    #[test]
    fn frame_bytes_matches_supersampled_slot_area_x4() {
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
            assert_eq!(plan.frame_bytes_per_input, expected_map_frame_bytes(*w, *h));
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
            // WS0 — color fields default to "no signal" for test fixtures.
            // Downstream consumers treat `Unknown` as SDR Rec.709 so existing
            // filtergraph assertions stay valid.
            pix_fmt: None,
            color_primaries: None,
            color_trc: None,
            color_space: None,
            color_range: None,
            has_dolby_vision: false,
            camera_make: None,
            camera_model: None,
            source_color_class: crate::util::color::SourceColorClass::Unknown,
            user_color_class_override: None,
            // WS8 — test fixtures don't exercise log detection; the field
            // stays None so these helpers keep building plain SDR clips.
            suggested_log_class: None,
            color_space_override: None,
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
        assert!(fc.contains("concat=n=1:v=1:a=0,fps=30[vc]"), "fc: {}", fc);
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
        assert!(fc.contains("[v0][v1]concat=n=2:v=1:a=0,fps=30[vc]"), "fc: {}", fc);
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
        // WS3: `[vc]` is in working space (gbrpf32le, no alpha), so it
        // gets converted to yuva for alphamerge into `[vc_a]` first.
        assert!(fc.contains("[vc]format=yuva444p10le[vc_a]"), "fc: {}", fc);
        assert!(
            fc.contains("[vc_a][mask]alphamerge=shortest=1[vmasked]"),
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

    /// VideoToolbox HEVC `EncoderChoice` — the macOS hardware path. Per
    /// `encoder.rs::hevc_candidates`, this branch uses `-tag:v hvc1` +
    /// `-q:v 65` and does NOT carry an explicit `-pix_fmt` (the encoder
    /// picks one based on the input). Exists alongside `hevc_choice` so
    /// the composite filtergraph tests exercise both software and
    /// hardware encoder paths — WS6 acceptance criterion: "Both `libx265`
    /// and `hevc_videotoolbox` encoder paths covered by tests".
    fn hevc_videotoolbox_choice() -> EncoderChoice {
        EncoderChoice {
            class: EncoderClass::Hevc,
            name: "hevc_videotoolbox".to_string(),
            kind: EncoderKind::Hardware,
            codec_args: vec![
                "-tag:v".into(),
                "hvc1".into(),
                "-q:v".into(),
                "65".into(),
            ],
            probe_wall_clock_ms: 0,
        }
    }

    /// Default audio bitrate used by the composite tests — matches the
    /// production default in `RenderExportRequest`.
    const DEFAULT_AUDIO_KBPS: u32 = 256;

    /// Default delivery target for composite tests. `YoutubeSdr4k` is the
    /// canonical HEVC SDR target — matches the `hevc_choice()` fixture
    /// and the existing assertions on `-c:v libx265`, `-c:a aac`, BT.709
    /// color tags, and `+faststart`. Tests that exercise a specific
    /// target (HDR, ProRes, social) override locally.
    const DEFAULT_TEST_TARGET: DeliveryTarget = DeliveryTarget::SdrH265;

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
            DEFAULT_AUDIO_KBPS,
            DEFAULT_TEST_TARGET,
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
        // Rawvideo geometry matches the map slot dims (renderer downsamples
        // its supersampled buffer to slot dims on-GPU).
        assert!(joined.contains("-s 346x346"), "joined: {}", joined);
        assert!(joined.contains("-r 30"), "joined: {}", joined);
        assert!(joined.contains("-i pipe:0"), "joined: {}", joined);

        // No looped mask.
        assert!(!plan.argv.iter().any(|a| a == "-loop"));

        // filter_complex assertions.
        let fc = fc_of(&plan);
        assert!(fc.contains("concat=n=2:v=1:a=0,fps=30[vc]"), "fc: {}", fc);
        // WS3: the map stream now enters working space via
        // `map_ingest_filter()` instead of a pixel-only `format=yuva444p10le`
        // promotion. The label `[map]` denotes a gbrpf32le stream — the
        // overlay below operates in working space, not yuv space.
        let expected_map_ingest = crate::util::color::map_ingest_filter();
        assert!(
            fc.contains(&format!("[2:v]{expected_map_ingest}[map]")),
            "fc: {}",
            fc,
        );
        // The overlay is in working space — no `format=auto` needed
        // (both inputs are gbrpf32le, no negotiation). `overlay` cannot
        // consume `gbrpf32le` directly, so both inputs are explicitly
        // lifted to `yuva444p10le` (4:4:4 10-bit) before the overlay and
        // the result is brought back to working space afterwards.
        assert!(
            fc.contains("[vc]format=yuva444p10le[vc_nm]"),
            "fc: {}",
            fc,
        );
        assert!(
            fc.contains("[map]format=yuva444p10le[map_nm]"),
            "fc: {}",
            fc,
        );
        assert!(
            fc.contains("[vc_nm][map_nm]overlay=702:1497:format=yuv444p10[vout_lifted]"),
            "fc: {}",
            fc,
        );
        assert!(
            fc.contains("[vout_lifted]format=gbrpf32le[vout_w]"),
            "fc: {}",
            fc,
        );
        // Regression guard: the buggy unlifted overlay must not appear.
        assert!(
            !fc.contains("[vc][map]overlay="),
            "no-mask PipMapInset must lift both overlay inputs; fc: {}",
            fc,
        );
        // Delivery finishing chain — `SdrH265` target picks BT.709 limited
        // yuv420p (color transform only; no scale+pad). Post-Issue-2
        // refactor: the composite renders at the project's validated
        // canvas from the start, so the finishing chain no longer encodes
        // aspect/resolution. Asserting that scale/pad are ABSENT is the
        // regression guard that catches re-introduction of the conflation.
        assert!(
            fc.contains("[vout_w]zscale=t=bt709:m=bt709:p=bt709:r=limited"),
            "fc must contain SdrH265 finishing chain (BT.709 limited zscale): {}",
            fc,
        );
        assert!(
            fc.contains("format=yuv420p"),
            "fc must emit yuv420p for SDR target: {}",
            fc,
        );
        // `[vout]` is the video pipeline's final label; the full filter_complex
        // continues with `;[0:a]atrim=...` audio subgraphs ending in `[aout]`.
        assert!(
            fc.contains("[vout];") || fc.contains("[vout]"),
            "fc must contain a labeled [vout] output: {}",
            fc,
        );
        assert!(!fc.contains("alphamerge"), "no-mask path must not alphamerge: {}", fc);
        // The finishing chain (post-`[vout_w]`) must NOT resize or pad —
        // pre-Issue-2 it padded to the target's hardcoded dims, silently
        // overriding the user's (aspect, quality). Per-clip scales upstream
        // of `[vout_w]` are legitimate (clips fit project canvas slot);
        // narrow the check to the finishing tail only.
        //
        // Phase 4 re-baseline (fix D): the finishing tail now contains a
        // FLAGS-ONLY `scale=` (the HQ lanczos chroma resample, no w=/h= —
        // it does not resize). The hazard this guards is a DIMENSIONED
        // scale/pad, so that is what's forbidden.
        let finishing_tail = fc
            .rfind("[vout_w]")
            .map(|i| &fc[i..])
            .unwrap_or("");
        assert!(
            !finishing_tail.contains("scale=w=")
                && !finishing_tail.contains(":w=")
                && !finishing_tail.contains("pad="),
            "post-Issue-2: finishing chain must not resize or pad: {}",
            finishing_tail,
        );
        assert!(
            finishing_tail.contains("scale=flags=lanczos"),
            "fix D: SDR finishing must carry the HQ chroma subsample split: {}",
            finishing_tail,
        );

        // Audio chain.
        assert!(fc.contains("concat=n=2:v=0:a=1[aout]"), "fc: {}", fc);

        // -frames:v cap.
        assert!(joined.contains("-frames:v 105"), "joined: {}", joined);

        // Audio encoder splice — `delivery_encoder_args(YoutubeSdr4k, ...)`
        // emits `-c:a aac -b:a 192k` per the WS4 brief (not the legacy
        // 256k from the export-controls plan's audio_bitrate_kbps).
        assert!(joined.contains("-c:a aac -b:a 192k"), "joined: {}", joined);
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

        // frame_bytes_per_input matches the supersampled map render area × 4
        // (RGBA) — slot dims × SSAA factor.
        assert_eq!(
            plan.frame_bytes_per_input,
            expected_map_frame_bytes(map_slot.w, map_slot.h),
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
            DEFAULT_AUDIO_KBPS,
            DEFAULT_TEST_TARGET,
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
        // WS3 masked-PIP shape (PIP-saturation fix): the map is converted
        // to yuva for alphamerge AND the background `[vc]` is lifted to
        // yuva444p10le too, so both inputs to `overlay` share a pixel
        // format family. After overlay, the result is brought back down
        // to working-space `gbrpf32le` for the delivery finishing chain.
        // See `composite_pip_map_inset_with_corner_radius` source comment
        // (and the production code's PipMapInset masked branch) for the
        // root cause — `overlay` does NOT accept `gbrpf32le` natively, so
        // the cross-family mismatch used to be resolved by FFmpeg's
        // implicit swscale with default colorspace tags.
        assert!(fc.contains("[map]format=yuva444p10le[map_a]"), "fc: {}", fc);
        assert!(fc.contains("[map_a][mask]alphamerge[map_masked]"), "fc: {}", fc);
        assert!(fc.contains("[vc]format=yuva444p10le[vc_a]"), "fc: {}", fc);
        assert!(
            fc.contains("[vc_a][map_masked]overlay=702:1497:format=yuv444p10[vout_masked]"),
            "fc: {}",
            fc,
        );
        assert!(
            fc.contains("[vout_masked]format=gbrpf32le[vout_w]"),
            "fc: {}",
            fc,
        );
        // WS4 finishing chain — `YoutubeSdr4k` target. The masked path
        // still routes through the working-space overlay; finishing is
        // applied after `[vout_w]`.
        assert!(
            fc.contains("[vout_w]zscale=t=bt709:m=bt709:p=bt709:r=limited"),
            "fc: {}",
            fc,
        );
        // `[vout]` is the video pipeline's final label; the full filter_complex
        // continues with `;[0:a]atrim=...` audio subgraphs ending in `[aout]`.
        assert!(
            fc.contains("[vout];") || fc.contains("[vout]"),
            "fc must contain a labeled [vout] output: {}",
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
            DEFAULT_AUDIO_KBPS,
            DEFAULT_TEST_TARGET,
            out_path(),
        )
        .unwrap();

        let fc = fc_of(&plan);
        assert!(fc.contains("[3:v]format=gray[mask]"), "fc: {}", fc);
        // WS3 masked-PIP shape (PIP-saturation fix), symmetric to
        // PipMapInset: the video gets converted to yuva for alphamerge,
        // AND the background `[map]` is lifted to yuva444p10le too so
        // both overlay inputs share a pixel format family. After overlay,
        // the result is brought back down to working-space `gbrpf32le`
        // for the delivery finishing chain.
        assert!(fc.contains("[vc]format=yuva444p10le[vc_a]"), "fc: {}", fc);
        assert!(fc.contains("[vc_a][mask]alphamerge[vc_masked]"), "fc: {}", fc);
        assert!(fc.contains("[map]format=yuva444p10le[map_a]"), "fc: {}", fc);
        // Background is the map (lifted to yuva); inset is the masked
        // video at video_slot.
        assert!(
            fc.contains("[map_a][vc_masked]overlay=60:80:format=yuv444p10[vout_masked]"),
            "fc: {}",
            fc,
        );
        assert!(
            fc.contains("[vout_masked]format=gbrpf32le[vout_w]"),
            "fc: {}",
            fc,
        );
        // WS4 finishing chain — `YoutubeSdr4k` target. Same assertion
        // shape as the PipMapInset masked test.
        assert!(
            fc.contains("[vout_w]zscale=t=bt709:m=bt709:p=bt709:r=limited"),
            "fc: {}",
            fc,
        );
        // `[vout]` is the video pipeline's final label; the full filter_complex
        // continues with `;[0:a]atrim=...` audio subgraphs ending in `[aout]`.
        assert!(
            fc.contains("[vout];") || fc.contains("[vout]"),
            "fc must contain a labeled [vout] output: {}",
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
            DEFAULT_AUDIO_KBPS,
            DEFAULT_TEST_TARGET,
            out_path(),
        )
        .unwrap();

        // N+1 inputs = 2 clips + rawvideo. No mask, no -loop.
        assert_eq!(plan.argv.iter().filter(|a| *a == "-i").count(), 3);
        assert!(!plan.argv.iter().any(|a| a == "-loop"));

        let fc = fc_of(&plan);
        // WS3: the synthetic black base is now in working space
        // (gbrpf32le), so both overlays operate in one regime. The
        // `setparams` tail explicitly tags the canvas with the working
        // space's color attributes — without it the synthetic frames
        // carry unspecified primaries / transfer / matrix and the
        // delivery zscale errors with code 3074 on HDR sources (whose
        // working-space tags are `linear` + bt2020 — incompatible with
        // unspecified).
        assert!(
            fc.contains(
                "color=c=black:s=1080x1920:r=30,format=gbrpf32le,\
                 setparams=range=pc:color_primaries=bt2020:color_trc=linear:colorspace=bt2020nc[bg]"
            ),
            "fc: {}",
            fc,
        );
        // Two overlays: map at map_slot, then video at video_slot. No
        // `format=auto` — every input is gbrpf32le and is explicitly
        // lifted to `yuva444p10le` ahead of the overlays so `overlay`
        // doesn't auto-swscale to yuv420 (4:2:0) and softening labels.
        assert!(fc.contains("[bg]format=yuva444p10le[bg_a]"), "fc: {}", fc);
        assert!(fc.contains("[map]format=yuva444p10le[map_a]"), "fc: {}", fc);
        assert!(fc.contains("[vc]format=yuva444p10le[vc_a]"), "fc: {}", fc);
        assert!(
            fc.contains("[bg_a][map_a]overlay=0:0:format=yuv444p10[bg_with_map]"),
            "fc: {}",
            fc,
        );
        assert!(
            fc.contains("[bg_with_map][vc_a]overlay=540:0:format=yuv444p10[vout_lifted]"),
            "fc: {}",
            fc,
        );
        assert!(
            fc.contains("[vout_lifted]format=gbrpf32le[vout_w]"),
            "fc: {}",
            fc,
        );
        // Regression guard: bare unlifted overlays must not appear.
        assert!(
            !fc.contains("[bg][map]overlay="),
            "Split must lift bg/map before first overlay; fc: {}",
            fc,
        );
        assert!(
            !fc.contains("[bg_with_map][vc]overlay="),
            "Split must lift vc before second overlay; fc: {}",
            fc,
        );
        // WS4 finishing chain — `YoutubeSdr4k` target. Split has no
        // alpha-bearing inset; the chain is the same BT.709 SDR finishing
        // chain as the no-mask PIP paths.
        assert!(
            fc.contains("[vout_w]zscale=t=bt709:m=bt709:p=bt709:r=limited"),
            "fc: {}",
            fc,
        );
        // `[vout]` is the video pipeline's final label; the full filter_complex
        // continues with `;[0:a]atrim=...` audio subgraphs ending in `[aout]`.
        assert!(
            fc.contains("[vout];") || fc.contains("[vout]"),
            "fc must contain a labeled [vout] output: {}",
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
                DEFAULT_AUDIO_KBPS,
                DEFAULT_TEST_TARGET,
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
    fn composite_frame_bytes_matches_supersampled_map_slot_area_x4() {
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
                DEFAULT_AUDIO_KBPS,
                DEFAULT_TEST_TARGET,
                out_path(),
            )
            .unwrap();
            assert_eq!(
                plan.frame_bytes_per_input,
                expected_map_frame_bytes(*w, *h),
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
            DEFAULT_AUDIO_KBPS,
            DEFAULT_TEST_TARGET,
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
                DEFAULT_AUDIO_KBPS,
                DEFAULT_TEST_TARGET,
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
            DEFAULT_AUDIO_KBPS,
            DEFAULT_TEST_TARGET,
            out_path(),
        )
        .unwrap();
        let fc = fc_of(&plan);
        // WS3: the per-clip chain pattern is now
        // `crop=...,scale=W:H,{F_ingest_{class}},format=gbrpf32le[v{idx}]`
        // (scale BEFORE ingest BEFORE the working-space format). Assert the
        // video_slot dims appear in the `scale=W:H,` position, and the
        // map_slot dims do NOT — `scale=320:568,zscale=…` would be the bug.
        assert!(
            fc.contains("scale=1080:1920,zscale="),
            "expected per-clip scale to video_slot dims followed by working-space ingest; fc: {}",
            fc,
        );
        assert!(
            !fc.contains("scale=320:568,zscale="),
            "per-clip scale should use video_slot, not map_slot; fc: {}",
            fc,
        );
    }

    #[test]
    fn composite_fps_normalizes_concat_to_export_rate() {
        // Regression: an export at fps=24 of 30-fps iPhone source clips
        // produced a 30-fps composite output (overlay inherits its first
        // input's rate; `[vc]` carries clip-native rate without
        // normalization). The `-frames:v` cap is computed at the export
        // fps, so output reached the cap at `cap/30` seconds — earlier than
        // `cap/24` — FFmpeg closed stdin, and the orchestrator's next sink
        // write failed with `Broken pipe (os error 32)`. The `fps={fps}`
        // splice after `concat` keeps `[vc]` on the same clock as the
        // rawvideo input (`-r {fps}`) and the cap.
        //
        // Cover every CompositeMode + both fps tiers we expose (24 and 30)
        // so a future refactor that reorders the filter chain can't drop
        // the normalization for one mode while preserving it for another.
        for mode in [
            CompositeMode::PipMapInset,
            CompositeMode::PipVideoInset,
            CompositeMode::Split,
        ] {
            for fps in [24u32, 30u32] {
                let inputs = vec![vc("a", 2000, true)];
                let map_slot = PixelRect { x: 0, y: 0, w: 1080, h: 1080 };
                let video_slot = PixelRect { x: 0, y: 1080, w: 1080, h: 840 };
                let output = OutputDimensions { w: 1080, h: 1920 };
                let plan = build_composite_filtergraph(
                    &inputs,
                    map_slot,
                    video_slot,
                    output,
                    mode,
                    None,
                    fps,
                    fps * 2,
                    &hevc_choice(),
                    DEFAULT_AUDIO_KBPS,
                    DEFAULT_TEST_TARGET,
                    out_path(),
                )
                .unwrap();
                let fc = fc_of(&plan);
                let needle = format!("concat=n=1:v=1:a=0,fps={fps}[vc]");
                assert!(
                    fc.contains(&needle),
                    "mode={:?} fps={}: expected `{}` in filter_complex; fc: {}",
                    mode, fps, needle, fc,
                );
                // Negative form: the un-normalized concat (the pre-fix
                // shape) must not appear. Catches a regression that emits
                // both forms or accidentally double-labels `[vc]`.
                assert!(
                    !fc.contains("concat=n=1:v=1:a=0[vc]"),
                    "mode={:?} fps={}: un-normalized concat must not appear; fc: {}",
                    mode, fps, fc,
                );
            }
        }
    }

    // -----------------------------------------------------------------
    // WS3 — working-space architecture in export
    // -----------------------------------------------------------------

    /// Helper: clone a `VisibleClipInput` with a specific source color class.
    fn vc_with_class(
        id: &str,
        dur_ms: u64,
        has_audio: bool,
        class: crate::util::color::SourceColorClass,
    ) -> VisibleClipInput {
        let mut v = vc(id, dur_ms, has_audio);
        v.clip.source_color_class = class;
        v
    }

    #[test]
    fn ws3_map_only_filter_complex_contains_map_ingest_filter() {
        // Acceptance criterion: map ingest must contain `map_ingest_filter()`
        // output. Verified for both the no-mask and masked branches of
        // Channel B's filter_complex.
        let slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let expected = crate::util::color::map_ingest_filter();

        // No-mask branch.
        let plan = build_map_only_filtergraph(
            slot, output, None, 30, 60, &prores_choice(), out_path(),
        );
        let fc = plan
            .argv
            .iter()
            .position(|a| a == "-filter_complex")
            .map(|i| &plan.argv[i + 1])
            .unwrap();
        assert!(
            fc.contains(&expected),
            "no-mask map_only must contain map_ingest_filter() output; expected substring `{}`; fc: {}",
            expected, fc,
        );

        // Masked branch.
        let mask_path = Path::new("/tmp/mask.png");
        let plan = build_map_only_filtergraph(
            slot, output, Some(mask_path), 30, 60, &prores_choice(), out_path(),
        );
        let fc = plan
            .argv
            .iter()
            .position(|a| a == "-filter_complex")
            .map(|i| &plan.argv[i + 1])
            .unwrap();
        assert!(
            fc.contains(&expected),
            "masked map_only must contain map_ingest_filter() output; expected substring `{}`; fc: {}",
            expected, fc,
        );
    }

    #[test]
    fn ws3_composite_filter_complex_contains_map_ingest_filter() {
        // Acceptance criterion: map ingest in Channel A must contain
        // `map_ingest_filter()` output for every composite mode. This is
        // the PIP-saturation-bug fix's structural assertion — both sides
        // of every overlay must enter working space.
        let expected = crate::util::color::map_ingest_filter();
        let map_slot = PixelRect { x: 100, y: 200, w: 346, h: 346 };
        let video_slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true)];

        for (mode, mask) in [
            (CompositeMode::PipMapInset, None),
            (CompositeMode::PipMapInset, Some(Path::new("/tmp/mask.png"))),
            (CompositeMode::PipVideoInset, None),
            (CompositeMode::PipVideoInset, Some(Path::new("/tmp/mask.png"))),
            (CompositeMode::Split, None),
        ] {
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
                DEFAULT_AUDIO_KBPS,
                DEFAULT_TEST_TARGET,
                out_path(),
            )
            .unwrap();
            let fc = fc_of(&plan);
            assert!(
                fc.contains(&expected),
                "mode={:?} mask={:?}: filter_complex must contain map_ingest_filter() output; fc: {}",
                mode, mask, fc,
            );
        }
    }

    #[test]
    fn ws3_per_clip_subgraph_contains_ingest_filter_for_class() {
        // Acceptance criterion: per-clip subgraphs must contain the
        // `ingest_filter_for(class)` output for the clip's effective
        // color class. Exercised for both Channel A and Channel C across
        // every Phase 1 SourceColorClass.
        let map_slot = PixelRect { x: 100, y: 200, w: 346, h: 346 };
        let video_slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };

        for class in [
            crate::util::color::SourceColorClass::SdrBt709,
            crate::util::color::SourceColorClass::HlgBt2020,
            crate::util::color::SourceColorClass::PqBt2020,
            crate::util::color::SourceColorClass::DolbyVision,
            crate::util::color::SourceColorClass::Unknown,
        ] {
            let expected = crate::util::color::ingest_filter_for(class, None);
            let inputs = vec![vc_with_class("a", 2000, true, class)];

            // Channel A (composite).
            let plan_a = build_composite_filtergraph(
                &inputs,
                map_slot,
                video_slot,
                output,
                CompositeMode::PipMapInset,
                None,
                30,
                60,
                &hevc_choice(),
                DEFAULT_AUDIO_KBPS,
                DEFAULT_TEST_TARGET,
                out_path(),
            )
            .unwrap();
            assert!(
                fc_of(&plan_a).contains(&expected),
                "composite class={:?}: per-clip subgraph must contain ingest_filter_for({:?}); fc: {}",
                class, class, fc_of(&plan_a),
            );

            // Channel C (video_only).
            let plan_c = build_video_only_filtergraph(
                &inputs,
                video_slot,
                output,
                None,
                30,
                &prores_choice(),
                &["-c:a", "pcm_s16le"],
                out_path(),
            )
            .unwrap();
            assert!(
                fc_of(&plan_c).contains(&expected),
                "video_only class={:?}: per-clip subgraph must contain ingest_filter_for({:?}); fc: {}",
                class, class, fc_of(&plan_c),
            );
        }
    }

    #[test]
    fn ws3_composite_filter_complex_internal_precision_is_gbrpf32le() {
        // Acceptance criterion: "Internal precision is `gbrpf32le` through
        // the filter graph (verify by inspecting the assembled filter
        // string)." For every composite mode, assert (a) gbrpf32le appears
        // (per-clip ingest output + map ingest output), and (b) the
        // pre-delivery placeholder is yuv444p10le — high-bit-depth, no
        // chroma subsample — not yuv420p (which would be a regression to
        // the pre-WS3 forced 8-bit chroma loss).
        let map_slot = PixelRect { x: 100, y: 200, w: 346, h: 346 };
        let video_slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true)];

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
                60,
                &hevc_choice(),
                DEFAULT_AUDIO_KBPS,
                DEFAULT_TEST_TARGET,
                out_path(),
            )
            .unwrap();
            let fc = fc_of(&plan);
            assert!(
                fc.contains("format=gbrpf32le"),
                "mode={:?}: working-space pixel format gbrpf32le must appear in filter_complex; fc: {}",
                mode, fc,
            );
            // WS4 delivery finishing: `YoutubeSdr4k` emits
            // `format=yuv420p` (8-bit 4:2:0 for SDR HEVC). The pre-WS3
            // forced 4:2:0 used to appear UNCONDITIONALLY before any
            // working-space rewrite; under WS4 it only appears as the
            // tail-end of the delivery chain after the working-space
            // overlay has completed. We assert (a) gbrpf32le appears
            // (working-space invariant), (b) yuv420p appears only AFTER
            // the working-space marker — i.e. it's the delivery output
            // format, not a forced early subsample.
            let gbr_pos = fc
                .find("format=gbrpf32le")
                .expect("working-space pix fmt missing");
            if let Some(yuv_pos) = fc.find("format=yuv420p") {
                assert!(
                    yuv_pos > gbr_pos,
                    "mode={:?}: yuv420p must appear AFTER working-space gbrpf32le (delivery finishing tail), not before; fc: {}",
                    mode, fc,
                );
            }
        }
    }

    #[test]
    fn ws3_composite_overlays_drop_format_auto_negotiation() {
        // With WS3 both overlay inputs are gbrpf32le, so the
        // `format=auto` negotiation is no longer needed on the
        // working-space overlays. The masked branches still need to
        // negotiate (one input is yuva post-alphamerge), but the no-mask
        // case must be pure working-space overlay.
        let map_slot = PixelRect { x: 100, y: 200, w: 346, h: 346 };
        let video_slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true)];
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
                60,
                &hevc_choice(),
                DEFAULT_AUDIO_KBPS,
                DEFAULT_TEST_TARGET,
                out_path(),
            )
            .unwrap();
            let fc = fc_of(&plan);
            assert!(
                !fc.contains("format=auto"),
                "mode={:?} no-mask: overlay must not carry format=auto in working space; fc: {}",
                mode, fc,
            );
        }
    }

    #[test]
    fn ws3_composite_with_mixed_source_classes_emits_distinct_ingest_chains() {
        // Mixed-source timeline (SDR + HLG clip in the same project) is
        // exactly the case WS3 fixes. Each per-clip subgraph must carry
        // its own ingest chain — the SDR clip routes through bt709, the
        // HLG clip through arib-std-b67 — and BOTH must end in
        // gbrpf32le so concat sees uniform pixel formats.
        let map_slot = PixelRect { x: 100, y: 200, w: 346, h: 346 };
        let video_slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![
            vc_with_class("a", 2000, true, crate::util::color::SourceColorClass::SdrBt709),
            vc_with_class("b", 1500, true, crate::util::color::SourceColorClass::HlgBt2020),
        ];
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
            DEFAULT_AUDIO_KBPS,
            DEFAULT_TEST_TARGET,
            out_path(),
        )
        .unwrap();
        let fc = fc_of(&plan);
        assert!(
            fc.contains("zscale=tin=bt709:t=linear"),
            "SDR clip must route through bt709 ingest; fc: {}",
            fc,
        );
        assert!(
            fc.contains("zscale=tin=arib-std-b67:t=linear:npl=100"),
            "HLG clip must route through arib-std-b67 ingest; fc: {}",
            fc,
        );
        // Both per-clip subgraphs must terminate in gbrpf32le.
        assert!(
            fc.contains(",format=gbrpf32le[v0]"),
            "SDR per-clip subgraph must end in gbrpf32le; fc: {}",
            fc,
        );
        assert!(
            fc.contains(",format=gbrpf32le[v1]"),
            "HLG per-clip subgraph must end in gbrpf32le; fc: {}",
            fc,
        );
    }

    #[test]
    fn video_only_fps_normalizes_concat_to_export_rate() {
        // Channel C variant of the same bug. video_only has no rawvideo
        // input and no `-frames:v` cap, so the symptom is silent rather
        // than a Broken pipe: an N-second export at fps=24 of 30-fps source
        // clips produces 30·N output frames (1.25× expected duration).
        // Same fix — `fps={fps}` after the video concat — for the same
        // reason.
        let slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        for fps in [24u32, 30u32, 60u32] {
            let inputs = vec![vc("a", 2000, true)];
            let plan = build_video_only_filtergraph(
                &inputs,
                slot,
                output,
                None,
                fps,
                &prores_choice(),
                &["-c:a", "pcm_s16le"],
                out_path(),
            )
            .unwrap();
            let fc = fc_of(&plan);
            let needle = format!("concat=n=1:v=1:a=0,fps={fps}[vc]");
            assert!(fc.contains(&needle), "fps={}: expected `{}`; fc: {}", fps, needle, fc);
            assert!(
                !fc.contains("concat=n=1:v=1:a=0[vc]"),
                "fps={}: un-normalized concat must not appear; fc: {}",
                fps, fc,
            );
        }
    }

    // ---------- WS6 — hevc_videotoolbox parity coverage ----------
    //
    // Every composite test above runs against `hevc_choice()` (software
    // libx265). The WS6 brief requires both encoder paths be covered:
    // these tests run the macOS hardware encoder choice through the same
    // builder and assert the argv splices the videotoolbox name + its
    // `-tag:v hvc1 -q:v 65` codec args without an explicit `-pix_fmt`
    // (which the VideoToolbox encoder picks for itself based on input).

    #[test]
    fn composite_with_hevc_videotoolbox_splices_videotoolbox_codec_args() {
        let map_slot = PixelRect { x: 702, y: 1497, w: 346, h: 346 };
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
            &hevc_videotoolbox_choice(),
            DEFAULT_AUDIO_KBPS,
            DEFAULT_TEST_TARGET,
            out_path(),
        )
        .unwrap();

        let joined = argv_to_string(&plan.argv);
        // Encoder name and its videotoolbox-specific codec args.
        // `delivery_encoder_args(SdrH265, videotoolbox)` emits
        // `-c:v hevc_videotoolbox -tag:v hvc1 -q:v 65` — the FALLBACK-ONLY
        // hardware path (libx265 absent); q:v 65 replaced the WS4 brief's
        // q:v 50, which the decoration-crispness probe (2026-07-03) measured
        // starving the encode (~13 Mbps at 4K, decoration mush).
        let cv_idx = plan.argv.iter().position(|a| a == "-c:v").unwrap();
        assert_eq!(plan.argv[cv_idx + 1], "hevc_videotoolbox");
        assert!(joined.contains("-tag:v hvc1"), "joined: {}", joined);
        assert!(joined.contains("-q:v 65"), "VT fallback uses q:v 65 (non-starving); joined: {}", joined);
        let cv_count = plan
            .argv
            .windows(2)
            .filter(|w| w[0] == "-c:v")
            .count();
        assert_eq!(cv_count, 1, "expected exactly one -c:v pair, argv: {:?}", plan.argv);
        // WS4: every YoutubeSdr4k argv carries `-pix_fmt yuv420p`
        // regardless of encoder. The pre-WS4 invariant ("VideoToolbox
        // picks its own pix_fmt") is gone — the delivery target dictates
        // pixel format so the output's `colr` atom and the stream VUI
        // align.
        assert!(
            joined.contains("-pix_fmt yuv420p"),
            "WS4 delivery target dictates -pix_fmt yuv420p for YoutubeSdr4k; joined: {}",
            joined,
        );
        // WS6 regression: VT path honours global -color_* flags directly,
        // so the encoder-params VUI duplicate is NOT emitted on this path.
        assert!(
            !joined.contains("-x265-params"),
            "videotoolbox path must not splice -x265-params: {}",
            joined,
        );

        // `+faststart` and audio splicing both class-agnostic — same as libx265 path.
        assert!(joined.contains("-movflags +faststart"), "joined: {}", joined);
        assert!(joined.contains("-c:a aac"), "joined: {}", joined);
    }

    #[test]
    fn composite_libx265_and_videotoolbox_paths_share_filter_complex() {
        // Encoder choice is post-filter-complex — the filter graph itself
        // does NOT depend on which HEVC encoder we use. This test
        // structurally enforces that property: same inputs, different
        // encoder choice, identical filter_complex string.
        let map_slot = PixelRect { x: 702, y: 1497, w: 346, h: 346 };
        let video_slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true)];

        let with_sw = build_composite_filtergraph(
            &inputs,
            map_slot,
            video_slot,
            output,
            CompositeMode::PipMapInset,
            None,
            30,
            60,
            &hevc_choice(),
            DEFAULT_AUDIO_KBPS,
            DEFAULT_TEST_TARGET,
            out_path(),
        )
        .unwrap();
        let with_hw = build_composite_filtergraph(
            &inputs,
            map_slot,
            video_slot,
            output,
            CompositeMode::PipMapInset,
            None,
            30,
            60,
            &hevc_videotoolbox_choice(),
            DEFAULT_AUDIO_KBPS,
            DEFAULT_TEST_TARGET,
            out_path(),
        )
        .unwrap();

        let fc_sw = fc_of(&with_sw);
        let fc_hw = fc_of(&with_hw);
        assert_eq!(
            fc_sw, fc_hw,
            "filter_complex must be encoder-agnostic; sw={}, hw={}",
            fc_sw, fc_hw,
        );
        assert_eq!(
            with_sw.frame_bytes_per_input, with_hw.frame_bytes_per_input,
            "frame_bytes_per_input is filter-derived, must be encoder-agnostic",
        );
    }

    #[test]
    fn ws3_masked_pip_overlay_inputs_share_pixel_format_family() {
        // PIP-saturation regression guard (post-WS3-QA fix).
        //
        // The bug: the masked-PIP branches used to feed `overlay` two
        // inputs from different pixel-format families — `gbrpf32le`
        // (working-space, float, no alpha) for the background and
        // `yuva444p10le` (10-bit 4:4:4 with alpha) for the masked inset.
        // `overlay`'s pixel-format support does NOT include `gbrpf32le`
        // (see `ffmpeg -h filter=overlay` — the `format` enum covers
        // yuv420/422/444 +/-10-bit, rgb, gbrp, but no float variants).
        // FFmpeg's framework resolved the cross-family mismatch by
        // auto-inserting a swscale with default colorspace tags, which
        // is exactly the implicit-conversion path WS3 was designed to
        // eliminate.
        //
        // The fix lifts the background side to `yuva444p10le` BEFORE
        // overlay so both inputs share a family (10-bit 4:4:4 with
        // alpha). After overlay, the result is converted back to
        // `gbrpf32le` so the `[vout_w]` label still matches the
        // working-space contract `delivery_finishing_filter` expects.
        //
        // This test asserts both masked-PIP branches emit:
        //   1. an explicit `format=yuva444p10le` step on the background
        //      side (either `[vc]format=yuva444p10le[vc_a]` for
        //      PipMapInset or `[map]format=yuva444p10le[map_a]` for
        //      PipVideoInset),
        //   2. an `overlay` step whose two inputs both end in `_a` (the
        //      yuva-promoted background) or `_masked` (the alpha-merged
        //      inset) — never a raw `[vc]` or `[map]` going straight
        //      into `overlay`,
        //   3. a post-overlay round-trip back to `gbrpf32le` so
        //      `[vout_w]` is in the working-space pixel format.
        let map_slot = PixelRect { x: 100, y: 200, w: 346, h: 346 };
        let video_slot = PixelRect { x: 60, y: 80, w: 400, h: 720 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true)];
        let mask_path = Path::new("/tmp/mask.png");

        for (label, mode, expected_overlay) in [
            (
                "PipMapInset",
                CompositeMode::PipMapInset,
                "[vc_a][map_masked]overlay=",
            ),
            (
                "PipVideoInset",
                CompositeMode::PipVideoInset,
                "[map_a][vc_masked]overlay=",
            ),
        ] {
            let plan = build_composite_filtergraph(
                &inputs,
                map_slot,
                video_slot,
                output,
                mode,
                Some(mask_path),
                30,
                60,
                &hevc_choice(),
                DEFAULT_AUDIO_KBPS,
                DEFAULT_TEST_TARGET,
                out_path(),
            )
            .unwrap();
            let fc = fc_of(&plan);

            // (1) Both `[vc]` and `[map]` get an explicit
            //     `format=yuva444p10le` step. The masked stream (vc_masked
            //     or map_masked) inherits yuva via alphamerge; the
            //     background side has to be promoted explicitly.
            assert!(
                fc.contains("[vc]format=yuva444p10le[vc_a]"),
                "{label}: missing `[vc]format=yuva444p10le[vc_a]`; fc: {fc}",
            );
            assert!(
                fc.contains("[map]format=yuva444p10le[map_a]"),
                "{label}: missing `[map]format=yuva444p10le[map_a]`; fc: {fc}",
            );

            // (2) The overlay step composes the two yuva-family streams.
            //     No raw `[vc]` or `[map]` (gbrpf32le) entering overlay.
            assert!(
                fc.contains(expected_overlay),
                "{label}: expected `{expected_overlay}` in fc: {fc}",
            );
            // Negative: the pre-fix shape (one gbrpf32le input, one
            // yuva input) must not appear.
            assert!(
                !fc.contains("[vc][map_masked]overlay"),
                "{label}: pre-fix shape `[vc][map_masked]overlay` (mixed families) must not appear; fc: {fc}",
            );
            assert!(
                !fc.contains("[map][vc_masked]overlay"),
                "{label}: pre-fix shape `[map][vc_masked]overlay` (mixed families) must not appear; fc: {fc}",
            );

            // (3) Post-overlay round-trip back to working-space gbrpf32le.
            //     `[vout_w]` is what `delivery_finishing_filter` consumes
            //     and the working-space contract says it should be in
            //     `gbrpf32le`.
            assert!(
                fc.contains("[vout_masked]format=gbrpf32le[vout_w]"),
                "{label}: missing `[vout_masked]format=gbrpf32le[vout_w]` round-trip; fc: {fc}",
            );
        }
    }

    #[test]
    fn ws3_masked_pip_overlay_finishing_chain_still_runs_off_vout_w() {
        // Adjacent regression guard for the masked-PIP fix above. The
        // `delivery_finishing_filter` chain is spliced as
        // `[vout_w]{finishing}[vout]`; the fix renamed the intermediate
        // post-overlay label to `[vout_masked]` and adds the
        // `[vout_masked]format=gbrpf32le[vout_w]` step. This test asserts
        // the finishing chain is still attached to `[vout_w]` (not to
        // `[vout_masked]`), so the WS4 delivery transform actually runs.
        let map_slot = PixelRect { x: 100, y: 200, w: 346, h: 346 };
        let video_slot = PixelRect { x: 60, y: 80, w: 400, h: 720 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true)];
        let mask_path = Path::new("/tmp/mask.png");

        for mode in [CompositeMode::PipMapInset, CompositeMode::PipVideoInset] {
            let plan = build_composite_filtergraph(
                &inputs,
                map_slot,
                video_slot,
                output,
                mode,
                Some(mask_path),
                30,
                60,
                &hevc_choice(),
                DEFAULT_AUDIO_KBPS,
                DEFAULT_TEST_TARGET,
                out_path(),
            )
            .unwrap();
            let fc = fc_of(&plan);
            // The finishing chain begins immediately after `[vout_w]`
            // (the working-space label). The exact head of the chain
            // depends on the delivery target — YoutubeSdr4k's chain
            // begins with `zscale=t=bt709:m=bt709:p=bt709:r=limited`.
            assert!(
                fc.contains("[vout_w]zscale=t=bt709:m=bt709:p=bt709:r=limited"),
                "mode={mode:?}: finishing chain must follow `[vout_w]`; fc: {fc}",
            );
            // Negative: the finishing chain must NOT follow
            // `[vout_masked]` (that's the pre-finishing intermediate;
            // a regression that splices the finishing chain there
            // would skip the working-space round-trip).
            assert!(
                !fc.contains("[vout_masked]zscale="),
                "mode={mode:?}: finishing chain must not splice onto `[vout_masked]`; fc: {fc}",
            );
        }
    }

    // ---------- 4K HEVC chroma regression — overlay-input lift ----------
    //
    // FFmpeg's `overlay` filter does not accept `gbrpf32le` (its supported
    // `format` enum is yuv420/422/444 (incl. 10-bit), rgb, gbrp — no float
    // variants). If `overlay` is fed `gbrpf32le` inputs the framework
    // silently auto-inserts a swscale that converts to yuv420 (4:2:0)
    // BEFORE the overlay, subsampling chroma early — visible as soft
    // labels/edges in the export vs. the live preview. The fix lifts
    // overlay inputs to `yuva444p10le` (4:4:4, 10-bit) ahead of every
    // overlay and converts back to working space afterwards. The tests
    // below pin that contract on each composite branch.

    #[test]
    fn pip_map_inset_no_mask_lifts_overlay_inputs_to_yuva444p10le() {
        let map_slot = PixelRect { x: 702, y: 1497, w: 346, h: 346 };
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
            DEFAULT_AUDIO_KBPS,
            DEFAULT_TEST_TARGET,
            out_path(),
        )
        .unwrap();
        let fc = fc_of(&plan);
        // Both overlay inputs explicitly lifted ahead of the overlay.
        assert!(
            fc.contains("[vc]format=yuva444p10le[vc_nm]"),
            "PipMapInset no-mask must lift `[vc]` to yuva444p10le before overlay; fc: {fc}",
        );
        assert!(
            fc.contains("[map]format=yuva444p10le[map_nm]"),
            "PipMapInset no-mask must lift `[map]` to yuva444p10le before overlay; fc: {fc}",
        );
        // Overlay operates on lifted labels with explicit
        // `:format=yuv444p10` to pin its internal pixel format. Without
        // that parameter `overlay` defaults to `yuv420` and auto-inserts
        // a swscale that downconverts both inputs to yuva420p before
        // compositing — the chroma drop the round-1 lift was meant to
        // prevent.
        assert!(
            fc.contains("[vc_nm][map_nm]overlay=702:1497:format=yuv444p10[vout_lifted]"),
            "PipMapInset no-mask overlay must consume lifted labels with :format=yuv444p10; fc: {fc}",
        );
        // Round-trip back to working space.
        assert!(
            fc.contains("[vout_lifted]format=gbrpf32le[vout_w]"),
            "PipMapInset no-mask must round-trip back to working space; fc: {fc}",
        );
        // Buggy unlifted overlay must not appear.
        assert!(
            !fc.contains("[vc][map]overlay="),
            "PipMapInset no-mask must not feed bare gbrpf32le to overlay; fc: {fc}",
        );
    }

    #[test]
    fn pip_video_inset_no_mask_lifts_overlay_inputs_to_yuva444p10le() {
        let map_slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let video_slot = PixelRect { x: 702, y: 1497, w: 346, h: 346 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true)];
        let plan = build_composite_filtergraph(
            &inputs,
            map_slot,
            video_slot,
            output,
            CompositeMode::PipVideoInset,
            None,
            30,
            60,
            &hevc_choice(),
            DEFAULT_AUDIO_KBPS,
            DEFAULT_TEST_TARGET,
            out_path(),
        )
        .unwrap();
        let fc = fc_of(&plan);
        assert!(
            fc.contains("[map]format=yuva444p10le[map_nm]"),
            "PipVideoInset no-mask must lift `[map]` to yuva444p10le before overlay; fc: {fc}",
        );
        assert!(
            fc.contains("[vc]format=yuva444p10le[vc_nm]"),
            "PipVideoInset no-mask must lift `[vc]` to yuva444p10le before overlay; fc: {fc}",
        );
        assert!(
            fc.contains("[map_nm][vc_nm]overlay=702:1497:format=yuv444p10[vout_lifted]"),
            "PipVideoInset no-mask overlay must consume lifted labels with :format=yuv444p10; fc: {fc}",
        );
        assert!(
            fc.contains("[vout_lifted]format=gbrpf32le[vout_w]"),
            "PipVideoInset no-mask must round-trip back to working space; fc: {fc}",
        );
        assert!(
            !fc.contains("[map][vc]overlay="),
            "PipVideoInset no-mask must not feed bare gbrpf32le to overlay; fc: {fc}",
        );
    }

    #[test]
    fn split_lifts_all_overlay_inputs_to_yuva444p10le() {
        // Symmetric 50/50 split (half-canvas each, no overlap).
        let map_slot = PixelRect { x: 0, y: 0, w: 540, h: 1920 };
        let video_slot = PixelRect { x: 540, y: 0, w: 540, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true)];
        let plan = build_composite_filtergraph(
            &inputs,
            map_slot,
            video_slot,
            output,
            CompositeMode::Split,
            None,
            30,
            60,
            &hevc_choice(),
            DEFAULT_AUDIO_KBPS,
            DEFAULT_TEST_TARGET,
            out_path(),
        )
        .unwrap();
        let fc = fc_of(&plan);
        // All three overlay-touching streams lifted ahead of the overlays.
        assert!(
            fc.contains("[bg]format=yuva444p10le[bg_a]"),
            "Split must lift `[bg]` to yuva444p10le before overlay; fc: {fc}",
        );
        assert!(
            fc.contains("[map]format=yuva444p10le[map_a]"),
            "Split must lift `[map]` to yuva444p10le before overlay; fc: {fc}",
        );
        assert!(
            fc.contains("[vc]format=yuva444p10le[vc_a]"),
            "Split must lift `[vc]` to yuva444p10le before overlay; fc: {fc}",
        );
        // Both overlays operate on lifted labels with explicit
        // `:format=yuv444p10` (see PipMapInset test for why).
        assert!(
            fc.contains("[bg_a][map_a]overlay=0:0:format=yuv444p10[bg_with_map]"),
            "Split first overlay must consume lifted labels with :format=yuv444p10; fc: {fc}",
        );
        assert!(
            fc.contains("[bg_with_map][vc_a]overlay=540:0:format=yuv444p10[vout_lifted]"),
            "Split second overlay must consume lifted labels with :format=yuv444p10; fc: {fc}",
        );
        // Round-trip back to working space.
        assert!(
            fc.contains("[vout_lifted]format=gbrpf32le[vout_w]"),
            "Split must round-trip back to working space; fc: {fc}",
        );
        // No bare gbrpf32le overlay anywhere in the Split chain.
        assert!(
            !fc.contains("[bg][map]overlay="),
            "Split must lift bg/map before first overlay; fc: {fc}",
        );
        assert!(
            !fc.contains("[bg_with_map][vc]overlay="),
            "Split must lift vc before second overlay; fc: {fc}",
        );
    }

    #[test]
    fn composite_overlays_never_consume_unlifted_working_space_labels() {
        // Defense-in-depth scan: across every composite mode (both
        // masked and unmasked), no `overlay=...` invocation may consume
        // a label whose most recent definition emitted `gbrpf32le`.
        // Concretely: scan the filter_complex chain for `overlay=` and
        // assert each input label was last written by a step ending in
        // `format=yuva444p10le[<label>]` (or by an `alphamerge[<label>]`
        // — itself sourced from a yuva-lifted predecessor). This catches
        // any future composite branch that forgets the lift.
        let map_slot = PixelRect { x: 702, y: 1497, w: 346, h: 346 };
        let video_slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true)];
        let mask = Path::new("/tmp/mask.png");

        for (mode, mask_arg) in [
            (CompositeMode::PipMapInset, None),
            (CompositeMode::PipMapInset, Some(mask)),
            (CompositeMode::PipVideoInset, None),
            (CompositeMode::PipVideoInset, Some(mask)),
            (CompositeMode::Split, None),
        ] {
            let plan = build_composite_filtergraph(
                &inputs,
                map_slot,
                video_slot,
                output,
                mode,
                mask_arg,
                30,
                60,
                &hevc_choice(),
                DEFAULT_AUDIO_KBPS,
                DEFAULT_TEST_TARGET,
                out_path(),
            )
            .unwrap();
            let fc = fc_of(&plan);

            // Find every `[X][Y]overlay=` occurrence and verify both
            // labels were produced by a yuva444p10le lift (or an
            // alphamerge that consumed a yuva444p10le-lifted input).
            // The filtergraph is `;`-separated.
            let steps: Vec<&str> = fc.split(';').collect();
            for (step_idx, step) in steps.iter().enumerate() {
                if !step.contains("overlay=") {
                    continue;
                }
                // Every overlay call must pin its internal pixel format to
                // `yuv444p10` (the overlay enum value). Without it overlay
                // defaults to `yuv420` and auto-inserts a swscale that
                // downconverts yuva444p10le inputs to yuva420p before
                // compositing — silently dropping chroma to 4:2:0 even
                // when the lifts were correct.
                assert!(
                    step.contains(":format=yuv444p10"),
                    "mode={mode:?} mask={mask_arg:?}: overlay step missing `:format=yuv444p10` (defaults to yuv420 and subsamples chroma); step: `{step}`; fc: {fc}",
                );
                // Pull the two input labels: pattern `[A][B]overlay=...`.
                let lbr1 = step.find('[').unwrap();
                let rbr1 = step.find(']').unwrap();
                let label_a = &step[lbr1 + 1..rbr1];
                let rest = &step[rbr1 + 1..];
                let lbr2 = rest.find('[').unwrap();
                let rbr2 = rest.find(']').unwrap();
                let label_b = &rest[lbr2 + 1..rbr2];

                for label in [label_a, label_b] {
                    // Find the producer step for `label`.
                    let producer = steps[..step_idx]
                        .iter()
                        .rev()
                        .find(|s| s.contains(&format!("[{label}]")) && s.trim_end().ends_with(&format!("[{label}]")))
                        .unwrap_or_else(|| panic!(
                            "mode={mode:?} mask={mask_arg:?}: no producer found for overlay input `[{label}]` in fc: {fc}",
                        ));
                    // Valid producers: explicit yuva444p10le lift,
                    // alphamerge (which preserves the yuva444p10le pixel
                    // format of its first input), or a previous overlay
                    // whose inputs were themselves yuva-lifted (overlay
                    // preserves its first input's pixel format, so
                    // `[bg_a][map_a]overlay=...[bg_with_map]` produces
                    // a yuva444p10le `[bg_with_map]`).
                    let is_yuva_lift = producer.contains(&format!("format=yuva444p10le[{label}]"));
                    let is_alphamerge = producer.contains(&format!("alphamerge[{label}]"));
                    let is_overlay_of_lifted = producer.contains("overlay=")
                        && producer.trim_end().ends_with(&format!("[{label}]"));
                    assert!(
                        is_yuva_lift || is_alphamerge || is_overlay_of_lifted,
                        "mode={mode:?} mask={mask_arg:?}: overlay input `[{label}]` was not lifted to yuva444p10le; producer step: `{producer}`; fc: {fc}",
                    );
                    // If the producer is itself an overlay, recursively
                    // confirm that overlay's inputs were lifted (its
                    // first input is what determines the producer's
                    // pixel format).
                    if is_overlay_of_lifted && !is_yuva_lift && !is_alphamerge {
                        let p_lbr1 = producer.find('[').unwrap();
                        let p_rbr1 = producer.find(']').unwrap();
                        let p_label_a = &producer[p_lbr1 + 1..p_rbr1];
                        // The producer overlay's first input must itself
                        // have come from a yuva lift (we don't recurse
                        // past one level; this catches the common case).
                        let p_first_producer = steps[..step_idx]
                            .iter()
                            .find(|s| s.trim_end().ends_with(&format!("[{p_label_a}]")))
                            .unwrap_or_else(|| panic!(
                                "mode={mode:?} mask={mask_arg:?}: no producer found for nested overlay first input `[{p_label_a}]` in fc: {fc}",
                            ));
                        assert!(
                            p_first_producer.contains(&format!("format=yuva444p10le[{p_label_a}]"))
                                || p_first_producer.contains(&format!("alphamerge[{p_label_a}]")),
                            "mode={mode:?} mask={mask_arg:?}: nested overlay's first input `[{p_label_a}]` was not yuva-lifted; producer: `{p_first_producer}`; fc: {fc}",
                        );
                    }
                }
            }
        }
    }

    // -----------------------------------------------------------------
    // Phase 4 (HDR port) — composite anchor + headroom gating
    // -----------------------------------------------------------------

    /// The ×2.03 BT.2408 anchor chain (fix B), as `linear_gain_filter(2.03)`
    /// emits it — byte-pinned in `color_space::tests`.
    const ANCHOR_2_03: &str =
        "colorchannelmixer=rr=2:gg=2:bb=2,colorchannelmixer=rr=1.015:gg=1.015:bb=1.015";
    /// PQ transport encode (fix C′): linear→PQ before the 10-bit lift.
    const TRANSPORT_DOWN: &str = "zscale=t=smpte2084";
    /// PQ transport decode (fix C′): PQ→linear (npl=100) after the lift.
    const TRANSPORT_UP: &str = "zscale=tin=smpte2084:t=linear:npl=100";

    /// Every composite mode × mask combination the builder supports.
    /// (Split structurally has no mask.)
    fn all_composite_shapes() -> Vec<(CompositeMode, Option<&'static Path>)> {
        let mask: &'static Path = Path::new("/tmp/mask.png");
        vec![
            (CompositeMode::PipMapInset, None),
            (CompositeMode::PipMapInset, Some(mask)),
            (CompositeMode::PipVideoInset, None),
            (CompositeMode::PipVideoInset, Some(mask)),
            (CompositeMode::Split, None),
        ]
    }

    fn build_fc_for_target(
        mode: CompositeMode,
        mask: Option<&Path>,
        target: DeliveryTarget,
    ) -> String {
        let map_slot = PixelRect { x: 702, y: 1497, w: 346, h: 346 };
        let video_slot = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
        let output = OutputDimensions { w: 1080, h: 1920 };
        let inputs = vec![vc("a", 2000, true)];
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
            DEFAULT_AUDIO_KBPS,
            target,
            out_path(),
        )
        .unwrap();
        fc_of(&plan).to_string()
    }

    #[test]
    fn composite_hdr_delivery_anchors_sdr_origins_and_wraps_lifts_in_pq_transport() {
        // Fix B: SDR-origin streams (every clip here is SDR; the map always
        // is) carry the ×2.03 BT.2408 anchor at their ingest tails.
        // Fix C′: every COLOR-stream lift to yuva444p10le is preceded by the PQ
        // transport encode (linear→PQ) and the single post-overlay restore to
        // gbrpf32le is followed by the decode (PQ→linear, npl=100) — so the
        // anchored (>1.0) values cross the 10-bit integer grid PQ-coded, where
        // the bottom of the range keeps its precision (256/256 levels) instead
        // of being crushed into the bottom 6.3% by the retired ÷32 (66 levels).
        for target in [DeliveryTarget::HdrHlg, DeliveryTarget::HdrPq] {
            for (mode, mask) in all_composite_shapes() {
                let fc = build_fc_for_target(mode, mask, target);
                let label = format!("{target:?}/{mode:?}/mask={}", mask.is_some());

                // (B) clip subgraph anchored between ingest tail and format.
                assert!(
                    fc.contains(&format!(",{ANCHOR_2_03},format=gbrpf32le[v0]")),
                    "{label}: SDR clip must carry the ×2.03 anchor; fc: {fc}",
                );
                // (B) map ingest anchored (the [map] label ends with the gain).
                assert!(
                    fc.contains(&format!(",{ANCHOR_2_03}[map]")),
                    "{label}: map ingest must carry the ×2.03 anchor; fc: {fc}",
                );

                // (C′) EVERY yuva444p10le lift is preceded by the PQ encode —
                // the lift count and the encode count must match exactly.
                let lifts = fc.matches("format=yuva444p10le[").count();
                let guarded = fc
                    .matches(&format!("{TRANSPORT_DOWN},format=yuva444p10le["))
                    .count();
                assert!(lifts > 0, "{label}: expected yuva lifts; fc: {fc}");
                assert_eq!(
                    guarded, lifts,
                    "{label}: every color-stream lift must be PQ-encode-wrapped ({guarded}/{lifts}); fc: {fc}",
                );

                // (C′) restore followed by the PQ decode, feeding [vout_w].
                assert!(
                    fc.contains(&format!("format=gbrpf32le,{TRANSPORT_UP}[vout_w]")),
                    "{label}: post-overlay restore must apply the PQ decode before [vout_w]; fc: {fc}",
                );
                // The retired linear headroom must be entirely gone.
                assert!(
                    !fc.contains("colorchannelmixer=rr=0.03125"),
                    "{label}: fix-C ÷32 headroom must be gone; fc: {fc}",
                );

                // (D) HDR finishing carries the HQ chroma subsample split.
                assert!(
                    fc.contains("format=yuv444p10le,scale=flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp,format=yuv420p10le"),
                    "{label}: HDR finishing must use the HQ chroma split; fc: {fc}",
                );

                // The gray corner mask is alpha, not color — never transported.
                if mask.is_some() {
                    assert!(
                        !fc.contains(&format!("{TRANSPORT_DOWN},format=gray")),
                        "{label}: the mask must NOT be PQ-transported; fc: {fc}",
                    );
                }
            }
        }
    }

    #[test]
    fn composite_sdr_delivery_emits_no_anchor_and_no_transport() {
        // SDR delivery gate: anchor and PQ transport are both HDR-delivery-only.
        // No colorchannelmixer (anchor/old headroom) AND no composite PQ
        // transport may appear anywhere — the composite chain is byte-identical
        // to pre-Phase-4 (the existing SDR composite tests pin the exact
        // strings; this is the explicit negative guard).
        for target in [DeliveryTarget::SdrH264, DeliveryTarget::SdrH265, DeliveryTarget::Prores] {
            for (mode, mask) in all_composite_shapes() {
                let fc = build_fc_for_target(mode, mask, target);
                let label = format!("{target:?}/{mode:?}/mask={}", mask.is_some());
                assert!(
                    !fc.contains("colorchannelmixer"),
                    "{label}: SDR/ProRes delivery must not gain-scale; fc: {fc}",
                );
                // The composite PQ transport (fix C′) is the linear→PQ encode
                // wrapped around the overlay lift; it must never appear on SDR.
                // (Per-clip SDR ingest legitimately contains other zscale hops,
                // but never the `zscale=t=smpte2084,format=yuva444p10le` seam.)
                assert!(
                    !fc.contains("zscale=t=smpte2084,format=yuva444p10le"),
                    "{label}: SDR/ProRes delivery must not PQ-transport the lift; fc: {fc}",
                );
                assert!(
                    !fc.contains("zscale=tin=smpte2084:t=linear:npl=100"),
                    "{label}: SDR/ProRes delivery must not PQ-decode the lift; fc: {fc}",
                );
            }
        }
    }
}
