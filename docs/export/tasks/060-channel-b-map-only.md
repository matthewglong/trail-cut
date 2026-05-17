# Task 060 — Channel B (map-only) end-to-end

**Step**: Export pipeline (first concrete channel — orchestrator → FFmpeg → file on disk)
**Estimated effort**: ~1.5 days (10–14h)
**Status**: pending
**Depends on**: 030 (orchestrator + `FrameSink` seam), 040 (`select_encoder(EncoderClass::ProResAlpha)`), 050 (`LayoutDescriptor`, `resolve_slots`).

## Goal

Ship the first end-to-end export channel: render the map at its layout-assigned slot dimensions through the existing orchestrator, position it on a full-output-aspect transparent canvas at the slot's rect with an antialiased corner-radius alpha mask, encode as ProRes 4444 in `.mov` with alpha, and write the file at `output_path`. After this task:

- A new `FFmpegSink` implementation of the `FrameSink` trait spawns FFmpeg with the right filtergraph + encoder args, writes RGBA frames into stdin in order, and waits for exit + flush on `finish()`. The orchestrator-side code is unchanged.
- A new Tauri command `render_export` (variant: `channel = "map_only"`) drives the orchestrator with an `FFmpegSink` instead of `VecSink`, accepting a `LayoutDescriptor` and computing the map render viewport from `resolved.map_slot`.
- A minimal "Export map-only (.mov)" button in the frontend kicks off the command for the current project at the project's currently-configured 9:16 layout (or the default layout if none configured), writes to a user-picked path.
- A passing integration test produces a real `.mov` from a fixture project, asserts FFprobe reports the expected `(width, height, codec, pixel format with alpha, duration)`.

This is the first task that puts pixels on disk. Channels C (070) and A (090) reuse the FFmpegSink scaffolding; their additional complexity is the per-clip video filter chain (070) and compositing two streams (090). 060 is deliberately the simplest channel — single rawvideo input, single overlay, single encoder pass — so that the FFmpeg-sink seam can be exercised, debugged, and stabilized before the more complex channels build on top of it.

**The load-bearing invariant — full-frame canvas with content positioned at slot, alpha=0 elsewhere.** LAYOUT.md §6's "masked positional export" semantics are non-negotiable: B.mov has the full chosen-aspect dimensions (e.g. 1080×1920 for 9:16), with the map rendered into its slot's rect and alpha=0 outside. A user must be able to drop B.mov and a future C.mov into Resolve / Premiere / FCP, stack them, and see Channel A's composite emerge with no positioning work. The filtergraph this task builds — `[map]format=yuva…,pad=W:H:X:Y:color=#00000000` + corner-mask `alphamerge` — is what enforces that invariant; deviations break downstream remixing for every user, not just the ones who notice.

## Files to touch

- New: `src-tauri/src/export/ffmpeg_sink.rs` — `FFmpegSink` struct and `FrameSink` impl. Owns the FFmpeg child process, holds its `stdin` and a `JoinHandle` for the stderr-forwarder. `new(args, expected_frame_bytes) -> io::Result<Self>` spawns; `write_frame` writes the raw RGBA payload (asserting `rgba.len() == expected_frame_bytes`); `finish` closes stdin, waits for exit, captures the last 4 KB of stderr, returns `Err` on non-zero exit.
- New: `src-tauri/src/export/filtergraph.rs` — pure filtergraph builder. Public surface: `build_map_only_filtergraph(slot: PixelRect, output: OutputDimensions, corner_radius_px: u32, fps: u32) -> FiltergraphPlan`, where `FiltergraphPlan { args: Vec<String>, total_frames_arg: Vec<String> }` is the splat-ready argv chunk for FFmpeg (filter_complex string + the `-frames:v` count + any extra inputs like the corner-mask PNG). Pure function: same inputs → same args, no IO, no FFmpeg invocation. Tested in isolation.
- New: `src-tauri/src/export/corner_mask.rs` — pure alpha-mask generator. `build_corner_mask_png(slot_w: u32, slot_h: u32, radius_px: u32) -> Vec<u8>` returns a single-channel-equivalent (or RGBA with R=G=B=255) PNG buffer of dims `slot_w × slot_h` with antialiased rounded-corner alpha. Used as a second input to FFmpeg's `alphamerge` when `corner_radius_px > 0`. No external image-processing crate beyond `png` (already a transitive of MapLibre's bundle, but verify; pull `png` directly if missing).
- Modified: `src-tauri/src/export/mod.rs` — `mod ffmpeg_sink;`, `mod filtergraph;`, `mod corner_mask;`; re-export `FFmpegSink`. Replace the dev-only `RenderRequest` shape and `render_map_frames_command` with the production `render_export` shape (next bullet) — `RenderRequest` was a 030-era smoke-test surface (per its docstring "Task 060 will wrap this with `channel`/`output_path` once a real FFmpeg `FrameSink` lands").
- Modified: `src-tauri/src/export/mod.rs` — new Tauri command `render_export`:
  ```rust
  #[derive(Debug, Deserialize)]
  pub struct RenderExportRequest {
      pub channel: String,                       // "map_only" only in 060; "video_only"/"composite" land in 070/090
      pub fps: u32,
      pub output_path: String,
      pub layout: LayoutDescriptor,              // see types section below
      // Same project-state fields as the orchestrator's SetupPayload — pass-through to the workers.
      #[serde(flatten)]
      pub project_state: serde_json::Value,
  }
  pub async fn render_export(req: RenderExportRequest) -> Result<RenderExportSummary, String>;
  ```
  In 060, the only branch implemented is `channel == "map_only"`; the others return `Err("channel not yet implemented in this build: …")` rather than silently mis-rendering. 070/090 fill them in.
