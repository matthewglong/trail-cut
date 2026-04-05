# TrailCut — Architecture & Implementation Guide

## What this is

TrailCut is a macOS desktop application for turning a collection of iPhone hiking videos + an optional GPS route recording (Strava/Garmin) into polished, map-integrated video content for social media. It is NOT a general-purpose video editor — it is purpose-built for the workflow of: hike → film clips → export a video that shows both the footage and an animated map of the journey.

## Core user workflow

1. **Import**: User points at a folder of iPhone videos (or drags them in). Optionally imports a GPX/FIT file from Strava or Garmin.
2. **Auto-timeline**: Clips are automatically sorted by creation timestamp. No manual ordering.
3. **Edit**: User trims clips (in/out points), sets a focal point per clip (for cropping), applies effects (stabilization, color grading, speed adjustment).
4. **Preview**: Split-pane UI shows video preview on one side, animated map on the other. Map shows clip locations, and when a GPX route is loaded, the full recorded path.
5. **Configure export**: User selects aspect ratio (9:16 vertical, 16:9 landscape, 1:1 square), map position/size, and whether the map is always visible or only during transitions.
6. **Export**: App renders map animations frame-by-frame, composites with processed video via FFmpeg, outputs final video file.

## Key design decisions and rationale

### No media copying until export
The app stores file paths in the project file, not copies of the media. During editing, it works with lightweight proxy thumbnails/previews. Original files are only read by FFmpeg at export time. This keeps the app fast and avoids doubling storage usage.

### Auto-ordering by timestamp
Since these are hiking clips filmed over a single outing, chronological order IS the correct order. There is no need for drag-and-drop reordering in V1. The creation timestamp from ExifTool determines sequence.

### Focal point per clip
Each clip has an (x, y) percentage pair (default: 0.5, 0.5 = center). This is the anchor point around which the frame is cropped when converting from the source aspect ratio (typically 16:9 landscape from iPhone) to the export aspect ratio. For vertical 9:16 export, a huge portion of the landscape frame is cut — the focal point determines WHICH portion survives. The UI shows a draggable crosshair over the video frame with a live crop preview.

### Map transitions ARE the transitions
When clip A ends and clip B begins, the "transition" is the map animating between those two geographic points. If a GPX route is available, the map progressively draws the route segment connecting them. If not, the map does a smooth camera fly between GPS points. The video side can optionally crossfade (FFmpeg xfade filter). This means transitions emerge from geography rather than being a separate editing concept.

### Timestamp-based synchronization when GPX is available
GPX/FIT files from Strava/Garmin contain trackpoints with lat/lng every 1-3 seconds with high GPS accuracy. Each video clip's creation timestamp maps to a position on this timeline. This is far more accurate than iPhone video embedded GPS (which is a single point per clip, less precise). Without GPX, the app falls back to the video's embedded GPS coordinates.

### Layout is user-configurable per export
Rather than fixed templates, the export configurator lets the user define:
- What percentage of the frame is video vs. map
- Where the map sits (top/bottom/left/right/overlay/PIP)
- Whether the map is always visible or only during transitions between clips
- Default for vertical: 60% video top, 40% map bottom (split screen)
- Default for landscape: 65% video left, 35% map right (side-by-side)
- The user can override these defaults freely

### Quality-first map rendering for export
For the editing UI, MapLibre GL JS renders the map live in the webview — fast and interactive. For export, we need pixel-perfect frames. The approach: spin up a hidden/offscreen WebView, programmatically drive MapLibre through the exact animation sequence (camera positions, route drawing progress, markers), capture each frame as a PNG, and pipe the image sequence to FFmpeg for compositing. This is slower than real-time but produces beautiful results.

---

## Tech stack

### Application shell: Tauri 2.x
- **Why**: Native macOS app with tiny footprint (~10MB installer, ~30-50MB RAM). Uses WKWebView on Mac, which is excellent. Rust backend handles file system access, process orchestration (FFmpeg, ExifTool), and heavy lifting. Web frontend handles all UI.
- **Frontend framework**: React + TypeScript
- **Build tool**: Vite

