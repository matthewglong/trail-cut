# TrailCut — Claude Code Context

## What this is
Cross-platform desktop app (Tauri 2) for turning iPhone hiking videos + GPS routes into polished map-integrated social media videos. Ships to thousands of end users; **macOS is the current ship target, Windows is near-term**. Matthew is the developer, not the end user — "fix your environment" answers are dev-only stopgaps, never product solutions. See `docs/CANON.md` for the living decision canon, ARCHITECTURE.md for the founding design, and the design docs listed below.

## Ship-review execution (check before starting work)
- **Progress tracker: `docs/ship-review/PROGRESS.md`** — cross-session state for the ship-review execution (plan: `docs/ship-review/ACTION_PLAN.md`, findings: `SHIP_REVIEW.md`). Read it at session start to pick up where the last session left off; update it whenever a phase advances or a decision lands.
- **`attic/` is quarantined cruft** — preserved (never deleted), gitignored, and deny-listed in `.claude/settings.json`. Never read, search, cite, or restore from it.

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
                           #   MarkerSection (preset + image marker gallery), DecorationPanel (Route / Waypoints / POV / Transition)
    WaypointsPanel/        # Waypoint decoration UI
    LayoutConfigurator/    # Split-layout (map+video) configurator
    LayoutPreview/         # Layout preview rendering
    MapPositioningModal/   # Map framing / camera positioning
    ExportModal/           # Export grid (aspect × channel cells/chips), config modal, queue view
  lib/
    mapVisuals/            # SINGLE SOURCE OF TRUTH for map rendering (see contract below)
                           #   styleSpec.ts (resolveStaticPaints), perFrame.ts (buildPerFrameState),
                           #   paints.ts, shapes.ts, markerImage.ts, sources.ts, animations.ts, types.ts
    layout.ts, cameraIntent.ts, routeLocation.ts, waypoints.ts, markerLibrary.ts,
    exportRequest.ts, exportEstimate.ts, exportFilenames.ts, sourceFormat.ts, livePlayhead.ts
  hooks/                   # useProject, useMediaImport, useExportQueue, etc.
  theme/                   # tokens.ts, common.ts
  shortcuts/               # keyboard shortcut catalog + editor hook
src-tauri/                 # Rust backend
  src/
    main.rs                # Entry point
    lib.rs                 # Tauri builder, registers commands
    models.rs              # Data types (Clip, Route, Project, MapSettings, etc.); CURRENT_SCHEMA_VERSION = 11
    commands/              # Tauri commands, one module per area:
                           #   media, project, recent, gpx, ffmpeg, encoder, camera_presets, image
    export/                # Export pipeline: orchestrator, clip_chain, filtergraph, layout,
                           #   resolution, delivery, encoder, ffmpeg_sink/runner, corner_mask,
                           #   protocol (sidecar IPC), ffprobe, sink, error
    util/                  # color, color_space (atomic color-space registry — see docs/CANON.md),
                           #   log_detection, hash, exiftool, fs
  sidecars/renderer/       # Headless MapLibre export renderer (TS → bundled .cjs), shares mapVisuals
  tauri.conf.json          # asset protocol enabled, scope: $HOME/**
  capabilities/            # Tauri permission capabilities
```

## Rust backend commands (registered in `lib.rs`)
- **Import / scan**: `scan_directory`, `import_media` (any mix of files/dirs)
- **Project lifecycle**: `create_project`, `save_project` / `load_project` (JSON, with v1→v11 migration chain), `rename_project`, `duplicate_project` (sibling `<Name> copy.trailcut` clone, re-roots the absolute `thumbnail` path, registers in recents), `delete_project`
- **GPX**: `parse_gpx` (optionally copies into bundle)
- **Marker-image library**: `import_marker_image` (validates + copies original into `assets/`), `save_marker_icon` (persists the webview-baked render PNG, authoritative dims), `delete_marker_image` (removes both assets; frontend reverts all uses first)
- **Proxies / thumbnails**: `generate_proxy`, `regenerate_proxy_for_class`, `generate_thumbnail`, `generate_thumbnail_at`
- **Recents**: `get_recent_projects`, `register_recent_project` (registry in `~/.trailcut/recent.json`)
- **Export**: `render_export`, `resolve_output_dir`, `probe_encoders`
- **Camera presets**: `get_camera_presets`, `set_camera_preset`, `remove_camera_preset`

## Project bundle format
Self-contained directories with `.trailcut` extension:
```
MyHike.trailcut/
  project.json          # schema-versioned (currently v11): clips, route, MapSettings, export grid/configs
  proxies/              # 720p proxy videos (hash-based filenames)
  thumbnails/           # thumbnail JPGs
  assets/               # marker-library images (marker-source-<hash>.<ext> original + marker-icon-<hash>.png baked render asset; legacy v10 pov-* names still valid)
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
- **FFmpeg built with zscale/libzimg** (`brew install ffmpeg-full`, then `brew link ffmpeg-full` — the plain core `ffmpeg` bottle has NO libzimg, proven by CI run 27385616028) — the color pipeline requires zscale at every ingest path; the color test suite fails loudly without it (`assert_ffmpeg_has_zscale` in `src-tauri/tests/color_fixtures.rs`)
- ExifTool (`brew install exiftool`)

