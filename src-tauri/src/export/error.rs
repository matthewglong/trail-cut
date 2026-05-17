use thiserror::Error;

use crate::export::sink::SinkError;

#[derive(Debug, Error)]
pub enum OrchestratorError {
    #[error("renderer bundle not found at {path}; run `npm run build:renderer`")]
    BundleMissing { path: String },

    #[error("failed to spawn worker {worker_id}: {source}")]
    WorkerSpawnFailed {
        worker_id: usize,
        #[source]
        source: std::io::Error,
    },

    #[error("worker {worker_id} exited early (code: {code:?})\n--- stderr tail ---\n{stderr_tail}")]
    WorkerExitedEarly {
        worker_id: usize,
        code: Option<i32>,
        stderr_tail: String,
    },

    #[error("protocol error from worker {worker_id}: {reason}")]
    ProtocolError { worker_id: usize, reason: String },

    #[error("sink error: {0}")]
    SinkError(#[source] SinkError),

    #[error("timeout in stage: {stage}")]
    Timeout { stage: String },

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),
}

impl From<OrchestratorError> for String {
    fn from(e: OrchestratorError) -> Self {
        e.to_string()
    }
}

// ---------- Channel C (video-only) error variants (task 070) ----------
//
// These live alongside `OrchestratorError` so `error.rs` stays the central
// place for export-pipeline error variants, but they're a separate family
// because Channel C bypasses the orchestrator entirely (no worker spawn,
// no FrameSink). The classification helper in `mod.rs::classify_*` maps
// each into the on-the-wire `RenderExportError { stage, message,
// stderr_tail }` shape.

#[derive(Debug, Error)]
pub enum ClipChainError {
    /// `zoom < 1.0` is rejected — LAYOUT.md §7 defines focal-zoom as
    /// punch-in only.
    #[error("clip {clip_id}: invalid zoom {zoom} (must be >= 1.0)")]
    InvalidZoom { clip_id: String, zoom: f64 },

    /// Source dimensions were not available (probe failed or returned 0×0).
    #[error("clip {clip_id}: missing or zero source dimensions")]
    MissingSourceDims { clip_id: String },

    /// Trim range is empty or inverted (out_ms <= in_ms).
    #[error("clip {clip_id}: invalid trim range in_ms={in_ms} out_ms={out_ms}")]
    InvalidTrim {
        clip_id: String,
        in_ms: u64,
        out_ms: u64,
    },

    /// Speed is non-positive or non-finite. LAYOUT.md §7 expects > 0.
    #[error("clip {clip_id}: invalid speed {speed}")]
    InvalidSpeed { clip_id: String, speed: f64 },
}

#[derive(Debug, Error)]
pub enum FfprobeError {
    #[error("ffprobe spawn failed for {source_path}: {reason}")]
    SpawnFailed { source_path: String, reason: String },

    #[error("ffprobe exited non-zero for {source_path}: {reason}")]
    ProbeFailed { source_path: String, reason: String },

    #[error("ffprobe parse failed for {source_path}: {reason}")]
    ParseFailed { source_path: String, reason: String },
}

#[derive(Debug, Error)]
pub enum FFmpegRunnerError {
    #[error("failed to spawn ffmpeg at {path}: {source}")]
    SpawnFailed {
        path: String,
        #[source]
        source: std::io::Error,
    },

    #[error(
        "ffmpeg exited with code {exit_code:?}\n--- stderr tail ---\n{stderr_tail}"
    )]
    EncoderFailed {
        exit_code: Option<i32>,
        stderr_tail: String,
        wall_clock_ms: u64,
    },

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl FFmpegRunnerError {
    /// Best-effort accessor for the captured stderr tail. Returns `None` for
    /// variants that don't carry one.
    pub fn stderr_tail(&self) -> Option<&str> {
        match self {
            FFmpegRunnerError::EncoderFailed { stderr_tail, .. } => Some(stderr_tail.as_str()),
            _ => None,
        }
    }
}

/// Errors that can surface during `render_export`'s `video_only` branch
/// before any FFmpeg work begins. These are all "validation" stage errors
/// from the frontend's perspective.
#[derive(Debug, Error)]
pub enum VideoOnlyValidationError {
    /// No visible clips on the timeline; `concat=n=0` is rejected by FFmpeg
    /// and would be a no-op file regardless.
    #[error("no visible clips — nothing to render")]
    EmptyTimeline,

    /// A clip's source file was not found on disk. Caught before ffprobe
    /// to surface a clearer message than ffprobe's generic "No such file".
    #[error("source file missing: {path}")]
    MissingSourceFile { path: String },
}
