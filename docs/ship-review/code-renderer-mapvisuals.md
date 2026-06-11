# Ship review — Headless map renderer sidecar + shared mapVisuals module

**Scope:** `src-tauri/sidecars/renderer/` (index.ts 1089 ln, page/init.ts 926 ln, painterPatch.ts,
tileCache.ts, trailcutFetch.ts, bootstrap.html.ts, `__tests__/`) and `src/lib/mapVisuals/`
(styleSpec.ts 631 ln, perFrame.ts 164 ln, paints.ts 290 ln, shapes.ts 920 ln, sources.ts 339 ln,
animations.ts 155 ln, types.ts 142 ln, index.ts 57 ln), plus `src/components/MapView.tsx` (748 ln)
as the preview consumer and the Rust side of the protocol
(`src-tauri/src/export/protocol.rs`, `export/mod.rs::build_setup_payload`, `export/layout.rs`).

**Date:** 2026-06-11. **Branch at audit:** `feat/control-panel` (working tree includes uncommitted
changes to shapes.ts, init.ts, index.ts — the audited state is the working tree).

**Question:** Is this pair (the preview/export-parity backbone) deep-module engineering or
accumulated patch soup? Does the mapVisuals single-source-of-truth contract actually hold?

**Verdict up front:** This is one of the deepest, most battle-hardened subsystems in the codebase.
The contract genuinely holds (verified by grep, §2). The sidecar protocol is sound and unusually
well-tested (§3). The shape rasterizers are crisp analytical engineering, not patches (§5).
**But** the audit found one high-severity latent bug (fractional `pixelRatio` breaks the SDF icon
atlas at the 1440p export tier, §6.1), one confirmed parity-invariant violation
(`override_secondary_color` dropped in visited mode, §6.2), and one suspected preview/export
divergence in the anti-jitter patching (§6.3). Salvage grade: **keep-with-cleanup**.

---

## 1. Architecture summary (what actually exists)

The export map renderer is a long-running Node sidecar (`renderer/index.ts`) driving a full
headless Chrome (puppeteer ≥22 new headless mode, ANGLE→Metal on macOS —
`index.ts:278-336`) that runs maplibre-gl-js in a page (`page/init.ts`). Wire protocol with the
Rust orchestrator: line-delimited JSON commands on stdin (`setup` / `render` / `recycle` /
`shutdown`), and on stdout `{"ready":true}\n` replies plus `[4-byte BE length][N bytes RGBA]`
frames (`index.ts:945-954`; Rust mirror `src-tauri/src/export/protocol.rs:7-11,142-151`).

The "visual parity by import" invariant is stated at `index.ts:21-25`:

> Every visual decision (style spec, layer specs, source data, animation curves, camera math)
> lives in src/lib/mapVisuals/ … This worker imports the same modules the preview's MapView.tsx
> uses; it never redefines them.

And it does: `index.ts:70-91` imports `buildStyleSpec`, `buildStaticSourceData`,
`buildPerFrameState`, `resolveStaticPaints`, all layer specs, and `outlineThicknessCanvasPx` from
`src/lib/mapVisuals`; the page bundle imports `buildAllShapeIcons` from the same `shapes.ts` the
preview uses (`page/init.ts:34`).

Module roles inside mapVisuals:

- `styleSpec.ts` — style/layer specs (all size literals are explicit PLACEHOLDERs, e.g.
  `ROUTE_FULL_LAYER` line-width `1` at `styleSpec.ts:117-127`) + `resolveStaticPaints(mapSettings)`
  returning `{paints, layouts, gradients}` **tuples** (`styleSpec.ts:373-395, 402-578`).
- `perFrame.ts` — `buildPerFrameState(timeline, t, …) → {camera, sources, paints}`; pure; the
  stated contract is "single source of truth for what the map looks like at project-time t"
  (`perFrame.ts:5-12`).
- `paints.ts` — per-frame data-driven expressions (3-arm color cases, halo, sort keys, pulse).
- `sources.ts` — static + per-frame GeoJSON builders (route-full, route-trail, waypoints,
  live-marker), active-waypoint selection.
