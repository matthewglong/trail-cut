# Spike Handoff — Native GL (maplibre-native) moving-map export at 4K, jitter test

**Status:** not started
**Type:** throwaway spike — isolated, NOT integrated into the app
**Owner of decision:** Matthew

## 1. The one question this spike answers

> Can `maplibre-native` render a **smoothly moving** map camera path at **4K** **without the pixel-grid jitter** that forced us back to headless GL JS — and if it *does* jitter, *which layer* is responsible and is that fix reachable without forking the whole engine per platform?

This is a **go / no-go** investigation. The deliverable is a measured answer with numbers and two 4K videos, not production code.

### Why we care
Our export renderer is headless Chrome + MapLibre GL **JS**. It works but carries a structural "browser tax" (per-frame CDP round-trips + base64 pixel readback) that makes rendering slow. `maplibre-native` would remove that tax entirely. We previously rejected it because slow camera pans rendered jittery, and the only fix we found was forking the renderer and maintaining native binaries per platform (Mac/Win/Linux). This spike re-tests that conclusion from first principles.

### What the source review already established (don't re-derive this)
- The jitter is **pixel-grid snapping**: `TransformState::getProjMatrix(..., aligned)` strips the fractional pixel off the camera translation with `std::modf`, rounding the map onto whole pixels. On sub-pixel-per-frame pans this produces a few-px sawtooth wobble.
- GL JS gates this on a per-frame `moving` flag; our renderer forces `moving: true` (`src-tauri/sidecars/renderer/page/painterPatch.ts`) to bypass it.
- **Native has no `moving` concept.** Alignment is a per-call `aligned` argument. In the current "Drawable" renderer the shared `LayerTweaker::getTileMatrix(...)` defaults `aligned = false` (`include/mbgl/renderer/layer_tweaker.hpp:59`), so **vector** fill/line/symbol geometry uses the *non-snapped* matrix; only callers that explicitly pass `true` (raster / background, for crispness) snap.
- The **legacy Node binding** (`platform/node/src/node_map.cpp`) hardcodes `MapMode::Static`/`Tile` and exposes **no** alignment or mode knob.
- **Conclusion the spike must validate:** the jitter is probably from a *specific* layer (raster/background `aligned=true`, or symbol shader rounding), not a global pixel-lock. If so, the "fix" may be one call site, not a full fork. We need to confirm empirically and identify the layer.

## 2. Decision criteria (define PASS/FAIL up front)

The measurement is **inter-frame displacement residual** in pixels (see §5.3). Using the GL JS render of the *identical* path as the known-smooth ground truth:

- **PASS / no-fork viable** — native residual RMS `< ~0.10 px` with no sawtooth, AND the 4K video is visually smooth, AND native 4K crispness ≥ GL JS. → native is a real option; recommend next steps.
- **FAIL but localized** — native shows a `±0.5 px` sawtooth (RMS `> ~0.2 px`), but layer-isolation (§5.5) pins it to **one** layer class with a known code site. → report the exact site and the per-platform build cost of patching just that.
- **FAIL global** — every layer variant jitters → confirms the original "fork everything" conclusion. Close the door with evidence.

