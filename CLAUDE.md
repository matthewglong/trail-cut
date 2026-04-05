# TrailCut — Claude Code Context

## What this is
macOS desktop app (Tauri 2) for turning iPhone hiking videos + GPS routes into polished map-integrated social media videos. See ARCHITECTURE.md for full design.

## Tech stack
- **Frontend**: React + TypeScript + Vite
- **Backend**: Rust (Tauri 2 commands)
- **Map**: MapLibre GL JS + OpenFreeMap tiles
- **Video processing**: FFmpeg (CLI, not yet integrated)
- **Metadata**: ExifTool (CLI, called from Rust)
- **GPX parsing**: roxmltree (Rust)

## Project structure
```
src/                    # React frontend
  App.tsx               # Main app shell — toolbar, split pane layout
  types.ts              # TypeScript types matching Rust models
  components/
    Timeline.tsx        # Horizontal clip strip (bottom)
    MapView.tsx         # MapLibre map with markers + route (right pane)
    ClipInfo.tsx        # Clip metadata panel (left pane)
src-tauri/              # Rust backend
  src/
    main.rs             # Entry point
    lib.rs              # Tauri builder, registers commands
    models.rs           # Data types (Clip, Route, Project, etc.)
    commands.rs         # Tauri commands (scan_directory, parse_gpx, save/load project)
  tauri.conf.json       # Tauri config
  capabilities/         # Tauri permission capabilities
  icons/                # App icons (placeholder)
```

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
- **Phase 1 (Foundation)**: COMPLETE — folder import via ExifTool, chronological timeline, MapLibre map with clip markers, GPX route drawing, project save/load
- **Phase 2 (Editing)**: NOT STARTED — video preview with proxies, trim UI, focal point, stabilization, color grading, speed adjustment
- **Phase 3 (Export)**: NOT STARTED — map frame rendering, FFmpeg compositing, layout configurator
- **Phase 4 (Polish)**: NOT STARTED — audio, map styles, batch export, undo/redo, performance

## Key design decisions
- ExifTool called directly (not bundled as sidecar yet) — works for dev, sidecar bundling is Phase 4
- No media copying — app stores file paths, reads originals only at export time
- Auto-ordering by timestamp, no manual reordering
- Map transitions ARE the transitions between clips (geography-driven)
- All state lives in project JSON file; Rust backend is stateless