- `shapes.ts` — analytical SDF rasterizers for waypoint/POV shapes (circle/ring/pin/square/diamond).
- `animations.ts` — pulse styles as pure functions of project-time.
- `index.ts` — explicit public boundary ("Anything not re-exported here is module-private",
  `mapVisuals/index.ts:1-4`).

---

## 2. Does the single-source-of-truth contract hold? YES — verified

Grep of the whole frontend and sidecar for `setPaintProperty` / `setLayoutProperty`
(excluding tests and mapVisuals itself) finds **only**:

- `MapView.tsx:510, 514, 524` — the static apply loop, iterating `resolveStaticPaints()` tuples
  verbatim. The block carries the contract in writing (`MapView.tsx:487-496`): "If you find
  yourself reaching for a new `map.setPaintProperty` … add it to `resolveStaticPaints` instead."
- `MapView.tsx:668-722` — the per-frame apply block, writing **only** fields of
  `state.paints` (the `PaintUpdates` struct from `buildPerFramePaints`). No literal values,
  no ad-hoc derivations.
- `page/init.ts:517, 521, 533` (static seed) and `789, 794, 805` (per-frame) — both iterate
  worker-shipped tuples that were produced by the same `resolveStaticPaints` /
  `buildPerFrameState` calls (`index.ts:511, 730-786`).
- One comment-only mention in `GradientEditor.tsx:9`.

So there is **zero ad-hoc paint/layout writing** on either side. Every MapSettings-derived value
flows through the shared resolvers. Additional parity strengths:

- The renderer re-resolves `resolveStaticPaints` **per frame** against the active clip's merged
  `map_overrides` (`index.ts:699-730`), so per-clip overrides take effect at the cut; preview gets
  the same via the already-resolved `mapSettings` prop (`MapView.tsx:498-502`).
- Camera math runs in the same canonical CSS viewport on both sides: preview resolves intents
  against `outputDims(aspect,'1080p')` (`MapView.tsx:626-641`), renderer against
  `payload.cssViewport` (`index.ts:684-715`), which by construction is the slot scaled to the
  canonical multiplier (`export/mod.rs:510-514`, `export/layout.rs:119-134`).
- SDF icons are rasterized by the **same pure function** on both sides, with the same
  `outlineThicknessCanvasPx(stroke_width, circle_radius)` derivation
  (`MapView.tsx:332-346`, `index.ts:494-497` → `page/init.ts:487-504`).
- The label/outline co-placement decision (one symbol layer so MapLibre treats outline+label as a
  single placement unit) is recorded with its failure history (`styleSpec.ts:201-219`).

**Caveats (not violations, but contract held by comments rather than types):**

- The layer **stacking order** and the **addSource specs** (notably `lineMetrics: true`, which is
  mandatory for `line-gradient` and a silent no-op if added late) are hand-duplicated:
  `MapView.tsx:268-308` vs `index.ts:451-476`. Each side carries a comment promising it matches
  the other. A shared `SOURCE_SPECS` / `LAYER_STACK` export from mapVisuals would close this.
- The per-frame channel is a **named struct** (`PaintUpdates`, `mapVisuals/types.ts:45-113`)
  whose field→(layerId, property) mapping is hand-enumerated twice: `MapView.tsx:661-723`
  (preview apply) and `index.ts:736-779` (renderer translation to wire tuples). The *static*
  channel already solved this with tuples; the per-frame channel didn't get the same treatment.
  Adding one per-frame paint today requires touching paints.ts + types.ts + MapView.tsx +
  renderer/index.ts. This is the main change-amplification hotspot in the pair (§6.4).

---

## 3. Is the stdio/CDP protocol sound? Yes — and the failure-mode engineering is exceptional

**Wire protocol.** Lockstep state machine: each `setup`/`recycle` is answered by a ready line;
each `render` by exactly one length-prefixed RGBA frame (`protocol.rs:7-11`). The worker
serializes commands through a single-flight queue (`index.ts:958-1044`), so ordering is
deterministic. Errors are crash-only: any setup/render failure logs to stderr and
`process.exit(1)` after a 500 ms delay that exists specifically to let Chrome's `dumpio`-forwarded
stderr flush so the orchestrator's stderr ring captures the *root cause*, not just the puppeteer
`ProtocolError` (`index.ts:994-999`). There is no structured error reply on the wire — worker
death is the error signal. Acceptable for a single-purpose sidecar; the orchestrator must (and
does) treat EOF as failure (`protocol.rs:117-140` rejects EOF/malformed/`ready:false` loudly).

