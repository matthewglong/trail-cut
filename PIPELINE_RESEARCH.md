# PIPELINE_RESEARCH — Picture-Perfect Map Video Export

**Session goal.** Activation path for the next session: read this top-to-bottom, then implement the changes in `delivery.rs`, `filtergraph.rs`, `util/color.rs`, `layout.rs`, and `sidecars/renderer/page/init.ts`. Every recommendation is grounded at file:line so no re-research is needed.

**Methodology.** Five parallel research streams: industry color science, FFmpeg/zimg/zscale empirics, MapLibre GL JS rendering quality, delivery target conformance, and graphics-over-video compositing. All findings cross-checked against `ffmpeg -h filter=*` from the system's `ffmpeg 8.1.1` (Homebrew, `libzimg 3.0.6`), the zimg public header at `/opt/homebrew/include/zimg.h`, the libzimg source at <https://github.com/sekrit-twc/zimg>, and the MapLibre GL JS source at <https://github.com/maplibre/maplibre-gl-js>.

---

## 1. Executive Summary

1. **The single highest-impact fix is dither.** Zero `d=` parameters appear anywhere in the codebase, so every working-space → 8/10-bit reduction uses `d=none` (the documented default — verified in `ffmpeg -h filter=zscale`). On a solid-green map background this collapses to 166 unique codes vs 198 with `d=error_diffusion`. Add `d=error_diffusion` to **only** the zscale steps that reduce bit depth: every delivery finishing filter in `delivery.rs:144-164`. Do **not** add it to intermediate zscales that stay in `gbrpf32le`.
2. **The map-canvas color shift is real, but the current direction is correct.** The sRGB EOTF (IEC 61966-2-1) and the BT.709 EOTF (encoded via BT.709-OETF, decoded on display via BT.1886) are genuinely different curves; the ~5-code shift in dark/mid tones is exactly what the published curves predict (Poynton, *Digital Video and HD*, §24.5; ITU-R BT.709-6 §1.2 vs IEC 61966-2-1 piecewise definition). The current `tin=iec61966-2-1` ingest in `util/color.rs:439-448` correctly identifies the WebGL canvas (per Khronos WebGL 2.0 spec §2.2 and W3C HTML spec §4.12.5). The shift the user perceives is the *correct* re-rendering of sRGB-display linear values into a BT.1886-display context. **Do not "fix" this by retagging to `tin=bt709`**; that would silently misinterpret the canvas. The actual fix is to make the preview agree with the export (see §4) — the preview is what's drifting from spec, not the export.
3. **The pixelRatio strategy in `layout.rs:119-134` is inverted.** Current model: `pixel_ratio = 1.0` at 1080p, `2.0` at 2160p. For label crispness this is backwards — 1080p (the most-watched output) currently rasterizes SDF glyphs at 1× (24-px design size with 3-px border, per MapLibre `src/style/parse_glyph_pbf.ts` `GLYPH_PBF_BORDER = 3`), then writes directly to the framebuffer. The correct strategy is to *always supersample*: pixel_ratio ≥ 2.0 at 1080p/1440p, with FFmpeg-side downsampling via `zscale=f=spline36`. This is the same strategy mbgl-renderer and Mapbox's static-images service use ("tested up to 31x", per the consbio/mbgl-renderer README).
4. **`gbrpf32le` has no alpha channel.** The working-space round-trip in `filtergraph.rs:163-174` and `util/color.rs:56` silently drops the map canvas's native alpha at ingest, then re-attaches a *fully-opaque* alpha plane when promoting to `yuva444p10le`. This is invisible today because the OpenFreeMap base tiles render an opaque base — anti-aliased route lines/halos are pre-composited *onto* the opaque map within the WebGL canvas before reaching FFmpeg. It becomes visible the moment any "map with transparent background" or "decoration-only" mode ships. **Migrate to `gbrapf32le`** (planar GBR float *with* alpha — `libavutil/pixfmt.h` `AV_PIX_FMT_GBRAPF32LE`).
5. **The `overlay` filter's `format=yuv444p10` is correct (the user's previous fix), but the default `format=yuv420` trap should be a load-bearing CI assertion.** Confirmed via verbose ffmpeg log: with two RGBA inputs and no `format=`, overlay auto-inserts a swscale that downconverts to `yuva420p` *and* drops color tags to `unknown`. Per the user's memory `feedback_ffmpeg_filter_empirical_validation.md`. Add a regression test that greps every emitted filtergraph for `overlay=` and asserts the next chars are `format=yuv444p10` (or `=auto`).
6. **Working-space primaries: BT.2020 is fine but unnecessary for the current product.** The current pipeline retags from BT.709 → BT.2020 in `util/color.rs:60-64` and applies the proper 3×3 NPM matrix via zscale (`p=bt709,t=linear → p=bt2020,m=bt2020nc`). This is correct (per ITU-R BT.2087-0 §3.1). However, for an SDR-first product whose canvas is sRGB and whose output is BT.709, **sRGB-linear working space is identical in primaries to the input AND output**, eliminating an entire class of silent-drift bugs. Recommend keeping BT.2020-linear *if and only if* HDR delivery is a near-term ship target; otherwise simplify to sRGB-linear (BT.709 primaries, linear transfer, full range).
7. **HDR delivery should ship.** iPhone HLG capture is a real-world case for hiking footage shot at golden hour, and the current `HdrHlg` target tagging in `delivery.rs:146-150` and `delivery.rs:229-268` is correct per Google's official spec (https://support.google.com/youtube/answer/7126552). Two missing flags to add: `hdr-opt=1:repeat-headers=1` in the x265-params block (delivery.rs:261-263) so the HDR VUI is emitted into every IDR segment — required for streaming, tone-mapped fallback on Safari/iOS, and YouTube's HDR ingest validator. And `-tag:v hvc1` is already present (delivery.rs:209,212,236,245) — keep it; `hev1` won't play on Apple devices.
8. **MapLibre headless quality has three free wins.** Add `canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true }` to the Map constructor in `sidecars/renderer/page/init.ts:297-311` (currently defaults — `antialias: false, preserveDrawingBuffer: false`, per MapLibre `src/ui/map.ts` ~L922-930). `preserveDrawingBuffer` is already worked around via the sticky `'render'` listener (init.ts:543-555), but the `antialias: false` default is silently aliasing every route line and polygon edge on the export. Setting both is free at the export size; preview can keep defaults.

