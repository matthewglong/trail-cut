# Task 090 — Channel A (composite) end-to-end

**Step**: Export pipeline (the headline deliverable — map + processed video composited into a single H.265 `.mp4` per layout, at the chosen aspect)
**Estimated effort**: ~2 days (12–18h)
**Status**: pending
**Depends on**: 030 (orchestrator + `FrameSink` seam — used here just like in 060), 040 (`select_encoder(EncoderClass::Hevc)` — *new* class for this task; 060/070 used `ProResAlpha`), 050 (`LayoutDescriptor`, `resolve_slots`), 060 (FFmpegSink + corner-mask generator + `render_export` shape — extended here), 070 (`clip_chain` builders + `ffprobe::probe_clip` + `VisibleClipInput` — consumed verbatim), 080 (a populated `project.layouts['9_16']` so the export reads a real stored layout, not a `pickLayout` fallback).

## Goal

Ship the third and final v1 export channel — the headline deliverable: a single H.265 `.mp4` that composites the map render stream and the per-clip processed video stream into one frame per the configured layout, at the chosen aspect, with audio. After this task:

- A new `build_composite_filtergraph(...)` joins `build_map_only_filtergraph` and `build_video_only_filtergraph` in `src-tauri/src/export/filtergraph.rs`. It accepts both the map slot (rawvideo input on stdin) **and** the per-clip video chain (file inputs), composites them via `overlay` filters per the layout mode (PiP-map-as-inset, PiP-video-as-inset, or Split), and emits the argv FFmpeg ingests.
- The `render_export` Tauri command's `channel == "composite"` branch fills in (replacing the catch-all `Err("channel not yet implemented…")`). The branch is the structural union of 060 and 070: it spawns the renderer worker pool via `render_map_frames` (like 060), and reads source video files directly (like 070), with a single FFmpeg child consuming both the rawvideo stdin and the source-file inputs.
- A third toolbar button "Export composite (.mp4)" lands in `ProjectView.tsx`, parallel to 060's and 070's buttons. The configurator UI (110) replaces all three with one export-settings dialog; until then, three buttons.
- A passing integration test produces a real `.mp4` from a fixture project (two visible clips), asserts FFprobe reports `(1080×1920, hevc, yuv420p, duration matches Σ trimmed-and-speed-adjusted clip spans, 1 audio stream aac)`. A "compositing parity" test renders B and C separately, then renders A, then composites B+C in FFmpeg externally and pixel-compares the result against A — within a tolerance budget for codec rounding (per PLAN.md's "B+C stack reconstructs A" promise from LAYOUT.md §6).

This is the third task that puts pixels on disk and the first that produces a *deliverable* rather than a compositing intermediate. Everything 060/070 built was scaffolding for this moment: the orchestrator drives map frames into the same FFmpeg child that's also reading source video files; the per-clip chain from 070 is consumed verbatim; the corner-mask generator from 060 is reused without modification. 090 is "compose the two channels' filter shapes into one filtergraph and pick a different encoder."

**The load-bearing invariant — A is the union of B and C.** LAYOUT.md §6 settles it: "A user can stack B.mov and C.mov in any NLE and reconstruct A's composite with no positioning work." That promise is only kept if A is, structurally, "B's map-render pipeline + C's per-clip video pipeline + an `overlay` instead of two separate `pad`s." Drift between A's composite and (B + C externally composited) means a user who exports A directly and a user who exports B+C and stacks them in Resolve get *different pixels* — which silently breaks the whole compositing-intermediate UX. The invariant is enforced two ways: structurally (`build_composite_filtergraph` calls into the same `build_clip_chain` and the same `corner_mask` builder that 070/060 use) and empirically (the parity integration test above). Drift is detectable, not theoretical.

**The second load-bearing invariant — A is opaque, B and C are masked.** Channels B and C are full-frame ProRes 4444 with alpha=0 outside their slot rect (LAYOUT.md §6's masked-positional semantics). Channel A is the *deliverable*; it has no transparent regions. The output canvas for A is opaque — Split mode fills any uncovered slot edge with black; PiP mode covers the full frame because one source is full-bleed background. This is enforced by the filtergraph's choice of `overlay` (composites onto an opaque base) over B/C's `pad=color=#00000000` (composites onto a transparent canvas). The pixel format chain ends in `yuv420p` for H.265 4:2:0 compatibility (no alpha channel in the output stream), where B/C ended in `yuva444p10le`.

## Files to touch

- Modified: `src-tauri/src/export/filtergraph.rs` — add `build_composite_filtergraph(...)` alongside the existing two builders. Public surface:
  ```rust
  #[allow(clippy::too_many_arguments)]
  pub fn build_composite_filtergraph(
      visible_clips: &[VisibleClipInput],   // reused from 070; same shape, same probe
      map_slot: PixelRect,                  // resolved.map_slot
      video_slot: PixelRect,                // resolved.video_slot
      output: OutputDimensions,
      composite_mode: CompositeMode,        // see below
      corner_mask_png_path: Option<&Path>,  // some only when corner_radius_px > 0
      fps: u32,
      total_frames: u32,                    // caps the rawvideo input (same role as 060)
      video_encoder: &EncoderChoice,        // EncoderClass::Hevc
      audio_encoder_args: &[&str],          // ["-c:a", "aac", "-b:a", "256k"]
      output_path: &Path,
  ) -> Result<FiltergraphPlan, ClipChainError>;

  #[derive(Debug, Clone, Copy)]
  pub enum CompositeMode {
      /// PiP, map is the inset (small) and video is the full-bleed background.
      /// `corner_radius_slot == Map`.
      PipMapInset,
      /// PiP, video is the inset (small) and map is the full-bleed background.
      /// `corner_radius_slot == Video`.
      PipVideoInset,
      /// Split — map and video tile the frame at their slots, no overlap,
      /// no corner radius (LAYOUT.md §1 — Split has no inset).
      Split,
  }
  ```
  The plan's `frame_bytes_per_input == map_slot.w * map_slot.h * 4` (same role as Channel B's — the orchestrator writes RGBA frames at the map slot dims). Internally, `composite_mode` is derived from `(layout.layout, resolved.corner_radius_slot)` by the `render_export` branch and passed in; the builder is a pure function of its inputs.

- Modified: `src-tauri/src/export/mod.rs` — implement `channel == "composite"` in `render_export`. The branch:
  1. **Lifts encoder selection out of `validate_request`.** Today `validate_request` hard-codes `select_encoder(EncoderClass::ProResAlpha)`. Channel A needs `EncoderClass::Hevc`. Refactor: `validate_request` no longer touches the encoder; each channel's branch picks its own. The other shared validation (parity check, total-frames math, output-dims extraction) stays in `validate_request`. ProResAlpha selection moves into `render_export_map_only` and `render_export_video_only` (one line each).
  2. Validates the request via the (now encoder-free) `validate_request`.
  3. Reads + filters `visible: Vec<Clip>` from `project_state.clips` (mirrors `render_export_video_only`'s extraction step). Errors on empty.
  4. Validates source-file existence per clip (mirrors 070).
  5. Probes each source via `probe_clips_capped(...)` — the helper from 070 is reused without change.
  6. Determines `composite_mode` from the resolved layout — `match (req.layout.layout, req.layout.resolved.corner_radius_slot)` produces one of the three variants.
  7. Generates the corner-mask PNG iff `corner_radius_px > 0`. The mask dims are the *inset's* slot dims (whichever slot has `corner_radius_slot`). For `Split`, `corner_radius_px` is structurally always 0 (Split has no inset, so `resolve_slots` returns `corner_radius_px = 0` for split layouts — verified at acceptance time).
  8. Selects the HEVC encoder: `select_encoder(EncoderClass::Hevc)`.
  9. Builds the filtergraph: `build_composite_filtergraph(...)`.
  10. Spawns `FFmpegSink::spawn(...)` with `frame_bytes_per_input = map_slot.w * map_slot.h * 4` (rawvideo input on stdin). **Not** `FFmpegRunner` — Channel A reads rawvideo from the renderer worker.
  11. Drives the orchestrator: `render_map_frames(setup, total_frames, OrchestratorConfig::default(), Box::new(sink))` with `viewport: { w: map_slot.w, h: map_slot.h }`. Same call as 060.
  12. On success: `RenderExportSummary { frames_written, output_path, wall_clock_ms }`.
  13. On failure: classify into `RenderExportError { stage, message, stderr_tail }` via the existing `classify_orchestrator_error` / `classify_clip_chain_error` helpers extended with one new `From<FFmpegSinkError>` arm shared with 060.

- Modified: `src-tauri/src/export/error.rs` — extend `RenderExportError` taxonomy if needed for composite-specific failures. In practice, 070's existing `ClipChainError`, `FfprobeError`, `FFmpegSinkError`, and `OrchestratorError` cover everything 090 can fail with; this file changes only if a new compose-specific failure surface emerges (e.g., "map_slot and video_slot don't tile the output frame in Split mode" — a layout-validity check that probably belongs in `resolve_slots` rather than `error.rs`). Confirm at implementation time.

- Modified: `src-tauri/src/lib.rs` — no change (the `render_export` command is already registered; the new branch lives inside it).

- Modified: `src/lib/exportRequest.ts` — no API change; `ExportChannel` already includes `'composite'`. Add a unit test asserting that `buildExportRequest({ channel: 'composite', ... })` produces a wire shape that round-trips through Rust's `RenderExportRequest::deserialize` (mirrors 070's TS-side test). The shape is identical to 070's; the Rust-side branch reads the same fields.

- Modified: `src/screens/ProjectView.tsx` — third toolbar button "Export composite (.mp4)", parallel to 060's and 070's. Wired to a file-save dialog (`save({filters: [{name: "MP4", extensions: ["mp4"]}]})`) and `invoke('render_export', buildExportRequest({ channel: 'composite', ... }))`. Disabled while another export is in flight; shows "Exporting…" indicator. Same UX scaffolding as 060/070's; the only divergence is the channel string and the file-extension filter.

- New: `src-tauri/tests/render_export_composite.rs` — integration test. Refuses to run without `--features integration_export` (mirrors 060/070). Constructs a fixture project with **two visible clips** (covers the per-clip concat path), 2-second route, default 9:16 PiP-bottom-right layout (which is `inset_source: 'map'` per `defaultLayout('9_16')` — so `composite_mode == PipMapInset`, video as full-bleed background, map as inset). Drives `render_export` to a temp dir, asserts FFprobe output:
  - Video: `width=1080`, `height=1920`, `codec_name=hevc`, `pix_fmt=yuv420p`, `nb_frames` matches the timeline frame count, `duration ≈ 2.0s ± frame`.
  - Audio: 1 stream, `codec_name=aac`, `sample_rate >= 44100`, `channels in [1, 2]`, `duration` matches video duration ± 50ms.
  - Frame 30 (mid-timeline): pixel at `(540, 960)` — frame center, inside the video's full-bleed coverage but outside the map inset rect (default inset is bottom-right) — has alpha=255 (opaque output) and non-(0,0,0) RGB (the source video's pixel).
  - Frame 30: pixel at the inset's *center* — the configured inset rect's `(x + w/2, y + h/2)` — is non-(0,0,0) and visibly *not* the source video at that location (the map covers it). A weak assertion (RGB difference > 30 in at least one channel) is sufficient — we're not pixel-equal-asserting; we're confirming the composite ran.
  - A second `#[test]` case using `inset_source: 'video'` (`composite_mode == PipVideoInset`): pixel at `(540, 960)` shows the *map's* coverage (no alpha, opaque, distinct from a "what the video would have shown there" baseline). Pixel at the inset's center shows the video.
  - A third `#[test]` case using a Split layout (synthesized — `defaultLayout` returns PiP, so the test constructs a `LayoutConfig::Split` directly): pixel sampling at the divider's two halves shows map on one side, video on the other. No corner-mask path is exercised here.
  - **Compositing parity test** (`#[test]` flagged behind a sub-feature `integration_export_parity` since it runs three exports back-to-back and is the slowest test in the suite): export B at the test layout, export C at the same layout, run an external FFmpeg invocation that overlays C onto B and re-encodes as H.265 with the same encoder choice as A. Then export A. Pixel-diff frame 30 of (A) vs (B+C-composited): mean per-channel difference < 5/255, max per-channel difference < 30/255 (codec-rounding tolerance — H.265 lossy at CRF ~17 is not bit-exact across two encode passes). The tolerance is a guard against gross structural drift, not a bit-equality check; it catches the failure modes that matter (wrong slot, wrong overlay coords, wrong corner mask, wrong concat ordering).

