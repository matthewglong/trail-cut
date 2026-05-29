# TrailCut — Claude Code Context

## What this is
Cross-platform desktop app (Tauri 2) for turning iPhone hiking videos + GPS routes into polished map-integrated social media videos. Ships to thousands of end users; **macOS is the current ship target, Windows is near-term**. Matthew is the developer, not the end user — "fix your environment" answers are dev-only stopgaps, never product solutions. See ARCHITECTURE.md for full design, and the pipeline/export design docs below for active decisions.

## Tech stack
- **Frontend**: React + TypeScript + Vite (test runner: Vitest)
- **Backend**: Rust (Tauri 2 commands)
- **Map**: MapLibre GL JS + OpenFreeMap tiles
- **Export map renderer**: headless MapLibre in a Node sidecar (`src-tauri/sidecars/renderer/`), driven over a stdio protocol — renders the same map frames the preview shows, for compositing into the export
- **Video processing**: FFmpeg (CLI — proxy/thumbnail generation AND the full export filtergraph/compositing pipeline)
- **Metadata**: ExifTool (CLI, called from Rust — uses `CreationDate` field for accurate iPhone timestamps)
- **GPX parsing**: roxmltree (Rust)

> External CLI deps (ffmpeg, ffprobe, exiftool) are currently resolved via `PATH` (`Command::new("ffmpeg")`). Sidecar bundling is deferred (tracked as "task 130") but **required before ship** — see `src/util` / `commands/encoder.rs` notes.

## Project structure
```
src/                       # React frontend
  App.tsx                  # Thin shell — routes between home and project screens, auto-save
  types.ts                 # TypeScript types matching Rust models
  screens/
    HomeScreen.tsx         # Project gallery + new/open
    ProjectView.tsx        # 3-pane editor (clip info | preview | map) + timeline
  components/
    Timeline/              # Horizontal clip strip with thumbnails
    VideoPreview/          # HTML5 video player with controls
    MapView.tsx            # Live MapLibre preview (applies mapVisuals tuples — see contract below)
    EditToolbar/           # Per-clip edit controls (zoom, speed, crop preview)
    MapToolbar/            # Map decoration control panel — ColorSection (+ GradientEditor),
                           #   ShapeSection, DecorationPanel (Route / Waypoints / POV)
    WaypointsPanel/        # Waypoint decoration UI
    LayoutConfigurator/    # Split-layout (map+video) configurator
    LayoutPreview/         # Layout preview rendering
    MapPositioningModal/   # Map framing / camera positioning
    ExportModal/           # Export grid (aspect × channel cells/chips), config modal, queue view
  lib/
    mapVisuals/            # SINGLE SOURCE OF TRUTH for map rendering (see contract below)
                           #   styleSpec.ts (resolveStaticPaints), perFrame.ts (buildPerFrameState),
                           #   paints.ts, shapes.ts, sources.ts, animations.ts, types.ts
    layout.ts, cameraIntent.ts, routeLocation.ts, waypoints.ts,
    exportRequest.ts, exportEstimate.ts, exportFilenames.ts, sourceFormat.ts, livePlayhead.ts
  hooks/                   # useProject, useMediaImport, useExportQueue, etc.
  theme/                   # tokens.ts, common.ts
  shortcuts/               # keyboard shortcut catalog + editor hook
src-tauri/                 # Rust backend
  src/
    main.rs                # Entry point
    lib.rs                 # Tauri builder, registers commands
    models.rs              # Data types (Clip, Route, Project, MapSettings, etc.); CURRENT_SCHEMA_VERSION = 8
    commands/              # Tauri commands, one module per area:
                           #   media, project, recent, gpx, ffmpeg, encoder, camera_presets
    export/                # Export pipeline: orchestrator, clip_chain, filtergraph, layout,
                           #   resolution, delivery, encoder, ffmpeg_sink/runner, corner_mask,
                           #   protocol (sidecar IPC), ffprobe, sink, error
    util/                  # color, log_detection, hash, exiftool, fs
  sidecars/renderer/       # Headless MapLibre export renderer (TS → bundled .cjs), shares mapVisuals
  tauri.conf.json          # asset protocol enabled, scope: $HOME/**
  capabilities/            # Tauri permission capabilities
```

## Rust backend commands (registered in `lib.rs`)
- **Import / scan**: `scan_directory`, `import_media` (any mix of files/dirs)
- **Project lifecycle**: `create_project`, `save_project` / `load_project` (JSON, with v1→v8 migration chain), `rename_project`, `delete_project`
- **GPX**: `parse_gpx` (optionally copies into bundle)
- **Proxies / thumbnails**: `generate_proxy`, `regenerate_proxy_for_class`, `generate_thumbnail`, `generate_thumbnail_at`
- **Recents**: `get_recent_projects`, `register_recent_project` (registry in `~/.trailcut/recent.json`)
- **Export**: `render_export`, `resolve_output_dir`, `probe_encoders`
- **Camera presets**: `get_camera_presets`, `set_camera_preset`, `remove_camera_preset`

## Project bundle format
Self-contained directories with `.trailcut` extension:
```
MyHike.trailcut/
  project.json          # schema-versioned (currently v8): clips, route, MapSettings, export grid/configs
  proxies/              # 720p proxy videos (hash-based filenames)
  thumbnails/           # thumbnail JPGs
  route.gpx             # copied GPS data (if imported)
```
Source videos are linked (absolute paths), not copied. `project.json` is schema-versioned (`CURRENT_SCHEMA_VERSION` in `models.rs`); `load_project` runs the migration chain (`migrate_vN_to_vN+1` in `commands/project.rs`). Known migration scope cuts are tracked in `EXPORT_GAPS.md`.