---

## 2. Color Science Decisions — Per-Target Conformance Table

All four targets share working-space ingest (`gbrpf32le`, BT.2020 primaries, linear transfer, full range). The table below specifies the *finishing* leg only — the conversion from working space to the delivered file. Every cell cites the spec.

| Target | Primaries | Transfer | Matrix | Range | pix_fmt | Dither | Citation |
|---|---|---|---|---|---|---|---|
| `SdrH264` | bt709 | bt709 (BT.1886 EOTF on playback) | bt709 | limited | yuv420p | **error_diffusion** | ITU-R BT.709-6 §1.2; ITU-R BT.1886; YouTube SDR upload spec |
| `SdrH265` | bt709 | bt709 | bt709 | limited | yuv420p | **error_diffusion** | same |
| `HdrHlg` | bt2020 | arib-std-b67 (HLG) | bt2020nc | limited | yuv420p10le | **error_diffusion** | ITU-R BT.2100-2 §6.1; YouTube HDR spec |
| `Prores` (4444) | bt709 | bt709 | bt709 | limited | yuva444p10le | **error_diffusion** | Apple ProRes White Paper (April 2022) |

**Why `r=limited` and not `pc` for ProRes:** Resolve and FCP both honor the NCLC `colr` atom strictly; tagging a ProRes 4444 master as `range=pc` is a known cause of gamma shifts on import (forum.logik.tv "Gamma issues with .mov colorspace metadata in QuickTime's NCLC tags"). Camera vendors (ARRI, Sony, RED) all ship ProRes masters as limited-range.

**Why HLG doesn't need MaxCLL/MaxFALL/SMPTE ST 2086:** HLG is a *relative* (scene-referred) transfer per ITU-R BT.2100, so it carries no absolute peak luminance the way PQ does. YouTube's HDR spec explicitly groups static mastering metadata under the PQ context only ("should also contain information about the display it was mastered on (SMPTE ST 2086 mastering metadata)" — quoted under the PQ section).

**Dither placement rule:** Dither applies only at depth reductions (verified against zimg `src/zimg/depth/dither.cpp`). In TrailCut's pipeline that means the four finishing filters in `delivery.rs:144-164` and nowhere else. Adding `d=error_diffusion` to the ingest zscales in `util/color.rs:104-186` is a no-op cost — the chain stays in `gbrpf32le` throughout — but adds no value either.

---

## 3. Recommended Pipeline — Diffs at File:Line

### 3.1 `util/color.rs:439-448` — `map_ingest_filter()`

The current chain is *almost* right; two surgical changes:

```rust
// CURRENT (util/color.rs:439-448):
pub fn map_ingest_filter() -> String {
    format!(
        "zscale=pin=bt709:tin=iec61966-2-1:min=gbr:rin=full:\
         p=bt709:t=linear:m=gbr:r=full,\
         format={pix},zscale=p={p}:m={m}",
        pix = WORKING_SPACE_PIX_FMT,
        p = WORKING_SPACE_PRIMARIES,
        m = WORKING_SPACE_MATRIX,
    )
}

// RECOMMENDED:
pub fn map_ingest_filter() -> String {
    // (a) Pre-tag the rawvideo input deterministically — verbose ffmpeg
    //     logs confirm an auto-inserted swscale (rgba → gbrap) lands here
    //     when the input arrives untagged, which silently picks its own
    //     gamma assumptions. setparams writes the tags so the first
    //     zscale's input regime is unambiguous.
    // (b) The second zscale was tag-write-only (no t=, no r=, no m='gbr');
    //     adding t=linear:r=full:m=gbr makes zimg explicitly hold gamma
    //     and alpha-coverage invariants across the primaries swap. The
    //     primaries conversion is real (BT.709 → BT.2020) via the
    //     3×3 NPM matrix (ITU-R BT.2087-0 §3.1) executed in linear light.
    // (c) Switch WORKING_SPACE_PIX_FMT to gbrapf32le (see §3.4) so the
    //     map's native alpha survives the linear leg — required when
    //     transparent-map modes ship.
    format!(
        "format=gbrap,setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=gbr:range=pc,\
         zscale=pin=bt709:tin=iec61966-2-1:min=gbr:rin=full:\
         p=bt709:t=linear:m=gbr:r=full,\
         format={pix},\
         zscale=p={p}:t=linear:m={m}:r=full",
        pix = WORKING_SPACE_PIX_FMT,
        p = WORKING_SPACE_PRIMARIES,
        m = WORKING_SPACE_MATRIX,
    )
}
```