**The "Promise was collected" handshake** (`index.ts:163-197, 368-396, 578-615, 818-844`).
puppeteer's `evaluate` sets `awaitPromise: true` on `Runtime.callFunctionOn`; under page heap
pressure V8's Inspector can GC the awaited Promise before observing resolution — the failure
surfaces *after* the page-side function logged completion. The fix: the outer evaluate returns
synchronously (fire-and-forget kickoff of `__init`/`__applyFrame`), completion is signaled back
through an `exposeFunction` (`__signalInitDone` / `__signalApplyFrameDone`) resolving a Node-local
Promise. The comments distinguish the two observable symptoms ("Promise was collected" vs
`Runtime.callFunctionOn timed out`) and identify them as the same root cause. This is a
hard-won, correctly-generalized fix (applied to both init and every frame, with the per-frame
cost quantified at ~1 ms vs ~100 ms render). **Gem.**

**Idle-deadlock kills** (`page/init.ts:366-445`). Three independent maplibre wall-clock
mechanisms would keep `style.hasTransitions()` true forever under a frozen `setNow` clock,
starving the `idle` event `__applyFrame` awaits: (a) paint transitions — the comment documents
why the naive `stylesheet.transition.duration = 0` override does NOT work, down to operator-
precedence quirks in maplibre's `properties.ts:232-240`, and patches each layer's
`updateTransitions` to produce `untransitioned()`; (b) light/sky transition sites (defensive);
(c) raster tile fade (`setRasterFadeDuration(0)`, with the maplibre source line cited).
Each patch names the exact deadlock it prevents. **Gem** — this is the difference between a
renderer that deterministically settles and one that hangs on frame 0.

**Lifecycle.** One Browser per worker, one Page per Browser; orchestrator-driven `recycle`
rebuilds the Page; every 10th recycle relaunches the Browser as layered defense against allocator
fragmentation — invisible on the wire (`index.ts:27-32, 140-148, 640-667`). Liveness telemetry
(`currentActivity` + heartbeat, `index.ts:199-214, 1071-1089`) addresses the real operator
problem that a stalled export and a busy one are both silent.

