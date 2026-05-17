# Task 070 — Channel C (video-only) end-to-end

**Step**: Export pipeline (second concrete channel — per-clip video filter chain → FFmpeg → file on disk)
**Estimated effort**: ~2 days (12–18h)
**Status**: pending
**Depends on**: 030 (orchestrator's `FrameSink` seam — *not* used by C, but the protocol/error taxonomy in `export/error.rs` and the FFmpeg-spawn pattern in `export/ffmpeg_sink.rs` are reused), 040 (`select_encoder(EncoderClass::ProResAlpha)`), 050 (`LayoutDescriptor`, `resolve_slots`). Practical predecessor: 060 (Channel B) — its filtergraph builder, corner-mask generator, `render_export` shape, and FFmpeg-spawn/error-classification scaffolding are extended here. 060 doesn't appear as a strict dependency in the README's column because the channels are conceptually parallel, but landing 070 before 060 would mean inventing the FFmpeg-spawn pattern from scratch.

## Goal

Ship the second end-to-end export channel: build a per-clip video filter chain (trim → setpts → focal-crop → scale → format) for every visible clip, concatenate, position the concatenated video on a full-output-aspect transparent canvas at the layout's `video_slot` rect (with antialiased corner-radius alpha mask if the video is the inset), encode as ProRes 4444 in `.mov` with alpha; in parallel, build a per-clip audio chain (atrim → asetpts → atempo, chained for extreme speeds), concatenate, and mux as a PCM s16le stereo track. After this task:

- A new `build_video_only_filtergraph(...)` joins `build_map_only_filtergraph` in `src-tauri/src/export/filtergraph.rs`, producing the argv FFmpeg ingests directly from source video files (no rawvideo input from a renderer worker).
- A new `clip_chain` module emits the per-clip video and audio sub-graph strings as pure functions of `(clip, slot_dims, source_dims)` — table-driven, unit-tested, with no FFmpeg spawn.
- A new `FFmpegRunner` (or a `spawn_no_stdin` constructor on `FFmpegSink`) handles the spawn-and-wait lifecycle for channels that don't stream rawvideo. Stderr capture and structured-error surface are shared with the existing sink.
- The `render_export` Tauri command's `channel == "video_only"` branch fills in (replacing 060's `Err("channel not yet implemented…")`). The branch is structurally simpler than `map_only` in one way (no orchestrator, no renderer worker, no recycle loop) and more complex in another (multi-input filtergraph, per-clip math, audio).
- A second "Export video-only (.mov)" button lands in `ProjectView.tsx`'s toolbar, parallel to 060's button, reusing the existing `buildExportRequest` builder with `channel: 'video_only'`.
- A passing integration test produces a real `.mov` from a fixture project, asserts FFprobe reports `(1080×1920, prores, yuva444p10le, duration matches sum of trimmed-and-speed-adjusted clip spans, 1 audio stream pcm_s16le)`.

This is the second task that puts pixels on disk. Channel A (090) reuses **both** 060's map-render scaffolding and 070's per-clip video chain, then composites the two streams into a single H.265 deliverable. 070 is deliberately the "video-only mirror" of 060 so that all the per-clip filtergraph complexity — trim math, focal crop math, atempo chaining, multi-input concat — gets exercised and stabilized in isolation before 090 adds compositing on top.

**The load-bearing invariant — same per-clip chain produces the video stream feeding both Channel A and Channel C.** LAYOUT.md §7 settles this explicitly: "the same per-clip chain produces the video stream that feeds **both** Channel A's video slot and Channel C's video slot — both target the same dimensions (the layout's video slot dims), so the per-clip processed video is identical between A and C." The `clip_chain` module this task ships is consumed verbatim by 090. Any drift between "C's video pipeline" and "A's video pipeline" would mean a user who exports B+C as compositing intermediates and a user who exports A directly get different pixels — which silently breaks the "stack B+C in any NLE and reconstruct A" promise from LAYOUT.md §6. The invariant is enforced structurally: there is one builder, two callers.

**The second load-bearing invariant — masked positional export, same as Channel B.** LAYOUT.md §6's masked-positional semantics apply identically to C: full-frame ProRes 4444 with alpha, content at `video_slot` rect, alpha=0 elsewhere. The pad/alphamerge pattern from 060 is directly reused; only the input source changes (source video files instead of orchestrator stdin). A user must be able to drop B.mov and C.mov into Resolve / Premiere / FCP, stack them, and see Channel A's composite emerge with no positioning work. The filter sequence — `[concat]…format=yuva444p10le,pad=W:H:X:Y:color=#00000000` + corner-mask `alphamerge` when `corner_radius_slot == Video` — is what enforces that invariant.

## Files to touch