## Phase status
- **Phase 1 (Foundation)**: COMPLETE — import via ExifTool, chronological timeline, MapLibre map, GPX route, bundle save/load, home gallery. Missing only: drag-and-drop import (low priority).
- **Phase 2 (Editing)**: COMPLETE — proxy generation, preview player, clip removal, trim UI, focal-point crop, speed adjustment, edit-state persistence.
- **Phase 3 (Export)**: IN PROGRESS / largely landed — FFmpeg compositing pipeline (`src-tauri/src/export/`), headless map-frame renderer sidecar, split-layout configurator, export-modal redesign (aspect × channel grid + queue), multi-target delivery — `SdrH264`, `SdrH265`, `HdrHlg`, `HdrPq`, `ProresAlpha` all shipped. The HDR reference-white port landed 2026-06-11 (×2.03 SDR-origin anchor, npl=100 absolute working space, HDR composite headroom, HQ chroma subsample — `docs/CANON.md` §1.12). Remaining active work: see `docs/CANON.md` open items (HDR→SDR tone-map follow-up, task 120 parity gate).
- **Phase 4 (Polish)**: PARTIAL — map decorations (Route/Waypoints/POV with gradients + shapes) done; color grading underway (`util/color.rs`, `util/log_detection.rs`). Remaining: audio, additional map styles, undo/redo, performance, stabilization (vidstab two-pass), sidecar bundling of FFmpeg/ExifTool/renderer.

