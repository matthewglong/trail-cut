# Task 610 — Hidden `/export-renderer` Tauri window route

**Step**: Compiled Timeline export (Step 2 of the 600-series)
**Estimated effort**: 3h
**Status**: pending
**Depends on**: 600

## Goal

Stand up a hidden, headless Tauri window that loads a dedicated React route (`/export-renderer`) hosting a MapLibre instance the export pipeline can drive. The window is created on-demand by the `render_map_frames` command (task 630 wires the lifecycle), is invisible to the user, and renders at the exact viewport pixel dimensions the export requested.

This task only ships the **route + window plumbing**. The IPC channel that feeds it `FrameSpec`s lands in task 620; the per-frame `jumpTo` + capture loop lands in task 630. The route should mount, instantiate a MapLibre map at the requested viewport, and report "ready" — nothing more.

## Files to touch

- `src/screens/ExportRenderer.tsx` — new — the route component. Reads window-creation params (viewport width/height/dpr, map style, route GPX path) from window URL query string or a Tauri `init_script`-injected global. Mounts a MapLibre map at the requested pixel dims with the requested style. Signals readiness via a Tauri event (`export-renderer:ready`).
- `src/main.tsx` (or `src/App.tsx`, wherever the route table lives) — modify — add a route check: if `window.location.pathname === '/export-renderer'` (or matching React Router setup), render `<ExportRenderer />` instead of the main app shell. The export window must NOT mount the main editor UI.
- `src-tauri/src/commands/export.rs` — modify — add a helper `create_export_renderer_window(app, viewport, style, route_url)` that uses `tauri::WebviewWindowBuilder` to create an invisible window pointed at `/export-renderer` with the requested params encoded in the URL. The `render_map_frames` command body still returns its placeholder result for now; lifecycle wiring is task 630.
- `src-tauri/capabilities/default.json` — modify — extend `windows` to include both `"main"` and `"export-renderer"` so the same permissions apply.

## Deliverables

- A Tauri window labeled `export-renderer` can be created programmatically with: `visible: false`, `decorations: false`, `resizable: false`, `inner_size: (viewport.width, viewport.height)`, `url: WebviewUrl::App(format!("/export-renderer?w={}&h={}&dpr={}&style={}&route={}", ...).into())`.
- The window loads, mounts `<ExportRenderer />`, instantiates a MapLibre `Map` at the requested viewport, applies the requested style, loads the route GeoJSON from the supplied path, then emits `export-renderer:ready` via `getCurrentWebview().emit('export-renderer:ready', { ... })`.
- The main app window (`main`) is unaffected: its `<App />` still mounts as before, and the route-discriminator does not fire there.
- The main app window does NOT mount `<ExportRenderer />`, and the export window does NOT mount the editor shell — they are mutually exclusive.

## Acceptance criteria

- [ ] `cargo build --manifest-path src-tauri/Cargo.toml` passes.
- [ ] `npm run build` passes.
- [ ] `npm run tauri dev`: from devtools, calling the helper (via a temporary debug button or directly through `invoke` once task 630 wires it) creates a hidden window, the window's MapLibre map mounts, the `export-renderer:ready` event fires within 5 seconds, then closes cleanly when explicitly destroyed.
- [ ] The main window's UX is unchanged (no flash, no extra toolbar element, no console errors related to the route check).
- [ ] No camera math runs in the renderer window. The route mounts a MapLibre map and waits — it does NOT call `cameraAt`, `compileTimeline`, or `resolveIntent`. Per `COMPILED_TIMELINE_PLAN.md` §"Export Semantics", `cameraAt(timeline, t)` is the source of truth and runs only in the parent window before each `FrameSpec` is shipped over IPC.
- [ ] Renderer window viewport pixel dims match the requested `viewport.width × viewport.height` exactly (no DPR-doubled surprises). The DPR is applied to MapLibre's `pixelRatio` option, not to the window dims.

## Implementation notes

This is a Tauri-2-style multi-window app. The pattern (per Tauri 2 docs):

```rust
use tauri::{WebviewUrl, WebviewWindowBuilder};

pub fn create_export_renderer_window(
    app: &tauri::AppHandle,
    viewport: ViewportIpc,
    style: String,
    route_url: String,
) -> Result<tauri::WebviewWindow, String> {
    let url = format!(
        "/export-renderer?w={}&h={}&dpr={}&style={}&route={}",
        viewport.width, viewport.height, viewport.dpr,
        urlencoding::encode(&style), urlencoding::encode(&route_url),
    );
    WebviewWindowBuilder::new(app, "export-renderer", WebviewUrl::App(url.into()))
        .visible(false)
        .decorations(false)
        .resizable(false)
        .inner_size(viewport.width as f64, viewport.height as f64)
        .build()
        .map_err(|e| e.to_string())
}
```

Add `urlencoding = "2"` to `src-tauri/Cargo.toml` if not already present.

The `<ExportRenderer />` route reads query params, instantiates a MapLibre `Map` (same `maplibre-gl` import the editor's `MapView.tsx` uses) at:
- `container`: a div sized exactly `width × height` pixels (no `100%`/responsive sizing — fixed pixels match the requested viewport).
- `style`: the style URL passed in (defaults to whatever the editor uses today; thread the same style resolution from the project's `MapSettings`).
- `pixelRatio`: `dpr` from query params (passed to MapLibre's constructor for raster sharpness).
- Route layer: load GeoJSON from `route_url` (re-used GPX-to-GeoJSON converter from the editor's MapView, factored out if needed; do not duplicate parsing logic).

Why a hidden window instead of headless rendering in Rust: MapLibre is the renderer. We need MapLibre's actual pixel output, not a Rust port. A hidden Tauri window is the cheapest way to get a real WebGL canvas the export loop can drive.

Why `visible: false` rather than off-screen positioning: macOS hides off-screen windows from screen capture but still composites them; `visible: false` is more efficient. It does mean the window's WebGL context may be backgrounded (paused) by the OS — task 630's render loop must verify the captured pixels are real, not stale.

Window label `"export-renderer"` is reserved for this purpose and must be unique per app run. If a previous run leaked a window, task 630's lifecycle code is responsible for closing it — this task only creates.

Coordinate with task 620 (IPC wiring): the `export-renderer:ready` event is the handshake the parent waits on before shipping the first batch of frames. Use a stable event name now so task 620 can subscribe to it.

Coordinate with task 630 (lifecycle): this task does NOT call `create_export_renderer_window` from inside `render_map_frames`. That wiring is task 630. This task ships the helper as a public function (or pub-crate) and the route, ready to be called.
