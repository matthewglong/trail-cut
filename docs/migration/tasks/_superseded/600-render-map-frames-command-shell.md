# Task 600 — Register `render_map_frames` Tauri command shell

**Step**: Compiled Timeline export (Step 1 of the 600-series)
**Estimated effort**: 2h
**Status**: pending
**Depends on**: 570

## Goal

Stand up the Rust-side Tauri command that owns the export-side map-frame render run. This task only ships the *shell*: the command name, the IPC payload type, the registration in `lib.rs`, and a placeholder body that validates inputs and creates the output directory. The hidden renderer window (task 610), the IPC wiring (task 620), the per-frame loop (task 630), and the parity verification (task 640) layer on top.

The command name and signature must match what `COMPILED_TIMELINE_PLAN.md` §"Export Semantics" describes: a per-frame loop fed by `cameraAt(timeline, t)` from the preview evaluator. Every camera the renderer eventually `jumpTo`s comes from the **same** `cameraAt(timeline, t)` the preview ease loop consumes. This command must not contain any camera math — the math lives only in `src/lib/cameraIntent.ts`.

## Files to touch

- `src-tauri/src/commands/mod.rs` — modify — add `mod export;` and `pub use export::*;`.
- `src-tauri/src/commands/export.rs` — new — the `render_map_frames` command shell, the `FrameSpec` / `ResolvedCameraIpc` payload structs, and the input-validation + output-dir bootstrap.
- `src-tauri/src/lib.rs` — modify — register `commands::render_map_frames` in `invoke_handler`.
- `src-tauri/src/models.rs` — verify — no changes; the IPC types live in `commands/export.rs`, not the persisted-shape models module. (`ResolvedCamera` on the persisted side does not exist; the equivalent runtime shape is `ProjectStartCamera` plus the compiled-timeline output, both TS-side only.)

## Deliverables

- `render_map_frames` is invokable from the frontend via `invoke('render_map_frames', { ... })` and returns successfully (with a placeholder result) for any well-formed payload.
- Payload struct (Rust `serde`, snake_case on the wire):
  ```rust
  #[derive(serde::Deserialize)]
  pub struct ResolvedCameraIpc {
      pub center: LngLatIpc,
      pub zoom: f64,
      pub bearing: f64,
      pub pitch: f64,
  }

  #[derive(serde::Deserialize)]
  pub struct LngLatIpc { pub lng: f64, pub lat: f64 }

  #[derive(serde::Deserialize)]
  pub struct FrameSpec {
      pub frame_index: u32,
      pub project_time_ms: f64,
      pub camera: ResolvedCameraIpc,
  }

  #[derive(serde::Deserialize)]
  pub struct RenderMapFramesRequest {
      pub frames: Vec<FrameSpec>,
      pub fps: u32,
      pub output_dir: String,
      pub viewport: ViewportIpc,
  }

  #[derive(serde::Deserialize)]
  pub struct ViewportIpc { pub width: u32, pub height: u32, pub dpr: f64 }
  ```
- Validation: `frames` non-empty; `fps > 0`; `output_dir` is a writable absolute path; viewport dims > 0. Errors return `Result<_, String>` with a descriptive message (matches the convention in `commands/ffmpeg.rs`).
- Output-dir bootstrap: `ensure_dir(&output_dir)` (reuse `crate::util::fs::ensure_dir`).
- Placeholder return: `Ok(serde_json::json!({ "frames_written": 0, "output_dir": output_dir }))` — task 630 replaces this with the real per-frame loop's result.

## Acceptance criteria

- [ ] `cargo build --manifest-path src-tauri/Cargo.toml` passes.
- [ ] `npm run build` passes.
- [ ] From the frontend devtools console, `invoke('render_map_frames', { frames: [...], fps: 30, output_dir: '/tmp/trailcut-export-test', viewport: { width: 1080, height: 1920, dpr: 2 } })` returns `Ok` with the placeholder JSON.
- [ ] Invalid payloads (`frames: []`, `fps: 0`, missing `output_dir`, viewport with zero dim) return a descriptive `Err` string and do not create the output dir.
- [ ] No camera math in `commands/export.rs`. The Rust side never invokes anything analogous to `cameraAt` — every `ResolvedCamera` it sees was produced by the frontend's `cameraAt(timeline, t)` and shipped over IPC. This is the determinism contract from `COMPILED_TIMELINE_PLAN.md` §"Export Semantics": "export at any project-time `t` matches preview at the same `t`."
- [ ] No camera-shape duplication: the IPC structs do not import or re-derive `MapAnchor`, `MapTrack`, or any other deleted wall-clock-anchor type.

## Implementation notes

The IPC payload deliberately ships pre-resolved cameras, not the timeline. Per `COMPILED_TIMELINE_PLAN.md` §"Export Semantics" (and the design rationale in task 580's notes): the renderer is "dumb" — it takes a `ResolvedCamera` per frame and `jumpTo`s. All scheduling, all evaluator invocations, all `resolveIntent(intent, viewport)` calls happen in the **frontend** before the IPC call, so the Rust side never needs a port of the camera math.

This is the choice that keeps preview and export locked to the same evaluator. If we shipped the compiled timeline + `t` per frame and re-evaluated in Rust, we would need a parallel Rust port of `cameraAt`, `resolveIntent`, `vanWijkSample`, etc. — and the moment they drift from the TS implementation, preview-export parity breaks. Pre-resolution side-steps the problem entirely.

`ResolvedCamera` (the TS type in `cameraIntent.ts`) and the Rust `ResolvedCameraIpc` defined here are **wire-compatible siblings**, not the same type. Keep the field names and JSON shape aligned (`center.lng`, `center.lat`, `zoom`, `bearing`, `pitch`) so the frontend can `JSON.stringify(resolvedCamera)` straight into the IPC payload without a translator layer.

The `viewport` field is the renderer's *output* viewport — the pixel rectangle each frame is captured into. The frontend computes each `FrameSpec.camera` by calling `resolveIntent(cameraAt(timeline, t), viewport)`, so the viewport in the payload is the same one used at resolution time. (This matters for `region` intents whose framing depends on viewport aspect ratio.) Documented contract: same viewport in payload as in `resolveIntent`, otherwise the renderer's `jumpTo` lands on a camera framed for a different aspect than the captured frame.

`output_dir` is a workspace path the renderer dumps frame PNGs (and eventually a manifest) into. The composing-into-a-final-mp4 step lives in a future task in the layout/compositing phase, not in the camera-migration export tasks.

The placeholder body lets the frontend exercise the IPC end-to-end before the renderer window exists — useful for shaking out payload-shape bugs before task 610 lands.

Open questions deferred to later tasks (do not resolve here):
- During a transition span, `cameraAt` returns a `point` intent (collapsed from Van Wijk). The renderer (task 630) treats this as a normal frame — no special-case handling.
- For clip 1's `t ∈ [0, transitionSpan.endMs]` window (video not yet playing), the export composer eventually needs a content-layer source — held first frame, `startCamera`-only background, or similar. This is layout/compositing-phase design, **not** a camera-migration concern. Flag in task 640 if it surfaces during validation; otherwise leave for the compositing phase.