### Map rendering: MapLibre GL JS
- **Why**: Open-source fork of Mapbox GL JS. GPU-accelerated WebGL rendering at 60fps. Supports smooth animations, 3D terrain, route drawing, custom styling. BSD-3 license.
- **Tile provider**: OpenFreeMap (https://tiles.openfreemap.org/styles/liberty). Completely free, no API key, no registration, no usage limits. Uses OpenStreetMap data via OpenMapTiles schema. Multiple styles available (Liberty, Bright, Positron). Customizable via Maputnik editor.
- **Fallback**: If OpenFreeMap ever goes down, Protomaps with a self-hosted PMTiles file is the backup plan. Zero API costs either way.

### Video processing: FFmpeg (via CLI)
- **Why**: Industry standard. Handles every codec/format iPhone produces. The Rust backend shells out to FFmpeg for all video operations.
- **Stabilization**: vidstab library (two-pass: vidstabdetect → vidstabtransform)
- **Color grading**: Hald CLUT / 3D LUT filter. Generate a reference LUT, edit in any image editor, apply to video.
- **Speed adjustment**: setpts filter for video, atempo for audio
- **Trimming**: Frame-accurate seek with -ss and -to
- **Compositing**: filter_complex with overlay, pad, scale for combining video + map frames
- **Transitions**: xfade filter for crossfades between clips
- **Export codecs**: H.264 (libx264) for compatibility, H.265 (libx265) for quality/size

### Metadata extraction: ExifTool (via CLI)
- **Why**: Best-in-class for reading metadata from iPhone MOV/MP4 files. Extracts GPS coordinates, creation timestamps, duration, resolution, codec info. JSON output mode (-json flag) makes parsing trivial.
- **Key fields**: GPSLatitude, GPSLongitude, CreateDate, Duration, ImageSize, VideoFrameRate

### GPX/FIT parsing
- **GPX**: Standard XML format. Parse with any XML library in Rust (quick-xml or roxmltree). Extract trackpoints with lat, lng, elevation, timestamp.
- **FIT**: Binary format from Garmin. Use the `fitparser` Rust crate. Same data: trackpoints with lat, lng, elevation, timestamp.

### Project file format
JSON file stored on disk alongside (or wherever the user chooses). Contains:
```
{
  "version": 1,
  "clips": [
    {
      "id": "uuid",
      "path": "/absolute/path/to/video.MOV",
      "created_at": "2025-04-04T14:23:15Z",
      "duration_ms": 12400,
      "gps": { "lat": 37.8199, "lng": -122.4783 },
      "trim": { "in_ms": 0, "out_ms": 12400 },
      "focal_point": { "x": 0.5, "y": 0.5 },
      "effects": {
        "stabilize": { "enabled": false, "shakiness": 5 },
        "color_lut": null,
        "speed": 1.0
      }
    }
  ],
  "route": {
    "source_path": "/path/to/activity.gpx",
    "format": "gpx",
    "trackpoints": []  // parsed and cached here
  },
  "exports": [
    {
      "name": "TikTok vertical",
      "aspect_ratio": "9:16",
      "resolution": { "width": 1080, "height": 1920 },
      "layout": {
        "video_pct": 60,
        "map_position": "bottom",
        "map_visible": "always"
      },
      "codec": "h264",
      "quality": "high"
    }
  ]
}
```

---

## Architecture layers

### Rust backend (Tauri commands)

The backend exposes Tauri commands that the frontend calls via IPC. Each command is a Rust function annotated with `#[tauri::command]`. The backend does NOT hold state in memory between calls — all state lives in the project JSON file. The backend is stateless and functional: receive request → do work → return result.

Key command groups:

**Import & metadata**
- `scan_directory(path) → Vec<ClipMetadata>`: Run ExifTool on all video files in a directory, return sorted metadata
- `extract_metadata(file_path) → ClipMetadata`: ExifTool on a single file
- `parse_route(file_path) → Route`: Parse GPX or FIT file into trackpoints
- `generate_proxy(file_path, output_path)`: Generate low-res proxy video for preview playback

**Synchronization**
- `build_timeline(clips, route?) → Timeline`: Match clips to route positions by timestamp. If route is provided, each clip gets a precise position from the GPX trackpoints. If not, clips use their embedded GPS. Gaps between clips become transition segments with start/end positions and (if GPX available) the route geometry between them.

**Effects processing**
- `stabilize_clip(input, output, settings)`: Run vidstab two-pass on a clip
- `apply_lut(input, output, lut_path)`: Apply color LUT via FFmpeg haldclut
- `adjust_speed(input, output, factor)`: Apply speed change via setpts/atempo

**Export**
- `render_map_frames(timeline, layout, output_dir)`: Drive a headless WebView through the map animation sequence, capture PNGs. This is the slowest step.
- `composite_export(timeline, map_frames_dir, layout, output_path)`: Build the final FFmpeg filter_complex command that composites video clips + map frames, applies transitions, and encodes to the target format.
- `export(project, export_config, output_path)`: Orchestrates the full pipeline: process effects → render map → composite → encode.

**Project file**
- `save_project(project, path)`: Write JSON
- `load_project(path) → Project`: Read JSON

### React frontend

The frontend is a single-window app with a resizable split-pane layout:

**Left pane: Video editing**
- Timeline strip at the bottom showing clip thumbnails in chronological order
- Video preview player (using proxy files) in the main area
- Focal point overlay (draggable crosshair) on the video preview
- Clip inspector panel: trim controls (in/out point sliders), effect toggles (stabilize, LUT, speed), focal point coordinates

**Right pane: Map**
- MapLibre GL JS map showing the full route (if GPX loaded) and markers for each clip's location
- Current clip highlighted on map
- During preview playback, map animates between clip positions
- Route drawn progressively if GPX is available

**Bottom bar: Export**
- Export preset selector (vertical/landscape/square/custom)
- Layout configurator (video %, map position, map visibility mode)
- Export button → progress indicator → file save dialog

### External dependencies (CLI tools on the user's machine)

The app needs FFmpeg and ExifTool installed on the user's Mac. Options for handling this:
1. **Bundled**: Ship FFmpeg and ExifTool binaries inside the Tauri app bundle (Tauri sidecar feature). This is the smoothest UX — no setup required. FFmpeg static builds for macOS are available. ExifTool is a single Perl script.
2. **Homebrew prerequisite**: Require the user to `brew install ffmpeg exiftool`. Simpler to build but worse UX.
3. **Hybrid**: Bundle ExifTool (tiny), require FFmpeg via Homebrew or offer to install it.

Recommendation: **Bundle both as Tauri sidecars** for V1. The total added size is ~80MB (FFmpeg static build) + ~5MB (ExifTool), which is acceptable for a desktop app. This eliminates setup friction entirely.

---

## Data flow: Import → Edit → Export

### Import flow
```
User selects folder
  → Rust scans for video files (MOV, MP4, M4V)
  → ExifTool extracts metadata from each file (batch mode: exiftool -json *.MOV)
  → Clips sorted by CreateDate
  → Optional: user imports GPX/FIT file
  → Rust parses route into trackpoints
  → Timeline synchronizer matches clips to route by timestamp
  → Frontend receives timeline, renders clip strip + map
```

### Edit flow
```
User selects clip in timeline
  → Frontend shows video preview (proxy) with focal point overlay
  → User adjusts trim, focal point, effects
  → Changes written to project JSON (no media processing yet)
  → Map pane highlights current clip location
  → Preview reflects trim/speed changes in real-time
  → Stabilization and LUT preview: generate a single processed frame on demand for preview
```

### Export flow
```
User configures export (aspect ratio, layout, quality)
  → Rust processes each clip: apply trim, stabilize, color grade, speed
  → Rust renders map animation frames:
      For each clip: static map frame at clip's GPS position
      For each transition: N frames of animated camera move / route drawing
  → Rust builds FFmpeg filter_complex:
      Scale video clips to target resolution with focal-point-based crop
      Scale map frames to target size
      Overlay/arrange video + map per layout config
      Apply xfade transitions on video track
      Concatenate all segments
      Encode to target codec
  → Output file saved to user-specified location
```

### Map animation rendering detail
The most technically interesting part. For each transition between clips:

1. Calculate start position (clip A's GPS) and end position (clip B's GPS)
2. If GPX route exists: extract the route segment between these timestamps
3. Determine frame count based on desired transition duration (e.g., 2 seconds at 30fps = 60 frames)
4. For each frame:
   - Set MapLibre camera position (interpolated along route or direct lerp)
   - If route exists: set the route line's endpoint to the current interpolated position (progressive reveal)
   - Add/update markers for clip positions
   - Render the WebView to a canvas
   - Capture canvas as PNG
5. Write all PNGs to a temp directory
6. FFmpeg reads them as an image sequence: `-framerate 30 -i frame_%04d.png`

For the headless WebView rendering, Tauri can create an offscreen/hidden window with MapLibre loaded. The Rust backend sends JavaScript commands to the WebView via `window.eval()` to position the camera and trigger renders. The WebView calls back to Rust with the rendered frame data.

---

## Implementation phases

### Phase 1: Foundation — "Folder to timeline with map"
**Goal**: Import a folder of iPhone videos, see them sorted chronologically with GPS markers on a map.

- Scaffold Tauri app with React + TypeScript + Vite frontend
- Bundle ExifTool as a Tauri sidecar
- Implement `scan_directory` command: run ExifTool in batch JSON mode, parse results, sort by timestamp
- Build the clip timeline UI component: horizontal strip of thumbnails in chronological order
- Integrate MapLibre GL JS with OpenFreeMap tiles
- Show clip locations as markers on the map
- Implement GPX file import and parsing (Rust)
- When GPX is loaded, draw the full route on the map as a MapLibre line layer
- Implement the timeline synchronizer: match clips to GPX trackpoints by timestamp
- Build the project file save/load (JSON)
- Basic file drag-and-drop or folder picker for import

**Exit criteria**: Open app → drag in a folder of hiking videos + a GPX file → see clips on a timeline, markers on a beautiful map, route drawn. Save/load project.

### Phase 2: Editing — "Trim, grade, stabilize"
**Goal**: Edit individual clips with trim, focal point, and effects.

- Bundle FFmpeg as a Tauri sidecar
- Implement proxy generation (low-res copies for preview)
- Build video preview player using HTML5 `<video>` element with proxy files
- Implement trim UI: in/out point sliders that scrub the proxy video
- Implement focal point UI: draggable crosshair overlay on video preview, with live crop preview showing how the frame will look in different aspect ratios
- Implement stabilization: Rust command shells out to FFmpeg vidstab two-pass
- Implement color grading: LUT-based workflow. Provide a few built-in LUTs (warm, cool, cinematic). Allow custom LUT import.
- Implement speed adjustment UI and backend (setpts/atempo)
- Preview processed frames on demand (single-frame renders for effect preview without processing full clip)
- All edits stored in project JSON, no destructive changes to source files

**Exit criteria**: Select a clip → trim it → apply stabilization → apply a color LUT → adjust speed → set focal point → see preview of how it will look in vertical crop. All saved to project file.

### Phase 3: Export — "Render the final video"
**Goal**: Produce finished videos with map composited alongside footage.

- Build the export configurator UI: aspect ratio presets, layout controls (video %, map position, visibility mode)
- Implement map frame rendering: hidden WebView with MapLibre, programmatic camera control, frame capture
- Implement the animated map transitions: camera fly-between for clips without GPX, progressive route drawing for clips with GPX
- Build the FFmpeg compositing pipeline: filter_complex that arranges video + map frames per layout
- Implement focal-point-based cropping in FFmpeg: calculate crop coordinates from focal point + target aspect ratio
- Implement video-side crossfade transitions (xfade filter)
- Export progress UI with cancel support
- Output format options: H.264 / H.265, quality presets

**Exit criteria**: Configure a vertical 9:16 export with 60/40 split → hit export → get a video file with footage on top, animated map on bottom, smooth transitions between clips showing the route being drawn. Same for landscape 16:9 side-by-side.

### Phase 4: Polish — "Make it feel great"
**Goal**: Refine the experience, handle edge cases, add nice-to-haves.

- Audio handling: preserve original audio from clips, crossfade audio during transitions, optional background music track with volume control
- Map style customization: let user pick from OpenFreeMap styles (Liberty, Bright, Positron) or import custom MapLibre style JSON
- Map annotations: custom markers, labels, or waypoint names from GPX
- Batch export: queue multiple export configs (vertical + landscape + square) and render sequentially
- Keyboard shortcuts for timeline navigation and editing
- Undo/redo system (state history in frontend)
- Performance optimization: parallel proxy generation, FFmpeg GPU acceleration (VideoToolbox on macOS)
- Error handling polish: graceful handling of corrupted files, missing metadata, permission issues
- Auto-update mechanism (Tauri updater plugin)
- App icon, DMG installer design

---

## Technical notes

### iPhone video metadata
iPhone videos (MOV/MP4) contain GPS coordinates, creation timestamps, and other metadata in QuickTime container format. ExifTool is the most reliable tool for extracting this. Key fields:
- `CreateDate`: When the clip was filmed (local time)
- `GPSLatitude` / `GPSLongitude`: Location where filming started
- `Duration`: Clip length
- `ImageSize`: Resolution (e.g., 1920x1080, 3840x2160)
- `VideoFrameRate`: FPS (typically 30 or 60 for iPhone)
- `MediaCreateDate`: Alternative timestamp field

Note: iPhone GPS in video metadata is a SINGLE point (where recording started), not a track. This is why GPX route data is so valuable — it provides continuous positioning.

### GPX format
```xml
<gpx>
  <trk>
    <trkseg>
      <trkpt lat="37.8199" lon="-122.4783">
        <ele>45.2</ele>
        <time>2025-04-04T14:23:15Z</time>
      </trkpt>
      <!-- thousands more trackpoints, typically every 1-3 seconds -->
    </trkseg>
  </trk>
</gpx>
```

### FFmpeg compositing example (vertical split-screen)
```bash
ffmpeg \
  -i clip.mp4 \
  -framerate 30 -i map_frames/frame_%04d.png \
  -filter_complex "
    [0:v]crop=ih*9/16:ih:iw/2-ih*9/32:0,scale=1080:1152[vid];
    [1:v]scale=1080:768[map];
    [vid][map]vstack[out]
  " \
  -map "[out]" -map 0:a \
  -c:v libx264 -preset slow -crf 18 \
  -c:a aac -b:a 128k \
  output_vertical.mp4
```
The crop filter uses the focal point to determine the horizontal offset (here simplified as center). In practice, the offset is calculated from the clip's focal_point.x value.

### FFmpeg stabilization example
```bash
# Pass 1: detect
ffmpeg -i input.MOV -vf vidstabdetect=shakiness=7:accuracy=15 -f null -
# Pass 2: transform
ffmpeg -i input.MOV -vf vidstabtransform=smoothing=10:optzoom=2,unsharp=5:5:0.8:3:3:0.4 stabilized.mp4
```

### Tauri sidecar setup
In `tauri.conf.json`:
```json
{
  "bundle": {
    "externalBin": [
      "binaries/ffmpeg",
      "binaries/exiftool"
    ]
  }
}
```
Place platform-specific binaries in `src-tauri/binaries/` with the naming convention: `ffmpeg-aarch64-apple-darwin`, `ffmpeg-x86_64-apple-darwin`.

### MapLibre route animation (frontend JavaScript)
```javascript
// Progressive route reveal
function animateRoute(map, routeCoords, durationMs) {
  const startTime = performance.now();
  function frame(time) {
    const progress = Math.min((time - startTime) / durationMs, 1);
    const pointCount = Math.floor(progress * routeCoords.length);
    const partial = routeCoords.slice(0, pointCount);
    map.getSource('route').setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: partial }
    });
    if (progress < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
```

---

## Open questions for later phases

- **Multi-day hikes**: Should the app support importing clips + routes from multiple days into a single project? This affects timeline grouping and map zoom levels.
- **Drone footage**: iPhone videos are the primary target, but drone footage from DJI etc. has similar metadata. Should be compatible with minimal changes.
- **Live photo / slow-mo**: iPhone live photos and slow-mo clips have different metadata structures. Handle gracefully (extract what we can, skip what we can't).
- **Collaborative editing**: Could two people working on the same hike video share a project file? The JSON format makes this possible if paths are relative.
- **Cloud storage**: If source videos are in iCloud, do we handle the "file not downloaded" state gracefully?
- **Windows/Linux**: Tauri supports all three platforms. macOS is the primary target, but the architecture doesn't preclude cross-platform. FFmpeg and ExifTool work everywhere. MapLibre works everywhere. The only macOS-specific piece is WKWebView (vs. WebView2 on Windows, WebKitGTK on Linux).
