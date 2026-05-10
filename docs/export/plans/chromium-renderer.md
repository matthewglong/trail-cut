# Plan — Replace `@maplibre/maplibre-gl-native` renderer with headless Chromium + `maplibre-gl-js`

**Status**: Complete (2026-05-08). Tasks 115–119 landed the migration. The chromium renderer is the only renderer; this document is preserved as a historical record of the decision.
**Owner**: export pipeline
**Depends on**: shipped 010–110. **Blocks**: 130 (sidecar bundling), 120 (render parity verification — its golden frames must come from the new renderer)

---

## 1. Goal & non-goals

**Goal.** Replace the Node + `@maplibre/maplibre-gl-native` worker at `src-tauri/sidecars/renderer/index.ts` with a Node + headless-Chromium + `maplibre-gl-js` worker that produces byte-equivalent (or visually superior) RGBA frames for the same `(timeline, t)` inputs, while preserving:

- the line-delimited-JSON-in / length-prefixed-RGBA-out wire contract that `src-tauri/src/export/protocol.rs` and `orchestrator.rs` already drive,
- visual parity by import (everything that paints comes from `src/lib/mapVisuals/`, `src/lib/cameraIntent.ts`, `src/lib/routeLocation.ts`),
- the existing on-disk tile cache at `~/.trailcut/tile-cache`.

The single architectural justification is the slow-pan **wobble** the native binding produces on sub-pixel camera deltas (≪ 1 px/frame). The spike on `export-test` (commits `13b2ff4`, `6f4a185`) confirmed that running the same camera path through `maplibre-gl-js` in headless Chromium with the four-line `painter.render` `moving=true` patch eliminates it. Everything in this plan exists to deliver that patch into production with the smallest possible blast radius on bundle size, build time, and operational surface.

**Non-goals.**

- Changing the camera evaluator, `cameraAt(timeline, t)`, or any module under `src/lib/mapVisuals/`. The renderer applies; it does not redefine.
- Changing the Rust orchestrator's protocol shape, frame ordering logic, recycle cadence, or sink layer.
- Cross-browser support (Firefox/WebKit). We render in one runtime, picked for fitness.
- Bundling preview and export into one process. Preview keeps using the live `maplibre-gl-js` instance inside the Tauri webview; export gets its own headless Chromium. They share `src/lib/mapVisuals/` and the maplibre-gl version; that is what "render through the same code" means.
- Windows distribution work. That is task 130's slot, fed by this plan's Chromium-bundling decision.

---

## 2. Architecture decision record

### 2.1 Headless-browser library: **`puppeteer-core` + bundled `chrome-headless-shell`**

The choice space the user enumerated:

