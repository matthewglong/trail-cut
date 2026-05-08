// Orchestrator: spawns N renderer-worker children, distributes a frame range
// across them, drains stdout in `frame_index` order, and writes ordered frames
// into a `FrameSink`.
//
// The worker source is the protocol's source of truth (task 020). This module
// drives the protocol; it does NOT reimplement worker-side logic — no per-
// frame derivation, no camera math, no style/layer specs live here.
//
// Per-worker pipeline = three tokio tasks:
//   1. The orchestrator task (this fn) writes commands to stdin and reads
//      ready/frame replies from stdout, in lockstep with the worker's state
//      machine (setup → ready → render → frame → ... → recycle → ready → ...
//      → shutdown).
//   2. A separate stderr-forwarder task copies the worker's stderr to the
//      parent process's stderr (prefixed with `[worker N]`) and retains the
//      last 4 KB in a ring for inclusion in error variants.
//
// Cross-worker frame ordering is handled by a single drain loop in
// `render_map_frames`: a bounded mpsc carries `(frame_index, bytes)` from
// each worker into a `BTreeMap` re-ordering buffer; the buffer is drained in
// strict frame-index order into the sink.

use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, Command};
use tokio::sync::mpsc;
use tokio::task::{JoinHandle, JoinSet};

use crate::export::error::OrchestratorError;
use crate::export::protocol::{
    read_frame, read_ready, recycle_line, render_line, setup_line, shutdown_line, SetupPayload,
};
use crate::export::sink::FrameSink;

/// Default per-worker recycle cadence. PLAN.md §"Renderer worker lifecycle"
/// — the native renderer retains ~130 MB per frame with no internal eviction,
/// so a 60-frame chunk holds ~7.8 GB without recycling. Tunable via
/// `OrchestratorConfig::recycle_every`.
pub const RECYCLE_EVERY_FRAMES: u32 = 60;

const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const STDERR_TAIL_BYTES: usize = 4096;

// Sentinel worker_id used when a task panics. `JoinSet` does not expose which
// task panicked, so we cannot attribute panics or count-mismatch errors to a
// specific worker. Sentinel keeps the diagnostic honest rather than blaming
// worker 0.
const PANIC_UNKNOWN_WORKER_ID: usize = usize::MAX;

pub struct OrchestratorConfig {
    pub worker_count: usize,
    pub recycle_every: u32,
    pub renderer_cjs_path: PathBuf,
    pub node_path: PathBuf,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        // Dev-mode resolution. Production sidecar lookup (per-platform binaries
        // bundled via Tauri's `bundle.externalBin`) is task 130's concern.
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        Self {
            worker_count: 1,
            recycle_every: RECYCLE_EVERY_FRAMES,
            renderer_cjs_path: PathBuf::from(manifest_dir)
                .join("sidecars")
                .join("renderer")
                .join("dist")
                .join("renderer.cjs"),
            node_path: PathBuf::from("node"),
        }
    }
}

