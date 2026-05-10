# Task 115 — Chromium renderer sidecar (build alongside native, do not route)

**Step**: Export pipeline (renderer migration step 1 of 5 — see [`../plans/chromium-renderer.md`](../plans/chromium-renderer.md))
**Estimated effort**: ~3 days (18–24h)
**Status**: pending
**Depends on**: 010 (shared `mapVisuals` module), 020 (renderer worker — protocol contract), 030 (orchestrator — drives the protocol unchanged), 035 (tile cache — reused unchanged).

## Goal

Stand up a second renderer sidecar at `src-tauri/sidecars/renderer-chromium/` that produces RGBA frames for the same `(timeline, t)` inputs as the existing maplibre-native worker, but via headless Chromium running `maplibre-gl-js`. Same wire protocol. Same `src/lib/mapVisuals/` imports. Same on-disk tile cache. **Nothing routes to it yet** — the existing renderer stays the default; this task only adds a second bundle that the orchestrator can be pointed at via env flag in 116.

The single architectural justification is the slow-pan **wobble** the native binding produces on sub-pixel camera deltas (≪ 1 px/frame). The spike on `export-test` (commits `13b2ff4`, `6f4a185`, since reverted by `bbf7a44`) confirmed that running the same camera path through `maplibre-gl-js` in headless Chromium with a four-line `painter.render` `moving=true` patch eliminates it. This task lands that patch in production-shaped code.

**The load-bearing invariant — visual parity by import.** The new sidecar imports `buildStyleSpec`, `buildStaticSourceData`, `buildPerFrameState`, `BUILDINGS_LAYER_SPEC`, all `*_LAYER` exports, `cameraAt(timeline, t)`, `activeClipIdAt(timeline, t)`, `indexRoute(route)`, and the `Clip` / `Route` / `MapSettings` types from `src/lib/mapVisuals/`, `src/lib/cameraIntent.ts`, `src/lib/routeLocation.ts`, `src/types.ts`. It applies them; it does not redefine them. The grep from task 020 carries forward: any `addLayer` / `setPaintProperty` literal that doesn't reference `state.paints.*` is a parity violation.

**The second load-bearing invariant — tile cache hash-key parity.** The cache (035) is content-addressed by sha256 of the **original** OpenFreeMap URL. The migration's `addProtocol` bridge rewrites every OpenFreeMap URL in the style spec to a `trailcut://<sha-of-original>?u=<base64-original>` URL so maplibre-gl-js's network path can be intercepted. The Node-side bridge function MUST unwrap `?u=` and pass the original URL into `tileCache.get` — never hash on the rewritten `trailcut://` URL. Without this, every fresh export starts from a cold cache and the spike's offline determinism property regresses. Test for it in this task; do not defer.

## Architecture decisions (recap from plan)

