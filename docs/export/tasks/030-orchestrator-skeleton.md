# Task 030 — Rust orchestrator skeleton (spawn + frame distribution + ordering)

**Step**: Export pipeline (the layer that drives the renderer worker)
**Estimated effort**: ~1 day (6–10h)
**Status**: done
**Depends on**: [020 — Renderer worker (Node + maplibre-native + stdio protocol)](./020-renderer-worker.md). 030 spawns the worker bundle 020 produces and drives its protocol; without 020 there is nothing to orchestrate.

## Goal

Build the Rust-side orchestrator that spawns N renderer-worker children, distributes a frame range across them, drains stdout in `frame_index` order, and writes ordered frames into a `FrameSink` (a trait that's stubbed for v1 and gets the real FFmpeg implementation in task 060). The orchestrator owns process lifecycle, the recycle loop, error surface, and ordering — the worker side stays oblivious to multi-worker concerns.

**The load-bearing invariant — the orchestrator drives the protocol; it does not reimplement it.** Every wire decision (frame format, recycle cadence semantics, ready-handshake shape, malformed-JSON handling) is defined by 020 and the worker source. The orchestrator's tests assert the wire format end-to-end against the real worker bundle — there is no second "Rust-side mock worker" reimplementing the contract. This is the analogue of 020's visual-parity invariant: orchestration logic must not duplicate worker-side logic.

This task ships the orchestrator module, the `FrameSink` trait, and a Tauri command that exposes orchestration to the frontend. FFmpeg integration — the real `FrameSink` impl that pipes ordered RGBA into an encoder — is task 060. Per-platform sidecar packaging (locating `node` and `renderer.cjs` in shipped builds) is task 130. The on-disk tile cache is spun out as task 035.

## Files to touch

- New: `src-tauri/src/export/mod.rs` — re-exports the public surface (`render_map_frames`, `FrameSink`, `OrchestratorError`, `OrchestratorConfig`).
- New: `src-tauri/src/export/orchestrator.rs` — spawn loop, frame-range splitter, stdout drainer, ordering buffer, recycle scheduler. The bulk of the task lives here.
- New: `src-tauri/src/export/protocol.rs` — wire types: `SetupPayload` (a thin wrapper over an opaque `serde_json::Value` for the project-state fields plus typed `viewport`/`fps`), the four command shapes (`setup`/`render`/`recycle`/`shutdown`) as serializers, and the stdout reader (length-prefixed frames + line-delimited ready replies). Mirrors the JS `StdoutReader` from `__tests__/protocol.test.ts` — translate, don't redesign.
- New: `src-tauri/src/export/sink.rs` — `FrameSink` trait + `VecSink` (test-only collector). The trait is the seam 060 plugs FFmpeg into.
- New: `src-tauri/src/commands/export.rs` — the Tauri command `render_map_frames` (narrow scope; does not yet take `channel` / `output_path` — that's 060's wrapper). Discoverable via `commands::*` re-export.
- New: `src-tauri/tests/orchestrator.rs` — integration test. Spawns the real bundled worker, drives via the orchestrator, asserts frame count + ordering + recycle behavior. Gated like 020's renderer test: requires `npm run build:renderer` to have run; refuses if `dist/renderer.cjs` is missing.
- Modified: `src-tauri/src/lib.rs` — `mod export;`, register the new command in `tauri::generate_handler![...]`.
- Modified: `src-tauri/src/commands.rs` (or new `commands/mod.rs` if commands are split) — re-export the new export command. The current commands.rs is single-file; minimal change is to add the command file as a sibling and import it.
- Modified: `src-tauri/Cargo.toml` — add `tokio` (features: `process`, `io-util`, `sync`, `rt-multi-thread`, `macros`), `thiserror` (for `OrchestratorError`). `serde` and `serde_json` already present.
- Modified: `docs/export/tasks/README.md` — flip 030 to ✅ on completion (already 🟡 to mark in-progress); link this file from the table.
- Untouched in this task: any FFmpeg code, any frontend code (the command exists for the frontend to call but no frontend caller is wired in 030 — that arrives in 060/090).

## Deliverables

A Rust module at `src-tauri/src/export/` that, given a setup payload and a frame count, drives N worker children to produce ordered RGBA frames into a `FrameSink`:

1. **Spawn.** `render_map_frames(setup, total_frames, config, sink)` spawns `config.worker_count` children via `tokio::process::Command::new(config.node_path).arg(config.renderer_cjs_path)`, with stdin/stdout/stderr piped. Each child receives the same setup payload and the same `{"ready":true}` handshake. Workers are spawned in parallel (futures joined); the orchestrator waits for all `ready` replies before sending any render commands. Stderr is forwarded line-by-line to the parent process's stderr (prefixed with `[worker N]`) for diagnostics.

2. **Frame-range split.** Frames `0..total_frames` are pre-split into `worker_count` contiguous ranges by integer division; the last worker absorbs any remainder. No work-stealing in v1 — pre-split is simpler, reproducible, and the dominant cost is per-frame render time, not scheduling jitter. Each worker is sent its range as a sequence of `{"cmd":"render","frame_index":N,"project_time_ms":T}` lines, with `T = floor(N * 1000 / fps)`. (Project-time math lives in the orchestrator, not the worker — the worker is a pure function of `(frame_index, project_time_ms)`.)

3. **Recycle loop.** Every `config.recycle_every` frames per worker (default `RECYCLE_EVERY_FRAMES = 60`, matching PLAN.md §"Renderer worker lifecycle"), the orchestrator inserts a `{"cmd":"recycle"}` command and waits for the worker's `{"ready":true}` reply before continuing that worker's range. Recycle cadence is per-worker, not global — workers progress independently within their ranges.

4. **Ordering.** Each worker's stdout produces frames in the order it received their render commands (020 §"Frame ordering inside a worker is implicit"). The orchestrator tags each incoming frame with its `frame_index` (known from the dispatch order to that worker) and routes it through a bounded ordering buffer. Frames are written to the sink in strict `frame_index` order: `0, 1, 2, ..., total_frames-1`. The buffer is bounded at `64 * worker_count` slots to absorb scheduling jitter without unbounded memory growth (PLAN.md §"Frame-pipeline ordering").

5. **Shutdown.** After a worker's range is exhausted, the orchestrator sends `{"cmd":"shutdown"}` and waits for clean exit (code 0) with a 5s timeout, escalating to SIGKILL on timeout. After all workers exit, the sink's `finish()` is called and the function returns `Ok(())`.

6. **Error surface.** `OrchestratorError` (via `thiserror`) covers: `WorkerSpawnFailed`, `WorkerExitedEarly { worker_id, code, stderr_tail }`, `ProtocolError { worker_id, reason }` (e.g. malformed ready reply, frame length mismatch), `SinkError(Box<dyn Error>)`, `Timeout { stage }`. On any error mid-export the orchestrator cancels remaining workers (SIGKILL the children, abort the task), surfaces the first error, and returns. No restart-on-crash in v1 — export is idempotent at the command level (the user retries).

7. **Tauri command.** `#[tauri::command] async fn render_map_frames(setup: serde_json::Value, total_frames: u32, fps: u32) -> Result<u32, String>` — for v1 the command writes to a `VecSink` and returns the frame count rendered. The frontend caller doesn't exist yet; the command is the surface 060 will wrap with `channel`/`output_path` once a real `FrameSink` (FFmpeg) lands. Returning frame count instead of pixel data keeps the command useful as a smoke test without serializing megabytes back over the Tauri bridge.

## Acceptance criteria

- [ ] `cargo build` (in `src-tauri`) succeeds with the new module wired into `lib.rs` and the new command registered.
- [ ] `cargo clippy --all-targets -- -D warnings` (in `src-tauri`) is clean.
- [ ] **Integration test passes** (`cargo test --test orchestrator`). The test:
  - Refuses to run with a clear error if `src-tauri/sidecars/renderer/dist/renderer.cjs` is missing (mirrors 020's `beforeAll` guard).
  - Builds the same synthetic setup payload as `__tests__/protocol.test.ts` (1 clip, 2s duration, 3-trackpoint route, `viewport: {w:540,h:960}`, `fps:30`).
  - Runs `render_map_frames` with `worker_count=1`, `total_frames=4`, `recycle_every=2` — forces a recycle mid-test. Asserts: 4 frames written to the sink, in order `0..4`, each frame is `540*960*4 = 2_073_600` bytes, none all-zero.
  - Runs the same setup with `worker_count=2`, `total_frames=8`, `recycle_every=4`. Asserts: 8 frames written in order `0..8` despite arriving from two workers in parallel; no frame missing, no duplicates.
- [ ] **Unit test for the protocol reader** (`cargo test --lib export::protocol`). Constructs a `Cursor<Vec<u8>>` containing `[length prefix][N bytes][\n-terminated ready line][length prefix][N bytes]`, asserts the reader correctly demuxes frames and ready replies in order. This test does not spawn a worker — it's a pure protocol-decode test, fast.
- [ ] **No reimplementation of worker-side logic.** Grep at acceptance time:
  - `grep -rE "buildPerFrameState|cameraAt|buildStyleSpec" src-tauri/src/` returns nothing — the orchestrator does not call into per-frame derivation; that's the worker's job.
  - `grep -rE "addLayer|setPaintProperty" src-tauri/src/` returns nothing.
- [ ] **Worker bundle resolved cleanly.** The default `OrchestratorConfig::default()` resolves `renderer_cjs_path` via `CARGO_MANIFEST_DIR/sidecars/renderer/dist/renderer.cjs`. Production packaging (per task 130) is documented as a follow-up; v1 ships dev-only path resolution.
- [ ] `npm run test:run` and `npm run build` continue to pass (no frontend changes in 030, but ensure nothing breaks).
- [ ] `docs/export/tasks/README.md` row 030 flipped to ✅ and linking this file.

## Implementation notes

**Why tokio, not std::process.** Existing commands (FFmpeg, ExifTool) use `std::process::Command::output()` — fire-and-forget, blocking, no interactive I/O. The orchestrator is structurally different: N long-running children, line-delimited stdin streamed over the lifetime of the export, binary stdout drained concurrently with stderr forwarding, with timeouts on each protocol step. Doing this with `std::sync` and threads-per-worker works but turns into a thicket of channels and join handles. Tauri 2's async runtime is already tokio under the hood (`tauri::async_runtime`), so adopting tokio in the export module is essentially free — no new runtime, just enabling the `process`/`io-util`/`sync` features. The rest of the codebase keeps using `std::process` because its workloads don't need this; the export module is the exception.

**`FrameSink` trait shape.** The seam between "ordered frames out of the orchestrator" and "bytes into FFmpeg" (or anything else):

```rust
pub trait FrameSink: Send {
    fn write_frame(&mut self, frame_index: u32, rgba: &[u8]) -> Result<(), SinkError>;
    fn finish(self: Box<Self>) -> Result<(), SinkError>;
}
```

`finish` consumes `self` so an FFmpeg sink can close stdin and wait for the encoder's exit. The orchestrator owns the sink and drives both methods; callers never touch FrameSink directly. v1 ships `VecSink` (test collector). 060 adds `FFmpegSink`. The trait is intentionally minimal — frame index lets the sink choose to ignore it (FFmpeg in `-f rawvideo` mode does), but it's there for sinks that need it (debug dumps, parity-comparison tooling in 120).

**Why opaque `serde_json::Value` for the project-state fields.** The setup payload carries `timeline: CompiledTimeline`, `route: Route`, `clips: Clip[]`, `mapSettings: MapSettings`. `CompiledTimeline` is a TypeScript-only construct (output of `compileTimeline` in `src/lib/cameraIntent.ts`) — defining a Rust mirror of it would force a second source of truth that drifts every time camera intent evolves. `Clip`/`Route`/`MapSettings` already have Rust models in `models.rs`, but the orchestrator doesn't read these fields — it only forwards them to the worker. Pass-through as `serde_json::Value` is correct: Rust enforces the wrapping shape (`viewport`, `fps`) and forwards the rest opaquely. The worker is the parser. If a field changes shape, the worker breaks; the orchestrator stays oblivious.

**Frame ordering buffer.** Per-worker channels carry `(frame_index, frame_bytes)` to a single drain task. The drain task maintains `next_to_emit: u32 = 0` and a `BTreeMap<u32, Vec<u8>>` of out-of-order frames. On each receive, it inserts into the map, then drains contiguous frames starting at `next_to_emit` into the sink. Cap the map size at `64 * worker_count` (PLAN.md §"Frame-pipeline ordering") — backpressure on a worker's send if the global buffer is full. With N=1 the buffer is trivially always-in-order; with N>1 it absorbs the case where a slow worker's range starts at frame 0 and a fast worker's range starts at frame 100, and frame 100 arrives before frame 0.

**Per-worker pipeline.** Three tokio tasks per worker: (1) **stdin writer** — sends setup, then iterates the worker's frame range writing render commands (with recycle inserted every `recycle_every` frames), then sends shutdown; (2) **stdout reader** — alternates between reading a ready line (after setup/recycle) and a length-prefixed frame (after render), tagging each frame with its expected `frame_index` from the dispatched order; (3) **stderr forwarder** — line-by-line copy to parent stderr with `[worker N]` prefix. The reader and writer coordinate via a tiny state machine (`Expecting::Ready` vs `Expecting::Frame`) — same demux logic as the JS `StdoutReader` in `__tests__/protocol.test.ts`. The two-task split (separate reader from writer) is necessary because the worker's setup/recycle ready replies interleave with frame writes; a single task that alternates reads and writes would deadlock.

**Resolving `renderer.cjs` and `node`.** Dev-mode resolution: `OrchestratorConfig::default()` returns `renderer_cjs_path = CARGO_MANIFEST_DIR/sidecars/renderer/dist/renderer.cjs`, `node_path = "node"` (PATH lookup). Both are fields on the config so tests and production callers can override. Production packaging (per-platform sidecar binaries via Tauri's `bundle.externalBin`) is task 130's concern; this task documents the dev path and leaves a TODO comment in `default()`. The integration test verifies the bundle exists and asserts a clear error message when it doesn't — same UX as 020's `beforeAll` guard.

**Project-time computation.** `project_time_ms = (frame_index * 1000) / fps` using integer division. For 30fps this gives `0, 33, 66, 100, 133, ...` (with the off-by-one rounding deliberately not "fixed" — `cameraAt(t)` is continuous over `t`, so a 1ms quantization is invisible). Computing `t` in the orchestrator (not the worker) means the worker stays a pure function of `(frame_index, t)` — no `fps` knowledge, no rounding policy, just "render this exact `t`." If we ever change the time-quantization policy (e.g. fractional ms for VFR), it's a one-line change in the orchestrator.

**Why the Tauri command is narrow in 030.** PLAN.md §"IPC contract" defines `invoke('render_export', { channel, output_path, layout, ... })` — the full surface. 030 ships `render_map_frames` (no channel, no output_path, no layout): it returns the rendered frame count via a `VecSink`. The full `render_export` requires a `FrameSink` impl that pipes into FFmpeg, which doesn't exist until 060. Splitting the command in two avoids a "command exists but the channel/output_path args do nothing" footgun for 060. 060's deliverable will rename or wrap `render_map_frames` into the public `render_export`.

**Recycle K is a constant, not a runtime knob.** PLAN.md says K=60 (~2s at 30fps); 020 wires this into the worker as the orchestrator's responsibility. Define `pub const RECYCLE_EVERY_FRAMES: u32 = 60;` in the orchestrator module. `OrchestratorConfig` has a `recycle_every: u32` field defaulting to that constant — tests can override (the test uses `recycle_every: 2` to force a recycle in a 4-frame run). Keeping it tunable lets us measure the memory/wall-clock tradeoff once we have a real harness; keeping it at 60 by default matches PLAN.md's empirical sizing.

**Worker exit semantics.** A worker that crashes mid-render (its child exits non-zero) propagates as `OrchestratorError::WorkerExitedEarly`. The orchestrator's stderr forwarder retains the last 4KB of each worker's stderr in a ring buffer; on early exit, that tail is included in the error variant for the user-facing diagnostic. Workers should never exit non-zero in normal operation — they only crash on contract violations (malformed JSON from us) or render errors (network/tile failures, native binding bugs). Either way, the export fails fast.

**Test scope.** The integration test exercises the orchestrator end-to-end against the real worker bundle — it's structurally analogous to 020's renderer protocol test. It does NOT test the FFmpeg sink, the full `render_export` surface, or any frontend wiring; those land in 060/090. It also does NOT load-test parallelism (e.g. N=8) — that's a measurement task, not an acceptance criterion. The N=2 case is a smoke test for the ordering buffer's correctness, not a perf gate.

## Open questions deferred to follow-up tasks

- **On-disk tile cache.** PLAN.md §"Renderer architecture" → "Determinism" wants tile fetches routed through a hash-based on-disk cache. Currently the worker's `request()` callback is a network-only stub (020 §"Tile cache deferral"). Spinning out as **task 035** rather than folding into 030: the cache is worker-side (lives in the `request()` callback), not orchestrator-side, and a clean implementation needs a small bit of design (cache key derivation, eviction policy, location under `~/.trailcut/`) that doesn't belong inside an orchestration task.
- **Pre-warming tiles before frame loop.** Walk the camera path once, fetch all tiles into the cache, then start rendering. Orchestrator-side optimization, but only useful once 035's cache exists. Task 035 or a follow-up to it.
- **Frame deduplication for static-camera spans.** When `cameraAt(t)` returns the same camera over a span, the orchestrator can render once and write the same bytes for `K` consecutive frame indices. Orchestrator-side optimization; deferred. PLAN.md §"Performance considerations" #4.
- **Production sidecar resolution.** Task 130 owns finding `node-<target-triple>` and `renderer-<target-triple>.cjs` in the bundled app via Tauri's `bundle.externalBin`. v1 of 030 uses dev paths.
- **Adaptive worker count.** v1 ships N=1 in production config and supports N>1 in code. A future task can pick N based on CPU count + memory pressure. Out of scope here.
- **Cancellation from the frontend.** A user clicking "Cancel Export" mid-run needs a cancel token threaded through the orchestrator. Tauri has patterns for this (state + AbortHandle); not in 030 because no frontend caller exists yet. Will land alongside 060 when the export-progress UI is real.
- **Progress events.** Emitting `tauri::Window::emit("export-progress", { frame, total })` from the drain task. Same reasoning as cancellation — wait for the UI in 060/090.

## Doc tie-in

- PLAN.md §"Renderer architecture" → "Process model" / "Parallelism strategy" / "Frame-pipeline ordering" — this task implements the Rust side of that architecture. Worker side is 020.
- PLAN.md §"IPC contract" → Rust → renderer worker — the wire format the orchestrator drives. Any divergence between this doc and the worker source is a worker-source bug; 020 is the protocol's source of truth.
- 020 §"Frame ordering inside a worker is implicit" — informs the orchestrator's per-worker-sequential / cross-worker-ordered design.
- LAYOUT.md §5 (map render viewport) — the orchestrator passes `viewport` straight through; doesn't compute slot dims itself. Slot dims arrive from the frontend in 060/090's full `render_export` surface.
- After 030 lands, the worker bundle has a Rust driver that produces ordered RGBA into a sink. Task 040 (encoder probing) and 060 (Channel B end-to-end) plug a real FFmpeg `FrameSink` into the same orchestrator with no orchestrator-side changes.
