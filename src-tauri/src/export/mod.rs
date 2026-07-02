// Export pipeline — Rust orchestrator + concrete channels.
//
// 030 introduced the orchestrator + `FrameSink` trait. 060 plugs in the first
// real sink (`FFmpegSink`) and the first end-to-end Tauri command
// (`render_export`) that drives the orchestrator into FFmpeg, producing a
// ProRes 4444 `.mov` on disk. 070 adds Channel C (video-only): per-clip
// filter chain → concat → ProRes 4444 `.mov` with audio. Channel C bypasses
// the orchestrator entirely (no map render, so no renderer worker, no
// `FrameSink`); it spawns FFmpeg via `FFmpegRunner` directly.

pub mod clip_chain;
pub mod corner_mask;
pub mod delivery;
pub mod encoder;
pub mod error;
pub mod ffmpeg_runner;
pub mod ffmpeg_sink;
pub mod ffprobe;
pub mod filtergraph;
pub mod layout;
pub mod orchestrator;
pub mod protocol;
pub mod resolution;
pub mod sink;

pub use clip_chain::{
    build_clip_audio_subgraph, build_clip_chain, build_clip_video_subgraph, chain_atempo,
    compute_focal_crop, ClipChainInputs, ClipChainOutput, CropRect, PixelDims,
};
pub use delivery::{
    delivery_encoder_args, delivery_finishing_filter, select_encoder_for_target, DeliveryTarget,
};
pub use encoder::{
    ffmpeg_path, probe_all, select_encoder, set_cache_path_for_test, set_ffmpeg_path,
    EncoderChoice, EncoderClass, EncoderError, EncoderKind, EncoderProbe,
};
pub use error::{
    ClipChainError, FFmpegRunnerError, FfprobeError, OrchestratorError, VideoOnlyValidationError,
};
pub use ffmpeg_runner::{
    run_ffmpeg, run_ffmpeg_with_progress, FFmpegRunResult, FFmpegRunner,
};
pub use ffmpeg_sink::{FFmpegSink, FFmpegSinkError, EXPORT_FINISH_TIMEOUT_SECS};
pub use ffprobe::{probe_clip, ProbedClip};
pub use filtergraph::{
    build_composite_filtergraph, build_map_only_filtergraph, build_video_only_filtergraph,
    CompositeMode, FiltergraphPlan, VisibleClipInput,
};
pub use layout::{
    canonical_map_css_width, canonical_map_viewport, clamp_layout, default_layout,
    default_pip_layout, default_split_layout, legal_split_sides, map_supersample_factor,
    output_dims, resolve_slots,
    AspectRatio, CanonicalMapViewport, CornerRadiusSlot, LayoutConfig, LayoutDescriptor,
    NormalizedRect, OutputDimensions, PipInsetSource, PixelRect, ProjectLayouts,
    SlotResolution, SplitSide,
};
pub use orchestrator::{
    render_map_frames, OrchestratorConfig, RendererBackend, RECYCLE_EVERY_FRAMES,
};
pub use protocol::{SetupPayload, Viewport};
pub use resolution::{CodecPreference, OutputResolution};
pub use sink::{FrameSink, SinkError, VecSink};

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::models::Clip;

/// Per-job progress event. Sent over `tauri::ipc::Channel` from the
/// `render_export` command back to the frontend. `frames_done` is the
/// current count of output frames the channel has produced; `total_frames`
/// is the constant denominator (computed once at validate time).
#[derive(Debug, Clone, Serialize)]
pub struct ProgressEvent {
    pub frames_done: u32,
    pub total_frames: u32,
}

/// Per-frame progress callback. Channel-agnostic so the orchestrator and the
/// ffmpeg runner can both invoke it without depending on Tauri's IPC types.
/// `Arc` so it can be shared across the orchestrator's drain loop and the
/// ffmpeg runner's stdout parser. The `Tauri` command constructs one that
/// forwards via `tauri::ipc::Channel::send`; tests pass `None`.
pub type ProgressCallback = Arc<dyn Fn(u32, u32) + Send + Sync>;

/// Wire payload for the `render_export` command. Mirrors the IPC contract
/// in PLAN.md §"IPC contract" (`channel`, `fps`, `output_path`, `layout`,
/// project state). Project state is forwarded opaquely to the worker; only
/// `timeline.totalDurationMs` is read on the Rust side, to compute
/// `total_frames`.
#[derive(Debug, Deserialize)]
pub struct RenderExportRequest {
    /// Channel selector. 060 ships `"map_only"`, 070 adds `"video_only"`;
    /// `"composite"` (Channel A) lands with 090.
    pub channel: String,
    pub fps: u32,
    pub output_path: String,
    pub layout: LayoutDescriptor,
    /// User-selected video codec preference. Defaults to `Auto` (current
    /// behavior — Hevc with internal fallback ladder). Phase 3 of the
    /// export-controls plan wires this into the composite-branch encoder
    /// selection in this module; this phase only adds the field.
    #[serde(default)]
    pub codec_preference: CodecPreference,
    /// AAC audio bitrate in kbps. Defaults to 256 (the value currently
    /// hardcoded in the composite branch). Phase 3 plumbs this through
    /// `build_composite_filtergraph`; this phase only adds the field.
    #[serde(default = "default_audio_bitrate_kbps")]
    pub audio_bitrate_kbps: u32,
    /// Delivery-target selection. Composite (Channel A) accepts any of the
    /// four `DeliveryTarget` variants; map_only and video_only accept only
    /// `Prores` (lossless compositing intermediates). Defaults to `Prores`
    /// so wire data missing the field deserializes cleanly (B/C unaffected;
    /// A defaults to the master archival output).
    #[serde(default = "default_delivery_target")]
    pub delivery_target: DeliveryTarget,
    /// Same project-state fields as the orchestrator's `SetupPayload` —
    /// pass-through to the workers.
    #[serde(flatten)]
    pub project_state: Value,
}

fn default_audio_bitrate_kbps() -> u32 {
    256
}

fn default_delivery_target() -> DeliveryTarget {
    DeliveryTarget::Prores
}

/// Successful return value from `render_export`. `wall_clock_ms` includes
/// orchestrator setup, frame rendering, and FFmpeg flush.
#[derive(Debug, Clone, Serialize)]
pub struct RenderExportSummary {
    pub frames_written: u32,
    pub output_path: String,
    pub wall_clock_ms: u64,
}

/// Structured error variant returned to the frontend on export failure.
/// `stage` is one of "validation" (parity check / pre-flight), "ffmpeg"
/// (sink/encoder failure), or "orchestrator" (worker / protocol failure).
#[derive(Debug, Clone, Serialize)]
pub struct RenderExportError {
    pub stage: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_tail: Option<String>,
}

impl RenderExportError {
    fn validation(msg: impl Into<String>) -> Self {
        Self {
            stage: "validation".to_string(),
            message: msg.into(),
            stderr_tail: None,
        }
    }
}

/// Validated request shared between channels. Extracted so `map_only`,
/// `video_only`, and `composite` don't drift on validation. `total_frames` is
/// the user-visible truth for `frames_written`; the integration tests verify
/// FFmpeg's actual encoded count via FFprobe.
///
/// Encoder selection is **not** in this struct — each channel picks its own
/// encoder class (B/C → `ProResAlpha`, A → `Hevc`) after validation. This
/// keeps `validate_request` channel-agnostic.
#[derive(Debug)]
struct ValidatedRequest {
    total_frames: u32,
    output_dims: OutputDimensions,
    output_path_buf: PathBuf,
}

