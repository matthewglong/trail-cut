# Color Pipeline Architecture

## The enterprise pattern

Professional editors (DaVinci Resolve, Premiere, Final Cut) share one core idea: **there is one canonical "working color space" that everything lives in during editing, and the only color math that happens is at the borders — coming in and going out.** Three transforms:

1. **Ingest transform** (`F_ingest_*`) — turn whatever the source is into the working space.
2. **Working space** — a single, known regime where compositing, blending, and effects happen.
3. **Delivery transform** (`F_delivery_*`) — turn the working space into whatever the export target needs.

Proxies are an editing-speed convenience. They live *in* the working space already (rendered down to SDR for browser playback), so the preview matches what export will produce. **Proxies are not used at export time** — export reads the source again and runs the same ingest transform.

## Working space definition

| Property | Value |
|---|---|
| Color model | Linear-light RGB |
| Primaries | BT.2020 (wide gamut, future-proof for HDR delivery) |
| Transfer | Linear (no gamma encoding) |
| Range | Full |
| Internal pixel format | `gbrpf32le` (planar GBR float) through filter graphs |
| Bit depth | 32-bit float for color math, downconverted at delivery |

**Why linear-light, wide-gamut, float:** lets us hold HDR sources (HLG, PQ, Dolby Vision base) without crushing range, lets SDR sources sit comfortably without distortion, and gives log footage (Phase 2) a place to land cleanly after LUT development. Float precision avoids quantization artifacts during compositing.

**Why this matters for the PIP bug:** today, the map enters as full-range sRGB RGBA and gets composited directly with limited-range Y'CbCr video clips that still carry their iPhone source color tags. The overlay filter does no normalization. Result: color drift. In the new architecture, both sides enter the working space first, so the overlay is mixing identical regimes.

## Data flow

```
SOURCE  ──▶  F_ingest_{class}  ──▶  WORKING SPACE  ──▶  F_delivery_{target}  ──▶  OUTPUT
                                    (linear-light,
                                     BT.2020 primaries,
                                     gbrpf32le)

PROXY GENERATION (one per clip, at import):
  source → F_ingest_{class} → F_proxy_encode (downconvert to SDR for WKWebView)

THUMBNAIL GENERATION (one per clip, at import):
  source → F_ingest_{class} → F_thumbnail_encode (sRGB JPEG with ICC profile)

EXPORT (one per delivery, reads source again):
  source → F_ingest_{class} → [concat across clips] ──┐
                                                       ├──▶ composite ──▶ F_delivery_{target}
  map canvas → F_map_to_working ─────────────────────┘
```

## Ingest formulas (Phase 1)

`F_ingest_{class}` takes a source stream into working space.

| Class | Detection signal (ffprobe) | Transform |
|---|---|---|
| `SdrBt709` | `color_transfer=bt709`, no DV side data | Linearize via inverse BT.709 EOTF, primaries pass through |
| `HlgBt2020` | `color_transfer=arib-std-b67` | Inverse HLG OETF with `npl=400`, primaries pass through |
| `PqBt2020` | `color_transfer=smpte2084` | Inverse PQ EOTF with `npl=1000` |
| `DolbyVision` | `side_data_list` contains DOVI config | Treat as HLG base layer (discard RPU for Phase 1) |
| `Unknown` | Anything else | Assume SDR Rec.709 |

FFmpeg pattern (HLG example):
```
zscale=t=linear:npl=400, format=gbrpf32le, zscale=p=bt2020:m=bt2020nc
```

## Map ingest formula

`F_map_to_working`: takes raw RGBA8 from the map renderer's `gl.readPixels()` (full-range sRGB) into working space.

FFmpeg pattern:
```
zscale=t=linear:p=bt709:r=full, format=gbrpf32le, zscale=p=bt2020:m=bt2020nc
```

Same logical operation as `F_ingest_sdr`, but starting from sRGB full-range RGB rather than BT.709 limited Y'CbCr. The map canvas is full-range sRGB by WebGL convention.

## Delivery formulas (Phase 1)

`F_delivery_{target}` takes working-space pixels to a final output file.

| Target | Aspect | Codec | Color | Container | Use |
|---|---|---|---|---|---|
| `social_sdr_vertical` | 9:16 1080×1920 | H.264 | BT.709 limited yuv420p | mp4 | TikTok, IG Reels |
| `social_sdr_square` | 1:1 1080×1080 | H.264 | BT.709 limited yuv420p | mp4 | IG feed |
| `youtube_sdr_4k` | 16:9 3840×2160 | HEVC (videotoolbox) | BT.709 limited yuv420p | mp4 | YouTube SDR |
| `youtube_hdr_4k` | 16:9 3840×2160 | HEVC 10-bit | HLG BT.2020 yuv420p10le | mp4 | YouTube HDR |
| `prores_master` | matches project | ProRes 4444 | BT.709 limited yuva444p10le | mov | Archival / regrading |

Every delivery formula ends with explicit color flags on the output: `-color_primaries`, `-color_trc`, `-colorspace`, `-color_range`, plus `-movflags +faststart` for mp4.

FFmpeg pattern (`social_sdr_vertical`):
```
[working] zscale=t=bt709:m=bt709:p=bt709:r=limited, format=yuv420p
ffmpeg ... -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv -movflags +faststart
```

FFmpeg pattern (`youtube_hdr_4k`):
```
[working] zscale=t=arib-std-b67:m=bt2020nc:p=bt2020:r=limited, format=yuv420p10le
ffmpeg ... -color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc -color_range tv -movflags +faststart
```

## Phase 2 additions

Log formats (D-Log, C-Log, GP-Log, V-Log, S-Log2, S-Log3) are SDR-range files that encode a wider dynamic range via a log curve. They look flat/gray when displayed directly. They need a LUT-based "development" step at ingest.

**Detection limitation:** log formats tag themselves as plain `bt709` in ffprobe output. They cannot be auto-detected reliably from color metadata. Detection relies on camera make/model strings in container metadata (DJI Mavic + 10-bit bt709 → probably D-Log), and is offered to the user as a *suggestion*, not auto-applied. False positives are worse than no detection.

Phase 2 adds:
- New `SourceColorClass` variants: `DLog`, `CLog`, `CLog2`, `CLog3`, `GpLog`, `VLog`, `SLog2`, `SLog3`.
- `F_ingest_{log_class}` formulas using `lut3d` filter with bundled official LUTs.
- Per-clip and per-camera-group source format declaration UI.

## Key design decisions

These were debated and settled during planning. See [`background/design-decisions.md`](background/design-decisions.md) for the full rationale.

1. **Linear-light, wide-gamut working space** (not BT.709 SDR). Enables HDR delivery from any project, handles log footage cleanly when Phase 2 lands.
2. **Always-on (no project type chooser).** TikTok and YouTube HDR exports come from the same project. Per-export delivery target selection, not per-project.
3. **Export reads source, not proxy.** Enterprise pattern; higher fidelity.
4. **Proxy is always SDR.** WKWebView doesn't reliably display HDR. Preview-matches-export holds for SDR; HDR exports are previewed as SDR equivalent.
5. **Auto-detect HDR, manually declare log.** Matches what every enterprise editor does. False positives on log are destructive.
6. **Group-level format declaration for log.** "32 clips from DJI Mavic 3 — set source format for all" in one click.