| Option | Verdict | Why |
|---|---|---|
| `puppeteer` (auto-downloads Chrome) | ❌ | Couples our build to puppeteer's Chrome download; no control over which binary ships with the app. |
| **`puppeteer-core` + bundled `chrome-headless-shell`** | ✅ **Selected** | Minimal lib, explicit `executablePath`, headless-shell is the smaller binary purpose-built for this workload, fits Tauri's `externalBin` model. |
| `playwright` | ❌ | Cross-browser surface (Firefox/WebKit), context-isolation features, and 326 KB-vs-11 KB CDP traffic [(Browserless)](https://www.browserless.io/blog/headless-chrome) buy nothing for a single-tenant single-runtime renderer; we'd pay the bigger surface for no return. |
| `puppeteer-core` + system Chrome | ❌ | First-run UX requires the user to have Chrome installed and discoverable. Acceptable for a CLI; not for a polished Tauri app where "import a video, click export" must Just Work. |
| Raw CDP (`chrome-remote-interface`) | ❌ | We aren't bottlenecked on per-call protocol overhead; the API lift from puppeteer-core to raw CDP is non-trivial and the saved bytes are noise next to a per-frame screenshot. |

**Citations / corroborating evidence:**

- Remotion — the closest production reference (browser-based deterministic video rendering at scale) — also defaults to `chrome-headless-shell` and uses puppeteer underneath, switching to full Chrome only for GPU-bound Linux rendering. [(Remotion docs)](https://www.remotion.dev/docs/miscellaneous/chrome-headless-shell)
- `chrome-headless-shell` is the supported smaller-footprint binary post-Chrome 132; available via `@puppeteer/browsers` install API and explicitly intended for headless automation workloads [(developer.chrome.com)](https://developer.chrome.com/blog/chrome-headless-shell).
- Puppeteer's `headless: 'shell'` option [(puppeteer headless modes)](https://pptr.dev/guides/headless-modes) maps cleanly to bundling our own headless-shell binary alongside `puppeteer-core`.

**Pinned versions** (subject to bump in the migration's first PR; pin them in lockstep):

- `puppeteer-core` ≥ 23.x (matches the spike's puppeteer 23.0).
- `@puppeteer/browsers` for the build-time download script.
- `chrome-headless-shell` matched to whatever puppeteer-core's compatibility matrix names current at the time of the bundling PR.
- `maplibre-gl` stays at the version preview already uses (currently `^5.22.0`). **Bumping it is a single PR** that touches both preview (`MapView.tsx`) and the new renderer; we never let the two drift.

### 2.2 Sidecar shape: **one long-running Node process per worker, one persistent browser, one persistent page; recycle the page on the existing K-frame cadence**

The Rust orchestrator stays. It still spawns `worker_count` Node sidecars (1 today; ≥1 once we restore parallelism), still drives the same setup → ready → render*N → recycle → render*N → shutdown state machine.

What changes inside a worker:

- **Boot:** instead of `new mbgl.Map(...)`, the worker launches a Chromium browser via `puppeteer.launch({ executablePath, headless: 'shell', args: [...] })`, opens one Page, navigates it to `about:blank`, injects an HTML+JS bootstrap that constructs `new maplibregl.Map({...})` against an in-memory style spec, applies the `painter.render` patch, and signals "ready" once the page has fired the maplibre `'load'` event.
- **Per frame:** the worker calls `page.evaluate(...)` to (a) `setNow(project_time_ms)`, (b) push per-frame source data via `getSource(id).setData(...)` and per-frame paint via `setPaintProperty(...)`, (c) `jumpTo({...})` the camera, (d) wait for `idle` + two rAFs, then (e) calls `page.screenshot({ type: 'png', captureBeyondViewport: false, omitBackground: true })` and decodes to RGBA via the same length-prefix protocol the orchestrator already reads.
- **Recycle:** close and replace the Page (not the whole browser). Mirrors the existing `recycle` semantics (rebuild map, preserve setup) but at a level the puppeteer crash-recovery community treats as canonical [(rendershot.io fix #4)](https://rendershot.io/blog/headless-chromium-fleet-memory). Cheaper than relaunching the browser; sufficient for memory-fragmentation reset because Chromium frees per-page allocations on Page close.
- **Browser-level scheduled restart:** layered defense from [(rendershot.io fix #3)](https://rendershot.io/blog/headless-chromium-fleet-memory). Restart the entire browser every M page-recycles (M=10 default; tunable). The sidecar absorbs this internally; orchestrator never sees it.
- **Shutdown:** orderly browser close on stdin EOF, fall back to `kill` after `SHUTDOWN_TIMEOUT` (already wired in `orchestrator.rs`).

Why one persistent browser per Node process and not "one browser shared across orchestrator's N workers" — orchestrator owns the multi-worker frame distribution; collapsing to a single browser would force per-page concurrency inside the sidecar, which puppeteer handles less reliably than parallel processes [(Browserless on memory leaks at >100 tabs/page)](https://www.browserless.io/blog/headless-chrome). Keep the orchestrator's process-per-worker model; let each worker own its own browser. This is how Remotion scales [(renderFrames docs)](https://www.remotion.dev/docs/renderer/render-frames).

### 2.3 Chromium bundling: **`@puppeteer/browsers` install at build time → Tauri `externalBin` per platform**

Concretely:

1. `npm run build:renderer` (extended): after esbuild bundling the worker, runs `npx @puppeteer/browsers install chrome-headless-shell@<pinned>` into `src-tauri/binaries/chrome-headless-shell-<target-triple>/`. The `@puppeteer/browsers` CLI [(API docs)](https://pptr.dev/browsers-api) handles per-platform downloads and unpacks to a known directory layout.
2. `tauri.conf.json` adds these to `bundle.externalBin` (alongside `node-<target-triple>` and `renderer-<target-triple>`). The Tauri docs [(externalBin)](https://v2.tauri.app/develop/sidecar/) require the `-<target-triple>` suffix on every binary.
3. At runtime, the worker resolves `chrome-headless-shell`'s path relative to the sidecar binary (Tauri's resource resolution path; same mechanism task 130 uses for `node` and the worker bundle).
4. CI cross-builds: each target triple builds its own headless-shell. `@puppeteer/browsers install` accepts `--platform` for foreign-platform downloads, so a macOS CI host can produce the Windows headless-shell artifact.

**Install size, quantified:**

| Component | Size | Notes |
|---|---|---|
| `chrome-headless-shell` (macOS) | ~120 MB | Smaller than Chrome for Testing's ~170 MB [(puppeteer install docs)](https://pptr.dev/guides/installation) |
| `chrome-headless-shell` (Windows) | ~150 MB | Smaller than Chrome for Testing's ~280 MB |
| `node` runtime | ~80 MB | Already planned by task 130 |
| Worker bundle (`renderer.cjs`) | ~3 MB | Includes maplibre-gl-js bundled via esbuild |
| `@maplibre/maplibre-gl-native` `.node` | ~30 MB | **Removed** by this migration |

Net change from this migration: `+120 MB to +150 MB` per platform. This is the cost line. We pay it because (a) the wobble fix has no alternative, (b) Tauri's webview already proves users tolerate large per-platform installers when the app actually does something, and (c) the bundle is well under Electron's typical floor of ~150 MB even with Chromium added [(Tauri vs Electron sizing)](https://www.gethopp.app/blog/tauri-vs-electron).

**Why not ship Playwright-managed browsers, puppeteer's bundled Chromium, or rely on system Chrome:**

- `puppeteer` (bundled): same binary as headless-shell ends up downloaded, but the download path is opaque, and we'd be coupling app builds to whatever puppeteer's postinstall hook decides. Explicit `@puppeteer/browsers install` is auditable.
- Playwright managed: heavier metadata, ships three-browser registry whether we want it or not, doesn't fit `externalBin` as cleanly.
- System Chrome: defeats determinism (different versions across users → different rendering) and the install-flow UX cost is real.

### 2.4 Tile cache integration: **`addProtocol` rewriting all OpenFreeMap URLs to a `trailcut://` scheme; the protocol handler bridges to existing `tileCache.ts` over a Node-side function call**

Chromium's network stack will not traverse our existing on-disk cache for free; that cache is reached via the `request()` callback in maplibre-native, which has no equivalent in maplibre-gl-js's network path. The four candidate mechanisms:

| Option | Decision |
|---|---|
| CDP `Fetch.requestPaused` interception in puppeteer | ❌ Per-request CDP roundtrips are slow [(puppeteer interception guide)](https://pptr.dev/guides/network-interception); fragile under crash recovery (lose intercepts on Page reload). |
| Local HTTP proxy in front of OpenFreeMap | ❌ Adds a port, a process, TLS config, and one more failure mode. |
| Service worker inside the rendered page | ❌ Lifecycle quirks in headless; activation timing unreliable. |
| **`addProtocol` + Node IPC** | ✅ **Selected** |

Implementation outline:

1. The worker's HTML bootstrap calls `maplibregl.addProtocol('trailcut', loader)` once before constructing the map. `addProtocol` is the supported maplibre-gl-js extension point and explicitly returns `{ data: ArrayBuffer }` from arbitrary sources [(addProtocol docs)](https://maplibre.org/maplibre-gl-js/docs/API/functions/addProtocol/).
2. The style spec is rewritten in-place at boot: every `https://tiles.openfreemap.org/...` URL (style JSON, sprite, glyphs, tiles) is rewritten to `trailcut://<sha256-of-original>?u=<base64-original>`. This is a one-pass walk on the parsed style; small.
3. `loader(params, ctrl)` posts a message to Node via puppeteer's `page.exposeFunction('trailcutFetch', fn)`. The Node-side `fn(originalUrl)` is the existing `tileCache.get(url, fetchUrl, cb)` from `src-tauri/sidecars/renderer/tileCache.ts`, returning the same `Buffer` it returns today. The Buffer is transferred to the page as a `Uint8Array`; the loader returns `{ data }`. **`tileCache.ts` is unchanged.** This is the migration's biggest carry-over.
4. Cache hit-rate parity is exact: same URLs → same sha256 keys → same on-disk paths → same bytes. Determinism property (sect. 035) preserved.

Critically, **`maplibre-gl-js`'s `transformRequest` is the wrong primitive here.** `transformRequest` only rewrites URL/headers/credentials/method [(RequestParameters docs)](https://maplibre.org/maplibre-gl-js/docs/API/type-aliases/RequestParameters/); it cannot return a body. `addProtocol` is the only API that lets us short-circuit the fetch.

### 2.5 Where the monkey-patch lives and how it's tested

The patch:

```js
const _origRender = window.map.painter.render.bind(window.map.painter);
window.map.painter.render = function (style, options) {
  return _origRender(style, { ...options, moving: true });
};
```

Lives in the worker's HTML bootstrap, applied **immediately after** `new maplibregl.Map(...)` returns and **before** any frame is drawn. Worker source ships the bootstrap as an inlined string constant; esbuild bundles it; no separate file.

**Upstream coverage check** (open question — see §7): a brief search for upstream issues around `painter.render(style, options.moving)` snap-to-pixel-grid behavior turned up nothing actionable [(maplibre-gl-js issues #1014, #4871)](https://github.com/maplibre/maplibre-gl-js/issues/1014). Plan assumes the patch persists indefinitely; ship it, gate the migration's smoke test on its presence.

**Testing the patch:**

- A new Vitest unit test, `painterPatch.test.ts`, asserts that on a freshly constructed `maplibregl.Map` instance running under `jsdom` with a stub WebGL context, `map.painter.render` is the wrapped version (i.e. inspects `.toString()` for the `moving: true` literal, or wraps and asserts the wrapper's identity via a sentinel).
- A golden-frame integration test (see §5) renders one frame from a slow-pan camera path and diffs against a committed PNG. If the patch ever regresses, the diff blows up.

---

## 3. Visual parity guarantees

The new sidecar imports from `src/lib/mapVisuals/`, `src/lib/cameraIntent.ts`, `src/lib/routeLocation.ts` exactly as the current one does — esbuild bundles the same sources into `dist/renderer.cjs`. The worker code applies them; it does not redefine them.

What gets **deleted** because the JS API is the right shape:

| Worker quirk that goes away | Why it goes away |
|---|---|
| `adaptForNative()` LineString degeneracy adapter (`index.ts:162-179`) | `maplibre-gl-js` accepts the same payload preview already produces — no native validator throwing on empty LineStrings. |
| `removeLayer + removeSource + addSource + addLayer` dance for dynamic GeoJSON (`applyDynamicSource`, `index.ts:348-368`) | Replaced by `getSource(id).setData(geojson)` — one call. |
| `setPaintProperty` typed as `any` workaround (file-header note 3) | `maplibre-gl-js`'s typings include `setPaintProperty`; map var is properly typed. |
| Per-Map `request` callback wiring (`index.ts:215-227`) | Replaced by `addProtocol` (§2.4). |
| Style-JSON pre-fetch + `map.load(parsedObject)` (`fetchStyleJson` at `index.ts:183-201`) | `maplibre-gl-js` accepts a URL or a parsed style; we pass the rewritten style spec object directly. |
| `DYNAMIC_LAYERS_BY_SOURCE` / `LAYER_SPEC_BY_ID` helper tables (`index.ts:316-327`) | The remove/re-add cycle they support is gone. |

What stays exactly the same:

- `buildStyleSpec`, `buildStaticSourceData`, `buildPerFrameState`, `BUILDINGS_LAYER_SPEC`, all `*_LAYER` exports.
- `cameraAt(timeline, t)` evaluation; `activeClipIdAt(timeline, t)` resolution.
- `indexRoute(route)` cached at boot, fed into `buildPerFrameState` per frame.
- `tileCache.ts` — unmodified.
- The Rust-side `protocol.rs` / `orchestrator.rs` — unmodified.

**Parity-by-import grep, carried forward as an acceptance criterion** (mirrors task 020):

```sh
grep -rE "addLayer|setPaintProperty\b.*('route|'waypoints|'live-marker)" \
  src-tauri/sidecars/renderer/index.ts
```

…must return no matches not covered by `state.paints.*` lookups. Visual decisions stay single-sourced.

---

## 4. Migration sequence

Each step is a discrete PR and leaves the app working. The old sidecar stays present and default until step 4.

### Step 1 — Add the new sidecar alongside the existing one
**New files:**
- `src-tauri/sidecars/renderer-chromium/index.ts` — new worker source.
- `src-tauri/sidecars/renderer-chromium/bootstrap.html.ts` — exported HTML+JS string constant.
- `src-tauri/sidecars/renderer-chromium/build.mjs` — extends current build script, adds `@puppeteer/browsers install chrome-headless-shell` step.
- `src-tauri/sidecars/renderer-chromium/__tests__/protocol.test.ts` — process-level test mirroring `renderer/__tests__/protocol.test.ts`.
- `src-tauri/sidecars/renderer-chromium/__tests__/painterPatch.test.ts` — unit test for the patch wrapper.
- `src-tauri/sidecars/renderer-chromium/tsconfig.json` — Node-target tsconfig, includes shared `src/lib/mapVisuals/` etc.

**Modified files:**
- `package.json`: add `puppeteer-core`, `@puppeteer/browsers`, `maplibre-gl` (already present); add `build:renderer-chromium` and `test:renderer-chromium` scripts.
- Reuse `src-tauri/sidecars/renderer/tileCache.ts` from the new sidecar (relative import; no copy).

**Untouched:** `src-tauri/src/export/orchestrator.rs`, `protocol.rs`, the existing renderer, all Rust tests. The new bundle resolves to a different path; nothing routes to it yet.

**Acceptance:** `npm run build:renderer-chromium && npm run test:renderer-chromium` passes locally. Existing `npm run test:run` and `cargo test --features integration_export` still pass.

### Step 2 — Switch via env flag for dev validation
**Modified:** `OrchestratorConfig` in `src-tauri/src/export/orchestrator.rs` — read `TRAILCUT_RENDERER` env var (`native` | `chromium`, default `native`). Toggle resolves `renderer_cjs_path` between the two bundles.

**Acceptance:** `TRAILCUT_RENDERER=chromium cargo test --test render_export_map_only --features integration_export -- --nocapture` passes against the new sidecar. The existing tests stay green by default.

### Step 3 — Visual parity check on a fixture project (golden frames)
**New:** `src-tauri/tests/fixtures/golden-frames/` — committed PNGs of frames 0, 30, 60, 120 from the wobble repro camera path (slow-pan over OpenFreeMap liberty), produced by the new sidecar. **New** Rust test `src-tauri/tests/golden_frame_parity.rs` (gated on `integration_export`) re-renders those frames, decodes the worker's output to PNG, and compares pixel-for-pixel within a tolerance (configurable; expected to be byte-identical for vector styles, see §6 risk).

**Acceptance:** Test passes at the chosen tolerance. The fixture is the wobble-fix regression guard; future maplibre-gl version bumps run this test as a blocker.

### Step 4 — Cut over default
**Modified:** `OrchestratorConfig::default()` flips `renderer_cjs_path` to the chromium build. `TRAILCUT_RENDERER=native` now opts into the legacy renderer for hotfix purposes only.

**Modified:** `tauri.conf.json` adds `chrome-headless-shell-<target-triple>` to `bundle.externalBin`. (This is the line that grows the installer.)

**Modified:** `docs/export/PLAN.md` — flip §"Renderer architecture" decision summary; new §"Renderer architecture v2" section explaining the wobble fix and the Chromium bundling cost.

**Acceptance:** All `render_export_*.rs` integration tests pass. App-level smoke export of a real fixture project produces a clean, wobble-free `.mov`.

### Step 5 — Remove old sidecar + dependency
**Deleted:**
- `src-tauri/sidecars/renderer/index.ts`, `build.mjs`, `tsconfig.json`, `__tests__/protocol.test.ts`, `__tests__/setupFixture.ts`. (Keep `tileCache.ts` — moved into `renderer-chromium/` or a shared `sidecars/lib/`.)
- `@maplibre/maplibre-gl-native` from `package.json` devDependencies and `package-lock.json`.

**Renamed:** `renderer-chromium/` → `renderer/`. The new sidecar is the only renderer.

**Modified:** `OrchestratorConfig` drops the env-flag toggle.

**Acceptance:** `cargo test --features integration_export` still passes against the renamed paths. `grep -r 'maplibre-gl-native' .` returns nothing.

### Step 6 — Tile cache integration cleanup
The cache itself is preserved as-is. Audit the call sites that `addProtocol` now exercises:

- `tileCache.ts` `get(url, fetcher, cb)` is called from the Node side of the `exposeFunction` bridge — same signature, same semantics.
- The hash-key remains keyed on the **original** OpenFreeMap URL (the `?u=` parameter), not on the rewritten `trailcut://` URL. Without this, every fresh export recomputes hashes and trashes the cache. Implementation: the Node-side bridge function unwraps the original URL before delegating to `tileCache.get`.

**Modified:** `docs/export/tasks/035-shared-tile-cache.md` — append a postscript noting the post-migration call path. No structural change to the doc.

**Acceptance:** `tileCache.test.ts` still passes (it's pure module test, doesn't care about callers). A new test asserts that after one export run, `~/.trailcut/tile-cache/` contains entries hashed on the **original** URLs.

---

## 5. Test plan

Per-test verdicts:

| Test | Verdict | Action |
|---|---|---|
| `src-tauri/sidecars/renderer/__tests__/protocol.test.ts` | **Rewrite** | Rewritten as `renderer-chromium/__tests__/protocol.test.ts`. Same wire-format assertions; first-frame budget bumped from 30 s → 45 s to absorb cold Chromium launch. |
| `src-tauri/sidecars/renderer/__tests__/tileCache.test.ts` | **Carry over unchanged** | Pure module test; doesn't care about callers. |
| `src-tauri/sidecars/renderer/__tests__/setupFixture.ts` | **Carry over** | Setup payload is sidecar-agnostic. Move into renamed dir at step 5. |
| `src-tauri/tests/render_export_map_only.rs` | **Carry over** | Gated `--features integration_export`; uses the orchestrator's renderer-resolution path. Will exercise the new sidecar after step 4 with no test-code changes. |
| `src-tauri/tests/render_export_video_only.rs` | **Carry over** | Same. |
| `src-tauri/tests/render_export_composite.rs` | **Carry over** | Same. |
| `src-tauri/tests/encoder_probe.rs` | **Carry over unchanged** | Touches FFmpeg, not the renderer. |
| `src-tauri/tests/orchestrator.rs` | **Carry over** | Drives the orchestrator state machine; sidecar-agnostic at the level of asserted contracts. |
| `src-tauri/tests/layout_parity.rs` | **Carry over** | Layout-math test; not a renderer test. |

Tests added by this migration:

1. **`painterPatch.test.ts`** — unit test for the wrapper presence (sect. 2.5).
2. **`addProtocolBridge.test.ts`** — Node-side bridge unit test: a stub `tileCache.get` is invoked through the `trailcutFetch` exposed function, asserts the original URL is unwrapped before lookup.
3. **`golden_frame_parity.rs`** — wobble-fix regression guard (sect. 4 step 3). Critical: this is the only test that ties the migration's *visual* claim to CI.
4. **Camera-path determinism check** in `protocol.test.ts`: render frame N twice in two consecutive worker boots; assert the two RGBA buffers are byte-identical. Catches non-determinism introduced by `setNow` regressions, missing rAFs, or random tile-load races.

Test gating remains: default `npm run test:run` and `cargo test` are fast; `--features integration_export` and `npm run test:renderer-chromium` are the heavy gates that need the bundle and FFmpeg/Chromium on PATH.

---

## 6. Performance budget & monitoring

**Per-frame budget at 1080×1920, single worker, warm tiles** (target — to be refined against the first end-to-end run):

| Phase | Budget | Source |
|---|---|---|
| `setNow` + state push (`page.evaluate`) | ≤ 10 ms | maplibre-gl-js setSource/setPaint are O(features); our per-frame deltas are tiny [(setNow API)](https://maplibre.org/maplibre-gl-js/docs/API/functions/setNow/). |
| `jumpTo` + render to `idle` | 30–80 ms warm; up to ~500 ms cold | Replit's published numbers for similar deterministic-clock workloads [(Replit blog)](https://blog.replit.com/browsers-dont-want-to-be-cameras). |
| Two rAFs post-`idle` | ~33 ms | Two frame slots at 60 Hz. |
| `page.screenshot` (PNG raw, no clipping) | 80–150 ms | Bannerbear's published 1920px-tall screenshots at this range [(Bannerbear screenshot perf)](https://www.bannerbear.com/blog/ways-to-speed-up-puppeteer-screenshots/) |
| **Total warm per frame** | **~150–300 ms** | |
| Cold first frame (browser launch + tile prefetch warm-up) | ≤ 5 s | Spike measurement with warm-up jump. |

A 30-second 30 fps export = 900 frames. At 250 ms/frame warm: **3:45 wall-clock** for a single-worker map-only export. Worker_count=2 (when restored) halves it. This sits roughly on par with the maplibre-native budget shipped today (the spike measured them comparable; native won on speed but lost on wobble).

**Memory ceiling** (per Node + browser pair, observed):
- Node: ~80 MB resident.
- Browser: ~250 MB at startup, growing to ~600 MB over a 60-frame chunk before page recycle.
- Recycle drops back to ~280 MB. [(rendershot.io fix #3 corroborates the recycle cadence as the right knob)](https://rendershot.io/blog/headless-chromium-fleet-memory).

**Max export duration** (representative project, 5-clip / 90-second hike at 30 fps, 1080×1920, single worker): ≤ 12 minutes wall-clock. Exceeding 20 minutes triggers a perf-regression alert (manual; we don't have monitoring infra). The first real export run after step 4 cuts over locks these numbers in or causes a re-budget.

**Monitoring (lightweight):** worker emits one stderr line per recycle with `{frame_index, page_rss_mb, browser_rss_mb, hits, misses}` from the cache stats. Orchestrator forwards to parent stderr (already wired). Real telemetry is out of scope.

---

## 7. Risks & open questions

**R1 — `painter.render` patch fragility across maplibre-gl-js versions.** The patch depends on `painter.render(style, options)` keeping its signature. If maplibre-gl refactors `painter` (e.g. into the WebGPU backend they're prototyping [(MapLibre Newsletter Apr 2026)](https://maplibre.org/news/2026-05-02-maplibre-newsletter-april-2026/)), the patch silently no-ops and wobble returns. **Mitigation:** the golden-frame test (sect. 5) blows up on regression. **Open:** is there an upstream issue we should file proposing a public `Map` option for `painter.render({moving: true})` so we can eventually delete the monkey-patch? Search turned up no existing thread; worth opening one ourselves.

**R2 — Tile-cache hash-key parity.** The migration must hash on the **original** OpenFreeMap URL, not the rewritten `trailcut://` URL, or every fresh export starts from a cold cache. Step 6 has the audit but it's the place a careless refactor will silently regress; flag it explicitly in the cutover PR.

**R3 — Two rAFs may not be enough for dense label collisions.** The spike's "two rAFs after idle" was verified for raster + simple vector; symbol placement after `idle` continues over multiple frames. OpenFreeMap liberty has a fair amount of label density. **Mitigation:** the golden-frame fixture covers a label-dense camera frame; the parity check is the canary.

**R4 — Bundle size growth (~120–150 MB per platform).** Costed and accepted in §2.3. Open question for the bundling PR: do we ship a single-arch installer per platform, or universal? If universal on macOS, double the headless-shell cost. **Lean: per-arch.**

**R5 — Cold-start UX on first export.** Browser launch is ~1.5 s; first tile prefetch warm-up adds ~3 s. User clicks "Export" → no progress for ~5 s → impatience. **Mitigation:** prelaunch the browser when the user opens the export modal, before they click Start. Worker stays parked between exports until a global idle timeout. Defer to a follow-up task; current spike behavior is acceptable.

**R6 — Windows determinism.** The spike was run on macOS only. ANGLE on Windows can produce subtly different fragment shading (sub-pixel rounding, anti-aliasing). The golden-frame fixture must be **per-platform**. **Open:** acceptable tolerance for cross-platform pixel diffs, or ship per-platform fixtures? **Lean: per-platform fixtures**, treat cross-platform parity as a "nice to have" not a hard guarantee.

**R7 — `chrome-headless-shell` version drift over time.** Chrome ships fast; pinning headless-shell to a specific version means we ship security-stale Chromium until we proactively bump. **Mitigation:** add a quarterly bump task; gate the bump behind golden-frame regression test. Less risky for an offline-first desktop renderer than for a server-side service, but flag it.

**R8 — `setNow` interaction with `idle`.** maplibre-gl-js's `idle` event may not account for the frozen-clock case; symbol fade-in animations driven by `now()` could wedge if the clock never advances between `jumpTo` and `idle`. **Verify in step 1 protocol.test.ts** by rendering several frames and asserting `idle` fires within budget for each.

---

## Appendix — Citations

- [Browserless: Headless Chrome Explained](https://www.browserless.io/blog/headless-chrome) — CDP traffic comparison, memory leak realities.
- [Puppeteer headless modes](https://pptr.dev/guides/headless-modes) — `headless: 'shell'` semantics.
- [Puppeteer installation & system requirements](https://pptr.dev/guides/installation) — bundle size ranges.
- [@puppeteer/browsers API](https://pptr.dev/browsers-api) — install programmatic API.
- [Chrome for Developers: Download chrome-headless-shell](https://developer.chrome.com/blog/chrome-headless-shell) — post-Chrome-132 status.
- [Remotion: Chrome Headless Shell](https://www.remotion.dev/docs/miscellaneous/chrome-headless-shell) — production reference for browser-based video rendering, defaults to headless-shell.
- [Remotion: renderFrames](https://www.remotion.dev/docs/renderer/render-frames) — process-per-worker scaling pattern.
- [Replit: We Built a Video Rendering Engine by Lying to the Browser About What Time It Is](https://blog.replit.com/browsers-dont-want-to-be-cameras) — clock virtualization, warm-up frames.
- [rendershot.io: four fixes for a fleet that kept eating RAM](https://rendershot.io/blog/headless-chromium-fleet-memory) — page recycle, scheduled browser restart, semaphore-bounded concurrency.
- [maplibre-gl-js setNow API](https://maplibre.org/maplibre-gl-js/docs/API/functions/setNow/) — frame-by-frame deterministic time.
- [maplibre-gl-js addProtocol API](https://maplibre.org/maplibre-gl-js/docs/API/functions/addProtocol/) — custom URL schemes returning `{ data: ArrayBuffer }`.
- [maplibre-gl-js RequestParameters](https://maplibre.org/maplibre-gl-js/docs/API/type-aliases/RequestParameters/) — confirms `transformRequest` cannot return body.
- [maplibre-gl-js discussion #6728: How to intercept tile requests](https://github.com/maplibre/maplibre-gl-js/discussions/6728) — `transformRequest` vs `addProtocol` guidance from maintainers.
- [Bannerbear: 8 Tips for Faster Puppeteer Screenshots](https://www.bannerbear.com/blog/ways-to-speed-up-puppeteer-screenshots/) — `optimizeForSpeed`, buffer-vs-file.
- [Tauri v2 externalBin](https://v2.tauri.app/develop/sidecar/) — per-target-triple bundling.
- [Tauri vs Electron sizing](https://www.gethopp.app/blog/tauri-vs-electron) — installer size context.
- [maplibre-gl-js #1014: Markers jump in 1 pixel](https://github.com/maplibre/maplibre-gl-js/issues/1014), [#4871: Custom Layer jumping at high zoom](https://github.com/maplibre/maplibre-gl-js/issues/4871) — adjacent (but not identical) snap-to-pixel issues; no upstream fix touches our case.
- [MapLibre Newsletter Apr 2026](https://maplibre.org/news/2026-05-02-maplibre-newsletter-april-2026/) — current development priorities (WebGPU backend), informs R1.