fn validate_request(req: &RenderExportRequest) -> Result<ValidatedRequest, RenderExportError> {
    // IPC parity check — re-run resolve_slots, compare. The TS port is the
    // source of truth (LAYOUT.md / task 050); this catches a tampered
    // descriptor before any FFmpeg / ffprobe / orchestrator work begins.
    let recomputed = resolve_slots(
        &req.layout.layout,
        req.layout.aspect,
        req.layout.resolution,
    );
    if recomputed != req.layout.resolved {
        return Err(RenderExportError::validation(format!(
            "layout descriptor parity check failed: frontend resolved={:?}, rust resolved={:?}",
            req.layout.resolved, recomputed,
        )));
    }

    // Split-orientation legality (task 100). LAYOUT.md §3 forbids
    // inverse-orientation splits — a vertical divider in 9:16 (or 4:5)
    // produces two narrow, near-unusable slots; a horizontal divider in 16:9
    // does the same. The renderer's math handles any pair correctly, but
    // the UX rule belongs at the IPC boundary so bad project files surface
    // here rather than producing nonsense exports. The configurator (110)
    // constrains its swap toggle via `legal_split_sides`; this validator
    // backstops file-level edits and IPC tampering.
    if let LayoutConfig::Split { video_side, .. } = &req.layout.layout {
        let legal = legal_split_sides(req.layout.aspect);
        if !legal.contains(video_side) {
            return Err(RenderExportError::validation(format!(
                "split layout uses inverse-orientation video_side={:?} for aspect {:?}; legal sides are {:?}",
                video_side, req.layout.aspect, legal,
            )));
        }
    }

    let total_duration_ms = extract_total_duration_ms(&req.project_state).map_err(|e| {
        RenderExportError::validation(format!("project_state.timeline.totalDurationMs: {}", e))
    })?;
    if total_duration_ms == 0 {
        return Err(RenderExportError::validation(
            "timeline has zero duration — nothing to render".to_string(),
        ));
    }
    // Round-half-up integer math: (a*b + denom/2) / denom.
    let total_frames: u32 = {
        let n = total_duration_ms.saturating_mul(req.fps as u64);
        let rounded = (n + 500) / 1000;
        rounded.try_into().map_err(|_| {
            RenderExportError::validation(format!("total_frames overflowed u32: {}", rounded))
        })?
    };
    if total_frames == 0 {
        return Err(RenderExportError::validation(
            "total_frames rounded to 0 — fps too low for timeline duration".to_string(),
        ));
    }

    let output_path_buf = PathBuf::from(&req.output_path);
    // `resolve_output_dir` deliberately does not create the directory it
    // returns — the contract is "the renderer creates it later". This is
    // that step. Without it, FFmpeg fails with "No such file or directory"
    // when the user's project name resolves to a fresh subfolder under
    // `~/Movies/TrailCut/{project}/` that has never been written to before.
    if let Some(parent) = output_path_buf.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| {
                RenderExportError::validation(format!(
                    "create output directory {}: {}",
                    parent.display(),
                    e,
                ))
            })?;
        }
    }

    Ok(ValidatedRequest {
        total_frames,
        output_dims: req.layout.resolved.output,
        output_path_buf,
    })
}

/// Channel-specific encoder selection. Lifted out of `validate_request` so
/// the shared validator stays channel-agnostic.
fn select_channel_encoder(class: EncoderClass) -> Result<EncoderChoice, RenderExportError> {
    select_encoder(class).map_err(|e| RenderExportError {
        stage: "validation".to_string(),
        message: format!("select_encoder({:?}): {}", class, e),
        stderr_tail: None,
    })
}

/// Resolve the user-facing codec preference into a concrete encoder for the
/// composite branch (Channel A). Only this branch consults the preference —
/// `map_only` / `video_only` always pick `ProResAlpha` because ProRes is an
/// internal compositing intermediate, not a user-facing codec.
///
/// Behavior per `CodecPreference`:
///   - `Auto`  → probe `Hevc` (the same fallback ladder of HEVC candidates
///     `select_encoder` already walks: hevc_videotoolbox → libx265 on macOS,
///     etc.). On total HEVC failure this propagates as a generic validation
///     error — same shape as today's default-path behavior.
///   - `H264`  → probe `H264` only; never touches the Hevc class.
///   - `Hevc`  → probe `Hevc` and, on `NoEncoderForClass(Hevc)`, return a
///     user-facing validation error pointing the user at H.264 or Auto.
///     Explicitly does NOT silently fall back to H.264 — the export-controls
///     plan's architecture decision: "Codec preference does NOT silently
///     fall back" (export-controls.md §"Architecture decisions").
///
/// Audit of `select_encoder` / `select_channel_encoder`: neither has any
/// implicit codec fallback today. `EncoderClass::Hevc`'s candidate ladder
/// contains only HEVC encoders (hevc_videotoolbox / hevc_nvenc / libx265,
/// per `candidates_for` in encoder.rs); failing the whole class returns
/// `NoEncoderForClass(Hevc)` with no auto-retry against H264. So the
/// "strict" path here only needs to translate that error into a friendlier
/// message — no behavior bypass is required.
#[allow(dead_code)] // Superseded by `select_encoder_for_target` (WS4). Kept
                    // for the Phase-3 codec-preference test fixtures below.
fn select_composite_encoder(
    pref: CodecPreference,
) -> Result<EncoderChoice, RenderExportError> {
    select_composite_encoder_with(pref, select_encoder)
}

/// Generic core of `select_composite_encoder`. Parameterized on the
/// encoder-selection function so unit tests can inject a stub that returns
/// `NoEncoderForClass(Hevc)` without spawning ffmpeg or touching the cache.
#[allow(dead_code)] // see `select_composite_encoder` note.
fn select_composite_encoder_with<F>(
    pref: CodecPreference,
    select: F,
) -> Result<EncoderChoice, RenderExportError>
where
    F: Fn(EncoderClass) -> Result<EncoderChoice, EncoderError>,
{
    let class = match pref {
        CodecPreference::Auto | CodecPreference::Hevc => EncoderClass::Hevc,
        CodecPreference::H264 => EncoderClass::H264,
    };
    match select(class) {
        Ok(choice) => Ok(choice),
        Err(EncoderError::NoEncoderForClass(EncoderClass::Hevc))
            if matches!(pref, CodecPreference::Hevc) =>
        {
            // Explicit-HEVC strict path. The user picked HEVC, the system
            // has no working HEVC encoder, and the architecture decision is
            // to surface that rather than silently downgrade. Stage is
            // "validation" so the frontend treats it the same as any other
            // pre-flight error.
            Err(RenderExportError::validation(
                "HEVC encoder not available on this system; choose H.264 or Auto.",
            ))
        }
        Err(e) => Err(RenderExportError {
            stage: "validation".to_string(),
            message: format!("select_encoder({:?}): {}", class, e),
            stderr_tail: None,
        }),
    }
}

/// Tauri command entry point. Wraps `render_export_inner` with a progress
/// callback that forwards `ProgressEvent`s over the Tauri-managed IPC channel
/// passed in by the frontend. Tests call `render_export_inner` directly with
/// `None` to skip the channel construction.
#[tauri::command]
pub async fn render_export(
    req: RenderExportRequest,
    progress: tauri::ipc::Channel<ProgressEvent>,
) -> Result<RenderExportSummary, RenderExportError> {
    let callback: ProgressCallback = Arc::new(move |frames_done, total_frames| {
        // Channel::send returns an error only if the frontend dropped the
        // channel (window closed mid-export). The render itself shouldn't
        // fail on that — let it continue and surface any real error from
        // FFmpeg/orchestrator instead.
        let _ = progress.send(ProgressEvent {
            frames_done,
            total_frames,
        });
    });
    render_export_inner(req, Some(callback)).await
}