- New: `src-tauri/src/export/clip_chain.rs` — pure builders for the per-clip video and audio sub-graph strings. Public surface:
  ```rust
  pub struct ClipChainInputs<'a> {
      pub input_index: u32,         // FFmpeg input index (0-based, in the order inputs are listed on argv)
      pub clip: &'a Clip,           // crate::models::Clip
      pub source_dims: PixelDims,   // parsed from clip.resolution; required, errors if absent
      pub video_slot: PixelRect,    // target dims; from layout.resolved.video_slot
      pub fps: u32,
  }

  pub struct ClipChainOutput {
      /// Filter sub-graph fragment for this clip's video. Ends with `[v{input_index}]`.
      pub video_subgraph: String,
      /// Filter sub-graph fragment for this clip's audio. Ends with `[a{input_index}]`. None if the source has no audio (see implementation notes).
      pub audio_subgraph: Option<String>,
      /// The output-stream label other filters can reference (e.g. `"v0"`).
      pub video_label: String,
      pub audio_label: Option<String>,
  }

  pub fn build_clip_video_subgraph(inputs: &ClipChainInputs) -> Result<String, ClipChainError>;
  pub fn build_clip_audio_subgraph(inputs: &ClipChainInputs) -> Result<String, ClipChainError>;
  pub fn build_clip_chain(inputs: &ClipChainInputs) -> Result<ClipChainOutput, ClipChainError>;
  ```
  No FFmpeg invocation, no IO. The video subgraph emits exactly:
  ```
  [{idx}:v]trim=start={in_s}:end={out_s},setpts=(PTS-STARTPTS)/{speed},crop={cw}:{ch}:{cx}:{cy},scale={vw}:{vh},format=yuva444p10le[v{idx}]
  ```
  The audio subgraph emits:
  ```
  [{idx}:a]atrim=start={in_s}:end={out_s},asetpts=PTS-STARTPTS,atempo={f1},atempo={f2}…[a{idx}]
  ```
  with `atempo` chained per LAYOUT.md §7 (each instance ∈ `[0.5, 2.0]`). All numbers serialized with consistent precision (6 decimal places for floats; `{:.6}`); no scientific notation (FFmpeg's parser rejects `1e-3`).

- New: `src-tauri/src/export/clip_chain/focal_crop.rs` (or inline as a pub fn in `clip_chain.rs` if <60 LOC) — `compute_focal_crop(source_dims, target_aspect_dims, focal: &FocalPoint) -> CropRect`. Pure: implements LAYOUT.md §7 "Focal-point crop" math with explicit clamp-to-source-bounds. Tested in isolation against a fixture covering: aspect-fit (zoom=1.0) at all three target aspects, punch-in (zoom=2.0), focal point at corners (clamped), focal point off-center.

- New: `src-tauri/src/export/clip_chain/atempo.rs` (or inline) — `chain_atempo(speed: f64) -> Vec<f64>`. Decomposes a speed into a chain of factors each in `[0.5, 2.0]`. Algorithm: while `speed > 2.0`, push `2.0` and divide; while `speed < 0.5`, push `0.5` and divide; push the remainder. Tested for: 1.0 → `[1.0]`; 2.0 → `[2.0]`; 4.0 → `[2.0, 2.0]`; 5.0 → `[2.0, 2.0, 1.25]`; 0.5 → `[0.5]`; 0.25 → `[0.5, 0.5]`; 0.1 → `[0.5, 0.5, 0.5, 0.8]`.

- Modified: `src-tauri/src/export/filtergraph.rs` — add `build_video_only_filtergraph(...)` alongside the existing `build_map_only_filtergraph`. Public surface:
  ```rust
  pub fn build_video_only_filtergraph(
      visible_clips: &[VisibleClipInput],     // in timeline order; each carries source path + parsed dims
      slot: PixelRect,                        // video_slot
      output: OutputDimensions,
      corner_mask_png_path: Option<&Path>,    // Some only when corner_radius_px > 0 AND corner_radius_slot == Video
      fps: u32,
      encoder: &EncoderChoice,                // EncoderClass::ProResAlpha
      audio_encoder_args: &[&str],            // ["-c:a", "pcm_s16le"]
      output_path: &Path,
  ) -> FiltergraphPlan;

  pub struct VisibleClipInput {
      pub source_path: PathBuf,
      pub clip: Clip,                         // owned because the request struct hands ownership over
      pub source_dims: PixelDims,
      pub has_audio: bool,                    // probed via ffprobe at request time; see implementation notes
  }
  ```
  The plan's `argv` is the splat-ready FFmpeg invocation; `frame_bytes_per_input` is unused for this channel (set to 0 — Channel C has no rawvideo input).

- New: `src-tauri/src/export/ffmpeg_runner.rs` — process-only FFmpeg runner for non-streaming channels. Distinct from `FFmpegSink`: spawn → wait for exit → capture stderr tail → return structured error. No stdin, no frame writer.
  ```rust
  pub struct FFmpegRunResult {
      pub exit_code: i32,
      pub wall_clock_ms: u64,
      pub stderr_tail: String,                // last 4 KB
  }

  pub async fn run_ffmpeg(
      ffmpeg_path: &Path,
      argv: &[String],
  ) -> Result<FFmpegRunResult, FFmpegRunnerError>;
  ```
  Stderr forwarder lives here too (mirrors `FFmpegSink`'s pattern), captured into a 4 KB ring buffer and surfaced in the error variant on non-zero exit. The returned `wall_clock_ms` covers spawn-to-exit; the caller adds its own pre/post-flight timing.

- New: `src-tauri/src/export/ffprobe.rs` — narrow ffprobe wrapper used to detect audio-stream presence + verify source dimensions parse cleanly. Public surface:
  ```rust
  pub struct ProbedClip {
      pub width: u32,
      pub height: u32,
      pub has_audio: bool,
      pub container_duration_s: f64,
  }

  pub async fn probe_clip(ffprobe_path: &Path, source_path: &Path) -> Result<ProbedClip, FfprobeError>;
  ```
  Uses `ffprobe -v error -show_streams -of json` and parses `streams[*].codec_type`. ~80 LOC. Caches the result keyed by `(source_path, mtime)` in-process for the duration of an export; cross-export caching is out of scope for 070.

- Modified: `src-tauri/src/export/mod.rs` — implement `channel == "video_only"` in `render_export`. The branch:
  1. Reuses validation (parity check, total-frames math) from the existing `map_only` flow — extract into private helpers if the duplication exceeds ~10 LOC.
  2. Reads `clips: Vec<Clip>` from `req.project_state.clips` (currently passed through opaquely; for `video_only` we need a typed view, so this branch deserializes that field via `serde_json::from_value`). Filters to `clip.visible == true`. **Errors if the visible-clip list is empty.**
  3. Resolves each clip's source path. Per LAYOUT.md §7, exports use originals, not proxies — read from `clip.path` directly, error if the file is missing.
  4. Probes each source with `probe_clip(...)` — fills `source_dims` and `has_audio`. Spec'd to run probes in parallel via `futures::future::try_join_all`; capped at 8-way concurrency to avoid OS handle exhaustion on large projects.
  5. Generates the corner-mask PNG only if `corner_radius_px > 0 && corner_radius_slot == Video`. (For `map_only`, 060 generates only if `corner_radius_slot == Map`. The mirror is intentional.)
  6. Builds the filtergraph: `build_video_only_filtergraph(...)`.
  7. Spawns FFmpeg via `ffmpeg_runner::run_ffmpeg`. No orchestrator, no renderer worker, no FrameSink.
  8. Returns `RenderExportSummary { frames_written: total_frames, output_path, wall_clock_ms }` on exit code 0. `frames_written` for `video_only` is computed from the timeline (same formula as `map_only`); FFmpeg's actual encoded-frame count is sanity-checked via a post-export ffprobe in the integration test, not at runtime.

- Modified: `src-tauri/src/export/error.rs` — extend `OrchestratorError` (or add a sibling `RenderExportError` variant family — pick whichever keeps `error.rs` cohesive) with:
  - `ClipChainError { clip_id, reason }` — focal-point math failures, missing source dims.
  - `FfprobeError { source_path, reason }` — ffprobe spawn / parse failures.
  - `FFmpegRunnerError { exit_code, stderr_tail }` — non-zero exit from the runner.
  - `EmptyTimeline` — no visible clips.
  - `MissingSourceFile { path }`.
  These map into the existing `RenderExportError { stage, message, stderr_tail }` shape via `classify_*` helpers in `mod.rs` (extending the existing `classify_orchestrator_error` pattern).

- Modified: `src-tauri/src/export/mod.rs` (re-exports) — `pub use clip_chain::*; pub use ffmpeg_runner::*; pub use ffprobe::*;`. The `build_video_only_filtergraph` is already on the existing `filtergraph` re-export line; extend it.

- Modified: `src/screens/ProjectView.tsx` — second toolbar button "Export video-only (.mov)", parallel to 060's button. Wired to a file-save dialog and `invoke('render_export', { req: buildExportRequest({ channel: 'video_only', ... }) })`. Disabled while another export is in flight; shows "Exporting…" indicator. Same UX scaffolding as 060's; the only divergence is the channel string.

- Modified: `src/lib/exportRequest.ts` — no API change; `ExportChannel` already includes `'video_only'`. Add a unit test asserting that `buildExportRequest({ channel: 'video_only', ... })` produces a wire shape that round-trips through Rust's `RenderExportRequest::deserialize` (the test runs in TS but compares against an inline Rust-generated fixture, mirroring the layout-parity pattern).

- New: `src-tauri/tests/render_export_video_only.rs` — integration test. Refuses to run without `--features integration_export` (mirrors 060's gate). Constructs a tiny fixture project with **two visible clips** (covers the concat path, which a single-clip test wouldn't), each with non-trivial trim, speed=1.5, focal_point with zoom=1.2; default 9:16 PiP layout (which puts video as the full-frame background — `video_slot` is the full output rect, no corner mask). Drives `render_export` to a temp dir, asserts FFprobe output:
  - Video: `width=1080`, `height=1920`, `codec_name=prores`, `pix_fmt=yuva444p10le`, `nb_frames` matches the timeline frame count, `duration` ≈ Σ(trimmed_span / speed) ± frame.
  - Audio: 1 stream, `codec_name=pcm_s16le`, `sample_rate >= 44100`, `channels in [1, 2]`, `duration` matches video duration ± 50ms.
  - Frame 30 (mid-clip-0): pixel at `(540, 960)` — slot center for full-bleed video — is non-(0,0,0) and alpha≠0 (a real video pixel).
  - For the *PiP-with-video-as-inset* variant (a second `#[test]` case using `inset_source: 'video'`): pixel at (10, 10) — outside the inset rect — has alpha == 0; pixel at the inset center has alpha == 255.
  - With a *corner-radius* variant (third test case, `corner_radius: 0.05`, video as inset): a pixel at the rounded-corner arc center has `alpha ∈ (0, 255)` (antialiased band). Alpha falloff verified via two pixels at increasing distance from the arc's center.

- Modified: `docs/export/tasks/README.md` — flip 070 to ⬜→🟡→✅ as it lands; link this file.

- Untouched in this task: anything in 090's scope (compositing two streams into Channel A; H.265 encoder selection; CRF tuning), the configurator UI (110), additional aspects beyond what the test fixtures exercise (100), parity verification (120). The renderer worker is **entirely uninvolved** in Channel C — workers and the orchestrator are not spawned, not configured, not even imported by this branch. That's deliberate; `video_only` is a strictly FFmpeg-side channel.

## Deliverables

### `clip_chain` (in `src-tauri/src/export/clip_chain.rs`)

The per-clip video sub-graph (with concrete numbers for a representative clip — `trim.in_ms=500`, `trim.out_ms=3500`, `speed=1.5`, focal_point `(0.6, 0.4, 1.2)`, source `1920×1080`, slot `1080×1920`):

```
[0:v]trim=start=0.500000:end=3.500000,setpts=(PTS-STARTPTS)/1.500000,crop=480:854:600:113,scale=1080:1920,format=yuva444p10le[v0]
```

The math:

- `trim.start_s = trim.in_ms / 1000.0` (float seconds; FFmpeg accepts microsecond precision).
- `trim.end_s = trim.out_ms / 1000.0`.
- `setpts` divisor is the speed factor (note: `setpts` *divides* PTS by speed, so a 1.5× speed produces a 1.5× faster playback — same convention as the editor preview's `playbackRate`).
- Focal crop (from LAYOUT.md §7):
  - `target_aspect = video_slot.w / video_slot.h` (e.g., `1080/1920 = 0.5625` for 9:16).
  - Aspect-fit: `if (src_w / src_h) > target_aspect: fit_h = src_h; fit_w = src_h * target_aspect; else: fit_w = src_w; fit_h = src_w / target_aspect`.
  - Punch-in (`zoom >= 1.0`; `zoom < 1.0` rejected with `ClipChainError::InvalidZoom`): `crop_w = fit_w / zoom; crop_h = fit_h / zoom`.
  - Center alignment: `crop_x_center = focal.x * src_w; crop_y_center = focal.y * src_h`.
  - Top-left: `crop_x = clamp(crop_x_center - crop_w/2, 0, src_w - crop_w); crop_y = clamp(crop_y_center - crop_h/2, 0, src_h - crop_h)`.
  - All four crop values rounded half-away-from-zero to integer (FFmpeg's `crop` filter takes integers; subpixel cropping is not supported).
- `scale` to `video_slot.w × video_slot.h` (the slot dims, fixed per export).
- `format=yuva444p10le` adds the alpha channel needed for downstream `pad` / `alphamerge`.

The per-clip audio sub-graph (same clip, speed=1.5):

```
[0:a]atrim=start=0.500000:end=3.500000,asetpts=PTS-STARTPTS,atempo=1.500000[a0]
```

For speed=4.0, the chain expands to `atempo=2.000000,atempo=2.000000`. For speed=0.25, `atempo=0.500000,atempo=0.500000`. For speed=1.0, no `atempo` filter is emitted (identity). The decision matrix lives in `chain_atempo(1.0) -> [1.0]` returning `[]` after a final `if factors == [1.0] { factors.clear() }` — emitted as no audio-tempo filter at all when speed is 1×, saving a no-op pass.

### Filtergraph builder (in `src-tauri/src/export/filtergraph.rs`)

```rust
pub fn build_video_only_filtergraph(
    visible_clips: &[VisibleClipInput],
    slot: PixelRect,
    output: OutputDimensions,
    corner_mask_png_path: Option<&Path>,
    fps: u32,
    encoder: &EncoderChoice,
    audio_encoder_args: &[&str],
    output_path: &Path,
) -> FiltergraphPlan;
```

The argv it emits, for the no-corner-radius case (Split layout, or PiP with the video-as-background — `video_slot` rect = full output frame):

```
ffmpeg -hide_banner -y \
  -i {clip_0_path} \
  -i {clip_1_path} \
  ... \
  -filter_complex "
    [0:v]trim=start=…:end=…,setpts=…,crop=…,scale={vw}:{vh},format=yuva444p10le[v0];
    [1:v]trim=…,setpts=…,crop=…,scale={vw}:{vh},format=yuva444p10le[v1];
    …
    [v0][v1]…concat=n=N:v=1:a=0[vc];
    [vc]pad={out.w}:{out.h}:{slot.x}:{slot.y}:color=#00000000[vout];
    [0:a]atrim=…,asetpts=PTS-STARTPTS,atempo=…[a0];
    [1:a]atrim=…,asetpts=PTS-STARTPTS,atempo=…[a1];
    …
    [a0][a1]…concat=n=N:v=0:a=1[aout]
  " \
  -map "[vout]" -map "[aout]" \
  -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le -vendor apl0 \
  -c:a pcm_s16le \
  -movflags +faststart \
  {output_path}
```

For the corner-radius case (`corner_radius_slot == Video`, `corner_radius_px > 0`):

```
ffmpeg -hide_banner -y \
  -i {clip_0_path} \
  -i {clip_1_path} \
  ... \
  -loop 1 -i {corner_mask_png_path} \
  -filter_complex "
    [0:v]trim=…,setpts=…,crop=…,scale={vw}:{vh},format=yuva444p10le[v0];
    [1:v]trim=…,setpts=…,crop=…,scale={vw}:{vh},format=yuva444p10le[v1];
    …
    [v0][v1]…concat=n=N:v=1:a=0[vc];
    [{N}:v]format=gray[mask];
    [vc][mask]alphamerge[vmasked];
    [vmasked]pad={out.w}:{out.h}:{slot.x}:{slot.y}:color=#00000000[vout];
    [0:a]atrim=…,asetpts=PTS-STARTPTS,atempo=…[a0];
    …
    [a0][a1]…concat=n=N:v=0:a=1[aout]
  " \
  -map "[vout]" -map "[aout]" \
  -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le -vendor apl0 \
  -c:a pcm_s16le \
  -movflags +faststart \
  {output_path}
```

Notes on the filtergraph:

- **Source files, not stdin.** Channel C reads original source files (one `-i {path}` per visible clip). The renderer worker contributes nothing here — `frame_bytes_per_input: 0` in the returned `FiltergraphPlan`, used as a flag by the runner to confirm "no rawvideo input" expectations.
- **`format=yuva444p10le` per clip, not after concat.** Concat requires all input streams to share the same pixel format. Forcing each clip's chain to end in `yuva444p10le` makes the concat input-compatible without an extra normalization pass. (Tested locally; concat of `yuv420p` and `yuv444p` streams without per-input `format=` produces a "concat: input streams don't match" failure.)
- **`pad` after `alphamerge`, not before.** Same reasoning as 060: `pad=color=#00000000` produces transparent fill only if the stream already has alpha. The clip chain's `format=yuva444p10le` handles this for the no-mask case; the alphamerge intermediate keeps alpha for the mask case. Reversing the order (pad-then-alphamerge) reintroduces the "blackened opaque region" failure mode 060 documented.
- **`-loop 1` mask input is the *last* input.** The mask input index is `visible_clips.len()` — one past the last clip. Documented in `build_video_only_filtergraph`'s implementation comment so a future refactor doesn't reorder the inputs and silently break the mask reference.
- **Audio fallback for clips without an audio stream.** If `has_audio` is `false` for any clip, the corresponding `[N:a]` sub-graph is replaced by `aevalsrc=0:duration={span_s}:sample_rate=48000[a{N}]` so the concat's `n` count matches the video side. Without this, FFmpeg's concat filter errors with "Input link parameters do not match." Rare in practice (iPhone videos always carry audio) but a real edge case for re-imported edits.
- **`-c:a pcm_s16le` chosen over AAC.** ProRes 4444 in `.mov` is a compositing intermediate; matching it with PCM (lossless) keeps the entire B+C → NLE round-trip lossless. AAC re-encodes audio losslessly enough for delivery but introduces a re-encode step the user might already be paying for downstream. PCM also sidesteps the small-sample-count edge cases AAC has at clip boundaries.
- **`-movflags +faststart` matters even for intermediates.** A user who scrubs B.mov / C.mov in QuickTime / Resolve gets instant seek with the moov atom at the head; without `+faststart`, large files require a full read before scrubbing works. Free correctness win.
- **No `-frames:v` cap.** For Channel B (rawvideo via stdin), `-frames:v` was needed to terminate the looped corner-mask input. For Channel C, the concat output has a natural duration (sum of trimmed clip spans), and `alphamerge` ends with the shorter of its inputs; the mask's infinite-loop terminates cleanly when the concat ends. Adding `-frames:v` would require computing the exact frame count from FPS × concat duration, and any rounding mismatch would truncate or pad — no upside.

### `FFmpegRunner` (in `src-tauri/src/export/ffmpeg_runner.rs`)

```rust
pub struct FFmpegRunner {
    child: tokio::process::Child,
    stderr_handle: tokio::task::JoinHandle<()>,
    stderr_tail: Arc<Mutex<VecDeque<u8>>>,  // last 4 KB ring buffer; pattern shared with FFmpegSink
}

impl FFmpegRunner {
    pub async fn spawn(ffmpeg_path: &Path, argv: &[String]) -> Result<Self, FFmpegRunnerError>;
    pub async fn wait(self) -> Result<FFmpegRunResult, FFmpegRunnerError>;
}

pub async fn run_ffmpeg(ffmpeg_path: &Path, argv: &[String]) -> Result<FFmpegRunResult, FFmpegRunnerError> {
    let runner = FFmpegRunner::spawn(ffmpeg_path, argv).await?;
    runner.wait().await
}
```

`wait` blocks until exit (no timeout for v1; FFmpeg encoder hangs are rare in practice and the user can cancel the app — cancellation is a 110 concern). On non-zero exit, returns `FFmpegRunnerError::EncoderFailed { exit_code, stderr_tail, wall_clock_ms }`.

### `render_export` `video_only` branch (in `src-tauri/src/export/mod.rs`)

```rust
async fn render_export_video_only(req: RenderExportRequest, started: Instant) -> Result<RenderExportSummary, RenderExportError> {
    // 1. Layout parity check (shared with map_only — extract).
    // 2. Read clips + filter visible.
    // 3. Validate source files exist + probe dims/audio (parallel, 8-way capped).
    // 4. Compute total_frames from timeline.
    // 5. Pick map_slot is unused; we use video_slot only.
    // 6. select_encoder(EncoderClass::ProResAlpha).
    // 7. Generate corner mask iff corner_radius_px > 0 && corner_radius_slot == Video.
    // 8. build_video_only_filtergraph(...).
    // 9. run_ffmpeg(ffmpeg_path, &plan.argv).
    // 10. On success: RenderExportSummary { frames_written: total_frames, output_path, wall_clock_ms }.
    // 11. On failure: classify into RenderExportError { stage, message, stderr_tail }.
}
```

The shared validation between `map_only` and `video_only` (steps 1, 4, parity check, total_frames math) is extracted into private helpers — `fn validate_request(req: &RenderExportRequest) -> Result<ValidatedRequest, RenderExportError>` — so the two branches don't drift.

## Acceptance criteria

- [ ] `cargo build` (in `src-tauri`) succeeds with the new modules and command branch wired in.
- [ ] `cargo clippy --all-targets -- -D warnings` (in `src-tauri`) is clean.
- [ ] `npm run lint`, `npm run build`, `npm run test:run` pass.
- [ ] **Clip-chain unit tests** (`cargo test --lib export::clip_chain`):
  - **Video subgraph**: representative cases — `(speed=1.0, zoom=1.0)`, `(speed=2.0, zoom=1.5)`, `(speed=0.5, zoom=1.0)`, focal at `(0, 0)`, focal at `(1, 1)`, source `3840×2160` to slot `1080×1920` — emit the expected exact string with 6-decimal float precision and integer crop rect.
  - **Audio subgraph**: `speed=1.0` emits no `atempo`; `speed=2.0` emits `atempo=2.000000`; `speed=4.0` emits `atempo=2.000000,atempo=2.000000`; `speed=0.25` emits `atempo=0.500000,atempo=0.500000`; `speed=5.0` emits `atempo=2.000000,atempo=2.000000,atempo=1.250000`.
  - **Focal crop**: aspect-fit at all three target aspects produces a rect that fits inside the source; punch-in at zoom=2 produces a rect with half the aspect-fit dims; focal at `(0, 0)` clamps `crop_x = 0, crop_y = 0`; focal at `(1, 1)` clamps to the bottom-right.
  - **Invalid-zoom rejection**: `zoom = 0.5` returns `ClipChainError::InvalidZoom` (LAYOUT.md §7 — `zoom < 1.0` is disallowed).
  - **Missing source dims**: `source_dims` of 0×0 (clip with no probed resolution) returns `ClipChainError::MissingSourceDims`. Test verifies the error variant, not just an arbitrary failure.

- [ ] **Filtergraph unit tests** (`cargo test --lib export::filtergraph`):
  - Single visible clip, no corner radius, video as full-bleed background → argv has 1 `-i`, `filter_complex` contains `[v0]…concat=n=1:v=1:a=0[vc]`, no `alphamerge`.
  - Two visible clips, no corner radius → argv has 2 `-i`, `concat=n=2:v=1:a=0`, no mask input.
  - Two visible clips, with corner radius (video as inset) → argv has 3 `-i` (2 clips + mask), `-loop 1` immediately precedes the mask path, `filter_complex` contains `alphamerge`.
  - One clip without audio (`has_audio: false`) → audio sub-graph emits `aevalsrc=…[aN]` instead of `[N:a]atrim…`.
  - `frame_bytes_per_input == 0` for every fixture (Channel C has no rawvideo input).

- [ ] **`run_ffmpeg` unit test** — invokes `ffmpeg -version` (zero-frame test that exits cleanly), asserts exit code 0 and a non-empty `stderr_tail`. Negative test: `ffmpeg -nonexistent_flag` returns `FFmpegRunnerError::EncoderFailed` with the stderr tail containing "Unrecognized option".

- [ ] **Integration test passes** (`cargo test --test render_export_video_only --features integration_export`):
  - Refuses to run without bundled / system FFmpeg + ffprobe (mirrors 060's guard).
  - Builds a fixture project with two visible clips (real test-fixture videos in `src-tauri/tests/fixtures/clips/`; `git lfs` if too large, otherwise small sub-second `.mp4` clips authored once and committed).
  - **Default 9:16 PiP layout (video as full-bleed background)**: exports a `.mov`, asserts via FFprobe:
    - Video: `prores`, `yuva444p10le`, `1080×1920`, `nb_frames` matches expected, `duration ≈ 2.0s ± frame`.
    - Audio: 1 `pcm_s16le` stream, `duration` matches video ± 50ms.
    - Frame 30 pixel at video slot center is non-(0,0,0) and alpha=255.
  - **Inset variant (`inset_source: 'video'`, `corner_radius: 0`)**: pixel at `(10, 10)` outside the inset has alpha=0; pixel at the inset center has alpha=255 and is non-(0,0,0).
  - **Inset variant with corner radius (`corner_radius: 0.05`)**: a pixel exactly on the corner-arc center has alpha ∈ `(0, 255)`; the alpha falloff is monotonic.

- [ ] **Layout parity check at the IPC boundary** (covered in 060; assert it still works for `video_only` path) — a tampered `LayoutDescriptor.resolved` is rejected before any FFmpeg / ffprobe work begins. Test: tamper, expect `RenderExportError::validation`.

- [ ] **No reimplementation of layout math in `clip_chain` or `filtergraph`.** Grep at acceptance time:
  - `grep -nE "1080|1920|1350|OUTPUT_DIMS" src-tauri/src/export/clip_chain.rs src-tauri/src/export/filtergraph.rs` returns nothing — slot dims arrive as `PixelRect`/`OutputDimensions` parameters; output dims are not duplicated.
  - `grep -nE "resolveSlots|resolve_slots" src-tauri/src/export/clip_chain.rs` returns nothing — the clip chain doesn't compute slots, only consumes them.

- [ ] **The renderer worker is uninvolved.** Grep at acceptance time:
  - `grep -nE "render_map_frames|OrchestratorConfig|SetupPayload" src-tauri/src/export/clip_chain.rs src-tauri/src/export/ffmpeg_runner.rs src-tauri/src/export/ffprobe.rs` returns nothing.
  - The `video_only` branch in `render_export` does not call `render_map_frames` (verified by reading mod.rs; documented as an inline comment marking the structural divergence from `map_only`).

- [ ] **Manual smoke test on macOS dev machine.** Author opens a project with 2+ clips, clicks "Export video-only (.mov)", picks a path, waits for the export. Drops the resulting `.mov` into Resolve / Premiere / FCP (or QuickTime if no NLE handy). The video plays at 9:16 with audio passing through; in NLEs, the video sits at its slot rect with alpha=0 elsewhere when the layout is PiP-with-video-as-inset. Subjective: video frame timing matches editor playback at the same `t` values. Subjective audio: no glitches at clip boundaries; speed-adjusted audio sounds right (no chipmunking artifacts beyond what `atempo` produces normally).

- [ ] **B + C stack composites correctly.** Run two exports back-to-back at the same default layout (one B from 060, one C from this task). Drop both into an NLE, stack on two video tracks (B above C, or C above B — they're masked positional). The composite visually matches what a future Channel A would produce: video at the video slot, map at the map slot, transparent regions of one channel reveal the other. This is the load-bearing user promise from LAYOUT.md §6.

- [ ] `docs/export/tasks/README.md` row 070 flipped to ✅, this file linked.

## Implementation notes

**Why Channel C bypasses the orchestrator entirely.** The orchestrator's job (030) is to drive a renderer worker that produces map frames over stdin. Channel C has no map. Wedging the orchestrator into this channel — with a "no-op" renderer worker, or a `FrameSink` that swallows nothing — would add code, surface area, and conceptual confusion for zero benefit. The cleanest design is the structural mirror: 060/090 use orchestrator-plus-FFmpegSink; 070 uses FFmpegRunner only. The shared seam between channels is at a higher level — they all return `RenderExportSummary` or `RenderExportError`, both branches go through the same `validate_request` helper, both spawn FFmpeg with `select_encoder(ProResAlpha)` flags. The orchestrator-vs-runner split is below that seam.

**Why the per-clip chain is in `clip_chain.rs`, not inline in `filtergraph.rs`.** Channel A (090) consumes the same builder. Putting it next to the `build_*_filtergraph` functions would couple the chain to a single channel's filter shape; extracting it makes 090's job trivially "concat the clip chain into the composite filtergraph at the right point." The `filtergraph.rs` for `video_only` is thin glue: assemble per-clip strings, add concat, add pad, add audio concat, splice in the encoder args. The math lives in `clip_chain.rs`.

**Why we probe sources at request time, not at request build time.** The frontend `buildExportRequest` currently passes `clips: Clip[]` opaquely. The `Clip.resolution` field is a string ("1920x1080") populated at import time via ExifTool — sometimes accurate, sometimes truncated (rotation metadata can confuse the parse). Probing via FFprobe at export time — when we already need to confirm the file exists and is encodable — is a one-stop validation. Caching by `(path, mtime)` for the duration of the export means re-probing the same clip across multiple test runs in CI is cheap. Cross-export caching (persistent on disk) is a follow-up; export volumes are too low for v1 to benefit.

**Why FFprobe lives in its own module instead of a private helper.** Channel A (090) needs the same probe — same audio detection, same dim verification — and 070's caller is the first one to write it. Promoting to a module keeps 090 from open-coding the same logic. The probe is also a candidate for unit testing in isolation (parse a known FFprobe JSON output, assert the right fields are extracted) without spawning ffprobe.

**Why `pcm_s16le` audio, not AAC.** Channel C is a compositing intermediate. AAC's lossy encode + the inevitable AAC re-encode in any final NLE-driven export means the user's audio gets re-encoded twice for no quality reason. PCM is lossless, plays everywhere, and matches the ProRes 4444 video's "lossless intermediate" vibe. File size cost: PCM stereo at 48kHz is ~1.5 Mbps, negligible compared to ProRes's ~700 Mbps.

**Why `atempo` chained instead of `rubberband`.** FFmpeg has `rubberband` for higher-quality time-stretching (`-af "rubberband=tempo=4.0"`), but it depends on the librubberband build flag (not in every FFmpeg static build) and is much slower (~10× the CPU of `atempo`). LAYOUT.md §7 commits to `atempo` chained as the v1 audio-speed primitive; `rubberband` is a v2 quality-knob option. The decomposition algorithm in `chain_atempo` is one screen of code and well-tested.

**Why `-c:v` and `-c:a` come *after* `-map`, not before.** FFmpeg accepts both orderings, but the convention in the FFmpeg docs and most published filter recipes is `-map [stream] -c:v {codec} -c:a {codec} {output}`. Sticking to convention makes the argv readable when surfaced in a log file or stderr-tail-on-error dialog. Mechanical consistency with 060's emitted argv shape too.

**Why `concat` with `n=N` instead of the demuxer-level `concat` protocol.** FFmpeg has two distinct concat features: the `concat` filter (used here) operates on filter-graph streams, and the `concat` demuxer (`-f concat -i list.txt`) operates on file inputs. For Channel C, we *must* apply per-clip filters (trim, setpts, crop, scale) before concatenation — that's incompatible with the demuxer-level concat. The filter-level concat is the only fit.

**Why focal-crop math runs in Rust, not in TS at request-build time.** The crop math depends on the *probed* source dimensions, not the `clip.resolution` field. Probing is a Rust-side step (FFprobe, async, error-prone). Doing the crop in TS would require either probing in TS (impossible — Tauri doesn't expose ffprobe to the frontend, and the asset-protocol layer doesn't help) or trusting `clip.resolution` (sometimes wrong). Doing it in Rust after probing is the only architecture that consistently produces the right crop rect. The TS preview's `CropOverlay.tsx` already does its own version with the editor's playback dims — that's a UI concern, not the export's source of truth.

**Why no fade-in/fade-out between clips.** The `concat` filter produces hard cuts at clip boundaries — that matches the editor's preview, which also hard-cuts. Adding crossfades is a feature decision that LAYOUT.md doesn't authorize; deferring keeps Channel A's composite (090) honest to the editor preview. Animated layout transitions (the v2+ feature alongside per-clip layout overrides) is the right place to revisit this.

**Why we error on empty visible-clip list instead of producing an empty `.mov`.** A 0-byte / 0-frame export is never what the user wants; it's a configuration mistake. Erroring with `RenderExportError::validation { message: "no visible clips — nothing to render" }` is the right failure mode. (For Channel B, an empty timeline produces a no-op map render with no markers — but the timeline still has duration. For Channel C, "no visible clips" means literally no inputs, no concat, no output. The `concat` filter rejects `n=0`.)

**`MissingSourceFile` error vs ffprobe failure.** A clip whose source file has been moved or deleted should fail with a clear "source missing" message before the ffprobe step (which would emit a less actionable "ffprobe failed: No such file or directory"). The validation in step 3 of the branch checks `Path::exists()` per clip; ffprobe runs only on existing files. Cost: one syscall per clip, negligible.

**Why `RenderExportSummary.frames_written` for `video_only` is computed, not measured.** FFmpeg's actual encoded frame count is reported in stderr (`frame= 60 fps=...`) but parsing stderr for it is fragile. The timeline's frame count is the user-visible truth: timeline says 2 seconds at 30fps, the user expects 60 frames. Returning that value matches user expectations; the integration test verifies via FFprobe that FFmpeg actually produced exactly that count.

**The frontend export-button parallels 060 deliberately.** Two buttons in the same toolbar — "Export map-only (.mov)" and "Export video-only (.mov)" — share the export-state UI (`exporting`, `exportError`, `exportDetailsOpen`). The configurator UI (110) replaces both buttons with a single export-settings dialog that picks channel(s) + aspect + output path; until then, two buttons in the toolbar is the fastest UX scaffolding. Documented as a known UX limitation: a user wanting both B and C runs two export passes.

**`-an` was for Channel B; `-c:a pcm_s16le` is for Channel C.** Channel B had `-an` to drop audio (LAYOUT.md §8 — silent). Channel C has audio. Both are explicit on the argv; neither relies on FFmpeg's defaults. The filtergraph builders for B and C diverge at exactly this point.

**Hidden clips and the timeline's `totalDurationMs`.** The timeline (compiled from `clips` via `compileTimeline` in TS) already excludes hidden clips from its duration computation. So `req.project_state.timeline.totalDurationMs` is "duration of the visible portion." 070's branch reads visible clips directly from `clips` (not from the compiled timeline) for filter-chain construction, but uses the timeline's duration for `total_frames`. Consistency is structural — `compileTimeline` and the visible-clip filter both walk the same `clip.visible` field.

## Open questions deferred to follow-up tasks

- **Progress reporting via Tauri events.** Same as 060: deferred to 110 with the configurator's progress UI. Channel C is generally faster than B (no map render), so the user-visible "Exporting…" → "Done" wait is shorter, but still real for a 60s+ project.
- **Export cancellation.** Same as 060: deferred to 110.
- **Source file integrity on import.** A clip that points to a removed source file is caught at export time today, with a `MissingSourceFile` error. A nicer UX would warn the user at edit time (red banner on the clip in the timeline). UI concern; not blocking.
- **Audio fade-in/fade-out at clip boundaries.** Hard cuts mirror the editor preview; soft transitions are a v2+ feature paired with animated layout transitions.
- **Audio loudness normalization.** `loudnorm` is a single FFmpeg filter and a real quality-of-life win for hike videos with wildly varying audio levels. Out of scope; this is a polish feature for v2.
- **Music track.** LAYOUT.md §8 explicitly defers; Channel C's audio chain is the foundation that a future "music track" feature mixes onto.
- **Per-clip volume / mute.** Trivial extension to the audio chain (`volume={mul}` after `atempo`); no UX yet to drive it. Defer.
- **Channel A composite.** 090 reuses this task's `clip_chain` builder verbatim, plus 060's `build_map_only_filtergraph` shape (extended to overlay the video on top of the map render stream rather than padding to a transparent canvas). The filter sequence is well-trodden; the new bits in 090 are H.265 encoder selection + the overlay-with-corner-mask filter for compositing.
- **Sidecar bundling.** 070 calls FFmpeg + ffprobe from PATH (`Command::new("ffmpeg")`, `Command::new("ffprobe")`). Per-platform bundled binaries land in 130. The runner reads paths through resolver cells (same pattern as 060/030/040).

## Doc tie-in

- PLAN.md §"Channels" — Channel C is "processed source clips → ProRes 4444 with alpha at full output dim, content at slot rect, alpha=0 elsewhere." 070 implements this row.
- PLAN.md §"Rust → FFmpeg" — Channel C's filtergraph is the more complex of the three sketched there. The per-clip chain plus concat plus pad pattern is exactly what 070 builds.
- PLAN.md §"IPC contract" — `render_export` for `video_only` reuses 060's wire shape; the only divergence is the `channel` string. `source_clips: ClipSourceRef[]` from the original PLAN sketch becomes "the `clips: Clip[]` field already on the request, filtered to visible" — no separate field needed since `Clip` already carries source path, trim, focal_point, effects.
- LAYOUT.md §6 — masked positional export is the load-bearing invariant; Channel C's pad at `video_slot` rect with optional `alphamerge` is what enforces it.
- LAYOUT.md §7 — per-clip video chain (trim → setpts → crop → scale) is *the* spec for `clip_chain.rs`; this task is its implementation. Per-clip audio chain (atrim → atempo) likewise.
- LAYOUT.md §8 — Channel C has audio; per-clip source passthrough with `atempo` chained for extreme speeds. PCM s16le mux is consistent with the "lossless intermediate" framing.
- 040 — `select_encoder(EncoderClass::ProResAlpha)` returns the same ProRes choice 060 uses; the encoder selection contract is shared.
- 050 — `LayoutDescriptor`, `resolve_slots`, `OUTPUT_DIMS`. The `corner_radius_slot` field gates whether 070 generates a corner mask (only when `== Video`); Channel B made the mirror choice (`== Map`). One layout descriptor, three channel-specific behaviors driven by the same field.
- 060 — Filtergraph builder pattern, corner-mask generator (reused verbatim — `build_corner_mask_png` doesn't care which slot it's masking), FFmpeg-spawn structured-error pattern (`FFmpegSink::stderr_tail` becomes `FFmpegRunner::stderr_tail`), `RenderExportRequest` / `RenderExportSummary` / `RenderExportError` shapes. After 070, 090's job is "compose 060's map render + 070's video chain into one filtergraph + one H.265 encode pass."
