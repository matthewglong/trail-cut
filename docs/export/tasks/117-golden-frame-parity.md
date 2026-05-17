# Task 117 — Golden-frame parity test (wobble-fix regression guard)

**Step**: Export pipeline (renderer migration step 3 of 5 — see [`../plans/chromium-renderer.md`](../plans/chromium-renderer.md))
**Estimated effort**: ~1.5 days (8–12h)
**Status**: pending
**Depends on**: 115 (chromium sidecar), 116 (env-flag toggle so the test renders via the new sidecar).

## Goal

Lock in the visual output of the new chromium renderer with committed golden-frame PNGs and a Rust integration test that re-renders the same frames and diffs them pixel-for-pixel. This is the **only** test in the migration that ties the wobble-fix claim to CI: if the painter patch ever regresses (or maplibre-gl-js's behavior drifts on a version bump), this test blows up.

**Why golden frames over a synthetic property test:** the wobble is a sub-pixel rounding artifact that only manifests during slow camera deltas. There's no clean property test for "no wobble" — you'd have to define wobble structurally, which means encoding the bug we're trying to avoid. A pixel-diff against committed truth is blunt but complete: if the patch silently no-ops, the diff explodes.

**Load-bearing invariant — the fixture camera path is *deterministic and label-dense*.** Determinism: same `(timeline, t)` produces same RGBA bytes every time, no clock-driven fades, no random tile-load races. Label-dense: the camera is positioned over an OpenFreeMap region with high symbol-collision density, so plan §7 R3 (two rAFs may not be enough for label collisions) is exercised. If R3 manifests, the diff exposes it.

**macOS only for v1.** Cross-platform pixel determinism (plan §7 R6) is deferred to whenever Windows distribution lands (task 130's slot). The fixture is committed for the macOS dev/CI target only; Windows fixtures are added when Windows export ships.

## Files to touch

- New: `src-tauri/tests/fixtures/golden-frames/setup.json` — the `SetupCmd` payload used to drive the fixture. A 5-second single-clip timeline at 30 fps over a slow-pan camera path. Specifics:
  - **Camera path:** linear interpolation from `(lng=11.5820, lat=48.1351)` to `(lng=11.5780, lat=48.1340)` over 5 s, zoom held at 16.0, bearing 0, pitch 0. (Munich Marienplatz — OpenFreeMap liberty has dense labels here, and the longitude/latitude deltas produce ~0.2 px/frame at zoom 16, which is exactly the wobble regime.) The exact lat/lng values are committed to the fixture; the test does not regenerate the camera path each run.
  - **Map settings:** `{ map_style: 'default', waypoints_mode: 'full', route_mode: 'full' }` — exercises route-full layer + waypoints, the two layers most sensitive to label-collision timing.
  - **Route:** synthetic 3-trackpoint LineString matching the camera path.
  - **Clips:** one 5-second clip with default focal point and trim. Path is `/dev/null/...` (the fixture renders the *map*, not the video; `render_export_map_only.rs`-style invocation).
  - **Viewport:** 540 × 960 (the existing native test viewport — keeps fixture file size manageable; a 1080×1920 fixture is 8 MB per PNG, vs ~2 MB at 540×960).
  - **fps:** 30. Frame indices 0, 30, 60, 120 = times 0 s, 1 s, 2 s, 4 s.

  This file is generated once at fixture-creation time by the chromium renderer itself (see "Bootstrapping the fixture" below), then committed.

- New: `src-tauri/tests/fixtures/golden-frames/frame-0000.png`
- New: `src-tauri/tests/fixtures/golden-frames/frame-0030.png`
- New: `src-tauri/tests/fixtures/golden-frames/frame-0060.png`
- New: `src-tauri/tests/fixtures/golden-frames/frame-0120.png`
  - Each PNG is the chromium renderer's RGBA output for the corresponding `(setup.json, frame_index)`, encoded losslessly to PNG. Committed as binary blobs. ~2 MB each at 540×960. Total fixture growth: ~8 MB.

- New: `src-tauri/tests/fixtures/golden-frames/README.md` — explains:
  - What the fixture is: deterministic 5-frame snapshot of the chromium renderer's output for a slow-pan camera path with dense labels.
  - How to regenerate it: `TRAILCUT_RENDERER=chromium cargo test --test golden_frame_regenerate --features integration_export -- --nocapture` (a separate, ignored-by-default test that writes new PNGs on demand — see below).
  - When to regenerate it: maplibre-gl bumps, deliberate visual changes to `mapVisuals/`, OpenFreeMap style changes. Regeneration is a deliberate action; the test failing is *information*, not noise.

- New: `src-tauri/tests/golden_frame_parity.rs` — Rust integration test, gated on `--features integration_export`. Pseudocode:
  ```rust
  #[cfg(feature = "integration_export")]
  #[tokio::test]
  async fn golden_frame_parity_chromium() {
      // 1. Force chromium renderer.
      std::env::set_var("TRAILCUT_RENDERER", "chromium");
      // 2. Load setup.json from the fixture dir.
      let setup: SetupPayload = ...;
      // 3. Run render_map_frames over frames [0, 121) with a sink that captures
      //    frames 0, 30, 60, 120 specifically (others discarded).
      // 4. For each captured frame: PNG-encode the RGBA, byte-compare against
      //    the committed PNG. (Or: decode the committed PNG, byte-compare RGBA
      //    directly — avoids PNG-encoder nondeterminism, slightly faster.)
      // 5. On mismatch: write the rendered PNG to a temp dir, write a diff PNG
      //    using a tolerance-aware diffing crate (e.g. `image-compare`), fail
      //    the test with a path-to-temp-files message.
  }
  ```
  Tolerance: byte-identical for the first version (we're snapshotting the chromium renderer's output, against itself, deterministically — no excuse for drift). If maintenance proves byte-identity too brittle (e.g. anti-aliasing on label rasterization shifts by 1 LSB in a corner), graduate to a structural-similarity threshold (`image-compare` with SSIM ≥ 0.999), but **start strict**.

- New: `src-tauri/tests/golden_frame_regenerate.rs` — separate, `#[ignore]`-by-default test (or `#[cfg(feature = "regenerate_golden")]` gated) that runs the same render but writes the output PNGs back to the fixture dir. Documented as the regen mechanism in the fixture README. Never runs in CI; only manual invocation.

- Modified: `Cargo.toml` (root or `src-tauri/Cargo.toml` — wherever the existing `integration_export` feature is declared): add `image` crate (or whatever PNG decoder is already in the dep tree — check first) for PNG ↔ RGBA conversion. Use `png` crate if it's already pulled in transitively; otherwise add `image = { version = "0.25", default-features = false, features = ["png"] }`.

- Modified: `docs/export/tasks/README.md` — add row for 117 ⬜.

- Untouched: every existing renderer/orchestrator file, every other test. The new test file is purely additive.

## Bootstrapping the fixture (one-time)

Ordering matters: the test needs PNGs to compare against, and those PNGs are produced by the chromium renderer. Bootstrap procedure (executed once by the task author, results committed):

1. Write `setup.json` by hand (or via a small one-off generator script).
2. Run the regen test: `TRAILCUT_RENDERER=chromium cargo test --test golden_frame_regenerate --features integration_export -- --ignored`. This writes `frame-NNNN.png` files into the fixture dir.
3. **Visually inspect each PNG.** Open them. Verify the map renders correctly (labels readable, no missing tiles, no obvious wobble), the route line is visible, the live marker is at the correct position. This is the manual gate — once the PNGs are committed, "correct" means "matches these bytes," so the bytes had better actually be correct.
4. Commit the PNGs.
5. Run `cargo test --test golden_frame_parity --features integration_export` and confirm green.
6. Deliberately revert the painter patch in `bootstrap.html.ts`. Re-run the test. Confirm it fails. (Sanity: the test actually catches what it's supposed to catch.)
7. Restore the patch.

## Acceptance

- The four PNG fixtures exist, are committed to git (binary), are visually correct, and total under 10 MB.
- `cargo test --test golden_frame_parity --features integration_export` passes.
- The regen test (`golden_frame_regenerate`) is gated and does not run in default CI.
- Reverting the painter patch causes the parity test to fail with a clear pixel-diff message. (Verified manually during bootstrapping; not a CI assertion.)
- The fixture README explains regen and visual-inspection procedure.
- macOS-only is documented in the fixture README. Windows fixtures will be added in the Windows distribution task (task 130) using the same setup.json + a per-platform PNG dir.