**Tile fetching.** All page http(s) fetches are rewritten in `transformRequest` (post-placeholder-
interpolation — the doc records why the originally-planned style-JSON walk was wrong,
`trailcutFetch.ts:8-17`) into `trailcut://` URLs served by `addProtocol` → `exposeFunction` →
Node `tileCache`. The cache is content-addressed (sha256(url)), write-once, tempfile+rename
atomic, sharded (`tileCache.ts:1-23, 80-86, 133-141`); the hash-key-parity invariant ("MUST hash
the original URL, not the trailcut:// URL — a regression silently invalidates the cache") has its
own dedicated test (`trailcutFetch.ts:19-22`, `__tests__/trailcutFetch.test.ts`).

**Tests fail loud** (per the project's loud-failure rule): the protocol test throws up front if
the bundles are missing or `TRAILCUT_CHROME_BIN` is unset (`__tests__/protocol.test.ts:136-153`)
— no silent skip. It walks the full setup→render→recycle→render→shutdown state machine,
asserts non-all-zero frames, asserts **byte-identical determinism** for two renders at the same
`project_time_ms` (`protocol.test.ts:231-264`), and proves offline-from-cache rendering with a
second worker under `TRAILCUT_TILE_CACHE_OFFLINE=1` (`protocol.test.ts:266-339`). The Rust side
has mirrored wire-format tests including a guard that the stale pre-lever-model `viewport` key is
absent "so a stale page-side reader fails loudly" (`protocol.rs:228-260`). The shared fixture
builder is single-sourced for the TS and Rust integration tests (`__tests__/setupFixture.ts:1-13`).

---

## 4. Frame transport + fidelity (the lever model in practice)

**Lever model wiring** (per MAP_RENDERING_PLAN.md). Rust computes
`canonical_map_viewport(aspect, slot_w, slot_h, resolution)`:
`multiplier = outputW(resolution)/outputW(1080p)`, `css = round(slot/multiplier)`,
`pixel_ratio = multiplier` (`export/layout.rs:119-134`), then multiplies in the SSAA factor:
`framebuffer = slot × factor`, `readback = slot`, `pixel_ratio = multiplier × factor`
(`export/mod.rs:527-536`), with debug asserts bounding round-trip drift to pr/2
(`export/mod.rs:537-547`). The page sizes the `#map` container at `cssViewport` and passes
`pixelRatio` to the MapLibre constructor (`page/init.ts:336-345`), so zoom semantics are
resolution-invariant — exactly the perceived-scale-invariance constraint. The ≤1 px
framebuffer-rounding drift (e.g. css_h 3413 × 27/128 = 719.93 floored to 719 by Chromium) is
handled by pad/crop in `captureFramebufferIntoBuf` with a one-shot warning that distinguishes
benign ≤1 px from a real viewport bug (`page/init.ts:256-265, 705-759`).

**SSAA.** Factor is tiered in Rust — 3× for slots whose long edge ×3 ≤ 4320, else 2× up to a 7680
GPU edge budget, with tests pinning the tiers (`export/layout.rs:136-182, 550-559`). The
rationale is recorded: the Retina preview was effectively supersampled for free
(devicePixelRatio≈2 + OS downsample), which is what left export edges aliased
(`export/layout.rs:153-172`). The page downsamples on-GPU via a slot-sized 2D canvas
(`drawImage` high-quality smoothing, gamma-space "matching the preview's compositor downsample")
before readback (`page/init.ts:269-310, 669-691`) — so supersampling never inflates the wire,
matching the memory note that frames stay slot-sized under the CDP ~100 MB cap.

**Readback path.** Default transport is `readpixels`: `gl.readPixels` runs **synchronously inside
maplibre's `'render'` event** because with `preserveDrawingBuffer:false` the framebuffer may be
cleared by the compositor before a post-idle continuation runs (verified empirically: post-idle
reads returned all-zero frames), and `preserveDrawingBuffer:true` hangs maplibre's first render
(also verified) (`page/init.ts:538-585`). Bytes go base64 over CDP (chunked
`String.fromCharCode.apply` under V8's spread-arg stack limit; the comment records the empirical
disproof of the `TextDecoder('latin1')` shortcut — windows-1252 maps 0x80–0x9F outside Latin-1
and `btoa` throws) (`page/init.ts:613-642`), then `Buffer.from(b64,'base64')` (native) on the Node
side and a strict length check against `readback.w*h*4` (`index.ts:853-873`). The legacy PNG
transport is kept as an escape hatch and **fails loudly** when SSAA is active rather than emitting
wrong dims (`index.ts:874-896`). Reusable scratch buffers avoid 8 MB/frame GC churn
(`page/init.ts:607-611, 644-646`). Per-frame timing summary is always-on, one line, named fields
(`index.ts:912-923`).

Known accepted inefficiency, documented in place: the `'render'` listener performs a readback on
*every* render event (1–2 per frame steady-state, more during tile loads); the throttle-to-
last-render-before-idle optimization is named and deliberately deferred
(`page/init.ts:565-572`).

**Anti-jitter.** `painterPatch.ts` forces `moving: true` on every `painter.render` call to bypass
maplibre's integer-pixel camera snap at rest (the wobble fix; `painterPatch.ts:1-29`), unit-tested
without the maplibre bundle (`__tests__/painterPatch.test.ts`). See §6.3 for the asymmetry with
the preview's broader patch.

---

## 5. shapes.ts — crisp engineering, not accumulated patches

The decoration shape module is the opposite of patch accumulation:

- **True SDF encoding**, derived from MapLibre's `symbol_sdf.fragment.glsl` constants
  (`alpha = clamp(255·(0.75 + d/SDF_PX))`, boundary = 191), with the *why* recorded: a
  coverage-encoded alpha gets the wrong slope through the shader's smoothstep at 0.75 and
  produced the prior "grainy circle" faceting (`shapes.ts:13-33, 215-230`). The texel-vs-CSS-px
  distinction and why higher pixelRatio genuinely sharpens edges is spelled out
  (`shapes.ts:65-75`).
- **Analytical distance functions** per shape (circle `r−d`, square L∞, diamond L1/√2, ring band
  `halfStroke−|r−mid|`), each with its corner-case caveat documented (e.g. the L∞-vs-Euclidean
  divergence at square corners and why it's invisible in practice, `shapes.ts:608-618`).
- **Outline as a derived band**: `outlineSdfFrom(d, t) = min(d, t−d)` (`shapes.ts:296-314`) means
  every secondary slot is generated from the primary's SDF — no per-shape outline rasterizers to
  drift.
- **The pin** is the standout: tangent-line tail geometry for C1 continuity at the head/tail
  junction, and a long-form comment explaining why the naive `max(headSdf, tailSdf)` union has the
  right *sign* but wrong *magnitude* (painting a spurious secondary-color arc near the tangent
  points) and why a proper min-over-boundary-pieces distance is required
  (`shapes.ts:699-742, 829-886`). Tip-at-bottom-center + per-shape `icon-anchor` expression in
  `resolveStaticPaints` (`styleSpec.ts:469-485`) gives sub-pixel geographic anchoring.
- **Size-system coherence**: `SHAPE_CANONICAL_RADIUS` bridges the user's 1080-anchored fractions
  to MapLibre `icon-size` (`shapes.ts:77-90`), and `outlineThicknessCanvasPx` inversely
  compensates baked thickness by `circle_radius` so the on-screen stroke stays at the requested
  CSS width regardless of dot size — with the derivation shown and the cache-invalidation
  consequence named (`shapes.ts:111-135`).
- **Extension story**: adding a shape = "write a primary rasterizer, optionally a secondary,
  append to SHAPES" (`shapes.ts:181-197`); a `domains` field keeps POV/waypoint pickers honest;
  unknown legacy names degrade to circle through a defensive `match` in the icon-image expression
  (`styleSpec.ts:429-452`) rather than MapLibre's hot-pink missing-image placeholder.
- The decision **not** to use OffscreenCanvas/node-canvas is argued on parity + dependency-cost
  grounds (`shapes.ts:35-53`) — and it's what made the page-side rasterization fix (§6.1 context)
  possible at all.

Two defects found here, though — see §6.1 (fractional pixelRatio, high) and §6.6 (pin bbox clip,
low).

---

## 6. Findings (questionable / defects), with severity

### 6.1 HIGH — Fractional `pixelRatio` breaks the SDF icon atlas at the 1440p export tier

`rasterize()` and `transparentIcon()` size the icon canvas as
`WAYPOINT_ICON_SIZE * pixelRatio` = `128 × pr` (`shapes.ts:206-213, 265-273`) and the page passes
the export's `payload.pixelRatio` straight in (`page/init.ts:487-490`). But the export
pixelRatio is `canonical multiplier × SSAA factor` (`export/mod.rs:536`), and the 1440p
multiplier is **4/3** (`export/layout.rs:99`, fixture comment `setupFixture.ts:100-105`). With the
2× SSAA tier (any map slot with long edge > 1440 px — i.e. full-frame and most split 1440p
exports), `pr = 8/3` and the canvas size is `128 × 8/3 = 341.333…` — not an integer.

Verified mechanism (Node REPL, this audit):

- `new Uint8Array(341.333² × 4)` does **not** throw — it truncates to length 466033;
- `data[(y*341.333+x)*4] = 255` with a fractional index is **silently dropped** by the
  typed-array integer-indexed-exotic semantics (write verified lost);
- `map.addImage(id, {width: 341.333, height: 341.333, data})` then fails maplibre's
  `width*height*4 === data.length` check — caught by the deliberate per-icon try/catch at
  `page/init.ts:499-503`, which logs and continues ("visible-but-not-fatal").

Net effect: at 1440p (4/3-multiplier) exports with a 2×-SSAA map slot, **every waypoint shape
icon fails to register and waypoints render as missing/fallback in the export only** — preview is
unaffected (devicePixelRatio is 1/2/1.25/1.5, all of which make 128·pr integral). This is exactly
the silent preview/export divergence class the whole architecture exists to prevent, and it's
masked by the very try/catch that makes single-icon failures non-fatal. 1080p (pr 2 or 3) and
2160p (pr 4 or 6) tiers are integral and unaffected, which is presumably why it hasn't been seen.

Fix shape: `const size = Math.ceil(WAYPOINT_ICON_SIZE * pixelRatio)` and derive the effective
`options.pixelRatio` as `size / WAYPOINT_ICON_SIZE` (so MapLibre's natural-size normalization
stays exact), or round the atlas pixelRatio up to an integer before rasterizing. Either is a
~3-line change in `shapes.ts` + a regression test asserting integral dims for
`pr ∈ {8/3, 4/3, 1.25, 2.6667}`.

### 6.2 MEDIUM-HIGH — Visited-mode waypoint rebuild drops `override_secondary_color` (confirmed invariant violation)

`buildWaypointsCollection` (static path) bakes `override_color`, `override_secondary_color`, and
`override_shape` into each feature, with this comment (`sources.ts:110-122`):

> Must match the visited-mode rebuild below or visited mode silently loses the override.

The visited-mode per-frame rebuild (`sources.ts:316-327`) sets `override_color` and
`override_shape` **but not `override_secondary_color`**. So with `waypoints.mode === 'visited'`,
any per-waypoint secondary (outline) color override silently reverts to the project base — in
*both* preview and export (shared code, so no preview/export divergence), but it violates the
decorations model (per-waypoint overrides are a first-class feature) and it is precisely the
failure its own comment warned about. Root cause is the duplicated feature-construction code:
the visited filter re-implements the property bag instead of filtering the output of
`buildWaypointsCollection`. Fix: build features once, filter by `waypointPassed` — deletes the
duplication and the bug class.

### 6.3 MEDIUM — Anti-jitter patch asymmetry between preview and sidecar (suspected export icon shimmer)

The preview forces **three** of maplibre's at-rest heuristics off, with documented reasons
(`MapView.tsx:198-218`):

> - `moving` … gates `align` in draw_raster.ts:96 … visible as 1-pixel raster wobble
> - `zooming` and `rotating` … gate the icon atlas texture filter in draw_symbol.ts:365,370.
>   At rest the engine picks `gl.NEAREST`, which aliases against the texel grid … visible as POI
>   shimmer/jitter on the default vector style.

```ts
map.isMoving = () => true;
map.isZooming = () => true;
map.isRotating = () => true;
```

The sidecar's `painterPatch` forces only `moving: true` (`page/init.ts:357`,
`painterPatch.ts:23-29`); nothing in `page/init.ts` touches `isZooming`/`isRotating` (grep
confirmed). Both renderers drive the identical per-frame `jumpTo` loop, so the export's symbol
layers should hit the same `gl.NEAREST` at-rest filter the preview explicitly works around —
i.e. the export may sample the icon/glyph atlas with NEAREST while the preview samples LINEAR.
2–3× SSAA will partially mask this, but sub-pixel icon drift between frames is exactly the
decoration-crispness symptom class being chased. Needs an A/B verification frame pair; if
confirmed, the fix is extending the page patch to mirror MapView's three-flag forcing (and the
deeper fix is moving the *shared* anti-jitter policy into mapVisuals-adjacent shared code instead
of two hand-maintained monkey-patches: `MapView.tsx:216-218` vs `painterPatch.ts`).

### 6.4 MEDIUM — Per-frame paint channel is a named struct hand-mapped twice (change amplification)

`resolveStaticPaints` returns `[layerId, prop, value]` tuples that both consumers iterate blindly
— a genuinely deep interface. `buildPerFramePaints` instead returns the 13-field `PaintUpdates`
struct (`mapVisuals/types.ts:45-113`), and the field→(layer, property) mapping is duplicated:
`MapView.tsx:661-723` (≈60 lines of `setPaintProperty('waypoints-primary','icon-color', state.paints.waypointPrimaryColor)` …)
and `index.ts:736-779` (the same mapping re-expressed as wire tuples, with duplicated rationale
comments about sort-key semantics). Adding one per-frame property = 4 files. If
`buildPerFramePaints` emitted the same `{paints, layouts}` tuple shape the static channel uses,
both apply sites collapse to the existing loops and the wire translation disappears. This is the
single highest-leverage interface cleanup in the pair.

### 6.5 MEDIUM-LOW — Layer stack + source specs duplicated across consumers, comment-enforced

Stacking order and addSource specs (incl. the load-bearing `lineMetrics: true`, which is a silent
no-op if not set at addSource time) exist twice: `MapView.tsx:259-308` and `index.ts:444-476`,
each side promising in a comment that it matches the other ("order matches renderer/index.ts
buildMap so stacking is identical", `index.ts:443-444`). One drift here = silent visual
divergence with no test to catch it (the styleSpec tests pin specs, not consumer ordering). Should
be a shared exported `SOURCE_SPECS: Array<[id, spec]>` + `LAYER_STACK: LayerSpecification[]` in
mapVisuals.

### 6.6 LOW — Pin SDF bounding box clips the head's outside fringe

`drawPin`/`drawPinOutline` rasterize over
`xLo: cx − tangentHalfWidth − SDF_PX` … (`shapes.ts:888-901, 909-917`), but the pin head circle is
wider than the tail's tangent width: at canonical size 128, `headR = 42` while
`tangentHalfWidth = headR·sinα ≈ 35.3` (cosα = 42/77.5, `shapes.ts:744-799`). The bbox half-extent
is ≈ 43.3 px vs the ≈ 48 px needed (`headR + 6` for the alpha>0 fringe), so roughly 4–5 px of the
outside SDF ramp at the head's widest left/right points is truncated — alpha falls off a cliff
(~112 → 0) instead of ramping to 0. The visible-edge smoothstep window sits at alpha ≈ 191, well
inside the bbox, so at normal sizes this is invisible; it becomes a flat-edge artifact only when
the smoothstep gamma widens (very small icon-size) or if icon-halo is ever used. Fix: use
`max(tangentHalfWidth, headR)` in the bbox. (Note: commit 8f27b8c "fixing shapes, specifically the
pin shape" predates this audit; the clip is present in the audited working tree.)

### 6.7 LOW — Sidecar worker file mixes five concerns in one 1089-line module

`index.ts` contains: protocol parsing/queueing, browser/page lifecycle, a hand-rolled HTTP client
with redirects + gzip/deflate/brotli (`index.ts:218-261`), frame-state translation, and transport
plumbing. Each piece is individually clean and the narrative comments make it navigable, but the
HTTP client and the stdin state machine are obvious extraction candidates. Not urgent; cohesion is
acceptable for a sidecar.

### 6.8 LOW — Acknowledged-but-open visual approximations (documented, not hidden)

- Trail gradient is normalized 0→1 over the trail's *current* extent rather than the route
  fraction — called "visually approximate at the head; a 'clamped to current progress' refinement
  is deferred" (`styleSpec.ts:565-572`). Preview and export agree (shared), so parity holds; it's
  a correctness-vs-spec note.
- Tile cache has no eviction ("grows unboundedly … documented as a known limitation",
  `tileCache.ts:21-23`). Fine for now; a ship blocker only at scale.
- Per-frame `gradients` are re-sent every frame though no per-clip route-color override exists
  yet; relies on maplibre's deepEqual no-op (`index.ts:780-786`, `page/init.ts:798-807`). Cheap,
  deliberate, and keeps the channel uniform — acceptable.

---

## 7. Gems (hard-won knowledge that must survive any rewrite)

1. **The tuple-based `resolveStaticPaints` contract** — placeholder literals in layer specs +
   mandatory seed + identical apply loops on both sides; and the discipline that *held* (grep in
   §2). `styleSpec.ts:337-395`, `MapView.tsx:487-528`, `page/init.ts:506-535`.
2. **The Promise-was-collected handshake** — V8 Inspector GC of awaited evaluate Promises under
   page heap pressure, the two distinct symptoms, and the exposeFunction signal pattern.
   `index.ts:163-197`.
3. **Synchronous-in-'render'-event readPixels** — the only correct readback window with
   `preserveDrawingBuffer:false`; both alternatives empirically disproven (all-zero frames /
   first-render hang). `page/init.ts:538-585`.
4. **The transition/raster-fade idle-deadlock kills**, with maplibre-internals line citations and
   the disproof of the naive duration=0 override. `page/init.ts:366-445`.
5. **Page-side SDF rasterization** — the 10-icon atlas serialized as JSON Uint8Arrays blew CDP's
   100 MB inbound cap at 4K (~127 MB); shipping two scalars and rasterizing in-context with the
   same pure function gives a bit-identical atlas with zero pixels over the wire. Also fixed a
   real bug en route (worker had hardcoded DEFAULT_OUTLINE_THICKNESS, ignoring user stroke width
   on export). `index.ts:478-497`, `page/init.ts:468-504`.
6. **True-SDF encoding rationale** (coverage alpha ⇒ wrong smoothstep slope ⇒ grainy circles) and
   the pin's proper-distance union (max-of-SDFs has wrong magnitude ⇒ phantom secondary arc).
   `shapes.ts:13-33, 729-742`.
7. **The lever model + SSAA framebuffer/readback split** — zoom interpreted at canonical CSS,
   resolution absorbed by pixelRatio, supersample downsampled on-GPU so the wire stays
   slot-sized; with the ≤1 px Chromium rounding drift handled and bounded by asserts.
   `export/layout.rs:119-182`, `export/mod.rs:510-547`, `page/init.ts:256-310, 666-760`.
8. **`outlineThicknessCanvasPx`** inverse-compensation derivation (stroke stays at requested CSS
   width across dot radii; cache must invalidate on either knob). `shapes.ts:111-135`.
9. **Deterministic, loud, process-level protocol tests** — byte-identical same-t frames,
   offline-cache replay, missing-prereq throws (no silent skips), and the Rust-side stale-key
   guard. `__tests__/protocol.test.ts`, `protocol.rs:228-260`.
10. **bytesToBase64 latin1 caveat** ('latin1' is windows-1252 per WHATWG; 0x80–0x9F escape the
    Latin-1 range and btoa throws — empirically hit) and the 32 KB spread-arg chunking.
    `page/init.ts:613-642`.
11. **painterPatch wobble fix** (at-rest integer-pixel camera snap) and the preview's fuller
    three-flag version with maplibre line citations — together they are the map-jitter playbook.
    `painterPatch.ts:1-29`, `MapView.tsx:198-218`.
12. **trailcutFetch's post-interpolation rewrite** (transformRequest, not style-JSON walking) and
    the hash-key-parity invariant with its dedicated test. `trailcutFetch.ts:1-22`.

---

## 8. Ousterhout assessment

**Deep where it matters.** `buildPerFrameState(timeline, t, …) → {camera, sources, paints}` is a
genuinely deep interface: seven inputs, one snapshot out, hiding camera intent resolution,
wall-clock translation (with its three-branch transition semantics, `perFrame.ts:49-95`),
visited filtering, active-waypoint selection, gradient/override expression construction, and
pulse math. `shapes.ts` hides SDF theory behind "append a descriptor". The sidecar hides an
entire headless-Chrome failure-mode museum behind four wire commands. The comments are not noise
— they are mostly *disproofs* (what was tried, what broke, with line-level citations into
maplibre), which is exactly the knowledge a rewrite would lose first.

**Shallow spots are localized and nameable:** the per-frame named-struct channel (§6.4), the
duplicated layer-stack/source-spec setup (§6.5), the duplicated waypoint feature builder that
already diverged (§6.2), and two hand-maintained anti-jitter monkey-patches (§6.3). None of these
require a rewrite; all four are interface-tightening refactors inside an architecture that is
working.

**Against the owner's "soupy and shallow" hypothesis:** this subsystem is the counterexample. The
defects found are point bugs (one serious) and seam duplication, not architectural soup. A
fresh-start would have to re-earn items 2–5 and 10–11 of §7 the hard way.

**Salvage grade: keep-with-cleanup.** Priority order: fix §6.1 (with a fractional-pr regression
test), fix §6.2 (by de-duplicating the feature builder), verify+fix §6.3, then do §6.4/§6.5 as
one "tuple-ize the per-frame channel + share the layer stack" refactor.
