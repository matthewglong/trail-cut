# Patched maplibre-gl-native binding (native export-renderer backend)

The export renderer's native backend (`TRAILCUT_RENDERER_BACKEND=native`)
drives `@maplibre/maplibre-gl-native` **in-process** instead of headless
Chrome. It requires a patched build of the node binding:

- **Upstream pin:** tag `node-v6.4.1` (core `0aff90b`).
- **Patch:** `expose-setGestureInProgress.patch` — binding-only
  (`platform/node/src/node_map.{cpp,hpp}`), exposes
  `map.setGestureInProgress(bool)` to JS. While true, the transform reports
  `isChanging()`, so raster tiles use the non-pixel-aligned projection
  matrix — the exact analogue of the GL JS `moving` painter flag our
  shipped Chrome renderer forces via `page/painterPatch.ts`. Without it,
  satellite exports sawtooth at 0.93 px RMS on sub-pixel pans; with it,
  0.0795 px (bar 0.10) — measured, `.spike/native-gl/jitter-report.md`.
- **Provisioning:** `ensure-binding.mjs` (run by `npm run build:renderer`,
  or standalone via `npm run build:native-binding`). Verifies the staged
  artifact at `src-tauri/binaries/mbgl-native-<triple>/`, else builds from
  source (~5 min; needs `brew install cmake ninja ccache pkg-config glfw
  libuv`). CI caches the staged dir keyed on the patch + script hashes.
- **Verification:** the build is byte-identical to upstream's prebuilt with
  the knob off (jitter stats match to 12+ digits — build parity proven).

**Distribution status** (`.spike/native-gl/PRODUCTION_PATH.md`): the
upstream PR is the exit ramp — **not posted; Matthew decides when**.
Interim: this vendored patch + local/CI build (route 3 shape). Task 130
sidecar bundling ships the staged dir per platform alongside
ffmpeg/exiftool. Windows: upstream's `node-release.yml` prebuilt matrix
includes win32; the fetch path lands with task 130.
