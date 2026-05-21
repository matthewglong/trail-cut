# WS2 — Thumbnail Pipeline

**Phase:** 1
**Blocks:** none
**Blocked by:** WS0 (needs `effective_color_class()` on `ClipMetadata`)
**Estimated scope:** small — two Rust functions, color branching + ICC attach

## Goal

Thumbnails are sRGB-tagged JPEGs with no washout on HDR sources. Same color-class branching as WS1 (proxy), but JPEG output with embedded sRGB ICC profile.

## Context

Read first:
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — ingest formula concepts.
- [`../background/investigation-findings.md`](../background/investigation-findings.md) — current thumbnail state.

Current state: two functions in `src-tauri/src/commands/ffmpeg.rs`:
- `generate_thumbnail` (lines ~144–155): `ffmpeg -i src -ss 1 -frames:v 1 -vf scale=-2:160 -y out.jpg` (slow output-seek form)
- `generate_thumbnail_at` (lines ~96–106): `ffmpeg -ss <t> -i src -frames:v 1 -vf scale=-2:160 -y out.jpg` (fast input-seek form)

No color flags, no ICC profile, no tone-mapping. HDR sources produce washed-out thumbnails.

## Files to modify

| File | Change |
|---|---|
| `src-tauri/src/commands/ffmpeg.rs` | Branch both thumbnail functions on `SourceColorClass`. Fix `generate_thumbnail` to use input-seek form. Attach sRGB ICC profile to output. |

## Implementation

Same branching as WS1 but ending in JPEG (mjpeg) instead of H.264. Use the same `-vf` chains from WS1, just substitute the encoder.

### Common output settings

```
-frames:v 1 -c:v mjpeg -q:v 3
-color_primaries bt709 -color_trc iec61966-2-1 -colorspace bt709 -color_range pc
-y <out>.jpg
```

Note: JPEG uses sRGB transfer (`iec61966-2-1`), not BT.709 transfer. Range is `pc` (full) for JPEG.

### Per-class -vf chains

Use the same chains as [WS1](WS1-proxy-pipeline.md), but with the smaller scale target (`scale=-2:160` instead of `-2:720`), and end the chain with `format=yuvj420p` (note the `j` — full range) instead of `yuv420p`.

### ICC profile embedding

FFmpeg's `mjpeg` encoder does not embed ICC profiles natively. Two options:

1. **Preferred:** use FFmpeg's `-attach`/metadata + `mov_text` is N/A for JPEG. Use `-bsf:v "attach=…"` if available, or
2. **Fallback:** after ffmpeg writes the JPEG, shell out to `exiftool -icc_profile<=sRGB.icc <out>.jpg` to embed.

Recommended: option 2. Bundle a small `sRGB.icc` profile file (~3KB) with the app and use the existing ExifTool sidecar. Update the build/packaging if needed.

If ExifTool sidecar is awkward, the minimum acceptable form is: write the four `-color_*` flags in the JPEG metadata via ffmpeg's `metadata=` filter and accept that some viewers will still treat as sRGB-assumed (which is what we want anyway — these are sRGB JPEGs).

### Fix `generate_thumbnail` seek form

While in the file, fix `generate_thumbnail` to use input-seek form (`-ss` before `-i`) — this is a meaningful performance improvement (~10x faster on large files) and was called out by the reviewer as a defect.

```
ffmpeg -ss 1 -i <src> -frames:v 1 -vf "..." ...
```

## Acceptance criteria

- [ ] `cargo build` passes.
- [ ] Thumbnail of an iPhone HLG sample renders without washout. Visual comparison against the original: tone-mapped, not gray/flat.
- [ ] Thumbnail of an iPhone SDR sample renders correctly (no regression).
- [ ] Output JPEGs have sRGB ICC profile embedded (verify with `exiftool -ColorSpaceTags <file>.jpg` showing `sRGB`).
- [ ] `generate_thumbnail` now uses input-seek form (`-ss` precedes `-i`).
- [ ] No regression in existing thumbnail tests.
- [ ] New unit tests cover each color class branch.

## Out of scope

- Changing thumbnail resolution or quality settings.
- Per-frame thumbnail at arbitrary time (existing `generate_thumbnail_at` keeps its signature).
- Log format support (Phase 2).

## References

- [`WS1-proxy-pipeline.md`](WS1-proxy-pipeline.md) — sibling workstream with the same per-class chains.
- [`../background/investigation-findings.md`](../background/investigation-findings.md).
- [FFmpeg mjpeg encoder docs](https://ffmpeg.org/ffmpeg-codecs.html#mjpeg).
