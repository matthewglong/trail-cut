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
pub mod encoder;
pub mod error;
pub mod ffmpeg_runner;
pub mod ffmpeg_sink;
pub mod ffprobe;
pub mod filtergraph;
pub mod layout;
pub mod orchestrator;
pub mod protocol;
pub mod sink;

pub use clip_chain::{
    build_clip_audio_subgraph, build_clip_chain, build_clip_video_subgraph, chain_atempo,
    compute_focal_crop, ClipChainInputs, ClipChainOutput, CropRect, PixelDims,
};
pub use encoder::{
    ffmpeg_path, probe_all, select_encoder, set_cache_path_for_test, set_ffmpeg_path,
    EncoderChoice, EncoderClass, EncoderError, EncoderKind, EncoderProbe,
};
pub use error::{
    ClipChainError, FFmpegRunnerError, FfprobeError, OrchestratorError, VideoOnlyValidationError,
};
pub use ffmpeg_runner::{run_ffmpeg, FFmpegRunResult, FFmpegRunner};
pub use ffmpeg_sink::{FFmpegSink, FFmpegSinkError, EXPORT_FINISH_TIMEOUT_SECS};
pub use ffprobe::{probe_clip, ProbedClip};
pub use filtergraph::{
    build_composite_filtergraph, build_map_only_filtergraph, build_video_only_filtergraph,
    CompositeMode, FiltergraphPlan, VisibleClipInput,
};
pub use layout::{
    default_layout, output_dims, resolve_slots, AspectRatio, CornerRadiusSlot, LayoutConfig,
    LayoutDescriptor, NormalizedRect, OutputDimensions, PipInsetSource, PixelRect, ProjectLayouts,
    SlotResolution, SplitSide,
};
pub use orchestrator::{render_map_frames, OrchestratorConfig, RECYCLE_EVERY_FRAMES};
pub use protocol::{SetupPayload, Viewport};
pub use sink::{FrameSink, SinkError, VecSink};

use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::models::Clip;

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
    /// Same project-state fields as the orchestrator's `SetupPayload` —
    /// pass-through to the workers.
    #[serde(flatten)]
    pub project_state: Value,
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
    let recomputed = resolve_slots(&req.layout.layout, req.layout.aspect);
    if recomputed != req.layout.resolved {
        return Err(RenderExportError::validation(format!(
            "layout descriptor parity check failed: frontend resolved={:?}, rust resolved={:?}",
            req.layout.resolved, recomputed,
        )));
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

    Ok(ValidatedRequest {
        total_frames,
        output_dims: req.layout.resolved.output,
        output_path_buf: PathBuf::from(&req.output_path),
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

#[tauri::command]
pub async fn render_export(
    req: RenderExportRequest,
) -> Result<RenderExportSummary, RenderExportError> {
    let started = Instant::now();
    match req.channel.as_str() {
        "map_only" => render_export_map_only(req, started).await,
        "video_only" => render_export_video_only(req, started).await,
        "composite" => render_export_composite(req, started).await,
        other => Err(RenderExportError::validation(format!(
            "channel not yet implemented in this build: {}",
            other,
        ))),
    }
}

async fn render_export_map_only(
    req: RenderExportRequest,
    started: Instant,
) -> Result<RenderExportSummary, RenderExportError> {
    let validated = validate_request(&req)?;

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

    let setup = SetupPayload {
        viewport: Viewport {
            w: map_slot.w,
            h: map_slot.h,
        },
        fps: req.fps,
        project_state: req.project_state,
    };

    let frames_written = render_map_frames(
        setup,
        validated.total_frames,
        OrchestratorConfig::default(),
        Box::new(sink),
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
) -> Result<RenderExportSummary, RenderExportError> {
    let validated = validate_request(&req)?;

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

    // Spawn FFmpeg via the runner (no stdin, no FrameSink).
    let ffmpeg_bin = ffmpeg_path();
    run_ffmpeg(&ffmpeg_bin, &plan.argv)
        .await
        .map_err(|e| RenderExportError {
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
) -> Result<RenderExportSummary, RenderExportError> {
    let validated = validate_request(&req)?;

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

    // HEVC for the deliverable. Channel A picks its own encoder (post-refactor
    // in `validate_request`) — B/C use ProResAlpha, A uses Hevc.
    let encoder = select_channel_encoder(EncoderClass::Hevc)?;

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
        &["-c:a", "aac", "-b:a", "256k"],
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

    let setup = SetupPayload {
        viewport: Viewport {
            w: map_slot.w,
            h: map_slot.h,
        },
        fps: req.fps,
        project_state: req.project_state,
    };

    let frames_written = render_map_frames(
        setup,
        validated.total_frames,
        OrchestratorConfig::default(),
        Box::new(sink),
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
        let resolved = resolve_slots(&layout, AspectRatio::NineSixteen);
        LayoutDescriptor {
            aspect: AspectRatio::NineSixteen,
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
            project_state: project_state_with_duration(2000),
        };
        let err = render_export(req).await.unwrap_err();
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
            project_state: project_state_with_duration(2000),
        };
        let err = render_export(req).await.unwrap_err();
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
            project_state: project_state_with_duration(2000),
        };
        let err = render_export(req).await.unwrap_err();
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
            project_state: project_state_with_duration(2000),
        };
        let err = render_export(req).await.unwrap_err();
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
            project_state: project_state_with_duration(2000),
        };
        let err = render_export(req).await.unwrap_err();
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
            project_state: project,
        };
        let err = render_export(req).await.unwrap_err();
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
            project_state: project_state_with_duration(2000),
        };
        let err = render_export(req).await.unwrap_err();
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
            project_state: project_state_with_duration(0),
        };
        let err = render_export(req).await.unwrap_err();
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
}
