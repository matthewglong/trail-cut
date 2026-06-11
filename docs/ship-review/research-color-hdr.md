# Research Receipt — SDR Graphics over HDR Video: Color Math, FFmpeg Tooling, Compositing Strategy

**Date:** 2026-06-11
**Task:** Ship-review research on (1) BT.2408-correct SDR-graphics-onto-HDR compositing, (2) zscale vs libplacebo in 2025–2026, (3) overlay pixel-format strategy, (4) what pro pipelines (Resolve/Nuke) do, (5) whether Rust filtergraph-string building is architecturally sound.
**Inputs read:** `PIPELINE_DECISIONS.md`, `COLOR_PIPELINE_SPEC.md`, `src-tauri/src/util/color_space.rs`, `src-tauri/src/export/delivery.rs`, `src-tauri/src/export/filtergraph.rs`, `src-tauri/src/export/clip_chain.rs`, `src-tauri/src/util/color.rs`, plus the web sources cited inline. The full text of ITU-R Report BT.2408-7 was downloaded and read (pdftotext), not paraphrased from secondary sources.
**Empirical tests run on this machine:** local FFmpeg build inspection; a live `vf_libplacebo` invocation (failed — see §4.4).

---

## 0. TrailCut's current pipeline state (baseline facts, with file:line)

These are the code facts every finding below is anchored against.

- **Working space:** linear-light BT.2020 RGB float, `gbrpf32le` (no alpha) — `src-tauri/src/util/color_space.rs:178-184` (`ColorSpace::WORKING`), `:256-258` (`working_pix_fmt` = `"gbrpf32le"`).
- **HDR ingest anchors:** HLG ingested with `npl=400`, PQ with `npl=1000` — `color_space.rs:205-221` (`HDR_HLG_BT2020` npl `Some(400)`, `HDR_PQ_BT2020` npl `Some(1000)`), `:331-338` (`default_npl_for`). Tests pin the strings: `color.rs:849-859`.
- **Map ingest:** sRGB full-range RGBA rawvideo → linear working space, **no npl, no gain** — `color_space.rs:287-299` (map form of `ingest_zscale_chain`), `util/color.rs:458-468` (`map_ingest_filter`).
- **Delivery:** `delivery_zscale_chain` intentionally emits **no `npl`** (`color_space.rs:317-329`, test `delivery_never_emits_npl` at `:477-483`); `delivery_finishing_filter` is registry-generated (`src-tauri/src/export/delivery.rs:175-184`). HLG delivery string: `zscale=t=arib-std-b67:m=bt2020nc:p=bt2020:r=limited` (test at `color_space.rs:457-464`).
- **Compositing:** all overlays run in working space, but FFmpeg's `overlay` cannot consume float, so both sides round-trip through `yuva444p10le` (`src-tauri/src/export/filtergraph.rs:339`, `:442-457`, `:673-712`). `format=auto` was removed from overlay calls because inputs are pre-normalized (`filtergraph.rs:657-660`).
- **No tone mapping exists in the export path.** `grep -rn "tonemap|2446|hable" src/export/` → zero non-test hits; tonemapping (Hable) exists only in proxy/thumbnail code (`src-tauri/src/commands/ffmpeg.rs:96-115`). `COLOR_PIPELINE_SPEC.md:55-58` *specifies* a `ToneMap` (BT.2446 Method A) LinearLightOperator, but it is unimplemented in `src/export/`.
- Decision ledger: spline36 chroma kernel ACCEPTED, error-diffusion dither DEFERRED (`PIPELINE_DECISIONS.md:15-27`); overlay default-format trap is C2 (`PIPELINE_DECISIONS.md:64-65`).

---

## 1. The professionally correct way to composite SDR graphics onto HDR (ITU-R BT.2408)

Source: **Report ITU-R BT.2408-7 (2023), "Guidance for operational practices in HDR television production"** — https://www.itu.int/dms_pub/itu-r/opb/rep/R-REP-BT.2408-7-2023-PDF-E.pdf (full text extracted and quoted below).

### 1.1 HDR Reference White and Graphics White (§2.1, Table 1)

> "The reference level, HDR Reference White, is defined in this Report as the nominal signal level obtained from an HDR camera and a 100% reflectance white card resulting in a nominal luminance of **203 cd/m² on a PQ display or on an HLG display that has a nominal peak luminance capability of 1 000 cd/m²**." — BT.2408-7 §2.1

> "**Graphics White** is defined within the scope of this Report as the equivalent in the graphics domain of a 100% reflectance white card: the signal level of a flat, white element without any specular highlights within a graphic element. **It therefore has the same signal level as HDR Reference White, and graphics should be inserted based on this level.**" — BT.2408-7 §2.1

