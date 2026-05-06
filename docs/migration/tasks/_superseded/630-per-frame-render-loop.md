# Task 630 — Per-frame render loop with tile-load determinism check

**Step**: Compiled Timeline export (Step 4 of the 600-series)
**Estimated effort**: 6h
**Status**: pending
**Depends on**: 620

## Goal

Implement the actual per-frame render loop inside the export-renderer window: for each `FrameSpec`, `map.jumpTo(camera)` to the pre-resolved camera, wait deterministically for tiles + sources to settle, capture the canvas pixels, write a PNG to `output_dir/frame_{index:06d}.png`, then advance to the next frame. Wire the lifecycle so `render_map_frames` (task 600) creates the renderer window (task 610), ships frames (task 620), waits for `:done`, and tears the window down.

The renderer is **dumb** by contract: it never invokes camera math. Per `COMPILED_TIMELINE_PLAN.md` §"Export Semantics": "`jumpTo` remains correct for export because interpolation is contained in `cameraAt(track, t)`. Export must not ask MapLibre to add a second layer of motion." This task is where we operationalize that "no second motion layer" rule — `jumpTo`, never `easeTo` or `flyTo`.

## Files to touch

- `src/screens/ExportRenderer.tsx` — modify — replace the placeholder `:done` immediate-fire (task 620) with the real per-frame loop. After `:received`, iterate `frames`: for each, `map.jumpTo({ center, zoom, bearing, pitch })`, await tile-load determinism (`map.areTilesLoaded()` polling + `map.once('idle')` settle), capture pixels via `map.getCanvas().toDataURL('image/png')` (or `toBlob` for binary), ship the PNG to Rust via a `save_export_frame` command, then advance. After the last frame, emit `export-renderer:done` with `{ success, frames_written }`.
- `src-tauri/src/commands/export.rs` — modify — (a) `render_map_frames` body now: spawn the export-renderer window, wait for `:ready`, emit `:frames`, wait for `:done`, close the window, return the result; (b) add `save_export_frame(output_dir, frame_index, data_url) -> Result<String, String>` that decodes the data URL and writes the PNG to disk. Reuse `crate::util::fs::ensure_dir`.
- `src-tauri/src/lib.rs` — modify — register `commands::save_export_frame` in `invoke_handler`.

## Deliverables

- Per-frame loop:
  ```ts
  for (const frame of frames) {
    map.jumpTo({
      center: [frame.camera.center.lng, frame.camera.center.lat],
      zoom: frame.camera.zoom,
      bearing: frame.camera.bearing,
      pitch: frame.camera.pitch,
    });
    await waitForMapIdle(map); // tiles loaded + sources idle
    const dataUrl = map.getCanvas().toDataURL('image/png');
    await invoke('save_export_frame', {
      output_dir, frame_index: frame.frame_index, data_url: dataUrl,
    });
  }
  ```
- `waitForMapIdle(map)` is the determinism-critical helper: poll `map.areTilesLoaded()` until true, then await one `map.once('idle')` event. If both don't resolve within a budget (`MAX_FRAME_WAIT_MS = 8000`), reject with a descriptive error so the export stops cleanly rather than producing a stale-tile frame.
- `render_map_frames` lifecycle (Rust):
  ```rust
  let window = create_export_renderer_window(&app, viewport, style, route_url)?;
  window.once("export-renderer:ready", move |_| { /* emit :frames */ });
  let result = wait_for_done(&window, MAX_EXPORT_TIMEOUT)?; // blocks
  window.close().ok();
  Ok(result)
  ```
- The renderer's PNGs land at `${output_dir}/frame_${index.padStart(6, '0')}.png`. Frame indices are 0-based and contiguous, matching `FrameSpec.frame_index`.
- The renderer only ever calls `jumpTo` — no `easeTo`, `flyTo`, `panTo`, or animation API. (`COMPILED_TIMELINE_PLAN.md` §"Export Semantics": all interpolation lives in `cameraAt`.)

## Acceptance criteria

