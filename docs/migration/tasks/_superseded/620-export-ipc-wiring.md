# Task 620 — IPC wiring: parent → renderer frame stream

**Step**: Compiled Timeline export (Step 3 of the 600-series)
**Estimated effort**: 3h
**Status**: pending
**Depends on**: 610

## Goal

Wire the IPC channel that ships `FrameSpec`s from the parent (main) window through Rust into the hidden export-renderer window (task 610). The frontend builds each `FrameSpec` from `cameraAt(timeline, t)` resolved against the export viewport — preview's evaluator is the **only** source of camera state. This task only ships the **wire**; the per-frame `jumpTo` + capture + write loop lands in task 630, and parity verification lands in task 640.

Per `COMPILED_TIMELINE_PLAN.md` §"Export Semantics": "Preview and export share `cameraAt(timeline, t)`; export iterates `t = frame_index / fps`." This is the task that operationalizes that sentence — the IPC payload format and the producer / forwarder / consumer roles.

## Files to touch

- `src/screens/ProjectView.tsx` (or a new `src/lib/exportFramePlan.ts`) — add — a pure function `planExportFrames(timeline, fps, viewport): FrameSpec[]` that iterates `i = 0..floor(totalDurationMs * fps / 1000)`, computes `t = i * 1000 / fps`, calls `cameraAt(timeline, t)`, then `resolveIntent(intent, viewport)`, and packs the result into a `FrameSpec`. Pure: no DOM, no `performance.now`, no MapLibre.
- `src/lib/exportTypes.ts` — new — TS-side mirror of the Rust IPC payload shapes from task 600. One source of the wire shape, importable by both `planExportFrames` and any future export-trigger UI.
- `src-tauri/src/commands/export.rs` — modify — `render_map_frames` now (a) deserializes the payload from task 600, (b) emits the `frames` array as an event the renderer window subscribes to (`export-renderer:frames`), (c) waits for an `export-renderer:done` event from the renderer before returning. Use Tauri's typed event system (`app.emit_to(label, event, payload)` and `app.listen` / `WebviewWindow::once`).
- `src/screens/ExportRenderer.tsx` — modify — subscribe to `export-renderer:frames` after emitting `:ready`. On payload receipt: store the frames array (do NOT yet render — task 630 adds the per-frame loop). Acknowledge by emitting `export-renderer:received` with the count.

## Deliverables

- `planExportFrames(timeline, fps, viewport)` returns `FrameSpec[]` with `frames.length === Math.floor(timeline.totalDurationMs * fps / 1000)` and per-frame `project_time_ms === i * 1000 / fps`. Pure function (`planExportFrames(...)` called twice with the same inputs returns deeply-equal output — same purity guarantee `compileTimeline` and `cameraAt` carry).
- TS `FrameSpec` / `ResolvedCameraIpc` shapes match Rust deserialization exactly (snake_case keys, `lng`/`lat` not `lon`/`latitude`, etc.) — round-trip an example payload through `JSON.stringify` → Rust `serde_json::from_str` → back as smoke test.
- IPC handshake order:
  1. parent invokes `render_map_frames(...)`
  2. Rust spawns / reuses the export-renderer window
  3. renderer mounts, emits `export-renderer:ready` (task 610)
  4. Rust receives `:ready`, emits `export-renderer:frames` with the `FrameSpec[]` to that window
  5. renderer emits `export-renderer:received` with the frame count (sanity check)
  6. (task 630 fills in the render loop here)
  7. renderer emits `export-renderer:done` with success or error
  8. Rust returns the result to the parent
- Parent → renderer ships *only* `FrameSpec[]`, `fps`, `output_dir`, and `viewport`. The renderer never sees the timeline, the project, or any clip — only the pre-resolved per-frame cameras. This is the determinism contract from `COMPILED_TIMELINE_PLAN.md` §"Export Semantics" enforced at the wire boundary: "export at any project-time `t` matches preview at the same `t`" because there is no second source of `t`-to-camera math anywhere downstream of `cameraAt(timeline, t)`.

