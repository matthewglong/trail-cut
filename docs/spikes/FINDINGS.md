# Spike: 4K HDR-HLG map-export quality vs preview ("Abel's Hike")

**Goal:** reproduce the 4K/24fps/HDR-HLG export of *Abel's Hike* in an isolated harness,
compare map + decoration quality (slimetrail / waypoints / POV) against the SDR map
preview, and find a pipeline that exports the map well. **No core code was changed** —
everything lives in `.spike/`.

## The export under test (from project.json `last_export_selection`)
16:9, 2160p, 24fps, `hdr_hlg`, split layout (video left, divider 0.684).
Map slot geometry (from `layout.rs`): **map_slot 1216×2160**, SSAA factor 2 →
framebuffer 2432×4320, readback 1216×2160, cssViewport 608×1080, **pixelRatio 4.0**.

## Harness (all in `.spike/`)
- `prep.mjs` — parses real `project.json` + `route.gpx` (29,373 trackpoints), runs the
  project's own `dist/setup_fixture.cjs` (real `compileTimeline`/`indexRoute`) → `base_payload.json`.
- `render.mjs` — drives the real `dist/renderer.cjs` (puppeteer + Chrome-for-Testing) standalone,
  saving map frames as PNG. Two modes share identical MapLibre code & camera:
  - `preview` = pixelRatio 2, no SSAA (preview-equivalent)
  - `export`  = pixelRatio 4, SSAA 2× (the real 4K export render)
- `ff.sh` / `score.sh` — replicate the codebase's exact FFmpeg color filters and score
  candidates (PSNR/SSIM vs preview, viewed through a BT.2408-correct HLG→SDR display).

## What is NOT the problem
1. **The renderer.** export-SSAA frame ≈ preview frame, pixel-for-pixel (slightly crisper if
   anything; full-frame LapVar ~0.83× = SSAA correctly attenuating aliased background detail).
   The raw map the export feeds FFmpeg is good. Renderer fully exonerated.
2. **SSAA gamma-space downsample** (browser `drawImage` averages in sRGB-gamma, not linear).
   Technically incorrect, but negligible for this content: line-core saturation identical,
   dark-text contrast within ~2 DN, global HF-energy ratio 0.995.
3. **Hue.** Decoration hues are preserved end-to-end (lime 72°, cyan 190°). No gamut rotation.

## Secondary, real, decoration-specific: 4:2:0 chroma-edge blur
4:2:0 (`yuv420p10le`, mandatory for consumer HEVC-main10 HDR delivery) does NOT hurt luma or
the broad map (whole-frame sRGB→420→sRGB PSNR 39), but it measurably **softens the saturated
lime/cyan decoration EDGES** — the agent measured chroma HF-energy −36% (LapVar B−G 97.8→62.4),
lime-line chroma edge width **doubling 1.41→2.97 px**, and cyan ring fringing, with luma LapVar
untouched (251→250). This is the user's "blurry edges," and it lands on exactly the high-chroma
decorations they're looking at. It is a delivery-path effect (preview is RGB on screen, so it
never shows there). **Magnitude ranking: off-color HLG ≫ 4:2:0 decoration-edge blur ≫ SSAA
gamma downsample (negligible).** 4:2:0 can't be dropped for consumer HDR; mitigation (if wanted)
is decoration-side (slightly wider/softer decoration edges, or a high-quality linear-light
chroma downscale) — separate from the dominant color fix below.
**[Session 2 — pipeline-side mitigation MEASURED (see "Measured levers" below): a high-quality
4:4:4→4:2:0 split recovers ~25% of the doubled edge width, for free. The "linear-light downscale"
framing was partly wrong — the probe shows zimg already fuses the decimation in one step in the
HLG-encoded signal, no swscale auto-inserted. The remaining ~75% is intrinsic to 4:2:0. The
decoration-SIDE mitigation (giving the edge luma contrast) is DEFERRED — a later design exploration,
deliberately not specified here.]**

