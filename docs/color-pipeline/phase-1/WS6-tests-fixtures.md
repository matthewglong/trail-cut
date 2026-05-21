# WS6 — Tests, Fixtures, CI

**Phase:** 1
**Blocks:** none
**Blocked by:** none (can run in parallel with WS1/WS2/WS3)
**Estimated scope:** medium — test infrastructure, sample assets, golden assertions

## Goal

Make the color pipeline regression-resistant. Add reference fixtures, golden ffprobe assertions, and stub coverage for both encoder paths. This workstream runs in parallel with WS1–WS5 and lands the test harness those workstreams need.

## Context

Read first:
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — what's being tested.
- [`../background/investigation-findings.md`](../background/investigation-findings.md) — what regressions to watch for.

Current state: existing tests stub `libx265` only. No HDR/HLG/PQ fixtures. No golden ffprobe assertions on outputs.

## Files to modify / create

| Path | Change |
|---|---|
| `src-tauri/fixtures/color/` | **NEW DIR.** Reference fixtures. |
| `src-tauri/fixtures/color/sdr_bt709_iphone.mov` | Sample iPhone SDR clip (~3s, small). |
| `src-tauri/fixtures/color/hlg_bt2020_iphone.mov` | Sample iPhone HLG clip. |
| `src-tauri/fixtures/color/pq_bt2020.mp4` | Sample PQ HDR clip (generated synthetically OK). |
| `src-tauri/fixtures/color/dolby_vision.mov` | Synthetic DV sample. |
| `src-tauri/fixtures/color/no_color_metadata.mp4` | A file stripped of all color metadata (test the Unknown branch). |
| `src-tauri/fixtures/color/README.md` | How each fixture was made; provenance and licensing notes. |
| `src-tauri/src/export/tests/` (or wherever tests live) | Golden ffprobe assertions on outputs. |
| `src-tauri/src/export/encoder.rs` tests | Add `hevc_videotoolbox` stub alongside existing `libx265` stub. |

## Implementation

### 1. Fixtures

Each fixture should be:
- Short (1–3 seconds) to keep CI fast.
- Small (< 5 MB) to commit cleanly to git, OR stored via git-lfs if the repo supports it (check existing patterns).
- Real-world representative where possible (actual iPhone footage trimmed down). For PQ/DV, synthetic samples are fine — document how they were generated.

If recording your own fixtures is impractical, candidates from public sources:
- HLG iPhone samples from Apple's developer site
- BBC R&D test patterns for HLG
- ffmpeg's built-in test sources for synthetic generation

Add a `fixtures/color/README.md` that documents:
- Each file's provenance.
- Each file's expected `ffprobe` color characterization (what `classify()` should return).
- The license of each file (must be permissible for inclusion in the repo).

### 2. ffprobe golden assertions

Add a test helper:

```rust
fn assert_color_tags(path: &Path, expected: ExpectedColorTags) {
    let probed = ffprobe::probe(path).unwrap();
    assert_eq!(probed.color_primaries.as_deref(), expected.primaries);
    assert_eq!(probed.color_trc.as_deref(), expected.transfer);
    assert_eq!(probed.color_space.as_deref(), expected.matrix);
    assert_eq!(probed.color_range.as_deref(), expected.range);
    assert_eq!(probed.pix_fmt.as_deref(), expected.pix_fmt);
}
```

Use this against:
- Every WS1 proxy output (always BT.709 SDR limited yuv420p).
- Every WS2 thumbnail output (sRGB-tagged, ICC embedded).
- Every WS4 delivery output (per-target expected tags from [WS4](WS4-delivery-transforms.md)).

### 3. Single-`colr`-atom assertion

For mp4/mov outputs, parse the container and assert exactly one `colr` atom whose values match the stream VUI. Either:
- Shell out to `MP4Box -info` or `mp4dump` and parse output, or
- Use a Rust mp4 crate (e.g., `mp4parse`) to read the atom directly.

This is the assertion that catches QuickTime per-frame warnings.

### 4. Visual regression (golden frame comparison)

Add a test that:
1. Runs a Channel A (composite) PIP export of a fixture project.
2. Runs the same project as Split export.
3. Extracts a representative frame from each.
4. Compares pixel-wise — should match within a small tolerance.

This is the regression test for the PIP saturation bug.

Use FFmpeg to extract frames; use a simple SSD or MSE comparison. Tolerance: ~3% per channel is generous; tighter is better.

### 5. Encoder stub coverage

Existing tests likely have a `libx265` mock. Add a parallel `hevc_videotoolbox` mock so the test suite exercises both encoder paths. Pattern after the existing stub.

### 6. CI integration

If there's a CI config (GitHub Actions, etc.), ensure:
- Fixtures are checked out (or fetched via git-lfs if applicable).
- FFmpeg and ExifTool are installed in the CI environment.
- New tests run as part of the standard test job.

## Acceptance criteria

- [ ] All five fixtures exist in `src-tauri/fixtures/color/` with documented provenance.
- [ ] `classify()` test: each fixture is correctly classified by `SourceColorClass`.
- [ ] Proxy tests: every WS1 output passes `assert_color_tags` for BT.709 SDR.
- [ ] Thumbnail tests: every WS2 output has sRGB ICC profile (verify via ExifTool in test).
- [ ] Delivery tests: every WS4 output passes `assert_color_tags` for its target.
- [ ] Single `colr` atom assertion passes on every mp4/mov output.
- [ ] Visual regression: PIP vs Split frames match within tolerance.
- [ ] Both `libx265` and `hevc_videotoolbox` encoder paths covered by tests.
- [ ] CI runs new tests and passes.

## Out of scope

- Performance benchmarks (separate concern; can be added later).
- Live HDR display verification (requires actual HDR monitor; manual test only).

## References

- [`WS1-proxy-pipeline.md`](WS1-proxy-pipeline.md), [`WS2-thumbnail-pipeline.md`](WS2-thumbnail-pipeline.md), [`WS3-working-space-export.md`](WS3-working-space-export.md), [`WS4-delivery-transforms.md`](WS4-delivery-transforms.md) — what's being tested.
- [`../background/investigation-findings.md`](../background/investigation-findings.md) — bugs to regression-test.
