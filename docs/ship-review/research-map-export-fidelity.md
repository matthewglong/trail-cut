# Research receipt — Map-export fidelity: headless-Chromium pixel extraction, edge crispness through encode, ecosystem precedent, deterministic frame stepping

Date: 2026-06-11. Researched for the ship-review "start over vs clean up" verdict.
Scope: the four research questions posed for the export map renderer
(`src-tauri/sidecars/renderer/`), grounded in `MAP_RENDERING_PLAN.md` and the
worker/page sources, cross-checked against 2025–2026 web sources.

**Headline conclusions (detail + citations below):**

1. TrailCut's architecture — full headless Chrome + MapLibre `setNow` frame
   stepping + raw `gl.readPixels` readback — is squarely what the ecosystem
   converged on, and the only deterministic option available on macOS (CDP
   `HeadlessExperimental.beginFrame` is Linux/Windows-only). The architecture
   is *not* the soup; it is validated.
2. The one genuinely unusual piece is the **transport**: base64-RGBA over CDP
   (`page/init.ts:914` `bytesToBase64` → exposed-function arg). Everyone else
   either encodes video in-page (Mapbox's own debug exporter, WebCodecs
   pipelines) or eats the screenshot cost. A binary WebSocket side-channel from
   page to Node removes both the 100 MB cap and the base64 CPU/size tax without
   touching anything else.
3. The 4:2:0 blur at final delivery is **inherent** for every consumer/social
   target; TrailCut's 4:4:4 10-bit intermediate compositing
   (`filtergraph.rs:171,718–742`) is already the textbook mitigation. Remaining
   levers are subsample quality, encoder tunes, and delivering at higher
   resolution (the "4K upload trick").
4. `maplibregl.setNow()/restoreNow()` is the *official* MapLibre deterministic-
   time API (it descends from the exact `browser.now` hijack Mapbox used in its
   own video-export debug page). TrailCut uses it correctly. The fragile part is
   the *private-internals* monkey-patching around transitions/raster-fade in
   `page/init.ts:391–444`, which must be version-pinned and canary-tested.

---

## 0. Current architecture (grounding, file:line)

- **Worker**: Node sidecar drives full Chrome (new headless, puppeteer ≥22,
  `headless: true`) because chrome-headless-shell has no GPU path on macOS and
  software WebGL (SwiftShader) stalls/crashes on first paint —
  `src-tauri/sidecars/renderer/index.ts:7–12`. ANGLE→Metal on Apple Silicon via
  `--use-angle=metal` (`index.ts:283`).
- **Frame stepping**: orchestrator sends `{cmd:'render', frame_index,
  project_time_ms}` (`index.ts:131–135`); page calls
  `maplibregl.setNow(frame.t)` (`page/init.ts:777`), applies per-frame
  source/paint/layout/gradient deltas, `jumpTo`, `triggerRepaint`, awaits
  `once('idle')` + 1 rAF (`page/init.ts:780–897`).
- **Determinism patches**: `fadeDuration: 0` (`page/init.ts:347`), per-layer
  `updateTransitions` monkey-patch to kill paint transitions
  (`page/init.ts:391–425`, with the documented `properties.ts` precedence-quirk
  rationale at `:377–390`), raster fade zeroed via `setRasterFadeDuration(0)`
  (`page/init.ts:437–443`), painter patch forcing `moving = true`
  (`page/painterPatch.ts`, applied at `init.ts:357`).
- **Pixel readback**: `gl.readPixels` called synchronously inside MapLibre's
  `'render'` event (the only window where `preserveDrawingBuffer:false`
  guarantees pixels; `preserveDrawingBuffer:true` hangs MapLibre's first render
  — both verified empirically, `page/init.ts:538–572`). Row-flip + ≤1 px
  pad/crop guard (`page/init.ts:666–760`).
- **SSAA**: map painted at `framebuffer = slot × factor` (factor 2–3,
  `src-tauri/src/export/layout.rs:153–173`, tiers asserted at `:550–559`),
  downsampled on-GPU onto a slot-sized 2D canvas
  (`imageSmoothingQuality:'high'`, gamma-space, deliberately matching the
  preview compositor — `page/init.ts:270–310,675–691`), so the wire stays
  slot-sized (`index.ts:109–114`).
- **Transport**: RGBA → base64 in-page (chunked `String.fromCharCode` + `btoa`,
  ~30–40 ms per 8 MB 1080p frame on M-series, `page/init.ts:631–642`) → CDP
  exposed-function arg → `Buffer.from(b64,'base64')` Node-side (`index.ts:863`)
  → length-prefixed raw RGBA on stdout to Rust (`index.ts:949–954`). Legacy
  `Page.captureScreenshot` PNG path kept as escape hatch (`index.ts:60,874–904`)
  but **incompatible with SSAA** (fails loudly, `index.ts:880–888`).
- **100 MB cap, observed twice**: shipping the SDF icon atlas as JSON-serialized
  `Uint8Array` blew "Chrome's 100 MB inbound-message cap" at 4K
  (`index.ts:478–494`, fixed by rasterizing page-side); the same cap bounds any
  single CDP message, hence the "hard 100 MB-per-frame practical cap" framing.
- **Compositing**: map RGBA enters FFmpeg, is lifted to `yuva444p10le` before
  overlay, overlay pinned to `format=yuv444p10` (because overlay defaults to
  yuv420 internally and silently strips chroma — `filtergraph.rs:659–730`,
  esp. `:677` "subsampling chroma early"), final `format={pix}` is yuv420p /
  yuv420p10le only at delivery (`filtergraph.rs:462–463`).

---