- New (or modify existing): `src-tauri/tests/fixtures/clips/` — same fixture clips as 070 (two short `.mp4`s with audio), already on disk per 070's setup. Confirm at acceptance time.

- Modified: `docs/export/tasks/README.md` — flip 090 to ⬜→🟡→✅ as it lands; link this file. Remove the now-stale "Tasks beyond 060 are not yet authored" line at the bottom.

- Untouched in this task: layout configurator UI (110), additional aspects beyond what the integration test fixtures exercise (100), parity verification harness for preview-vs-export at sampled `t` values (120), sidecar bundling (130). The renderer worker is involved exactly as it is in 060 — no changes to the worker, no changes to the orchestrator.

## Deliverables

### `build_composite_filtergraph` (in `src-tauri/src/export/filtergraph.rs`)

The argv it emits, for **PiP-map-inset, no corner radius** (video full-bleed background, map inset, sharp corners):

```
ffmpeg -hide_banner -y \
  -i {clip_0_path} \
  -i {clip_1_path} \
  ... \
  -f rawvideo -pix_fmt rgba -s {map_w}x{map_h} -r {fps} -i pipe:0 \
  -frames:v {total_frames} \
  -filter_complex "
    [0:v]trim=...,setpts=...,crop=...,scale={video_w}:{video_h},format=yuva444p10le[v0];
    [1:v]trim=...,setpts=...,crop=...,scale={video_w}:{video_h},format=yuva444p10le[v1];
    ...
    [v0][v1]...concat=n=N:v=1:a=0[vc];
    [{N}:v]format=yuva444p10le[map];
    [vc][map]overlay={inset.x}:{inset.y}:format=auto[vout_alpha];
    [vout_alpha]format=yuv420p[vout];
    [0:a]atrim=...,asetpts=PTS-STARTPTS,atempo=...[a0];
    ...
    [a0][a1]...concat=n=N:v=0:a=1[aout]
  " \
  -map "[vout]" -map "[aout]" \
  -c:v {hevc_encoder_name} {hevc_encoder.codec_args...} \
  -c:a aac -b:a 256k \
  -movflags +faststart \
  {output_path}
```

