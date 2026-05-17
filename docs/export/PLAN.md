# TrailCut Export Pipeline — Plan

**Status**: Architecture and layout decisions captured; concrete task authoring pending.
**Replaces**: `docs/migration/tasks/_superseded/600`–`640` (obsolete webview-screen-capture approach).
**Date**: 2026-05-05

## What this document covers

- The three export channels (composite, map-only, video-only) and how they relate.
- The renderer architecture: a Node sidecar running native MapLibre, called from Rust, streamed into FFmpeg.
- Cross-platform strategy (macOS + Windows) for the renderer, FFmpeg, and bundling.
- The frame pipeline: parallelism, memory recycling, ordering guarantees.
- The IPC contract between Rust and the renderer workers.

## What this document does NOT cover

- **Layout system, video-side effects pipeline, channel output formats, audio rule** — settled in [`./LAYOUT.md`](./LAYOUT.md). This document and LAYOUT.md are companions.
- **Concrete task files** (replacing the superseded 600-series). Authored next, now that layout design has landed; expected sequence at the end of this doc.

## Constraints and principles

A few hard constraints and guiding principles that shaped the decisions below:

- **Cross-platform from day one.** The app must run on macOS (current) and Windows (planned). Architecture choices that were viable on Mac alone but fragile on Windows — e.g. the Rust binding to maplibre-native, which lacks Windows CI — were rejected. This is a fixed product requirement, not a stretch goal.
- **Headless, parallel, deterministic.** Map rendering for export must be a pure function — `(timeline, t, viewport) → pixels` — called from a library, not screen-captured from an interactive renderer. Real video editors render this way: parallelism, determinism, no playback-clock dependency, no fences between frames. We do too.
- **Single source of camera truth.** `cameraAt(timeline, t)` (TS) drives both preview and export. The renderer worker imports the same compiled `cameraAt` as preview (via the shared-module mechanism in the next bullet), so per-frame camera evaluation in the worker is the literal same function call as in preview — no Rust/Node port, no parallel implementation, no drift. This is the central invariant of the 500-series migration; the *end* (identical camera at any `t`) survives, and the *means* strengthens — earlier drafts had the frontend pre-resolve cameras to prevent a Rust/Node port from drifting, but the shared-module mechanism makes pre-resolution unnecessary because preview and worker run identical TS code.
- **Single source of visual truth.** Every visual decision — base style, layer specs, paint expressions, source-data computation (route, trail, waypoints, marker), and animation curves — lives in a shared TypeScript module (`src/lib/mapVisuals/`) consumed by **both** the preview renderer (browser MapLibre GL JS) and the export renderer worker (Node + headless-Chromium running the same MapLibre GL JS, built from the same TS source). A change to marker color, slime-trail paint, waypoint styling, or any animation curve is a one-PR change in that module; both surfaces pick it up automatically. There is no "preview-side" or "export-side" version of any visual decision. Animations are **project-time-driven** (pure functions of `t`), not wall-clock-driven, so the export renderer reproduces them frame-for-frame at any sampled `t` — and preview behavior under scrub/pause becomes correct as a side effect (today's CSS-keyframe pulse, for example, drifts under scrub). This is the same principle as the camera invariant, generalized to all visuals.

## Channels

The export pipeline produces three product channels. All three share the same map renderer and FFmpeg pipeline; they differ in time range and filtergraph configuration.

| Channel | Output | Source streams | Time range |
|---|---|---|---|
| **A. Composite** *(headline)* | `final.mp4` — H.265, map + processed video composited per layout, at chosen aspect | map render stream + processed source clips | `[0, totalDurationMs]` |
| **B. Map only** | `map.mov` (full) or `clip{N}_map.mov` (per-clip) — ProRes 4444 with alpha; map at its slot rect, alpha=0 elsewhere | map render stream | full timeline or per-clip span |
| **C. Video only** | `video.mov` (full) or `clip{N}_video.mov` (per-clip) — ProRes 4444 with alpha; video at its slot rect, alpha=0 elsewhere | processed source clips, no map | full timeline or per-clip span |

B and C are **masked positional exports** — full output-frame dimensions with content placed at its layout slot rect and alpha=0 elsewhere. This lets a user stack B.mov and C.mov in any NLE and reconstruct A's composite with no positioning work. See [`./LAYOUT.md`](./LAYOUT.md) §6.

C is non-trivial: it applies the same per-clip effects (trim, speed, focal-point crop to slot aspect) as the composite, so the video-side filtergraph is shared between A and C.

User experience implication: each channel is a separate export action. v1 may ship all three but the composite is the headline; map-only / video-only are user-control surfaces for downstream remixing.

## Renderer architecture

**Decision (v2, post-task-118)**: Node sidecar running `puppeteer-core` driving `chrome-headless-shell` with `maplibre-gl-js` inside the page, spawned from Rust, communicating over stdio.

The original v1 plan selected `@maplibre/maplibre-gl-native` (Node binding to the C++ engine) and shipped through tasks 010–110. During task 110 the native renderer was found to produce visible 1-pixel wobble on slow camera pans — sub-pixel deltas snap to the integer pixel grid because the painter's `options.moving` flag is forced false on long-running animations. Tasks 115–119 migrated to the chromium renderer, which exposes the same painter object; a 4-line monkey-patch in `src-tauri/sidecars/renderer/page/painterPatch.ts` forces `moving: true` and produces wobble-free output. Detailed rationale and rejected alternatives in [`./plans/chromium-renderer.md`](./plans/chromium-renderer.md).

The chromium renderer adds ~120 MB per macOS arch (chrome-headless-shell + .pak resources + .dylibs) on top of the existing Node runtime — accepted trade-off for visual quality. Tasks 118 (cutover + bundle) and 119 (delete native) realize the migration.

### Why this and not the alternatives

Three renderer venues were evaluated for v1:

1. **Tauri hidden webview + MapLibre GL JS + `gl.readPixels`** — what the superseded 600-series proposed. An interactive renderer with a fence in front of it. Tile-load determinism requires waiting for `map.once('idle')` between frames; serializes badly; not how real editors work. Rejected.
2. **`maplibre-native-rs` (Rust binding to C++ library)** — active and synchronous-API-friendly, but Windows support is marked "theoretical, no CI" by the maintainers. Cross-platform requirement disqualifies. Reconsider if/when Windows CI lands.
3. **`maplibre-rs` (pure Rust)** — pre-1.0, missing symbol layer (markers) and raster sources, no Windows support listed. Disqualifying feature gaps.
4. **`@maplibre/maplibre-gl-native` (Node binding to the same C++ engine as #2)** — prebuilt binaries for macOS amd64+arm64 / Windows amd64+arm64 / Linux, npm install with no native build, used in production by TileServer GL and `mapgl-tile-renderer`. **Selected for v1, retired in v2 because of the wobble bug — see above.**

The v2 decision (chromium) was forced by the wobble finding. v1's bundle-size argument was the right call given the information at the time; v2 trades 120 MB for a fix to a user-visible visual defect that has no other resolution path on the C++ engine.

### Process model

```
┌──────────────────────────────────────────────────────────────────┐
│ Tauri app process (Rust + webview)                               │
│                                                                  │
│  Frontend (webview):                                             │
│    cameraAt(timeline, t) → resolveIntent → FrameSpec[]           │
│    │                                                             │
│    ▼ invoke('render_export', { frame_specs, channel, ... })      │
│                                                                  │
│  Rust orchestrator (commands/export/*.rs):                       │
│    splits frame_specs into N ranges                              │
│    spawns N renderer workers + 1 FFmpeg child                    │
│    drains worker stdout in frame_index order → FFmpeg stdin      │
└──────────────────────────────────────────────────────────────────┘
        │                              │
        │ spawns (N×)                  │ spawns
        ▼                              ▼
  ┌─────────────────────┐         ┌─────────────────────────┐
  │ Renderer worker(s)  │  RGBA   │ FFmpeg sidecar          │
  │ (Node + puppeteer-  │ ──────▶ │  -f rawvideo            │
  │  core + headless-   │  bytes  │  -pix_fmt rgba          │
  │  Chromium)          │         │  -i pipe:0              │
  │ stdin: JSON cmds    │         │  + filtergraph          │
  │ stdout: RGBA frames │         │  → output.mp4           │
  └─────────────────────┘         └─────────────────────────┘
```

Sidecar binaries, all bundled per-platform via Tauri 2's `bundle.externalBin` (single-file binaries) and `bundle.resources` (directory trees):

- `node` (the runtime) + `renderer.cjs` (our worker script — built from TypeScript via esbuild from `src-tauri/sidecars/renderer/index.ts`, importing from `src/lib/mapVisuals/`, `src/lib/cameraIntent.ts`, `src/lib/routeLocation.ts`; `puppeteer-core` and `pngjs` are externalized)
- `chrome-headless-shell-<target-triple>/` (directory tree: binary + .dylibs + .pak + resources, ~120 MB; downloaded by `src-tauri/sidecars/renderer/build.mjs` via `@puppeteer/browsers`, shipped via `bundle.resources` — not `externalBin` because Tauri's `externalBin` mechanism is single-file)
- `ffmpeg` (static build)
- `exiftool` (already there — unrelated to export)

### Renderer worker lifecycle

Each worker is a long-running Node process. Its source lives in TypeScript and imports the same `mapVisuals` / `cameraIntent` / `routeLocation` modules the preview consumes — that's how visual parity is structurally enforced (see "Single source of visual truth" above and the IPC contract section below).

1. **Boot**: receives the setup payload on stdin (project state — see IPC contract). Builds the style spec via `mapVisuals.buildStyleSpec(map_settings)`, attaches the static source data via `mapVisuals.buildStaticSourceData(...)`. Caches an indexed-route via `indexRoute(route)` for per-frame lookups. Reports `{ready: true}` on stdout once `style.load` fires.
2. **Render loop**: receives one render command per stdin line (`{frame_index, project_time_ms}`). Calls `mapVisuals.buildPerFrameState(timeline, t, indexedRoute, clips, map_settings)`, applies per-frame source/paint updates to the `Map`, then `map.render(opts, callback)`. On callback, writes a 4-byte big-endian length prefix + the raw RGBA buffer to stdout. Continues to next message.
3. **Recycle**: every K frames (initial K=60, ~2s of video), the worker closes and reopens the headless-Chromium `Page` and rebuilds the `Map` from the cached setup payload. Browser-level allocations accumulate per render; recycling caps growth without re-paying browser-launch cost (the underlying `Browser` is reused; only the `Page` recycles). Recycling is effectively free in wall-clock terms (style is cached on disk; warm tiles are cached too). Every 10 page-recycles the worker also relaunches the `Browser` as a layered defense — see `src-tauri/sidecars/renderer/index.ts` for the BROWSER_RESTART_EVERY_RECYCLES knob.
4. **Shutdown**: on EOF or explicit `{cmd: "shutdown"}`, releases the `Map` and exits.

Memory budget per worker after recycling: ~200 MB steady state. With N workers in parallel, total resident set ≈ N × 200 MB — workable up to N=8 on a 16 GB machine.

### Parallelism strategy

Frames split into N contiguous ranges. Each range is bound to one worker; workers render frames sequentially within their range. The orchestrator drains workers in frame-index order and feeds FFmpeg's stdin in order — workers may race ahead and queue completed frames, but FFmpeg only ever sees frames in order.

For v1, ship with N=1 (sequential, single worker). The orchestrator is structured for N>1 from day one but the configuration starts conservative; we tune up after measuring real exports.

### Determinism

- The same `cameraAt(timeline, t)` evaluator drives both preview and export, so camera state is identical.
- The renderer is `maplibre-gl-js` running inside `chrome-headless-shell` — the same engine the in-app preview uses. Same engine + same style + same camera = same pixels (within float precision).
- The page-side bootstrap freezes maplibre's clock with `setNow(t)` and overwrites `style.stylesheet.transition` to `{duration:0,delay:0}`, so paint transitions complete instantly and `idle` fires deterministically per frame.
- Tile fetches go through the page's `addProtocol('trailcut', ...)` loader → `page.exposeFunction` bridge → Node's `tileCache.get(originalUrl, ...)`, hashed on the **original** OpenFreeMap URL (never the rewritten `trailcut://` URL). Repeat exports are deterministic and fast.
- No timing dependence: each frame waits for `map.once('idle')` plus two rAFs after `setNow`+source/paint updates, then captures via `page.screenshot`. The page render loop is fully driven by the frozen clock and explicit `triggerRepaint`.

### Frame-pipeline ordering

The output FFmpeg process receives raw RGBA frames at a fixed `(w, h, fps)`. There's no per-frame metadata in the stream — frame N is "the Nth W×H×4 bytes." The orchestrator is responsible for:

- Receiving each worker's output, tagging by `frame_index`.
- Buffering until the next-needed `frame_index` is available.
- Writing in order to FFmpeg's stdin.

A small bounded buffer (~64 frames = ~500 MB at 1080×1920) is enough to absorb worker scheduling jitter without backing up the renderer pool.

## Cross-platform strategy

### Sidecar binaries (per-target-triple, via Tauri's `bundle.externalBin` + `bundle.resources`)

| Binary | macOS arm64 source | Windows x86_64 source | Notes |
|---|---|---|---|
| `node` | https://nodejs.org/dist/ (LTS, signed) | https://nodejs.org/dist/ (LTS, signed) | Bundle the runtime |
| `chrome-headless-shell` directory tree | `@puppeteer/browsers install --platform mac_arm` at build time (~120 MB, downloaded into `src-tauri/binaries/chrome-headless-shell-<triple>/`) | `--platform win` (task 130) | Directory tree, not single binary — shipped via `bundle.resources` glob; binary + .pak + .dylibs all required at runtime |
| `ffmpeg` | evermeet.cx static build (Mach-O) | BtbN GPL static build (PE) | GPL flavor needed for libx264/libx265; license OK because we exec as separate process |

Tauri sidecar paths follow `binaries/<name>-<target-triple>{.exe}` for single-file binaries; directory-tree resources land at `<bundle>/Contents/Resources/<original-relative-path>` on macOS via `bundle.resources` globbing.

### Hardware-accelerated encoding

Probed once at first launch; cached in `~/.trailcut/encoder.json`:

| Platform | Try order | Fallback |
|---|---|---|
| macOS | `h264_videotoolbox` | `libx264` |
| Windows | `h264_nvenc` → `h264_qsv` → `h264_amf` | `libx264` |

Probe procedure: run `ffmpeg -encoders`, parse the listed encoders, then test-encode a 1-frame clip per supported encoder (catches "encoder is in the build but the GPU/driver doesn't support the API version" failures, which are common on NVENC).

### Code signing

- macOS: existing dev cert chain works; production build needs notarization (handled by Tauri bundler).
- Windows: OV cert via Azure Key Vault is the indie-friendly path post-2023 HSM requirement. SmartScreen will block unsigned builds; signing is effectively required for distribution. **Action item before Windows ship**: provision OV cert + Azure Key Vault, plumb via Tauri's `signtool` integration. Not blocking macOS work.

## IPC contract — frontend → Rust → renderer

The contract follows from the **single source of visual truth** principle above: the renderer worker is built from the same TypeScript sources as the preview (`src/lib/mapVisuals/`, `src/lib/cameraIntent.ts`, `src/lib/routeLocation.ts`), so per-frame derivation happens in the worker via the same shared module that drives `MapView.tsx`. The wire payload carries project state, not pre-derived per-frame state.

### Frontend → Rust (Tauri command)

```ts
type ExportChannel = "composite" | "map_only" | "video_only";

invoke('render_export', {
  channel: ExportChannel,
  fps: number,                       // 30 or 60
  output_path: string,               // .mp4 for Channel A; .mov for B and C
  layout: LayoutDescriptor,          // see LAYOUT.md §1 (modes) and §6 (slot rects per channel)

  // Project state — same shapes that drive MapView.tsx in preview. The
  // worker derives every per-frame value from these by calling into
  // `mapVisuals` (camera, source data, paint property values) — identical
  // code path to preview, identical pixels at any given `t`.
  timeline: CompiledTimeline,
  route: Route | null,
  clips: Clip[],
  map_settings: MapSettings,

  // FFmpeg / video-side input — independent of the map renderer.
  source_clips: ClipSourceRef[],     // proxy + source paths, in/out, speed, focal point
});
```

Total frame count is derived from `timeline.totalDurationMs` and `fps` in Rust; the frontend does not pre-walk frames. The map's render viewport is the layout-assigned **slot** dimensions, not the output frame; this comes from `layout` and the output aspect's pixel dims (see LAYOUT.md §5).

### Rust → renderer worker (stdio, line-delimited JSON for commands; raw bytes for pixel responses)

Setup (sent once after spawn, all project state included):

```json
{
  "cmd": "setup",
  "viewport": {"w": 540, "h": 960},
  "fps": 30,
  "timeline": {...CompiledTimeline...},
  "route": {...Route...} ,
  "clips": [...],
  "map_settings": {...MapSettings...}
}
```

Worker actions on setup:
1. `mapVisuals.buildStyleSpec(map_settings)` → assembles the complete MapLibre style (sources + layers + paints — same definitions preview consumes).
2. `mapVisuals.buildStaticSourceData({route, clips, map_settings})` → seeds the static GeoJSON sources (full route line, waypoint feature collection).
3. Wait for `style.load`, then reply `{"ready":true}\n` on stdout.

Per-frame:

```json
{"cmd":"render","frame_index":0,"project_time_ms":0}\n
```

Worker actions per frame:
1. Call `mapVisuals.buildPerFrameState(timeline, project_time_ms, indexedRoute, clips, map_settings)` — the same function preview's ease loop calls. Returns `{ camera, sources, paints }`.
2. Apply per-frame source-data updates (`source.setData(...)` for `route-trail`, marker layer source, etc.) and paint property updates (`map.setPaintProperty(...)` for active-clip highlighting, marker pulse).
3. `map.render({...camera, width, height}, callback)`.
4. On callback, write 4-byte big-endian length prefix + raw RGBA bytes to stdout. Length always equals `w × h × 4`, but the prefix is included for protocol robustness against partial reads.

Recycle (sent every K frames by orchestrator):

```json
{"cmd":"recycle"}\n
```

Worker tears down + rebuilds the `Map` instance, re-applies the setup payload from cached state, replies `{"ready":true}\n`.

Shutdown:

```json
{"cmd":"shutdown"}\n
```

Worker releases the `Map`, exits 0.

stderr is reserved for diagnostic logging; the orchestrator forwards it to the Tauri app's log file. Render errors crash the worker with a non-zero exit; the orchestrator detects via process exit / broken pipe and surfaces a user-visible error.

### Rust → FFmpeg

```
ffmpeg \
  -f rawvideo -pix_fmt rgba -s {map_w}x{map_h} -r {fps} -i pipe:0 \
  -i {source_clip_0} -i {source_clip_1} ... \
  -filter_complex "{filtergraph derived from layout + channel}" \
  -c:v {selected_encoder} -movflags +faststart \
  {output_path}
```

The filtergraph is the layout's compiled output — see [`./LAYOUT.md`](./LAYOUT.md) for the per-channel composition rules. It's responsible for:

- Verifying orientation (`maplibre-native` returns top-down per the test, so no vflip; contract to confirm in the first task).
- **Channel A**: per-clip video chain (trim → setpts → focal-crop → scale to video slot dims), concat in clip order, overlay onto the map render stream at the video slot's rect with the layout's `corner_radius` alpha mask if PiP. Encode H.265 in `.mp4`.
- **Channel B**: overlay the map render stream onto a transparent canvas at the map slot's rect (with corner-radius alpha mask if applicable). Encode ProRes 4444 in `.mov` with alpha.
- **Channel C**: per-clip video chain (same as A), concat, overlay onto a transparent canvas at the video slot's rect (with corner-radius alpha mask if applicable). Encode ProRes 4444 in `.mov` with alpha.

## Performance considerations

The hands-on test of `@maplibre/maplibre-gl-native` rendered a 1080×1920 frame in ~2.0s cold and ~0.7–1.4s warm on M-series macOS. Naïvely that means a 60-second 30fps export takes ~30 minutes sequentially, ~3.75 minutes with 8 parallel workers — slow for a desktop export workflow. Several real-world factors should bring this down significantly:

**1. Render at the slot size, not the output size.** The map's render viewport is the layout's slot rect, not the output frame. Channel A typically places the map in a smaller slot — a 360×640 PiP corner is **1/9 the pixels** of full 1080×1920, and render time roughly tracks pixel count.

| Slot size | Pixels (relative) | Est. warm render |
|---|---|---|
| 1080×1920 (full bleed) | 1.0× | ~1.0s |
| 540×960 (half) | 0.25× | ~0.25s |
| 360×640 (PiP corner) | 0.11× | ~0.11s |
| 270×480 (small inset) | 0.06× | ~0.06s |

**2. Pre-warm tiles before the frame loop.** The test fetched tiles over the network during rendering. In production, walk the camera path once before frame rendering begins, fetch every tile we'll need at the relevant zoom levels into a local disk cache, then start the loop. Eliminates network round-trips during rendering.

**3. GPU acceleration via Metal (unverified).** maplibre-native supports Metal on macOS; the Node binding may default to CPU. If we can enable GPU rendering in the sidecar, we're potentially looking at a 5–10× additional speedup on top of the others. Worth measuring once we have a real harness.

**4. Frame deduplication for static cameras.** During clip spans where the camera intent is `point` (and not following a marker), the camera is fully static — render one frame, have FFmpeg duplicate it. Cuts rendering work meaningfully for typical hike videos.

### Realistic estimates (60s of video at 30fps)

| Scenario | Wall-clock |
|---|---|
| Channel A composite, PiP slot, all optimizations | Faster than real-time (~30–60s) |
| Channel A composite, half-bleed map | Roughly real-time |
| Channel B map-only, full resolution, CPU only | 2–4× real-time |
| Channel B map-only, full resolution, GPU enabled | Roughly real-time *(best guess)* |
| Worst case — full-res, no pre-warming, single worker | ~30 minutes |

The architecture supports all of the optimizations above without fundamental changes. We don't know the realistic numbers until we measure with optimizations applied; the test was a feasibility check, not a benchmark.

### Escape hatches if performance falls short

In increasing order of effort:

1. **Lower default export resolution** (720×1280 instead of 1080×1920) — most social platforms re-encode anyway, and it cuts pixels by ~2.25×.
2. **Background-render during editing** so export feels instant when the user hits the button.
3. **Two-tier quality** (Quick draft / High quality) with the user picking per export.
4. **Cloud rendering** as a future option — render on a beefy server, user uploads the project file.

None of these are needed if the optimizations work; they're insurance.

## Layout system

Layout, video-side effects pipeline, channel output formats, and audio rule are settled in [`./LAYOUT.md`](./LAYOUT.md). At a glance:

- Two layout modes for v1: **PiP** (free inset rect, `corner_radius` supported) and **Split** (free divider, orientation locked by aspect).
- Three output aspects: **9:16, 16:9, 4:5**, with fixed pixel dims per aspect.
- Layout configured **per project, per aspect**; per-clip layout-geometry overrides deferred to v2 (paired with animated transitions).
- **Channel A**: H.265 in `.mp4` (visually lossless deliverable).
- **Channels B and C**: ProRes 4444 in `.mov` with alpha (masked positional exports usable as compositing intermediates).
- Map render viewport = map slot dims (per layout, per channel); set once per export run.
- Per-clip video chain: trim → setpts (speed) → focal-crop (to slot aspect) → scale (to slot dims). Audio: source-passthrough with `atempo` for speed, no music in v1.

## Next tasks

With architecture and layout settled, the concrete task sequence to replace the superseded 600-series. Authored tasks live under [`./tasks/`](./tasks/); see the [task index](./tasks/README.md) for current status.

- **Task 010** — **Shared `mapVisuals` module + MapView refactor.** Foundational: extract every visual decision MapView makes (style spec per `map_style` mode, route layers, waypoint layers, live marker as a layer with project-time-driven pulse, slime-trail computation, active-clip highlighting) into a browser+Node-safe shared module. Refactor `MapView.tsx` to consume it. Both preview and the future export worker will import from this module — that's how the "single source of visual truth" invariant is enforced structurally rather than by discipline.
- Task 020 — Renderer worker (Node + maplibre-native + stdio protocol). Imports from `mapVisuals`; built from TS via esbuild.
- Task 030 — Rust orchestrator skeleton (spawn + frame distribution + ordering).
- Task 040 — Encoder probing + selection (H.264/H.265 hardware path; confirm ProRes 4444 software encoding performance).
- Task 050 — Layout descriptor types in TS + Rust; project-schema migration to add per-aspect layout storage.
- Task 060 — Channel B (map-only) end-to-end — simplest, validates the core pipeline plus the masked-positional export path.
- Task 070 — Channel C (video-only) end-to-end — validates the per-clip video filter chain plus the masked-positional export path.
- Task 080 — First concrete layout (9:16 PiP-bottom-right baseline) for the configurator.
- Task 090 — Channel A (composite) end-to-end at one layout.
- Task 100 — Additional layouts + aspects (Split mode; 16:9 and 4:5 layouts).
- Task 110 — Layout configurator UI (drag, snap, swap, corner-radius) — a UI design pass precedes implementation.
- Task 120 — Render parity verification (replaces the original 640) — sample random `t` values, compare a worker-rendered frame against a preview-rendered frame at the same `t` and slot viewport. Visual parity is the gate, not just camera parity.
- Task 130 — Sidecar bundling + Windows distribution.

Effort estimates land as each task is authored.
