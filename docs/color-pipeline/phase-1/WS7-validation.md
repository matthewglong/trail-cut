# WS7 — Validation

**Phase:** 1
**Blocks:** none (final workstream)
**Blocked by:** WS1, WS2, WS3, WS4, WS5, WS6
**Estimated scope:** small — manual + automated smoke tests, no code changes

## Goal

Confirm the three user-reported symptoms are gone. This is the gate before declaring Phase 1 done.

## Context

Read first:
- [`../background/investigation-findings.md`](../background/investigation-findings.md) — the three original symptoms and their root causes.

This workstream is mostly verification, not implementation. It runs the full pipeline against real footage and confirms outputs are correct.

## Procedure

### 1. Set up test projects

Create two real projects:

- **Project A**: an iPhone HLG hike (real footage if available, or use the WS6 HLG fixture extended to ~30s).
- **Project B**: an iPhone SDR hike.

Each project should have:
- 3–4 clips.
- A GPX route.
- Both PIP and Split composite modes exercised.

### 2. Smoke test all five delivery targets

For each project, export all five delivery targets:
- `social_sdr_vertical`
- `social_sdr_square`
- `youtube_sdr_4k`
- `youtube_hdr_4k`
- `prores_master`

Verify each export completes without errors.

### 3. Symptom 1 — Washout

For each export and the corresponding proxy + thumbnail:
- Open the file in QuickTime / VLC / Finder Quick Look.
- Compare visually against the original source.
- **Pass criterion**: no washed-out appearance. Colors look saturated and natural.

Spot-check a frame: load it in an image editor and check the histogram. Highlights should not be crushed; midtones should sit in a reasonable range.

### 4. Symptom 2 — PIP saturation

For Project A and Project B:
- Export the same project as PIP composite and as Split composite (both `social_sdr_vertical`).
- Open both in QuickTime side-by-side.
- **Pass criterion**: the map and video colors look identical between PIP and Split exports. No visible saturation shift.

Optionally extract matching frames and pixel-compare (the WS6 visual regression test should catch this automatically; this is the manual verification).

### 5. Symptom 3 — QuickTime per-frame warnings

For every export from step 2:
- Open in QuickTime.
- Open the Movie Inspector (Window → Show Movie Inspector).
- Scrub through the timeline.
- **Pass criterion**: zero color warnings. No yellow triangles, no "this clip has color metadata issues" messages.

Also run BBC's `qtff-parameter-editor` on each mp4/mov:
```
qtff-parameter-editor <file>
```
- **Pass criterion**: `colr` atom is present, has expected values, matches the stream VUI.

### 6. Additional checks

- Upload one `youtube_hdr_4k` export to YouTube as an unlisted test video. After processing, verify YouTube recognizes it as HDR (the player shows "HDR" badge).
- Upload one `social_sdr_vertical` to TikTok (or just verify it plays correctly on a mobile device).
- Open `prores_master` in DaVinci Resolve (or another editor) and confirm color tags are recognized.

### 7. Report

Write a validation report at `docs/color-pipeline/VALIDATION-REPORT.md` containing:
- Date of validation.
- Git commit hash being validated.
- Per-symptom pass/fail with notes.
- Per-target pass/fail with notes.
- Screenshots of QuickTime Movie Inspector for each export (showing zero warnings).
- Any issues discovered (file as follow-up tasks if any).

## Acceptance criteria

- [ ] All five delivery targets export successfully for both Project A and Project B.
- [ ] No washed-out appearance on any export, proxy, or thumbnail.
- [ ] PIP composite and Split composite of the same project look color-identical.
- [ ] Zero QuickTime per-frame color warnings on any export.
- [ ] BBC `qtff-parameter-editor` confirms valid `colr` atoms on all mp4/mov outputs.
- [ ] YouTube recognizes `youtube_hdr_4k` export as HDR (optional but recommended).
- [ ] `VALIDATION-REPORT.md` is written and committed.

## If validation fails

If any symptom is still present:
- Do NOT mark Phase 1 complete.
- File the failure as a specific bug with: what was tested, what was observed vs expected, ffprobe output of the failing file, suspected workstream that needs revisiting.
- Surface to the user before proceeding to Phase 2.

## Out of scope

- Performance testing (export speed benchmarks).
- Stress testing (large projects, long clips).
- Cross-platform validation (TrailCut is macOS-only per CLAUDE.md).

## References

- [`../background/investigation-findings.md`](../background/investigation-findings.md) — the three symptoms.
- [BBC qtff-parameter-editor](https://github.com/bbc/qtff-parameter-editor).
- [YouTube HDR upload guide](https://support.google.com/youtube/answer/7126552).