## Root cause — SDR→HLG reference-white is wrong
The map is sRGB graphics. The pipeline converts it to HLG by treating it as **scene-linear
light** with the default (no-`npl`) HLG finishing
(`zscale=t=arib-std-b67:m=bt2020nc:p=bt2020:r=limited`). This lands SDR/graphics **white at
~62% HLG signal (measured 158/255)** instead of the **BT.2408 HDR reference white of 75% =
203 nits**. On a compliant HLG display the whole map is rendered **~24-25% too dark / dull**,
and dimmer than the surrounding HDR video (whose diffuse white sits at the 203-nit reference).

The round-trip is *reversible* (forward + exact inverse recovers the source, bg `f8f4f0`→`f9f5f1`),
so **no data is lost** — the defect is purely the display-referred level the map is encoded at.

### Measured (viewed through BT.2408-correct HLG→SDR, npl=203)
| | preview | CURRENT export | FIX (npl=203) |
|---|---|---|---|
| PSNR vs preview | — | **12.1 dB** | **34.8 dB** |
| SSIM vs preview | — | 0.935 | **0.984** |
| Lime trail brightness (HSV V) | 94% | **69%** | 94% |
| Cyan waypoint brightness (V) | 88% | **64%** | 87% |

Consistent across t=2000/8000/14000 (baseline ~12.1, fix ~34.8 every frame).

## Confirmed in the real composite (map beside the actual HLG video)
Built true 3840×2160 HLG composites (video slot via npl=400 ingest + map slot, tiled at the
x=2624 seam, libx265 main10), viewed through the BT.2408 display:

| region | HLG signal | SDR-view luma |
|---|---|---|
| video diffuse white | 70.4% (p90 73.6%) | 226 |
| **baseline** map white | **61–63%** | 179–186 (never reaches paper-white) |
| **fix** map white | **73.5%** | 247 |

The HDR **video's** diffuse white already sits at the ~75%/203-nit reference. The baseline map
white is **40 SDR-levels darker than the video beside it** — a dull grey strip across the seam.
The fix lands map white at 73.5%, within ~3 points of the video, so graphics white reads as
proper HDR reference white and the seam is coherent.

## The fix
Convert the SDR map to HLG anchored to **BT.2408 reference white (203 nits)** so SDR white →
75% HLG, matching the HDR video's diffuse white. In the spike this is `npl=203` on the
linear→HLG step:

```
# map: sRGB → BT.2020 display-linear, then HLG OETF referenced to 203-nit graphics white
zscale=pin=bt709:tin=iec61966-2-1:min=gbr:rin=full:p=bt2020:t=linear:m=bt2020nc:r=full,
zscale=t=arib-std-b67:r=tv:npl=203
```
(vs current: ingest to working-space linear, then `zscale=t=arib-std-b67:...` with no npl.)

npl sweep confirmed 203 is the optimum (white→74%): npl100→PSNR12, **npl203→PSNR35**,
npl300→24, npl1000→18.

## Application to the app (no code changed here)
The SDR-graphics→HLG hop in the **map ingest / HLG finishing** (`util/color.rs`,
`util/color_space.rs`, `export/filtergraph.rs`) must place SDR/graphics white at the BT.2408
reference (203 nits / 75% HLG), not at scene-linear 1.0. This is a per-target concern: it
only applies when an SDR source (the map; also any SDR title/overlay) is composited into an
HDR (HLG/PQ) delivery. SDR delivery targets are unaffected (the map already matches there).
Open question for implementation: do it as an explicit SDR→HLG reference-white scale on the
map branch, or fold a `npl`/peak parameter into the working-space→HDR finishing for SDR-origin
inputs. The PQ target needs the analogous 203-nit anchoring.

## Why the leftmost (preview) panel still looks best — even after the fix
Important and correct observation. The fix closes the **big** gap (brightness: PSNR 12→35), but
the preview is RGB-on-screen and is the visual *ceiling*; the HDR export has **irreducible
delivery-path costs** the preview never pays:
1. **4:2:0 chroma-edge softening** on the saturated lime/cyan decorations (see section above) —
   the fix is still `yuv420p10le`, so decoration edges are slightly softer than the preview's.
2. **Slight desaturation from the BT.2020 limited-range 10-bit round-trip** — measured at the
   decorations: lime S 55%→47%, cyan S 29%→26% (present in BOTH baseline and fix, ~equal, so it
   is NOT the dark-map bug — it's a separate, smaller residual). Hue is preserved; saturation
   dips a few points.
3. **HLG quantization / tone** vs pure sRGB.
So the fix reaches ~preview *brightness/contrast* parity (the dominant defect) but not pixel-
perfect parity. The residual softness + minor desaturation is what the eye reads as "left still
looks a bit better." Whether to chase those residuals (4:2:0 mitigation, saturation
compensation) is an open design call — they are far smaller than the brightness bug.