## Dev commands
- `npm run tauri dev` — run in dev mode with hot reload
- `npm run tauri build --debug` — build debug .app bundle
- `npm run test:run` — frontend Vitest suite; `cargo test` (in `src-tauri/`) for Rust
- First Rust compile is slow (~2 min); subsequent builds are incremental

## Dependencies to have installed
- Rust (via rustup), Node.js (v22+), Xcode CLI tools
- **FFmpeg built with zscale/libzimg** (`brew install ffmpeg`) — the color pipeline requires zscale at every ingest path; the color test suite fails loudly without it (`assert_ffmpeg_has_zscale` in `src-tauri/tests/color_fixtures.rs`)
- ExifTool (`brew install exiftool`)

## Phase status
- **Phase 1 (Foundation)**: COMPLETE — import via ExifTool, chronological timeline, MapLibre map, GPX route, bundle save/load, home gallery. Missing only: drag-and-drop import (low priority).
- **Phase 2 (Editing)**: COMPLETE — proxy generation, preview player, clip removal, trim UI, focal-point crop, speed adjustment, edit-state persistence.
- **Phase 3 (Export)**: IN PROGRESS / largely landed — FFmpeg compositing pipeline (`src-tauri/src/export/`), headless map-frame renderer sidecar, split-layout configurator, export-modal redesign (aspect × channel grid + queue), multi-target delivery (incl. `HdrHlg`). Active work: map-export color/sharpness parity (see pipeline docs), control-panel polish (current branch `feat/control-panel`: decoration colors, shapes, tear-away controls).
- **Phase 4 (Polish)**: PARTIAL — map decorations (Route/Waypoints/POV with gradients + shapes) done; color grading underway (`util/color.rs`, `util/log_detection.rs`). Remaining: audio, additional map styles, undo/redo, performance, stabilization (vidstab two-pass), sidecar bundling of FFmpeg/ExifTool/renderer.

## Design docs (read before touching these areas)
- `ARCHITECTURE.md` — overall design
- `MAP_RENDERING_PLAN.md` — map-rendering "lever model" (cssViewport tracks slot shape, pixelRatio absorbs resolution) for preview/export parity
- `PIPELINE_RESEARCH.md` / `PIPELINE_DECISIONS.md` / `PIPELINE_TEACHING_HANDOFF.md` — color-pipeline research, ACCEPT/REJECT/DEFER decisions
- `EXPORT_REDESIGN_HANDOFF.md` / `EXPORT_GAPS.md` — export-modal redesign + deliberate scope cuts

## App flow
1. **Home screen**: New Project / Open Project + project gallery (from `~/.trailcut/recent.json`, filtered to existing bundles)
2. **Project view**: toolbar (Import Media, Import GPX), 3-pane layout (clip info | video preview | map) + map control panel, timeline strip at bottom
3. **Import Media**: "Select Files" / "Select Folder" → `import_media` (handles any mix)
4. **Auto-save**: debounced ~1s save to `project.json` on any clip/route/settings change
5. **Export**: configure an aspect × channel grid of jobs, render via FFmpeg + the map-renderer sidecar

## Key design decisions
- **CreationDate over CreateDate**: ExifTool's `CreationDate` has the actual iPhone filming timestamp with timezone; `CreateDate`/`MediaCreateDate` can be corrupted by transfers. Fallback chain: CreationDate → CreateDate → MediaCreateDate.
- **Project bundles**: self-contained `.trailcut` dirs (proxies/thumbnails inside, not a global cache). Each independent.
- **No media copying**: store absolute paths to sources; read originals only at export.
- **Auto-ordering by timestamp**: clips sorted by CreationDate, no manual reordering.
- **Import merges**: re-importing updates metadata, new files merge chronologically, dedup by path.
- **Map transitions ARE the transitions**: transitions between clips are driven by geography, not a separate editing concept.
- **Proxy-based preview**: 720p H.264 proxies + CSS/browser effect preview; FFmpeg for real processing at export.
- **mapVisuals single-source-of-truth contract**: anything derivable from `MapSettings` flows through `resolveStaticPaints` / `buildPerFrameState` in `src/lib/mapVisuals/`. Both `MapView.tsx` (preview) and the renderer sidecar apply the same returned tuples — never write an ad-hoc `setPaintProperty`/`setLayoutProperty` in `MapView` for `MapSettings`-derived state, or preview and export silently diverge.
- **Map decorations are independent**: Route / Waypoints / POV each own their color/gradient config (no shared palette); linking is a one-shot copy button, not a binding. Route + Waypoints support gradient (by trail distance); per-clip waypoint overrides and POV are solid-only.
- **Perceived-scale invariance**: same route + export settings must look the same apparent scale across aspect ratios and resolutions — aspect changes shape/visible-area only, resolution changes pixel density only.
- **HDR is first-class**: `HdrHlg` delivery is near-term; pipeline decisions must keep BT.2020 working-space primaries. SDR-only simplifications are off the table.
- **Asset protocol**: Tauri `protocol-asset` with `$HOME/**` scope serves local files to the webview via `convertFileSrc`.
- **Stabilization deferred**: vidstab requires FFmpeg two-pass (not real-time previewable).