/// Drive `config.worker_count` worker children to produce ordered RGBA frames
/// into `sink`. Returns the number of frames written on success.
pub async fn render_map_frames(
    setup: SetupPayload,
    total_frames: u32,
    config: OrchestratorConfig,
    mut sink: Box<dyn FrameSink>,
) -> Result<u32, OrchestratorError> {
    if total_frames == 0 {
        sink.finish().map_err(OrchestratorError::SinkError)?;
        return Ok(0);
    }
    if !config.renderer_cjs_path.exists() {
        return Err(OrchestratorError::BundleMissing {
            path: config.renderer_cjs_path.display().to_string(),
        });
    }

    let n = config.worker_count.max(1).min(total_frames as usize);
    let ranges = split_range(total_frames, n);

    // Bounded channel: backpressure on workers when the ordering buffer fills.
    // PLAN.md §"Frame-pipeline ordering" — ~64 frames * N is enough to absorb
    // scheduling jitter without unbounded memory growth.
    let (tx, mut rx) = mpsc::channel::<(u32, Vec<u8>)>(64 * n);

    let fps = setup.fps;
    let recycle_every = config.recycle_every;
    let setup_line_bytes = setup_line(&setup)?;

    let mut set: JoinSet<Result<(), OrchestratorError>> = JoinSet::new();
    for (worker_id, range) in ranges.into_iter().enumerate() {
        let tx_clone = tx.clone();
        let setup_line_bytes = setup_line_bytes.clone();
        let node_path = config.node_path.clone();
        let renderer_cjs = config.renderer_cjs_path.clone();
        set.spawn(async move {
            run_worker(
                worker_id,
                range,
                fps,
                recycle_every,
                setup_line_bytes,
                node_path,
                renderer_cjs,
                tx_clone,
            )
            .await
        });
    }
    drop(tx); // close our copy so rx.recv() returns None when all workers are gone

    let mut next_to_emit: u32 = 0;
    let mut buffer: BTreeMap<u32, Vec<u8>> = BTreeMap::new();
    let mut emitted: u32 = 0;
    let mut first_error: Option<OrchestratorError> = None;

    loop {
        tokio::select! {
            // Bias toward worker completions: surface errors fast so siblings abort.
            biased;

            join_result = set.join_next(), if !set.is_empty() => {
                match join_result {
                    Some(Ok(Ok(()))) => {}
                    Some(Ok(Err(e))) => {
                        if first_error.is_none() {
                            first_error = Some(e);
                        }
                        set.abort_all();
                    }
                    Some(Err(je)) if je.is_cancelled() => {}
                    Some(Err(je)) => {
                        if first_error.is_none() {
                            first_error = Some(OrchestratorError::ProtocolError {
                                worker_id: PANIC_UNKNOWN_WORKER_ID,
                                reason: format!("worker task panicked: {}", je),
                            });
                        }
                        set.abort_all();
                    }
                    None => {}
                }
            }

            maybe = rx.recv() => {
                match maybe {
                    Some((idx, bytes)) => {
                        buffer.insert(idx, bytes);
                        while let Some(b) = buffer.remove(&next_to_emit) {
                            if let Err(e) = sink.write_frame(next_to_emit, &b) {
                                if first_error.is_none() {
                                    first_error = Some(OrchestratorError::SinkError(e));
                                }
                                set.abort_all();
                                break;
                            }
                            next_to_emit += 1;
                            emitted += 1;
                        }
                    }
                    None => {
                        // All worker senders dropped — drain remaining JoinSet, then exit.
                        while let Some(join_result) = set.join_next().await {
                            match join_result {
                                Ok(Ok(())) => {}
                                Ok(Err(e)) => {
                                    if first_error.is_none() {
                                        first_error = Some(e);
                                    }
                                }
                                Err(je) if je.is_cancelled() => {}
                                Err(je) => {
                                    if first_error.is_none() {
                                        first_error = Some(OrchestratorError::ProtocolError {
                                            worker_id: PANIC_UNKNOWN_WORKER_ID,
                                            reason: format!("worker task panicked: {}", je),
                                        });
                                    }
                                }
                            }
                        }
                        break;
                    }
                }
            }
        }
    }

    if let Some(e) = first_error {
        return Err(e);
    }
    if emitted < total_frames {
        return Err(OrchestratorError::ProtocolError {
            worker_id: PANIC_UNKNOWN_WORKER_ID,
            reason: format!("expected {} frames, emitted {}", total_frames, emitted),
        });
    }
    sink.finish().map_err(OrchestratorError::SinkError)?;
    Ok(emitted)
}

/// Pre-split `0..total` into `n` contiguous ranges. The last range absorbs any
/// remainder. Pre-split (vs. work-stealing) is chosen for simplicity and
/// reproducibility — per-frame render time dominates scheduling jitter at the
/// granularities we care about.
fn split_range(total: u32, n: usize) -> Vec<std::ops::Range<u32>> {
    debug_assert!(n > 0 && total > 0);
    let n_u = n as u32;
    let chunk = total / n_u;
    let remainder = total % n_u;
    let mut out = Vec::with_capacity(n);
    let mut start = 0u32;
    for i in 0..n_u {
        let extra = if i + 1 == n_u { remainder } else { 0 };
        let end = start + chunk + extra;
        out.push(start..end);
        start = end;
    }
    out
}

