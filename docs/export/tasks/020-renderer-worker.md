# Task 020 — Renderer worker (Node + maplibre-native + stdio protocol)

**Step**: Export pipeline (the headless map-frame producer)
**Estimated effort**: ~1 day (6–10h)
**Status**: pending
**Depends on**: [010 — Shared `mapVisuals` module](./010-shared-mapvisuals-module.md). The whole point of this task is that the worker imports the same `mapVisuals` surface preview consumes; without 010 there is nothing legitimate to import.

## Goal

Build a long-running Node sidecar that renders map frames headlessly via `@maplibre/maplibre-gl-native`, driven by a line-delimited JSON protocol on stdin and writing length-prefixed raw RGBA buffers to stdout. The worker is what the Rust orchestrator (task 030) will spawn N copies of and stream into FFmpeg.

**The load-bearing invariant — visual parity by import.** The worker MUST NOT define its own layer specs, paint expressions, animation curves, or per-frame derivation logic. It composes per-frame state by calling `buildPerFrameState(...)` and friends from `src/lib/mapVisuals/` — the same surface `MapView.tsx` consumes. A change to marker color, slime-trail paint, pulse curve, active-clip highlighting, or any other visual decision is a one-PR change in `src/lib/mapVisuals/`; both preview and worker pick it up via the build graph. There is no "preview-side" or "export-side" version of any visual decision. This is the structural enforcement of PLAN.md §"Constraints and principles" → "Single source of visual truth".

