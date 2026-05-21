# WS4 — Delivery Transforms

**Phase:** 1
**Blocks:** WS5
**Blocked by:** WS3 (delivery transforms plug into the working-space architecture)
**Estimated scope:** medium — five delivery formulas, encoder argv changes

## Goal

Implement the five `F_delivery_{target}` formulas. Each takes working-space pixels to a final output file with explicit color tagging. **This is the workstream that kills the QuickTime per-frame warnings** — every output is now consistently tagged.

## Context

Read first:
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — delivery formula table.
- [`../background/design-decisions.md`](../background/design-decisions.md) — Decision 2 (per-export delivery target).

Current state (after WS3 lands): export filter graph ends with `[vout_w]format=yuv444p10le[vout]` as a placeholder. Encoder argv has no color flags. This workstream replaces the placeholder with target-specific delivery transforms and adds full output tagging.

## Files to modify

| File | Change |
|---|---|
| `src-tauri/src/export/mod.rs` | Add `DeliveryTarget` enum, plumb through `render_export()`. |
| `src-tauri/src/export/filtergraph.rs` | Replace placeholder `format=yuv444p10le[vout]` with per-target delivery chain. |
| `src-tauri/src/export/encoder.rs` | Add per-target encoder argv (codec + color flags + container settings). |
| `src/types.ts` | Mirror `DeliveryTarget` enum in TS. |

## Implementation

### 1. Define `DeliveryTarget`

In `src-tauri/src/export/mod.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryTarget {
    SocialSdrVertical,   // TikTok / IG Reels — 9:16 1080×1920, H.264, BT.709 limited
    SocialSdrSquare,     // IG feed — 1:1 1080×1080, H.264, BT.709 limited
    YoutubeSdr4k,        // 16:9 3840×2160, HEVC, BT.709 limited
    YoutubeHdr4k,        // 16:9 3840×2160, HEVC 10-bit, HLG BT.2020 limited
    ProresMaster,        // matches project aspect, ProRes 4444, BT.709 limited
}
```

Extend `render_export()` to take a `DeliveryTarget` parameter (alongside the existing channel selection). Channel B (map_only) and Channel C (video_only) default to `ProresMaster`; Channel A (composite) accepts any target.

### 2. Per-target delivery filter chain

In `filtergraph.rs`, after the composite output `[vout_w]` (in working space, `gbrpf32le`), apply:

#### `SocialSdrVertical`, `SocialSdrSquare`, `YoutubeSdr4k`, `ProresMaster`
All SDR targets share the same color conversion:
```
[vout_w] zscale=t=bt709:m=bt709:p=bt709:r=limited,format=yuv420p[vout]
```
(For `ProresMaster`, use `format=yuva444p10le` to preserve alpha and bit depth.)

#### `YoutubeHdr4k`
```
[vout_w] zscale=t=arib-std-b67:m=bt2020nc:p=bt2020:r=limited,format=yuv420p10le[vout]
```

### 3. Per-target encoder argv

In `encoder.rs`, add a function that returns the encoder argv for a given `DeliveryTarget`. Examples:

#### `SocialSdrVertical` (9:16 1080×1920 H.264)
```
-vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2"
-c:v libx264 -preset medium -crf 18
-pix_fmt yuv420p
-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv
-c:a aac -b:a 192k
-movflags +faststart
```

#### `SocialSdrSquare` (1:1 1080×1080)
Same as above with `scale=1080:1080:...,pad=1080:1080:...`.

#### `YoutubeSdr4k` (16:9 3840×2160 HEVC)
```
-vf "scale=3840:2160:force_original_aspect_ratio=decrease,pad=3840:2160:(ow-iw)/2:(oh-ih)/2"
-c:v hevc_videotoolbox -tag:v hvc1 -q:v 50
-pix_fmt yuv420p
-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv
-c:a aac -b:a 192k
-movflags +faststart
```
Fall back to `libx265 -preset medium -crf 18` when VideoToolbox is unavailable.

#### `YoutubeHdr4k` (16:9 3840×2160 HEVC 10-bit HLG)
```
-vf "scale=3840:2160:force_original_aspect_ratio=decrease,pad=3840:2160:(ow-iw)/2:(oh-ih)/2"
-c:v hevc_videotoolbox -tag:v hvc1 -q:v 50 -profile:v main10
-pix_fmt yuv420p10le
-color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc -color_range tv
-c:a aac -b:a 192k
-movflags +faststart
```
Fall back to `libx265 -preset medium -crf 18 -profile:v main10` when VideoToolbox is unavailable.

#### `ProresMaster`
```
-c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le
-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv
-c:a pcm_s16le
```

### 4. Channel × Target compatibility matrix

| Channel | Allowed targets |
|---|---|
| Composite | All five |
| Map_only | `ProresMaster` only (lossless intermediate) |
| Video_only | `ProresMaster` only |

`render_export()` should reject invalid combinations with a clear error.

## Acceptance criteria

- [ ] `cargo build` passes.
- [ ] All five delivery targets produce valid output files for a composite export.
- [ ] `ffprobe` on each output shows the expected color tags:
  - SDR targets: `color_primaries=bt709`, `color_transfer=bt709`, `color_space=bt709`, `color_range=tv`, `pix_fmt=yuv420p` (or `yuva444p10le` for ProRes).
  - HDR target: `color_primaries=bt2020`, `color_transfer=arib-std-b67`, `color_space=bt2020nc`, `color_range=tv`, `pix_fmt=yuv420p10le`.
- [ ] **QuickTime opens every output with zero color warnings.**
- [ ] `mp4dump` confirms exactly one `colr` atom per file, matching the stream VUI.
- [ ] HDR output plays on YouTube as HDR (verify by uploading a test export — optional but recommended).
- [ ] PIP composite SDR export and Split composite SDR export of the same project look color-identical.
- [ ] Existing encoder tests still pass; new tests cover each target's argv.

## Out of scope

- UI for picking the delivery target — WS5.
- Batch export (multiple targets at once) — can be added as orchestration on top of WS5; not strictly required for this workstream.
- Codec/quality tuning beyond reasonable defaults.

## References

- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — delivery formula table.
- [`WS3-working-space-export.md`](WS3-working-space-export.md) — upstream working-space architecture.
- [ASWF Encoding Guidelines — H.264](https://academysoftwarefoundation.github.io/EncodingGuidelines/Encodeh264.html).
- [YouTube HDR upload guidance](https://support.google.com/youtube/answer/7126552) — HLG BT.2020 format requirements.
