# Investigation Findings (May 2026)

Multi-agent investigation across the existing color pipeline. Verified against the codebase by a follow-up reviewer agent. Findings here are the authoritative source for what's currently broken and why.

## User-reported symptoms

1. **Washed-out video** in thumbnails, previews, and exports.
2. **PIP map saturation** in picture-in-picture composite exports (side-by-side is unaffected).
3. **QuickTime per-frame color warnings** on exported files.

## Categories currently in play

| Stage | Location | Current color contract |
|---|---|---|
| Source ingest | `src-tauri/src/commands.rs::scan_directory/import_media`, `src-tauri/src/util/exiftool.rs:23–31` | ExifTool reads GPS/timestamps only. No color tags captured. |
| Clip model | `src-tauri/src/models.rs:7–80`, `src/types.ts:6–56` | Zero color fields. |
| ffprobe in export | `src-tauri/src/export/ffprobe.rs:21–29, 92–153` | Captures `width/height/has_audio/container_duration_s` only. Color JSON keys never read. |
| Thumbnail | `src-tauri/src/commands/ffmpeg.rs:144–155` (slow output seek) and `:96–106` (fast input seek) | `ffmpeg -i src -ss 1 -frames:v 1 -vf scale=-2:160 -y out.jpg`. No color flags, no ICC profile, no tonemap. |
| Proxy | `src-tauri/src/commands/ffmpeg.rs:31–50` | `ffmpeg -i src -vf scale=-2:720 -c:v libx264 -preset fast -crf 28 …`. No color tagging, no tonemap. Played in `<video>` inside WKWebView. |
| mapVisuals | `src/lib/mapVisuals/{styleSpec,paints,shapes,index}.ts` | Pure sRGB hex throughout. Bit-identical between preview and export. **Not a defect source.** |
| Map capture for export | `src-tauri/sidecars/renderer/page/init.ts:677` | `gl.readPixels(0,0,W,H, RGBA, UNSIGNED_BYTE, scratch)` → raw RGBA8, sRGB full-range, no tagging. |
| Per-clip video subgraph | `src-tauri/src/export/clip_chain.rs:90` | Each clip ends with `,format=yuva444p10le`. **Pixel format only — does NOT normalize range or primaries.** |
| Concat across clips | `clip_chain.rs` concat filter | No colorspace/zscale normalization across N clips. Mixed-source projects produce undefined per-frame color tags. |
| Composite filter (PIP) | `filtergraph.rs:563–569 (PipMapInset)`, `:585–590 (PipVideoInset)` | `[vc][map]overlay=X:Y:format=auto[vout_alpha]; [vout_alpha]format=yuv420p[vout]`. **Overlay does not normalize range or matrix.** |
| Composite filter (Split) | `filtergraph.rs:599–614` | Synthetic black base (`color=c=black:s=WxH,format=yuv444p10le[bg]`), then sequential overlays. The synthetic base normalizes the junction — explains why Split is unaffected by the PIP saturation bug. |
| Map ingest into FFmpeg | `filtergraph.rs:424–429` | `-f rawvideo -pix_fmt rgba -s WxH -r FPS -i pipe:0`. No `-color_range pc`, no primaries/transfer/matrix. |
| Encoder | `encoder.rs:341–347 (hevc_videotoolbox)`, `:352 (libx265 fallback)` | VideoToolbox: `-tag:v hvc1 -q:v 65` — no `-pix_fmt`, no color tags. libx265 fallback: `-pix_fmt yuv420p`, also no color tags. Channels B/C (ProRes 4444): also untagged. |

## Confirmed root causes

### Washout (Symptom 1)

Two concurrent causes:

- `generate_proxy` (`commands/ffmpeg.rs:31–50`) transcodes iPhone sources without tone-mapping. If the source is HLG/BT.2020, the proxy contains HDR-range pixel values re-encoded as H.264 with (potentially stripped or preserved) color tags. WKWebView's handling of those tags is inconsistent across macOS versions.
- Thumbnails (`commands/ffmpeg.rs:144–155`) write JPEGs with no embedded ICC profile and no color space normalization. The JPEG displays with browser/OS-default sRGB assumptions regardless of source color space.

### PIP saturation (Symptom 2)

Root cause at `filtergraph.rs:424–429` (rawvideo input with no range/primaries) and `:546` + `:564–569` (overlay junction):