#[allow(clippy::too_many_arguments)]
async fn run_worker(
    worker_id: usize,
    range: std::ops::Range<u32>,
    fps: u32,
    recycle_every: u32,
    setup_line_bytes: String,
    node_path: PathBuf,
    renderer_cjs: PathBuf,
    frame_tx: mpsc::Sender<(u32, Vec<u8>)>,
) -> Result<(), OrchestratorError> {
    let mut child = Command::new(&node_path)
        .arg(&renderer_cjs)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| OrchestratorError::WorkerSpawnFailed { worker_id, source: e })?;

    let mut stdin = child.stdin.take().expect("piped");
    let stdout = child.stdout.take().expect("piped");
    let stderr = child.stderr.take().expect("piped");
    let mut stdout_reader = BufReader::new(stdout);

    let stderr_tail = Arc::new(Mutex::new(StderrRing::new(STDERR_TAIL_BYTES)));
    let stderr_handle = {
        let tail = stderr_tail.clone();
        tokio::spawn(forward_stderr(worker_id, stderr, tail))
    };

    // ---- Setup ----
    if let Err(e) = stdin.write_all(setup_line_bytes.as_bytes()).await {
        return Err(finalize_worker_error(
            worker_id,
            OrchestratorError::Io(e),
            child,
            stderr_tail,
            stderr_handle,
        )
        .await);
    }
    if let Err(e) = read_ready(&mut stdout_reader).await {
        return Err(finalize_worker_error(
            worker_id,
            OrchestratorError::ProtocolError {
                worker_id,
                reason: format!("setup ready: {}", e),
            },
            child,
            stderr_tail,
            stderr_handle,
        )
        .await);
    }

    // ---- Render loop with recycle insertions ----
    //
    // If a sibling worker fails, the orchestrator calls `set.abort_all()`,
    // which cancels this task at its next `.await` point — usually inside
    // `stdin.write_all`, `read_frame`, or `frame_tx.send`. Cancellation drops
    // the `Child`, which fires `kill_on_drop(true)` and SIGKILLs the worker.
    // We don't try to send a graceful `shutdown` in the abort path: cancellation
    // unwinds before we'd reach it, and SIGKILL is sufficient cleanup since
    // the worker holds no on-disk state.
    let mut since_recycle: u32 = 0;
    for frame_index in range.clone() {
        let project_time_ms = (frame_index as u64) * 1000 / (fps as u64);
        let cmd = match render_line(frame_index, project_time_ms) {
            Ok(s) => s,
            Err(e) => {
                return Err(finalize_worker_error(
                    worker_id,
                    OrchestratorError::Serde(e),
                    child,
                    stderr_tail,
                    stderr_handle,
                )
                .await);
            }
        };
        if let Err(e) = stdin.write_all(cmd.as_bytes()).await {
            return Err(finalize_worker_error(
                worker_id,
                OrchestratorError::Io(e),
                child,
                stderr_tail,
                stderr_handle,
            )
            .await);
        }
        let frame = match read_frame(&mut stdout_reader).await {
            Ok(f) => f,
            Err(e) => {
                return Err(finalize_worker_error(
                    worker_id,
                    OrchestratorError::ProtocolError {
                        worker_id,
                        reason: format!("read frame {}: {}", frame_index, e),
                    },
                    child,
                    stderr_tail,
                    stderr_handle,
                )
                .await);
            }
        };
        if frame_tx.send((frame_index, frame)).await.is_err() {
            // The drain receiver is owned by `render_map_frames` for the
            // function's full duration, so a real-world `Err` here is unlikely
            // (it would mean the orchestrator unwound while the worker was
            // mid-frame). If it ever fires, exit the range loop and let the
            // graceful shutdown path run; the orchestrator's `first_error` is
            // already populated with the cause.
            break;
        }

        since_recycle += 1;
        let is_last = frame_index + 1 == range.end;
        if since_recycle >= recycle_every && !is_last {
            if let Err(e) = stdin.write_all(recycle_line().as_bytes()).await {
                return Err(finalize_worker_error(
                    worker_id,
                    OrchestratorError::Io(e),
                    child,
                    stderr_tail,
                    stderr_handle,
                )
                .await);
            }
            if let Err(e) = read_ready(&mut stdout_reader).await {
                return Err(finalize_worker_error(
                    worker_id,
                    OrchestratorError::ProtocolError {
                        worker_id,
                        reason: format!("recycle ready after frame {}: {}", frame_index, e),
                    },
                    child,
                    stderr_tail,
                    stderr_handle,
                )
                .await);
            }
            since_recycle = 0;
        }
    }

    // ---- Shutdown ----
    let _ = stdin.write_all(shutdown_line().as_bytes()).await;
    drop(stdin);

    let exit = tokio::time::timeout(SHUTDOWN_TIMEOUT, child.wait()).await;
    let status = match exit {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            let _ = stderr_handle.await;
            return Err(OrchestratorError::Io(e));
        }
        Err(_) => {
            let _ = child.kill().await;
            let _ = stderr_handle.await;
            return Err(OrchestratorError::Timeout {
                stage: format!("worker {} shutdown", worker_id),
            });
        }
    };
    let _ = stderr_handle.await;

    if !status.success() {
        let tail = stderr_tail.lock().unwrap().tail();
        return Err(OrchestratorError::WorkerExitedEarly {
            worker_id,
            code: status.code(),
            stderr_tail: tail,
        });
    }

    Ok(())
}