## 1. Getting pixels out of headless Chromium (2025–2026)

### 1.1 Option matrix

| Option | Determinism | Fidelity | Throughput | macOS GPU | Verdict for TrailCut |
|---|---|---|---|---|---|
| `gl.readPixels` → base64 → CDP (current) | exact (sync in `'render'`) | bit-exact framebuffer bytes, no color-management pass | base64 = +33% wire, ~30–40 ms/8 MB encode; 100 MB/frame cap | yes | works; transport is the weak link |
| `gl.readPixels` → **binary WebSocket side-channel** | same | same | binary, no cap, no base64 CPU | yes | **recommended evolution** |
| `Page.captureScreenshot` (PNG) | exact per-frame | color-managed by Chrome (profile-dependent) | libpng encode in GPU process + decode in Node; was the measured bottleneck | yes | keep as escape hatch only (already SSAA-incompatible) |
| CDP `Page.startScreencast` | **none** (push-based, ~30 fps max, drops frames) | JPEG-lossy (PNG possible but slow) | high but uncontrolled | yes | reject for export; fine for live monitoring |
| `HeadlessExperimental.beginFrame` + screenshot | best-in-class (Chrome's own vsync replaced) | screenshot path | good | **no — macOS unsupported**, needs headless-shell (no macOS GPU) | ruled out by platform |
| WebCodecs `VideoEncoder` in-page (→ mediabunny mux, chunks out) | exact (you feed `VideoFrame`s) | **lossy + 4:2:0 at the intermediate** (hardware H.264/HEVC encode converts internally) | excellent (~200 fps 1080p HW) | yes (VideoToolbox) | rejected for the *map* stream: reintroduces 4:2:0 before compositing |
| OffscreenCanvas + "shared memory" | n/a | n/a | n/a | n/a | no real page-JS→Node shared-memory primitive exists; closest is the WebSocket binary channel or File System Access/OPFS writes (adds disk IO + lifecycle complexity) |
| `--remote-debugging-pipe` | same as CDP | same | avoids the ws-library payload cap but still JSON/base64 framing; pipe backpressure issues documented | yes | sidegrade, not a fix |

### 1.2 Detail and sources

**Screencast vs screenshot.** CDP screencast streams `Page.screencastFrame`
events (base64 JPEG/PNG + ack protocol) at ~30 fps max and drops frames under
load; `captureScreenshot` is the per-frame pull. Community guidance: screencast
for liveness, screenshot for fidelity; hybrid (low-res screencast change
detection + hi-res screenshot) exists. Sources:
[copyprogramming 2026 guide](https://copyprogramming.com/howto/headless-chrome-capture-screen-video-or-animation),
[chromium headless-dev: screencast in headless](https://groups.google.com/a/chromium.org/g/headless-dev/c/6XKLTi5bsZA),
[headless-dev: screenshot is slow](https://groups.google.com/a/chromium.org/g/headless-dev/c/aVZw00nzxTU).
TrailCut already measured this: the PNG screenshot path's encode/decode "were
dwarfing the actual map render" (`index.ts:858–861`) — consistent with the
ecosystem's experience.

**The 100 MB cap is real, and it is layered.** (a) The `ws` WebSocket library
puppeteer uses introduced a default `maxPayload` of 100 MB in v6 — pages/
messages >100 MB fail ([puppeteer#4543](https://github.com/puppeteer/puppeteer/issues/4543));
the matching Chromium-side read-buffer error is "Too large read data is
pending: capacity=104857600" (100 MiB,
[chrome-remote-interface#522](https://github.com/cyrus-and/chrome-remote-interface/issues/522)).
(b) Large `page.evaluate` arguments (>100 MB) crash the connection
([puppeteer#5598](https://github.com/puppeteer/puppeteer/issues/5598)) — this is
the exact failure TrailCut hit with the 127 MB icon atlas (`index.ts:487–489`).
(c) Modern puppeteer's `NodeWebSocketTransport` raises `maxPayload` to
256 MiB ([puppeteer#14012](https://github.com/puppeteer/puppeteer/issues/14012)),
and Chromium's own DevTools session buffer is also 256 MiB ("Too large write
data is pending: max_buffer_size=268435456",
[puppeteer#4563](https://github.com/GoogleChrome/puppeteer/issues/4563)) — so
the true hard ceiling today is ~256 MB/message minus base64+JSON overhead,
with 100 MB the safe planning number across the version matrix. Raising caps
treats the symptom; base64-JSON framing of raw frames is the disease.

**exposeFunction / evaluate serialization is the slow path.** Data crosses CDP
via `JSON.stringify`; large `Uint8Array`s serialize as `{0:n,1:n,...}` (~12×
blowup — TrailCut's own measurement, `index.ts:483–486`; community measurement
~1 s/call for large buffers, [puppeteer#4311](https://github.com/puppeteer/puppeteer/issues/4311)).
The standard community answer for bulk binary: **open a parallel WebSocket from
the page to the Node process and send `ArrayBuffer`s** —
[puppeteer#3722](https://github.com/puppeteer/puppeteer/issues/3722),
[intoli: saving images from a headless browser](https://intoli.com/blog/saving-images/).
This keeps CDP for control (`__applyFrame` handshake unchanged) and moves only
pixels to a channel with no payload cap, no base64 (+33% size, ~30–40 ms/frame
encode at 1080p, scaling linearly to ~120–160 ms at 4K slots), and native
backpressure. Note puppeteer itself recently optimized its base64 decode path
([puppeteer commit 8145dd6](https://github.com/puppeteer/puppeteer/commit/8145dd64f21ca7ab917c9c75fe51d04a9463b552))
— the Node-side decode was never the bottleneck; the page-side encode and the
wire inflation are.

**`--remote-debugging-pipe`** swaps the WebSocket for fd 3/4 pipes; it removes
the ws-library cap but keeps CDP's JSON framing, and has documented stderr/
backpressure quirks ([puppeteer#14062](https://github.com/puppeteer/puppeteer/issues/14062)).
Not a fidelity or architecture win.

**`HeadlessExperimental.beginFrame`** is the theoretically-cleanest frame
control: it replaces Chromium's internal vsync (BeginFrame) signal so you
*request* frames, with virtual-clock advancement of `setTimeout`/`rAF`/CSS
animations and byte-identical output
([CDP HeadlessExperimental docs](https://chromedevtools.github.io/devtools-protocol/tot/HeadlessExperimental/),
[headless-dev: rendering control](https://groups.google.com/a/chromium.org/g/headless-dev/c/S5CoLs46AiE)).
**Disqualifier**: per the author of puppeteer-capture, "Linux and Windows.
macOS is not supported" — beginFrame behaves differently on macOS and
deterministic-mode flags are unreliable there; it also requires headless-shell,
which has no macOS GPU path
([Why I built puppeteer-capture](https://alexey-pelykh.com/blog/why-i-built-puppeteer-capture/)).
TrailCut ships to macOS first ⇒ beginFrame is off the table, and TrailCut's
app-level time control (`setNow` + per-frame idle waits) is the correct
substitute. This **independently validates the current design** rather than
indicting it.

**WebCodecs `VideoEncoder` in-page.** Mature in 2025: hardware encode via
VideoToolbox/NVENC/VAAPI/QSV with zero-copy `VideoFrame`-from-canvas, ~200 fps
1080p H.264 on a 2018 MBP, muxed client-side by
[Mediabunny](https://mediabunny.dev/) (successor to mp4-muxer/webm-muxer,
[migration note](https://vanilagy.github.io/mp4-muxer/MIGRATION-GUIDE.html)).
Sources: [Chrome WebCodecs guide](https://developer.chrome.com/docs/web-platform/best-practices/webcodecs),
[w3c/webcodecs#492 (HW accel)](https://github.com/w3c/webcodecs/issues/492),
[freecodecamp WebCodecs handbook](https://www.freecodecamp.org/news/the-webcodecs-handbook-native-video-processing-in-the-browser/).
**Why it's wrong for TrailCut's map stream**: hardware H.264/HEVC encoders take
RGBA `VideoFrame`s but convert to 4:2:0 internally — the decoration-crispness
problem would be reimported *upstream* of FFmpeg compositing, before the
4:4:4 10-bit overlay stage (`filtergraph.rs:718–742`) ever sees the pixels.
That violates the no-leveling-down constraint. (WebCodecs 4:4:4 profiles are
not reliably available on hardware paths.) Second disqualifier: WebCodecs has
**no HDR encode path** — `VideoColorSpace` covers BT.601/BT.709; PQ/HLG
transfer support has been an open spec issue since 2021
([w3c/webcodecs#384](https://github.com/w3c/webcodecs/issues/384)) — so an
in-page-encoded map stream could never carry HDR-adjacent metadata anyway.
In-page encode is only appropriate when the browser output *is* the final
video — which is exactly the Mapbox/Replit/maplibre-gl-video-export use case
below, and not TrailCut's.

**WebGL2 async readback (PIXEL_PACK_BUFFER + fenceSync + getBufferSubData)**
eliminates the CPU stall of synchronous `readPixels`
([MDN WebGL best practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices),
[three.js#22779](https://github.com/mrdoob/three.js/issues/22779)). Caveat for
TrailCut: the current capture *must* be synchronous inside the `'render'` event
because `preserveDrawingBuffer:false` lets the compositor clear the buffer
afterwards (`page/init.ts:545–551`, verified all-zero reads). An async PBO read
*initiated* inside the render handler (readPixels-into-PBO is the cheap part;
the fence/`getBufferSubData` completes later) is the correct shape if readback
ever shows up in the per-frame profile — currently it does not (the profile is
dominated by render + base64 + CDP, `index.ts:914–923` summary line).

### 1.3 Color management of each extraction path

- **`gl.readPixels` returns raw framebuffer bytes** — sRGB-encoded values with
  *no* color-profile conversion applied. WebGL's
  `drawingBufferColorSpace` defaults to `'srgb'` (`'display-p3'` available
  since Chrome 104) —
  [MDN drawingBufferColorSpace](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/drawingBufferColorSpace),
  [ccameron p3 examples](https://ccameron-chromium.github.io/webgl-examples/p3.html).
  This is the *deterministic* path: bytes in the buffer are bytes on the wire.
  TrailCut's comment "skips the entire Chrome screenshot color-management
  pipeline" (`page/init.ts:629–630`) is correct.
- **`Page.captureScreenshot` is color-managed**: Chrome converts through the
  (virtual) display profile. In headless there is no physical monitor and
  Chrome screenshots in sRGB, but the universally-recommended hardening is
  `--force-color-profile=srgb` so output never depends on host configuration —
  [kevdees: washed-out Chrome screenshot colors](https://kevdees.com/how-to-fix-washed-out-colors-in-google-chrome-screenshots-for-clear-and-accurate-images),
  [puppeteer#1699 (screenshots differ across displays)](https://github.com/GoogleChrome/puppeteer/issues/1699).
  **Gap found**: TrailCut's launch args (`index.ts:293–306`) do *not* include
  `--force-color-profile=srgb`. The default readpixels path is immune, but the
  PNG escape hatch (used "for parity comparisons", `index.ts:57–59`) is
  host-profile-dependent — a parity comparison run on a P3 MacBook panel could
  mislead. One launch arg closes it.
- **The SSAA downsample hop** runs through a 2D canvas (`drawImage` +
  `getImageData`, `page/init.ts:675–691`). 2D canvas backing default is sRGB
  ([WICG canvas-color-space proposal](https://github.com/WICG/canvas-color-space/blob/main/CanvasColorSpaceProposal.md))
  so no gamut shift, but two real caveats: (1) it is a **gamma-space resample**
  — deliberate, documented as matching the preview compositor
  (`page/init.ts:271`), and consistent with the perceived-parity goal even
  though linear-light resampling is mathematically "more correct"; (2)
  `getImageData` **un-premultiplies alpha** (WebGL canvases are
  premultiplied-alpha by default), which quantizes color in low-alpha pixels —
  exactly the anti-aliased decoration edges. At factor 2–3 SSAA the error is
  sub-LSB in practice, but if decoration-edge fringing is ever observed at the
  map's transparent edges, this hop is the suspect; a WebGL-side downsample
  (render-to-texture + minification sample, readPixels of the small FBO)
  removes both the un-premultiply and the 2D-canvas dependency.
- **HDR**: HTML canvas HDR (`rec2100-hlg` / `rec2100-pq` / float16 backing) is
  still **experimental behind flags** in Chrome as of 2025–2026
  ([chromestatus: HDR for HTMLCanvasElement](https://chromestatus.com/feature/5703719636172800),
  [W3C ColorWeb-CG HDR canvas draft](https://github.com/w3c/ColorWeb-CG/blob/main/hdr_html_canvas_element.md);
  WebGPU's `GPUCanvasToneMappingMode 'extended'` is further along —
  [Chrome 129 WebGPU notes](https://developer.chrome.com/blog/new-in-webgpu-129)).
  Consequence: the map renderer **cannot natively emit HDR frames** for the
  foreseeable future — Remotion states it flatly for the same stack: "Remotion
  uses a headless Chrome browser to render, which does not support HDR.
  Frames are always rendered in sRGB"
  ([Remotion HDR docs](https://www.remotion.dev/docs/hdr)). Map frames are SDR
  sRGB graphics entering an HDR-HLG composite, and the correct handling is the
  already-identified BT.2408 reference-white anchoring (`zscale npl=203`; see
  memory `project_hdr_map_reference_white`) on the FFmpeg side. The renderer's job is
  to deliver *clean tagged sRGB*; HDR adaptation belongs in the filtergraph.
  This is a deep-module boundary worth preserving in any rewrite.

---

## 2. Edge crispness through video encode

### 2.1 Mechanics — when 4:2:0 blur is inherent

4:2:0 stores chroma at quarter resolution (half each axis). On natural video
this is near-invisible; on **saturated anti-aliased vector edges and small
text** it is the classic "fuzzy colored edge" failure — "full 4:4:4 sampling is
required for pixel-perfect text"
([testufo chroma demo](https://testufo.com/chroma),
[displayninja explainer](https://www.displayninja.com/chroma-subsampling/),
[Wikipedia: chroma subsampling](https://en.wikipedia.org/wiki/Chroma_subsampling)).
Every mainstream delivery codec config (H.264 High, HEVC Main/Main10, and what
YouTube/Instagram/TikTok re-encode to) is 4:2:0 — including HDR (10-bit 4:2:0)
([YouTube upload encoding settings](https://support.google.com/youtube/answer/1722171?hl=en)
recommends 4:2:0). **So yes: the blur at final delivery is inherent.** The
question is only how much is lost *before* and *at* that single conversion.

### 2.2 What TrailCut already does right (verify, don't redo)

- Composite in 4:4:4 10-bit: map + video lifted to `yuva444p10le` pre-overlay
  (`filtergraph.rs:171,339,718–720,739–742`).
- Pin `overlay=...:format=yuv444p10` because FFmpeg's overlay filter otherwise
  silently converts inputs to its yuv420 internal format — chroma destroyed
  *before* the user ever chose a delivery format (`filtergraph.rs:721–727`;
  matches memory `feedback_ffmpeg_filter_empirical_validation`: textual
  filtergraph review can't see auto-inserted scalers; `-loglevel verbose`
  dry-runs required).
- Single 444→420 conversion at the very end (`format={pix}` at
  `filtergraph.rs:735,747,777,789`).
- This matches the screen-recording/motion-graphics community's canonical
  pipeline: keep RGB/4:4:4 as long as possible, subsample exactly once
  ([ffmpeg-devel: prefer 444 intermediates](https://ffmpeg-devel.ffmpeg.narkive.com/AiUbBKza/select-the-right-format)).

### 2.3 Remaining levers (ordered by leverage)

1. **Quality of the single 444→420 chroma downsample.** swscale's default
   chroma resampler is mediocre; zscale (libzimg, already a hard dependency —
   `CLAUDE.md` dev deps, `tests/color_fixtures.rs` `assert_ffmpeg_has_zscale`)
   does proper filtered subsampling with explicit chroma siting and dithering.
   The Academy Software Foundation's encoding guidelines are the authoritative
   reference: for RGB→Y'CbCr downsampling use `-sws_flags lanczos+accurate_rnd`
   (or spline for chroma ops), enable `full_chroma_int` ("full 4:4:4 internal
   processing… higher visual quality at a relatively small speed penalty"), and
   note zscale produces "slightly improved if occasionally softer" results vs
   swscale for 4:2:0
   ([ASWF EncodeSwsScale](https://academysoftwarefoundation.github.io/EncodingGuidelines/EncodeSwsScale.html)).
   Memory note `project_decoration_crispness_levers` already records "pipeline-
   side HQ subsample recovers ~25%". This is the cheap, already-identified win.
2. **Deliver at higher resolution.** At 4K 4:2:0, the chroma plane is
   1920×1080 — i.e., *full-resolution chroma relative to a 1080p frame*.
   Platforms also grant 4K uploads materially higher bitrate ladders
   ([streamguides upload-quality investigation](https://streamguides.gg/2024/03/youtube-upload-quality-investigation-does-source-codec-matter/),
   [zebgardner 2026 upload settings](https://www.zebgardner.com/photo-and-video-editing/2026-update-best-upload-settings-for-youtube)).
   TrailCut's lever model already makes resolution a pure pixel-density knob
   (`MAP_RENDERING_PLAN.md:55–84`), so "render the 4K ladder rung" is the
   product-shaped mitigation for chroma-sensitive decoration styles.
3. **Encoder settings for graphics content.** For x264: lower CRF for
   synthetic edges (graphics punish quantization more than film; sane range
   18–28, go toward 16–18 for overlay-heavy content —
   [slhck CRF guide](https://slhck.info/video/2017/02/24/crf-guide.html));
   `-tune stillimage`/psnr-style tuning preserves text/edge sharpness better
   than default psy settings, `-tune animation` suits flat-color content (it
   raises deblocking strength + reference frames, which preserves sharp edges;
   screen-recording guidance converges on CRF 15–18 for text-heavy content)
   ([mpegflow CRF-by-content](https://www.mpegflow.com/topics/encoding/ffmpeg-crf-tuning-by-content),
   [x264 settings reference](https://en.wikibooks.org/wiki/MeGUI/x264_Settings),
   [piratebosun OBS/x264 settings](https://piratebosun.com/x264-settings/)).
   Caveat: tunes apply to the whole frame — TrailCut frames are hybrid
   (natural video + graphics), so per-target CRF floors are safer than tune
   flags; treat tunes as an A/B experiment, not a default.
4. **What is NOT worth doing**: 4:4:4 delivery profiles (H.264 High 4:4:4
   Predictive) have no hardware-decode support and social platforms re-encode
   to 4:2:0 anyway; decoration-side fixes (keylines, glows) were already
   evaluated and rejected on looks (memory `project_decoration_crispness_levers`
   — do not redo).

---

## 3. Ecosystem precedent: is headless-browser MapLibre video export normal?

**Yes — it is the established pattern, including by Mapbox itself.**

- **Mapbox's own video tooling**: `debug/video-export.html` in mapbox-gl-js
  ([source](https://github.com/mapbox/mapbox-gl-js/blob/main/debug/video-export.html),
  landed via [PR #10172 by Volodymyr Agafonkin (mourner)](https://github.com/mapbox/mapbox-gl-js/pull/10172))
  renders "1920x1080 60fps, buttery smooth zero-jank video" by **hijacking GL
  JS's `browser.now` utility, "making it grow with 60fps-adjusted fixed
  increments on every frame"**, and encoding **in-page** with @mattdesl's WASM
  mp4-h264 encoder. `setNow`/`restoreNow` were exposed in the production build
  specifically for this. Transport: none — the MP4 is assembled in the page.
  The original feature request is
  [mapbox-gl-js#5297](https://github.com/mapbox/mapbox-gl-js/issues/5297).
- **MapLibre inherited and formalized the API**: maplibre-gl-js **v5.11.0**
  added the official time-control API (`setNow` / `restoreNow` /
  `isTimeFrozen`) "for deterministic rendering, enabling frame-by-frame video
  export and deterministic testing"
  ([MapLibre newsletter Nov 2025](https://maplibre.org/news/2025-12-02-maplibre-newsletter-november-2025/),
  [setNow docs](https://maplibre.org/maplibre-gl-js/docs/API/functions/setNow/),
  [restoreNow](https://maplibre.org/maplibre-gl-js/docs/API/functions/restoreNow/)).
  TrailCut is on `maplibre-gl ^5.22.0` (`package.json`) — i.e., the page-side
  `maplibregl.setNow(frame.t)` call (`page/init.ts:777`) sits on the official,
  documented API, not a private hook. The broader time-source discussion is
  [maplibre-gl-js#114](https://github.com/maplibre/maplibre-gl-js/issues/114).
- **maplibre-gl-video-export** (community plugin, listed on the official
  MapLibre plugins page): exports map animations to WebM VP9 / VP8 / MP4 H.264
  by reading the WebGL canvas "at exact time intervals" and explicitly "uses
  `setNow()` for deterministic frame-by-frame rendering"; encoding happens
  in-page via mediabunny / webm-wasm / mp4-h264
  ([bjperson/maplibre-gl-video-export](https://github.com/bjperson/maplibre-gl-video-export),
  [MapLibre plugins](https://maplibre.org/maplibre-gl-js/docs/plugins/)).
  Same stepping model as TrailCut; in-page lossy encode instead of raw
  readback (fine for its use case, below TrailCut's quality bar).
- **Mapbox's impact-tools route animations** (Mapbox blog): cinematic route
  videos are produced by FreeCamera-driven per-frame stepping with
  `gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)`
  feeding the mp4-encoder JS library, with the `line-gradient` paint property
  animating route reveal and lerp smoothing for camera jitter
  ([Mapbox: building cinematic route animations](https://www.mapbox.com/blog/building-cinematic-route-animations-with-mapboxgl)).
  This is *Mapbox themselves* using the exact readPixels-per-frame capture
  TrailCut uses — and even the same `line-gradient` reveal technique as
  TrailCut's slime trail.
- **Remotion** (the dominant programmatic-video tool) renders React in headless
  Chromium via puppeteer screenshots ([renderFrames docs](https://www.remotion.dev/docs/renderer/render-frames)),
  recommends full Chrome-for-Testing over headless-shell when GPU is needed
  ([Remotion GPU docs](https://www.remotion.dev/docs/gpu)) — same conclusion
  TrailCut reached at `index.ts:7–12`. Its **official MapLibre example**
  ([remotion-dev/maplibre-example](https://github.com/remotion-dev/maplibre-example))
  uses `interactive:false`, `fadeDuration:0`, `delayRender()/continueRender()`
  around tile loads, `--concurrency=1`, and Turf-based route slicing — a less
  rigorous version of exactly TrailCut's design (TrailCut adds `setNow`,
  transition-kill, and idle-await, which the Remotion example lacks).
- **Replit's renderer** (2025): JS shim virtualizing `setTimeout/rAF/Date/
  performance.now` advancing `1000/fps` per frame, screenshot-based capture in
  chrome-headless-shell, WebCodecs+mp4box.js for embedded video elements
  ([Browsers don't want to be cameras](https://replit.com/blog/browsers-dont-want-to-be-cameras)),
  crediting WebVideoCreator's beginFrame work.
- **timecut/timesnap** ([tungs/timecut](https://github.com/tungs/timecut)):
  the long-standing OSS approach — overwrite the page's time functions
  (timeweb), screenshot per virtual tick, pipe to FFmpeg.
- **puppeteer-capture** ([why built](https://alexey-pelykh.com/blog/why-i-built-puppeteer-capture/)):
  beginFrame-based, byte-identical output — **Linux/Windows only**, headless-
  shell only.
- **Native (non-browser) alternative**: maplibre-native Node bindings
  ([@maplibre/maplibre-gl-native](https://www.npmjs.com/package/@maplibre/maplibre-gl-native),
  [consbio/mbgl-renderer](https://github.com/consbio/mbgl-renderer),
  [pymgl](https://github.com/brendan-ward/pymgl)) do server-side *static*
  rendering; none target frame-sequence video. The bindings are actively
  maintained (new npm releases in 2025; parallel Rust bindings are being
  built up for server-side rasterization in Martin —
  [MapLibre newsletter Sep 2025](https://maplibre.org/news/2025-10-04-maplibre-newsletter-september-2025/),
  [node README](https://github.com/maplibre/maplibre-native/blob/main/platform/node/README.md)). TrailCut already ran this road:
  the C++ engine produced sub-pixel pan wobble on raster ("tasks 010–117",
  `index.ts:14–19`), and the recent native spike found the **vector** basemap
  jitter-free at 4K (memory `project_native_renderer_jitter_spike` — GO on
  vector, painterPatch is raster-only). So maplibre-native remains a live
  *future* option for the vector style specifically, with the major caveat
  that it abandons "visual parity by import" (`index.ts:21–25`) — the
  mapVisuals single-source-of-truth contract is only free while preview and
  export both run maplibre-gl-**js**.

**Net**: nobody has a materially better architecture for "MapLibre GL JS,
frame-accurate, GPU, macOS". The differentiator across projects is what
happens to the pixels *after* render: in-page encode (Mapbox, WebCodecs
pipelines — fine when browser output is final), screenshot+FFmpeg (Remotion,
timecut, Replit), or TrailCut's raw-RGBA-to-FFmpeg (highest fidelity, needed
because compositing happens downstream). TrailCut's choice is the right one
for its quality bar; only the framing of the bytes (base64/CDP) is
non-state-of-the-art.

---

## 4. Deterministic frame stepping in MapLibre — best practice

Best practice as established by Mapbox PR #10172, MapLibre docs, and the
render-test suite ([MapLibre native render tests](https://maplibre.org/maplibre-native/docs/book/render-tests.html),
[maplibre-gl-js#1007 on test flakiness](https://github.com/maplibre/maplibre-gl-js/issues/1007)):

1. **Freeze the clock** with `setNow(t)` per frame — TrailCut: `page/init.ts:777`. ✔
2. **Disable fades/transitions**: `fadeDuration: 0` at construction ✔
   (`page/init.ts:347`); but stylesheet `transition.duration=0` alone does NOT
   neutralize paint transitions (TrailCut documented the
   `TransitioningPropertyValue` precedence quirk, `page/init.ts:377–390`) —
   hence the per-layer `updateTransitions` monkey-patch (`:400–425`), the
   light/sky patch (`:416–425`), and `setRasterFadeDuration(0)` (`:437–443`).
   These go *beyond* documented practice into private internals — necessary
   (the idle-deadlock is real) but **version-coupled**: any maplibre-gl upgrade
   can silently break `_transitionablePaint`/`tileManagers` shapes.
3. **Drive the camera with `jumpTo`** (never `easeTo`/`flyTo`) and compute
   per-frame camera externally ✔ (`page/init.ts:810–815`; camera math in
   `src/lib/cameraIntent.ts`, shared with preview).
4. **Await completion** via `triggerRepaint` + `once('idle')` + 1 rAF ✔
   (`page/init.ts:830–897`). The Remotion example's `delayRender/continueRender`
   is the same idea with less precision.
5. **Pixel validity window**: read inside the `'render'` event with
   `preserveDrawingBuffer:false` ✔ (`page/init.ts:538–584`) — TrailCut's
   empirical findings here (post-idle reads return zeros;
   `preserveDrawingBuffer:true` hangs first render) are more rigorous than
   anything published; this knowledge is a gem to preserve verbatim in any
   rewrite.

**Gap vs best practice**: none functional. Risk item: the private-internals
patches (#2) plus `painterPatch.ts` lack a canary — a pinned-version
assumption with no test that fails loudly on upgrade (cf. memory
`feedback_loud_test_failures`). A small test that constructs a Map against the
bundled maplibre-gl and asserts `hasTransitions() === false` after patching
(and that `updateTransitions`/`tileManagers`/`_transitionablePaint` still
exist) converts a silent-divergence risk into a loud one.

---

## 5. Consolidated recommendations

1. **Keep the architecture** (full headless Chrome + setNow + readPixels-in-
   render-event + FFmpeg compositing). It is ecosystem-validated; beginFrame
   is macOS-unsupported; maplibre-native breaks the mapVisuals parity-by-import
   contract. In the rewrite-vs-cleanup verdict, this subsystem is a *deep
   module already* — its stdin/stdout protocol is simple, its internals encode
   hard-won empirical knowledge (Promise-GC handshake, render-event readback
   window, transition deadlock). Do not start it over.
2. **Transport**: replace base64-RGBA-over-CDP with a binary WebSocket
   side-channel (page → Node `ws` server, `ArrayBuffer` frames). Removes the
   100 MB/frame ceiling, the +33% wire inflation, and the ~30–40 ms+/frame
   base64 encode; CDP remains control-plane only. Keep the existing handshake
   semantics (frame send acknowledged before next render cmd) for backpressure.
3. **Color hardening**: add `--force-color-profile=srgb` to launch args so the
   PNG escape-hatch/parity path stops depending on host display profile. The
   readpixels path is already deterministic; leave it alone.
4. **HDR boundary**: canvas HDR is still flag-gated experimental — do not plan
   on the renderer emitting HLG. Keep "renderer emits tagged sRGB; filtergraph
   adapts to working space with npl=203 ref-white anchoring" as an explicit
   module contract.
5. **Crispness**: the 4:2:0 delivery blur is inherent; the 4:4:4 10-bit
   intermediate + pinned `overlay:format=yuv444p10` is already correct. Spend
   remaining effort on (a) zscale-quality 444→420 subsampling with explicit
   chroma siting + dither at the single delivery conversion, (b) offering the
   4K ladder rung for decoration-heavy exports, (c) optional per-target CRF
   floor for graphics-heavy frames. Do not pursue 4:4:4 delivery or
   decoration-side redesigns (already rejected).
6. **Determinism canary**: add a loud test pinning the maplibre-gl private
   internals the transition/painter patches touch (fails on upgrade, not in
   production). Consider upstreaming a `transitions: false` map option to
   MapLibre — the monkey-patch is exactly the kind of thing
   [maplibre-gl-js#114](https://github.com/maplibre/maplibre-gl-js/issues/114)
   contemplates.
7. **If readback ever profiles hot**: move SSAA downsample from the 2D-canvas
   hop to a WebGL render-to-texture minification (also eliminates the
   premultiplied-alpha un-premultiply on decoration edges), and/or initiate a
   PIXEL_PACK_BUFFER async read inside the render event. Neither is currently
   the bottleneck.

---

## Appendix: all sources

**Local files (load-bearing lines):**
- `MAP_RENDERING_PLAN.md` (lever model :55–84; decisions :86–92)
- `src-tauri/sidecars/renderer/index.ts` (:7–25 rationale; :54–61 transport
  flag; :99–130 protocol; :283–306 launch args; :478–494 100 MB atlas
  incident; :849–904 readback paths; :949–954 stdout framing)
- `src-tauri/sidecars/renderer/page/init.ts` (:263–310 SSAA state; :340–354
  Map construction; :377–444 transition/raster-fade patches; :538–584
  render-event readback rationale; :631–642 bytesToBase64; :666–760 capture;
  :777 setNow; :830–897 idle+rAF)
- `src-tauri/src/export/layout.rs` (:136–173 SSAA factor; :550–559 tiers)
- `src-tauri/src/export/filtergraph.rs` (:171,339,659–742,777–789 4:4:4
  compositing & pinned overlay format; :462–463 delivery regimes)

**Web:**
- Headless capture: [copyprogramming guide](https://copyprogramming.com/howto/headless-chrome-capture-screen-video-or-animation) · [headless-dev screencast thread](https://groups.google.com/a/chromium.org/g/headless-dev/c/6XKLTi5bsZA) · [headless-dev screenshot-slow thread](https://groups.google.com/a/chromium.org/g/headless-dev/c/aVZw00nzxTU) · [Chrome headless docs](https://developer.chrome.com/docs/chromium/headless)
- CDP limits/serialization: [puppeteer#4543](https://github.com/puppeteer/puppeteer/issues/4543) · [puppeteer#5598](https://github.com/puppeteer/puppeteer/issues/5598) · [puppeteer#4311](https://github.com/puppeteer/puppeteer/issues/4311) · [puppeteer#3722](https://github.com/puppeteer/puppeteer/issues/3722) · [puppeteer#14062 (pipe)](https://github.com/puppeteer/puppeteer/issues/14062) · [puppeteer#14012 (maxPayload 256 MiB)](https://github.com/puppeteer/puppeteer/issues/14012) · [puppeteer#4563 (Chromium 256 MiB buffer)](https://github.com/GoogleChrome/puppeteer/issues/4563) · [chrome-remote-interface#522](https://github.com/cyrus-and/chrome-remote-interface/issues/522) · [intoli saving-images](https://intoli.com/blog/saving-images/)
- beginFrame/determinism: [CDP HeadlessExperimental](https://chromedevtools.github.io/devtools-protocol/tot/HeadlessExperimental/) · [headless-dev rendering control](https://groups.google.com/a/chromium.org/g/headless-dev/c/S5CoLs46AiE) · [puppeteer-capture rationale](https://alexey-pelykh.com/blog/why-i-built-puppeteer-capture/) · [Replit renderer blog](https://replit.com/blog/browsers-dont-want-to-be-cameras) · [tungs/timecut](https://github.com/tungs/timecut) · [tungs/timesnap](https://github.com/tungs/timesnap)
- WebCodecs/muxing: [Chrome WebCodecs guide](https://developer.chrome.com/docs/web-platform/best-practices/webcodecs) · [MDN WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API) · [w3c/webcodecs#492](https://github.com/w3c/webcodecs/issues/492) · [w3c/webcodecs#384 (HDR gap)](https://github.com/w3c/webcodecs/issues/384) · [Mediabunny](https://mediabunny.dev/) · [mp4-muxer migration](https://vanilagy.github.io/mp4-muxer/MIGRATION-GUIDE.html) · [WebCodecs handbook](https://www.freecodecamp.org/news/the-webcodecs-handbook-native-video-processing-in-the-browser/)
- Color: [MDN drawingBufferColorSpace](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/drawingBufferColorSpace) · [WICG canvas-color-space](https://github.com/WICG/canvas-color-space/blob/main/CanvasColorSpaceProposal.md) · [kevdees force-color-profile](https://kevdees.com/how-to-fix-washed-out-colors-in-google-chrome-screenshots-for-clear-and-accurate-images) · [puppeteer#1699](https://github.com/GoogleChrome/puppeteer/issues/1699) · [chromestatus HDR canvas](https://chromestatus.com/feature/5703719636172800) · [W3C ColorWeb-CG HDR draft](https://github.com/w3c/ColorWeb-CG/blob/main/hdr_html_canvas_element.md) · [Chrome 129 WebGPU HDR](https://developer.chrome.com/blog/new-in-webgpu-129) · [Remotion HDR docs](https://www.remotion.dev/docs/hdr)
- Chroma/encoding: [testufo chroma](https://testufo.com/chroma) · [displayninja](https://www.displayninja.com/chroma-subsampling/) · [Wikipedia chroma subsampling](https://en.wikipedia.org/wiki/Chroma_subsampling) · [ASWF EncodeSwsScale guidelines](https://academysoftwarefoundation.github.io/EncodingGuidelines/EncodeSwsScale.html) · [ffmpeg-devel 444 intermediates](https://ffmpeg-devel.ffmpeg.narkive.com/AiUbBKza/select-the-right-format) · [slhck CRF guide](https://slhck.info/video/2017/02/24/crf-guide.html) · [mpegflow CRF by content](https://www.mpegflow.com/topics/encoding/ffmpeg-crf-tuning-by-content) · [piratebosun OBS x264](https://piratebosun.com/x264-settings/) · [YouTube upload settings](https://support.google.com/youtube/answer/1722171?hl=en) · [streamguides upload investigation](https://streamguides.gg/2024/03/youtube-upload-quality-investigation-does-source-codec-matter/) · [zebgardner 2026 settings](https://www.zebgardner.com/photo-and-video-editing/2026-update-best-upload-settings-for-youtube)
- Precedent: [mapbox-gl-js PR#10172](https://github.com/mapbox/mapbox-gl-js/pull/10172) · [mapbox video-export.html](https://github.com/mapbox/mapbox-gl-js/blob/main/debug/video-export.html) · [mapbox-gl-js#5297](https://github.com/mapbox/mapbox-gl-js/issues/5297) · [Mapbox cinematic route animations blog](https://www.mapbox.com/blog/building-cinematic-route-animations-with-mapboxgl) · [MapLibre setNow](https://maplibre.org/maplibre-gl-js/docs/API/functions/setNow/) · [restoreNow](https://maplibre.org/maplibre-gl-js/docs/API/functions/restoreNow/) · [MapLibre newsletter Nov 2025 (v5.11.0 time API)](https://maplibre.org/news/2025-12-02-maplibre-newsletter-november-2025/) · [maplibre-gl-js#114](https://github.com/maplibre/maplibre-gl-js/issues/114) · [bjperson/maplibre-gl-video-export](https://github.com/bjperson/maplibre-gl-video-export) · [MapLibre plugins page](https://maplibre.org/maplibre-gl-js/docs/plugins/) · [remotion-dev/maplibre-example](https://github.com/remotion-dev/maplibre-example) · [Remotion renderFrames](https://www.remotion.dev/docs/renderer/render-frames) · [Remotion GPU](https://www.remotion.dev/docs/gpu) · [@maplibre/maplibre-gl-native](https://www.npmjs.com/package/@maplibre/maplibre-gl-native) · [maplibre-native node README](https://github.com/maplibre/maplibre-native/blob/main/platform/node/README.md) · [MapLibre newsletter Sep 2025 (native maintenance)](https://maplibre.org/news/2025-10-04-maplibre-newsletter-september-2025/) · [consbio/mbgl-renderer](https://github.com/consbio/mbgl-renderer) · [Mapbox GL Director](https://medium.com/devseed/add-flyover-to-any-app-with-mapbox-gl-director-d8d523dab2e1)
- Async readback: [MDN WebGL best practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices) · [three.js#22779](https://github.com/mrdoob/three.js/issues/22779) · [MDN getBufferSubData](https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext/getBufferSubData)
