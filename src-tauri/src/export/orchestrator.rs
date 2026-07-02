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
/// — recycling caps per-Page memory growth (Chrome holds allocations
/// across renders) so a 60-frame chunk doesn't spiral.
/// Tunable via `OrchestratorConfig::recycle_every`.
pub const RECYCLE_EVERY_FRAMES: u32 = 60;

const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const STDERR_TAIL_BYTES: usize = 4096;

// Sentinel worker_id used when a task panics. `JoinSet` does not expose which
// task panicked, so we cannot attribute panics or count-mismatch errors to a
// specific worker. Sentinel keeps the diagnostic honest rather than blaming
// worker 0.
const PANIC_UNKNOWN_WORKER_ID: usize = usize::MAX;

/// Rendering backend the worker should use. `None` in
/// [`OrchestratorConfig`] means "don't override" — the worker child
/// inherits the parent process env, so a `TRAILCUT_RENDERER_BACKEND` set on
/// the app (or shell) flows through untouched and the worker's own default
/// (native, since the Phase 5 cutover) applies otherwise. `Some(_)` pins
/// the backend explicitly on the child's env regardless of the parent env —
/// used by integration tests so backend selection never races through
/// process-global env mutation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RendererBackend {
    Chrome,
    Native,
}

impl RendererBackend {
    fn as_env_value(self) -> &'static str {
        match self {
            RendererBackend::Chrome => "chrome",
            RendererBackend::Native => "native",
        }
    }
}

pub struct OrchestratorConfig {
    pub worker_count: usize,
    pub recycle_every: u32,
    pub renderer_cjs_path: PathBuf,
    pub node_path: PathBuf,
    /// Path to the Chrome executable that the chromium renderer worker
    /// spawns via puppeteer-core. Always set; the orchestrator passes it
    /// to every worker via `TRAILCUT_CHROME_BIN`. Resolution lives here
    /// (not in the Node worker) because production must look at the Tauri
    /// bundle's `Resources/` directory and dev must look at
    /// `src-tauri/binaries/`, both filesystem concerns the worker shouldn't
    /// know about.
    pub chrome_path: PathBuf,
    /// Directory of the patched `@maplibre/maplibre-gl-native` binding the
    /// worker's NATIVE backend `require()`s. Same resolution philosophy as
    /// `chrome_path` (env override → Tauri `Resources/` → dev
    /// `src-tauri/binaries/`); always passed via `TRAILCUT_MBGL_NATIVE_DIR`
    /// — harmless when the backend is chrome. Provisioned by
    /// `npm run build:renderer` (sidecars/renderer/native/ensure-binding.mjs).
    pub mbgl_native_dir: PathBuf,
    /// Explicit backend pin for spawned workers; see [`RendererBackend`].
    pub renderer_backend: Option<RendererBackend>,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        Self {
            worker_count: default_worker_count(),
            recycle_every: RECYCLE_EVERY_FRAMES,
            renderer_cjs_path: PathBuf::from(manifest_dir)
                .join("sidecars")
                .join("renderer")
                .join("dist")
                .join("renderer.cjs"),
            node_path: PathBuf::from("node"),
            chrome_path: resolve_chrome(manifest_dir),
            mbgl_native_dir: resolve_mbgl_native(manifest_dir),
            renderer_backend: None,
        }
    }
}

// Default worker count.
//
// Map-frame rendering is embarrassingly parallel — each worker owns a
// disjoint frame range, the orchestrator already re-orders the (idx, bytes)
// pairs from a bounded mpsc into the sink in strict frame order. The
// per-frame cost is dominated by maplibre's render pipeline + GPU readback
// inside Chrome (CPU+GPU bound, single-threaded JS event loop per worker),
// so wall-clock scales close to linearly with worker count up to physical
// CPU saturation.
//
// Default: 2 workers. Each worker spawns its own headless Chrome (~500 MB
// RAM steady-state, ~150 MB more for the maplibre Map allocations). 2
// workers ≈ 1.3 GB which is comfortable on the 16 GB M-series machines
// we target. Override with TRAILCUT_RENDERER_WORKERS=N (clamped to
// 1..=available_parallelism).
fn default_worker_count() -> usize {
    if let Ok(s) = std::env::var("TRAILCUT_RENDERER_WORKERS") {
        if let Ok(n) = s.trim().parse::<usize>() {
            if n >= 1 {
                return n.min(max_reasonable_workers());
            }
        }
    }
    2.min(max_reasonable_workers())
}