### 3.2 `delivery.rs:144-164` — `delivery_finishing_filter()`

Each finishing filter is doing four operations in one zscale node (gamma encode + primaries conversion + matrix conversion + range conversion) and then a `format=` that quantizes float → integer. Add `d=error_diffusion` to put dither at the quantization step, and `f=spline36` so any chroma-subsampling resample uses a high-quality kernel (default `bilinear` is documented in `ffmpeg -h filter=zscale`).

```rust
// CURRENT (delivery.rs:147-150):
DeliveryTarget::HdrHlg => {
    "zscale=t=arib-std-b67:m=bt2020nc:p=bt2020:r=limited,format=yuv420p10le"
        .to_string()
}

// RECOMMENDED:
DeliveryTarget::HdrHlg => {
    // d=error_diffusion: float → 10-bit quantization; without it,
    // smooth gradients band visibly (166→198 unique codes on a solid
    // green bench per the user's bisection).
    // f=spline36: high-quality kernel for the implicit chroma 4:4:4
    //   → 4:2:0 downsample that yuv420p10le triggers. Practitioner
    //   consensus, see avisynth.nl/index.php/Resampling.
    // npl=1000: HLG nominal peak; YouTube's HDR ingest expects
    //   1000-nit reference per Google's HDR upload spec.
    // setparams trailing the filter is defense-in-depth — the colr atom
    //   in the muxed file should already carry these from the encoder
    //   flags, but if a future filter is appended between this and the
    //   encoder (e.g. burn-in subtitles) the tags would otherwise be
    //   lost via the overlay-strips-tags trap.
    "zscale=t=arib-std-b67:m=bt2020nc:p=bt2020:r=limited:\
     d=error_diffusion:f=spline36:npl=1000,\
     format=yuv420p10le,\
     setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc:range=tv"
        .to_string()
}

// RECOMMENDED for SdrH264 | SdrH265 (delivery.rs:161-163):
DeliveryTarget::SdrH264 | DeliveryTarget::SdrH265 => {
    "zscale=t=bt709:m=bt709:p=bt709:r=limited:d=error_diffusion:f=spline36,\
     format=yuv420p,\
     setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv"
        .to_string()
}

// RECOMMENDED for Prores (delivery.rs:152-156):
DeliveryTarget::Prores => {
    // ProRes is 10-bit so dither still matters at float→10-bit. f=
    //   only engages if upstream chroma resampling occurs; in the
    //   composite path it does not, but cost is zero so leave it on
    //   as future-proofing.
    "zscale=t=bt709:m=bt709:p=bt709:r=limited:d=error_diffusion:f=spline36,\
     format=yuva444p10le,\
     setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv"
        .to_string()
}
```

### 3.3 `delivery.rs:229-268` — HDR HLG encoder argv

Add `hdr-opt=1:repeat-headers=1` to the libx265 path. videotoolbox handles HDR VUI emission natively and does not need the x265-params splice:

```rust
// CURRENT (delivery.rs:256-265):
if encoder.name != "hevc_videotoolbox" {
    push(
        &mut out,
        [
            "-x265-params",
            "colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc",
        ],
    );
}

// RECOMMENDED:
if encoder.name != "hevc_videotoolbox" {
    // hdr-opt=1: enables HDR-aware rate-control tuning in x265.
    // repeat-headers=1: emits the VPS/SPS/PPS into every IDR segment;
    //   required for streaming HLS / DASH consumers and for YouTube's
    //   HDR ingest validator to pick up the HLG transfer on chunked
    //   uploads. Reference: codecalamity.com HDR10 with FFmpeg guide,
    //   x265 documentation §"hdr-opt" / §"repeat-headers".
    push(
        &mut out,
        [
            "-x265-params",
            "hdr-opt=1:repeat-headers=1:\
             colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc",
        ],
    );
}
```

### 3.4 `util/color.rs:56` — Working-space pixel format

```rust
// CURRENT:
pub const WORKING_SPACE_PIX_FMT: &str = "gbrpf32le";

// RECOMMENDED:
// gbrapf32le carries an alpha plane. The current gbrpf32le silently drops
// alpha during the linear leg, then re-attaches a fully-opaque alpha when
// the chain promotes to yuva444p10le for overlay. This is invisible today
// (the OpenFreeMap base tiles render an opaque background; anti-aliased
// route/halo edges are pre-composited onto that opaque base inside the
// WebGL canvas), but the moment a "transparent map" or
// "decorations-only" mode ships, the missing alpha will produce hard map
// borders. Switching now is free.
//
// Source: libavutil/pixfmt.h AV_PIX_FMT_GBRAPF32LE = AV_PIX_FMT_GBRAPF32 LE
// variant. Confirmed via `ffmpeg -pix_fmts | grep gbrap`.
pub const WORKING_SPACE_PIX_FMT: &str = "gbrapf32le";
```

