---
status: superseded
superseded_by: ../../../export/PLAN.md
date: 2026-05-05
---

# Superseded 600-series task files

The original 600-series tasks (600–640) were authored as part of the camera-migration phase to specify the export-side mirror of the compiled-timeline preview. Their architectural premise — render frames in a hidden Tauri webview, capture via `gl.readPixels`, write PNGs to a directory — was reconsidered before any code landed.

Two issues surfaced:

1. **Wrong renderer venue.** A hidden webview is an interactive renderer with a fence stuck in front of it (`map.once('idle')` between frames). Real video editors render headlessly and in parallel — the render is a pure function of (project, frame_index), not a playback timeline that gets screen-scraped. The right primitive is a headless library call, not a webview.
2. **Wrong output abstraction.** PNGs on disk are useful for nothing downstream — Channels A (composite), B (map only), and C (video only) all want to feed raw frames into ffmpeg's filtergraph as a *stream*, not pick them off a directory. The PNG step was a vestige of a never-finished compositing design.

The replacement architecture is documented in [`docs/export/PLAN.md`](../../../export/PLAN.md). At a glance:

- **Renderer**: Node sidecar process running `@maplibre/maplibre-gl-native` (mature, prebuilt cross-platform binaries, used in production by tile-server stacks).
- **Pipeline**: Rust spawns N renderer workers in parallel, each owns one `Map` instance, frames stream as raw RGBA bytes over stdout, Rust orders and pipes into ffmpeg's stdin.
- **Three channels**: A (composite — map + processed video, the headline product), B (map-only, full or per-clip), C (video-only, full or per-clip). All three share the same renderer + ffmpeg pipeline; they differ in filtergraph configuration.

What survived from the 500-series migration's parity contract:

- `cameraAt(timeline, t)` in TS remains the single source of camera truth.
- The frontend pre-resolves cameras via `resolveIntent(cameraAt(t), viewport)` and ships `FrameSpec[]` to Rust.
- The renderer is "dumb" — receives pre-resolved cameras, calls into MapLibre, returns pixels.

What changed:

- The renderer is native (Node binding to maplibre-native C++) instead of a webview.
- Output is a raw RGBA stream into ffmpeg, not PNGs on disk.
- The architecture supports parallel frame rendering across worker processes from day one.

These files are kept for history. Do not act on them.