fn max_reasonable_workers() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2)
        // Hard cap. Spawning more headless Chromes than physical perf
        // cores produces context-switch thrash and saturates the GPU
        // command queue without further wall-clock win. 8 is generous.
        .min(8)
}

// Path components from the unpacked Chrome dir to the actual executable.
// macOS ships browsers as .app bundles with the binary buried at
// `<App>.app/Contents/MacOS/<App>`. Task 130 will add Windows/Linux.
fn chrome_binary_relative() -> &'static [&'static str] {
    #[cfg(target_os = "macos")]
    {
        &[
            "Google Chrome for Testing.app",
            "Contents",
            "MacOS",
            "Google Chrome for Testing",
        ]
    }
    #[cfg(not(target_os = "macos"))]
    {
        &["chrome"]
    }
}

// Resolve the bundled Chrome binary. Three-tier lookup:
//
//   1. `TRAILCUT_CHROME_BIN` env var — explicit override, used by tests and
//      for ad-hoc dev with a non-default install.
//   2. Production layout — when the executable lives next to a Tauri bundle
//      Resources dir (`<exe>/../Resources/binaries/chrome-<triple>/...` on
//      macOS). Computed from `current_exe()`.
//   3. Dev layout — `<manifest>/binaries/chrome-<triple>/<inner>`, populated
//      by `npm run build:renderer` via @puppeteer/browsers.
//
// Returns the first candidate that exists. If none exist, returns the dev
// path (so the eventual `puppeteer.launch` error message points the developer
// at the location they need to populate).
//
// Chrome ships as a directory tree (.app bundle on macOS containing the
// binary plus frameworks, helper apps, and resources). We expose the path of
// the inner executable; the surrounding tree must travel with it. That's why
// this ships via `bundle.resources` (directory copy) rather than
// `bundle.externalBin` (single-file copy).
fn resolve_chrome(manifest_dir: &str) -> PathBuf {
    if let Ok(p) = std::env::var("TRAILCUT_CHROME_BIN") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }

    let triple = host_target_triple();
    let dirname = format!("chrome-{}", triple);
    let inner: Vec<&str> = chrome_binary_relative().to_vec();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(macos_dir) = exe.parent() {
            // <bundle>/Contents/MacOS/<exe> → <bundle>/Contents/Resources/binaries/...
            let mut resources_candidate = macos_dir
                .join("..")
                .join("Resources")
                .join("binaries")
                .join(&dirname);
            for seg in &inner {
                resources_candidate = resources_candidate.join(seg);
            }
            if resources_candidate.exists() {
                return resources_candidate;
            }
        }
    }

    let mut dev = PathBuf::from(manifest_dir).join("binaries").join(&dirname);
    for seg in &inner {
        dev = dev.join(seg);
    }
    dev
}

// Resolve the patched maplibre-gl-native binding directory for the worker's
// native backend. Same three-tier lookup as `resolve_chrome`:
//
//   1. `TRAILCUT_MBGL_NATIVE_DIR` env var — explicit override (tests, ad-hoc
//      dev with a non-default artifact).
//   2. Production layout — `<exe>/../Resources/binaries/mbgl-native-<triple>`
//      (task 130 ships the staged dir like the other sidecar binaries).
//   3. Dev layout — `<manifest>/binaries/mbgl-native-<triple>`, populated by
//      `npm run build:renderer` via native/ensure-binding.mjs.
//
// Returns the first candidate that exists, else the dev path so the worker's
// loud missing-binding error points the developer at the location to
// populate. The binding is a directory (npm-package layout: index.js +
// lib/node-v<ABI>/mbgl.node), not a single file.
fn resolve_mbgl_native(manifest_dir: &str) -> PathBuf {
    if let Ok(p) = std::env::var("TRAILCUT_MBGL_NATIVE_DIR") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }

    let dirname = format!("mbgl-native-{}", host_target_triple());

    if let Ok(exe) = std::env::current_exe() {
        if let Some(macos_dir) = exe.parent() {
            let resources_candidate = macos_dir
                .join("..")
                .join("Resources")
                .join("binaries")
                .join(&dirname);
            if resources_candidate.exists() {
                return resources_candidate;
            }
        }
    }

    PathBuf::from(manifest_dir).join("binaries").join(&dirname)
}