GL JS baseline residual is expected to be `≪ 0.05 px` (it's the smooth reference).

## 3. Scope / non-goals

**In scope:** one isolated Node spike folder; render a moving path in native and in GL JS at 4K; measure jitter; if present, isolate the layer; compare 4K crispness; write a verdict.

**Out of scope (do NOT do):**
- No integration with the app, the export pipeline, `mapVisuals`, or the existing sidecar protocol.
- **No render-speed benchmarking.** This spike is purely jitter + crispness. (Native may fall to software rasterization in this harness; that does not matter here and must not be used to judge it.)
- No color/HDR pipeline work.
- No productionization, no cleanup of the existing renderer.

## 4. Environment setup

1. Create `/.spike/native-gl/` for all spike artifacts (scripts, frames, videos, report). Keep it self-contained; it can be deleted wholesale.
2. Install the native renderer: `npm i @maplibre/maplibre-gl-native` (in an isolated package.json inside the spike folder, **not** the app's).
3. **Record install friction verbatim** in `.spike/native-gl/install-notes.md`: node version used, whether a prebuilt binary existed or it compiled from source, any system deps, total time, any failures. *This is data* — the cross-platform build/maintenance burden is half the original rejection rationale.
4. Tooling for analysis: Python 3 with `numpy` + `opencv-python` (`cv2.phaseCorrelate` gives sub-pixel shift), and `ffmpeg` for assembling frames into video.

Platform: develop on macOS (current ship target). Note in the report that Windows/Linux build viability is a separate follow-up — but the macOS install experience is an early signal.

## 5. Build — phased

### Phase 0 — single 4K frame, prove the harness
- `render-native.js`: construct the map with a `request` handler that fetches over HTTPS (handle **all** resource kinds: Style, Source, Tile, Glyphs, SpriteImage, SpriteJSON) with a simple on-disk cache by URL hash.
- Style: `https://tiles.openfreemap.org/styles/liberty` (the app's basemap — `src/lib/mapVisuals/styleSpec.ts:56`).
- Render ONE frame at **4K UHD framebuffer dims**: target a `3840×2160` RGBA buffer for 16:9 (or `2160×3840` for the 9:16 social slot — pick 16:9 for Phase 0). Use the binding's `width`/`height`/`ratio` to reach those pixel dims; **assert the returned buffer is exactly W·H·4 bytes**.
- Write it as a PNG. **Acceptance:** a recognizable, sharp 4K map of a real location (pick a detailed area — e.g. a mountain town with roads + labels + terrain).

### Phase 1 — the moving camera path
Define one deterministic path generator shared by both renderers so they are byte-for-byte comparable in intent:
- `N = 150` frames. Fixed zoom `Z = 14`, pitch `0`, and a **slow linear pan** (translation is the classic snap-provoker).
- Choose the per-frame center delta so on-screen motion is **sub-pixel: ~0.3–0.6 px/frame** (this is the regime where snapping is visible and where GL JS without the patch wobbles). Convert px→degrees with the web-mercator scale at `Z`: `degPerPx_lng = 360 / (512 · 2^Z · ratio) / cos(lat)`; set `lngStep = 0.4 · degPerPx_lng`. Keep `lat` ≈ constant.
- Also generate two secondary paths to stress other transform axes: (a) pan **+ slow bearing** rotation (~0.2°/frame), (b) slow **zoom** ramp (~0.003 zoom/frame). Run the primary pan first; do the others only if the primary is inconclusive.
- Emit `path.json` (array of `{frame, center:[lng,lat], zoom, bearing, pitch}`) so both renderers consume the **exact** same poses.

### Phase 2 — render both at 4K
- **Native:** loop `path.json`, `map.render(pose)` per frame, write `frames-native/####.png` at 4K.
- **GL JS baseline (known-smooth reference):** a small standalone Puppeteer harness (`render-gljs.js`) loading `maplibre-gl` in headless Chrome at the same 4K dims (`deviceScaleFactor` to hit 3840×2160), same style, same `path.json`, screenshot per frame → `frames-gljs/####.png`. **Apply the same painter patch** we ship (copy the logic from `src-tauri/sidecars/renderer/page/painterPatch.ts`) so the baseline is our *actual* smooth behavior. Do **not** wire up the full export sidecar — keep this minimal and isolated.
- Assemble both into **visually lossless** 4K videos for eyeballing: `ffmpeg -framerate 30 -i frames-native/%04d.png -c:v prores_ks -profile:v 3 native.mov` (or H.264 `-crf 10`). **All numeric analysis runs on the raw PNGs, never the compressed video**, so encoding can't mask or fake jitter.

### Phase 3 — quantitative jitter measurement (the decisive step)
`measure.py`:
1. For each consecutive PNG pair in a sequence, compute sub-pixel displacement with `cv2.phaseCorrelate` (apply a Hanning window). This yields `d[i] = (dx,dy)` per step.
2. For a linear pan, the **true** displacement is constant. Take the GL JS sequence's `d_gljs` as the smooth ground truth (fit a low-order polynomial / its mean for pure pan).
3. Define `jitter[i] = d_native[i] − smoothfit(d_native[i])` (high-frequency residual). Also report `d_native − d_gljs` directly.
4. Output `jitter.csv` (per-frame dx,dy, residual magnitude) and summary stats: **RMS residual, max residual, and presence/period of a ±0.5 px sawtooth** (FFT of the residual or simple peak-to-peak). Do this for native and for GL JS.
5. Snapping signature = residual bounded near ±0.5 px, correlated with the fractional pixel position of the camera. Smooth = residual RMS ≪ 0.05 px.

### Phase 4 — 4K crispness check
The user's explicit requirement is maximum crispness at 4K. On one matched static pose:
- Render the same frame in native and GL JS at 4K. Crop identical regions containing fine labels + thin roads.
- Compare sharpness quantitatively (mean edge-gradient magnitude / acutance via a Sobel response) and save side-by-side crops. **Native must be at least as crisp as GL JS at 4K**; if labels/lines are visibly softer, that's a strike — record it.

### Phase 5 — layer isolation (ONLY if Phase 3 shows native jitter)
Re-render the native pan with minimal styles to pin the source, mapping each to the code path from the source review:
- **vector-only** (openfreemap fills + lines, symbols removed): exercises the `aligned=false` default vector path — expected smooth.
- **+ symbols** (labels on): isolates symbol/label pixel rounding (shader-side, separate from the matrix).
- **raster-only** (a raster source, e.g. the satellite layer at `styleSpec.ts:69`): exercises the `aligned=true` raster path — prime suspect.
- **background-only**.

Run `measure.py` on each. The variant(s) that jitter identify the offending layer class. Map the result to the concrete fix site (e.g. "raster tweaker passes `aligned=true` → one call-site change" vs "symbol shader rounds in `symbol_layer_tweaker.cpp`") and state whether that's a binding-level patch or a core-`mbgl` patch — i.e., how deep a fork actually is.

## 6. Deliverables (all under `.spike/native-gl/`)

1. `native.mov` + `gljs.mov` — 4K videos of the identical moving path.
2. `jitter.csv` + `jitter-report.md` — per-frame residuals and summary stats (RMS/max/sawtooth) for native vs GL JS, plus per-variant if Phase 5 ran.
3. `crispness/` — side-by-side 4K crops + the acutance numbers.
4. `install-notes.md` — install/build friction (the maintenance-burden signal).
5. `VERDICT.md` — one of **GO / NO-GO / CONDITIONAL** per §2, with the numbers, the identified jitter layer (if any), the exact code site + fork depth for any fix, and a recommended next step.

## 7. Risks & gotchas

- **Install may fail / no prebuilt binary** for the node version. That is itself a result — capture it; don't paper over it.
- **Software vs GPU raster:** the harness may not be GPU-accelerated. Irrelevant to jitter/crispness; explicitly do not judge speed here.
- **Resource fetching:** the liberty style pulls tiles, glyphs, and sprite from the network — the `request` handler must serve **all** kinds or you'll get blank/garbled frames. Cache to disk so reruns are fast.
- **Apples-to-apples:** native and GL JS must match on style, every pose, dims, pitch/bearing, and antialiasing. Any mismatch corrupts the phase-correlation comparison.
- **Don't analyze compressed video** — only raw PNGs.
- **Buffer size:** 4K RGBA ≈ 33 MB/frame; 150 frames ≈ 5 GB raw. Stream/clean up or keep N at 120–180.
- **9:16 too:** our primary social slot is vertical. After 16:9 passes/fails, re-confirm the headline result once at `2160×3840`.

## 8. Assumptions (override if wrong)
- Location for the path: pick any detailed real area with roads + labels + terrain; swap freely. A real route from `.spike/base_payload.json` can be used but is not required — a synthetic linear pan is sufficient and cleaner.
- 16:9 4K (`3840×2160`) for the main runs; one 9:16 confirmation at the end.
- `Z=14`, `N=150`, `0.4 px/frame` pan are starting points — adjust if the snap signature isn't provoked (slower pan = more visible snapping).

## 9. Report back
Lead `VERDICT.md` with the go/no-go and the single most important number (native residual RMS vs GL JS). Then: which layer jitters (or "none"), the exact fix site + whether it's binding-level or core-`mbgl`, the macOS install experience, and the 4K crispness comparison. End with a recommended next step (e.g. "patch raster tweaker call site and re-spike" / "no fork needed, prototype a follow-cam" / "confirmed global snap, stay on GL JS").