**Camera invariant follows the same pattern.** The worker uses `cameraAt(timeline, t)` (which `buildPerFrameState` already calls internally) — no Rust port, no Node port, no parallel implementation of camera math. Worker and preview both apply `cameraAt(t)` directly per frame: preview via `map.jumpTo(...)` (recently landed in MapView's per-rAF render loop), worker via `map.render({...camera, width, height})`. Neither side eases the apply step. Any time-based curve (transition arcs, pulse) lives inside the shared module where both pipelines see it.

This task ships the worker process and its protocol harness only. The Rust orchestrator that spawns N workers, splits frame ranges, and drains stdout in order is task 030. Per-platform sidecar packaging into `src-tauri/binaries/renderer-<target-triple>` is task 130.

## Files to touch

- New: `src-tauri/sidecars/renderer/index.ts` — the worker source. Plain Node, no React/DOM, no browser globals. Imports from `../../../src/lib/mapVisuals/`, `../../../src/lib/cameraIntent`, `../../../src/lib/routeLocation`.
- New: `src-tauri/sidecars/renderer/build.mjs` — esbuild bundle script. Bundles `index.ts` → `dist/renderer.cjs` with `@maplibre/maplibre-gl-native` externalized, `platform: 'node'`, `format: 'cjs'`, `target: 'node20'`.
- New: `src-tauri/sidecars/renderer/tsconfig.json` — CJS-targeting tsconfig. Distinct from the root tsconfig because the worker is plain Node, not a browser bundle. `module: 'CommonJS'`, `moduleResolution: 'Node'`, `target: 'ES2022'`, `types: ['node']`, `noEmit: true` (esbuild does the emit; tsc is type-check only).
- New: `src-tauri/sidecars/renderer/__tests__/protocol.test.ts` — vitest process-level test. Builds the bundle (or assumes it's been built), spawns it via `child_process.spawn('node', ['dist/renderer.cjs'])`, walks the protocol (setup → render → recycle → render → shutdown), asserts:
  - First stdout line after setup is `{"ready":true}\n`.
  - After one render command, stdout yields a 4-byte big-endian length prefix followed by exactly `viewport.w × viewport.h × 4` bytes of RGBA, and the buffer is non-empty (not all zero).
  - After `{"cmd":"recycle"}`, stdout yields a fresh `{"ready":true}\n` and a subsequent render still produces a frame.
  - After `{"cmd":"shutdown"}`, the process exits 0 within a short timeout.
- Modified: root `package.json`:
  - Dev deps: `@maplibre/maplibre-gl-native`, `esbuild`.
  - Scripts: `"build:renderer": "node src-tauri/sidecars/renderer/build.mjs"`, `"test:renderer": "vitest run --config vitest.renderer.config.ts"`. The renderer test is a separate script (not folded into the default `test:run`) because it's slow (cold maplibre-native render is ~1–2s) and requires the bundle to be built first; CI runs `build:renderer && test:renderer` as a sibling of `test:run`. A dedicated `vitest.renderer.config.ts` is required because vitest 4 removed the `--include` CLI flag, and the default `vitest.config.ts`'s `include: ['src/**/*.test.ts']` would otherwise filter the worker test out. The renderer config sets `environment: 'node'` (no jsdom needed — the test spawns a child process and reads stdout) and points `include` at `src-tauri/sidecars/renderer/__tests__/**`. See "Testing" note below.
- Modified: `src-tauri/tauri.conf.json` — add a comment-style note (or a TODO in this doc only — no real Tauri-config keys are added in 020) that `bundle.externalBin` will list `binaries/renderer-<target-triple>` and `binaries/node-<target-triple>` once task 130 lands. Per-platform binary plumbing is intentionally out of scope here.
- Modified: `docs/export/tasks/README.md` — flip 010 to ✅, link 020 to this file, drop the "tasks beyond 010 are not yet authored" sentence (or narrow it to "tasks beyond 020").
- Untouched in this task: any Rust file. The orchestrator and the Tauri command that spawns workers are task 030.

## Deliverables

A bundled Node CommonJS file at `src-tauri/sidecars/renderer/dist/renderer.cjs` that, when run as `node renderer.cjs`:

1. **Boot.** Reads stdin line-by-line. On the first line — a JSON `{"cmd":"setup", ...}` payload — caches the payload, calls `mapVisuals.buildStyleSpec(map_settings)`. If the style is a URL (default/3d modes), fetches and JSON-parses it via the same network path used for tiles — `map.load()` only accepts a parsed style object, not a URL string. Then calls `mapVisuals.buildStaticSourceData({route, clips, mapSettings})`, instantiates a `Map` from `@maplibre/maplibre-gl-native` with `request` callback wired (see "Tile cache" below), calls `map.load(styleSpec)` (synchronous), seeds the static GeoJSON sources via `addSource`, adds layers via `addLayer` in canonical stacking order, indexes the route via `indexRoute(route)`, replies `{"ready":true}\n` on stdout. Setup is async because of the style fetch; the handshake fires once `addSource`/`addLayer` complete. The pre-cached setup payload also doubles as the recycle blueprint (no separate "remember this" command needed).

2. **Render loop.** For each subsequent line `{"cmd":"render","frame_index":N,"project_time_ms":T}`:
   - Compose per-frame state via `buildPerFrameState(timeline, T, activeClipId, indexedRoute, clips, mapSettings, viewport)`. (`activeClipId` derivation: pick from `timeline.clipSpans` containing `T`; this is what MapView's `activeClipIdRef` resolves to in the preview's render loop. Lift the same one-liner.)
   - Apply per-frame source updates: for each `(id, data)` in `state.sources`, rebuild the source via `removeLayer(layerId)` for each dependent layer (in reverse stacking order), `removeSource(id)`, `addSource(id, {type: 'geojson', data})`, then `addLayer(spec)` for each dependent layer (in forward stacking order). The native binding has no `getSource(id)` or `setData(...)` — this remove/re-add cycle is the documented mechanism for pushing fresh GeoJSON data. Sources `route-trail` and `live-marker` are always present; `waypoints` is included when `mapSettings.waypoints_mode === 'visited'`. Layer specs come from the canonical exports in `src/lib/mapVisuals/` — the worker only references them by reference, never by literal.
   - Apply per-frame paint updates: `setPaintProperty('waypoints-circle', 'circle-radius' | 'circle-color' | 'circle-stroke-color', ...)` and `setPaintProperty('live-marker-pulse', 'circle-radius' | 'circle-opacity', ...)` from `state.paints`.
   - Call `map.render({zoom, bearing, pitch, center, width, height}, callback)` — fields fed from `state.camera`, with `width`/`height` taken from the setup payload's `viewport`. (`buildStyleSpec`'s returned `defaultPitch` is applied at setup time as a fallback; `state.camera.pitch` overrides per-frame in the normal case.)
   - On callback `(err, buffer)`: write a 4-byte big-endian length prefix (`Buffer.alloc(4); writeUInt32BE(buffer.length)`) followed by the buffer to stdout, atomically. The next stdin line is processed only after the write resolves.

3. **Recycle.** On `{"cmd":"recycle"}`: tear down the current `Map` (release any handles, drop references for GC), construct a fresh `Map` from the cached setup payload, re-seed static sources, wait for `style.load`, reply `{"ready":true}\n`. The orchestrator inserts a `recycle` every K=60 render commands (configurable). Necessity: PLAN.md §"Renderer worker lifecycle" notes maplibre-native retains ~130 MB per frame with no internal eviction; a 60-frame chunk holds ~7.8 GB without recycling. Recycling reuses the warm tile cache so wall-clock cost is minimal.

4. **Shutdown.** On `{"cmd":"shutdown"}` or stdin EOF: release the `Map` instance, exit 0. The orchestrator detects worker exit via `child.on('exit')`.

5. **Diagnostics.** All non-protocol logging goes to stderr. Render errors crash the worker with a non-zero exit code; the orchestrator detects via process exit / broken pipe and surfaces a user-visible error.

The protocol is line-delimited JSON for stdin and a tagged byte stream on stdout (each ready reply is a single JSON line ending in `\n`; each frame is `[4-byte BE length][length bytes RGBA]`). Stdout is **not** a JSON stream — the orchestrator's reader knows whether it's expecting a ready line (after setup/recycle) or a frame (after render). This is simpler than wrapping every payload in JSON-with-base64 and was the design in PLAN.md §"IPC contract".

## Acceptance criteria

- [ ] `npm run build:renderer` produces `src-tauri/sidecars/renderer/dist/renderer.cjs`. The bundle resolves under plain Node (`node -e "require('./src-tauri/sidecars/renderer/dist/renderer.cjs')"` does not throw a module-resolution error; it may exit because no setup arrives, but require must succeed).
- [ ] `node src-tauri/sidecars/renderer/dist/renderer.cjs` exits 0 on stdin EOF without setup (no work to do, clean shutdown).
- [ ] Process-level test (`npm run test:renderer`) passes:
  - Spawn `node dist/renderer.cjs`, write a setup payload built from a small synthetic timeline (1 clip, 2-second duration) and a synthetic route (2–3 trackpoints), with `viewport: {w: 540, h: 960}`. Assert stdout's first line equals `{"ready":true}\n` (with `style.load` having fired).
  - Write `{"cmd":"render","frame_index":0,"project_time_ms":0}\n`. Read 4 bytes from stdout, decode as big-endian uint32 — assert it equals `540 * 960 * 4 = 2_073_600`. Read that many bytes — assert the buffer is W×H×4 bytes long and is not all zero (some non-bg pixel exists).
  - Write `{"cmd":"recycle"}\n`. Assert next stdout line is `{"ready":true}\n`. Write another render command; assert another valid frame comes back.
  - Write `{"cmd":"shutdown"}\n`. Assert process exits 0 within 5s.
- [ ] **Visual-parity import enforcement.** Grep at acceptance time:
  - `grep -rE "addLayer|setPaintProperty\\b.*('"'"'route|'"'"'waypoints|'"'"'live-marker)" src-tauri/sidecars/renderer/index.ts` returns no matches that aren't covered by a `state.paints.*` lookup. (i.e. layer-spec literals and paint-expression literals do not appear in the worker source — they all live in `src/lib/mapVisuals/`.)
  - `grep -E "from ['"'"'\"](\\.\\./)+src/lib/mapVisuals" src-tauri/sidecars/renderer/index.ts` returns at least one match. The worker imports from the shared module via relative path; esbuild resolves it at build time.
  - The bundled `dist/renderer.cjs` includes the `mapVisuals` module's compiled output (verifiable via `grep "buildPerFrameState" dist/renderer.cjs`).
- [ ] **Plain-Node bundle.** Grep `dist/renderer.cjs` for browser-only globals — `grep -wE "window|document|navigator|requestAnimationFrame" dist/renderer.cjs` returns nothing in code paths the worker actually executes. (esbuild's tree-shake removes the `MapView`-side imports of `mapVisuals` since the worker only pulls the pure functions; the assertion is on the worker's reachable code, not on incidental string matches in third-party deps. If a third-party dep adds noise, narrow the grep to `index.ts` source-mapped regions.)
- [ ] `npm run test:run` continues to pass (the renderer test is gated behind `npm run test:renderer` to keep the default suite fast and avoid requiring a built bundle).
- [ ] `npm run build` continues to pass (the worker's tsconfig is **not** referenced by the root tsconfig — root build does not type-check the worker. Worker type-checks via `npx tsc -p src-tauri/sidecars/renderer/tsconfig.json --noEmit`, run as part of `build:renderer`).

## Implementation notes

**Why CJS instead of ESM.** `@maplibre/maplibre-gl-native` is a CommonJS native addon — the prebuilt `.node` is loaded via `node-pre-gyp`'s CJS-style `require()`. Bundling the worker as ESM forces a `createRequire(import.meta.url)` dance plus top-level `await` if we want the import to look idiomatic, and ESM's strictness around `__dirname` (used by `node-pre-gyp` to find the `.node`) adds friction. CJS is the path of least resistance for a Node-only sidecar that has no reason to be ESM other than aesthetic. Pick CJS, document the rationale, move on.

**Why externalize maplibre-native in esbuild.** Bundling a native `.node` addon as inline JavaScript doesn't work — the binary is a platform-specific ELF/Mach-O/DLL that Node loads via `process.dlopen`. The bundler must leave `require('@maplibre/maplibre-gl-native')` as a runtime require, and the `node_modules/@maplibre/maplibre-gl-native/` directory must be on the runtime resolution path. esbuild config: `external: ['@maplibre/maplibre-gl-native']`. Task 130 (per-platform bundling) handles where the addon lives in the shipped app — for now it's resolved out of the project's `node_modules`.

**Why a separate tsconfig for the worker.** The root `tsconfig.json` references `tsconfig.app.json` (DOM lib, JSX, browser-targeted) and `tsconfig.node.json` (vite.config only). Neither fits a Node-binary that imports `src/lib/mapVisuals/` as plain TS. The worker needs `lib: ['ES2022']` (no DOM), `types: ['node']`, `module: CommonJS`, and crucially needs to be willing to compile the imports from `src/lib/mapVisuals/` and `src/lib/cameraIntent.ts` under that mode — esbuild does the actual compile, so the worker's tsconfig is a type-check-only configuration. Set `noEmit: true`, `include: ['index.ts', '../../../src/lib/mapVisuals/**/*.ts', '../../../src/lib/cameraIntent.ts', '../../../src/lib/routeLocation.ts', '../../../src/types.ts']`, exclude `**/__tests__/**`. The intent: `tsc --noEmit` proves the worker compiles in a Node context against the same shared sources the browser bundle consumes.

**`buildPerFrameState`'s viewport argument.** Pass `{width: viewport.w, height: viewport.h, dpr: 1}` from the setup payload. DPR is 1 in maplibre-native by default — output pixel buffer is exactly W×H, not W×H×DPR. (The orchestrator scales the slot rect to output coords later if needed. PLAN.md §"Performance considerations" #1 — render at slot size, not output size.)

**Tile cache deferral.** PLAN.md §"Renderer architecture" → "Determinism" mentions routing tile fetches through a shared on-disk cache. For task 020, wire the `request()` callback as a network-only stub (`https.get(url)` style, with a TODO comment) — enough to make first-frame rendering work in tests with internet access. The real on-disk cache (with hash-based filenames keyed by tile URL) is task 030's concern, or a follow-up task spun out of 030. Document the deferral in this file under "Open questions deferred to follow-up tasks" — not a v1 blocker for the worker shape.

**Setup payload as recycle blueprint.** The worker caches the parsed setup payload at boot. On `{"cmd":"recycle"}` it rebuilds the `Map` from the same payload — no second setup roundtrip from the orchestrator. This is what PLAN.md §"Renderer worker lifecycle" → "Recycle" describes. Implementation: keep `let setupPayload: SetupCmd | null = null` at module scope; recycle pulls from it.

**The setup → ready handshake.** maplibre-native has no `style.load` event — `Map` instances are not `EventEmitter`s. `map.load(styleSpec)` is synchronous and accepts only a parsed style object (not a URL string — that throws `ParseError: Failed to parse style: Invalid value at offset 0`). For URL-based styles (default/3d → OpenFreeMap liberty), the worker fetches the style JSON itself via the same network helper used for tiles, parses it, and passes the parsed object to `load()`. After `load()` returns, `addSource`/`addLayer` calls are immediately legal; tile fetches happen lazily during the first `render(...)`. Reply `{"ready":true}\n` once setup finishes adding sources and layers. The orchestrator must wait for this reply before sending render commands — otherwise the worker would drop or queue them, both of which add complexity; synchronous handshake is simpler.

**Frame ordering inside a worker is implicit.** A worker processes stdin line-by-line; render commands within one worker are sequential by construction. The orchestrator is the layer responsible for multi-worker frame ordering (task 030). A single worker writes frames to stdout in the order it received their render commands.

**Orientation.** PLAN.md §"Cross-platform strategy" notes: maplibre-native returns top-down per the manual feasibility test on this machine — no vflip needed. The worker writes the buffer as maplibre-native hands it back. Task 030 / 040 (FFmpeg side) re-confirms before locking the contract; if it turns out flip is needed on some platform, the fix is one byte-row swap and we add a per-platform note. **For now: no vflip.**

**Setup payload shape mirrors `MapView` props.** The wire payload is JSON, large arrays (timeline.clipSpans, route.trackpoints) round-trip fine — no protobuf or binary framing needed at this stage. Schema:

```ts
interface SetupCmd {
  cmd: 'setup';
  viewport: { w: number; h: number };  // map-slot dims (PLAN.md §"Performance considerations" #1)
  fps: number;                         // 30 or 60; not used by the worker per se, but echoed for diagnostics
  timeline: CompiledTimeline;
  route: Route | null;
  clips: Clip[];
  mapSettings: MapSettings;
}
interface RenderCmd { cmd: 'render'; frame_index: number; project_time_ms: number }
interface RecycleCmd { cmd: 'recycle' }
interface ShutdownCmd { cmd: 'shutdown' }
type Cmd = SetupCmd | RenderCmd | RecycleCmd | ShutdownCmd;
```

Worker discriminates on `cmd`. Unknown command → log to stderr, ignore. Malformed JSON → crash with non-zero exit (the orchestrator should never produce malformed JSON; this is a fail-fast contract violation, not a runtime fallback).

**Stdin line buffering.** Use Node's `readline.createInterface({input: process.stdin})` for line-delimited stdin. Each `'line'` event is one command. Avoid manual `Buffer` parsing — readline handles partial reads and CR/LF correctly across platforms. For stdout writes, use `process.stdout.write(...)` synchronously for ready replies (small) and `process.stdout.write(prefixBuffer); process.stdout.write(rgbaBuffer)` for frames (the contract is byte-stream-concatenation; Node serializes writes on a TTY or pipe in order).

**Empty `Feature<LineString>` rejection.** maplibre-native validates GeoJSON at `addSource` time and throws `A line string must have two or more coordinate points` for any `Feature<LineString>` with fewer than two coordinates. The browser `maplibre-gl-js` silently accepts the same payload. The shared `mapVisuals` module returns a degenerate empty `Feature<LineString>` (with `coordinates: []`) when there's no trail to draw — that's the contract preview consumes. The worker bridges this by translating degenerate LineStrings into empty `FeatureCollection`s at the `addSource` boundary (semantically identical: nothing to draw). Don't push this back into `mapVisuals` — preview's contract is browser-shape GeoJSON, and the adapter is a worker-local quirk.

**`setPaintProperty` typing gap.** `setPaintProperty` is missing from `@maplibre/maplibre-gl-native`'s published `index.d.ts` (as of v6.4.1) but exists at runtime. The worker uses it as documented and types `map` as `any` at the boundary to avoid casting at every call site. If a future version restores the typing, this can be tightened to a proper `Map` reference.

**Test scope.** The protocol test exercises the wire format end-to-end; it does NOT fixture the entire `mapVisuals` API surface. Use a minimal real route (2–3 trackpoints with timestamps a few seconds apart), a 1-clip timeline of ~2s, and a real `MapSettings` with `map_style: 'default'` and `waypoints_mode: 'all'`. The test verifies "the worker produces a non-empty frame and the protocol works"; visual correctness of map rendering is implicitly covered by visual-parity verification in task 120 — not by this task. Don't over-test.

**Why `test:renderer` is a separate script.** Process spawning, esbuild bundle being available, maplibre-native cold-loading and pulling a tile or two from the network — this test is structurally heavier than a unit test. Folding it into the default `test:run` would (a) require the bundle to be built before every default test run (slow), (b) require network access for the test machine (CI nuisance), and (c) hide a flaky "tile fetch timed out" failure inside the regular suite. Separate script, separate signal.

**`buildStyleSpec`'s `defaultPitch` return.** Apply at setup time before the first render — `map.render(...)` doesn't take a "default pitch from style" hint, so the worker explicitly threads it as the fallback when `state.camera.pitch` is undefined (which `buildPerFrameState` doesn't return — it always sets pitch — but defensive against a future where `cameraAt` returns partial overrides). In the normal path, `state.camera.pitch` overrides per-frame and `defaultPitch` is unused.

**No React, no DOM.** The worker MUST NOT import React, react-dom, maplibre-gl (the JS browser package — note the distinction from `@maplibre/maplibre-gl-native`), or anything depending on `window`/`document`. The shared `mapVisuals` module imports `maplibre-gl` only for **types** (`StyleSpecification`, `GeoJSONSourceSpecification`, `DataDrivenPropertyValueSpecification`); these are erased at runtime. esbuild strips the type-only imports during bundling. Verify with the grep acceptance criterion above.

## Open questions deferred to follow-up tasks

- **Shared on-disk tile cache.** The `request()` callback is a network-only stub in 020; full hash-based caching (so repeat exports skip network roundtrips) belongs in task 030 or a 035 spun out of it. PLAN.md §"Renderer architecture" → "Determinism".
- **Frame deduplication for static-camera spans.** When `cameraAt(t)` returns the same camera over a span (point intent + no marker follow), the orchestrator can render once and have FFmpeg duplicate. Orchestrator-side optimization, task 030. PLAN.md §"Performance considerations" #4.
- **Pre-warming tiles before frame loop.** Walking the full camera path once before render loop begins, fetching all needed tiles into the cache, then starting the loop. Orchestrator-side, task 030. PLAN.md §"Performance considerations" #2.
- **GPU/Metal acceleration.** maplibre-native supports Metal on macOS but the Node binding may default to CPU; potentially a 5–10× speedup on top of other optimizations. Not investigated in 020. PLAN.md §"Performance considerations" #3.
- **Per-platform `bundle.externalBin` plumbing.** Task 130 — bundling `node-<target-triple>`, `renderer-<target-triple>`, and the maplibre-native `.node` addon per platform. The 020 worker bundle is a project-local artifact; production packaging is a separate concern.
- **N>1 worker pool.** v1 ships N=1 per PLAN.md §"Parallelism strategy". Multi-worker orchestration is task 030.
- **Worker re-handshake on style change.** If `mapSettings.map_style` changes mid-export (it won't in v1), the worker would need a new setup. Out of scope; v1 settles `mapSettings` once at export start.

## Doc tie-in

- PLAN.md §"Renderer architecture" — process model, parallelism, determinism, frame ordering — this task implements the worker side of that architecture; the Rust orchestrator side is task 030.
- PLAN.md §"IPC contract" — the wire format specified there is what this task makes real. Any divergence between this task's protocol and the doc is a doc bug — keep them aligned.
- PLAN.md §"Cross-platform strategy" — the worker design is platform-agnostic by virtue of running on Node + a prebuilt addon with macOS/Windows/Linux binaries. Per-platform packaging is task 130.
- LAYOUT.md §5 (map render viewport) — informs the `viewport` field in the setup payload (slot dims, not output dims). Worker doesn't care about slot vs. output; it renders whatever W×H it's told.
- After 020 lands, the worker is callable from any spawning Rust code via stdin/stdout. Task 030 picks that up: spawn N, distribute frame_indices, drain in order, feed FFmpeg.