// Target triple of the current build, in the form Tauri uses for sidecar
// naming. Restricted to the platforms this app supports today (macOS arm64 +
// x86_64). Task 130 will add Windows triples.
fn host_target_triple() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "aarch64-apple-darwin"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "x86_64-apple-darwin"
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Fallback: keep compiling on unsupported hosts (CI or future Windows
        // dev) but use a sentinel path component so the missing-binary error
        // is recognizable. Task 130 supersedes this branch.
        "unsupported-host"
    }
}

/// Per-frame progress callback used by `render_map_frames`. Called with the
/// running output-frame count after each frame is written to the sink.
/// Channel-agnostic; the `render_export` command wraps a Tauri IPC channel.
pub type FrameProgress = Arc<dyn Fn(u32) + Send + Sync>;

/// Drive `config.worker_count` worker children to produce ordered RGBA frames
/// into `sink`. Returns the number of frames written on success.
pub async fn render_map_frames(
    setup: SetupPayload,
    total_frames: u32,
    config: OrchestratorConfig,
    mut sink: Box<dyn FrameSink>,
    on_progress: Option<FrameProgress>,
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
    // Interleaved (round-robin) assignment: worker `w` renders every frame
    // where `frame_index % n == w`. `stride == n`. See `worker_frame_indices`.
    let stride = n as u32;

    // Bounded channel: backpressure on workers when the ordering buffer fills.
    // PLAN.md §"Frame-pipeline ordering" — ~64 frames * N is enough to absorb
    // scheduling jitter without unbounded memory growth.
    let (tx, mut rx) = mpsc::channel::<(u32, Vec<u8>)>(64 * n);

    let fps = setup.fps;
    let recycle_every = config.recycle_every;
    let setup_line_bytes = setup_line(&setup)?;

    let mut set: JoinSet<Result<(), OrchestratorError>> = JoinSet::new();
    for worker_id in 0..n {
        let tx_clone = tx.clone();
        let setup_line_bytes = setup_line_bytes.clone();
        let node_path = config.node_path.clone();
        let renderer_cjs = config.renderer_cjs_path.clone();
        let chrome_path = config.chrome_path.clone();
        let mbgl_native_dir = config.mbgl_native_dir.clone();
        let renderer_backend = config.renderer_backend;
        set.spawn(async move {
            run_worker(
                worker_id,
                stride,
                total_frames,
                fps,
                recycle_every,
                setup_line_bytes,
                node_path,
                renderer_cjs,
                chrome_path,
                mbgl_native_dir,
                renderer_backend,
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
                            if let Some(cb) = &on_progress {
                                cb(emitted);
                            }
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

/// Frame indices assigned to worker `worker_id` under INTERLEAVED (round-robin)
/// assignment across `stride` workers: worker `w` renders `w, w+stride,
/// w+2*stride, ...` while `< total`.
///
/// Interleaving (vs. contiguous ranges) bounds the reorder buffer. Because the
/// drain loop must emit frames in strict ascending order and the map render is
/// the pipeline bottleneck (the sink rarely backpressures), a contiguous split
/// forces every frame a higher-numbered worker produces to park in the
/// `BTreeMap` until the lower-numbered workers finish their whole ranges — at
/// the midpoint that buffer holds ~`(N-1)/N` of ALL frames (RGBA, slot-sized),
/// an OOM risk on long high-res exports. With interleaving every worker stays
/// within ~N frames of the drain loop's `next_to_emit`, so the buffer holds at
/// most O(N) frames regardless of total length.
///
/// The union of `worker_frame_indices(w, n, total)` over `w in 0..n` is exactly
/// `0..total`, each index once — no gaps, no duplicates (the completeness
/// invariant `render_map_frames` enforces).
fn worker_frame_indices(worker_id: usize, stride: u32, total: u32) -> Vec<u32> {
    debug_assert!(stride > 0 && (worker_id as u32) < stride);
    ((worker_id as u32)..total)
        .step_by(stride as usize)
        .collect()
}

#[allow(clippy::too_many_arguments)]
async fn run_worker(
    worker_id: usize,
    stride: u32,
    total_frames: u32,
    fps: u32,
    recycle_every: u32,
    setup_line_bytes: String,
    node_path: PathBuf,
    renderer_cjs: PathBuf,
    chrome_path: PathBuf,
    mbgl_native_dir: PathBuf,
    renderer_backend: Option<RendererBackend>,
    frame_tx: mpsc::Sender<(u32, Vec<u8>)>,
) -> Result<(), OrchestratorError> {
    let mut command = Command::new(&node_path);
    command
        .arg(&renderer_cjs)
        .env("TRAILCUT_CHROME_BIN", &chrome_path)
        // Always passed; only the native backend reads it. Resolution lives
        // here for the same prod-vs-dev filesystem reason as chrome_path.
        .env("TRAILCUT_MBGL_NATIVE_DIR", &mbgl_native_dir);
    if let Some(backend) = renderer_backend {
        // Explicit pin (tests / programmatic override). When None, the
        // child inherits the parent env, so an app-level
        // TRAILCUT_RENDERER_BACKEND still selects the backend.
        command.env("TRAILCUT_RENDERER_BACKEND", backend.as_env_value());
    }
    let mut child = command
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
    for frame_index in worker_frame_indices(worker_id, stride, total_frames) {
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
        // "Last frame THIS worker will render": its strided indices end once
        // `frame_index + stride` would overflow `total_frames`. Don't recycle
        // after the final frame — the worker is about to shut down.
        let is_last = frame_index + stride >= total_frames;
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

    // Mirror the worker-count clamp `render_map_frames` applies before deriving
    // the stride, so coverage tests exercise the same `n` the orchestrator uses.
    fn clamp_workers(worker_count: usize, total: u32) -> usize {
        worker_count.max(1).min(total as usize)
    }

    #[test]
    fn worker_frame_indices_interleaves() {
        // n = 2: worker 0 -> evens, worker 1 -> odds.
        assert_eq!(worker_frame_indices(0, 2, 8), vec![0, 2, 4, 6]);
        assert_eq!(worker_frame_indices(1, 2, 8), vec![1, 3, 5, 7]);
        // n = 3 over 10 frames (3 does not divide 10).
        assert_eq!(worker_frame_indices(0, 3, 10), vec![0, 3, 6, 9]);
        assert_eq!(worker_frame_indices(1, 3, 10), vec![1, 4, 7]);
        assert_eq!(worker_frame_indices(2, 3, 10), vec![2, 5, 8]);
        // n = 1: the single worker renders the whole range, in order.
        assert_eq!(worker_frame_indices(0, 1, 5), vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn worker_frame_indices_are_congruent_mod_stride() {
        // Every index worker `w` renders satisfies `idx % n == w`.
        for n in 1u32..=6 {
            for w in 0..n {
                for idx in worker_frame_indices(w as usize, n, 50) {
                    assert_eq!(idx % n, w, "worker {w} (n={n}) got off-residue index {idx}");
                }
            }
        }
    }

    #[test]
    fn worker_assignment_is_complete_and_disjoint() {
        // For a range of (total, worker_count) pairs — including n not dividing
        // total, n == 1, and n clamped down to total — the union of every
        // worker's assigned indices is exactly `0..total`, each index once.
        let cases: &[(u32, usize)] = &[
            (8, 2),   // even split
            (10, 3),  // n does not divide total
            (7, 4),   // n does not divide total
            (5, 1),   // single worker
            (3, 8),   // worker_count > total: clamped to n == total
            (1, 1),   // single frame
            (100, 6), // larger, uneven
        ];
        for &(total, worker_count) in cases {
            let n = clamp_workers(worker_count, total);
            let stride = n as u32;
            let mut seen: Vec<u32> = Vec::new();
            for w in 0..n {
                seen.extend(worker_frame_indices(w, stride, total));
            }
            seen.sort_unstable();
            let expected: Vec<u32> = (0..total).collect();
            assert_eq!(
                seen, expected,
                "(total={total}, worker_count={worker_count}, n={n}) union must be 0..{total} exactly once",
            );
        }
    }

    #[test]
    fn worker_count_clamps_to_total_frames() {
        // When worker_count exceeds total_frames, n clamps to total so no
        // worker is assigned an empty range and the stride still tiles 0..total.
        let n = clamp_workers(8, 3);
        assert_eq!(n, 3);
        for w in 0..n {
            assert!(
                !worker_frame_indices(w, n as u32, 3).is_empty(),
                "clamped worker {w} should still own at least one frame",
            );
        }
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

    // Env-touching tests share process state, so serialize them to avoid
    // racing each other (cargo runs tests in parallel by default).
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_env<F: FnOnce()>(key: &str, value: Option<&str>, body: F) {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let prior = std::env::var(key).ok();
        match value {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
        body();
        match prior {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
    }

    #[test]
    fn default_renderer_path_points_at_renderer_sidecar() {
        let cfg = OrchestratorConfig::default();
        let s = cfg.renderer_cjs_path.to_string_lossy();
        assert!(
            s.ends_with("sidecars/renderer/dist/renderer.cjs"),
            "expected renderer path, got {s}"
        );
    }

    #[test]
    fn chrome_env_override_takes_priority() {
        with_env("TRAILCUT_CHROME_BIN", Some("/tmp/explicit-override/chrome"), || {
            let cfg = OrchestratorConfig::default();
            assert_eq!(
                cfg.chrome_path,
                PathBuf::from("/tmp/explicit-override/chrome"),
            );
        });
    }

    #[test]
    fn chrome_dev_path_when_no_env() {
        with_env("TRAILCUT_CHROME_BIN", None, || {
            let cfg = OrchestratorConfig::default();
            let s = cfg.chrome_path.to_string_lossy();
            // Dev layout: <manifest>/binaries/chrome-<triple>/<inner>.
            // Inner path is platform-specific; on macOS the binary lives
            // inside `Google Chrome for Testing.app/Contents/MacOS/...`.
            // Production resolution only fires inside a real Tauri bundle.
            assert!(
                s.contains("binaries/chrome-"),
                "expected dev path under binaries/chrome-<triple>/, got {s}",
            );
            #[cfg(target_os = "macos")]
            assert!(
                s.ends_with("/Google Chrome for Testing"),
                "expected macOS binary path, got {s}",
            );
        });
    }

    #[test]
    fn mbgl_native_env_override_takes_priority() {
        with_env("TRAILCUT_MBGL_NATIVE_DIR", Some("/tmp/explicit-override/mbgl"), || {
            let cfg = OrchestratorConfig::default();
            assert_eq!(
                cfg.mbgl_native_dir,
                PathBuf::from("/tmp/explicit-override/mbgl"),
            );
        });
    }

    #[test]
    fn mbgl_native_dev_path_when_no_env() {
        with_env("TRAILCUT_MBGL_NATIVE_DIR", None, || {
            let cfg = OrchestratorConfig::default();
            let s = cfg.mbgl_native_dir.to_string_lossy();
            // Dev layout: <manifest>/binaries/mbgl-native-<triple>/ — the
            // npm-package-shaped dir ensure-binding.mjs stages. Production
            // resolution only fires inside a real Tauri bundle.
            assert!(
                s.contains("binaries/mbgl-native-"),
                "expected dev path under binaries/mbgl-native-<triple>/, got {s}",
            );
        });
    }

    #[test]
    fn default_config_pins_no_backend() {
        // None = the worker child inherits the parent env; the worker's own
        // default — NATIVE since the Phase 5 cutover — applies otherwise.
        // The worker-side default itself is pinned in
        // sidecars/renderer/__tests__/backendSelect.test.ts.
        let cfg = OrchestratorConfig::default();
        assert_eq!(cfg.renderer_backend, None);
        assert_eq!(RendererBackend::Chrome.as_env_value(), "chrome");
        assert_eq!(RendererBackend::Native.as_env_value(), "native");
    }
}