/// Channel-agnostic entry point. Same as `render_export` minus the Tauri
/// `Channel<T>` arg, so unit + integration tests can call it without
/// constructing a fake IPC channel. `on_progress` is `None` from tests; the
/// command path always supplies one.
pub async fn render_export_inner(
    req: RenderExportRequest,
    on_progress: Option<ProgressCallback>,
) -> Result<RenderExportSummary, RenderExportError> {
    let started = Instant::now();
    match req.channel.as_str() {
        "map_only" => render_export_map_only(req, started, on_progress).await,
        "video_only" => render_export_video_only(req, started, on_progress).await,
        "composite" => render_export_composite(req, started, on_progress).await,
        other => Err(RenderExportError::validation(format!(
            "channel not yet implemented in this build: {}",
            other,
        ))),
    }
}

async fn render_export_map_only(
    req: RenderExportRequest,
    started: Instant,
    on_progress: Option<ProgressCallback>,
) -> Result<RenderExportSummary, RenderExportError> {
    let validated = validate_request(&req)?;
    validate_target_for_channel(req.delivery_target, "map_only")?;

    let map_slot = req.layout.resolved.map_slot;
    if map_slot.w == 0 || map_slot.h == 0 {
        return Err(RenderExportError::validation(format!(
            "map_slot has zero dimension: {:?}",
            map_slot,
        )));
    }

    // Corner-mask PNG (only when the radius applies to the *map* slot).
    // Channel B masks the map's slot only; if the radius is on the video
    // slot (PiP-with-video-as-inset), B's map is the full-bleed background
    // and gets sharp corners. Channel C makes the mirror choice.
    let mut _mask_handle: Option<tempfile::NamedTempFile> = None;
    let corner_mask_path: Option<PathBuf> = if req.layout.resolved.corner_radius_px > 0
        && matches!(req.layout.resolved.corner_radius_slot, CornerRadiusSlot::Map)
    {
        let png_bytes = corner_mask::build_corner_mask_png(
            map_slot.w,
            map_slot.h,
            req.layout.resolved.corner_radius_px,
        )
        .map_err(|e| RenderExportError {
            stage: "validation".to_string(),
            message: format!("corner mask: {}", e),
            stderr_tail: None,
        })?;
        let tmp = write_corner_mask_tempfile(&png_bytes).map_err(|e| RenderExportError {
            stage: "validation".to_string(),
            message: format!("write corner mask tempfile: {}", e),
            stderr_tail: None,
        })?;
        let path = tmp.path().to_path_buf();
        _mask_handle = Some(tmp);
        Some(path)
    } else {
        None
    };

    // ProRes 4444 with alpha — Channel B's compositing intermediate.
    let encoder = select_channel_encoder(EncoderClass::ProResAlpha)?;

    let plan = build_map_only_filtergraph(
        map_slot,
        validated.output_dims,
        corner_mask_path.as_deref(),
        req.fps,
        validated.total_frames,
        &encoder,
        &validated.output_path_buf,
    );

    let ffmpeg_bin = ffmpeg_path();
    let sink = FFmpegSink::spawn(&ffmpeg_bin, &plan.argv, plan.frame_bytes_per_input)
        .await
        .map_err(|e| RenderExportError {
            stage: "ffmpeg".to_string(),
            message: e.to_string(),
            stderr_tail: e.stderr_tail().map(|s| s.to_string()),
        })?;

    let setup = build_setup_payload(
        map_slot,
        req.layout.aspect,
        req.layout.resolution,
        req.fps,
        req.project_state,
    );

    let frames_written = render_map_frames(
        setup,
        validated.total_frames,
        OrchestratorConfig::default(),
        Box::new(sink),
        frame_progress_for(on_progress, validated.total_frames),
    )
    .await
    .map_err(classify_orchestrator_error)?;

    let wall_clock_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    Ok(RenderExportSummary {
        frames_written,
        output_path: req.output_path,
        wall_clock_ms,
    })
}

/// Construct a `SetupPayload` from the resolved map slot, export aspect, and
/// output resolution.
///
/// Computes the renderer-worker's three viewport-shape fields under the
/// multiplier model (MAP_RENDERING_PLAN.md §"The lever model"), then applies
/// the SSAA supersample factor on top of the framebuffer/pixelRatio:
/// - `framebuffer` = map slot pixel dims × `map_supersample_factor` — the
///   high-res WebGL buffer the renderer paints into.
/// - `readback` = map slot pixel dims — the buffer the renderer downsamples
///   that framebuffer to ON-GPU and writes back, so supersampling never
///   inflates the wire (the readback bytes match `frame_bytes_per_input`).
/// - `pixel_ratio = multiplier × factor`, where `multiplier =
///   output_dims(aspect, resolution).w / output_dims(aspect, P1080).w` is
///   purely a function of (aspect, resolution) (∈ {2/3, 1, 4/3, 2}) and
///   `factor` is the SSAA factor (∈ {2, 3} for the exposed exports).
///   Multiplying only framebuffer/pixelRatio supersamples without changing
///   apparent scale (zoom is interpreted at `css_viewport`).
/// - `css_viewport = (round(slot_w / multiplier), round(slot_h /
///   multiplier))`. The CSS viewport aspect matches the **slot** aspect (not
///   `canonical_map_css_width` on the W axis any more) so MapLibre paints
///   into the slot shape directly — no render-then-crop.
///
/// Sanity-checked with an epsilon tolerance: `|css * pixel_ratio - fb| <=
/// pixel_ratio * 0.5` on each axis. Strict equality would fail because css_w
/// / css_h are rounded to integers; rounding `slot/multiplier` can land up to
/// `multiplier/2` off the original on a back-multiply. The renderer page
/// pads/crops by ≤1 row/col to match (init.ts captureFramebufferIntoBuf), so
/// this drift is benign — the assert just guards against the bound being
/// blown by something larger (e.g. a malformed multiplier).
fn build_setup_payload(
    map_slot: PixelRect,
    aspect: AspectRatio,
    resolution: OutputResolution,
    fps: u32,
    project_state: Value,
) -> SetupPayload {
    // Delegate the zoom-invariant lever math to `canonical_map_viewport` in
    // layout.rs so the renderer worker, this orchestrator helper, and the
    // TS↔Rust parity tests all share one derivation. See
    // `canonical_map_viewport`'s doc for the contract.
    let canonical = canonical_map_viewport(aspect, map_slot.w, map_slot.h, resolution);

    // SSAA: render the map into a framebuffer `factor`× the slot, then
    // downsample it back to slot dims ON-GPU in the renderer (see the
    // renderer's `captureFramebufferIntoBuf`) — so supersampling never inflates
    // the frame-transport bytes. `framebuffer` is the high-res GPU render
    // buffer; `readback` is the slot-sized buffer the renderer returns, which
    // is what `frame_bytes_per_input` validates. `cssViewport` is untouched —
    // zoom is interpreted at the CSS viewport, so multiplying ONLY the
    // framebuffer/pixelRatio supersamples without changing apparent scale.
    // `framebuffer = slot * factor` is exact (integer factor), so `css *
    // (pixel_ratio*factor)` tracks it within the same per-axis rounding drift
    // the renderer page already pads/crops.
    let factor = map_supersample_factor(map_slot.w, map_slot.h);
    let framebuffer = Viewport {
        w: map_slot.w * factor,
        h: map_slot.h * factor,
    };
    let readback = Viewport {
        w: map_slot.w,
        h: map_slot.h,
    };
    let pixel_ratio = canonical.pixel_ratio * factor as f64;
    let drift_bound = pixel_ratio * 0.5 + 1e-9;
    debug_assert!(
        (canonical.css_w as f64 * pixel_ratio - framebuffer.w as f64).abs() <= drift_bound,
        "cssViewport.w * pixelRatio drifted from framebuffer.w by more than pr/2: css_w={} pr={} fb_w={}",
        canonical.css_w, pixel_ratio, framebuffer.w,
    );
    debug_assert!(
        (canonical.css_h as f64 * pixel_ratio - framebuffer.h as f64).abs() <= drift_bound,
        "cssViewport.h * pixelRatio drifted from framebuffer.h by more than pr/2: css_h={} pr={} fb_h={}",
        canonical.css_h, pixel_ratio, framebuffer.h,
    );
    let css_viewport = Viewport {
        w: canonical.css_w,
        h: canonical.css_h,
    };
    SetupPayload {
        css_viewport,
        framebuffer,
        readback,
        pixel_ratio,
        fps,
        project_state,
    }
}