- Modified: `src-tauri/src/export/protocol.rs` — `LayoutDescriptor` Rust mirror, deserialized from the IPC payload. Defined in 050's deliverables but not actually committed there since no consumer existed yet; 060 adds:
  ```rust
  #[derive(Debug, Clone, Deserialize)]
  pub struct LayoutDescriptor {
      pub aspect: AspectRatio,
      pub layout: LayoutConfig,
      pub resolved: SlotResolution,
  }
  ```
  On receipt, Rust re-runs `resolve_slots(layout, aspect)` and asserts equality with `resolved` (the parity contract from 050 §"load-bearing invariant"). Mismatch → `Err`.
- Modified: `src-tauri/src/lib.rs` — register `render_export` in `tauri::generate_handler![...]`; drop `render_map_frames_command`.
- Modified: `src/lib/exportRequest.ts` (new file inside the `lib/` convention) — frontend builder that constructs the IPC payload from the project: compiles the timeline, chooses the layout for the requested aspect (or `defaultLayout(aspect)` if not configured), runs `resolveSlots(layout, aspect)`, and assembles the `RenderExportRequest`-shaped object. Pure function returning the invoke-arg; the actual `invoke('render_export', ...)` call lives in the consuming component so error / progress UI can decorate it.
- Modified: `src/screens/ProjectView.tsx` — minimal "Export map-only (.mov)" button in the toolbar, wired to a file-save dialog (`@tauri-apps/plugin-dialog`'s `save({filters: [{name: "QuickTime", extensions: ["mov"]}]})`), then `invoke('render_export', exportRequest)`. Disabled while another export is in flight; shows a simple "Exporting…" indicator. Deliberately *not* an export-settings dialog — that lands with the configurator UI (110). 060's button is a developer-grade entry point.
- New: `src-tauri/tests/render_export_map_only.rs` — integration test. Refuses to run without a `--features integration_export` flag (the test spawns FFmpeg + Node + maplibre-native and writes a real file; nightly/CI only). Constructs a tiny in-memory `Project` (1 clip, 2-second route, default 9:16 PiP layout), drives `render_export` to a temp dir, asserts FFprobe output: `width=1080`, `height=1920`, `codec_name=prores`, `pix_fmt=yuva444p10le`, `nb_frames` matches `total_frames`, `duration` ≈ 2.0s ± frame.
- Modified: `docs/export/tasks/README.md` — flip 060 to ⬜→🟡→✅ as it lands; link this file.
- Untouched in this task: anything in 070/090's scope (per-clip video chain, compositing, audio). The configurator UI (110), additional aspects (100), and parity-verification harness (120) all consume 060's surface but ship later.

## Deliverables

### `FFmpegSink` (in `src-tauri/src/export/ffmpeg_sink.rs`)

```rust
pub struct FFmpegSink {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    stderr_handle: tokio::task::JoinHandle<()>,
    stderr_tail: Arc<Mutex<VecDeque<u8>>>, // last 4 KB ring buffer; reused from orchestrator's stderr-forwarder pattern
    expected_frame_bytes: usize,
    frames_written: u32,
}

impl FFmpegSink {
    pub async fn spawn(
        ffmpeg_path: &Path,
        argv: &[String],
        expected_frame_bytes: usize,
    ) -> Result<Self, FFmpegSinkError>;
}

impl FrameSink for FFmpegSink {
    fn write_frame(&mut self, frame_index: u32, rgba: &[u8]) -> Result<(), SinkError>;
    fn finish(self: Box<Self>) -> Result<(), SinkError>;
}
```

`write_frame` panics in dev / errors in release if `rgba.len() != expected_frame_bytes` (the orchestrator's contract guarantees this; the assertion is a tripwire if a future regression reorders pipeline arithmetic).

`finish` closes stdin (signals EOF to FFmpeg → triggers encoder flush), waits up to `EXPORT_FINISH_TIMEOUT_SECS = 30` for exit, captures the last 4 KB of stderr, and:

- exit 0 → `Ok(())`.
- exit non-zero → `Err(FFmpegSinkError::EncoderFailed { exit_code, stderr_tail, frames_written })`.
- timeout → kill child, `Err(FFmpegSinkError::EncoderHang { stderr_tail, frames_written })`.

### Filtergraph builder (in `src-tauri/src/export/filtergraph.rs`)

```rust
pub struct FiltergraphPlan {
    /// Argv chunks the caller splats into the full FFmpeg invocation.
    pub argv: Vec<String>,
    /// Number of bytes per RGBA frame the orchestrator will write into stdin
    /// (`slot.w * slot.h * 4`). The sink uses this to validate frames.
    pub frame_bytes_per_input: usize,
}

pub fn build_map_only_filtergraph(
    slot: PixelRect,
    output: OutputDimensions,
    corner_mask_png_path: Option<&Path>, // None when corner_radius_px == 0
    fps: u32,
    total_frames: u32,
    encoder: &EncoderChoice,
    output_path: &Path,
) -> FiltergraphPlan;
```

The argv it emits, for the no-corner-radius case (Split layout, or PiP with the map-as-background — slot rect = full frame):

```
ffmpeg -hide_banner -y \
  -f rawvideo -pix_fmt rgba -s {slot.w}x{slot.h} -r {fps} -i pipe:0 \
  -frames:v {total_frames} \
  -filter_complex "[0:v]format=yuva444p10le,pad={out.w}:{out.h}:{slot.x}:{slot.y}:color=#00000000[v]" \
  -map "[v]" \
  -an \
  -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le -vendor apl0 \
  -movflags +faststart \
  {output_path}
```

For the corner-radius case (PiP with map-as-inset, `corner_radius_px > 0`):

```
ffmpeg -hide_banner -y \
  -f rawvideo -pix_fmt rgba -s {slot.w}x{slot.h} -r {fps} -i pipe:0 \
  -loop 1 -i {corner_mask_png_path} \
  -frames:v {total_frames} \
  -filter_complex "
    [0:v]format=yuva444p10le[map];
    [1:v]format=gray[mask];
    [map][mask]alphamerge[masked];
    [masked]pad={out.w}:{out.h}:{slot.x}:{slot.y}:color=#00000000[v]
  " \
  -map "[v]" \
  -an \
  -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le -vendor apl0 \
  -movflags +faststart \
  {output_path}
```

Notes on the filtergraph:

- `-pix_fmt rgba` on the rawvideo input matches the orchestrator's worker output (PLAN.md §"Rust → renderer worker" — workers write 4-byte BE length + RGBA bytes; orchestrator strips the prefix and forwards bytes as-is).
- `pad=W:H:X:Y:color=#00000000` produces a transparent canvas at output dims, places the input at `(slot.x, slot.y)`. Critical: must run *after* `format=yuva444p10le` so the canvas's transparent fill is a real alpha channel, not blackened RGB.
- `-loop 1` on the mask input causes FFmpeg to repeat the single-frame PNG for the duration of the rawvideo input; `-frames:v {total_frames}` caps the output at the orchestrator's frame count so the looping mask stops with the input.
- `alphamerge` takes the alpha from the second input's grayscale (mask) and applies it to the first input's RGB. The map's own RGB stream survives; its alpha is now the mask's grayscale.
- ProRes 4444 args are pulled from `EncoderChoice.codec_args` (set by 040 to `["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "apl0"]`). The filtergraph builder receives the choice as a parameter and splices its `codec_args` after `-map "[v]"`. No hard-coding.
- `-an` explicitly drops audio (LAYOUT.md §8 — Channel B is silent). Even if a future caller passes audio inputs, the map-only sink ignores them; the contract is structural.

### Corner-mask generator (in `src-tauri/src/export/corner_mask.rs`)

A single-image, single-channel-equivalent PNG (RGBA with R=G=B=255 and A varying):

- Outside the rounded rect: A=0.
- Inside the rounded rect, away from corners: A=255.
- Within `radius_px` of a corner: A computed via signed-distance to the rounded rect's corner arc, with a 1-pixel antialias band: A = clamp((radius_px + 0.5 - distance_to_arc_center) / 1.0, 0, 1) × 255.

Implementation: rasterize at slot dims using a straightforward CPU loop (no GPU, no third-party rasterizer). For each pixel, compute distance to the nearest rounded-rect edge or corner-arc center, threshold + blend. ~30 LOC.

The PNG is written to a temp file (using `tempfile::NamedTempFile`) for the duration of the FFmpeg run — FFmpeg's filtergraph wants a path. Cleanup runs on drop / on `FFmpegSink::finish`. Cached on disk under `~/.trailcut/corner_masks/{slot_w}x{slot_h}_r{radius_px}.png` for cross-export reuse — generation is fast (<10ms) but the cache is free and helps when the user re-runs the same export.

### `render_export` command (in `src-tauri/src/export/mod.rs`)

1. Deserialize `RenderExportRequest`. Fail-fast on `channel` other than `"map_only"`.
2. Re-run `resolve_slots(req.layout.layout, req.layout.aspect)`; assert equality with `req.layout.resolved` (parity check; mismatch → `Err("layout descriptor parity check failed: …")`).
3. Compute `total_frames = (timeline.totalDurationMs * fps + 500) / 1000` (round-half-up, integer math). Read `totalDurationMs` from `req.project_state["timeline"]["totalDurationMs"]` — orchestrator already treats `project_state` as opaque pass-through, so this command does the one extraction it needs.
4. Pick the map slot:
   - PiP: `req.layout.resolved.map_slot` (already resolved per `inset_source`).
   - Split: same field — `resolve_slots` puts it at the map's half.
5. Load `EncoderChoice` via `select_encoder(EncoderClass::ProResAlpha)`.
6. If PiP-with-map-as-inset and `corner_radius_px > 0`: generate the corner-mask PNG (or pull from cache), pass its path to the filtergraph builder. Else: `corner_mask_png_path: None`.
7. Build the filtergraph: `build_map_only_filtergraph(map_slot, output_dims(aspect), corner_mask_png_path, fps, total_frames, &encoder, &output_path)`.
8. Spawn `FFmpegSink::spawn(ffmpeg_path, &argv, slot.w * slot.h * 4)`.
9. Build the orchestrator `SetupPayload` with `viewport: { w: slot.w, h: slot.h }`. Forward `project_state` opaquely.
10. Call `render_map_frames(setup, total_frames, OrchestratorConfig::default(), Box::new(sink))`.
11. On success, return `RenderExportSummary { frames_written, output_path, wall_clock_ms }`.
12. On failure (orchestrator error OR sink error), surface a structured error:
    ```rust
    pub struct RenderExportError {
        pub stage: String,           // "orchestrator" | "ffmpeg" | "validation"
        pub message: String,
        pub stderr_tail: Option<String>,
    }
    ```

The frontend `invoke('render_export', ...)` returns either `RenderExportSummary` or this structured error. The button's UI reads `stderr_tail` to populate a "details" expansion if the export fails.

## Acceptance criteria

- [ ] `cargo build` (in `src-tauri`) succeeds with the new modules and command wired in.
- [ ] `cargo clippy --all-targets -- -D warnings` (in `src-tauri`) is clean.
- [ ] `npm run lint`, `npm run build`, `npm run test:run` pass.
- [ ] **Filtergraph unit tests** (`cargo test --lib export::filtergraph`):
  - Without corner radius: argv contains exactly one `-i pipe:0`, no `-loop 1`, the `filter_complex` string contains `format=yuva444p10le` followed by `pad=` with the correct `(W:H:X:Y)` numbers for representative cases (PiP-bottom-right at 9:16; Split-left at 16:9; PiP-full-bleed-map).
  - With corner radius: argv contains two inputs (rawvideo + the mask PNG), `filter_complex` includes `alphamerge`, `-loop 1` precedes the mask path.
  - `frame_bytes_per_input == slot.w * slot.h * 4` for every fixture.
- [ ] **Corner-mask unit tests** (`cargo test --lib export::corner_mask`):
  - Output dims match input dims.
  - Center pixel is fully opaque (A=255).
  - Pixels well outside the rounded rect (e.g. at corners < radius) have A=0.
  - The 1-px antialias band: a pixel exactly on the corner arc has A in [100, 200] (not 0 or 255).
  - PNG round-trips: re-decoding the buffer with the `png` crate gives back the same dims + alpha values.
- [ ] **Layout parity check at the IPC boundary** (Rust unit test): a `LayoutDescriptor` whose `resolved` field has been hand-mutated (e.g., bumped `map_slot.x` by 1) is rejected with a clear error before any FFmpeg / orchestrator work begins.
- [ ] **Integration test passes** (`cargo test --test render_export_map_only --features integration_export`):
  - Spawns the bundled (or system-PATH) FFmpeg + Node renderer; refuses to run if either is missing (mirrors 030's bundle guard).
  - Exports a 2-second 30fps Channel B at 9:16 PiP-bottom-right with `corner_radius=0.012` (default) to a temp `.mov`.
  - Runs `ffprobe -v error -show_streams -of json` on the output. Asserts:
    - `streams[0].codec_name == "prores"`.
    - `streams[0].pix_fmt == "yuva444p10le"`.
    - `streams[0].width == 1080`, `streams[0].height == 1920`.
    - `streams[0].nb_frames == "60"` (or `60` numeric).
    - `streams[0].duration` parses to a float in `[1.99, 2.01]`.
    - Audio stream count == 0 (`-an` worked).
  - Reads frame 30 of the output (FFmpeg `select=eq(n\,30)` → `-f rawvideo -pix_fmt rgba`), asserts: a pixel at (10, 10) — outside the inset rect — has alpha == 0; a pixel at the inset's center has alpha == 255 and non-(0,0,0) RGB (the map rendered something).
- [ ] **No reimplementation of orchestrator-side logic in the sink.** Grep at acceptance time:
  - `grep -nE "split_range|JoinSet|read_frame|recycle_line" src-tauri/src/export/ffmpeg_sink.rs` returns nothing — the sink is a thin process wrapper, not a reimplementation.
- [ ] **`render_map_frames_command` is removed.** Grep `grep -rn "render_map_frames_command" src-tauri/` returns nothing; `tauri::generate_handler![...]` lists `render_export` in its place.
- [ ] **Manual smoke test on macOS dev machine.** Author opens an existing project with a route + 1+ clips, clicks "Export map-only (.mov)", picks a path, waits for the export, drops the resulting `.mov` into a video player or QuickTime Pro (or Resolve / Premiere if available). The map plays back at 9:16 over a transparent canvas; the rest of the frame is alpha=0. Subjective: the marker movement, route reveal, and animations match the editor preview at the same `t` values (a side-by-side check is enough; full parity verification is 120's job).
- [ ] `docs/export/tasks/README.md` row 060 flipped to ✅, this file linked.

## Implementation notes

**Why ProRes 4444 in `.mov` and not WebM/VP9 with alpha.** LAYOUT.md §6 settled this: ProRes 4444 is the industry-standard intermediate codec on both Mac and Windows, supported natively by every NLE the user might bring it into. WebM/VP9 with alpha works in browsers but is rejected by Premiere and FCP without third-party plugins. The point of B and C is to be NLE-friendly compositing intermediates; the codec choice follows. File size (~5 GB/min at 1080p) is the tradeoff; the user is exporting an editing intermediate, not a deliverable.

**Why the filtergraph emits `format=yuva444p10le` *before* `pad`, not after.** `pad=color=#00000000` fills with transparent black, but the alpha channel must already exist on the input stream for the fill to be a real transparent fill rather than a blackened opaque region. Running `format=yuva444p10le` first ensures the stream has alpha by the time `pad` adds the canvas. (Tested locally; reversing the order produces a black-bordered output. Documented here so a future refactor doesn't innocently swap them for "consistency.")

**Why the corner mask is a PNG file input rather than a `geq` expression.** `geq` (generic equation) can compute a rounded-rect alpha mask procedurally, but the expression syntax is unwieldy (a 5–7 line expression with `if` / `min` / `max` / `hypot` calls), evaluation is per-pixel-per-frame in single-threaded mode, and FFmpeg's parser is unforgiving of small typos. A pre-rasterized PNG is a 30-LOC CPU loop in Rust, runs once per export, and the resulting filtergraph is dead-simple `alphamerge`. The cost — a temp file on disk and a second FFmpeg input — is negligible.

**Why `-loop 1` instead of `-stream_loop -1` for the mask.** `-loop 1` is the input-format-level loop flag (works specifically with image inputs). `-stream_loop -1` is the stream-level loop (works for any input but is more recent and has had subtle bugs around frame timing in older FFmpeg builds). The encoder-probe ensures we have a current build, but `-loop 1` is the conservative idiom for "this image input loops indefinitely until paired with a finite stream"; pair with `-frames:v {total}` to cap the output.

**Why the orchestrator hands raw bytes, not framed bytes, to the sink.** The orchestrator already strips the `[4-byte BE length][N bytes]` framing produced by the worker (per `protocol.rs::read_frame`); `FrameSink::write_frame(frame_index, rgba: &[u8])` receives the unframed payload. FFmpeg's `-f rawvideo -pix_fmt rgba` expects exactly that — no headers, no framing — at fixed `w × h × 4` bytes per frame. The sink writes raw bytes straight through; FFmpeg uses position to deduce frame boundaries.

**Why fail-fast on the layout parity check.** 050's central invariant is "the TS implementation is the source of truth; the Rust port is a structural mirror, kept honest by a parity test." The parity test runs at build time. At runtime, an attacker (or a future bug in the frontend's `resolveSlots` call site) could in principle emit a `LayoutDescriptor` whose `resolved` field doesn't match its `layout`. Re-running the math in Rust and asserting equality at the IPC boundary catches this in the one place it could matter — before pixels start flowing. Cost: ~µs per export. Defense in depth.

**Why the integration test is gated behind a Cargo feature.** Running real FFmpeg + a real Node renderer + maplibre-native takes ~5–15s per export and is sensitive to the dev machine's environment (FFmpeg version, GL drivers, network for cold tile fetches). Gating behind `--features integration_export` keeps `cargo test` fast for routine work and lets the CI matrix pick this test up explicitly. Mirrors 030's `dist/renderer.cjs` guard pattern.

**Why the `render_export` command flattens `project_state`.** The IPC payload's `timeline`, `route`, `clips`, `mapSettings` fields go straight to the worker via `SetupPayload.project_state` (an opaque `serde_json::Value`). Defining a Rust mirror of `CompiledTimeline` would force a second source of truth, which is exactly what the 500-series migration locked down (TS `cameraAt` is THE camera function — not a Rust port). Pass-through is correct here; Rust enforces only the wrapping shape (`channel`, `fps`, `output_path`, `layout`).

**The frontend export-request builder lives in `src/lib/`, not in the component.** `src/lib/exportRequest.ts` is unit-testable (vitest) and reusable when 070 / 090 add their own channels. The button in `ProjectView.tsx` is a thin wrapper: `const req = buildExportRequest(project, "map_only", "9_16"); await invoke('render_export', req);`. Future export-settings UI (110) will swap the button for a dialog, but the request-construction logic stays put.

**`-frames:v` is mandatory.** Without it, the rawvideo input has no length signal — FFmpeg keeps reading from `pipe:0` until EOF, which works, but the corner-mask `-loop 1` input has no end without an explicit count. Setting `-frames:v {total_frames}` caps the *output*, which terminates both inputs cleanly. The orchestrator naturally closes its end of the pipe after writing the last frame, so EOF-on-stdin coincides with the frame cap; FFmpeg exits 0 immediately after.

**`-vendor apl0`.** Apple's vendor tag for ProRes. Without it, FCP/Premiere may show the file as "ProRes 4444 (unknown vendor)" and refuse certain operations (smart-render passthrough, specifically). The encoder-probe sets this in `codec_args`; the filtergraph builder splices it through unmodified.

**Default 9:16 layout if `project.layouts` is null.** A user clicking the export button on a fresh project (no configurator interaction yet) should get *something*, not an error. Frontend builder calls `defaultLayout('9_16')` from 050 when `project.layouts?.['9_16']` is null. Documented in the button's tooltip ("Exports at 9:16. Configure layout per aspect via the layout configurator (coming in a later release).") — UX is rough on purpose; 060 is not the configurator.

**No progress reporting in 060.** Progress events (`emit('export_progress', { frame_index, total_frames })`) are easy to add but multiply the surface area of the IPC contract; the button shows a static "Exporting…" until the command resolves. Progress UI lands with the configurator (110) when the export-settings dialog has space for a progress bar. Documented as a known UX limitation — for a 60-second export at ~real-time, the user sees nothing for ~60s, which is fine for a developer-grade button but bad for production.

**No GPU acceleration in the renderer worker yet.** PLAN.md §"Performance" calls out "GPU acceleration via Metal (unverified)." 060 does *not* enable it; the worker runs CPU-only. Wall-clock will be 1–4× real-time depending on slot size and tile-cache warmth. If the integration test's 2-second export runs longer than 30s wall-clock on the author's M-series machine, that's a yellow flag worth tracking but not a blocker — 060's job is correctness, not speed. Performance work is a follow-up task post-090.

**Why no audio handling at all in this task.** Channel B is silent (LAYOUT.md §8); `-an` covers it. Channel C (070) and Channel A (090) need the per-clip audio chain (`atrim` + `atempo`) and audio-side concat. That logic doesn't fit cleanly into Channel B's filtergraph and would only be dead code here. Defer.

## Open questions deferred to follow-up tasks

- **Progress reporting via Tauri events.** Real progress UI (frame-level updates, stage labels — "rendering tiles…", "encoding…") lands with the configurator UI (110) where there's a place to put it. 060 ships fire-and-forget.
- **Export cancellation.** Today, hitting the export button fires the command and waits. There's no cancel. Implementation is straightforward (a `CancellationToken` shared between orchestrator and sink), but UX placement (where the cancel button lives) is a configurator question. Defer.
- **GPU rendering in the worker.** Per PLAN.md §"Performance" → "GPU acceleration via Metal (unverified)." Worth measuring once 060 lands and we have a real harness. Independent of channel topology; a worker-side improvement.
- **Tile pre-warming.** PLAN.md §"Performance" → "Pre-warm tiles before the frame loop." Not built in 060 — first export is cold-tile-fetch slow. Independent task; the orchestrator's `setup` phase is the natural place to inject a pre-warm call once it exists.
- **Per-aspect export choice in the UI.** 060's button is hard-coded to 9:16. The configurator (110) introduces an aspect picker; 060 just unblocks the data path.
- **Channels C and A.** 070 reuses `FFmpegSink` and the encoder selection; new logic is the per-clip video filter chain (trim → setpts → focal-crop → scale → concat) with audio. 090 composites two streams into Channel A. Both depend on this task's scaffolding.
- **Sidecar bundling.** 060 calls FFmpeg from PATH (`Command::new("ffmpeg")`) and Node from PATH. Per-platform bundled binaries land in 130. The encoder module (040) and orchestrator (030) already read paths through resolver cells; the same applies here.

## Doc tie-in

- PLAN.md §"Channels" — Channel B is "map render stream → ProRes 4444 with alpha at full output dim, content at slot rect, alpha=0 elsewhere." 060 implements this row of the table.
- PLAN.md §"Rust → FFmpeg" — the filtergraph sketch in PLAN.md is normative for this task; the corner-radius alpha-mask elaboration and the `-loop 1` mask-input idiom are 060-specific elaborations on top.
- PLAN.md §"IPC contract" — `render_export` matches the command shape sketched in PLAN.md (`channel`, `fps`, `output_path`, `layout`, project state, source clips). 060 ignores `source_clips` (no video chain in Channel B); 070/090 introduce it.
- LAYOUT.md §6 — "masked positional export" is the load-bearing invariant; the filtergraph's `pad=…:color=#00000000` is what enforces it. The corner-radius semantics for PiP-with-map-as-inset map directly to the alpha mask path.
- LAYOUT.md §8 — Channel B is silent; `-an` is non-negotiable.
- 040 — `select_encoder(EncoderClass::ProResAlpha)` returns the ProRes choice with full `codec_args`; 060 splices them straight in.
- 050 — `LayoutDescriptor`, `resolve_slots`, `OUTPUT_DIMS` are this task's geometry source. The IPC parity check against `req.layout.resolved` enforces 050's "TS is source of truth, Rust mirrors structurally" invariant at runtime, complementing the build-time fixture parity test.
- After 060 lands, 070 (Channel C) builds on the same `FFmpegSink` + filtergraph-builder seam, adding per-clip video chain logic. 090 composites two such streams into Channel A. The scaffolding stabilizes here.
