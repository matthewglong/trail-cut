# Task 420 — Wire IPC: parent → renderer sends (track, layout_per_frame, fps)

**Step**: 4 (Export harness)
**Estimated effort**: 2h
**Status**: pending
**Depends on**: 410

## Goal

Implement the IPC handshake that ships the per-frame data from the parent window (which holds the `MapTrack` and runs `cameraAt`/`resolveIntent`) to the hidden renderer window. The renderer receives the batch once and runs the export render loop (task 430) without further IPC chatter. Per §6.4 step 3 of the migration doc: "The export-renderer page receives `(track, layout_per_frame, fps)` via the asset protocol or a one-shot IPC and runs the export render loop from §3.7."

## Files to touch

- `src/screens/ExportRenderer.tsx` — modify — add a Tauri event listener for `'export-renderer-frames'`. When received, store the batch in component state and trigger the render loop (loop body is task 430 — for now, just receive and ack).
- `src-tauri/src/commands/export.rs` — modify — after the renderer emits `'export-renderer-ready'`, the command emits `'export-renderer-frames'` to the renderer window with the full frame batch. Awaits `'export-renderer-done'` before closing.
- `src/lib/exportFrames.ts` — new — frontend helper that, given a `MapTrack`, fps, and start/end wall-clock range, produces the `FrameSpec[]` array (calling `cameraAt → resolveIntent` per frame in the parent window before the IPC). This is where all the camera math runs; the renderer just consumes resolved cameras.

## Deliverables

- `exportFrames.ts` exports `buildExportFrames(track, fps, startMs, endMs, layout): FrameSpec[]` that walks the timeline at `1/fps` cadence and produces resolved cameras per frame.
- The Tauri command receives `frames: FrameSpec[]` (built by the parent) and forwards them to the renderer window.
- Renderer window receives the batch, logs "received N frames", and emits `'export-renderer-done'` immediately (the actual rendering body lands in task 430).
- The full handshake completes end-to-end for a 30-frame test batch.

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `cargo build --manifest-path src-tauri/Cargo.toml` passes.
- [ ] `await invoke('render_map_frames', { ... 30 frames ... })` resolves successfully — manually verifiable via a test button on the existing app or via devtools.
- [ ] The renderer's console shows the received frame count matches what the parent sent.
- [ ] No frame data is lost in the IPC roundtrip (verified by hashing the input array and the renderer-side received array).

## Implementation notes

Frame builder pseudo-code:

```ts
import { cameraAt, resolveIntent } from './cameraIntent';

export function buildExportFrames(
  track: MapTrack,
  fps: number,
  startMs: number,
  endMs: number,
  mapRect: LayoutRect,        // map_rect from layoutFor — task assumes single fixed layout for now
): FrameSpec[] {
  const frames: FrameSpec[] = [];
  const totalFrames = Math.ceil((endMs - startMs) / 1000 * fps);
  for (let i = 0; i < totalFrames; i++) {
    const t = startMs + (i * 1000 / fps);
    const intent = cameraAt(track, t);
    const viewport: Viewport = { width: mapRect.width, height: mapRect.height, dpr: 1 };
    const camera = resolveIntent(intent, viewport);
    frames.push({ frame_idx: i, camera, map_rect: mapRect });
  }
  return frames;
}
```

Note that this task assumes a single fixed `mapRect` for the entire export — true for v1 since the Step 5 layout policy is out of scope. If `layoutFor` ever returns different rects per frame, the same builder accepts a `(t) => LayoutRect` callback.

IPC message sizing: 30 frames × ~100 bytes per FrameSpec = ~3KB. Even a 30-second 30fps export is ~270KB — well within Tauri IPC limits. Don't preemptively chunk.

Tauri 2 event API:

```ts
import { listen, emit } from '@tauri-apps/api/event';
// In renderer:
listen<FrameSpec[]>('export-renderer-frames', async (e) => {
  const frames = e.payload;
  // task 430 fills in the render loop here
  await emit('export-renderer-done', { ok: true });
});
```

The Rust command uses `app_handle.emit_to('export-renderer', 'export-renderer-frames', frames)?` and then awaits a one-shot listener for `'export-renderer-done'`. Use `tauri::async_runtime::oneshot` or similar.

This task ratifies the IPC contract; task 430 fills in the rendering body.
