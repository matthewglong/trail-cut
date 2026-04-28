# Task 410 — Build hidden /export-renderer Tauri window route

**Step**: 4 (Export harness)
**Estimated effort**: 2h
**Status**: pending
**Depends on**: 400

## Goal

Add a hidden `/export-renderer` window route that loads a minimal page with a single MapLibre `<div>` and no UI chrome. This is the offscreen canvas where the export render loop runs, per §6.4 step 2 of the migration doc: "Inside the command, spawn a hidden Tauri window with a route `/export-renderer` that loads a minimal page: a single `<div>` for MapLibre, no UI chrome."

## Files to touch

- `src/screens/ExportRenderer.tsx` — new — minimal React component: a single `<div ref={containerRef} />` filling the window, mounting a `maplibregl.Map` instance, no toolbars / no overlays. Reads init params from a query string or window.location.
- `src/main.tsx` — modify — add a top-level route check: if `window.location.pathname === '/export-renderer'` (or query param `?export=1`), render `<ExportRenderer />` instead of `<App />`. Tauri's webview routes off the same React tree.
- `src-tauri/src/commands/export.rs` — modify — `render_map_frames` body now creates a hidden `WebviewWindow` pointing at the renderer route, awaits its IPC ready signal (via a separate `export_renderer_ready` command or a `tauri::Manager::listen`), then resolves. (Body still doesn't render frames yet — that's task 430.)
- `src-tauri/tauri.conf.json` — verify — no config change needed if the window can be created at runtime; if a static window definition is required for the asset protocol scope, add it.

## Deliverables

- Calling `invoke('render_map_frames', ...)` opens a hidden Tauri window at `/export-renderer`.
- The renderer window mounts a MapLibre map filling the window.
- The window is hidden (`visible: false` in WebviewWindow config) — does not flash on screen.
- Window closes after the command completes (cleanup in the command body).
- The renderer exposes a "ready" signal (e.g., emits a Tauri event `export-renderer-ready` when the map is loaded).

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `cargo build --manifest-path src-tauri/Cargo.toml` passes.
- [ ] Manually triggering `invoke('render_map_frames', { frames: [], fps: 30, output_dir: '/tmp/test' })` opens and closes the hidden window without visible flash.
- [ ] The renderer console logs "map loaded" on style ready (verifiable via Tauri devtools).
- [ ] No new visible window appears in normal app use.

## Implementation notes

WebviewWindow creation pattern (Tauri 2):

```rust
let window = tauri::WebviewWindowBuilder::new(
    app_handle,
    "export-renderer",
    tauri::WebviewUrl::App("/export-renderer".into()),
)
.visible(false)
.title("Export Renderer")
.inner_size(1920.0, 1080.0)  // overridden per-frame in task 430
.build()?;
```

The renderer page is fundamentally just `<div id="map">` styled `width: 100vw; height: 100vh`. No router, no clip browser, no toolbar — just the map.

Init params: the simplest is `await invoke('get_export_init_data')` after the renderer signals ready, returning the frames array. Or pass via the URL hash. Given Tauri's IPC is robust, prefer an event-based handshake:

1. Parent calls `render_map_frames`, which opens the window.
2. Renderer's React effect emits `'export-renderer-ready'`.
3. Parent's command listens for that event, then sends `'export-renderer-frames'` with the frame batch.
4. Renderer processes the batch (task 420/430), emits `'export-renderer-done'` (or per-frame progress events).
5. Parent closes the window and resolves the command.

This task wires steps 1, 2, and the close. Steps 3-4 land in task 420; the frame body lands in task 430.

Use the existing MapLibre style URL (OpenFreeMap tiles per `CLAUDE.md`). The renderer needs the same style as the preview to produce matching output.