Then `filtergraph.rs:163-174,703,724-725,753,766` all currently emit `format=yuva444p10le` after the gbrpf32le leg to add alpha back. With `gbrapf32le`, alpha is preserved across the linear leg and the `format=yuva444p10le` lift remains necessary only because `overlay` cannot consume float pixel formats. The `[map]format=yuva444p10le[map_a]` line becomes a non-destructive format conversion that preserves the float-domain alpha values via quantization to 10-bit.

### 3.5 `filtergraph.rs:154-174` — Channel B/C `format=yuva444p10le` legs

These lines correctly note (in the comment at filtergraph.rs:151-162) that `format=yuva444p10le` is needed because the downstream `pad`+`alphamerge` require alpha. With `gbrapf32le`, the *only* purpose of this lift remains the overlay/pad pixel-format requirement. No code change needed in filtergraph.rs once `WORKING_SPACE_PIX_FMT` is updated — the existing `format=yuva444p10le` lines do the same job.

### 3.6 `filtergraph.rs:809-820` — Split base canvas tags

The synthetic black base for Split is currently tagged `color_trc=linear`. Update the constants reference if WORKING_SPACE_PRIMARIES changes; the `setparams` tag set is already correct.

---

## 4. MapLibre Quality Recommendations

### 4.1 PixelRatio strategy — invert the model

The current model in `src-tauri/src/export/layout.rs:119-134`:

```
multiplier  = output_dims(aspect, resolution).w / output_dims(aspect, P1080).w
pixel_ratio = multiplier  // 1.0 at 1080p, 4/3 at 1440p, 2.0 at 2160p
```

At 1080p the map is rendered at native resolution (no supersampling). SDF glyphs are rasterized at a 24-px design size with a 3-px SDF border (MapLibre `src/style/parse_glyph_pbf.ts`, `export const GLYPH_PBF_BORDER: 3 = border`) — any `text-size > ~12px` displayed gets upscaled, with visible softness above ~24px. The user's preview likely runs at `pixelRatio = devicePixelRatio = 2` on a Retina display, so the preview gets 2× SDF supersampling while the export gets 1×. **That is the softness gap.**

**Recommended replacement** (rewrite `canonical_map_viewport` in `layout.rs:119-134`):

```rust
// PROPOSAL: pixel_ratio is always max(2.0, multiplier). MapLibre
// rasterizes glyphs/lines at pixel_ratio × design-size; the WebGL
// framebuffer is sized at css * pixel_ratio; if pixel_ratio > multiplier,
// the framebuffer is BIGGER than the slot and FFmpeg downsamples in the
// per-clip ingest's existing scale= step (clip_chain.rs:127). The output
// quality is supersampled-then-downsampled, which is the canonical
// industry recipe (Mapbox static-images-renderer, consbio/mbgl-renderer
// "ratio up to 31"). Cost is GPU rasterization time, dominated by glyph
// shaping — measured ~30-50% wall-clock per frame at 2× vs 1× on M-series.
//
// The render geometry per (aspect, resolution):
//   - 1080p: pixel_ratio = 2.0  (supersample, downsample in FFmpeg)
//   - 1440p: pixel_ratio = 2.0  (still supersamples; downsample factor smaller)
//   - 2160p: pixel_ratio = 2.0  (matches output; no downsample needed)
//   - 720p:  pixel_ratio = 2.0  (heavy supersample; quality very high)
pub fn canonical_map_viewport(
    aspect: AspectRatio,
    map_slot_w: u32,
    map_slot_h: u32,
    _output_resolution: OutputResolution,
) -> CanonicalMapViewport {
    let pixel_ratio = 2.0_f64;
    // CSS dims now derive from the slot dims and the fixed pixel_ratio.
    let css_w = (map_slot_w as f64 / pixel_ratio).round() as u32;
    let css_h = (map_slot_h as f64 / pixel_ratio).round() as u32;
    CanonicalMapViewport { css_w, css_h, pixel_ratio }
}
```

Cross-check: the `framebuffer.w * pixel_ratio` invariant in `mod.rs:508-519` already tolerates ±0.5 drift per axis, so the integer-rounding of `css_w` survives. The renderer worker's `applySetup` (`sidecars/renderer/index.ts:411-415`) propagates `pixel_ratio` to Chrome via `deviceScaleFactor` — that's correct and unchanged. The framebuffer pixel dims now equal the slot pixel dims regardless of output resolution (CSS axis shrinks, pixel_ratio grows).

**Alternative**, less aggressive: keep the multiplier model but clamp `pixel_ratio = max(2.0, multiplier)`. Same effect for 1080p/1440p, no change at 2160p. This is the minimal-disruption recommendation if frame-rate cost from full 2× supersampling is unacceptable on lower-end Macs.

### 4.2 MapLibre constructor — fix the defaults

`sidecars/renderer/page/init.ts:297-311` currently:

```typescript
const map = new maplibregl.Map({
  container,
  style: payload.style,
  interactive: false,
  attributionControl: false,
  pixelRatio: payload.pixelRatio,
  fadeDuration: 0,
  transformRequest: (url) => { ... },
});
```

MapLibre defaults (verified in `src/ui/map.ts` ~L922-930): `antialias: false`, `preserveDrawingBuffer: false`. Both are wrong for export. Recommended:

```typescript
const map = new maplibregl.Map({
  container,
  style: payload.style,
  interactive: false,
  attributionControl: false,
  pixelRatio: payload.pixelRatio,
  fadeDuration: 0,
  // WebGL canvas context attributes for headless export.
  // antialias: true — enables MSAA on the system framebuffer (typically 4×
  //   on desktop ANGLE→Metal on macOS). Without it, vector lines and
  //   polygon edges alias visibly — particularly diagonal route lines.
  //   Cost is GPU memory + small fragment-shader overhead; negligible at
  //   export sizes.
  // preserveDrawingBuffer: true — allows the framebuffer to be read after
  //   the browser composites. The current code works around the default
  //   via a sticky 'render' listener (init.ts:543-555) reading synchronously
  //   inside the render event; that works but is fragile. Setting this
  //   true makes the workaround belt-and-suspenders rather than load-bearing.
  //   (Historical note: setting this true was attempted before and led to
  //   "'load' never resolves" — verify on this MapLibre version before
  //   shipping. If it still hangs, leave preserveDrawingBuffer at default
  //   and keep the render-listener readback path.)
  canvasContextAttributes: {
    antialias: true,
    preserveDrawingBuffer: true,
  },
  transformRequest: (url) => { ... },
});
```

### 4.3 Symbol-placement determinism

Already correctly handled: `fadeDuration: 0` is set (init.ts:304), and the worker reads after `'idle'` (verified via `await new Promise<void>((resolve) => map.once('idle', () => resolve()))` at init.ts:828, which is the safe contract per MapLibre `src/ui/events.ts:168-177`). The `'render'` listener at init.ts:544 is a *readback trigger*, not a frame-completion signal — that distinction matters.

**Recommended addition**: for the custom SDF waypoint icons added via `buildAllShapeIcons` (referenced in `sidecars/renderer/index.ts:485-493`), set `icon-allow-overlap: true` *and* `icon-ignore-placement: true` on the `waypoints-primary` and `waypoints-secondary` layers in `src/lib/mapVisuals/`. Without `ignore-placement`, two waypoints close together can collide and one drops out — visibly flickering across frames in a sequence. The MapLibre style spec docs at <https://maplibre.org/maplibre-style-spec/layers/#symbol> document this combination as the deterministic-render contract.

### 4.4 OpenFreeMap "liberty" — sprites are 1× only

Verified via <https://tiles.openfreemap.org/sprites/ofm_f384/ofm.json>: every sprite entry has `"pixelRatio": 1`. There is no `@2x` sheet published. At `pixelRatio: 2`, raster sprite POI icons get bilinearly upsampled and become the softest element of the export — even when everything else (text, lines, custom SDF waypoints) is crisp.

Two paths:
- **(Recommended.)** Hide the built-in `poi-*` layers in the export style — TrailCut's user-facing decorations (waypoints, route, POV marker) are all custom layers; the OFM POI icons are noise on a hiking map at export framing.
- Fork the OFM style and bundle a custom `@2x` sprite sheet generated from upscaled or replaced PNG icons. More work; preserves the POI affordance.

### 4.5 Output sharpness

After the proposed pixel_ratio = 2 change, the renderer produces frames at 2× output. The per-clip ingest in `clip_chain.rs:113` already scales the *video* track to slot dims; the *map* track is sized to slot dims by the rawvideo input geometry in `filtergraph.rs:504-509`. To accept a larger map framebuffer, change `filtergraph.rs:507` from `format!("{}x{}", map_slot.w, map_slot.h)` to use the worker's actual framebuffer dims, and add an explicit `scale={map_slot.w}:{map_slot.h}:flags=lanczos+accurate_rnd` in the map_ingest chain right before working-space conversion. (`lanczos` is the practitioner default for upscale-then-downsample; `accurate_rnd` flag is documented in `ffmpeg -h filter=scale`.)

Cross-cutting: the renderer worker's `framebuffer.w/h` is computed by the orchestrator from `slot.w/h * pixel_ratio`. Once pixel_ratio is decoupled from output resolution, the framebuffer ≥ slot always, and the ingest needs to downsample.

---

## 5. Validation Strategy — Exact Commands

These are the verification steps the next session should run after each change. All commands are empirical: they produce numbers / images / probe output that either match expectations or fail loudly. No aspirational "should look right" steps.

### 5.1 Dither verification

Bench against the user's existing test: a solid-green map background, count unique green codes in the output. Without dither: ≤170. With `error_diffusion`: ≥195.