/// Kill the child, wait briefly for exit, drain stderr forwarder. If the
/// worker exited non-zero, prefer the `WorkerExitedEarly` variant (it carries
/// the stderr tail, which is usually more diagnostic than the protocol-level
/// symptom). Otherwise return the primary error.
async fn finalize_worker_error(
    worker_id: usize,
    primary: OrchestratorError,
    mut child: tokio::process::Child,
    stderr_tail: Arc<Mutex<StderrRing>>,
    stderr_handle: JoinHandle<()>,
) -> OrchestratorError {
    let _ = child.kill().await;
    let exit = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    let _ = stderr_handle.await;
    match exit {
        Ok(Ok(status)) if !status.success() => OrchestratorError::WorkerExitedEarly {
            worker_id,
            code: status.code(),
            stderr_tail: stderr_tail.lock().unwrap().tail(),
        },
        _ => primary,
    }
}

async fn forward_stderr(worker_id: usize, stderr: ChildStderr, tail: Arc<Mutex<StderrRing>>) {
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                eprint!("[worker {}] {}", worker_id, line);
                tail.lock().unwrap().push(&line);
            }
            Err(_) => break,
        }
    }
}

/// Bounded ring buffer of stderr lines, capped by total bytes.
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
    fn split_range_distributes_evenly() {
        assert_eq!(split_range(8, 2), vec![0..4, 4..8]);
        assert_eq!(split_range(10, 5), vec![0..2, 2..4, 4..6, 6..8, 8..10]);
        assert_eq!(split_range(1, 1), vec![0..1]);
    }

    #[test]
    fn split_range_remainder_to_last() {
        assert_eq!(split_range(7, 2), vec![0..3, 3..7]);
        assert_eq!(split_range(10, 3), vec![0..3, 3..6, 6..10]);
        assert_eq!(split_range(5, 2), vec![0..2, 2..5]);
    }

    #[test]
    fn stderr_ring_evicts_old_lines() {
        let mut ring = StderrRing::new(10);
        ring.push("aaaa\n");
        ring.push("bbbb\n");
        ring.push("cccc\n");
        // 5 + 5 + 5 = 15 > cap 10; oldest should be evicted.
        let tail = ring.tail();
        assert!(!tail.contains("aaaa"));
        assert!(tail.contains("cccc"));
    }
}
