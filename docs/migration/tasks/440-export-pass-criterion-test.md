# Task 440 — Pass criterion test: render 30-frame sequence for a real project

**Step**: 4 (Export harness)
**Estimated effort**: 2h
**Status**: pending
**Depends on**: 430

## Goal

Run the explicit Step 4 pass criterion from §6.4 of the migration doc and produce a one-page report. "**Pass criterion**: render a 30-frame sequence (1s at 30fps) for a real project. Every frame is non-blank, every frame's PNG matches the `cameraAt` resolved camera within ~1 zoom-step (allow tile downsampling fallback). Two independent runs of the same render produce byte-identical (or near-identical, modulo tile freshness) PNGs."

## Files to touch

- `src/dev/ExportPassCriterion.tsx` — new — a dev-only screen (or a test button on the existing app) that runs the 30-frame render twice and produces a comparison report.
- `docs/migration/STEP4_PASS_CRITERION_REPORT.md` — new — markdown report capturing: input project name, frames rendered, PNG hashes for run 1 and run 2, byte-identical % or pixel-diff %, §8.1 polling decision, blank-frame count.

## Deliverables

- A reproducible procedure to render a 30-frame batch for a chosen project.
- The output dir contains 30 PNGs after the run.
- A second run against the same project produces 30 more PNGs in a separate output dir.
- Pairwise pixel-diff between the two runs, per frame, recorded in the report.
- Blank-frame check: every PNG's mean pixel value > some threshold (e.g., 16/255). Zero blanks expected.
- §8.1 polling decision (used or not) recorded in the report.
- Final verdict: PASS / FAIL against the migration doc's criteria.

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] Two consecutive 30-frame render runs complete successfully.
- [ ] All 60 PNGs (30 per run) open without corruption.
- [ ] Every PNG mean pixel value > 16/255 (no blank frames).
- [ ] Pairwise diff between matched frames in run 1 vs run 2 is < 5% pixel-diff (allowing for tile freshness).
- [ ] Report exists at `docs/migration/STEP4_PASS_CRITERION_REPORT.md` with the verdict.

## Implementation notes

The dev-only test runner can be a single button in a dev panel or a script. Recommended approach: add a `<button onClick={runPassCriterion}>` to the `CameraSpikeHarness` (or its successor) that:

1. Picks the currently-loaded project.
2. Builds 30 FrameSpecs for `t = startMs + (i * 1000/30)` for i in [0..29].
3. Calls `invoke('render_map_frames', { frames, fps: 30, output_dir: '/tmp/trailcut_pass1' })`.
4. Calls again with `output_dir: '/tmp/trailcut_pass2'`.
5. Computes per-frame pixel-diff via canvas `getImageData` or via a Rust helper command (`compare_pngs(a_path, b_path) -> { diff_pct: f32 }`) — Rust helper is cleaner.
6. Writes the report with the result.

A small Rust helper for PNG diff:

```rust
#[tauri::command]
pub fn compare_pngs(a: PathBuf, b: PathBuf) -> Result<f32, String> {
    // load both PNGs via the `image` crate, compute mean abs diff over pixels
}
```

Pass criterion paraphrased from §6.4:

- ≥30 PNGs produced per run
- Every PNG non-blank
- Every PNG matches the `cameraAt` resolved camera within ~1 zoom-step (this is implicitly satisfied by the render loop using `map.jumpTo` of the resolved camera; the criterion is really "zoom mismatches mean tiles fell back to downsampled placeholders" — captured by §8.1's polling decision)
- Two runs near-identical (modulo tile freshness)

The report is the deliverable that signals Step 4 is done. Step 5 (layout/compositing) is out of scope per the original instructions.

If any criterion fails, capture the failure mode in the report and decide whether to file a follow-up task or fix in this task. Do not silently fail.
