// FFmpeg-process `FrameSink` implementation (task 060).
//
// Spawns FFmpeg with the argv produced by `filtergraph::build_map_only_filtergraph`,
// pipes RGBA frames into stdin in order, and waits for clean exit on `finish()`.
// Mirrors the orchestrator's stderr-forwarder pattern: a tokio task copies
// FFmpeg's stderr to the parent process's stderr (prefixed with `[ffmpeg]`)
// and retains the last 4 KB in a ring for inclusion in error variants.
//
// This module is deliberately a thin process wrapper. No frame distribution,
// no ordering, no recycle/lifecycle decisions — those live in the orchestrator.
// Acceptance criteria for task 060 enforce this with a grep over this file.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdin, Command};
use tokio::task::JoinHandle;

use crate::export::sink::{FrameSink, SinkError};

/// Maximum time `finish()` waits for FFmpeg to exit after stdin is closed.
/// FFmpeg flushes the encoder + writes the trailer on EOF; ProRes 4444
/// flush is fast (single-pass intra-frame), but we leave generous headroom.
pub const EXPORT_FINISH_TIMEOUT_SECS: u64 = 30;

const STDERR_TAIL_BYTES: usize = 4096;

#[derive(Debug, Error)]
pub enum FFmpegSinkError {
    #[error("failed to spawn ffmpeg at {path}: {source}")]
    SpawnFailed {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error(
        "frame {frame_index} size mismatch: expected {expected} bytes, got {actual}"
    )]
    FrameSizeMismatch {
        frame_index: u32,
        expected: usize,
        actual: usize,
    },
    #[error("io error writing frame {frame_index}: {source}")]
    WriteFailed {
        frame_index: u32,
        #[source]
        source: std::io::Error,
    },
    #[error(
        "ffmpeg exited with code {exit_code:?} after {frames_written} frames\n--- stderr tail ---\n{stderr_tail}"
    )]
    EncoderFailed {
        exit_code: Option<i32>,
        stderr_tail: String,
        frames_written: u32,
    },
    #[error("ffmpeg did not exit within {EXPORT_FINISH_TIMEOUT_SECS}s after stdin close (frames_written={frames_written})\n--- stderr tail ---\n{stderr_tail}")]
    EncoderHang {
        stderr_tail: String,
        frames_written: u32,
    },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl FFmpegSinkError {
    /// Best-effort accessor for the captured stderr tail. Returns `None` for
    /// variants that don't carry one (spawn / size-mismatch / per-frame io).
    pub fn stderr_tail(&self) -> Option<&str> {
        match self {
            FFmpegSinkError::EncoderFailed { stderr_tail, .. }
            | FFmpegSinkError::EncoderHang { stderr_tail, .. } => Some(stderr_tail.as_str()),
            _ => None,
        }
    }
}

/// FFmpeg-backed `FrameSink`.
pub struct FFmpegSink {
    child: tokio::process::Child,
    stdin: Option<ChildStdin>,
    stderr_handle: Option<JoinHandle<()>>,
    stderr_tail: Arc<Mutex<StderrRing>>,
    expected_frame_bytes: usize,
    frames_written: u32,
}

impl FFmpegSink {
    /// Spawn FFmpeg with `argv`. `expected_frame_bytes` is the exact byte
    /// count `write_frame` will accept (`slot.w * slot.h * 4` for rawvideo
    /// rgba). The orchestrator's contract guarantees fixed-size frames; the
    /// assertion in `write_frame` is a tripwire if a future regression
    /// reorders pipeline arithmetic.
    pub async fn spawn(
        ffmpeg_path: &Path,
        argv: &[String],
        expected_frame_bytes: usize,
    ) -> Result<Self, FFmpegSinkError> {
        let mut child = Command::new(ffmpeg_path)
            .args(argv)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| FFmpegSinkError::SpawnFailed {
                path: ffmpeg_path.to_string_lossy().into_owned(),
                source: e,
            })?;

