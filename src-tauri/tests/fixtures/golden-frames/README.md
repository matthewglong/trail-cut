# Golden-frame fixture (task 117 + Phase 5 renderer strangle)

Deterministic pixel-level regression guard for the export map renderer. See
[`docs/export/tasks/117-golden-frame-parity.md`](../../../../docs/export/tasks/117-golden-frame-parity.md)
for the original design rationale (chromium era); `docs/CANON.md` §2.5 for
the native backend this now guards.

## What this is

A 5-second, single-clip, 30 fps timeline rendered through the renderer
worker (`src-tauri/sidecars/renderer`). The camera linearly pans
from `(lng=11.5820, lat=48.1351)` to `(lng=11.5780, lat=48.1340)` at
zoom 16, bearing 0, pitch 0 — Munich Marienplatz on the OpenFreeMap
liberty style. Per-frame lng/lat deltas land in the sub-pixel "wobble
regime" at zoom 16, and the region is label-dense (the stress case for
anti-snap regressions). The default map decorations render too (route
line + live marker), so the pin covers the decoration layers, not just
the basemap.

Files:

- `setup.json` — the `SetupCmd` payload the worker consumes. 150
  stationary `point`-intent clip spans, one per frame, each with the
  linearly-interpolated camera. `transitionSpans` is empty so no Van Wijk
  arc / time-based curve participates: same `(timeline, t)` always
  produces the same camera values. Everything except the hand-authored
  timeline is built by the shared fixture builder
  (`sidecars/renderer/__tests__/setupFixture.ts` via
  `dist/setup_fixture.cjs`), so the wire shape tracks the live
  `SetupCmd`/`MapSettings`/`Clip` types instead of rotting silently.
- `native-frame-XXXX.png` — RGBA8 golden snapshots at frame indices 0,
  30, 60, 120 (project times 0 s, 1 s, 2 s, 4 s), 540 × 960, losslessly
  encoded. Compared with a measured ±1-LSB tolerance (mbgl/Metal has a
  small GPU AA wobble across identical runs: observed 0–10 px of 518,400
  per frame, always channel delta 1; the pin allows delta ≤ 1 on ≤ 0.01%
  of pixels and nothing more).
- `generate_setup.mjs` — writes `setup.json` deterministically.
  Re-run it after deliberate changes to the camera path or fixture
  metadata; it produces byte-identical output for the same code.
  Requires `npm run build:renderer` first (it loads
  `dist/setup_fixture.cjs`).

History: until the Phase 5 cutover this fixture also carried the chrome
backend's golden set (`frame-XXXX.png`, byte-identical comparison — GL JS
rendered byte-deterministically). Removed with the chrome backend; git
history has both if an engine comparison is ever needed.

## macOS only (v1)

Cross-platform pixel determinism is deferred to the Windows distribution
work (task 130 slot). The committed PNGs are the macOS dev/CI target;
Windows fixtures will land alongside Windows export support and will live
in a sibling per-platform directory.

The parity test (`src-tauri/tests/golden_frame_parity.rs`) and the regen
test (`src-tauri/tests/golden_frame_regenerate.rs`) both gate on
`#[cfg(target_os = "macos")]` and skip cleanly on other platforms.

## Running the parity test

```sh
cargo test --test golden_frame_parity --features integration_export -- --nocapture
```

Preconditions (loud panic, never skip):

- `npm run build:renderer` — produces
  `sidecars/renderer/dist/renderer.cjs` and stages the patched
  maplibre-gl-native binding at `src-tauri/binaries/mbgl-native-<triple>/`.
- Network on first run (populates the on-disk tile cache at
  `~/.cache/trailcut/tiles/`); subsequent runs work offline.

## Regenerating the fixture

When to regen: maplibre-gl-native binding bumps, deliberate visual
changes to `src/lib/mapVisuals/`, OpenFreeMap style changes, or a
deliberate camera-path change in `setup.json`. The parity test failing on
its own is **information** — investigate before regenerating.
Regen-on-failure defeats the entire test.

```sh
# 1. (If setup.json changed) regenerate it from generate_setup.mjs:
node src-tauri/tests/fixtures/golden-frames/generate_setup.mjs

# 2. Render fresh PNGs into the fixture dir:
cargo test --test golden_frame_regenerate --features integration_export \
  -- --ignored --nocapture

# 3. Visually inspect each PNG. Open them in Preview and verify:
#    - Map renders correctly (labels readable, no missing tiles).
#    - Route line is visible.
#    - Live marker is at the right position for that frame.
#    This is the manual gate. Once the bytes are committed, "correct" =
#    "matches these bytes," so the bytes had better actually be correct.

# 4. Commit the PNGs (and setup.json if changed).

# 5. Confirm the parity test now passes:
cargo test --test golden_frame_parity --features integration_export
```

## Sanity check during fixture creation

To prove the test catches what it's supposed to: temporarily skip the
`setGestureInProgress(true)` call in
`src-tauri/sidecars/renderer/nativeBackend.ts`, `npm run build:renderer`,
re-run the parity test — it should fail with a pixel-diff message (on
satellite/raster content the failure is dramatic; on the vector fixture
the tile-alignment path still shifts bytes).
