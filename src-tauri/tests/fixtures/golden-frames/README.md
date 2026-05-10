# Golden-frame fixture (task 117)

Deterministic regression guard for the chromium renderer's wobble fix. See
[`docs/export/tasks/117-golden-frame-parity.md`](../../../../docs/export/tasks/117-golden-frame-parity.md)
for the full design rationale.

## What this is

A 5-second, single-clip, 30 fps timeline rendered through the chromium
sidecar (`src-tauri/sidecars/renderer-chromium`). The camera linearly pans
from `(lng=11.5820, lat=48.1351)` to `(lng=11.5780, lat=48.1340)` at
zoom 16, bearing 0, pitch 0 — Munich Marienplatz on the OpenFreeMap
liberty style. Per-frame lng/lat deltas land in the sub-pixel "wobble
regime" at zoom 16, and the region is label-dense (the stress case the
2-rAF wait risks under-serving).

Files:

- `setup.json` — the `SetupCmd` payload the chromium worker consumes.
  150 stationary `point`-intent clip spans, one per frame, each with the
  linearly-interpolated camera. `transitionSpans` is empty so no Van Wijk
  arc / time-based curve participates: same `(timeline, t)` always
  produces the same camera values.
- `frame-0000.png`, `frame-0030.png`, `frame-0060.png`, `frame-0120.png`
  — RGBA8 PNG snapshots at frame indices 0, 30, 60, 120 (project times
  0 s, 1 s, 2 s, 4 s). 540 × 960. Encoded losslessly. Committed as
  binary blobs.
- `generate_setup.mjs` — one-off script that writes `setup.json`
  deterministically. Re-run it after deliberate changes to the camera
  path or fixture metadata; it produces byte-identical output for the
  same code.

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
TRAILCUT_CHROME_BIN=/path/to/chrome \
  cargo test --test golden_frame_parity --features integration_export -- --nocapture
```

Preconditions:

- `npm run build:renderer-chromium` — produces
  `src-tauri/sidecars/renderer-chromium/dist/{renderer.cjs,page-init.bundle.js}`.
- The headless-shell binary at the env-var path. Until task 118 bundles
  one, set the env var manually (the dev-mode default in the codebase
  comments points at `/tmp/trailcut-headless-shell/...`).
- Network on first run (populates the on-disk tile cache at
  `~/.cache/trailcut/tiles/`); subsequent runs work offline.

## Regenerating the fixture

When to regen: maplibre-gl bumps, deliberate visual changes to
`src/lib/mapVisuals/`, OpenFreeMap style changes, or a deliberate camera-
path change in `setup.json`. The parity test failing on its own is
**information** — investigate before regenerating. Regen-on-failure
defeats the entire test.

```sh
# 1. (If setup.json changed) regenerate it from generate_setup.mjs:
node src-tauri/tests/fixtures/golden-frames/generate_setup.mjs

# 2. Render fresh PNGs into the fixture dir:
TRAILCUT_CHROME_BIN=/path/to/chrome \
  cargo test --test golden_frame_regenerate --features integration_export \
  -- --ignored --nocapture

# 3. Visually inspect each PNG. Open them in Preview and verify:
#    - Map renders correctly (labels readable, no missing tiles).
#    - Route line is visible.
#    - Live marker is at the right position for that frame.
#    This is the manual gate. Once the bytes are committed, "correct" =
#    "matches these bytes," so the bytes had better actually be correct.

# 4. Commit the four PNGs (and setup.json if changed).

# 5. Confirm the parity test now passes:
TRAILCUT_CHROME_BIN=/path/to/chrome \
  cargo test --test golden_frame_parity --features integration_export
```

## Sanity check during fixture creation

To prove the test catches what it's supposed to:

1. Temporarily disable the painter monkey-patch in
   `src-tauri/sidecars/renderer-chromium/page/painterPatch.ts` (return
   from `applyPainterPatch` early).
2. `npm run build:renderer-chromium`.
3. Re-run the parity test — it should fail with a pixel-diff message.
4. Restore the patch and rebuild.

Performed manually during bootstrapping; not a CI assertion.