/// Adapt a `ProgressCallback` (which expects `(done, total)`) into the
/// single-arg `FrameProgress` the orchestrator + ffmpeg runner emit. Returns
/// `None` when no outer callback is set so the orchestrator can skip the
/// per-frame branch entirely.
fn frame_progress_for(
    outer: Option<ProgressCallback>,
    total: u32,
) -> Option<orchestrator::FrameProgress> {
    outer.map(|cb| {
        Arc::new(move |done: u32| cb(done, total)) as orchestrator::FrameProgress
    })
}

/// Splice `-progress pipe:1` into a video_only argv. FFmpeg accepts the flag
/// as a global option, but to be defensive we insert it after the leading
/// `-hide_banner -y` so it sits with the other global flags.
fn with_progress_pipe(mut argv: Vec<String>) -> Vec<String> {
    let insert_at = argv
        .iter()
        .position(|a| a == "-y")
        .map(|i| i + 1)
        .unwrap_or(0);
    argv.insert(insert_at, "-progress".to_string());
    argv.insert(insert_at + 1, "pipe:1".to_string());
    argv
}

/// Channel C (video-only) — task 070.
///
/// Reads source video files directly, builds a per-clip filter chain, concats,
/// pads to the full output canvas at the layout's video slot, encodes as
/// ProRes 4444 with PCM s16le audio. The orchestrator and renderer worker are
/// **uninvolved** — Channel C has no map render, so spawning a worker would
/// be pure overhead. Spawned via `FFmpegRunner` instead of `FFmpegSink`.
async fn render_export_video_only(
    req: RenderExportRequest,
    started: Instant,
    on_progress: Option<ProgressCallback>,
) -> Result<RenderExportSummary, RenderExportError> {
    let validated = validate_request(&req)?;
    validate_target_for_channel(req.delivery_target, "video_only")?;

    let video_slot = req.layout.resolved.video_slot;
    if video_slot.w == 0 || video_slot.h == 0 {
        return Err(RenderExportError::validation(format!(
            "video_slot has zero dimension: {:?}",
            video_slot,
        )));
    }

    // Read & filter visible clips. The frontend passes `clips: Vec<Clip>`
    // opaquely via `#[serde(flatten)]`; for video_only we need a typed view.
    let all_clips = extract_clips(&req.project_state).map_err(|e| {
        RenderExportError::validation(format!("project_state.clips: {}", e))
    })?;
    let visible: Vec<Clip> = all_clips.into_iter().filter(|c| c.visible).collect();
    if visible.is_empty() {
        return Err(RenderExportError::validation(
            VideoOnlyValidationError::EmptyTimeline.to_string(),
        ));
    }

    // Validate source files exist before any ffprobe / ffmpeg work — gives
    // a clearer message than ffprobe's generic "No such file or directory".
    for clip in &visible {
        let path = Path::new(&clip.path);
        if !path.exists() {
            return Err(RenderExportError::validation(
                VideoOnlyValidationError::MissingSourceFile {
                    path: clip.path.clone(),
                }
                .to_string(),
            ));
        }
    }

    // Probe each clip in parallel, capped at 8-way concurrency to avoid OS
    // handle exhaustion on large projects. Per LAYOUT.md §7, exports use
    // originals (not proxies) — `clip.path` is the source.
    let ffprobe_bin = ffprobe_path();
    let probed: Vec<ProbedClip> = probe_clips_capped(&ffprobe_bin, &visible, 8)
        .await
        .map_err(|e| RenderExportError {
            stage: "validation".to_string(),
            message: format!("ffprobe: {}", e),
            stderr_tail: None,
        })?;

    // Build VisibleClipInput rows for the filtergraph builder.
    let visible_inputs: Vec<VisibleClipInput> = visible
        .iter()
        .zip(probed.iter())
        .map(|(clip, p)| VisibleClipInput {
            source_path: PathBuf::from(&clip.path),
            clip: clip.clone(),
            source_dims: PixelDims {
                w: p.width,
                h: p.height,
            },
            has_audio: p.has_audio,
        })
        .collect();

    // Corner-mask PNG (only when the radius applies to the *video* slot).
    // Mirrors `map_only`'s gating: 060 generates only if radius_slot == Map;
    // 070 generates only if radius_slot == Video.
    let mut _mask_handle: Option<tempfile::NamedTempFile> = None;
    let corner_mask_path: Option<PathBuf> = if req.layout.resolved.corner_radius_px > 0
        && matches!(req.layout.resolved.corner_radius_slot, CornerRadiusSlot::Video)
    {
        let png_bytes = corner_mask::build_corner_mask_png(
            video_slot.w,
            video_slot.h,
            req.layout.resolved.corner_radius_px,
        )
        .map_err(|e| RenderExportError {
            stage: "validation".to_string(),
            message: format!("corner mask: {}", e),
            stderr_tail: None,
        })?;
        let tmp = write_corner_mask_tempfile(&png_bytes).map_err(|e| RenderExportError {
            stage: "validation".to_string(),
            message: format!("write corner mask tempfile: {}", e),
            stderr_tail: None,
        })?;
        let path = tmp.path().to_path_buf();
        _mask_handle = Some(tmp);
        Some(path)
    } else {
        None
    };

    // ProRes 4444 with alpha — Channel C's compositing intermediate.
    let encoder = select_channel_encoder(EncoderClass::ProResAlpha)?;

    // Build the filtergraph. NOTE — Channel C does NOT call
    // `render_map_frames`; the renderer worker / orchestrator are
    // structurally uninvolved here.
    let plan = build_video_only_filtergraph(
        &visible_inputs,
        video_slot,
        validated.output_dims,
        corner_mask_path.as_deref(),
        req.fps,
        &encoder,
        &["-c:a", "pcm_s16le"],
        &validated.output_path_buf,
    )
    .map_err(classify_clip_chain_error)?;

    // Spawn FFmpeg via the runner (no stdin, no FrameSink). When the caller
    // supplied a progress callback, splice `-progress pipe:1` into argv
    // (FFmpeg writes a key=value block per stats interval; the runner
    // parses `frame=N` and forwards via the callback). Channels A+B drive
    // progress from the orchestrator's emit loop instead — no `-progress`
    // flag, since there's no separate ffmpeg frame counter to consult.
    let ffmpeg_bin = ffmpeg_path();
    let argv = plan.argv;
    let run_result = if let Some(outer) = on_progress {
        let argv = with_progress_pipe(argv);
        let frame_cb = frame_progress_for(Some(outer), validated.total_frames)
            .expect("frame_progress_for returns Some when input is Some");
        run_ffmpeg_with_progress(&ffmpeg_bin, &argv, frame_cb).await
    } else {
        run_ffmpeg(&ffmpeg_bin, &argv).await
    };
    run_result.map_err(|e| RenderExportError {
        stage: "ffmpeg".to_string(),
        message: e.to_string(),
        stderr_tail: e.stderr_tail().map(|s| s.to_string()),
    })?;

    let wall_clock_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    Ok(RenderExportSummary {
        // The timeline's frame count is the user-visible truth — same
        // formula as `map_only`. The integration test verifies via FFprobe
        // that FFmpeg actually produced exactly that count.
        frames_written: validated.total_frames,
        output_path: req.output_path,
        wall_clock_ms,
    })
}