**Caveat on all "views":** every comparison decodes the HLG export through a *BT.2408-correct
HLG→SDR display model* (npl=203). On a real HDR display the absolute look depends on that
display's own HLG handling; the model is a faithful but approximate stand-in. Worth grounding
against an actual HDR-display playback in the deeper session.

## Measured levers (Session 2) — HQ chroma subsample + PQ verification
Three isolated spike experiments, each in its own `.spike/lever_*/` dir with reference white held
at npl=203 so each isolates ONE variable. All ran real FFmpeg incl. libx265 main10; metrics reuse
the `validate/` LapVar + edge-width code and the `ff.sh` BT.2408 HLG→SDR view model.

### Lever 1 — chroma-subsample quality (pipeline-side). Modest, free. → `lever_subsample/`
**Probe (verbose/debug — corrected a prior assumption):** in the real finishing chain
`…,zscale=t=arib-std-b67:m=bt2020nc:p=bt2020:r=limited,format=yuv420p10le`, **zimg itself fuses
the matrix + 4:2:0 decimation in one step — FFmpeg does NOT auto-insert a swscale**, and the
trailing `format=yuv420p10le` is a no-op. So the chroma averaging happens in the **HLG-encoded
non-linear YCbCr signal** (post-OETF, post-matrix), with zimg's default bicubic + left/MPEG-2 siting.

**Best candidate (C2_sws_hq)** — split the fused step so zimg matrices to full-res 4:4:4 and a
high-quality swscale owns the 444→420 decimation:
```
zscale=t=arib-std-b67:m=bt2020nc:p=bt2020:r=limited,format=yuv444p10le,scale=flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp,format=yuv420p10le
```
Measured vs current: lime chroma edge-width 6.22→5.29 px (**recovers ~25% of the subsample-
attributable blur**), chroma-HF B−G +16%, cyan fringing 55→82 (toward the 120 4:4:4 ceiling),
PSNR-vs-4:4:4-ideal 43.40→44.22 dB, **luma untouched**. Survives real libx265 main10 (+14–26%
chroma-HF). No perf/codec cost — a free quality win. **Ceiling:** a better filter recovers only
~25%; the remaining ~75% of the doubled edge width is **intrinsic to 4:2:0 half-res chroma** and
only erasable by not subsampling (off the table for consumer HEVC main10). Linear-light decimation
(libplacebo) couldn't be measured — no Vulkan on this Mac — and is bounded by the same ~25% ceiling.

### Lever 2 — decoration-side edge crispness. DEFERRED (design exploration for later).
The residual 4:2:0 decoration-edge softness is real (see "Secondary" section above), and the
mechanism is understood: the decorations are high-chroma / low-luma-contrast edges, and 4:2:0 keeps
luma at full res but chroma at half res — so the fix is to give the edge LUMA contrast (the way
broadcast graphics stay crisp). Spike prototypes of a hard luma keyline and a soft dark outer-glow
were built and scored (`lever_keyline/`), but **both were set aside on aesthetics** — the look
wasn't good enough. **This lever is intentionally left as an open DESIGN problem for a later
session/owner; no decoration-side approach is prescribed here.** The pipeline-side Lever 1 (above)
already recovers ~25% of the edge softness for free and is independent of whatever decoration
treatment is eventually chosen.

### Lever 3 — PQ / HDR10 reference-white. Same bug, verified. ✅ → `lever_pq/`
The PQ (`HdrPq`) target has the identical dark-map bug; fix is the direct PQ analog of npl=203 —
`:npl=203` added to the existing single step (unlike HLG, no ingest restructuring):
```
zscale=t=smpte2084:m=bt2020nc:p=bt2020:r=limited:npl=203,format=yuv420p10le
```
Map white (cream `#f8f4f0`) moves ~92 nits (PQ signal 0.500) → ~188 nits (signal 0.572, at the
BT.2408 reference). PSNR vs preview **12.17→34.78 dB**, SSIM 0.930→0.981, lime V 69→94%, cyan V
63→86%. npl=203 optimal (same sweep curve as HLG). **PQ caveat:** 203 nits = PQ signal **0.58**,
NOT HLG's 75% — anchor on the *nit* target via npl, never reuse HLG's signal number. The HLG fix
does not cover PQ; finishing is per-target.

