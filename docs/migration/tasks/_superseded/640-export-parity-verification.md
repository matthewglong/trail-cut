# Task 640 — Render parity verification: rendered frames vs. `cameraAt(timeline, t)` truth

**Step**: Compiled Timeline export (Step 5 of the 600-series)
**Estimated effort**: 3h
**Status**: pending
**Depends on**: 630

## Goal

Prove the export pipeline (tasks 600–630) honors the determinism contract from `COMPILED_TIMELINE_PLAN.md` §"Export Semantics": "export at any project-time `t` matches preview at the same `t`." Render a 30-frame sequence from a real test project and verify, frame-by-frame, that the captured PNG's resolved camera state matches `resolveIntent(cameraAt(timeline, t), viewport)` exactly (modulo tile freshness).

This is the gating sign-off for the 600-series. If it passes, preview and export are locked to the same `cameraAt(timeline, t)` and the camera migration is complete end-to-end. If it fails, the failure mode points at exactly which layer drifted — math (frontend), wire (IPC payload), or render (renderer's `jumpTo`).

This is the export-side mirror of task 590's preview-side validation.

## Files to touch

- `src/lib/exportFramePlan.test.ts` — new — unit tests asserting `planExportFrames(timeline, fps, viewport)` produces frame `i`'s camera equals `resolveIntent(cameraAt(timeline, i * 1000 / fps), viewport)` for every `i`. (Pure-function check, no IPC.)
- `docs/migration/COMPILED_TIMELINE_EXPORT_VERIFICATION_REPORT.md` — new — the gating report. Documents the test project, the rendered sequence, the parity check method, and PASS/FAIL per frame.
- `scripts/verify_export_parity.ts` (or a Rust integration test under `src-tauri/tests/`) — new — the harness: invoke `render_map_frames` for a 30-frame test, then for each frame compare:
  - the FrameSpec's `camera` (which the parent computed from `cameraAt(timeline, t)`)
  - the rendered PNG's actual map state, recovered by re-loading the renderer with the same viewport + style + route, calling `jumpTo` with the FrameSpec camera, and screenshot-diffing against the rendered PNG.
  Verify diff is below a small pixel tolerance (e.g. <0.1% pixels differ by >2/255 per channel).

## Deliverables

- `planExportFrames` unit tests (the determinism contract at the math layer):
  - `frames[i].camera === resolveIntent(cameraAt(timeline, frames[i].project_time_ms), viewport)` for every i. Deeply equal.
  - `planExportFrames(timeline, fps, viewport)` is pure (two calls, deeply-equal outputs).
  - For a test timeline with 3 clips and 1 transition span, sample 5 random `t` values and confirm `cameraAt(timeline, t)` continuity at each adjacent span boundary (mirror of task 590's continuity invariant spot checks, but at the export-frame-plan level).
- End-to-end render-parity harness:
  - Renders 30 frames at 30fps from a chosen test project (≥3 clips, valid GPX, ≥1 entry transition).
  - For each rendered frame, recovers the actual map state and compares to the expected `ResolvedCamera`. Pass criterion: per-frame pixel diff <0.1% pixels above the per-channel tolerance threshold.
  - Pass criterion (math-level): for every frame, `frame.camera === resolveIntent(cameraAt(timeline, frame.project_time_ms), viewport)` exactly. No floating-point tolerance — this is pure-function output, must be bit-equal.
- Report file at `docs/migration/COMPILED_TIMELINE_EXPORT_VERIFICATION_REPORT.md` capturing:
  - Test project name, clip count, total duration, viewport, fps, frame count.
  - Per-frame PASS/FAIL summary (table or histogram if 30 rows is too verbose).
  - Any deviations: which frame, what channel/region, what RMS pixel error.
  - Final verdict: PASS, OR every FAIL has a follow-up task filed to address the drift.

## Acceptance criteria

- [ ] `npm run test:run` passes the new `planExportFrames` test suite.
- [ ] `cargo build --manifest-path src-tauri/Cargo.toml` passes.
- [ ] The end-to-end harness completes for the chosen test project and emits a parity report.
- [ ] **Math-level parity**: every frame's `camera` field bit-equals `resolveIntent(cameraAt(timeline, frame.project_time_ms), viewport)`. This is the contract `cameraAt(timeline, t)` carries: pure function of `(timeline, t)`, same inputs → same output. Failures here indicate a regression in the evaluator or the `planExportFrames` plumbing.
- [ ] **Render-level parity**: every frame's rendered PNG matches a re-rendered reference (same camera, same MapLibre instance) within the pixel-diff tolerance. Failures here indicate a renderer-side issue — likely tile-load determinism (revisit `waitForMapIdle` from task 630), DPR mismatch between viewport and canvas, or a stray `easeTo`/`flyTo` somewhere in the renderer.
- [ ] Report `docs/migration/COMPILED_TIMELINE_EXPORT_VERIFICATION_REPORT.md` exists with PASS verdict OR every FAIL has a linked follow-up task.
- [ ] **Determinism re-run**: running the harness twice on the same test project produces deeply-equal `FrameSpec[]` and pixel-identical (or within tolerance) PNG sequences. The export pipeline is reproducible.
- [ ] Report explicitly cites `COMPILED_TIMELINE_PLAN.md` §"Export Semantics" — "export at any project-time `t` matches preview at the same `t`" — as the contract being verified, and `cameraAt(timeline, t)` as the source of truth.

## Implementation notes

The math-level test is cheap and catches the most likely failure mode: `planExportFrames` drifting from `cameraAt`. Run it on every commit; it's a tight unit test.

The render-level test is expensive (~1 minute per 30-frame run) and is the exact thing task 590 marked as deferred (per task 590: "Export at any project-time `t` matches preview at the same `t`. *Deferred to task 640 once export tasks ship*"). Treat it as a gating manual-or-CI check, not a per-commit suite.

Pixel-diff tolerance: tile rendering has tiny non-determinism from raster-tile fetch timing, font subpixel positioning, and GPU driver float ops. Empirically, two renders of the same camera against the same style differ in <0.05% of pixels by ≤1/255. Set the threshold at 0.1% / 2-of-255 to leave margin without hiding real drift. If a frame fails the threshold, the failure is structural (camera math drift, not noise) — investigate, don't widen the threshold.

Test project guidance:
- ≥3 clips: exercises both clip-1's `startCamera → clip 1` transition and inter-clip transitions.
- valid GPX: exercises follow-intent `playheadMs` resolution.
- ≥1 clip with `entry_transition.duration_ms` set explicitly: exercises authored-duration path.
- ≥1 clip with `entry_transition.entry_bias != 0`: exercises non-centered transitions.
- ≥1 clip with `effects.speed != 1`: exercises the project-time → clip-local → wall-clock translation in the evaluator.

Do NOT pick the same test project as task 590 — independent verification is more valuable than reusing the fixture. Document the chosen project in the report.

If render-level parity fails on the first run because of tile flakiness, do NOT immediately rerun and call it good — that hides the bug. Instead: capture the failing frame's rendered PNG and the reference PNG, diff, and identify the exact pixel region that differs. If the region is a tile boundary, the fix is in `waitForMapIdle` (task 630). If the region is geometry (route line, marker), the fix is in the renderer's source/layer setup (task 610) or a bearing/zoom drift (math). Each failure category points at a different file.

Once this task PASSes, the camera migration is complete end-to-end. The 600-series is done; layout / compositing work (out of scope per `COMPILED_TIMELINE_PLAN.md` §"Migration-from-current-state Notes") can begin.

Open question to surface in the report if it bites:
- Clip 1's `t ∈ [0, transitionSpan.endMs]` window has no playing video. Frames in this window render the map only — the layout/compositing phase will eventually need a content-layer policy (held first frame of clip 1, `startCamera`-only background, etc.). This is NOT a parity-verification failure; the map render at these frames still matches `cameraAt(timeline, t)` exactly. Flag it in the report so the compositing phase has a record.