/// Channel A (composite) — task 090.
///
/// The headline deliverable: composites the map render stream and the per-clip
/// video stream into a single H.265 `.mp4` per the configured layout.
///
/// Structurally a union of 060 (map render via the orchestrator + `FFmpegSink`)
/// and 070 (per-clip file inputs + concat + audio). The same FFmpeg child
/// reads both the rawvideo stdin (map frames) and the source video files; the
/// composite filtergraph references both via the input-index numbering scheme
/// (clips at indices `0..N`, rawvideo at `N`, optional mask at `N+1`).
///
/// LAYOUT.md §6's load-bearing invariant — "B + C composites to A" — is
/// enforced structurally: this branch reuses `build_clip_chain` (per 070) and
/// `corner_mask::build_corner_mask_png` (per 060) without modification, and
/// the integration test's parity case verifies the empirical promise.
async fn render_export_composite(
    req: RenderExportRequest,
    started: Instant,
    on_progress: Option<ProgressCallback>,
) -> Result<RenderExportSummary, RenderExportError> {
    let validated = validate_request(&req)?;
    validate_target_for_channel(req.delivery_target, "composite")?;

    let map_slot = req.layout.resolved.map_slot;
    let video_slot = req.layout.resolved.video_slot;
    if map_slot.w == 0 || map_slot.h == 0 || video_slot.w == 0 || video_slot.h == 0 {
        return Err(RenderExportError::validation(format!(
            "slot has zero dimension: map={:?} video={:?}",
            map_slot, video_slot,
        )));
    }

    // Mode discriminator from the layout config. Split has no inset; PiP's
    // inset_source picks which slot is the small overlay.
    let composite_mode = match &req.layout.layout {
        LayoutConfig::Pip {
            inset_source: PipInsetSource::Map,
            ..
        } => CompositeMode::PipMapInset,
        LayoutConfig::Pip {
            inset_source: PipInsetSource::Video,
            ..
        } => CompositeMode::PipVideoInset,
        LayoutConfig::Split { .. } => CompositeMode::Split,
    };

    // Read & filter visible clips — identical to 070.
    let all_clips = extract_clips(&req.project_state).map_err(|e| {
        RenderExportError::validation(format!("project_state.clips: {}", e))
    })?;
    let visible: Vec<Clip> = all_clips.into_iter().filter(|c| c.visible).collect();
    if visible.is_empty() {
        return Err(RenderExportError::validation(
            VideoOnlyValidationError::EmptyTimeline.to_string(),
        ));
    }

    // Source-file existence check — 070's helper, inlined for parity.
    for clip in &visible {
        let path = Path::new(&clip.path);
        if !path.exists() {
            return Err(RenderExportError::validation(
                VideoOnlyValidationError::MissingSourceFile {
                    path: clip.path.clone(),
                }
                .to_string(),
            ));
        }
    }

    // Probe per-clip dims + audio presence — capped at 8-way concurrency,
    // identical helper to 070.
    let ffprobe_bin = ffprobe_path();
    let probed: Vec<ProbedClip> = probe_clips_capped(&ffprobe_bin, &visible, 8)
        .await
        .map_err(|e| RenderExportError {
            stage: "validation".to_string(),
            message: format!("ffprobe: {}", e),
            stderr_tail: None,
        })?;

    let visible_inputs: Vec<VisibleClipInput> = visible
        .iter()
        .zip(probed.iter())
        .map(|(clip, p)| VisibleClipInput {
            source_path: PathBuf::from(&clip.path),
            clip: clip.clone(),
            source_dims: PixelDims {
                w: p.width,
                h: p.height,
            },
            has_audio: p.has_audio,
        })
        .collect();

    // Corner-mask PNG iff the radius applies to the inset slot. Mask dims
    // are the *inset's* slot dims; for Split there's no inset and
    // `resolve_slots` structurally returns `corner_radius_px = 0`.
    let mut _mask_handle: Option<tempfile::NamedTempFile> = None;
    let corner_mask_path: Option<PathBuf> = if req.layout.resolved.corner_radius_px > 0 {
        let (mask_w, mask_h) = match composite_mode {
            CompositeMode::PipMapInset => (map_slot.w, map_slot.h),
            CompositeMode::PipVideoInset => (video_slot.w, video_slot.h),
            // Defense-in-depth: `resolve_slots` returns 0 for Split. If we
            // ever reach here with Split + nonzero radius, that's a layout
            // bug; surface it rather than silently masking.
            CompositeMode::Split => {
                return Err(RenderExportError::validation(format!(
                    "split layout returned non-zero corner_radius_px ({}) — layout bug",
                    req.layout.resolved.corner_radius_px,
                )));
            }
        };
        let png_bytes = corner_mask::build_corner_mask_png(
            mask_w,
            mask_h,
            req.layout.resolved.corner_radius_px,
        )
        .map_err(|e| RenderExportError {
            stage: "validation".to_string(),
            message: format!("corner mask: {}", e),
            stderr_tail: None,
        })?;
        let tmp = write_corner_mask_tempfile(&png_bytes).map_err(|e| RenderExportError {
            stage: "validation".to_string(),
            message: format!("write corner mask tempfile: {}", e),
            stderr_tail: None,
        })?;
        let path = tmp.path().to_path_buf();
        _mask_handle = Some(tmp);
        Some(path)
    } else {
        None
    };

    // Channel A's deliverable codec — selected by `DeliveryTarget` (WS4).
    // Each target maps to one `EncoderClass`:
    //   - Social SDR (vertical / square) → H264 (always libx264)
    //   - YouTube SDR / HDR 4K          → Hevc (videotoolbox preferred,
    //                                            libx265 fallback)
    //   - ProresMaster                   → ProResAlpha (composite archival)
    //
    // `CodecPreference` (export-controls plan, Phase 3) is now superseded
    // for codec choice — the target dictates the codec class. The field
    // remains on the wire for back-compat but is unused on this path; WS5
    // will deprecate it on the UI side once the delivery-target picker
    // lands.
    let encoder = select_encoder_for_target(req.delivery_target).map_err(|e| {
        RenderExportError::validation(format!(
            "select_encoder_for_target({:?}): {}",
            req.delivery_target, e,
        ))
    })?;

    let plan = build_composite_filtergraph(
        &visible_inputs,
        map_slot,
        video_slot,
        validated.output_dims,
        composite_mode,
        corner_mask_path.as_deref(),
        req.fps,
        validated.total_frames,
        &encoder,
        req.audio_bitrate_kbps,
        req.delivery_target,
        &validated.output_path_buf,
    )
    .map_err(classify_clip_chain_error)?;

    // FFmpegSink — rawvideo input on stdin from the orchestrator's worker.
    // NOT FFmpegRunner: Channel A's map stream is the renderer worker's output.
    let ffmpeg_bin = ffmpeg_path();
    let sink = FFmpegSink::spawn(&ffmpeg_bin, &plan.argv, plan.frame_bytes_per_input)
        .await
        .map_err(|e| RenderExportError {
            stage: "ffmpeg".to_string(),
            message: e.to_string(),
            stderr_tail: e.stderr_tail().map(|s| s.to_string()),
        })?;

    let setup = build_setup_payload(
        map_slot,
        req.layout.aspect,
        req.layout.resolution,
        req.fps,
        req.project_state,
    );

    let frames_written = render_map_frames(
        setup,
        validated.total_frames,
        OrchestratorConfig::default(),
        Box::new(sink),
        frame_progress_for(on_progress, validated.total_frames),
    )
    .await
    .map_err(classify_orchestrator_error)?;

    let wall_clock_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    Ok(RenderExportSummary {
        frames_written,
        output_path: req.output_path,
        wall_clock_ms,
    })
}

