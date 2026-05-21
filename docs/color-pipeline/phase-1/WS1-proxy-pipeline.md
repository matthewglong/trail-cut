# WS1 — Proxy Pipeline

**Phase:** 1
**Blocks:** none
**Blocked by:** WS0 (needs `effective_color_class()` on `ClipMetadata`)
**Estimated scope:** small-medium — single Rust function, four branches

## Goal

Replace the current untyped proxy generation with color-class-aware branching. Every proxy is BT.709 SDR limited-range, correctly tagged, viewable consistently in WKWebView regardless of source color space.

## Context

Read first:
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — working space and ingest formula concepts.
- [`../background/design-decisions.md`](../background/design-decisions.md) — Decision 4 (proxies are always SDR).

Current state: `generate_proxy` at `src-tauri/src/commands/ffmpeg.rs:31–50` runs:
```
ffmpeg -i <src> -vf scale=-2:720 -c:v libx264 -preset fast -crf 28 -g 30 -c:a aac -b:a 128k -y <out>.mp4
```
No color flags, no tone-mapping. iPhone HLG source produces a washed-out preview in WKWebView.

## Files to modify

| File | Change |
|---|---|
| `src-tauri/src/commands/ffmpeg.rs` | Rewrite `generate_proxy` to branch on `SourceColorClass` and emit explicit ingest + delivery flags. |

## Implementation

`generate_proxy` should accept (or derive) the `SourceColorClass` of the source. The cleanest approach: probe at the start of the function (re-using the WS0 `ffprobe` helper) and pass the class through. Or accept the class as a parameter from the caller (caller already has the `Clip`).

Branch the `-vf` chain on class:

### SDR Rec.709 (and Unknown — treat as SDR)
No tone-map needed. Just normalize and re-tag.
```
-vf "scale=-2:720,format=yuv420p"
-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv
```

### HLG BT.2020
Tone-map HDR → SDR via Hable, preserving highlight color.
```
-vf "scale=-2:720,zscale=t=linear:npl=400,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv
```

### PQ BT.2020
Same chain with `npl=1000` and explicit PQ input.
```
-vf "scale=-2:720,zscale=t=linear:npl=1000:tin=smpte2084,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv
```

### Dolby Vision
Treat as HLG base layer (Phase 1 limitation — RPU is discarded). Same chain as HLG.

Keep the existing scale, codec, CRF, GOP, and audio settings:
```
-c:v libx264 -preset fast -crf 28 -g 30 -c:a aac -b:a 128k -movflags +faststart -y <out>.mp4
```

Add `-movflags +faststart` to the existing argv (was missing).

## Acceptance criteria

- [ ] `cargo build` passes.
- [ ] Proxy of an iPhone HLG sample plays in WKWebView without washout. Visual comparison against the original: tone-mapped, not desaturated.
- [ ] Proxy of an iPhone SDR sample plays correctly (no regression).
- [ ] ffprobe on every proxy output shows: `color_primaries=bt709`, `color_transfer=bt709`, `color_space=bt709`, `color_range=tv`, `pix_fmt=yuv420p`.
- [ ] mp4 has `moov` atom at the front (`mp4dump` or `MP4Box -info` confirms `faststart`).
- [ ] The `Unknown` class branch produces the same output as the SDR branch.
- [ ] No regression in existing proxy tests.
- [ ] New unit test on the argv builder verifying each class branch produces the expected flag set.

## Out of scope

- HDR proxy output (proxies are always SDR per Decision 4).
- Changing CRF, codec, or audio settings.
- Log format support (Phase 2).

## References

- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — proxy generation pattern in the architecture diagram.
- [`../background/investigation-findings.md`](../background/investigation-findings.md) — root cause analysis for the washout symptom.
- [FFmpeg zscale filter docs](https://ffmpeg.org/ffmpeg-filters.html#zscale).
- [FFmpeg tonemap filter docs](https://ffmpeg.org/ffmpeg-filters.html#tonemap).