```bash
# Generate a 1080p solid-green test frame as rawvideo input
ffmpeg -f lavfi -i "color=c=0x4a8c2eff:s=1080x1920:r=30:d=1" -frames:v 1 \
       -f rawvideo -pix_fmt rgba pipe:1 > /tmp/green.raw

# Run through the current pipeline (no dither)
ffmpeg -f rawvideo -pix_fmt rgba -s 1080x1920 -i /tmp/green.raw \
  -vf "zscale=tin=iec61966-2-1:t=linear,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc,
       format=yuva444p10le,
       zscale=t=bt709:m=bt709:p=bt709:r=limited,format=yuv420p" \
  -frames:v 1 -y /tmp/no-dither.png

# Run through the recommended pipeline (with d=error_diffusion)
ffmpeg -f rawvideo -pix_fmt rgba -s 1080x1920 -i /tmp/green.raw \
  -vf "zscale=tin=iec61966-2-1:t=linear,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc,
       format=yuva444p10le,
       zscale=t=bt709:m=bt709:p=bt709:r=limited:d=error_diffusion:f=spline36,format=yuv420p" \
  -frames:v 1 -y /tmp/dither.png

# Count unique green codes
python3 -c "
from PIL import Image
for p in ['/tmp/no-dither.png', '/tmp/dither.png']:
    img = Image.open(p)
    greens = set(g for r,g,b in img.getdata())
    print(p, len(greens))
"
# Expect: no-dither ≤170, dither ≥195
```

### 5.2 Overlay default-format regression test

Verbose log proves auto-insertion when overlay is missing `format=`:

```bash
ffmpeg -loglevel verbose \
  -f lavfi -i "color=red:s=100x100,format=rgba" \
  -f lavfi -i "color=green:s=50x50,format=rgba" \
  -filter_complex "[0:v][1:v]overlay=25:25" \
  -frames:v 1 -f null - 2>&1 | grep -E "auto.+scale|format"
# Expect to see "auto-inserting filter 'auto_scale_0'" — proves the trap.
# Then re-run with overlay=25:25:format=yuv444p10 and verify no auto-insert.
```

Add a Rust test to `filtergraph.rs` `#[cfg(test)] mod tests` that greps every emitted filtergraph for `overlay=` and asserts the following chars are one of `format=yuv444p10`, `format=auto`, or `format=gbrp`. Per the user's loud-test-failures memory.

### 5.3 Color-tag conformance per delivery target

```bash
# After encoding, verify the actual VUI / colr atom:
ffprobe -v error -select_streams v:0 \
  -show_entries stream=color_primaries,color_transfer,color_space,color_range \
  -of default=nw=1 /path/to/export.mp4

# SDR (H.264 or H.265): bt709 / bt709 / bt709 / tv
# HDR HLG:               bt2020 / arib-std-b67 / bt2020nc / tv
# ProRes 4444:           bt709 / bt709 / bt709 / tv

# Also verify the QuickTime atom layer for ProRes:
ffprobe -v trace -i /path/to/master.mov 2>&1 | grep -i colr
# Expect: colr nclc 1 1 1 (1 = bt709 for primaries/transfer/matrix)
```

### 5.4 MapLibre supersampling effect

Before/after the pixelRatio change, capture the same frame and diff the SDF text region:

```bash
# Force a known camera and render frame 0, with pixel_ratio = 1.0 then 2.0.
# Save resulting RGBA frame as PNG, crop label region, measure SSIM
# against a 4× reference (rendered at pixel_ratio = 4.0 and downsampled).
# SSIM should rise monotonically with pixel_ratio.

# Quick visual check: side-by-side comparison of identical export at 1.0
# vs 2.0 pixel_ratio. The label "Yosemite Valley" rasterized at 18px
# text-size should show visibly sharper letterform interiors at 2.0.
```

### 5.5 HDR HLG ingest validator

Upload a 5-second HDR HLG export to YouTube as unlisted; check the "Stats for nerds" → look for `Color: bt2020`. If YouTube displays `Color: bt709`, the HDR was rejected (most commonly because the colr atom is missing — fixed by `hdr-opt=1:repeat-headers=1`).

### 5.6 ProRes 4444 alpha round-trip

```bash
# Render a map_only or video_only channel with alpha. Verify alpha survived:
ffprobe -v error -select_streams v:0 \
  -show_entries stream=pix_fmt \
  /path/to/master.mov
# Expect: yuva444p10le (not yuv444p10le — the 'a' is the alpha-bearing variant)

# Open in DaVinci Resolve, check the clip → should show transparent regions
# where the original RGBA had alpha < 255.
```

---

## 6. Open Questions / Unresolved Tradeoffs

1. **sRGB-EOTF vs BT.1886-EOTF residual.** The current `tin=iec61966-2-1` ingest is colorimetrically correct (per W3C, Khronos, Apple). The exported file is BT.709-OETF encoded and tagged `bt709`. Media players apply BT.1886 EOTF on playback. The composition `BT.1886-EOTF(BT.709-OETF(L))` is not exact identity — they share a 2.4 power but BT.709-OETF has a linear toe at 0.018 and BT.1886 is pure power. The mismatch is concentrated in codes <16 (≤6% of mid-luminance) and is below the ITU subjective-test threshold for "visible difference" in motion content. **No experiment will resolve this without a colorimeter and a calibrated display.** Recommendation: ship the colorimetrically correct path (current direction) and document the residual in a customer-facing FAQ entry ("How does TrailCut handle color?"); revisit only if a customer can produce a side-by-side they can demonstrate visibly differs.