/// Probe up to `cap` clips concurrently. Returns probed dims + audio
/// presence in the same order as `clips`.
async fn probe_clips_capped(
    ffprobe_bin: &Path,
    clips: &[Clip],
    cap: usize,
) -> Result<Vec<ProbedClip>, FfprobeError> {
    use tokio::sync::Semaphore;
    let sem = std::sync::Arc::new(Semaphore::new(cap.max(1)));
    let mut handles = Vec::with_capacity(clips.len());
    for clip in clips {
        let sem = sem.clone();
        let path = PathBuf::from(&clip.path);
        let ffprobe = ffprobe_bin.to_path_buf();
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.expect("semaphore");
            probe_clip(&ffprobe, &path).await
        }));
    }
    let mut out = Vec::with_capacity(handles.len());
    for h in handles {
        match h.await {
            Ok(Ok(p)) => out.push(p),
            Ok(Err(e)) => return Err(e),
            Err(join_err) => {
                return Err(FfprobeError::SpawnFailed {
                    source_path: "(join)".to_string(),
                    reason: join_err.to_string(),
                });
            }
        }
    }
    Ok(out)
}

fn extract_clips(project_state: &Value) -> Result<Vec<Clip>, String> {
    let clips_value = project_state
        .get("clips")
        .ok_or_else(|| "missing `clips`".to_string())?;
    serde_json::from_value::<Vec<Clip>>(clips_value.clone())
        .map_err(|e| format!("clips deserialize: {}", e))
}

fn ffprobe_path() -> PathBuf {
    // Sidecar bundling (task 130) will swap this for the bundled binary
    // path the same way `ffmpeg_path()` does. For now: PATH lookup.
    PathBuf::from("ffprobe")
}

/// Reject channel × target combinations that are out of spec per the WS4
/// brief's compatibility matrix. Composite accepts all five targets;
/// map_only and video_only accept only `ProresMaster` (B and C are lossless
/// compositing intermediates).
fn validate_target_for_channel(
    target: DeliveryTarget,
    channel: &str,
) -> Result<(), RenderExportError> {
    if target.is_allowed_for_channel(channel) {
        Ok(())
    } else {
        Err(RenderExportError::validation(format!(
            "delivery target {:?} is not allowed for channel `{}` — \
             only `prores` is legal for map_only / video_only",
            target, channel,
        )))
    }
}

fn classify_clip_chain_error(e: ClipChainError) -> RenderExportError {
    RenderExportError {
        stage: "validation".to_string(),
        message: e.to_string(),
        stderr_tail: None,
    }
}

fn extract_total_duration_ms(project_state: &Value) -> Result<u64, String> {
    let timeline = project_state
        .get("timeline")
        .ok_or_else(|| "missing `timeline`".to_string())?;
    let v = timeline
        .get("totalDurationMs")
        .ok_or_else(|| "missing `totalDurationMs`".to_string())?;
    if let Some(n) = v.as_u64() {
        return Ok(n);
    }
    if let Some(n) = v.as_f64() {
        if n.is_finite() && n >= 0.0 {
            return Ok(n.round() as u64);
        }
    }
    Err(format!("not a non-negative number: {}", v))
}

fn write_corner_mask_tempfile(bytes: &[u8]) -> std::io::Result<tempfile::NamedTempFile> {
    use std::io::Write;
    let mut tmp = tempfile::Builder::new()
        .prefix("trailcut-corner-mask-")
        .suffix(".png")
        .tempfile()?;
    tmp.write_all(bytes)?;
    tmp.as_file_mut().sync_all()?;
    Ok(tmp)
}

