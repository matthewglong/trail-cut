# Patched maplibre-gl-native binding (native export-renderer backend)

The export renderer's native backend (`TRAILCUT_RENDERER_BACKEND=native`)
drives `@maplibre/maplibre-gl-native` **in-process** instead of headless
Chrome. It requires a patched build of the node binding:

- **Upstream pin:** tag `node-v6.4.1` (core `0aff90b`).
- **Patch 1:** `expose-setGestureInProgress.patch` — binding-only
  (`platform/node/src/node_map.{cpp,hpp}`), exposes
  `map.setGestureInProgress(bool)` to JS. While true, the transform reports
  `isChanging()`, so raster tiles use the non-pixel-aligned projection
  matrix — the exact analogue of the GL JS `moving` painter flag our
  shipped Chrome renderer forces via `page/painterPatch.ts`. Without it,
  satellite exports sawtooth at 0.93 px RMS on sub-pixel pans; with it,
  0.0795 px (bar 0.10) — measured, `.spike/native-gl/jitter-report.md`.
- **Patch 2:** `readback-downsample.patch` — adds the render option
  `downsample: {factor, width, height}`: an exact integer box filter run
  backend-side before readback. Applies on top of patch 1 (ensure-binding
  applies them in listed order).
  Under Metal it is a compute pass on the offscreen color texture
  (`src/mbgl/mtl/offscreen_texture.cpp`), so the full supersampled
  framebuffer never crosses the GPU→CPU boundary (7.6MB readback instead of
  42MB at the 9:16 cell) and the worker does zero per-pixel CPU work; other
  backends inherit a shared CPU fallback with identical semantics
  (`gfx/headless_backend.cpp`). Semantics are byte-identical to
  `nativeBackend.ts::boxDownsample` (zero-pad to width×factor, divisor
  stays factor², `(sum + n/2)/n` truncated) — pinned by
  `__tests__/readbackDownsample.test.ts`, whose flat-scene case is an exact
  rounding-mode probe (must be byte-identical). Capability marker:
  `mbgl.readbackDownsample === true`; `nativeBackend.ts` fails loud on a
  binding without it whenever the export is supersampled. Measured at the
  9:16 4K cell (fb 3676×2068, factor 2): per-frame render+reduce+readback
  81ms → 12ms median (isolated A/B, tile-free scene); production per-frame
  `down` 55–90ms → 0ms. Motivation + forensics: the 2026-07-03
  export-slowdown investigation (CPU box filter was 55–90% of frame time
  and inflated 2.5–6× under CPU contention).
- **Patch 3:** `group-composite.patch` — core + binding — adds engine-level
  **group-opacity compositing**: `Renderer::setGroupComposites([{layers,
  opacity}])` (core) / `map.setGroupComposite([...])` (node binding), same
  plumbing pattern as patches 1–2. Per frame, each configured group's member
  layers render into a full-viewport RGBA8 offscreen target (WITH
  depth+stencil — line layers stencil-clip their tiles); members are
  skipped in the main passes; one src-over composite of the offscreen
  texture at the group opacity happens at the topmost member's z-slot.
  New Metal shader `GroupCompositeShader` (the heatmap-texture shader minus
  the color-ramp lookup — premultiplied `texture × opacity` is the exact
  group-opacity composite; reuses heatmap's UBO layout/slots, zero edits to
  the generated shader_defines tables). One subtle bug surfaced and is
  fixed as part of the patch: tile clipping masks drawn into the offscreen
  pass's stencil marked themselves "covered" for the frame, so the main
  pass never redrew its own and every stencil-clipped drawable (the route
  line!) vanished — `PaintParameters::resetTileClippingMasks()` makes each
  independent stencil attachment redraw masks lazily. Capability marker:
  `mbgl.groupComposite === true`. Motivation: translucent halo layers
  double-blend where they overlap themselves (jitter sunbursts, and the
  legitimate out-and-back retrace) under MapLibre's plain per-layer alpha
  blending — this is the engine-level fix. Measured
  (`.spike/halo-composite/VERDICT.md`): out-and-back overlap coverage
  0.7487 → 0.4974 (sd 0 — exactly one coat, same as the non-overlapping
  control segment); +2.3 ms/frame at the 3840×2160 bare-scene fixture
  (≈+3% against a healthy ~66 ms production export frame); feature unused
  renders byte-identical (MD5) to the binding without it. **Descope note:**
  the base `gfx::Context::createOffscreenTexture(size, type, depth,
  stencil)` fallback ignores the depth/stencil flags on non-Metal
  backends — the feature is reachable only via the Metal-only node binding
  today; honoring the flags per-backend is required before any upstream
  PR.
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
