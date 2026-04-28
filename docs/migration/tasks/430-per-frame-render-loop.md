# Task 430 — Per-frame render loop with tile-load determinism check

**Step**: 4 (Export harness)
**Estimated effort**: 3h
**Status**: pending
**Depends on**: 420

## Goal

Implement the per-frame export loop in the hidden `/export-renderer` window per §3.7 and §6.4 step 4-5 of the migration doc: `cameraAt → resolveIntent → map.jumpTo → awaitTilesIdle → capture canvas → write PNG`. **Camera math already happened in task 420's frame builder** — this task consumes pre-resolved cameras. The task also resolves §8.1 (tile-load idle determinism): pixel-compare the same frame rendered immediately vs after 2s soak; if they differ, switch from `map.once('idle')` to `map.areTilesLoaded()` polling with a 2000ms timeout.

## Files to touch

- `src/screens/ExportRenderer.tsx` — modify — implement the render loop body inside the `'export-renderer-frames'` listener. For each frame: resize viewport if needed, `map.jumpTo(camera)`, await tiles, capture canvas to PNG, send PNG bytes (or file path) back to the parent for disk write OR write directly to disk via a Tauri `write_png` command.
- `src-tauri/src/commands/export.rs` — modify — add a `write_export_frame_png(output_dir, frame_idx, png_bytes)` command that the renderer calls per frame.
- `src/screens/ExportRenderer.tsx` — modify — implement §8.1 verification: render the first frame twice (jump → immediate capture A; wait 2000ms → capture B). Pixel-compare. If diff exceeds a tolerance (e.g., >1% of pixels), log a warning and switch the rest of the run to `areTilesLoaded()` polling with 2000ms timeout.

## Deliverables

- The renderer processes the FrameSpec batch end-to-end and emits one PNG per frame to `output_dir/frame_NNNNN.png`.
- §8.1 determinism check runs once per render (on frame 0): if the immediate-vs-soak diff is small, use `map.once('idle')` for the rest. If it's large, switch to `areTilesLoaded()` polling.
- Per-frame failure logging: if `areTilesLoaded()` doesn't return true within 2000ms, the frame is rendered anyway and a warning is logged with the frame_idx; the failure rate is reported in the final return value.
- The command's return value reports `{ frames_rendered, frames_with_tile_timeouts, used_polling: bool }`.

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `cargo build --manifest-path src-tauri/Cargo.toml` passes.
- [ ] Manual run: render a 30-frame batch for a real project. Output dir contains 30 PNG files numbered `frame_00000.png` through `frame_00029.png`.
- [ ] Every PNG opens (non-corrupt) and is non-blank (mean pixel value > 0).
- [ ] §8.1 verification result is logged for the run: either "tiles deterministic without polling" or "tiles polled, N/30 frames timed out."
- [ ] Per the doc's pass criterion (§6.4): two independent runs produce byte-identical (or near-identical, modulo tile freshness) PNGs.

## Implementation notes

§3.7 export render loop (verbatim):

```pseudocode
for frame_idx in 0..total_frames:
    t = wallClockForFrame(frame_idx, fps, project_start_ms)
    layout = layoutFor(export_aspect, video_aspect_at_t, project)
    intent = cameraAt(track, t)
    viewport = { width: layout.map_rect.w, height: layout.map_rect.h, dpr: 1 }
    camera = resolveIntent(intent, viewport)
    map.jumpTo({ ... camera ... })
    awaitTilesIdle(map)
    map_png = capture(map, layout.map_rect)
```

The migration doc (§3.7) explains why `jumpTo` is correct in export but wrong in preview: "Export evaluates `cameraAt(t)` at exactly the frame's wall-clock time. The function *already* contains the smooth Van Wijk interpolation. We do not want MapLibre to *also* interpolate — that would compound. `jumpTo` snaps the camera to exactly the value `cameraAt` produced, then we wait for tiles, then we capture."

Capture pattern (MapLibre):

```ts
map.jumpTo({ center: [c.lng, c.lat], zoom: c.zoom, bearing: c.bearing, pitch: c.pitch });
await awaitTilesIdle(map);
const canvas = map.getCanvas();
const blob: Blob = await new Promise(resolve => canvas.toBlob(b => resolve(b!), 'image/png'));
const buf = await blob.arrayBuffer();
await invoke('write_export_frame_png', { output_dir, frame_idx, png_bytes: Array.from(new Uint8Array(buf)) });
```

`awaitTilesIdle` v1 (§8.1 default):

```ts
async function awaitTilesIdle(map: maplibregl.Map): Promise<void> {
  return new Promise(resolve => map.once('idle', () => resolve()));
}
```

`awaitTilesIdle` v2 (polling fallback if §8.1 check fails):

```ts
async function awaitTilesLoaded(map: maplibregl.Map, timeoutMs = 2000): Promise<boolean> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (map.areTilesLoaded()) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}
```

§8.1 verification: render frame 0 with `awaitTilesIdle` v1, capture as PNG_A. Wait 2000ms. Capture again as PNG_B. Pixel-diff (sum of |A-B| / total pixels). If >1% of pixels differ, switch the rest of the batch to v2. The `used_polling` field in the return value reports which path was taken.

The migration doc (§8.1) mandate: "in Step 4's harness, render the same frame twice — once right after `jumpTo`, once after a 2s soak — and pixel-compare. If they differ beyond a tile-edge tolerance, switch to `areTilesLoaded()` polling."

`map.resize()` is essential when the viewport (FrameSpec.map_rect) changes between frames. Today's Step 5 is out of scope so all frames in v1 use the same map_rect — but the resize call is cheap and correct, so include it.

The Rust `write_export_frame_png` command takes `Vec<u8>` and writes via `std::fs::write`. Filename pattern: `frame_{:05}.png`. Use the `output_dir` from the original args.