Table 1 nominal signal levels (PQ reference display / 1000 cd/m² HLG display):

| Reference | Nominal luminance | %PQ | %HLG |
|---|---|---|---|
| 18% grey card | 26 cd/m² | 38 | 38 |
| HDR Reference White / diffuse white / **Graphics White** (100%) | **203 cd/m²** | **58** | **75** |

Footnote (2) to Table 1: *"The signal level of 'HDR Reference White' is not directly related to the signal level of SDR 'peak white'."* — i.e. you do not map SDR 100% to HDR 100%.

### 1.2 The graphics rule itself (§5.6 — this is the load-bearing paragraph)

> "**SDR graphics should be directly mapped into the HDR signal at the 'Graphics White' signal level specified in Table 1 (75% HLG or 58% PQ)** to avoid them appearing too bright, and thus making the underlying video appear dull in comparison. **Where the desire is to maintain the colour branding of the SDR graphics, a display-light mapping should be used.** Where the desire is to match signage within the captured scene (in-vision signage; e.g. a score board at a sporting event), a scene-light mapping is usually preferred." — BT.2408-7 §5.6

For TrailCut: the map canvas is exactly "graphics whose colour branding must be preserved" (route colors, waypoint shapes, basemap palette) — **display-light mapping at Graphics White is the standard-mandated path**. The scene-light variant is only for graphics meant to look like physical objects in the scene.

### 1.3 Display-referred (display-light) vs scene-referred (scene-light) — §5.1

> "Display-referred mapping is used when the goal is to preserve the colours and relative tones seen on an SDR display, when the content is shown on an HDR display… Display-referred mappings are derived by applying the desired EOTF (Recommendation ITU-R BT.1886), scaling the displayed light signal to match the brightness of HDR content." — BT.2408-7 §5.1
>
> "Scene-referred mapping is used when the goal is to match the colours and relative tones of a native HDR and native SDR camera… based on the light falling on the camera sensor." — BT.2408-7 §5.1

The display-referred recipe (§5.1.1, Figures 5–6): SDR signal → **BT.1886 EOTF (E = E′^2.40)** → BT.709→BT.2020 primaries matrix (per BT.2087) → **linear scale so 100% SDR lands at ~203 cd/m²** (2.03× of the 100 cd/m² SDR display light) → optional OOTF "gamma" adjustment → HLG/PQ inverse EOTF.

Key numeric anchors from the report:

- **PQ:** §5.1.2 — `E′ = EOTF_PQ⁻¹[scaling × EOTF_BT.1886[V]]`, "Example: for scaling = 2.03, E′(V=1) = **0.58** and EOTF_PQ(E′(V=1)) = 203 cd/m²."
- **HLG:** §5.1.3.3 — gain for 100%SDR→75%HLG: `EOTF_HLG(0.75)/EOTF_SDR(1.0) = 0.265^1.2/1.0^2.4 = 0.203`.
- **HLG shortcut:** §5.1.3.4 — "By configuring the HLG inverse EOTF with a nominal peak luminance, L_W, of **392 cd/m²**, an input of 100 cd/m² from the SDR EOTF will directly deliver an HLG signal of 75% … without further scaling and gamma adjustment." (Normalized-signal scale factor **0.2546** allowing for the inverse-OOTF gamma of 1.03.)
- **OOTF appearance compensation:** §5.1.3.2 — "Subjective tests carried out by the BBC and ARIB independently have found that an OOTF adjustment of **1.15–1.16** works well to preserve the appearance of shadows and midtones of the native SDR content at 100 cd/m² while scaling the SDR nominal peak white to 203 cd/m²." This is *optional* — without it you get the "mimic SDR shown on a 203 cd/m² BT.1886 display" behavior (§5.1.1 bullet 1), which is what consumer displays do in practice ("MovieLabs has found that linear scaling provides a good match to the way consumer displays scale SDR content", §5.1.2).

### 1.4 HLG vs PQ differences that matter here