- Map stream enters as implicit full-range sRGB.
- Video stream enters carrying iPhone source color tags (limited-range, potentially BT.2020) preserved through `clip_chain.rs:90`'s `format=yuva444p10le`.
- `overlay=format=auto` blends pixel-by-pixel without normalizing range, producing the saturation shift.

Split path avoids this because both sources first land on a synthetic full-range black canvas (`filtergraph.rs:599`), which FFmpeg treats as full-range, normalizing the effective base before composition.

### QuickTime warnings (Symptom 3)

Confirmed at `encoder.rs:341–347` and throughout `filtergraph.rs` — no `-color_primaries`, `-color_trc`, `-colorspace`, or `-color_range` flags appear anywhere in final output encoding. The concat of multiple clips with potentially different source color tags (unnormalized by `clip_chain.rs`) means the HEVC encoder receives a stream with conflicting per-frame SEI color data and no container-level override to resolve it.

## Omissions called out by review

- **No color probing**: `ffprobe.rs` never reads color fields. Pipeline is structurally blind to source color space at decision time.
- **No color storage**: `Clip`/`ClipMetadata` have no fields to carry color metadata even if probed.
- **No normalization before concat**: clips with mixed color tags are concatenated as-is.
- **No normalization before overlay**: map (full-range sRGB) and video (limited-range Y'CbCr, possibly BT.2020) are overlaid without `zscale`/`colorspace` reconciliation.
- **No explicit output tagging**: every encoder leg lacks the four color flags.
- **No ICC profile on thumbnail JPEGs**.
- **`hevc_videotoolbox` is not tested for color passthrough** — only `libx265` is stubbed in tests.
- **Inaccuracies in initial investigation** (corrected by reviewer): `generate_thumbnail` is slow-seek form (`-ss` after `-i`); `hevc_videotoolbox` does not pass `-pix_fmt yuv420p` (only libx265 fallback does); composite filtergraph helpers begin at lines 394/502 not 502 flat.

## Reference: FFmpeg color best practices

Authoritative references compiled during the investigation:

- [Apple: Tagging media with video color information](https://developer.apple.com/documentation/avfoundation/tagging-media-with-video-color-information)
- [Apple: HDR Metadata for Apple Devices (PDF)](https://developer.apple.com/av-foundation/High-Dynamic-Range-Metadata-for-Apple-Devices.pdf)
- [Apple: Color parameter atom (colr) reference](https://developer.apple.com/documentation/quicktime-file-format/color_parameter_atom)
- [Canva: A journey through colour space with FFmpeg](https://www.canva.dev/blog/engineering/a-journey-through-colour-space-with-ffmpeg/) — best single-page treatment of metadata-vs-conversion
- [InVideo: Talking about Colorspaces and FFmpeg](https://medium.com/invideo-io/talking-about-colorspaces-and-ffmpeg-f6d0b037cc2f) — overlay/compositing color drift specifically
- [FFmpeg Filters documentation (zscale, tonemap, colorspace, overlay)](https://ffmpeg.org/ffmpeg-filters.html)
- [ASWF Encoding Guidelines — H.264](https://academysoftwarefoundation.github.io/EncodingGuidelines/Encodeh264.html) — authoritative tagging recipe
- [Intel: Chromium/Edge HLG washout advisory](https://www.intel.com/content/www/us/en/support/articles/000095374/graphics.html)
- [BBC qtff-parameter-editor](https://github.com/bbc/qtff-parameter-editor) — surgical fix for mis-tagged QuickTime files

## iPhone source color characteristics (reference)

| Mode | Primaries | Transfer | Matrix | Range |
|---|---|---|---|---|
| SDR (default) | `bt709` | `bt709` | `bt709` | `tv` |
| HLG | `bt2020` | `arib-std-b67` | `bt2020nc` | `tv` |
| Dolby Vision (Profile 8.4) | Unspecified in base; HLG base layer carries primaries; DV RPU layered on top | | | `tv` |

Detection: `ffprobe -v error -select_streams v:0 -show_entries stream=color_primaries,color_transfer,color_space,color_range,pix_fmt -of default=nw=1 in.mov`. Also probe `side_data_list` for Dolby Vision (`dv_profile`, `dv_level`, `rpu_present_flag`).
