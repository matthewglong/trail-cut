# TrailCut — Claude Code Context

## What this is
macOS desktop app (Tauri 2) for turning iPhone hiking videos + GPS routes into polished map-integrated social media videos. See ARCHITECTURE.md for full design.

## Tech stack
- **Frontend**: React + TypeScript + Vite
- **Backend**: Rust (Tauri 2 commands)
- **Map**: MapLibre GL JS + OpenFreeMap tiles
- **Video processing**: FFmpeg (CLI, proxy generation + thumbnails)
- **Metadata**: ExifTool (CLI, called from Rust — uses `CreationDate` field for accurate iPhone timestamps)
- **GPX parsing**: roxmltree (Rust)

## Project structure
```
src/                    # React frontend
  App.tsx               # Main app shell — home screen, project view, import/export, auto-save
  types.ts              # TypeScript types matching Rust models
  components/
    Timeline.tsx        # Horizontal clip strip with thumbnails (bottom)
    VideoPreview.tsx    # HTML5 video player with controls
    MapView.tsx         # MapLibre map with markers + route
    EditToolbar/        # Per-clip edit controls (zoom, speed, crop preview)
    CollapsibleToolbar.tsx # Shared collapsible toolbar shell
src-tauri/              # Rust backend
  src/
    main.rs             # Entry point
    lib.rs              # Tauri builder, registers commands
    models.rs           # Data types (Clip, Route, Project, RecentProject, etc.)
    commands.rs         # Tauri commands (see below)
  tauri.conf.json       # Tauri config (asset protocol enabled, scope: $HOME/**)
  capabilities/         # Tauri permission capabilities
  icons/                # App icons (placeholder)
```

## Rust backend commands
- `scan_directory(path)` — scan folder for video files, extract metadata via ExifTool
- `import_media(paths)` — accepts any mix of files and directories, extracts videos and metadata
- `create_project(project_dir)` — create project bundle directory structure
- `parse_gpx(file_path, project_dir?)` — parse GPX, optionally copy into bundle
- `save_project(project, project_dir)` / `load_project(project_dir)` — JSON project persistence
- `generate_proxy(source_path, project_dir)` — 720p H.264 proxy in bundle
- `generate_thumbnail(source_path, project_dir)` — thumbnail JPG in bundle
- `get_recent_projects()` / `register_recent_project(project_dir)` — project registry in `~/.trailcut/recent.json`

## Project bundle format
Projects are self-contained directories with `.trailcut` extension:
```
MyHike.trailcut/
  project.json          # clip metadata, route, export configs
  proxies/              # 720p proxy videos (hash-based filenames)
  thumbnails/           # thumbnail JPGs
  route.gpx             # copied GPS data (if imported)
```
Source videos are linked (absolute paths), not copied into the bundle.

## Dev commands
- `npm run tauri dev` — run in dev mode with hot reload
- `npm run tauri build --debug` — build debug .app bundle
- First Rust compile is slow (~2 min); subsequent builds are incremental

## Dependencies to have installed
- Rust (via rustup)
- Node.js (v22+)
- Xcode CLI tools
- FFmpeg (`brew install ffmpeg`)
- ExifTool (`brew install exiftool`)

## Phase status
- **Phase 1 (Foundation)**: COMPLETE — file/folder import via ExifTool, chronological timeline, MapLibre map with clip markers, GPX route drawing, project bundle save/load, home screen with project gallery. Only missing: drag-and-drop import (low priority).
- **Phase 2 (Editing)**: COMPLETE
  - Done: proxy generation, video preview player, clip removal, trim UI (in/out handles on seek bar + numeric inputs), focal point UI (draggable crosshair + 9:16 crop preview), speed adjustment (0.25x–4x slider + playbackRate), edit state persistence (Clip[] throughout, survives save/load)
  - Deferred: stabilization (vidstab) pushed to Phase 4 — requires FFmpeg two-pass, not real-time previewable
  - Deferred: color grading — to be designed properly with WebGL preview + full slider set + histogram in a later phase
- **Phase 3 (Export)**: NOT STARTED — map frame rendering, FFmpeg compositing, layout configurator
- **Phase 4 (Polish)**: NOT STARTED — color grading, audio, map styles, batch export, undo/redo, performance, stabilization, sidecar bundling of FFmpeg/ExifTool

## App flow
1. **Home screen**: "New Project" button + "Open Project" button + project gallery (all known projects from `~/.trailcut/recent.json`, filtered to still-existing bundles)
2. **Project view**: toolbar (Import Media dropdown, Import GPX), 3-pane layout (clip info | video preview | map), timeline strip at bottom
3. **Import Media**: dropdown with "Select Files" and "Select Folder" — both feed into `import_media` which handles any mix of files/directories
4. **Auto-save**: debounced 1s save to `project.json` on any clip/route change

## Key design decisions
- **CreationDate over CreateDate**: ExifTool's `CreationDate` field has the actual iPhone filming timestamp with timezone. `CreateDate`/`MediaCreateDate` can be corrupted by AirDrop/file transfers. Fallback chain: CreationDate → CreateDate → MediaCreateDate.
- **Project bundles**: self-contained `.trailcut` directories with proxies/thumbnails inside (not a global cache). Each project is independent.
- **No media copying**: app stores absolute paths to source videos, reads originals only at export time
- **Auto-ordering by timestamp**: clips sorted by CreationDate, no manual reordering
- **Import merges**: re-importing same files updates metadata (e.g. fixes timestamps), new files merge into correct chronological position, dedup by path
- **Map transitions ARE the transitions**: transitions between clips are driven by geography, not a separate editing concept
- **Proxy-based preview**: 720p H.264 proxies for smooth playback, CSS/browser-based effect preview on top, FFmpeg for real processing at export
- **Asset protocol**: Tauri `protocol-asset` feature with `$HOME/**` scope serves local files to webview via `convertFileSrc`
- **Stabilization deferred**: vidstab requires FFmpeg two-pass (not real-time), deferred to later phase as non-essential for MVP