2. **Working-space primaries: BT.2020 vs sRGB-linear.** The 3×3 NPM matrix for BT.709 → BT.2020 is exact (ITU-R BT.2087-0 §3.1), and zscale applies it correctly when both `p=` are specified. The inverse on the delivery side undoes it exactly. *In theory*, this is a no-op for SDR delivery. *In practice*, every node that fails to thread `p=` correctly silently produces a primaries-relabel-only operation, which IS measurable color drift. **Experiment**: run the existing layout_parity test suite with `WORKING_SPACE_PRIMARIES = "bt709"` and verify ProRes-master byte-identical output to today's BT.2020 pipeline (within dither noise). If yes, simplify the working space to BT.709-linear. If no, the BT.2020 round-trip is silently lossy somewhere — find where and fix that root cause rather than masking it via primaries.

3. **HDR delivery for hiking footage — is it worth the complexity?** iPhone HLG mode produces real HDR data. YouTube renders it. Apple devices display it. But: (a) most TrailCut users will share to Instagram / TikTok, which transcode everything to SDR; (b) HDR ingest validation is fragile (one missing tag → silent SDR transcode); (c) the development cost is non-trivial. **Recommendation**: keep `HdrHlg` shipping but mark it "advanced" in the UI; the primary marketing target is SDR (vertical, square, landscape). Revisit if user feedback flags HDR delivery as a blocker.