- **Headless-browser library:** `puppeteer-core` + bundled `chrome-headless-shell`. Not `puppeteer` (auto-download), not `playwright` (cross-browser surface we don't need), not raw CDP (no perf reason).
- **Sidecar shape:** one Node process per worker (orchestrator's process-per-worker model unchanged), one persistent `Browser`, one persistent `Page`. Recycle the `Page` on the orchestrator's existing K-frame cadence; the browser stays up. Layered defense: restart the entire `Browser` every M=10 page-recycles, absorbed inside the sidecar (orchestrator never sees it).
- **Tile cache integration:** `maplibregl.addProtocol('trailcut', loader)` in the page; loader posts to Node via `page.exposeFunction('trailcutFetch', fn)`; Node-side `fn` unwraps the original URL from `?u=` and delegates to `tileCache.get(originalUrl, fetchUrl, cb)`. `transformRequest` is the wrong primitive — it can't return a body.
- **The patch:** wraps `map.painter.render(style, options)` to force `moving: true` in `options` on every call, immediately after `new maplibregl.Map(...)` returns and before any frame is drawn.

See [`../plans/chromium-renderer.md`](../plans/chromium-renderer.md) §2 for the full rationale.

## Files to touch

- New: `src-tauri/sidecars/renderer-chromium/index.ts` — the worker source. Boot launches Chromium via `puppeteer.launch({ executablePath, headless: 'shell', args: [...] })`, opens a `Page`, navigates to `about:blank`, sets the page content to the bootstrap HTML, exposes the `trailcutFetch` function, awaits the `'load'` event from `maplibregl.Map`. Per-frame `page.evaluate(...)` drives `setNow` + per-frame source/paint deltas + `jumpTo`, awaits `idle` + two rAFs, then `page.screenshot({ type: 'png', captureBeyondViewport: false, omitBackground: true })`, decodes PNG → raw RGBA, and writes the existing 4-byte BE length prefix + RGBA bytes to stdout. Stdin loop, queue, recycle (close + reopen `Page`, preserving `Browser`), browser-level scheduled restart every M page-recycles, orderly shutdown on stdin EOF — mirror the existing `index.ts` state machine 1:1.

- New: `src-tauri/sidecars/renderer-chromium/bootstrap.html.ts` — exports a single `BOOTSTRAP_HTML: string` constant. The HTML inlines:
  - The `maplibre-gl` JS bundle (via `import maplibregl from 'maplibre-gl'` + a small wrapper that exposes it on `window.maplibregl`; esbuild bundles the page-side script in a separate build pass — see `build.mjs` below).
  - A page-side `init()` function that:
    1. Calls `maplibregl.addProtocol('trailcut', (params, abortController) => { ... })`. The loader extracts the original URL from `params.url`'s `?u=` parameter (base64-decode), invokes `window.trailcutFetch(originalUrl)` (the `exposeFunction` bridge — returns `Promise<{ ok: true, bytes: Uint8Array } | { ok: false, error: string }>`), and resolves with `{ data: bytes.buffer }` on success or rejects on failure.
    2. Receives the rewritten style spec object via a `window.__init(setupPayload)` call from Node-side `page.evaluate`.
    3. Constructs `new maplibregl.Map({ container, style: rewrittenStyle, ... })`.
    4. **Applies the painter patch immediately**:
       ```js
       const _origRender = map.painter.render.bind(map.painter);
       map.painter.render = function (style, options) {
         return _origRender(style, { ...options, moving: true });
       };
       ```
    5. Awaits `'load'`, then signals readiness back to Node via a resolved promise from `page.evaluate`.
  - A page-side `applyFrame(state, camera)` function used by per-frame `page.evaluate` to push source/paint deltas and `jumpTo` the camera, then await `idle` + two rAFs.

- New: `src-tauri/sidecars/renderer-chromium/styleRewriter.ts` — pure helper. `rewriteStyleSpecForTrailcut(style: object): object` walks the parsed style JSON and replaces every `https://tiles.openfreemap.org/...` URL (style root, `sprite`, `glyphs`, every `sources[*].url` and `tiles[*]`) with `trailcut://<sha256-of-original-hex>?u=<base64-of-original>`. Returns a new object — no mutation of the input. Unit-tested as a pure function.

- New: `src-tauri/sidecars/renderer-chromium/trailcutFetch.ts` — pure helper. `unwrapTrailcutUrl(rewrittenUrl: string): string` extracts and base64-decodes the `?u=` parameter, returning the original OpenFreeMap URL. Throws on malformed input. The `trailcutFetch` function on the Node side is the composition: `unwrapTrailcutUrl` → `tileCache.get(original, fetchUrl, cb)` → respond with `{ ok: true, bytes }` (or `{ ok: false, error }`).

- New: `src-tauri/sidecars/renderer-chromium/build.mjs` — extends the existing `renderer/build.mjs` pattern:
  1. `tsc --noEmit` on the worker tsconfig.
  2. esbuild bundle worker → `dist/renderer.cjs`. Externalize `puppeteer-core` (don't bundle it — it's a Node dep that resolves at runtime against `node_modules`).
  3. esbuild bundle the page-side script → an inline string constant consumed by `bootstrap.html.ts`. Includes `maplibre-gl` (full bundle), the `init()` and `applyFrame()` page-side functions, and the painter patch. **`maplibre-gl` is bundled into the page script, not externalized** — the page is a sandboxed environment, no node_modules.
  4. esbuild bundle the setup-fixture (mirroring `renderer/build.mjs`) → `dist/setup_fixture.cjs`.
  5. Run `npx @puppeteer/browsers install chrome-headless-shell@<pinned>` into a per-target-triple directory under `src-tauri/binaries/` (deferred to task 118 — this build script doesn't yet write the binary; that's the cutover-step concern). For now, the build resolves `chrome-headless-shell` from a developer-local path via env (`TRAILCUT_CHROME_HEADLESS_SHELL`) so end-to-end testing can begin without the bundling pipeline in place.

- New: `src-tauri/sidecars/renderer-chromium/tsconfig.json` — Node-target tsconfig, mirroring `renderer/tsconfig.json`. Includes the shared `src/lib/mapVisuals/` etc. via project-relative paths.

- New: `src-tauri/sidecars/renderer-chromium/__tests__/protocol.test.ts` — process-level test mirroring `renderer/__tests__/protocol.test.ts`. Spawns the bundled `dist/renderer.cjs` as a child process (`node dist/renderer.cjs`), pipes a `setup` line + a small number of `render` lines on stdin, reads ready signal + length-prefixed RGBA frames from stdout, asserts: (a) the ready signal arrives, (b) each frame is the expected `viewport.w * viewport.h * 4` bytes, (c) two frames at the same `project_time_ms` are byte-identical (determinism check). First-frame budget: 45 s (vs 30 s for native, to absorb cold Chromium launch). Test gated behind the same env flag as the native test (`integration_renderer` or equivalent).

- New: `src-tauri/sidecars/renderer-chromium/__tests__/painterPatch.test.ts` — unit test. Constructs a stub `painter` object with a render method, applies the same patch wrapper the bootstrap uses (extracted into `bootstrap.html.ts` as an exported function `applyPainterPatch(painter)` for testability), asserts that subsequent `painter.render(style, options)` calls forward `{...options, moving: true}` to the original. Catches regressions of the patch's signature assumption.

- New: `src-tauri/sidecars/renderer-chromium/__tests__/styleRewriter.test.ts` — pure-function unit test. Feeds the OpenFreeMap liberty style JSON (a fixture or a small synthetic one), asserts every URL field is rewritten, asserts the `?u=` parameter base64-decodes to the original URL, asserts non-OpenFreeMap URLs are left untouched.

- New: `src-tauri/sidecars/renderer-chromium/__tests__/trailcutFetch.test.ts` — pure-function unit test. Asserts `unwrapTrailcutUrl` round-trips against `rewriteStyleSpecForTrailcut`'s output. Plus a Node-side bridge test: a stub `tileCache.get` implementation is invoked through the bridge function, asserts the stub receives the **original** OpenFreeMap URL (not the `trailcut://` URL). This is the explicit hash-key-parity regression guard.

- New: `src-tauri/sidecars/renderer-chromium/__tests__/setupFixture.ts` — re-exports `buildSetupPayload` from `renderer/__tests__/setupFixture.ts` (relative import). The fixture is sidecar-agnostic; we don't duplicate it.

- Modified: `package.json`:
  - Add: `puppeteer-core` (pinned to current latest stable as of 2026-05-08, expected ~24.x; verify on first install).
  - Add: `@puppeteer/browsers` (devDependency; used by the build script for the bundling step in task 118).
  - `maplibre-gl` already present at `^5.22.0` (preview uses it). Stays as-is; the new sidecar bundles the same version.
  - Add scripts: `build:renderer-chromium` → `node src-tauri/sidecars/renderer-chromium/build.mjs`. Add `test:renderer-chromium` → vitest runner pointed at the new test dir.
  - **Do not remove** `@maplibre/maplibre-gl-native` — that happens in task 119.

- Modified: `src-tauri/sidecars/renderer/tileCache.ts` — **untouched**. The new sidecar imports it via relative path: `import { createTileCache, defaultCacheDir } from '../renderer/tileCache'`. The shared module lives where it lives until task 119's rename moves it.

- Modified: `docs/export/tasks/README.md` — add row for 115 ⬜.

- Untouched: `src-tauri/src/export/orchestrator.rs`, `protocol.rs`, all Rust integration tests, the existing `src-tauri/sidecars/renderer/` worker. Task 116 wires the orchestrator to choose between bundles; this task only ships the second bundle.

## Deliverables

### Worker process state machine (mirrors `renderer/index.ts`)

```
boot → launch Browser (chrome-headless-shell, headless:'shell', args:[...])
     → newPage, page.setContent(BOOTSTRAP_HTML)
     → page.exposeFunction('trailcutFetch', nodeBridge)

setup (cmd) → rewrite style spec for trailcut://, page.evaluate(window.__init, payload)
            → await page promise (signals 'load' fired) → write {"ready":true}\n

render (cmd) → page.evaluate(window.__applyFrame, state, camera)
             → page.screenshot({ type: 'png', captureBeyondViewport: false, omitBackground: true })
             → decode PNG → RGBA → write length-prefixed bytes

recycle (cmd) → close current Page (NOT Browser); open new Page; re-run setup steps;
                if recycle_count_within_browser >= 10, also close + relaunch Browser
              → write {"ready":true}\n

shutdown / EOF → close Browser; exit 0
```

Key invariants that must hold for protocol parity with `renderer/index.ts`:
- The `setup` reply is exactly `{"ready":true}\n`. Same wire bytes.
- Each `render` reply is `[4-byte BE length][N RGBA bytes]`. Length = `viewport.w * viewport.h * 4`. No PNG-encoded bytes go on the wire — orchestrator expects raw RGBA.
- `recycle` reply is exactly `{"ready":true}\n`. Same wire bytes.
- Stdin parsing is line-delimited JSON. Malformed JSON is fail-fast (exit 1, stderr message).
- Render commands serialize on the worker side (one render at a time per worker — orchestrator's process-per-worker model is the parallelism).

### Painter patch — exact code

In `bootstrap.html.ts`, export:

```ts
export function applyPainterPatch(painter: any): void {
  const orig = painter.render.bind(painter);
  painter.render = function (style: any, options: any) {
    return orig(style, { ...options, moving: true });
  };
}
```

Page-side bootstrap calls `applyPainterPatch(map.painter)` on the line after `const map = new maplibregl.Map(...)` and before any rendering happens. Test in `painterPatch.test.ts`.

### Hash-key parity test — exact assertion

```ts
import { unwrapTrailcutUrl } from '../trailcutFetch';

test('Node bridge calls tileCache.get with the original URL, not the rewritten one', () => {
  const original = 'https://tiles.openfreemap.org/styles/liberty';
  const rewritten = `trailcut://abc123?u=${Buffer.from(original).toString('base64')}`;
  const calls: string[] = [];
  const stubCache = {
    get(url: string, _f: unknown, cb: (e: Error | null, b?: Buffer) => void) {
      calls.push(url);
      cb(null, Buffer.from('ok'));
    },
  };
  // bridge fn under test
  bridgeFetch(rewritten, stubCache);
  expect(calls).toEqual([original]);
});
```

Without this test the regression in plan §7 R2 is silent: a careless refactor changes `unwrapTrailcutUrl(...)` → `params.url`, every export starts cold, no functional test catches it because frames still render correctly.

### Per-frame `page.evaluate` payload shape

The Node side computes `state` using the same `buildPerFrameState(...)` call the native worker uses (imported from `src/lib/mapVisuals/`), then passes the result to the page:

```ts
await page.evaluate(
  (state, camera) => window.__applyFrame(state, camera),
  state,
  state.camera,
);
```

Page-side `__applyFrame`:
1. `maplibregl.setNow(t)` (frozen clock — pass `project_time_ms` through `state` or as a separate arg).
2. For each `(sourceId, data)` in `state.sources`: `map.getSource(sourceId).setData(data)`. Replaces the entire `removeLayer + removeSource + addSource + addLayer` dance from native.
3. For each `(layerId, prop, value)` in `state.paints`: `map.setPaintProperty(layerId, prop, value)`. Same five paint deltas the native worker applies.
4. `map.jumpTo({ center: [camera.center.lng, camera.center.lat], zoom: camera.zoom, bearing: camera.bearing, pitch: camera.pitch })`.
5. `await new Promise(resolve => map.once('idle', resolve))`.
6. `await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))` — two rAFs, per spike's empirical finding.

### What the new sidecar deletes (parity simplifications, not behavior changes)

| Native quirk gone | Why |
|---|---|
| `adaptForNative()` LineString degeneracy adapter | maplibre-gl-js accepts the same payload preview produces. |
| `removeLayer + removeSource + addSource + addLayer` for dynamic sources | Replaced by `getSource(id).setData(geojson)`. |
| `setPaintProperty` typed as `any` workaround | maplibre-gl-js's typings include `setPaintProperty`. |
| Per-Map `request` callback wiring | Replaced by `addProtocol`. |
| Style-JSON pre-fetch + `map.load(parsedObject)` (`fetchStyleJson` boot path) | maplibre-gl-js accepts a parsed style object directly; rewrite + pass. |
| `DYNAMIC_LAYERS_BY_SOURCE` / `LAYER_SPEC_BY_ID` helper tables | The remove/re-add cycle is gone. |

### Performance expectations (warm, single worker, 1080×1920)

| Phase | Budget |
|---|---|
| `setNow` + state push (`page.evaluate`) | ≤ 10 ms |
| `jumpTo` + render to `idle` | 30–80 ms warm |
| Two rAFs post-`idle` | ~33 ms |
| `page.screenshot` (PNG) + decode → RGBA (Node-side) | 80–150 ms |
| **Total warm per frame** | **~150–300 ms** |
| Cold first frame (browser launch + tile prefetch) | ≤ 5 s (test budget: 45 s for safety on cold CI) |

These are not hard SLAs; the budget refines after the first end-to-end run on real hardware. The protocol test asserts process correctness, not perf.

## Acceptance

- `npm run build:renderer-chromium` passes locally (assumes `TRAILCUT_CHROME_HEADLESS_SHELL` env points to a developer-local headless-shell binary; bundling pipeline lands in 118).
- `npm run test:renderer-chromium` passes — protocol + painterPatch + styleRewriter + trailcutFetch tests all green. Frames decode to expected byte length. Two-render determinism check passes.
- `npm run test:run` (existing Vitest run) and `cargo test --features integration_export` (existing Rust integration tests) **stay green** — task 115 is additive only.
- `grep -rE "addLayer|setPaintProperty\b.*('route|'waypoints|'live-marker)" src-tauri/sidecars/renderer-chromium/index.ts` returns no matches not covered by `state.paints.*` lookups (parity-by-import grep, carried forward from task 020).
- `grep -r "@maplibre/maplibre-gl-native" src-tauri/sidecars/renderer-chromium/` returns nothing — the new sidecar has zero dependency on the native binding.
- `tileCache.ts` is unmodified (`git diff src-tauri/sidecars/renderer/tileCache.ts` is empty).
