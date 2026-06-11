# Research receipt — maplibre-native raster snap: is "we'd have to fork native" still true?

**Date:** 2026-06-11
**Question:** TrailCut's export renderer uses headless-Chrome MapLibre GL JS partly because maplibre-native was believed to pixel-snap when the camera isn't "moving," and fixing that was believed to require maintaining a fork. The internal spike (`.spike/native-gl/VERDICT.md`) narrowed the snap to **raster layers only** (vector basemap is jitter-free) and concluded the raster fix needs a **core-mbgl C++ change** ("native has no `moving` concept; its raster path passes `aligned=true` unconditionally"). Is that still accurate as of June 2026?

**Verdict (one line): "We'd have to fork native" is now WRONG for the vector basemap, and MOSTLY WRONG for raster tiles — the core anti-snap gate already exists upstream (`!state.isChanging()`), an open maintainer-endorsed upstream PR ([#4137](https://github.com/maplibre/maplibre-native/pull/4137), from issue [#4132](https://github.com/maplibre/maplibre-native/issues/4132)) would remove the snap entirely, and the fallback is a ~10-line Node-binding exposure of an existing public core API (`Map::setGestureInProgress`) — not a core C++ fork. Only `image`/`video` raster sources (and hillshade) still need a true one-line core change.**

---

## 1. What the spike established (baseline, from the repo's own artifacts)

Source: `.spike/native-gl/VERDICT.md`, `.spike/native-gl/jitter-report.md`, `.spike/native-gl-jitter-handoff.md` (all in this repo).

- Native **vector** basemap at 4K: residual RMS **0.0080 px** vs GL JS reference 0.0070 px — smooth, no fork needed, crispness ≥ GL JS (acutance ratio 1.02). (`VERDICT.md` lines 12–19.)
- Native **raster** (satellite): RMS **0.8754 px** sawtooth — identical to **unpatched** GL JS to 4 decimal places; TrailCut's shipped painter patch (`src-tauri/sidecars/renderer/page/painterPatch.ts`, forces `moving:true` → `aligned=false`) fixes GL JS raster to 0.106 RMS. (`jitter-report.md` lines 16–25.)
- Spike's mechanism claim: "**Native has no `moving` concept** — its raster path passes `aligned=true` unconditionally," therefore the fix is "a **core-`mbgl` C++ change**" and "patching it means **building the native binary from source**." (`VERDICT.md` lines 30–46.)
- Spike tested `@maplibre/maplibre-gl-native@6.4.1` via the legacy Node binding, which "hardcodes `MapMode::Static`/`Tile` and exposes **no** alignment or mode knob." (`.spike/native-gl-jitter-handoff.md` line 20.)

The empirical measurements stand. The **mechanism claim is partially wrong**, and that changes the remedy — see §3.

## 2. Current state of maplibre-native (2025–2026)

### 2.1 Project activity and the Node binding

- The repo is very active: platform releases roughly weekly (`ios-v6.27.0` and `android-v13.3.0` on 2026-06-07; `node-v6.5.0-pre.1` on 2026-06-05). Source: https://github.com/maplibre/maplibre-native/releases (queried 2026-06-11 via `gh api repos/maplibre/maplibre-native/releases`).
- Node binding release cadence 2025–2026: `node-v6.1.0` (2025-04-29), `node-v6.2.0` (2025-08-14), `node-v6.3.0` (2025-12-30), `node-v6.4.0` (2026-03-05), `node-v6.4.1` (2026-03-30), `node-v6.5.0-pre.1` (2026-06-05) — ~6–8 releases/year, actively maintained.
- **Prebuilt-binary coverage (resolves the spike's open question #2):** the `node-v6.4.1` release ships prebuilt binaries for **darwin / linux / win32 × x64 / arm64**, each for node ABIs **v115 / v127 / v137** (Node 20/22/24) — 18 assets total. Source: `gh api repos/maplibre/maplibre-native/releases/tags/node-v6.4.1 --jq '.assets[].name'` (2026-06-11). Windows and Linux prebuilts exist; the spike's "unverified follow-up" is now verified positive.
- The Node binding gets real maintenance: a macOS/Metal bug where "the Node.js platform with Metal (on macOS) stopped rendering after 32 frames" was fixed in mid-2025 with an autoreleasepool flag in the core render loop, with an npm release shortly after — direct evidence that long many-frame headless render runs (TrailCut's exact use case) are an upstream-supported scenario. Sources: https://maplibre.org/news/2025-08-04-maplibre-newsletter-july-2025/ and https://maplibre.org/news/2025-09-04-maplibre-newsletter-august-2025/.
- The **legacy renderer is gone**; the "Drawable" renderer is the only renderer. `cmake/validate-backend-options.cmake` (main @ `fa8a9c8e`): `if (MLN_LEGACY_RENDERER) message(FATAL "The legacy renderer is no longer supported")` / "the drawable renderer is now the default". Backends: OpenGL, Metal, Vulkan, WebGPU (exactly one must be selected).

### 2.2 The raster alignment code on main — the spike's mechanism claim is outdated/wrong for tiles

All file references below are maplibre-native `main` @ commit `fa8a9c8e3261ce64940127aecc1d52f540c21c57` (2026-06-11).

- `include/mbgl/renderer/layer_tweaker.hpp:59` — `getTileMatrix(..., bool aligned = false)`: vector layers default to the non-snapped matrix (matches the spike's source review).
- `src/mbgl/map/transform_state.cpp:128,199–210` — `getProjMatrix(..., bool aligned)` builds the pixel-snapped matrix via `std::modf` (the snap mechanism, unchanged).
- **`src/mbgl/renderer/layers/raster_layer_tweaker.cpp:104` — the raster TILE path is NOT unconditional.** It passes:

  ```cpp
  matrix = getTileMatrix(tileID, parameters, {0.f, 0.f},
                         TranslateAnchorType::Viewport,
                         false, false, drawable,
                         !parameters.state.isChanging());   // aligned only when NOT changing
  ```

  i.e. **core mbgl already has the exact GL-JS `!options.moving` gate for raster tiles.** `git log -S isChanging -- src/mbgl/renderer/layers/raster_layer_tweaker.cpp` shows this gate has existed since the very first Drawable raster commit, `7f33ddfef4` "Raster layer (Tiles) #1168 (#1195)" (merged 2023-08-31). The spike's "passes `aligned=true` unconditionally" was never true of the tile path on the Drawable renderer.

- `src/mbgl/map/transform_state.cpp:732` — `bool TransformState::isChanging() const { return rotating || scaling || panning || gestureInProgress; }`.
- **Why the spike still measured a snap:** the Node binding drives the camera with `jumpTo` (`platform/node/src/node_map.cpp:1029,1046,1063,1080` — `SetCenter`/`SetZoom`/etc. all call `map->jumpTo(...)`), and `jumpTo` sets none of `rotating/scaling/panning/gestureInProgress`. So in Static-mode frame-by-frame rendering, `isChanging()` is always `false` → `aligned=true` → the measured sawtooth. The snap is real, but it is a **binding-surface gap, not a missing core capability**.
- **The image/video exception:** `raster_layer_tweaker.cpp:89` — the **image-drawable** branch (raster `image`/`video` sources, i.e. drawables with no tile ID) still hardcodes `multiplyWithProjectionMatrix(..., /*aligned*/ true)`. For those source types a genuine (one-line) core change is still required.
- **The hillshade exception:** `src/mbgl/renderer/layers/hillshade_layer_tweaker.cpp:175–176` also hardcodes the aligned matrix (`getTileMatrix(..., drawable, true)`), with no `isChanging()` gate. DEM hillshade in motion would snap even with `setGestureInProgress(true)`; same one-line consistency fix applies. (These two hardcoded sites plus the gated tile site are the **only** non-default `aligned` callers across `src/mbgl/renderer/layers/*.cpp` — verified by grep on the 2026-06-11 clone.)

### 2.3 The supported escape hatch: `Map::setGestureInProgress`

- `include/mbgl/map/map.hpp:65` — `void setGestureInProgress(bool);` is **public core API**.
- `src/mbgl/map/map.cpp:123–125` → `src/mbgl/map/transform.cpp:697–699` → `TransformState::gestureInProgress = true` → `isChanging()` returns `true` → raster tile drawables get the **unaligned** matrix. This is the API mobile platforms use while the user's finger is down — semantically "the camera is being continuously manipulated," which is exactly TrailCut's per-frame animated export.
- `Map::renderStill` (`src/mbgl/map/map.cpp:60–91`) checks only MapMode and a pending request — it does **not** assert `!isChanging()`, so Static-mode still-renders work with the flag set.
- **Side-effect audit** (every `isChanging()` consumer in the render path, via GitHub code search on the repo, 2026-06-11): exactly two —
  1. `raster_layer_tweaker.cpp:104` (the alignment gate — the desired effect), and
  2. `src/mbgl/gfx/drawable_atlases_tweaker.cpp:42–43` — switches glyph/icon atlas sampling to `LINEAR` while changing. That is the *correct* behavior for a moving camera (and is the same family of side effect TrailCut's GL JS painter patch already accepts by forcing `moving:true` permanently).
  All other hits (`map_impl.cpp:80` `onCameraIsChanging`, iOS/macOS/Android `MLNMapView`/`MapView` files) are observer-callback names, not render-path consumers.
- **The gap:** the Node binding does not expose it. `platform/node/src/node_map.cpp:92–122` (the full `SetPrototypeMethod` list) has `setCenter/setZoom/setBearing/setPitch/...` but nothing touching gesture/transition state, and hardcodes `MapMode::Static`/`Tile` (`node_map.cpp:1499–1501`). Exposing `setGestureInProgress` is a ~10–20-line binding-level addition (one `SetPrototypeMethod` + one trampoline calling existing public API) — **not** a core C++ change.

### 2.4 Is anyone upstream tracking this? **YES — an open, maintainer-endorsed issue + PR target the exact line**

- **Issue [maplibre-native#4132](https://github.com/maplibre/maplibre-native/issues/4132)** — "BUG: Raster and Vector layers desynchronize during map interaction" (opened 2026-02-26, **OPEN**). The reporter (UlysselaGlisse) independently pinned the identical mechanism and quotes the identical line, proposing to delete it:

  > "I've found a workaround to avoid this dealignment by deleting this condition:
  > `!parameters.state.isChanging()); // <- That one`" (`raster_layer_tweaker.cpp` l.97)

  Symptoms are user-visible in production mobile apps (CFF — Swiss railways — and Mappy, iOS + Android): during interaction, raster layers visibly desynchronize from vector layers — the same *relative* raster-vs-vector wobble the spike called out as unfixable by whole-frame de-snap (`VERDICT.md`, "harness-side de-snap" row). Maintainer **louwers** replied same day: *"Thanks a lot for the detailed report! Do you feel comfortable making a PR with your fix?"* and pinged the line's original author (@mwilsnd). The reporter confirmed the fix tested clean on Android + iOS custom builds "without any immediate performance regressions."
- **PR [maplibre-native#4137](https://github.com/maplibre/maplibre-native/pull/4137)** — "Fix raster layer tweaker to avoid desynchronization issue" (opened 2026-02-28, **OPEN**, last updated 2026-04-08). Single file, `src/mbgl/renderer/layers/raster_layer_tweaker.cpp`; the diff drops the final `!parameters.state.isChanging()` argument so the tile path falls back to the `aligned = false` default — i.e. raster tiles would **never** snap:

  ```diff
  -            matrix = getTileMatrix(tileID, ..., drawable,
  -                                   !parameters.state.isChanging());
  +            matrix = getTileMatrix(
  +                tileID, parameters, {0.f, 0.f}, TranslateAnchorType::Viewport, false, false, drawable);
  ```

  Status checked 2026-06-11 (`gh pr view/diff/checks 4137`): not a draft, labeler + pre-commit checks pass, `reviewDecision: REVIEW_REQUIRED`, **zero reviews, idle since April 2026**. It does not touch the image-drawable (`:89`) or hillshade hardcoded sites. Risk to merging: it removes the static-pose crispness alignment outright (the reason the gate exists), so a reviewer may ask for a gated/opt-out variant instead — either outcome unblocks TrailCut's moving-camera case.
- **Actionable:** the spike's quantitative evidence (0.8754 px sawtooth → 0.008 px smooth, phase-correlation methodology, side-by-side 4K videos) is exactly what this unreviewed PR lacks. Commenting with it / offering review is the cheapest path to the zero-maintenance outcome.
- Earlier searches for `raster jitter`, `pixel snap`, `aligned`, `setGestureInProgress`, `fractional zoom` surfaced nothing else — #4132/#4137 (found via an API search for `isChanging`) is the only upstream tracker. Nearest other hit is maplibre-native#2477 "Label Blinking Issue at Integer Zoom Levels with animateCamera" (open, symbol-related, not this).
- On the GL JS side, **maplibre-gl-js#6879** "Janky animation when setting zoom with a small difference while zoomed in" (opened 2025-12-17, closed) independently rediscovered the identical mechanism: `setZoom`/`jumpTo` never set `_moving` → `align = !painter.options.moving` → `_alignedProjMatrix`'s `Math.round` produces 1-px jumps. The reporter's userland fix is `map._moving = true` — functionally TrailCut's `painterPatch.ts`. Maintainer response treats the snap as **intended raster-crispness behavior**, not a bug. URL: https://github.com/maplibre/maplibre-gl-js/issues/6879. Current GL JS gate: `src/webgl/draw/draw_raster.ts:96` `const align = !painter.options.moving;`; the aligned-matrix construction with its rationale comment is `src/geo/projection/mercator_transform.ts:~672` ("Make a second projection matrix that is aligned to a pixel grid for rendering raster tiles…").
- Implication: this validates the painter patch as the community-known answer in GL JS, and confirms no engine intends to remove pixel alignment — the supported pattern in both engines is "tell the engine the camera is moving."

## 3. Answers to the four research questions

### (1) Has raster snapping changed upstream? Is there a tracking issue?

The shipped behavior is unchanged (snap when idle, for raster crispness), but two things are new: **(a)** the spike's premise — that native lacks any "moving" concept — is wrong: the `!isChanging()` gate has been in core's raster tile tweaker since 2023 (§2.2); **(b)** as of Feb 2026 there IS an upstream tracker — issue **#4132** (maintainer-endorsed, production mobile apps affected) and open PR **#4137**, which deletes the aligned gate for raster tiles entirely (§2.4). The PR is unreviewed/idle since April 2026, so the fix is in flight but not landed. Notably, native's maintainers treat the snap-induced desync as a **bug**, while a GL JS maintainer response treated the equivalent mechanism as expected behavior (#6879) — upstream native is the more receptive venue.

### (2) Is there a supported no-fork way to disable the snap?

| Lever | Works? | Evidence |
|---|---|---|
| Style/source option | **No.** Matrix alignment is renderer-internal; nothing in the style spec controls it. | §2.2; style spec has no alignment property |
| `raster-resampling: nearest/linear` | **No.** It selects the GL texture filter only, orthogonal to the matrix (`draw_raster.ts:96–99` shows `align` and `resampling` are independent). | §2.4 |
| Custom source type | **No.** Snap keys off layer/drawable class (raster tweaker), not source. | §2.2 |
| Continuous render mode in the Node binding | **Not exposed** (`MapMode::Static`/`Tile` hardcoded, `node_map.cpp:1499–1501`); and mode alone wouldn't set the transform flags anyway. | §2.3 |
| **`Map::setGestureInProgress(true)`** | **YES for raster tiles — public core API, zero core changes.** Flips `isChanging()` → unaligned matrices. Only side effect is linear atlas filtering (desirable in motion). **Missing only a Node-binding exposure (~10–20 lines).** | §2.3 |
| `image`/`video` raster sources | **No supported lever** — `raster_layer_tweaker.cpp:89` hardcodes `aligned=true` for image drawables; needs a one-line core change (e.g. same `!isChanging()` gate). | §2.2 |

### (3) Cost of carrying a small patch vs a full fork — how often does the touched code churn?

- `src/mbgl/renderer/layers/raster_layer_tweaker.cpp` commit history (22 commits since 2023): 2025–2026 saw exactly **two** touches — "UBO consolidation (#3089)" 2025-01-08 and a clang-tidy pass 2025-03-21; **nothing in the 15 months since**. Mostly mechanical refactors; the alignment logic has never changed.
- `platform/node/src/node_map.cpp`: **3 commits total in 2025–2026** (a memory-growth fix + revert, and the hillshade/color-relief API addition 2026-02-26); before that, untouched since 2023.
- Conclusion: both candidate patch sites are **very low churn**; rebasing a vendored patch is trivial. The real cost was never merge conflicts — it's **forfeiting prebuilt binaries**: any local patch means building the `.node` binary from source for 6 platform/arch targets (the upstream release CI builds 18 assets per release, §2.1). That is real infrastructure, which is why the ordering matters: **upstream the binding exposure first** (it is a far easier PR than the spike's proposed "thread a per-render aligned flag through core" — it adds no new concept, just exposes existing public API on a platform the maintainers actively release). A "full fork" was never on the table and still isn't.

### (4) Alternative high-fidelity headless map renderers (2025–2026)

- **mbgl-renderer** (consbio) — Node static-map renderer wrapping the same `@maplibre/maplibre-gl-native` binding; explicitly "largely in maintenance mode." Nothing TrailCut doesn't already get from the binding directly. https://github.com/consbio/mbgl-renderer
- **mapgl-tile-renderer** (ConservationMetrics) and **tileserver-gl** (maptiler) — same binding under the hood, oriented at tile/static serving, not per-frame animation. https://github.com/ConservationMetrics/mapgl-tile-renderer , https://github.com/maptiler/tileserver-gl
- **maplibre-rs** — Rust/WebGPU MapLibre renderer; repo alive (pushed 2026-06-05) but still experimental, nowhere near style-spec completeness. Not viable.
- **galileo** (Maximkaaa) — general-purpose Rust GIS renderer, active (pushed 2026-04-25, ~617 stars) — but does not implement the MapLibre style spec, so OpenFreeMap liberty styles don't apply. Not a drop-in.
- **tangram-es** — dormant (last push 2024-01-08).
- Net: **maplibre-native is the only style-spec-faithful headless renderer besides headless-Chrome GL JS.** No new contender emerged in 2025–2026.

## 4. Final verdict

**"We'd have to fork native" is wrong as stated, on three escalating levels:**

1. **Vector basemap (TrailCut's primary export surface): no fork, no patch, nothing.** The spike already proved this (RMS 0.008 px, crispness ≥ GL JS); this research found no upstream regression risk — the vector path's `aligned=false` default is untouched.
2. **Raster tiles (satellite, custom raster): no core fork needed — the core fix shipped in 2023, and upstream is already trying to remove the snap entirely.** The anti-snap gate (`!state.isChanging()`, `raster_layer_tweaker.cpp:104`) is the native equivalent of GL JS's `moving` flag, and `Map::setGestureInProgress(true)` is the supported public switch. Two independent no-fork routes: **(a)** open PR **#4137** deletes the gate — if it merges, raster tiles never snap and TrailCut needs nothing at all; **(b)** a **~10–20-line Node-binding exposure** of `setGestureInProgress` — a small upstream PR with high acceptance odds (exposes existing API, on an actively-released platform, no new renderer concept), robust even if #4137 stalls or gets redesigned. Interim: a binding-only patch against a file that changed 3 times in two years, at the cost of self-building until merged.
3. **`image`/`video` raster sources and DEM hillshade only: one-line core changes remain** (`raster_layer_tweaker.cpp:89` and `hillshade_layer_tweaker.cpp:175–176` hardcode `aligned=true`) — the natural upstream PR applies the same `!isChanging()` gate (or #4137's removal) there, plausibly framed as a consistency fix.

The spike's empirical work is excellent and fully reproduced by code inspection; its **fork-depth conclusion should be revised downward**. Its proposed upstream PR ("thread a per-render `aligned`/`moving` option through the raster tweaker + Node binding," `VERDICT.md` lines 47–49) is over-scoped — the per-render concept already exists in core as `isChanging()`/`setGestureInProgress`.

**Recommended sequencing if/when native migration proceeds:** (a) adopt native for vector-basemap export now (per spike GO, plus the speed benchmark the spike deferred); (b) **push PR #4137 over the line** — comment on it/#4132 with the spike's quantitative jitter evidence (0.875 px sawtooth → 0.008 px, 4K videos) and offer review; (c) in parallel or if #4137 stalls, file the small Node-binding PR exposing `setGestureInProgress`, citing #4132 and GL JS #6879 as cross-engine precedent, and include the `:89` image-drawable + hillshade hardcoded gates as consistency fixes; (d) re-run the spike's measured harness (`.spike/native-gl/`) on the fixed build to confirm raster RMS drops to ~0.008 before any raster-dependent ship decision (the `setGestureInProgress` route is source-verified but not yet empirically re-spiked), and re-check the spike's separate ~6% raster-softness finding, which is unrelated to alignment; (e) keep the GL JS painter patch in production until then (it is what keeps satellite exports smooth today — `VERDICT.md` line 106), and re-verify its hook point on any maplibre-gl upgrade, since the 2025 GL JS refactor moved the gate into `src/webgl/draw/draw_raster.ts`.

## 5. Source index

**Repo-internal:** `.spike/native-gl/VERDICT.md`; `.spike/native-gl/jitter-report.md`; `.spike/native-gl-jitter-handoff.md`; `src-tauri/sidecars/renderer/page/painterPatch.ts`.

**maplibre-native** (main @ `fa8a9c8e3261ce64940127aecc1d52f540c21c57`, all retrieved 2026-06-11 via `gh api`):
- `src/mbgl/renderer/layers/raster_layer_tweaker.cpp:89` (image drawables `aligned=true`), `:104` (tile gate `!parameters.state.isChanging()`)
- `src/mbgl/renderer/layers/hillshade_layer_tweaker.cpp:175–176` (hillshade hardcodes `aligned=true`, ungated)
- Churn (clone, `git log`): `raster_layer_tweaker.cpp` 22 commits ever / 0 since 2025-06 / last 2025-03-21 (clang-tidy); `layer_tweaker.hpp` last touched 2024-09-10; `node_map.cpp` 14 commits ever / 3 since 2025-01
- `src/mbgl/map/transform_state.cpp:732` (`isChanging()` definition), `:128,199–210` (`getProjMatrix` snap via `modf`)
- `include/mbgl/map/map.hpp:65` + `src/mbgl/map/map.cpp:123` + `src/mbgl/map/transform.cpp:697` (`setGestureInProgress` chain), `src/mbgl/map/map.cpp:60–91` (`renderStill`)
- `include/mbgl/renderer/layer_tweaker.hpp:59` (`aligned = false` default)
- `src/mbgl/gfx/drawable_atlases_tweaker.cpp:42–43` (only other `isChanging` render consumer)
- `platform/node/src/node_map.cpp:92–122` (method list), `:1029–1080` (`jumpTo` camera setters), `:1499–1501` (Static/Tile modes)
- `cmake/validate-backend-options.cmake` (legacy renderer removed)
- Commit `7f33ddfef4` "Raster layer (Tiles) #1168 (#1195)" (gate introduced 2023-08-31; via `git log -S isChanging` on a clone)
- https://github.com/maplibre/maplibre-native/issues/4132 (Feb 2026 — raster/vector desync, maintainer-endorsed removal of the aligned gate)
- https://github.com/maplibre/maplibre-native/pull/4137 (open single-file PR deleting `!parameters.state.isChanging()` from the raster tile path; unreviewed as of 2026-06-11)
- https://github.com/maplibre/maplibre-native/pull/3384 (legacy renderer removal, merged 2025-04-16)
- Releases: https://github.com/maplibre/maplibre-native/releases (`node-v6.4.1` assets list; cadence)

**Web:**
- https://github.com/maplibre/maplibre-gl-js/issues/6879 (Dec 2025 — same mechanism in GL JS, `_moving=true` workaround, treated as expected behavior)
- maplibre-gl-js main: `src/webgl/draw/draw_raster.ts:96` (`align = !painter.options.moving`), `src/geo/projection/mercator_transform.ts` aligned-matrix comment
- https://maplibre.org/news/2025-08-04-maplibre-newsletter-july-2025/ and https://maplibre.org/news/2025-09-04-maplibre-newsletter-august-2025/ (Node/Metal 32-frame fix)
- https://github.com/consbio/mbgl-renderer ; https://github.com/ConservationMetrics/mapgl-tile-renderer ; https://github.com/maptiler/tileserver-gl ; https://github.com/maplibre/maplibre-rs ; https://github.com/Maximkaaa/galileo ; https://github.com/tangrams/tangram-es (alternatives survey)
