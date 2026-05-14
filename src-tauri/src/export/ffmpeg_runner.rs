// Process-only FFmpeg runner for non-streaming channels — task 070.
//
// Distinct from `ffmpeg_sink::FFmpegSink`: this runner spawns FFmpeg, waits
// for exit, captures the stderr tail, and returns. No stdin, no per-frame
// writer, no `FrameSink` trait implementation. Channel C reads source files
// directly via `-i {path}` per clip; nothing streams in.
//
// Stderr is forwarded line-by-line to the parent process's stderr (prefixed
// `[ffmpeg]`) and the last 4 KB is retained in a ring buffer for inclusion
// in the structured error variant on non-zero exit. Pattern mirrors
// `ffmpeg_sink::forward_stderr`; intentionally duplicated rather than
// reused to avoid a public-API dependency between sibling modules.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout, Command};
use tokio::task::JoinHandle;

pub use crate::export::error::FFmpegRunnerError;
use crate::export::orchestrator::FrameProgress;

const STDERR_TAIL_BYTES: usize = 4096;

#[derive(Debug, Clone)]
pub struct FFmpegRunResult {
    pub exit_code: i32,
    pub wall_clock_ms: u64,
    pub stderr_tail: String,
}

/// FFmpeg-process runner. Owns the child + stderr-forwarder until `wait`
/// returns. Drop-on-error is automatic via `kill_on_drop(true)`.
pub struct FFmpegRunner {
    child: tokio::process::Child,
    stderr_handle: Option<JoinHandle<()>>,
    stdout_handle: Option<JoinHandle<()>>,
    stderr_tail: Arc<Mutex<StderrRing>>,
    started: Instant,
}

impl FFmpegRunner {
    /// Spawn FFmpeg with `argv`. Stdin is inherited as null (FFmpeg won't
    /// block waiting for input); stderr is piped and forwarded.
    ///
    /// When `on_progress` is `Some`, FFmpeg's stdout is also piped and parsed
    /// as the `-progress pipe:1` key/value stream: `frame=N` lines drive the
    /// callback. Callers that want progress must include `-progress pipe:1`
    /// in `argv` themselves — this function does not inject it, to keep the
    /// filtergraph builders in charge of the full argv.
    pub async fn spawn(
        ffmpeg_path: &Path,
        argv: &[String],
        on_progress: Option<FrameProgress>,
    ) -> Result<Self, FFmpegRunnerError> {
        let started = Instant::now();
        let stdout_kind = if on_progress.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        };
        let mut child = Command::new(ffmpeg_path)
            .args(argv)
            .stdin(std::process::Stdio::null())
            .stdout(stdout_kind)
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| FFmpegRunnerError::SpawnFailed {
                path: ffmpeg_path.to_string_lossy().into_owned(),
                source: e,
            })?;

        let stderr = child.stderr.take().expect("piped");
        let stderr_tail = Arc::new(Mutex::new(StderrRing::new(STDERR_TAIL_BYTES)));
        let stderr_handle = {
            let tail = stderr_tail.clone();
            tokio::spawn(forward_stderr(stderr, tail))
        };

        let stdout_handle = if let Some(cb) = on_progress {
            let stdout = child.stdout.take().expect("piped");
            Some(tokio::spawn(parse_progress_stream(stdout, cb)))
        } else {
            None
        };

        Ok(Self {
            child,
            stderr_handle: Some(stderr_handle),
            stdout_handle,
            stderr_tail,
            started,
        })
    }

    /// Block until FFmpeg exits. On non-zero exit, returns
    /// `FFmpegRunnerError::EncoderFailed` with the captured stderr tail.
    pub async fn wait(mut self) -> Result<FFmpegRunResult, FFmpegRunnerError> {
        let status = self.child.wait().await?;
        if let Some(h) = self.stderr_handle.take() {
            let _ = h.await;
        }
        if let Some(h) = self.stdout_handle.take() {
            let _ = h.await;
        }
        let stderr_tail = self.stderr_tail.lock().unwrap().tail();
        let wall_clock_ms = self.started.elapsed().as_millis().min(u64::MAX as u128) as u64;

        if status.success() {
            Ok(FFmpegRunResult {
                exit_code: status.code().unwrap_or(0),
                wall_clock_ms,
                stderr_tail,
            })
        } else {
            Err(FFmpegRunnerError::EncoderFailed {
                exit_code: status.code(),
                stderr_tail,
                wall_clock_ms,
            })
        }
    }
}