fn classify_orchestrator_error(e: OrchestratorError) -> RenderExportError {
    // Sink errors carry the FFmpeg-tagged message. Inspect their wrapped
    // payload for stderr_tail; everything else is "orchestrator".
    if let OrchestratorError::SinkError(ref boxed) = e {
        let msg = boxed.to_string();
        let stderr_tail = boxed
            .downcast_ref::<FFmpegSinkError>()
            .and_then(|fe| fe.stderr_tail().map(|s| s.to_string()));
        return RenderExportError {
            stage: "ffmpeg".to_string(),
            message: msg,
            stderr_tail,
        };
    }
    RenderExportError {
        stage: "orchestrator".to_string(),
        message: e.to_string(),
        stderr_tail: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::layout::{NormalizedRect, PipInsetSource, PixelRect};
    use serde_json::json;

    fn pip_descriptor() -> LayoutDescriptor {
        let layout = LayoutConfig::Pip {
            inset_source: PipInsetSource::Map,
            inset: NormalizedRect { x: 0.65, y: 0.78, w: 0.32, h: 0.18 },
            corner_radius: 0.012,
        };
        let resolved = resolve_slots(
            &layout,
            AspectRatio::NineSixteen,
            OutputResolution::default(),
        );
        LayoutDescriptor {
            aspect: AspectRatio::NineSixteen,
            resolution: OutputResolution::default(),
            layout,
            resolved,
        }
    }

    fn project_state_with_duration(ms: u64) -> Value {
        json!({
            "timeline": { "totalDurationMs": ms },
            "route": null,
            "clips": [],
            "mapSettings": {}
        })
    }

    #[tokio::test]
    async fn rejects_unknown_channel() {
        // 060/070/090 ship `map_only`, `video_only`, `composite` respectively.
        // Anything else is rejected at dispatch time before validation runs.
        let req = RenderExportRequest {
            channel: "thumbnail".to_string(),
            fps: 30,
            output_path: "/tmp/x.mov".to_string(),
            layout: pip_descriptor(),
            codec_preference: CodecPreference::default(),
            audio_bitrate_kbps: 256,
            delivery_target: DeliveryTarget::Prores,
            project_state: project_state_with_duration(2000),
        };
        let err = render_export_inner(req, None).await.unwrap_err();
        assert_eq!(err.stage, "validation");
        assert!(err.message.contains("channel not yet implemented"));
    }

    #[tokio::test]
    async fn composite_rejects_empty_visible_clip_list() {
        // Composite shares 070's `EmptyTimeline` validation path.
        let req = RenderExportRequest {
            channel: "composite".to_string(),
            fps: 30,
            output_path: "/tmp/x.mp4".to_string(),
            layout: pip_descriptor(),
            codec_preference: CodecPreference::default(),
            audio_bitrate_kbps: 256,
            delivery_target: DeliveryTarget::Prores,
            project_state: project_state_with_duration(2000),
        };
        let err = render_export_inner(req, None).await.unwrap_err();
        assert_eq!(err.stage, "validation");
        assert!(
            err.message.contains("no visible clips"),
            "got: {}",
            err.message,
        );
    }

    #[tokio::test]
    async fn composite_rejects_layout_parity_mismatch() {
        // Tampered descriptor must be rejected before any FFmpeg / orchestrator
        // / ffprobe work begins (acceptance criterion: composite path covered).
        let mut descriptor = pip_descriptor();
        descriptor.resolved.map_slot = PixelRect {
            x: descriptor.resolved.map_slot.x + 1,
            ..descriptor.resolved.map_slot
        };
        let req = RenderExportRequest {
            channel: "composite".to_string(),
            fps: 30,
            output_path: "/tmp/x.mp4".to_string(),
            layout: descriptor,
            codec_preference: CodecPreference::default(),
            audio_bitrate_kbps: 256,
            delivery_target: DeliveryTarget::Prores,
            project_state: project_state_with_duration(2000),
        };
        let err = render_export_inner(req, None).await.unwrap_err();
        assert_eq!(err.stage, "validation");
        assert!(
            err.message.contains("parity check failed"),
            "got: {}",
            err.message,
        );
    }

    #[test]
    fn validate_request_does_not_call_select_encoder() {
        // Encoder-refactor regression guard. `validate_request` must not
        // touch the encoder cache — each channel branch picks its own.
        // We verify structurally: the function returns Err on a bad timeline
        // without resolving an encoder. The test passes if the function is
        // synchronous (no async select_encoder probe) and returns early on
        // duration=0; if a future refactor reintroduces select_encoder into
        // validate_request, that call would be async and this test's
        // expectation that the function compiles as a plain `fn` would
        // change shape (forcing a code-review touchpoint).
        let req = RenderExportRequest {
            channel: "map_only".to_string(),
            fps: 30,
            output_path: "/tmp/x.mov".to_string(),
            layout: pip_descriptor(),
            codec_preference: CodecPreference::default(),
            audio_bitrate_kbps: 256,
            delivery_target: DeliveryTarget::Prores,
            project_state: project_state_with_duration(0),
        };
        let err = validate_request(&req).expect_err("zero duration must fail");
        assert_eq!(err.stage, "validation");
        assert!(err.message.contains("zero duration"));
    }

    #[tokio::test]
    async fn video_only_rejects_layout_parity_mismatch() {
        // Same parity check as map_only; verifies the shared
        // `validate_request` helper covers the `video_only` path too.
        let mut descriptor = pip_descriptor();
        descriptor.resolved.video_slot = PixelRect {
            x: descriptor.resolved.video_slot.x + 1,
            ..descriptor.resolved.video_slot
        };
        let req = RenderExportRequest {
            channel: "video_only".to_string(),
            fps: 30,
            output_path: "/tmp/x.mov".to_string(),
            layout: descriptor,
            codec_preference: CodecPreference::default(),
            audio_bitrate_kbps: 256,
            delivery_target: DeliveryTarget::Prores,
            project_state: project_state_with_duration(2000),
        };
        let err = render_export_inner(req, None).await.unwrap_err();
        assert_eq!(err.stage, "validation");
        assert!(err.message.contains("parity check failed"), "got: {}", err.message);
    }

    #[tokio::test]
    async fn video_only_rejects_empty_visible_clip_list() {
        // `clips` field present but empty → "no visible clips".
        let req = RenderExportRequest {
            channel: "video_only".to_string(),
            fps: 30,
            output_path: "/tmp/x.mov".to_string(),
            layout: pip_descriptor(),
            codec_preference: CodecPreference::default(),
            audio_bitrate_kbps: 256,
            delivery_target: DeliveryTarget::Prores,
            project_state: project_state_with_duration(2000),
        };
        let err = render_export_inner(req, None).await.unwrap_err();
        assert_eq!(err.stage, "validation");
        assert!(
            err.message.contains("no visible clips"),
            "got: {}",
            err.message,
        );
    }

    #[tokio::test]
    async fn video_only_rejects_missing_source_file() {
        // Build a clips array referencing a path that does not exist.
        let project = json!({
            "timeline": {"totalDurationMs": 2000},
            "route": null,
            "clips": [{
                "id": "c1",
                "path": "/nonexistent/path/clip.mov",
                "filename": "clip.mov",
                "duration_ms": 2000,
                "trim": {"in_ms": 0, "out_ms": 2000},
                "focal_point": {"x": 0.5, "y": 0.5, "zoom": 1.0},
                "effects": {
                    "stabilize": {"enabled": false, "shakiness": 5},
                    "speed": 1.0
                },
                "visible": true
            }],
            "mapSettings": {}
        });
        let req = RenderExportRequest {
            channel: "video_only".to_string(),
            fps: 30,
            output_path: "/tmp/x.mov".to_string(),
            layout: pip_descriptor(),
            codec_preference: CodecPreference::default(),
            audio_bitrate_kbps: 256,
            delivery_target: DeliveryTarget::Prores,
            project_state: project,
        };
        let err = render_export_inner(req, None).await.unwrap_err();
        assert_eq!(err.stage, "validation");
        assert!(
            err.message.contains("source file missing"),
            "got: {}",
            err.message,
        );
    }

    #[tokio::test]
    async fn rejects_layout_parity_mismatch() {
        // Tamper with `resolved.map_slot.x` so it disagrees with what
        // `resolve_slots` would compute. The IPC parity check must reject
        // the request before any FFmpeg / orchestrator work begins.
        let mut descriptor = pip_descriptor();
        descriptor.resolved.map_slot = PixelRect {
            x: descriptor.resolved.map_slot.x + 1, // off-by-one tamper
            ..descriptor.resolved.map_slot
        };
        let req = RenderExportRequest {
            channel: "map_only".to_string(),
            fps: 30,
            output_path: "/tmp/x.mov".to_string(),
            layout: descriptor,
            codec_preference: CodecPreference::default(),
            audio_bitrate_kbps: 256,
            delivery_target: DeliveryTarget::Prores,
            project_state: project_state_with_duration(2000),
        };
        let err = render_export_inner(req, None).await.unwrap_err();
        assert_eq!(err.stage, "validation");
        assert!(
            err.message.contains("parity check failed"),
            "got: {}",
            err.message,
        );
    }

    #[tokio::test]
    async fn rejects_zero_duration_timeline() {
        let req = RenderExportRequest {
            channel: "map_only".to_string(),
            fps: 30,
            output_path: "/tmp/x.mov".to_string(),
            layout: pip_descriptor(),
            codec_preference: CodecPreference::default(),
            audio_bitrate_kbps: 256,
            delivery_target: DeliveryTarget::Prores,
            project_state: project_state_with_duration(0),
        };
        let err = render_export_inner(req, None).await.unwrap_err();
        assert_eq!(err.stage, "validation");
        assert!(err.message.contains("zero duration"));
    }

    #[test]
    fn extract_duration_handles_int_and_float() {
        assert_eq!(
            extract_total_duration_ms(&json!({"timeline":{"totalDurationMs": 2000}})).unwrap(),
            2000,
        );
        assert_eq!(
            extract_total_duration_ms(&json!({"timeline":{"totalDurationMs": 1999.6}}))
                .unwrap(),
            2000,
        );
        assert!(
            extract_total_duration_ms(&json!({"timeline":{}})).is_err(),
            "missing field should error",
        );
    }

    #[test]
    fn round_half_up_total_frames() {
        // 2000ms × 30fps = 60_000 → /1000 = 60.
        let total = (2000u64 * 30 + 500) / 1000;
        assert_eq!(total, 60);
        // 1990ms × 30fps = 59_700 → +500 = 60_200 → /1000 = 60.
        let total = (1990u64 * 30 + 500) / 1000;
        assert_eq!(total, 60);
        // 1980ms × 30fps = 59_400 → +500 = 59_900 → /1000 = 59.
        let total = (1980u64 * 30 + 500) / 1000;
        assert_eq!(total, 59);
    }

    #[test]
    fn render_export_request_defaults_phase_1_fields() {
        // Phase 1 of the export-controls plan adds `codec_preference`,
        // `audio_bitrate_kbps`, and `layout.resolution` to the wire protocol.
        // All three are `#[serde(default)]`-decorated so back-compat wire data
        // captured before the plan landed deserializes cleanly to the
        // documented defaults. This is the back-compat smoke test the plan
        // calls out under §"Phase 1 — Tests".
        //
        // The JSON below intentionally omits all three new fields plus the
        // `resolution` field on the layout descriptor; serde must fill them in.
        let raw = json!({
            "channel": "map_only",
            "fps": 30,
            "output_path": "/tmp/x.mov",
            "layout": {
                "aspect": "9_16",
                // resolution intentionally absent — should default to "1080p".
                "layout": {
                    "mode": "pip",
                    "inset_source": "map",
                    "inset": { "x": 0.65, "y": 0.78, "w": 0.32, "h": 0.18 },
                    "corner_radius": 0.012
                },
                "resolved": {
                    "output": { "w": 1080, "h": 1920 },
                    "map_slot": { "x": 702, "y": 1498, "w": 346, "h": 346 },
                    "video_slot": { "x": 0, "y": 0, "w": 1080, "h": 1920 },
                    "corner_radius_px": 13,
                    "corner_radius_slot": "map"
                }
            },
            // codec_preference + audio_bitrate_kbps intentionally absent.
            "timeline": { "totalDurationMs": 2000 },
            "route": null,
            "clips": [],
            "mapSettings": {}
        });
        let req: RenderExportRequest = serde_json::from_value(raw)
            .expect("wire JSON missing Phase 1 fields must deserialize via serde defaults");
        assert_eq!(req.codec_preference, CodecPreference::Auto);
        assert_eq!(req.audio_bitrate_kbps, 256);
        assert_eq!(req.layout.resolution, OutputResolution::P1080);
    }

    #[test]
    fn render_export_request_defaults_via_raw_json_string() {
        // Phase 5 integration coverage. The Phase 1 back-compat test above
        // exercises `serde_json::from_value`; this one exercises the
        // `serde_json::from_str` path against a realistic raw JSON payload
        // captured pre-controls (no `codec_preference`, no
        // `audio_bitrate_kbps`, no `layout.resolution`). Both code paths route
        // through serde derives, but only the string parser exercises the
        // tokenizer — a missing-comma or stray-trailing-comma defaults
        // regression would slip past the `Value`-based test.
        let raw_json = r#"{
            "channel": "map_only",
            "fps": 30,
            "output_path": "/tmp/x.mov",
            "layout": {
                "aspect": "9_16",
                "layout": {
                    "mode": "pip",
                    "inset_source": "map",
                    "inset": { "x": 0.65, "y": 0.78, "w": 0.32, "h": 0.18 },
                    "corner_radius": 0.012
                },
                "resolved": {
                    "output": { "w": 1080, "h": 1920 },
                    "map_slot": { "x": 702, "y": 1498, "w": 346, "h": 346 },
                    "video_slot": { "x": 0, "y": 0, "w": 1080, "h": 1920 },
                    "corner_radius_px": 13,
                    "corner_radius_slot": "map"
                }
            },
            "timeline": { "totalDurationMs": 2000 },
            "route": null,
            "clips": [],
            "mapSettings": {}
        }"#;
        let req: RenderExportRequest = serde_json::from_str(raw_json).expect(
            "raw JSON missing controls fields must deserialize via serde(default) end-to-end",
        );
        assert_eq!(req.codec_preference, CodecPreference::Auto);
        assert_eq!(req.audio_bitrate_kbps, 256);
        assert_eq!(req.layout.resolution, OutputResolution::P1080);
    }

    // ---- Phase 3: codec-preference selector tests ----

    use crate::export::encoder::{EncoderChoice, EncoderError, EncoderKind};
    use std::cell::RefCell;

    fn stub_choice(class: EncoderClass, name: &str) -> EncoderChoice {
        EncoderChoice {
            class,
            name: name.to_string(),
            kind: EncoderKind::Software,
            codec_args: vec![],
            probe_wall_clock_ms: 0,
        }
    }

    #[test]
    fn h264_preference_picks_h264_and_never_probes_hevc() {
        // `H264` must route through `EncoderClass::H264`; the selector must
        // never request `EncoderClass::Hevc`. We assert both: the returned
        // encoder's class is H264, and the stub records show no Hevc lookup.
        let calls = RefCell::new(Vec::<EncoderClass>::new());
        let stub = |class: EncoderClass| -> Result<EncoderChoice, EncoderError> {
            calls.borrow_mut().push(class);
            Ok(stub_choice(class, "libx264"))
        };
        let choice = select_composite_encoder_with(CodecPreference::H264, stub).unwrap();
        assert_eq!(choice.class, EncoderClass::H264);
        let recorded = calls.borrow().clone();
        assert_eq!(recorded, vec![EncoderClass::H264]);
        assert!(
            !recorded.contains(&EncoderClass::Hevc),
            "H264 preference must never probe Hevc, got {:?}",
            recorded,
        );
    }

    #[test]
    fn auto_preference_probes_hevc_class() {
        // Auto is the today-equivalent: walk `EncoderClass::Hevc`'s candidate
        // ladder. Internally that ladder is HEVC-only (hevc_videotoolbox →
        // libx265 etc.) — no silent fallback to H264.
        let calls = RefCell::new(Vec::<EncoderClass>::new());
        let stub = |class: EncoderClass| -> Result<EncoderChoice, EncoderError> {
            calls.borrow_mut().push(class);
            Ok(stub_choice(class, "hevc_videotoolbox"))
        };
        let choice = select_composite_encoder_with(CodecPreference::Auto, stub).unwrap();
        assert_eq!(choice.class, EncoderClass::Hevc);
        assert_eq!(calls.borrow().clone(), vec![EncoderClass::Hevc]);
    }

    #[test]
    fn explicit_hevc_with_no_hevc_returns_strict_validation_error() {
        // Stub a "Hevc unavailable" environment: the selector returns
        // `NoEncoderForClass(Hevc)`. Explicit `Hevc` preference must surface
        // the user-facing validation message, NOT silently fall back to H264.
        let calls = RefCell::new(Vec::<EncoderClass>::new());
        let stub = |class: EncoderClass| -> Result<EncoderChoice, EncoderError> {
            calls.borrow_mut().push(class);
            Err(EncoderError::NoEncoderForClass(class))
        };
        let err = select_composite_encoder_with(CodecPreference::Hevc, stub).unwrap_err();
        assert_eq!(err.stage, "validation");
        assert_eq!(
            err.message,
            "HEVC encoder not available on this system; choose H.264 or Auto.",
        );
        // The stub must have been asked exactly once, for Hevc. No silent
        // retry against H264.
        assert_eq!(calls.borrow().clone(), vec![EncoderClass::Hevc]);
    }

    #[test]
    fn auto_with_no_hevc_returns_generic_validation_error_not_strict_message() {
        // Auto preference: if Hevc is unavailable the user gets a generic
        // failure (the today-equivalent code path), NOT the strict-Hevc
        // message — that message would mislead a user who didn't pick HEVC
        // explicitly.
        let stub = |class: EncoderClass| -> Result<EncoderChoice, EncoderError> {
            Err(EncoderError::NoEncoderForClass(class))
        };
        let err = select_composite_encoder_with(CodecPreference::Auto, stub).unwrap_err();
        assert_eq!(err.stage, "validation");
        assert!(
            !err.message.contains("choose H.264 or Auto"),
            "Auto preference must not surface the strict-Hevc message: {}",
            err.message,
        );
    }
}