## Design docs (read before touching these areas)
- **`docs/CANON.md` — the living decision canon.** Every still-binding decision from the retired root pipeline docs lives here (DECIDED/BINDING/OPEN/REJECTED, with code citations). For DECIDED items the cited code is the authority. The old root PIPELINE_* / COLOR_PIPELINE_SPEC / UNIVERSAL_WORKING_SPACE_REPORT docs are quarantined in `attic/` — never reference them as live.
- **Color authority**: `src-tauri/src/util/color_space.rs` (atomic-axes registry) + `docs/color-pipeline/` + `docs/CANON.md` §1.
- `ARCHITECTURE.md` — founding design (Apr 2026; product decisions bind, tech sections largely superseded — cross-check against code)
- `MAP_RENDERING_PLAN.md` — map-rendering "lever model" (cssViewport tracks slot shape, pixelRatio absorbs resolution) for preview/export parity; implemented, kept as the record (SSAA extension recorded in `docs/CANON.md` §2.2)
- `EXPORT_REDESIGN_HANDOFF.md` / `EXPORT_GAPS.md` — export-modal redesign + deliberate scope cuts (EXPORT_GAPS.md is the live gap registry)
- `docs/spikes/` — rescued spike docs (HDR port build spec, native-gl jitter findings)

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
- **mapVisuals single-source-of-truth contract**: anything derivable from `MapSettings` flows through `resolveStaticPaints` / `buildPerFrameState` in `src/lib/mapVisuals/`. Both `MapView.tsx` (preview) and the renderer sidecar apply the same returned tuples — never write an ad-hoc `setPaintProperty`/`setLayoutProperty` in `MapView` for `MapSettings`-derived state, or preview and export silently diverge. Zoom + decoration sizes are denominated in the **reference space** (canonical 1080p-class css frame; exports render it verbatim); the preview displays it at the fixed `previewDisplayScale(aspect, screen)` factor via the resolvers' `surfaceScale` parameter — never at raw pane pixels (`docs/CANON.md` §2.6).
- **Map decorations are independent**: Route / Waypoints / POV each own their color/gradient config (no shared palette); linking is a one-shot copy button, not a binding. Route + Waypoints support gradient (by trail distance); POV is solid-only (single point). **Everything is per-clip overridable** (`MapOverrides` — route color/halo, waypoint colors/marker/halo, all POV fields; full capability parity incl. gradients; object-valued leaves diff via deep-equal comparators in `src/types.ts`); the only project-pinned MapSettings field is the marker-image LIBRARY (`MapSettings.marker_images`) — one shared project-level list, both tools show every upload, SELECTION stays independent per decoration. Per-Waypoint entity overrides (solid-only) still win per feature over clip-level values. Each decoration also owns an optional **halo** block (`route.halo` / `waypoints.halo` / `pov.halo`, additive — no schema bump): color (gradient where the decoration supports it; POV solid-only) / spread / fade / falloff / opacity / offset X-Y. Falloff renders via a second fully-feathered `*-halo-core` layer (opacity redistribution — `HALO_FALLOFF_*` in `styleSpec.ts`); offsets are viewport-anchored `*-translate` px (drop-shadow direction fixed on screen). Halo self-overlap (out-and-back retraces, GPS-jitter sunbursts) is solved by **engine-level group-opacity compositing** on BOTH engines (`docs/CANON.md` §2.7): `haloGroupPolicy` in mapVisuals emits in-FBO opacities + a `haloComposites` bucket that consumers MUST apply via `map.setGroupComposite` (native patch 3 for export, `patches/maplibre-gl+*.patch` for preview — the two patches ship together; consumers fail loud on a missing capability). **Transition** is a fourth top-level decoration (`MapSettings.transition { travel?, ease_in?, ease_out? }`, additive — no schema bump; atomic per-clip override blob `MapOverrides.transition`) owning everything that happens to the playhead at clip seams, as three stacking layers. `travel { enabled, show_playhead?, sync?, playhead?, draw_route? }` (destination clip governs the seam INTO it): the traveling playhead runs along the route across the transition window (camera arc unchanged; zero added frames); playhead visibility and route drawing are independent toggles (`draw_route` force-shows the trail even when route mode is 'none'); `sync` (default) dresses the traveling playhead in the destination clip's full resolved POV look for the whole window, unsync exposes `travel.playhead`, a full PovSettings-shaped custom style. `ease_in`/`ease_out` (`{ style: pop|fade|grow, speed }`, absent = jump): pure scale/opacity envelopes over the whole marker stack with FIXED per-phase durations, anchored at the cut on jump seams, at the style-swap window edges on traveled seams, plus project start/end — the source clip's `ease_out` and destination's `ease_in` govern each seam. Mechanism + invariants in `docs/CANON.md` §2.9 (`povStyleTuples` shared static/per-frame; `seamEnvelopeAt` in animations.ts; `PerFrameState.povPaints`/`haloComposites` buckets).
- **Marker library (schema v11)**: both decorations pick their marker from a preset gallery + a shared upload library. Waypoints: the 5 shapes or a library image (`waypoints.marker_image_id`; per-waypoint override on `Waypoint.shape`/`Waypoint.marker_image_id`, mutually exclusive). POV: dot + pov-domain shapes (ring/square/diamond, SDF `pov-<shape>-*` icons tinted by POV colors) or a library image, via `pov.marker` (`{kind:'shape'|'image'}`), per-clip overridable through `map_overrides.pov.marker` (deep-equal diffed — first object-valued override leaf); the pulse applies to every marker kind, and the default dot keeps the original circle layer for pixel parity. Bake-once-consume-twice: the webview canvas rasterizes/normalizes each upload into `assets/marker-icon-<hash>.png` (≤1024 texels, sRGB) at import; preview (browser decode) and the export sidecar (pngjs) both resample that ONE master through `mapVisuals/markerImage.ts` → `map.addImage('marker-image-<id>', …, {sdf:false})`. Image markers render on dedicated non-SDF symbol layers (`waypoints-image`, `live-marker-image`) with transparent placeholders on the SDF side — MapLibre cannot mix SDF and non-SDF icons in one layer. Sizes are reference-space (POV `pov.size.image_size`; waypoints display images at the shape diameter `2×circle_radius`). The renderer never learns the bundle dir — `buildExportRequest` injects transient absolute `path`s on every library entry; the sidecar registers only REFERENCED ids and fails loud on missing ones. Deleting a library image (right-click tile → confirm) reverts every use via `lib/markerLibrary.ts` then removes the assets.
- **Perceived-scale invariance**: same route + export settings must look the same apparent scale across aspect ratios and resolutions — aspect changes shape/visible-area only, resolution changes pixel density only. Scoped by the per-aspect **map magnification** lever (`docs/CANON.md` §2.8): invariance holds at default `k = 1.0`; a non-default `k` (range 0.5–2.0, MapPositioningModal per-tile stepper) is an explicit per-aspect creative choice that magnifies the whole map render (basemap + decorations + world scale) relative to the frame.
- **HDR is first-class and CURRENT**: `HdrHlg` and `HdrPq` delivery are shipped today, co-equal with SDR — never reason from an SDR default. Pipeline decisions must keep BT.2020 working-space primaries; SDR-only simplifications are off the table (see `docs/CANON.md` §1.9/§5.2).
- **Asset protocol**: Tauri `protocol-asset` with `$HOME/**` scope serves local files to the webview via `convertFileSrc`.
- **Stabilization deferred**: vidstab requires FFmpeg two-pass (not real-time previewable).