For **PiP-map-inset, with corner radius** (the inset is the map; mask is the *(N+1)*th input):

```
ffmpeg -hide_banner -y \
  -i {clip_0_path} ... \
  -f rawvideo -pix_fmt rgba -s {map_w}x{map_h} -r {fps} -i pipe:0 \
  -loop 1 -i {corner_mask_png_path} \
  -frames:v {total_frames} \
  -filter_complex "
    [0:v]...scale={video_w}:{video_h},format=yuva444p10le[v0]; ...
    [v0][v1]...concat=n=N:v=1:a=0[vc];
    [{N}:v]format=yuva444p10le[map];
    [{N+1}:v]format=gray[mask];
    [map][mask]alphamerge[map_masked];
    [vc][map_masked]overlay={inset.x}:{inset.y}:format=auto[vout_alpha];
    [vout_alpha]format=yuv420p[vout];
    [0:a]atrim=...,...[a0]; ...
    [a0]...concat=n=N:v=0:a=1[aout]
  " \
  -map "[vout]" -map "[aout]" \
  -c:v {hevc} {hevc.codec_args...} \
  -c:a aac -b:a 256k \
  -movflags +faststart \
  {output_path}
```

For **PiP-video-inset, with corner radius** (the inset is the video; the per-clip chain's output is what gets masked):

```
... [v0][v1]...concat=n=N:v=1:a=0[vc];
    [{N}:v]format=yuva444p10le[map_bg];
    [{N+1}:v]format=gray[mask];
    [vc][mask]alphamerge[vc_masked];
    [map_bg][vc_masked]overlay={inset.x}:{inset.y}:format=auto[vout_alpha];
    [vout_alpha]format=yuv420p[vout];
    ...
```

For **Split** (no overlay onto a single source — both sources tile the output via two overlays onto an opaque canvas):

```
ffmpeg -hide_banner -y \
  -i {clip_0_path} ... \
  -f rawvideo -pix_fmt rgba -s {map_w}x{map_h} -r {fps} -i pipe:0 \
  -frames:v {total_frames} \
  -filter_complex "
    [0:v]...scale={video_w}:{video_h},format=yuva444p10le[v0]; ...
    [v0][v1]...concat=n=N:v=1:a=0[vc];
    [{N}:v]format=yuva444p10le[map];
    color=c=black:s={out_w}x{out_h}:r={fps},format=yuv444p10le[bg];
    [bg][map]overlay={map_slot.x}:{map_slot.y}[bg_with_map];
    [bg_with_map][vc]overlay={video_slot.x}:{video_slot.y}:format=auto[vout_alpha];
    [vout_alpha]format=yuv420p[vout];
    ...
  "
```

Notes on the filtergraph:

- **Input ordering: clips first, then rawvideo, then mask.** The per-clip inputs occupy indices `0..N`; the rawvideo (map) is index `N`; the corner mask (when present) is index `N+1`. This ordering is *required* — the orchestrator's `FFmpegSink` writes to `pipe:0`, which FFmpeg binds to the first stdin-flagged input, but `-f rawvideo … -i pipe:0` is identified by its argv position, not by being first. Putting clips before rawvideo means the per-clip subgraphs reference `[0:v]…[N-1:v]` in their natural index, leaving `[N:v]` for the map and `[N+1:v]` for the mask. Consistency with how 070 numbers per-clip inputs.
- **`overlay` instead of `pad`.** Channel A is opaque; the layout's "background" source fills the frame and the "inset" source overlays on top. `overlay=x:y` places the second input's top-left at `(x, y)` over the first input. The background source's slot covers the whole frame (PiP) or its share (Split with the canvas underneath); the inset's slot is its placed rect.
- **`format=auto` after `overlay`.** When overlaying a `yuva444p10le` stream onto a `yuva444p10le` background, FFmpeg's auto-format negotiation picks the correct intermediate. Without `format=auto`, the overlay can drop alpha unexpectedly when its inputs have mismatched alpha handling. (Tested locally; documented here so a future refactor doesn't drop the directive.)
- **`format=yuv420p` before output.** H.265 in `.mp4` for broad device compatibility wants `yuv420p`. The intermediate filter chain runs in `yuva444p10le` for compositing accuracy (the alpha channel matters during corner-mask `alphamerge`); the final `format=yuv420p` strips alpha and downsamples chroma to 4:2:0. Both `hevc_videotoolbox` (no `-pix_fmt` in `040`'s `codec_args`) and `libx265` (explicit `-pix_fmt yuv420p` in `040`'s `codec_args`) accept this; passing `yuv420p` via the filter chain is the consistent path.
- **AAC at 256 kbps.** Channel A is the deliverable; AAC is the universal MP4 audio codec, 256 kbps stereo at 48 kHz is visually-lossless-equivalent for audio (Apple, Google, and YouTube all upload at ≤256 kbps). Channel C used PCM s16le (lossless, intermediate); Channel A re-encodes to AAC for the final container. The audio chain itself (`atrim` → `atempo`) is identical to 070; only the encoder differs.
- **`-c:v {name}` is prepended for HEVC, not ProRes.** From 040's `Candidate::downstream_codec_args`: ProRes's `codec_args` already includes `-c:v prores_ks` at index 0 (B/C splat directly); HEVC's `codec_args` excludes the `-c:v` prefix (consumers prepend `-c:v {encoder.name}`). The composite filtergraph builder *prepends* the prefix when it splices HEVC's args. Confirmed by `encoder::tests::hevc_codec_args_omit_c_v_prefix` and `encoder::tests::prores_codec_args_include_c_v_prefix`.
- **`-frames:v {total_frames}` is mandatory.** Same reasoning as 060: the rawvideo input from the orchestrator has no length signal, and the optional looped corner-mask input also needs an explicit cap. The per-clip file inputs have intrinsic durations (their concat output drives the audio), but `concat`'s output and the rawvideo input are decoupled — `-frames:v` caps the *output*, terminating both. The orchestrator naturally closes its end of `pipe:0` after writing the last frame; FFmpeg exits 0 when `-frames:v` is reached.
- **No `-an`.** Unlike 060 (which had `-an` because Channel B is silent), Channel A has audio. The audio chain mirrors 070's exactly — same `build_clip_audio_subgraph`, same atempo chaining, same `aevalsrc` fallback for clips without an audio stream.
- **Split's opaque canvas.** Split mode doesn't have a "background source" that fills the frame; the two slots tile the output. To produce an opaque output, the filtergraph synthesizes a black canvas via `color=c=black:s={out_w}x{out_h}` and overlays both sources onto it. The canvas is `yuv444p10le` (no alpha — it's opaque by definition). The two `overlay` calls place map at `map_slot` and video at `video_slot`; these don't overlap (Split's invariant), so order is structurally irrelevant — pick map-first, video-second by convention so the PR diff is consistent.

### `render_export_composite` (in `src-tauri/src/export/mod.rs`)

```rust
async fn render_export_composite(
    req: RenderExportRequest,
    started: Instant,
) -> Result<RenderExportSummary, RenderExportError> {
    let validated = validate_request(&req)?;  // no-encoder version after the refactor

    let map_slot = req.layout.resolved.map_slot;
    let video_slot = req.layout.resolved.video_slot;
    if map_slot.w == 0 || map_slot.h == 0 || video_slot.w == 0 || video_slot.h == 0 {
        return Err(RenderExportError::validation(format!(
            "slot has zero dimension: map={:?} video={:?}", map_slot, video_slot,
        )));
    }

    // Visible-clip extraction + source validation + ffprobe — identical to 070.
    let visible: Vec<Clip> = extract_visible_clips(&req.project_state)?;
    if visible.is_empty() { return Err(/* EmptyTimeline */); }
    validate_source_files(&visible)?;
    let probed = probe_clips_capped(&ffprobe_path(), &visible, 8).await?;
    let visible_inputs: Vec<VisibleClipInput> = zip(visible, probed)
        .map(|(clip, p)| VisibleClipInput { /* ... */ }).collect();

    // Composite mode is a function of (layout.layout, corner_radius_slot).
    let composite_mode = match (&req.layout.layout, req.layout.resolved.corner_radius_slot) {
        (LayoutConfig::Pip { inset_source, .. }, _) => match inset_source {
            PipInsetSource::Map => CompositeMode::PipMapInset,
            PipInsetSource::Video => CompositeMode::PipVideoInset,
        },
        (LayoutConfig::Split { .. }, _) => CompositeMode::Split,
    };

    // Corner mask iff radius > 0. Mask dims are the *inset's* slot.
    let corner_mask_path = generate_corner_mask_if_needed(
        &req.layout.resolved,
        composite_mode,
    )?;

    // HEVC for the deliverable. Note: this branch picks its own encoder;
    // `validate_request` no longer touches `select_encoder`.
    let video_encoder = select_encoder(EncoderClass::Hevc).map_err(|e| /* ... */)?;

    let plan = build_composite_filtergraph(
        &visible_inputs,
        map_slot, video_slot,
        validated.output_dims,
        composite_mode,
        corner_mask_path.as_deref(),
        req.fps,
        validated.total_frames,
        &video_encoder,
        &["-c:a", "aac", "-b:a", "256k"],
        &validated.output_path_buf,
    ).map_err(classify_clip_chain_error)?;

    // FFmpegSink — rawvideo input on stdin from the orchestrator's worker.
    // NOT FFmpegRunner — Channel A's map stream is the renderer worker's output.
    let sink = FFmpegSink::spawn(&ffmpeg_path(), &plan.argv, plan.frame_bytes_per_input)
        .await
        .map_err(/* into RenderExportError::ffmpeg */)?;

    let setup = SetupPayload {
        viewport: Viewport { w: map_slot.w, h: map_slot.h },
        fps: req.fps,
        project_state: req.project_state,
    };

    let frames_written = render_map_frames(
        setup,
        validated.total_frames,
        OrchestratorConfig::default(),
        Box::new(sink),
    ).await.map_err(classify_orchestrator_error)?;

    let wall_clock_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    Ok(RenderExportSummary { frames_written, output_path: req.output_path, wall_clock_ms })
}
```

The shape is "060 + 070 unioned": map-stream half (rawvideo input + orchestrator) from 060, video-stream half (file inputs + per-clip chain + audio) from 070. The new piece is the `composite_mode` derivation and the `build_composite_filtergraph` builder; everything else is structural reuse.

### `validate_request` refactor (in `src-tauri/src/export/mod.rs`)

```rust
struct ValidatedRequest {
    total_frames: u32,
    output_dims: OutputDimensions,
    output_path_buf: PathBuf,
    // encoder removed — each branch picks its own.
}

fn validate_request(req: &RenderExportRequest) -> Result<ValidatedRequest, RenderExportError> {
    // Parity check, total-frames math, output_dims extraction — unchanged from 060/070.
    // No `select_encoder` call.
}
```

Each channel branch makes one extra `select_encoder` call that 060/070 used to get for free via `validate_request`. The line cost is one `let encoder = select_encoder(...)?` per branch — small enough that the duplication is healthier than channel-aware encoder selection in the shared validator.

## Acceptance criteria

- [ ] `cargo build` (in `src-tauri`) succeeds with the new builder, branch, and refactored `validate_request`.
- [ ] `cargo clippy --all-targets -- -D warnings` (in `src-tauri`) is clean.
- [ ] `npm run lint`, `npm run build`, `npm run test:run` pass.
- [ ] **`build_composite_filtergraph` unit tests** (`cargo test --lib export::filtergraph`):
  - **PipMapInset, no corner radius**: argv has `N` clip inputs + 1 rawvideo input (no mask), `filter_complex` contains `concat=n=N:v=1:a=0[vc]`, `[N:v]format=yuva444p10le[map]`, `[vc][map]overlay={inset.x}:{inset.y}:format=auto[vout_alpha]`, `[vout_alpha]format=yuv420p[vout]`. No `alphamerge`, no `pad`.
  - **PipMapInset, corner radius**: argv has `N + 2` inputs (clips + rawvideo + mask), `-loop 1` precedes the mask path, `filter_complex` contains `[map][mask]alphamerge[map_masked]`, then `overlay`.
  - **PipVideoInset, corner radius**: argv mirrors PipMapInset but the `alphamerge` operates on `[vc]`, not `[map]`; the overlay places `[vc_masked]` over `[map_bg]`.
  - **Split**: argv has `N` clip inputs + 1 rawvideo input (no mask), `filter_complex` contains a `color=c=black:s={out_w}x{out_h}…[bg]` clause, two `overlay` calls (map first, video second). Verifies the test fixture's split has no `alphamerge` (Split disallows corner radius).
  - **Audio chain**: every fixture's `filter_complex` contains the same per-clip audio sub-graph 070 emits, plus a `concat=n=N:v=0:a=1[aout]` and an `-c:a aac -b:a 256k` argv chunk. `-an` is *absent*.
  - **Encoder splice**: argv contains `-c:v {hevc_name}` followed by `hevc.codec_args` flags (no double `-c:v`). For ProRes-prefixed args this would be a regression — assert absence: `argv.windows(2).filter(|w| w[0] == "-c:v").count() == 1`.
  - **`frame_bytes_per_input == map_slot.w * map_slot.h * 4`** (this is the bytes the orchestrator will write). Distinct from B's same expression — same role, different slot in this channel.
  - **Input ordering**: in every fixture, all clip inputs precede the rawvideo input; the rawvideo input precedes the mask input (when present). A grep-style assertion on argv: position of `-i pipe:0` is greater than the position of every `-i {clip_path}`.

- [ ] **Layout parity check at the IPC boundary** (covered in 060/070; assert it still works for `composite` path) — a tampered `LayoutDescriptor.resolved` is rejected with `RenderExportError::validation` before any orchestrator / FFmpeg / ffprobe work begins.

- [ ] **Encoder refactor regression test** (`cargo test --lib export::render_export_validation`): a request that fails `validate_request` (e.g., `total_duration_ms = 0`) does *not* attempt to spawn FFmpeg or call `select_encoder`. Specifically — instrumentable via a one-shot `OnceCell<bool>` test hook on the cache path (which stays unset when `select_encoder` isn't reached), or via a structural assertion that the failing call site returns before `select_encoder`. The test exists to catch a refactor that re-introduces encoder selection inside `validate_request`.

- [ ] **Integration test passes** (`cargo test --test render_export_composite --features integration_export`):
  - Two-clip 9:16 PiP-map-inset (default) export: FFprobe asserts `hevc`, `yuv420p`, `1080×1920`, `nb_frames` matches, `duration ≈ 2.0s ± frame`, 1 `aac` audio stream, ~256 kbps bitrate ± 30%.
  - Frame 30 sampling per `Files to touch` above (full-bleed video coverage at frame center; map coverage at inset center).
  - PipVideoInset variant: passes the mirror sampling.
  - Split variant: passes the divider-half sampling.

- [ ] **Compositing parity test passes** (`cargo test --test render_export_composite --features integration_export_parity`):
  - Three exports (B, C, A) at the same fixture layout.
  - External FFmpeg invocation overlays C onto B with the same `composite_mode` filter shape (single-pass H.265 re-encode using the same encoder choice as A).
  - Pixel-diff frame 30 between A and (B+C-composited): mean per-channel difference < 5/255, max per-channel difference < 30/255. Failure mode → log the diff image to a temp path for debugging.
  - The test's runtime is ~30–90s on the author's M-series machine; gating behind a sub-feature keeps it out of routine CI runs.

- [ ] **No reimplementation of clip chain math** (grep at acceptance time):
  - `grep -nE "trim=start=|setpts=|crop=|atempo=" src-tauri/src/export/filtergraph.rs` returns matches only inside `build_composite_filtergraph`'s docstring/comments and `tests` blocks — never in inline filter-string assembly. The clip chain comes from `build_clip_chain` exclusively.
  - `grep -nE "compute_focal_crop|chain_atempo" src-tauri/src/export/filtergraph.rs` returns nothing — the builder consumes the clip-chain output, doesn't re-derive it.

- [ ] **No reimplementation of corner-mask geometry** (grep at acceptance time):
  - `grep -nE "build_corner_mask_png|alphamerge" src-tauri/src/export/mod.rs` shows the composite branch reuses 060's `corner_mask::build_corner_mask_png` verbatim. No new mask logic.

- [ ] **`render_export_map_only` and `render_export_video_only` still work** (regression check via existing 060 / 070 integration tests). The `validate_request` refactor moves `select_encoder(ProResAlpha)` into each branch; the existing tests exercise this.

- [ ] **Manual smoke test on macOS dev machine.** Author opens a project with 2+ clips, clicks "Export composite (.mp4)", picks a path, waits for the export. Drops the resulting `.mp4` into QuickTime / VLC — plays back at 9:16 with audio, video plays at full-bleed (9:16 aspect-fit-cropped from source), map appears as a small inset at the configured position with rounded corners, transitions match what the editor preview shows at the same `t` values. No alpha (the file is opaque); no black bars unexpectedly; movflags+faststart means scrubbing is instant.

- [ ] **B + C + A consistency check** (manual). Run all three exports back-to-back at the same layout. Drop B.mov + C.mov stacked on two video tracks in any NLE; render at HEVC. Compare against A.mp4 directly. Visually indistinguishable to the user (the parity test catches structural drift; this catches the perceptual edge cases).

- [ ] **`docs/export/tasks/README.md` row 090 flipped to ✅, this file linked.** Stale "Tasks beyond 060 are not yet authored" line removed.

## Implementation notes

**Why Channel A involves the renderer worker (unlike Channel C).** A composites map onto video (or vice versa), which means it needs a map render stream. The map render stream comes from the renderer worker via the orchestrator. So 090 spawns the worker pool just like 060 does — `render_map_frames(setup, total_frames, OrchestratorConfig::default(), Box::new(sink))`. The wrinkle is that the same FFmpeg child reads *both* the rawvideo stdin and the per-clip source files; the filtergraph references both via the input-index numbering scheme described above.

**Why the per-clip chain is in `clip_chain.rs` and not duplicated for compositing.** This is LAYOUT.md §7's load-bearing invariant — "the same per-clip chain produces the video stream feeding both Channel A's video slot and Channel C's video slot." 070's `build_clip_chain` is the single source; 090 imports and calls it without modification. Any divergence here would break the "B + C composites to A" promise.

**Why HEVC and not H.264.** PLAN.md §"Channels": Channel A is "H.265 in `.mp4`, CRF ~17 (visually lossless deliverable)." H.265 at 17 is ~30% smaller than H.264 at 17 for visually-equivalent quality on social-platform content (motion-heavy outdoor footage with wide gradient skies), and every modern device + every social platform decodes HEVC natively in 2026. The encoder probe selects `hevc_videotoolbox` on Mac (hardware) and `hevc_nvenc / qsv / amf / libx265` on Windows (per `040`).

**Why AAC and not Opus or PCM.** AAC is the universal MP4 audio codec; Opus in MP4 is technically supported but rejected by some social platforms' upload validators. PCM in MP4 is non-standard (PCM lives in MOV / WAV; MP4 spec allows it but many decoders refuse). 256 kbps stereo AAC at 48 kHz is the right intersection of "lossless to the ear" and "decodes everywhere."

**Why `format=yuv420p` at the end of the filter chain, not via `-pix_fmt`.** Both work for `libx265`. For `hevc_videotoolbox`, the encoder picks its own pix_fmt unless told otherwise; passing `yuv420p` via the filter chain *before* the encoder gets it ensures consistent behavior across Mac and Windows builds. It also makes the filter chain self-describing — a reader sees the format conversion in the filter complex without cross-referencing the encoder's argv.

**Why `overlay`'s second argument is the inset, not the background.** FFmpeg's `overlay` filter is `[main][overlay]overlay=x:y` — the second input is placed on top of the first at `(x, y)`. The mental model: "background, then inset on top." The PipMapInset variant overlays the map (small) onto the video (full-bleed); PipVideoInset overlays the video (small) onto the map (full-bleed); Split overlays both onto a synthesized opaque canvas.

**Why the corner mask attaches to the inset, not the background.** LAYOUT.md §6's PiP corner-radius semantics: "the corner radius applies to the slot's alpha mask. The inset's rounded corners produce alpha falloff at the corner curves." The full-bleed background is opaque to its edges (no rounded corners on a full-frame source). The mask only ever applies to the slot whose `corner_radius_slot` matches; for Split, `corner_radius_slot` is structurally `None` and no mask is generated. The composite mode discriminates via `match (composite_mode, corner_radius_px > 0)`.

**Why we lift encoder selection out of `validate_request`.** `validate_request` was 060's helper to share request validation between channels. 060 and 070 both used `EncoderClass::ProResAlpha`, so it was harmless to bake the choice into the helper. 090 needs `Hevc`. Channel-aware encoder selection in the shared validator (e.g., a `match req.channel`) couples an unrelated concern (HEVC vs ProRes) to validation. Moving `select_encoder` out is one line of duplication per branch and one less coupling point — net cleaner.

**Why `total_frames` matters even though clips have intrinsic durations.** The rawvideo input from the orchestrator has no length signal — FFmpeg keeps reading from `pipe:0` until EOF. The orchestrator naturally closes its end after `total_frames` frames, so FFmpeg sees EOF cleanly. But the *concat* output from the per-clip chain has its own duration (Σ trimmed-and-speed-adjusted spans), and `overlay`'s output ends with the *shorter* of its two inputs. Without `-frames:v`, a one-frame mismatch between the orchestrator's frame count and the concat's effective duration could truncate the output by a frame or hold the last frame for a frame longer. Setting `-frames:v {total_frames}` caps the *output*, terminating both inputs at exactly the same point.

**Why the parity test exists despite being slow.** The "B + C composite to A" promise from LAYOUT.md §6 is a load-bearing user expectation. If a user exports A directly and a user exports B + C and stacks them in Resolve, the only way to *prove* they get the same pixels is to run all three exports and pixel-compare. Unit tests catch filtergraph string drift; the parity test catches semantic drift — wrong overlay coordinate, wrong concat ordering, off-by-one mask placement, encoder-default difference. Gating it behind `integration_export_parity` keeps `cargo test` fast for routine work; CI runs it nightly.

**Why no progress reporting in 090.** Same as 060/070: deferred to 110's configurator UI where the export-settings dialog has space for a progress bar. Channel A is the slowest of the three (HEVC encode + map render at smaller-than-output dims), so the user-visible "Exporting…" wait is real for any non-trivial timeline. Documented as a known UX limitation.

**Why no GPU acceleration in 090.** PLAN.md §"Performance" → "GPU acceleration via Metal (unverified)." Worker-side improvement, independent of channel topology. 060 deferred it; 090 inherits the same baseline. Once landed, all three channels benefit.

**Why 090 doesn't introduce a new test fixture.** 070's `src-tauri/tests/fixtures/clips/` already has the two short `.mp4` clips with audio that 090's tests need. The only fixture-side change 090 introduces is the parity test's intermediate B/C export paths, which live in `tempdir`s and don't pollute the source tree.

**Edge case: zero visible clips.** Same as 070 — empty timeline errors with `RenderExportError::validation` before any FFmpeg / orchestrator work. The compositing branch shares 070's `EmptyTimeline` validation path.

**Edge case: a single visible clip.** No `concat` reduction needed — `concat=n=1:v=1:a=0[vc]` with a single input works correctly (FFmpeg accepts `n=1`). The filtergraph builder doesn't special-case single-clip; the same code path handles 1 clip and N clips.

**Edge case: source video has no audio stream.** Same fallback as 070 — `aevalsrc=0:duration={span_s}:sample_rate=48000[aN]` keeps the audio concat's `n` count consistent. AAC re-encoding silence is fine; the resulting file has an audio stream with the expected duration.

**Edge case: extreme speed (`speed = 8.0` or `speed = 0.1`).** The atempo chain handles it via 070's `chain_atempo`; 090 inherits the behavior. Visual output: video plays at 8×, audio uses three chained `atempo=2.0` instances.

**Why we don't add static-camera frame deduplication in 090.** PLAN.md §"Performance" #4 — "Frame deduplication for static cameras. During clip spans where the camera intent is `point` (and not following a marker), the camera is fully static — render one frame, have FFmpeg duplicate it." That's a renderer-side optimization at the orchestrator layer, not a filtergraph-layer change. Independent of channel topology; deferred to a performance task post-090.

**Why the corner mask's `.png` is the same one 060 and 070 use.** `build_corner_mask_png(slot_w, slot_h, radius_px)` is dim-parametric; whichever slot has the corner radius gets a mask sized to that slot. 060 generates one for the map slot (when applicable); 070 generates one for the video slot (when applicable); 090 generates one for the inset slot (whichever it is) — all calling the same function. The on-disk cache (`~/.trailcut/corner_masks/{w}x{h}_r{r}.png` from 060) is shared across all three channels.

**Why no music track.** LAYOUT.md §8: "No music track in v1." Channel A's audio chain mirrors C's exactly — per-clip source passthrough with `atempo`. A music track is a v2+ feature that mixes onto the existing chain via `amix`; data model and UI for it are also v2+.

## Open questions deferred to follow-up tasks

- **Progress reporting via Tauri events.** Same as 060/070 — deferred to 110.
- **Export cancellation.** Same as 060/070 — deferred to 110. Channel A is the longest export, so cancellation has the highest user-value here, but the implementation pattern (cancel the orchestrator + kill FFmpeg) is shared across channels.
- **Performance pass.** Tile pre-warming (PLAN.md §"Performance" #2), GPU rendering (#3), static-camera frame deduplication (#4) — all independent tasks. 090 ships at correctness baseline. A "performance audit" task lands after 100 / 110 surface real user export workloads.
- **Render parity verification at sampled `t`** (120). The parity test in this task is *channel-vs-channel* (A vs B+C). 120 introduces *preview-vs-export* parity at sampled `t` values — the orthogonal verification axis.
- **CRF / quality knob in the UI.** 090 hard-codes the encoder probe's per-class default (`-q:v 65` for `hevc_videotoolbox`, `-crf 17` for `libx265`). The configurator UI (110) introduces a quality slider that maps to encoder-specific args; the data plumbing is straightforward (`req.video_quality: i32` → translate per encoder name). Defer.
- **Two-tier export ("Quick draft" / "High quality")** from PLAN.md §"Escape hatches." Likely a 110 / 130 conversation; not blocking.
- **Animated layout transitions** (LAYOUT.md §4 v2+, paired with per-clip layout overrides). 090's `composite_mode` is a single value per export run; mid-stream layout changes require a different filter shape and a per-frame layout descriptor. v2+ feature.
- **Sidecar bundling.** 090 calls FFmpeg + ffprobe + node from PATH. Per-platform bundled binaries land in 130. The runner reads paths through resolver cells (same pattern as 060/070).
- **Channel A at additional aspects (4:5, 16:9).** The filtergraph builder is aspect-agnostic — it reads `output_dims` from the resolved layout. The 100 task (additional layouts + aspects) seeds layouts for 4:5 and 16:9; the composite export consumes them with no code change. 090's integration tests exercise 9:16 only; 100's tests cover the others.

## Doc tie-in

- PLAN.md §"Channels" — Channel A is "map render stream + processed source clips, composited per layout, H.265 in `.mp4`." 090 implements this row of the table.
- PLAN.md §"Rust → FFmpeg" — the composite filtergraph sketch in PLAN.md is normative; the per-mode elaboration (PipMapInset / PipVideoInset / Split), input-ordering rule, and `format=yuv420p` final pass are 090-specific elaborations.
- PLAN.md §"IPC contract" — `render_export` for `composite` reuses 070's wire shape; the only divergence is the `channel` string. The frontend builder (`exportRequest.ts`) needs no changes beyond the channel-string-driven file-extension filter on the save dialog.
- LAYOUT.md §1 — PiP and Split modes; 090 implements both via `composite_mode`.
- LAYOUT.md §6 — "Channel A is the deliverable" + "B + C composites to A" promise. 090 ships the deliverable and the parity test that proves the promise.
- LAYOUT.md §7 — per-clip video chain reused verbatim from 070; per-clip audio chain reused verbatim from 070, encoded as AAC instead of PCM.
- LAYOUT.md §8 — Channel A has audio (source-passthrough with `atempo`); no music in v1.
- 040 — `select_encoder(EncoderClass::Hevc)` returns the H.265 encoder choice. The `codec_args` convention (HEVC omits `-c:v` prefix; ProRes includes it) is load-bearing for 090's filtergraph splice.
- 050 — `LayoutDescriptor`, `resolve_slots`, `OUTPUT_DIMS`, `corner_radius_slot`. 090 reads all of these; the IPC parity check enforces the TS-Rust mirror invariant at runtime, same as 060/070.
- 060 — `FFmpegSink`, `corner_mask::build_corner_mask_png`, `RenderExportRequest` / `RenderExportSummary` / `RenderExportError` shapes, `validate_request` (refactored to drop encoder selection), `render_map_frames` orchestrator call. Reused without structural change.
- 070 — `clip_chain` builders (`build_clip_chain`, `compute_focal_crop`, `chain_atempo`), `ffprobe::probe_clip`, `VisibleClipInput`, `probe_clips_capped` helper, source-file existence validation. Reused without structural change.
- 080 — populated `project.layouts['9_16']`. 090's exports read the stored layout, not a `pickLayout` fallback (the fallback survives as defense; tests verify it's cold on freshly-created projects).
- After 090 lands, the export pipeline's three channels are all live. 100 broadens coverage (Split mode + 4:5 + 16:9), 110 ships the configurator UI, 120 introduces preview-vs-export parity verification, 130 bundles the sidecars. 090 is the load-bearing milestone for the entire export feature.