## Acceptance criteria

- [ ] `cargo build --manifest-path src-tauri/Cargo.toml` passes.
- [ ] `npm run build` and `npm run test:run` pass (the latter exercises the new `planExportFrames` purity test).
- [ ] Unit test: `planExportFrames(timeline, 30, viewport)` produces frames whose `camera` field equals `resolveIntent(cameraAt(timeline, i * 1000 / 30), viewport)` for every `i`. This is the local source-of-truth contract before any IPC enters the picture.
- [ ] Unit test: `planExportFrames` is pure — two calls with the same inputs return deeply-equal output.
- [ ] Unit test: example `FrameSpec` JSON-serialized in TS deserializes cleanly into the Rust `FrameSpec` struct (use a Rust integration test that loads a fixture written by a TS-side script, OR just hand-write a known-good JSON fixture in both places).
- [ ] `npm run tauri dev`: invoking `render_map_frames` with a small frame set (e.g. 30 frames) completes the handshake — `:ready`, `:frames`, `:received`, and `:done` (the last currently fired immediately by a placeholder in the renderer) all observe in order. Verify via a Rust-side log or a temporary `console.log` in the renderer.
- [ ] No camera math in the renderer route's frame handler. The renderer reads `frame.camera` from the IPC payload and stores it; it does not call `cameraAt`, `resolveIntent`, or compute anything from `t`. Per `COMPILED_TIMELINE_PLAN.md` §"Export Semantics", the per-frame camera is whatever `cameraAt(timeline, t)` produced in the parent; the renderer is the dumb consumer.

## Implementation notes

`planExportFrames` outline:

```ts
export function planExportFrames(
  timeline: CompiledTimeline,
  fps: number,
  viewport: Viewport,
): FrameSpec[] {
  if (timeline.totalDurationMs <= 0) return [];
  const frameCount = Math.floor((timeline.totalDurationMs * fps) / 1000);
  const out: FrameSpec[] = new Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    const projectTimeMs = (i * 1000) / fps;
    const intent = cameraAt(timeline, projectTimeMs);
    const camera = resolveIntent(intent, viewport);
    out[i] = {
      frame_index: i,
      project_time_ms: projectTimeMs,
      camera: {
        center: { lng: camera.center.lng, lat: camera.center.lat },
        zoom: camera.zoom,
        bearing: camera.bearing,
        pitch: camera.pitch,
      },
    };
  }
  return out;
}
```

Frame-count rule: `floor(totalDurationMs * fps / 1000)`, exclusive of the trailing frame at `t = totalDurationMs`. This matches the standard "video sample at frame center" convention; document and revisit if the layout/compositing phase wants a different convention (e.g., capture both endpoints).

Tauri 2 event API:
- Parent emits to a specific window: `app.get_webview_window("export-renderer").map(|w| w.emit("export-renderer:frames", payload))`.
- Renderer listens via the JS API: `import { getCurrentWebview } from '@tauri-apps/api/webview';` then `getCurrentWebview().listen('export-renderer:frames', handler)`.
- Parent waits for renderer events via Rust: use `WebviewWindow::once` (one-shot listener) for `:ready`, `:received`, and `:done` to avoid leaking listeners across runs.

Why ship the entire `FrameSpec[]` at once vs. streaming one at a time: a typical 60s export at 30fps is 1800 frames × ~80 bytes per frame = ~140KB. That's well within a single IPC payload's comfortable size. Streaming adds complexity (per-frame ack, backpressure) for no benefit at this scale. If exports grow into the multi-minute range, revisit by chunking frames into batches of ~600 (= 20s @ 30fps).

Coordinate with task 600 (the Rust IPC payload structs are the source of truth — the TS shapes mirror them) and task 630 (which adds the actual render loop on the renderer side, between `:received` and `:done`).

The `export-renderer:done` placeholder in this task: have the renderer emit `:done` with `{ success: true, frames_received: n }` immediately after `:received`. Task 630 replaces that placeholder with the real loop's result.