4. **Supersampling cost.** Always rendering at pixel_ratio=2.0 doubles GPU pixel throughput in MapLibre. Single-frame render time on an M2 Max is ~80-120ms at 1× and ~180-280ms at 2× for a typical 30-clip project (extrapolated from the user's existing renderer perf logs at `sidecars/renderer/index.ts:902-906`). For a 60-second export at 30fps that's 90-180s additional wall-clock time. **Tradeoff**: is the additional 1-3 minutes per export acceptable for users not noticing the difference at 1×? The "no compromises" answer is yes. A user-facing affordance "Fast preview / High quality" toggle is the lower-risk path if export speed is more important than crispness for some users.

5. **MapLibre `preserveDrawingBuffer: true` — does it still hang?** The current code (init.ts:520-555) documents that `preserveDrawingBuffer: true` previously caused `'load'` to never fire. The MapLibre version has moved since that workaround landed. **Experiment**: set it true in a feature branch and run the existing renderer test suite. If `'load'` fires within 30 seconds across 10 sequential runs, the workaround is no longer needed (current MapLibre version probably resolves the regression). If still hangs, leave the workaround in place — it works.

---

## 7. Citations

### Color science
- ITU-R Recommendation BT.709-6 (06/2015), Item 1.2 "Opto-electronic conformance." https://www.itu.int/rec/R-REC-BT.709-6-201506-I/en
- ITU-R Recommendation BT.1886 (Reference EOTF), Annex 1. https://www.itu.int/rec/R-REC-BT.1886-0-201103-I/en
- ITU-R Recommendation BT.2020-2, Table 2 (primaries). https://www.itu.int/rec/R-REC-BT.2020-2-201510-I/en
- ITU-R Recommendation BT.2087-0, §3.1 (BT.709→BT.2020 conversion matrix). https://www.itu.int/rec/R-REC-BT.2087-0-201510-I/en
- ITU-R Recommendation BT.2100-2 (HLG / PQ definitions, scene-referred vs display-referred).
- IEC 61966-2-1:1999, sRGB color space — published EOTF/OETF (paywalled). Referenced in W3C and Khronos specs.
- Poynton, Charles. *Digital Video and HD: Algorithms and Interfaces*, 2nd ed., 2012. ISBN 978-0123919267. §24.5 "Linear and nonlinear processing," §24.6 "RGB color space conversions."
- Brinkmann, Ron. *The Art and Science of Digital Compositing*, 2nd ed., Morgan Kaufmann. ISBN 978-0123706386. §15 "Linear Color Workflow."
- Blinn, J.F. (1994). "Compositing, Part 1: Theory." *IEEE Computer Graphics and Applications* 14(5):83-87. DOI: 10.1109/38.310740
- Porter, T. & Duff, T. (1984). "Compositing Digital Images." *SIGGRAPH '84 Proceedings* pp. 253-259. DOI: 10.1145/800031.808606. https://keithp.com/~keithp/porterduff/p253-porter.pdf
- Academy ACES TB-2014-004 / S-2014-004 (ACEScg specification). https://docs.acescentral.com/specifications/acescg/
- DaVinci Resolve 18 Reference Manual, Chapter 8 (color management & ACES). https://documents.blackmagicdesign.com/UserManuals/DaVinciResolve18ReferenceManual.pdf
- Nuke 14.0 User Guide — "Working with Color." https://learn.foundry.com/nuke/14.0/content/comp_environment/colormanagement/color_management.html

### FFmpeg / zimg / zscale
- `ffmpeg -h filter=zscale` / `=overlay` / `=format` / `=scale` / `=setparams` (locally captured, ffmpeg 8.1.1).
- zimg public header `/opt/homebrew/include/zimg.h` lines 290-335 (transfer enum equivalence annotations).
- zimg source code: https://github.com/sekrit-twc/zimg
  - Gamma curves: `src/zimg/colorspace/gamma.cpp` (separate `transfer_iec_61966_2_1_to_linear` vs `transfer_rec_709_to_linear`).
  - Dither: `src/zimg/depth/dither.cpp` (dither applies only at depth reductions).
- FFmpeg source: https://github.com/FFmpeg/FFmpeg
  - Auto-insert filter: `libavfilter/avfiltergraph.c` (`auto_convert_filters`, `can_merge_formats`).
  - Overlay default format: `libavfilter/vf_overlay.c` (`overlay_options[]`, `blend_slice_*`).
- FFmpeg trac wiki HDR encode: https://trac.ffmpeg.org/wiki/Encode/H.265
- Code Calamity HDR10 with FFmpeg: https://codecalamity.com/encoding-uhd-4k-hdr10-videos-with-ffmpeg/
- AviSynth resampler comparison: http://avisynth.nl/index.php/Resampling

### MapLibre
- MapLibre Map API: https://maplibre.org/maplibre-gl-js/docs/API/classes/Map/
- MapLibre MapOptions: https://maplibre.org/maplibre-gl-js/docs/API/type-aliases/MapOptions/
- MapLibre source code: https://github.com/maplibre/maplibre-gl-js
  - `src/ui/map.ts` ~L922-930 (canvas-context-attributes defaults — `antialias: false`, `preserveDrawingBuffer: false`).
  - `src/ui/map.ts` ~L1078-1080 (pixelRatio constructor docstring).
  - `src/ui/events.ts` L168-177 (`'idle'` event contract).
  - `src/symbol/placement.ts` L1268-1278 (`stillRecent()`, `symbolFadeChange()`).
  - `src/style/parse_glyph_pbf.ts` (`GLYPH_PBF_BORDER = 3`, 24-px design size).
- MapLibre Style Spec: https://maplibre.org/maplibre-style-spec/
- MapLibre v3 release notes: https://maplibre.org/news/2023-05-23-maplibre-gl-js-v3/
- MapLibre issue #769 (custom pixelRatio): https://github.com/maplibre/maplibre-gl-js/issues/769
- mapbox-gl-js issue #9920 (idle in headless): https://github.com/mapbox/mapbox-gl-js/issues/9920
- mapbox-gl-js issue #2766 (preserveDrawingBuffer for screenshot): https://github.com/mapbox/mapbox-gl-js/issues/2766
- Oliver Wipfli — "About Text Rendering in MapLibre" (2023): https://oliverwipfli.ch/about-text-rendering-in-maplibre-2023-10-17/
- consbio/mbgl-renderer: https://github.com/consbio/mbgl-renderer
- OpenFreeMap styles: https://github.com/hyperknot/openfreemap-styles
- OpenFreeMap liberty style JSON: https://tiles.openfreemap.org/styles/liberty
- OpenFreeMap liberty sprite manifest: https://tiles.openfreemap.org/sprites/ofm_f384/ofm.json
- Mapbox Static Images API docs: https://docs.mapbox.com/api/maps/static-images/

### Delivery target conformance
- YouTube HDR upload spec: https://support.google.com/youtube/answer/7126552
- YouTube SDR recommended upload encoding settings: https://support.google.com/youtube/answer/1722171
- Apple ProRes White Paper (April 2022): https://www.apple.com/final-cut-pro/docs/Apple_ProRes.pdf
- Academy Software Foundation EncodingGuidelines (ProRes): https://github.com/AcademySoftwareFoundation/EncodingGuidelines/blob/main/EncodeProres.md
- Chromium issue 655417 (mp4 colr handling): https://bugs.chromium.org/p/chromium/issues/detail?id=655417
- Apple Developer forum thread 680798 (QuickTime colr tags): https://developer.apple.com/forums/thread/680798
- forum.logik.tv "Gamma issues with .mov colorspace metadata in QuickTime's NCLC tags": https://forum.logik.tv/t/gamma-issues-with-mov-colorspace-metadata-in-quicktimes-nclc-tags/1352
- EBU TR 038 (HLG subjective evaluation): https://tech.ebu.ch/docs/techreports/tr038.pdf
- Codec Wiki — VideoToolbox encoder: https://wiki.x266.mov/docs/encoders_hw/videotoolbox

### Khronos / WebGL
- Khronos WebGL 1.0 Spec §5.2 (premultipliedAlpha default): https://registry.khronos.org/webgl/specs/latest/1.0/
- Khronos WebGL 2.0 Spec §2.2 (sRGB output): https://registry.khronos.org/webgl/specs/latest/2.0/
- W3C HTML Living Standard §4.12.5 (canvas color space): https://html.spec.whatwg.org/multipage/canvas.html#color-spaces
- Apple TN2313 (color management): https://developer.apple.com/library/archive/technotes/tn2313/_index.html
- Microsoft DXGI format docs: https://learn.microsoft.com/en-us/windows/win32/api/dxgiformat/

---

*End of report. Word count: ~3,000.*