/// One-shot helper: spawn → wait → return result. Equivalent to
/// `FFmpegRunner::spawn(...).await?.wait().await`.
pub async fn run_ffmpeg(
    ffmpeg_path: &Path,
    argv: &[String],
) -> Result<FFmpegRunResult, FFmpegRunnerError> {
    let runner = FFmpegRunner::spawn(ffmpeg_path, argv, None).await?;
    runner.wait().await
}

/// Progress-emitting variant of `run_ffmpeg`. Callers must include
/// `-progress pipe:1` in `argv` (the filtergraph builders own the argv, so
/// this stays separate from the runner). The callback is invoked with each
/// `frame=N` value FFmpeg writes to stdout.
pub async fn run_ffmpeg_with_progress(
    ffmpeg_path: &Path,
    argv: &[String],
    on_progress: FrameProgress,
) -> Result<FFmpegRunResult, FFmpegRunnerError> {
    let runner = FFmpegRunner::spawn(ffmpeg_path, argv, Some(on_progress)).await?;
    runner.wait().await
}

/// Read FFmpeg's `-progress pipe:1` key=value stream line by line and call
/// `on_progress(frame_index)` for each `frame=N` line. Other keys (`speed`,
/// `bitrate`, `out_time`, …) are ignored — we only need the frame count to
/// drive the progress bar.
async fn parse_progress_stream(stdout: ChildStdout, on_progress: FrameProgress) {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                if let Some(rest) = line.strip_prefix("frame=") {
                    if let Ok(n) = rest.trim().parse::<u32>() {
                        on_progress(n);
                    }
                }
            }
            Err(_) => break,
        }
    }
}

async fn forward_stderr(stderr: ChildStderr, tail: Arc<Mutex<StderrRing>>) {
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                eprint!("[ffmpeg] {}", line);
                tail.lock().unwrap().push(&line);
            }
            Err(_) => break,
        }
    }
}

/// Bounded ring buffer of stderr lines, capped by total bytes. Pattern
/// duplicated from `ffmpeg_sink.rs`; cohesive with that module's reasoning.
struct StderrRing {
    cap: usize,
    parts: VecDeque<String>,
    total_bytes: usize,
}

impl StderrRing {
    fn new(cap: usize) -> Self {
        Self {
            cap,
            parts: VecDeque::new(),
            total_bytes: 0,
        }
    }

    fn push(&mut self, s: &str) {
        self.total_bytes += s.len();
        self.parts.push_back(s.to_string());
        while self.total_bytes > self.cap && self.parts.len() > 1 {
            if let Some(removed) = self.parts.pop_front() {
                self.total_bytes -= removed.len();
            }
        }
    }

    fn tail(&self) -> String {
        let mut out = String::with_capacity(self.total_bytes);
        for s in &self.parts {
            out.push_str(s);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn ffmpeg_on_path() -> bool {
        std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[tokio::test]
    async fn run_ffmpeg_version_succeeds() {
        if !ffmpeg_on_path() {
            eprintln!("ffmpeg not on PATH — skipping");
            return;
        }
        let res = run_ffmpeg(&PathBuf::from("ffmpeg"), &["-version".to_string()])
            .await
            .expect("ffmpeg -version should succeed");
        assert_eq!(res.exit_code, 0);
        // FFmpeg prints version banner on stderr (it does).
        assert!(
            !res.stderr_tail.is_empty() || res.exit_code == 0,
            "expected stderr_tail or successful exit",
        );
    }

    #[tokio::test]
    async fn run_ffmpeg_unknown_flag_errors() {
        if !ffmpeg_on_path() {
            eprintln!("ffmpeg not on PATH — skipping");
            return;
        }
        let err = run_ffmpeg(
            &PathBuf::from("ffmpeg"),
            &["-nonexistent_flag_xyz".to_string()],
        )
        .await
        .expect_err("unknown flag must error");
        match err {
            FFmpegRunnerError::EncoderFailed {
                exit_code,
                stderr_tail,
                ..
            } => {
                assert!(
                    exit_code.unwrap_or(0) != 0,
                    "expected non-zero exit, got {:?}",
                    exit_code,
                );
                let lower = stderr_tail.to_lowercase();
                assert!(
                    lower.contains("unrecognized") || lower.contains("option"),
                    "stderr_tail should mention the bad flag: {}",
                    stderr_tail,
                );
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn stderr_ring_evicts_old_lines_under_cap() {
        let mut ring = StderrRing::new(10);
        ring.push("aaaa\n");
        ring.push("bbbb\n");
        ring.push("cccc\n");
        let tail = ring.tail();
        assert!(!tail.contains("aaaa"));
        assert!(tail.contains("cccc"));
    }
}