        let stdin = child.stdin.take().expect("piped");
        let stderr = child.stderr.take().expect("piped");

        let stderr_tail = Arc::new(Mutex::new(StderrRing::new(STDERR_TAIL_BYTES)));
        let stderr_handle = {
            let tail = stderr_tail.clone();
            tokio::spawn(forward_stderr(stderr, tail))
        };

        Ok(Self {
            child,
            stdin: Some(stdin),
            stderr_handle: Some(stderr_handle),
            stderr_tail,
            expected_frame_bytes,
            frames_written: 0,
        })
    }

    /// Number of frames successfully forwarded to FFmpeg's stdin.
    pub fn frames_written(&self) -> u32 {
        self.frames_written
    }
}

impl FrameSink for FFmpegSink {
    fn write_frame(&mut self, frame_index: u32, rgba: &[u8]) -> Result<(), SinkError> {
        if rgba.len() != self.expected_frame_bytes {
            return Err(Box::new(FFmpegSinkError::FrameSizeMismatch {
                frame_index,
                expected: self.expected_frame_bytes,
                actual: rgba.len(),
            }));
        }
        let stdin = match self.stdin.as_mut() {
            Some(s) => s,
            None => {
                return Err(Box::new(FFmpegSinkError::WriteFailed {
                    frame_index,
                    source: std::io::Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        "ffmpeg stdin already closed",
                    ),
                }));
            }
        };

        // The orchestrator runs inside a tokio runtime; we're inside its
        // call to `sink.write_frame`. Use the current runtime handle to
        // drive the async write without spawning a new runtime.
        let handle = tokio::runtime::Handle::current();
        let result = tokio::task::block_in_place(|| {
            handle.block_on(async {
                stdin.write_all(rgba).await
            })
        });

        match result {
            Ok(()) => {
                self.frames_written += 1;
                Ok(())
            }
            Err(e) => Err(Box::new(FFmpegSinkError::WriteFailed {
                frame_index,
                source: e,
            })),
        }
    }

    fn finish(self: Box<Self>) -> Result<(), SinkError> {
        let mut me = *self;
        let handle = tokio::runtime::Handle::current();
        let result = tokio::task::block_in_place(|| handle.block_on(me.finish_async()));
        result.map_err(|e| Box::new(e) as SinkError)
    }
}

impl FFmpegSink {
    async fn finish_async(&mut self) -> Result<(), FFmpegSinkError> {
        // Closing stdin signals EOF → FFmpeg flushes the encoder + writes
        // the trailer + exits.
        if let Some(mut stdin) = self.stdin.take() {
            let _ = stdin.shutdown().await;
            drop(stdin);
        }

        let wait_result = tokio::time::timeout(
            Duration::from_secs(EXPORT_FINISH_TIMEOUT_SECS),
            self.child.wait(),
        )
        .await;

        // Drain the stderr forwarder regardless of exit shape so the tail
        // captures any final error lines FFmpeg prints during teardown.
        if let Some(h) = self.stderr_handle.take() {
            let _ = h.await;
        }

        let stderr_tail = self.stderr_tail.lock().unwrap().tail();
        let frames_written = self.frames_written;

        match wait_result {
            Ok(Ok(status)) if status.success() => Ok(()),
            Ok(Ok(status)) => Err(FFmpegSinkError::EncoderFailed {
                exit_code: status.code(),
                stderr_tail,
                frames_written,
            }),
            Ok(Err(e)) => Err(FFmpegSinkError::Io(e)),
            Err(_) => {
                let _ = self.child.kill().await;
                Err(FFmpegSinkError::EncoderHang {
                    stderr_tail,
                    frames_written,
                })
            }
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

/// Bounded ring buffer of stderr lines, capped by total bytes. Kept
/// duplicated rather than reused from `orchestrator.rs` to avoid a
/// public-API dependency between sibling modules.
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