- **PQ is absolute (display-referred by definition):** "For PQ, the nominal luminance values are consistent on PQ reference displays" (§2.2). 203 cd/m² is always PQ signal 58%.
- **HLG is relative (scene-referred system):** "For HLG, the nominal luminance values will differ from those in Table 1 when the display's peak luminance is lower or higher than 1 000 cd/m². **The nominal signal levels in Table 1 do not change.**" (§2.2). So the target is *signal level 75%*, computed against the nominal 1000 cd/m² display; an end-user 600-nit HLG TV will show graphics white at ~higher relative level automatically — that is HLG working as designed, not an error.
- Where the anchor is applied: in both systems the anchor is applied **in display light** (after BT.1886 EOTF, before the HDR inverse EOTF). For HLG the inverse EOTF includes the inverse OOTF (BT.2100 display model at nominal 1000 cd/m²); for PQ it is the pure PQ inverse EOTF. The 8-bit caveat (§5.5): "The up-mapping process typically expands the SDR highlights. The 8-bit resolution… will limit the amount of highlight expansion that can be applied before banding and other artefacts become visible" — direct mapping (no expansion) avoids this entirely, which is another reason §5.6 prescribes direct mapping for graphics.
- One practice note (not in the standard): colorists report graphics at the full 203 nits can overpower *dark* scenes; theatrical content often grades diffuse white nearer 80–100 nits ([Daejeon Chronicles, "HDR Reference White"](https://daejeonchronicles.com/2021/02/13/hdr-reference-white/)). For a map occupying a large slot over mixed outdoor footage, 75%HLG is the right default; a user-facing "graphics brightness" trim would be a legitimate creative control, *below* not above 75%.

### 1.5 Verification of the internal "npl=203" finding — correct, with one critical trap

**zimg's npl semantics** (the authority for what `zscale=...:npl=` means), from [`zimg.h`](https://github.com/sekrit-twc/zimg/blob/master/src/zimg/api/zimg.h):

> "Nominal peak luminance (cd/m²) for standard-dynamic range (SDR) systems. When a high dynamic range (HDR) transfer function is converted to linear light, the linear values are scaled such that nominal white (L = 1.0) matches the nominal SDR luminance. The HDR component of the signal is represented as multiples of the SDR luminance (L > 1.0)." Default "NAN, which is interpreted as 100 cd/m²."

So `npl` is **the definition of what linear 1.0 means in nits**, applied at every HDR transfer encode/decode. zimg's HLG path is display-referred against a 1000 cd/m² nominal display (scaling `peak_luminance/1000` in [`gamma.cpp`](https://github.com/sekrit-twc/zimg/blob/master/src/zimg/colorspace/gamma.cpp); cf. [zimg issue #71](https://github.com/sekrit-twc/zimg/issues/71) for the scene/display-referred history).

**The math checks out exactly:**

- Current bug (delivery without npl ⇒ default 100): map white L=1.0 → 100 cd/m² → display fraction 0.1 → inverse OOTF 0.1^(1/1.2)=0.147 → HLG OETF ≈ **0.63 signal (≈62–63% HLG)** — matches the observed "dark map" (62%).
- With `npl=203` on the linear→HLG encode: L=1.0 → 203 cd/m² → 0.203^(1/1.2)=0.265 → HLG OETF(0.265) = 0.17883277·ln(12·0.265−0.28466892)+0.55991073 = **0.750** — exactly BT.2408's 75%HLG. For PQ, EOTF_PQ⁻¹(203) = **0.58**. Both match the internal empirical findings.

Note this is mathematically the same operation as BT.2408 §5.1.3.4's L_W=392 trick — both are "re-declare what linear 1.0 means so 100 cd/m² SDR white lands at 75%HLG"; zimg parameterizes by SDR white (203), BT.2100 Note 5e parameterizes by display peak (392). One deliberate deviation remains: zscale linearizes the map with the sRGB EOTF (`tin=iec61966-2-1`) and SDR clips with the BT.709 inverse OETF (`tin=bt709`, a scene-light decode, γ≈2.0) rather than BT.2408's BT.1886 γ2.4 display decode — that is decision A2's residual (`PIPELINE_DECISIONS.md:29`) and changes midtone weighting, not the white anchor.

**⚠️ The trap: npl is a global working-space anchor, not a per-stream knob.** Because zimg applies npl at *every* HDR transfer boundary, the ingest npl and delivery npl must describe the *same* linear scale or streams get silently re-gained:

- Today: HLG camera ingest `npl=400` (`color_space.rs:211`) means camera linear is "nits/400". If delivery alone is changed to `npl=203`, the encode treats linear as "nits/203" — **camera footage is darkened by 203/400 ≈ 0.51×** (camera reference white 75%HLG would round-trip out at ≈63%HLG: the current map bug, inverted onto the video).
- The coherent fix: pick **one working-space anchor — L=1.0 ≡ 203 cd/m² (HDR Reference White)** — and use `npl=203` at *both* HDR ingest and HDR delivery (HLG and PQ alike). Then: HLG/PQ camera footage round-trips bit-stable (the npl cancels); the sRGB map's natural white (linear 1.0) lands at 203 cd/m² = 75%HLG/58%PQ **with zero extra gain nodes**; SDR clip white (linear 1.0) gets the BT.2408 §5.1.1 direct mapping for free; and `COLOR_PIPELINE_SPEC.md:58`'s "colorimetric lift is identity in linear" claim becomes *true at the right level* (today it is identity at the *wrong* level — SDR content would sit at 100% HLG-display white, i.e. too dark relative to nothing/nothing, since delivery default npl=100 maps it to 63%).
- **Interaction that must ship together:** with ingest npl=203, an HLG camera's 1000-nit highlights become linear ≈4.93 (vs ≈2.5 at npl=400). The SDR delivery chain (`zscale=t=bt709…`, no tone map — §0) hard-clips L>1.0, so highlight clipping on SDR targets gets *worse* unless the spec'd BT.2446-A `ToneMap` operator (`COLOR_PIPELINE_SPEC.md:56`; [Report ITU-R BT.2446-1](https://www.itu.int/dms_pub/itu-r/opb/rep/R-REP-BT.2446-1-2021-PDF-E.pdf)) lands in the same change. The npl=203 anchoring and HDR→SDR tone mapping are one coupled work item, not two.

---

## 2. zscale (zimg) vs libplacebo in 2025–2026

### 2.1 zscale/zimg — what it is and its limits

- CPU, deterministic, bit-stable across machines; the basis of TrailCut's snapshot-tested string generation (`color_space.rs` tests; `COLOR_PIPELINE_SPEC.md` §5 performance contract).
- Options relevant here ([FFmpeg zscale docs](https://ffmpeg.org/ffmpeg-filters.html#zscale-1), enumerated via the [8.0 filter docs mirror](https://ayosec.github.io/ffmpeg-filters-docs/8.0/Filters/Video/zscale.html)): dither `d=` ∈ {none, ordered, random, **error_diffusion**}; resample kernel `f=` ∈ {point, bilinear, bicubic, spline16, **spline36**, lanczos} (confirms decision A1-kernel is expressible exactly where intended); `npl` ("Set the nominal peak luminance"); full primaries/transfer/matrix/range/chroma-siting control.
- **No tone-mapping operator.** zscale only converts; HDR→SDR compression must be done by a separate filter (FFmpeg `tonemap`, CPU float, static curves only — no dynamic peak detection, no ST.2094 metadata) or a custom linear-light stage. This is why TrailCut's export path currently clips instead of tone mapping (§0).
- **No gamut-mapping beyond clipping** at the primaries matrix (out-of-gamut after BT.2020→BT.709 is clipped per channel; no perceptual/soft-clip options).
- Known sharp edge already hit by TrailCut: rawvideo without explicit source tags fails graph planning with error 3074 (`color_space.rs:268-272` documents this) — a *good* loud failure.

### 2.2 libplacebo — what it adds

[libplacebo](https://github.com/haasn/libplacebo) is the GPU color/render core extracted from mpv, exposed in FFmpeg as `vf_libplacebo` ([FFmpeg docs](https://ffmpeg.org/ffmpeg-filters.html#libplacebo); [option enumeration](https://ayosec.github.io/ffmpeg-filters-docs/8.0/Filters/Video/libplacebo.html); [libplacebo options reference](https://libplacebo.org/options/)):

- **Tone mapping:** `tonemapping` ∈ {auto, clip, **st2094-40, st2094-10, bt.2390, bt.2446a**, spline (default), reinhard, mobius, hable, gamma, linear} with **dynamic peak detection** (`peak_detect`). This includes the exact ITU operators TrailCut's spec names (BT.2446-A) plus HDR10+ dynamic metadata curves.
- **Gamut mapping:** `gamut_mode` ∈ {clip, **perceptual (default)**, relative, saturation, absolute, desaturate, darken, warn, linear} — "perceptual performs a perceptually balanced gamut mapping using a soft knee function to preserve in-gamut colors, followed by a final softclip" (libplacebo docs). zscale has nothing comparable.
- **Dithering:** `dithering` ∈ {none, **blue (default, pseudo-blue noise)**, ordered, ordered_fixed, white}; the docs recommend leaving it on whenever rendering below 16-bit ("not doing so may result in visible banding").
- **BT.2408 is built in.** libplacebo hardcodes `PL_COLOR_SDR_WHITE = 203.0f` ("defines the reference white level… in cd/m²", [colorspace.h](https://github.com/haasn/libplacebo/blob/master/src/include/libplacebo/colorspace.h)); mpv adopted this in commit ["vo_gpu: reinterpret SDR white levels based on ITU-R BT.2408"](https://git.furworks.de/opensourcemirror/mpv/commit/ef6bc8504a945eb6492b8ed46fd5a1afaaf32182). I.e. the entire SDR-graphics-at-203-nits question that TrailCut had to discover empirically is libplacebo's *default* behavior for SDR↔HDR placement.
- **Multi-input compositing:** the `inputs` option "can be used, alongside the `idx` variable, to allow placing/blending multiple inputs inside the output frame" with per-input `crop_*`/`pos_*` — a single filter that converts each input from its own tagged space and composites, replacing the zscale→format→overlay→format chains. (One filter invocation = no FFmpeg auto-inserted scalers between stages.)
- Single-pass: decode→linearize→gamut→tone-map→dither happens inside one GPU pass instead of N CPU filter hops; community benchmarks consistently show large throughput wins over zscale+tonemap (e.g. [32blog tonemapping guide](https://32blog.com/en/ffmpeg/ffmpeg-hdr-to-sdr-tonemapping)).

### 2.3 libplacebo pitfalls — including a live failure on this machine

- **Vulkan requirement.** `vf_libplacebo` is Vulkan-based. On macOS that means **MoltenVK** (officially supported: "libplacebo currently supports Vulkan (including MoltenVK)" — [README](https://github.com/haasn/libplacebo); [issue #111](https://github.com/haasn/libplacebo/issues/111) is the original MoltenVK bring-up).
- **Empirical (2026-06-11, this machine):** Homebrew `ffmpeg-full` 8.1.1 is built `--enable-libplacebo --enable-libzimg`, but running
  `ffmpeg -f lavfi -i color=red:size=64x64 -vf "libplacebo=color_trc=arib-std-b67:format=yuv420p10le" -f null -`
  fails: `Failed creating instance: VK_ERROR_INCOMPATIBLE_DRIVER … Failed creating Vulkan device!`. Cause: `vulkan-loader` is installed but **no MoltenVK ICD** (`/opt/homebrew/share/vulkan/icd.d/` is empty; `molten-vk` not installed). Conclusion: shipping libplacebo to thousands of macOS users means **bundling the MoltenVK ICD + loader and wiring `VK_ICD_FILENAMES`/`VK_DRIVER_FILES` in the sidecar environment** — it does not work out of the box even on a dev machine with a libplacebo-enabled FFmpeg. (This folds into the existing "task 130" sidecar-bundling requirement; once TrailCut controls its own FFmpeg build, this is controllable.)
- **Determinism/testability:** output is GPU- and driver-dependent (and dithering is intentionally stochastic); TrailCut's byte-identical snapshot-string + golden-frame testing strategy would need tolerance-based image comparison instead of exact hashes.
- **macOS rendering-glitch reports exist** at the MoltenVK layer (e.g. [mpv #17258, gpu-next Vulkan glitches on macOS](https://github.com/mpv-player/mpv/issues/17258)) — unclear whether libplacebo or MoltenVK; risk is real but bounded (mpv ships this path to many Mac users).
- **No Vulkan video decode on macOS** ([mpv #11739](https://github.com/mpv-player/mpv/issues/11739)): frames must be uploaded/downloaded around the filter; fine for TrailCut's already-CPU pipeline, but the "60+ fps full-GPU pipeline" benchmarks from Linux/NVIDIA do not transfer to macOS.

### 2.4 Verdict for TrailCut

zscale remains the correct **ship-now** baseline: deterministic, CPU, already registry-generated, and the npl=203 fix is a two-line table change with exact-math verification. libplacebo is the correct **quality ceiling** (proper tone mapping, perceptual gamut mapping, blue-noise dithering, BT.2408 semantics native, single-pass comp) and should be evaluated *after* sidecar bundling exists, as a swap at the dispatcher/renderer layer (`COLOR_PIPELINE_SPEC.md` §10) — the spec's node taxonomy is engine-agnostic, which is exactly why the chain should stay typed (see §5).

---

## 3. Overlay compositing pixel-format strategy

### 3.1 The overlay-filter facts (verified against FFmpeg docs)

[FFmpeg `overlay` docs](https://ffmpeg.org/ffmpeg-filters.html#overlay-1) (option list confirmed via the [8.0 mirror](https://ayosec.github.io/ffmpeg-filters-docs/8.0/Filters/Video/overlay.html)):

- `format` ∈ {yuv420, yuv420p10, yuv422, yuv422p10, yuv444, yuv444p10, rgb, gbrp, auto}; **"Default: yuv420"** — 8-bit 4:2:0. This confirms internal finding C2: an unconfigured overlay silently destroys chroma resolution *and* bit depth. There is **no float and no 12/16-bit option**; `yuv444p10` / `gbrp` (8-bit!) is the ceiling.
- `alpha` ∈ {straight (default), premultiplied} — "Set format of alpha of the overlaid video".
- FFmpeg auto-inserts format-conversion `scale` filters between incompatible filter pads (visible only with `-loglevel verbose` as `auto_scale_N`) — which is why textual filtergraph review alone is insufficient (matches the project's established empirical-validation rule).

### 3.2 Correct strategy (what the literature mandates)

1. **Blend in linear light.** Alpha blending of gamma-encoded values is mathematically wrong light transport and produces hue shifts and dark fringes at anti-aliased edges — [GPU Gems 3, ch. 24 "The Importance of Being Linear" (NVIDIA)](https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-24-importance-being-linear). TrailCut already does this (overlays run in the linear working space — `filtergraph.rs:644-660`). This is the right call; do not regress it.
2. **Stay 4:4:4-or-better until the last possible moment; subsample exactly once, at delivery, with a good kernel.** Every 4:2:0 hop low-passes chroma; the decision A1-kernel (`spline36`, `PIPELINE_DECISIONS.md:24-27`) is the correct mitigation at the single legitimate subsample point. The current graph honors this (subsample only in `delivery_finishing_filter`).
3. **Premultiplied alpha for any filtered/resampled overlay.** Resampling or filtering a straight-alpha image mixes meaningless RGB from fully-transparent pixels into edge pixels (fringe halos). Pro compositors operate on premultiplied imagery in scene-linear; OCIO explicitly leaves premult state to the host ("OCIO… leaves that to the user — you can hand OCIO either premult or unpremult pixels" — [ocio-dev, "Thoughts on Alpha"](https://groups.google.com/g/ocio-dev/c/ZehKhUFqhjc)), and Nuke's convention is premultiplied comp in linear. FFmpeg has `premultiply`/`unpremultiply` filters and `overlay=alpha=premultiplied` to express either convention.
   **Open verification item for TrailCut:** the sidecar's `gl.readPixels` RGBA — WebGL canvases are typically configured premultiplied — versus the filtergraph's `alphamerge`/`overlay` path which defaults to *straight* alpha. A premultiplied-source-treated-as-straight error produces exactly the genre of artifact in the "decoration crispness" complaints (dark rims on anti-aliased route/marker edges). This should be settled with a 2× checker test frame, not assumed.
4. **Precision: 10-bit integer is marginal for *linear* intermediates.** TrailCut's float working space is correct, but the unavoidable `yuva444p10le` round-trip at each overlay (because `overlay` has no float support — `filtergraph.rs:673-712`) quantizes *linear* light to 1024 steps. Linear coding spends codes uniformly while perception is roughly logarithmic, so shadows get very few codes (this is the entire reason PQ/OETFs exist — see BT.2408-7 §5.5's warning about 8-bit headroom, and why EXR/ACES pipelines composite in half/full float). With dither DEFERRED (A1-dither), dark map areas crossing two such round-trips (PiP mask path) are the most banding-exposed surface in the pipeline. Mitigations, best-first: (a) a compositor that blends in float (libplacebo multi-input, §2.2; or `vf_libplacebo` used purely as the comp node), (b) keep 10-bit but enable dither at the final 4:2:0/8-bit hop, (c) verify with `-loglevel verbose` that no additional auto-inserted conversions ride along the yuva444p10le hops.

---

## 4. What professional pipelines do (and what FFmpeg can/can't replicate)

### 4.1 DaVinci Resolve

- Resolve has an explicit, named control for exactly TrailCut's problem: a **"203 nit support for SDR to HDR"** checkbox, "remapping SDR content to HDR by mapping 100 nits to 203 nits (defined as the diffuse white level)… This allows SDR whites to appear white, rather than gray, when compared to diffuse white in HDR" — [DaVinci Resolve 18 manual, "203 Nit Support for SDR to HDR"](https://www.steakunderwater.com/VFXPedia/__man/Resolve18-6/DaVinciResolve18_Manual_files/part297.htm). Independent confirmation of the same fix TrailCut derived ("whites appear gray" = the 62%HLG symptom).
- Colorist practice for graphics in HLG timelines: Color Space Transform with custom max output 203 nits ([Blackmagic forum, "Color Space Transform fixes HLG Diffuse White"](https://forum.blackmagicdesign.com/viewtopic.php?f=21&t=108801)). The Adobe ecosystem has the identical failure mode ("[Graphic White Levels Very Dark When Exported from HDR Project](https://community.adobe.com/questions-729/graphic-white-levels-very-dark-when-exported-from-hdr-project-1407306)") — this bug class is industry-universal, and TrailCut's diagnosis matches the industry fix.

### 4.2 Nuke-style comp (ACES/OCIO)

- Working space is **scene-linear float** (ACEScg under an ACES OCIO config: "Selecting an ACES config sets the working space to scene_linear (ACEScg)" — [Foundry, OCIO Color Management](https://learn.foundry.com/nuke/content/comp_environment/configuring_nuke/using_ocio_config_files.html)); all merges are premultiplied linear-light operations; SDR graphics are brought in through an inverse display transform (sRGB texture/Output-* inverse) and the HDR look is produced by the *output* display transform, never baked into the merge.
- Structurally TrailCut already mirrors this: decode-to-linear → composite → encode (the §1 ordering invariants in `COLOR_PIPELINE_SPEC.md` are the same invariants ACES enforces). The deltas are precision (float end-to-end vs the 10-bit overlay round-trip) and the missing reference-white anchor at the rendezvous.

### 4.3 What an FFmpeg pipeline can replicate

✅ Linear-light working space, BT.2020 primaries, per-stream IDT-style ingest, BT.2408 graphics anchoring (npl/gain), single terminal subsample with chosen kernel, static tone mapping (BT.2446-A as a filter chain or via libplacebo), correct VUI signaling.

### 4.4 What it cannot (or can only with libplacebo / custom GPU work)

❌ Float-precision *blending* (overlay caps at 10-bit int); dynamic/scene-adaptive tone mapping with peak detection; perceptual gamut mapping; ST.2094 dynamic metadata authoring; an interactive monitored grade (Resolve's human-in-the-loop trim is the one piece no batch pipeline replicates — TrailCut's equivalent guardrail is golden-frame tests against the preview).

---

## 5. Architecture: is Rust filtergraph-string building sound?

**Yes — conditionally, and TrailCut already satisfies most conditions.** Assessment:

1. **String-built CLI filtergraphs are the industry norm for FFmpeg-embedding products** (HandBrake, Shutter Encoder, countless render farms); the failure mode is not the strings, it is *untyped* strings. TrailCut's `color_space.rs` registry (axes → generated tokens, byte-equality tests at `color_space.rs:385-483`) plus the COLOR_PIPELINE_SPEC node taxonomy is precisely the "deep module" answer: the interface is `ColorSpace → ColorSpace`, the strings are an emission detail. Keep this; finish the dispatcher (spec grills 5–6) so `filtergraph.rs`'s remaining hand-spliced yuva444p10le hops also become emitted, validated nodes.
2. **Two systemic risks of the CLI approach, both already encountered:** (a) silent auto-inserted conversions (`auto_scale_N`) — mitigate by making the `-loglevel verbose` dry-run assertion a CI check, not a manual practice; (b) semantic parameters that *look* per-filter but are global contracts (npl — §1.5). The typed registry is the right place to enforce npl coherence (one `WORKING_NPL` constant consumed by both ingest and delivery emitters; a test asserting every emitted HDR `npl=` equals it).
3. **The pro-tool alternative (GPU node graph in float) maps onto three escalation options:**
   - *vf_libplacebo inside the existing CLI graph* — smallest step; replaces zscale+tonemap+overlay with one GPU node; blocked on bundling MoltenVK (§2.3 empirical failure) and on tolerance-based golden tests.
   - *libplacebo C API driven from Rust* (`pl_renderer`) — maximal control (per-input `pl_color_space`, true float comp, BT.2408 defaults), but adopts a GPU runtime into the Rust process and bypasses FFmpeg's mux/encode conveniences; only worth it if the sidecar-renderer architecture is revisited anyway.
   - *VapourSynth* — rejected for this product: drags a Python runtime into a consumer bundle.
4. **Recommendation:** do not abandon the filtergraph builder. The "soup" complaint is real where strings are hand-spliced (`filtergraph.rs` overlay plumbing), not where they're generated (`color_space.rs`). The cleanup direction the spec already defines (typed chain → coalescer → emitted string, snapshot-tested) is the same architecture a from-scratch rewrite would land on.

---

## 6. Consolidated corrections/confirmations of TrailCut's three internal findings

| Internal finding | Verdict | Detail |
|---|---|---|
| SDR graphics into HLG need npl=203 anchoring or render dark (62%) | **Confirmed, exact** — but incomplete | Math reproduces 62–63% (npl-default 100) and exactly 75% at npl=203 / 58%PQ (§1.5). **Must be applied as a coherent working-space anchor (ingest npl AND delivery npl = 203), not delivery-only, or HLG/PQ camera footage darkens by 203/400 (203/1000)**; couples with shipping BT.2446-A tone map for SDR targets. |
| FFmpeg overlay silently converts to yuv420 stripping chroma | **Confirmed** | `format` default is `yuv420` (8-bit 4:2:0) per FFmpeg docs (§3.1). Note overlay also has no float path — the 10-bit linear round-trip is its own (quieter) quality tax (§3.2.4). |
| zscale/libzimg required at ingest | **Confirmed as of today; libplacebo is the eventual upgrade** | swscale has no transfer-function awareness; zimg is the only correct CPU path in stock FFmpeg. libplacebo exceeds zimg on tone/gamut/dither quality and bakes in BT.2408 (PL_COLOR_SDR_WHITE=203) but empirically fails on this Mac without a bundled MoltenVK ICD (§2.3). |

---

## 7. Source index

**Standards / primary:**
- Report ITU-R BT.2408-7 (2023) — https://www.itu.int/dms_pub/itu-r/opb/rep/R-REP-BT.2408-7-2023-PDF-E.pdf (quoted §§2.1, 2.2, 5.1, 5.1.1–5.1.5, 5.5, 5.6, Table 1)
- Report ITU-R BT.2446-1 (2021), HDR↔SDR conversion methods — https://www.itu.int/dms_pub/itu-r/opb/rep/R-REP-BT.2446-1-2021-PDF-E.pdf

**FFmpeg / zimg / libplacebo:**
- FFmpeg filters documentation (overlay, zscale, libplacebo) — https://ffmpeg.org/ffmpeg-filters.html ; option enumerations via https://ayosec.github.io/ffmpeg-filters-docs/8.0/Filters/Video/{overlay,zscale,libplacebo}.html
- zimg API header (npl semantics) — https://github.com/sekrit-twc/zimg/blob/master/src/zimg/api/zimg.h ; gamma implementation — https://github.com/sekrit-twc/zimg/blob/master/src/zimg/colorspace/gamma.cpp ; HLG OOTF issue — https://github.com/sekrit-twc/zimg/issues/71
- libplacebo — https://github.com/haasn/libplacebo ; options — https://libplacebo.org/options/ ; PL_COLOR_SDR_WHITE — https://github.com/haasn/libplacebo/blob/master/src/include/libplacebo/colorspace.h ; MoltenVK bring-up — https://github.com/haasn/libplacebo/issues/111
- mpv BT.2408 adoption commit — https://git.furworks.de/opensourcemirror/mpv/commit/ef6bc8504a945eb6492b8ed46fd5a1afaaf32182 ; macOS Vulkan glitches — https://github.com/mpv-player/mpv/issues/17258 ; Vulkan decode FAQ — https://github.com/mpv-player/mpv/issues/11739

**Professional practice:**
- DaVinci Resolve 18 manual, "203 Nit Support for SDR to HDR" — https://www.steakunderwater.com/VFXPedia/__man/Resolve18-6/DaVinciResolve18_Manual_files/part297.htm
- Blackmagic forum, CST fixes HLG diffuse white — https://forum.blackmagicdesign.com/viewtopic.php?f=21&t=108801
- Adobe community, graphics dark in HDR export — https://community.adobe.com/questions-729/graphic-white-levels-very-dark-when-exported-from-hdr-project-1407306
- Foundry Nuke OCIO/ACES docs — https://learn.foundry.com/nuke/content/comp_environment/configuring_nuke/using_ocio_config_files.html
- ocio-dev "Thoughts on Alpha" — https://groups.google.com/g/ocio-dev/c/ZehKhUFqhjc
- GPU Gems 3 ch.24, "The Importance of Being Linear" — https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-24-importance-being-linear
- Daejeon Chronicles, "HDR Reference White" — https://daejeonchronicles.com/2021/02/13/hdr-reference-white/

**Empirical (this machine, 2026-06-11):** `ffmpeg-full` 8.1.1 (`--enable-libplacebo --enable-libzimg`); `vf_libplacebo` smoke test → `VK_ERROR_INCOMPATIBLE_DRIVER` (no MoltenVK ICD in `/opt/homebrew/share/vulkan/icd.d/`; `vulkan-loader` 1.4.350.0 present, `molten-vk` absent).