- [ ] `cargo build --manifest-path src-tauri/Cargo.toml` passes.
- [ ] `npm run build` and `npm run test:run` pass.
- [ ] `npm run tauri dev`: export a 30-frame run from a real test project (≥1 clip, valid GPX) at 30fps. The run completes in under 60 seconds wall-clock, the renderer window opens hidden and closes cleanly after, and `${output_dir}` contains exactly 30 PNGs named `frame_000000.png` through `frame_000029.png`.
- [ ] No stale-tile frames in the output: spot-check three randomly-picked frames (e.g. 0, 14, 29) and confirm the rendered map matches the expected camera at that `t` (zoom level legible in the PNG roughly equals `frame.camera.zoom`, bearing visually matches, route line visible at correct location). Full programmatic verification is task 640.
- [ ] If `waitForMapIdle` times out for any frame, the export aborts with an error returned through `:done` and propagated up through `render_map_frames`. No partial-write garbage frames.
- [ ] No `easeTo` / `flyTo` / `panTo` / `panBy` / animation calls anywhere in `ExportRenderer.tsx`. `grep -n 'easeTo\|flyTo\|panTo\|panBy' src/screens/ExportRenderer.tsx` returns zero matches.
- [ ] Renderer never imports `cameraAt`, `compileTimeline`, or `resolveIntent`. The contract from `COMPILED_TIMELINE_PLAN.md` §"Export Semantics" — "export at any project-time `t` matches preview at the same `t`" — holds because the renderer only consumes pre-resolved cameras the parent computed via `cameraAt(timeline, t)`.

## Implementation notes

`waitForMapIdle` is the single biggest determinism risk in this task. MapLibre's `idle` event fires when the map has no pending tile requests and no in-flight transitions. But: a `jumpTo` to a previously-unvisited area kicks off tile loads asynchronously, and `idle` may fire **before** those loads complete if the load was deferred to the next animation frame. The robust pattern:

```ts
async function waitForMapIdle(map: maplibregl.Map): Promise<void> {
  const deadline = performance.now() + MAX_FRAME_WAIT_MS;
  // 1. Poll areTilesLoaded — handles the "loads still pending" case.
  while (!map.areTilesLoaded()) {
    if (performance.now() > deadline) throw new Error('frame wait: tiles not loaded within budget');
    await new Promise(r => setTimeout(r, 50));
  }
  // 2. Await one idle event — handles in-flight render passes / source updates.
  if (!map.loaded()) {
    await new Promise<void>((resolve, reject) => {
      const onIdle = () => { map.off('error', onError); resolve(); };
      const onError = (e: any) => { map.off('idle', onIdle); reject(e.error ?? new Error('map error during idle wait')); };
      map.once('idle', onIdle);
      map.once('error', onError);
    });
  }
}
```

The 8000ms budget is generous on purpose — first-time tile loads on a fresh viewport can take several seconds on a cold cache. Tighten in a follow-up once empirical data exists.

`map.getCanvas().toDataURL('image/png')` is the simplest capture path. Memory cost: a 1080×1920 RGBA buffer is ~8MB, the data URL roughly doubles that with base64 — fine for 1800-frame exports if processed serially (no buffering). For larger exports, switch to `toBlob` and stream the binary directly to a Rust file-write command without round-tripping through a string.

Frame filename `frame_${index.padStart(6, '0')}.png` matches FFmpeg's standard `image2` demuxer input pattern, so the layout/compositing phase can reference the directory directly without a manifest. (A manifest is still worth shipping — record `fps`, frame count, viewport, source project path. Add as `${output_dir}/manifest.json` in the same task.)

Lifecycle on the Rust side: use `tauri::async_runtime::spawn` to run the `:done` wait in a task, so the `render_map_frames` command can return without blocking the main runtime. Pattern:

```rust
let (tx, rx) = tokio::sync::oneshot::channel();
window.once("export-renderer:done", move |event| {
    let payload: DoneEvent = serde_json::from_str(event.payload()).unwrap_or_default();
    let _ = tx.send(payload);
});
let payload = tokio::time::timeout(Duration::from_secs(600), rx).await
    .map_err(|_| "export timed out")?
    .map_err(|_| "renderer dropped without :done")?;
window.close().ok();
```

If a previous renderer window leaked from a prior run (e.g. crash mid-export), close it before creating a new one — query `app.get_webview_window("export-renderer")` and call `.close()` if `Some`.

Coordinate with task 640 (parity verification): this task only checks visual sanity. Task 640 verifies frame-by-frame that the rendered camera state matches `resolveIntent(cameraAt(timeline, t), viewport)` exactly (modulo tile freshness), which is the export-determinism contract from `COMPILED_TIMELINE_PLAN.md` §"Export Semantics".

Open question deferred to the layout/compositing phase: clip 1's `t = 0` to `transitionSpan.endMs` window has no playing video yet — the export composer eventually needs a content-layer source (held first frame, `startCamera`-only background). This is **not** a render-loop concern; the per-frame map render is the same regardless. Flag if validation in task 640 surfaces a problem.
