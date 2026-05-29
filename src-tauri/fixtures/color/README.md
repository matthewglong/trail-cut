# Color pipeline fixtures (WS6)

Reference clips that exercise the `SourceColorClass` classifier and every
downstream ingest formula. Each fixture is 320×240, 30 fps, 2 seconds so the
repo and CI stay fast. (Duration is 2 s rather than 1 s so the WS2
thumbnail path's fixed `1.0` second input-seek lands on a valid frame
instead of past EOF.) All fixtures are synthesised from FFmpeg's `testsrc`
lavfi source — no third-party footage, no licensing burden.

The classification contract these fixtures lock in lives in
`src-tauri/src/util/color.rs::classify`; per-fixture expected color tags are
the authoritative inputs the WS1 (proxy), WS2 (thumbnail), WS3 (working-space
export), and WS4 (delivery) workstreams branch on.

## Fixtures

| File | Source class | `pix_fmt` | `color_primaries` | `color_trc` | `color_space` | `color_range` | Notes |
|---|---|---|---|---|---|---|---|
| `sdr_bt709_iphone.mov` | `SdrBt709` | `yuv420p` | `bt709` | `bt709` | `bt709` | `tv` | Standard iPhone SDR signature. |
| `hlg_bt2020_iphone.mov` | `HlgBt2020` | `yuv420p10le` | `bt2020` | `arib-std-b67` | `bt2020nc` | `tv` | iPhone HLG signature. 10-bit. |
| `pq_bt2020.mp4` | `PqBt2020` | `yuv420p10le` | `bt2020` | `smpte2084` | `bt2020nc` | `tv` | Synthetic PQ HDR. 10-bit. |
| `dolby_vision.mov` | `DolbyVision` | `yuv420p10le` | `bt2020` | `arib-std-b67` | `bt2020nc` | `tv` | **Placeholder** — see "Dolby Vision limitation" below. |
| `no_color_metadata.mp4` | `Unknown` | `yuv420p` | `unknown` | `unknown` | `unknown` | `unknown` | All four color tags stripped. |

The "Source class" column is what `classify(ColorMetadata)` MUST return for
each fixture's probed tags. The four ffprobe columns are the inputs the
classifier sees.

## Provenance and licence

All five files are generated locally from FFmpeg's `testsrc` source via the
recipes documented below (`generate.sh`). FFmpeg's `testsrc` is part of
FFmpeg itself (LGPL/GPL); the resulting bytes are pure synthetic content with
no third-party copyright and may be redistributed freely as part of this
repo.

The same regen recipe produces byte-identical output for the same FFmpeg
version — see `generate.sh` for the exact argv. The fixtures committed here
were produced with FFmpeg 8.1 (Homebrew, macOS 14, arm64).

## How to regenerate

Run `bash generate.sh` from this directory. The script overwrites each
fixture in place; commit any diff intentionally after verifying the per-file
ffprobe tags still match this table.

When to regen:
- FFmpeg major version bump that changes the rawvideo / libx264 / libx265
  byte stream.
- Deliberate change to fixture size, frame rate, or duration.
- New fixture added (extend `generate.sh` and update this table).

## Dolby Vision limitation

True Dolby Vision sample generation requires either a real DV RPU sidecar
processed with `dovi_tool` / `MP4Box`, or an x265 build with DV enabled and
a VBV-constrained encoder configuration. Neither is universally available in
a stock `brew install ffmpeg`. The committed `dolby_vision.mov` is the same
HLG/BT.2020 base-layer payload as `hlg_bt2020_iphone.mov`; it does **not**
carry a `DOVI configuration record` side-data block.

The classifier path that branches on `has_dolby_vision: true` (`classify` in
`src-tauri/src/util/color.rs`) and the ffprobe JSON path that derives that
boolean from the `DOVI configuration record` side-data entry
(`parse_ffprobe_json` in `src-tauri/src/export/ffprobe.rs`) are both fully
covered by hand-built JSON fixtures in their respective unit tests. The
gap — "real DV file → `has_dolby_vision: true`" — is acknowledged in the
fixture-level color integration test (`tests/color_fixtures.rs`) which
declares the DV assertion `#[ignore]` with a TODO referencing this README.

When `dovi_tool` and a DV-capable libx265 are available in the test
environment, replace `dolby_vision.mov` with a real DV file (e.g. an HLG
base + injected RPU producing DV Profile 8.4) and drop the `#[ignore]` on
the DV integration test.