## Open threads for the deeper conversation
- **VERIFIED — PQ target:** `:npl=203` on the `smpte2084` finishing step (Lever 3).
- **VERIFIED — pipeline-side 4:2:0 mitigation:** HQ subsample split (Lever 1), free ~25%.
- **DEFERRED — decoration-side edge crispness:** the luma-contrast approach (keyline / soft glow)
  is left as an open design problem for a later session/owner; spike prototypes were set aside on
  aesthetics. Not prescribed here.
- **How close should the HDR export get to the preview?** Brightness fixed (npl=203). Remaining
  residuals: (a) decoration-edge softness (decoration-side, deferred above); (b) ~5–8 pt decoration
  **desaturation** from the BT.2020 limited 10-bit round-trip (present equally in base + fix, both
  HLG and PQ — NOT the dark-map bug). Open call: chase the desat (saturation compensation) or accept
  as HDR delivery cost.
- **Where exactly the fixes live in the color-axes registry** (implementation, both HLG + PQ):
  explicit SDR→HDR reference-white scale on the map/overlay branch, vs an `npl`/peak parameter on
  the working→HDR finishing for SDR-origin inputs. Must compose with per-clip override + project
  working space (schema v9). The subsample split (Lever 1) lands in `delivery_finishing_filter`.
- **Validate against a real HDR-display playback**, not only the BT.2408 view model (applies to all
  three levers — the view model is faithful but approximate).

## Reproduce / continue in a fresh session
Prereqs present on this machine: node 22, ffmpeg 8 (zscale+libx265+libplacebo), Chrome-for-
Testing at `src-tauri/binaries/chrome-aarch64-apple-darwin/...`, puppeteer-core, pngjs.
```
cd /Users/personal/Documents/trail-cut
node .spike/prep.mjs                       # rebuild base_payload.json from Abel's bundle
node .spike/render.mjs preview 2000,8000,14000
node .spike/render.mjs export  2000,8000,14000
bash .spike/ff.sh                          # decomposition (E1 full / E2 color / E3 subsample / E4 roundtrip)
bash .spike/score.sh <name> "<forward_chain>"   # score a candidate SDR->HLG chain
node .spike/hue.mjs                         # decoration hue/brightness sampling
```
Real HLG source video for composite tests: `/Users/personal/Downloads/trail-vids/IMG_1137.MOV`.
Project bundle: `/Users/personal/Downloads/Abel's Hike.trailcut` (schema v9, 1 clip, 16:9 split).

## Artifacts
- `out/preview/f*.png`, `out/export/f*.png` — renderer frames (preview-equiv vs export-SSAA)
- `cand/base_8000_v.png` (current export, dark) vs `cand/fix_8000_v.png` (fix) vs preview
- `triptych_8000.png`, `zoom_8000.png` — side-by-side preview | current | fix
- `validate/out/*` — blur agent: `cmp_*`, `t2_*` (gamma vs linear), `t3_*` (4:4:4 vs 4:2:0)
- `validate/{view,seam}_{baseline,fix}.png` — composite agent: real map+video seam coherence
- Harness scripts: `prep.mjs`, `render.mjs`, `ff.sh`, `score.sh`, `hue.mjs`
- **Session 2 levers** (each self-contained, with its own `RESULT.md` + scripts + encodes):
  - `lever_subsample/` — chroma-subsample probe + candidate scoring (C2_sws_hq recommended) [KEEP]
  - `lever_pq/` — PQ 203-nit anchoring verification (`cand/`, `score_pq.sh`, `hue_pq.mjs`) [KEEP]
  - `lever_keyline/` — decoration luma-contrast prototypes (keyline + soft glow). DEFERRED /
    exploratory; both set aside on aesthetics. Retained for reference only, not a recommendation.
- Project memory: `project_hdr_map_reference_white.md`, `project_decoration_crispness_levers.md`
