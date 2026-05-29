# TrailCut Color Architecture: Can a Universal Working Space Serve Both Ultra-HDR and Low-Quality SDR?

## 1. TL;DR

Your instinct was partially right: a single universal working space cannot equally serve every input from a 12-bit ARRI LogC4 cinema master down to a mistagged 8-bit dashcam clip — and, importantly, no professional NLE actually pretends otherwise. Resolve, Premiere, Final Cut Pro, and Avid all operate in 32-bit float internally, but the working space itself is **per-project**, dispatched against the delivery target, with an explicit "passthrough / disable color management" mode for projects that want bit-for-bit honesty against their source. The correct architecture for TrailCut is therefore not "pick one universal space and live in it forever" but **adaptive dispatch on three axes**: input class (consumer Rec.709 / consumer HDR / camera-native log / wide-gamut cinema), delivery target (SDR vs HDR), and metadata confidence (well-tagged vs inference-required). One important refinement to the original framing: the working space primaries must be **widened beyond Rec.2020** — to ACEScg AP1 or DaVinci Wide Gamut Intermediate — for projects ingesting cinema log sources, because ARRI Wide Gamut 4, REDWideGamutRGB, Sony S-Gamut3.Cine, and Canon Cinema Gamut all exceed Rec.2020. Rec.2020 is a strict superset of every *delivery* target but not of every *acquisition* gamut. One unavoidable wrinkle: because TrailCut always composites a map over video, linear-light compositing is mandatory inside the operator regardless of project mode — "bit-pass a clip through untouched" is moot in the regions the map covers. The architecture below is what falls out of these constraints.

## 2. The Question, Restated Precisely

Before we can talk about working spaces, every term has to be defined atomically, because most of the contradictions in the public discourse around color management come from people using these words to mean different things.

**Pixel.** A tuple of numbers. By itself it means nothing. The interpretation requires a color space.

**Color space.** A triple of (primaries, transfer function, encoding range). Without all three, a pixel value cannot be turned into light.

**Primaries.** The chromaticities (xy coordinates on the CIE 1931 chromaticity diagram) of the red, green, and blue lights that, mixed at unit intensity, define the color volume. Rec.709 primaries cover roughly the sRGB gamut. Rec.2020 primaries cover a much larger volume. ACES AP0 covers more than the visible spectrum.

**Transfer function.** The nonlinear function that maps stored code values to light intensity (and vice versa). Two directions matter:
- **OETF** (Opto-Electrical Transfer Function): scene-light → code (what a camera does).
- **EOTF** (Electro-Optical Transfer Function): code → display-light (what a TV does).
Common transfer functions: Rec.709 / sRGB gamma (~2.2/2.4, SDR), PQ (SMPTE ST 2084, HDR, absolute brightness up to 10,000 nits), HLG (Hybrid Log-Gamma, HDR, relative scene-referred).

**Gamut.** The set of colors a given set of primaries can represent at a given intensity. Rec.2020 is a strict superset of Rec.709.

**Linear light.** Pixel values proportional to photons. This is the only domain where alpha blending, convolution (blur), resampling, and additive light math are physically correct. Compositing in gamma-encoded space produces the dark fringes and off-color edges you'd see on a map drawn over a video where the map renderer and the video are in different transfers.

**Scene-referred.** Pixel values represent scene radiance (what was in front of the camera). No display assumed. Unbounded.

**Display-referred.** Pixel values represent the light a specific display will emit. Bounded by that display's peak luminance and gamut.

**Working space.** The internal representation a tool uses while it performs operations (composite, resize, color correct). Properly chosen, it is scene-referred, linear-light, and wide-gamut, in 32-bit float.

**Chroma subsampling.** YCbCr formats like 4:2:0 store one chroma sample per 2×2 luma block. Converting YCbCr ↔ RGB always passes through a chroma upsampler/downsampler; the result depends on **chroma siting** (where the chroma sample sits inside the luma grid — MPEG-2 vs MPEG-1 vs co-sited) and on the filter used. Mismatched siting causes ±1 pixel color shifts. Well-tagged consumer HEVC carries siting in its VUI; cheap Android, dashcams, web-rips, and older devices routinely omit or mis-tag it. FFmpeg silently assumes BT.709 when color metadata is absent, which is wrong for SD content (which is BT.601) and for some pre-2017 mobile footage.

**Studio (legal/limited) vs full range.** Video YCbCr typically stores luma in code values 16–235 ("studio") not 0–255. Treating studio data as full range crushes blacks and clips whites. Premiere has historically gotten this wrong in mixed pipelines, per Larry Jordan's 2025 color update ([4]).

**HDR.** Delivery format with high peak luminance and wide gamut. The encodings that matter:
- **HLG** (Hybrid Log-Gamma, BT.2100): relative, scene-referred, backward-compatible with SDR displays. Used by broadcast HDR, Sony cameras (HLG capture modes on the FX line and Alpha mirrorless), iPhone (Dolby Vision Profile 8.4 base layer), and modern Android HDR capture (Pixel 7+, Samsung Galaxy S22+).
- **PQ** (Perceptual Quantizer, SMPTE ST 2084, BT.2100): absolute, display-referred. Used by HDR10, HDR10+, Dolby Vision Profile 5 (PQ only) and Profile 8.1 (PQ base + dynamic metadata), most streaming HDR, and cinema mastering.

**Camera-native log.** Not delivery formats. Acquisition log encodings that pro and prosumer cameras shoot in, designed to preserve dynamic range for grading: ARRI LogC3 / LogC4, RED Log3G10 (paired with REDWideGamutRGB under IPP2), Sony S-Log3 (paired with S-Gamut3.Cine or S-Gamut3), Canon CLog2 / CLog3 (paired with Cinema Gamut), Panasonic V-Log (paired with V-Gamut), Blackmagic Film Gen 5 (paired with Blackmagic Wide Gamut), GoPro Protune / GP-Log, DJI D-Log / D-Log-M. Each requires a camera-specific **Input Device Transform (IDT)** to convert log-encoded values to linear scene-referred light in a defined working space. The ACES IDT library ([26]) is the canonical source for these transforms.

**SDR.** Rec.709 primaries, Rec.709 gamma transfer, 8-bit per channel for delivery.

**ACES.** Academy Color Encoding System. A specific scene-referred working space (AP0 or AP1 primaries, linear, fp16/fp32) plus a specific viewing pipeline (RRT + ODT). Not just "linear-light fp32" — ACES bundles a creative look transform with the math.

**OCIO.** OpenColorIO. A library that lets a project author declare its own color transforms in a config file. It is plumbing, not a working space.

The question you posed, restated against the actual input spectrum TrailCut must support — pro cinema RAW (ARRIRAW LogC4, REDCODE Log3G10, Blackmagic BRAW, CinemaDNG), pro intermediate codecs (ProRes 422/4444/4444 XQ, DNxHR, Sony XAVC-I/HS/S) carrying wide-gamut log metadata, camera-native log on prosumer bodies (Sony FX-series S-Log3, Canon CLog2/3, Panasonic V-Log, Blackmagic Film Gen 5, GoPro Protune, DJI D-Log), consumer HDR (Dolby Vision iPhone, HDR10/HLG Android, GoPro HDR, DJI drone HDR), consumer Rec.709 (every smartphone in SDR mode, every action cam standard mode), and metadata-poor or mistagged output from cheap Androids, dashcams, web-rips, and older devices — can one universal internal working space deliver, at the same quality bar, "HDR-in visually identical HDR-out" and "low-quality SDR-in zero-loss SDR-out"? The short answer is no, and the rest of this report shows why and what to do instead.

## 3. What Pro NLEs Actually Do

The first piece of evidence: no shipping pro tool tries to do what the universal-space framing proposes. Every one of them dispatches per project.

**DaVinci Resolve.** Project settings include a "Color Science" menu (DaVinci YRGB, DaVinci YRGB Color Managed, DaVinci Wide Gamut Intermediate, ACEScct, ACEScc) and, for managed modes, a separate "Timeline Color Space" plus an "Output Color Space" — chosen per project, not per app ([Blackmagic Resolve manual on choosing a timeline color space, 2]). The unmanaged "YRGB" mode is an explicit passthrough: input clips are treated as already display-referred and no transform is applied. DaVinci Wide Gamut Intermediate exists specifically because Resolve's authors found Rec.2020/Rec.2100 not wide enough for some camera sources ([Blackmagic DWG Intermediate PDF, 13]).

**Adobe Premiere Pro.** The 2025 release introduced project-level color management with three modes: Disable Color Management (legacy / passthrough), Direct (no inverse-tone-mapping, preserves intent across SDR/HDR), and Auto Tone-map (creative inverse) — all chosen per sequence ([Adobe helpx color management options, 3], [Larry Jordan 2025 color update, 4]). The Direct mode is, in effect, an admission that auto-inverse-tone-mapping is creative-not-invertible, exactly per the BT.2446 framing below.

**Final Cut Pro.** Wide-gamut HDR is a library- and project-level toggle ([Apple FCP wide-gamut HDR docs, 1]). FCP offers explicit preset transforms named "SDR to 100% HDR (HLG)" and "SDR to 75% HDR (HLG)" — the existence of *two* presets for the same input direction is itself a confession that there is no single right answer for inverse tone-mapping; it is a creative knob.

**Avid Media Composer.** Defaults to a display-referred working model and supports per-project color spaces.

The pattern is consistent: 32-bit float internally, working space chosen per project, and a passthrough mode for users who do not want color management touching their data. This is the architectural shape TrailCut should adopt.

## 4. Why a Single Universal Space Cannot Equally Serve SDR and HDR

There are three independent reasons, each sufficient on its own. You don't have to accept all three to reach the same conclusion.

### 4a. Inverse tone-mapping is creative, not invertible

A round trip SDR → wide HDR working space → SDR requires, somewhere in the middle, a decision about what the SDR scene "would have looked like" if captured in HDR. ITU-R BT.2408 ([6]) and BT.2446 ([7]) — the reference documents on cross-format conversion — are explicit that this direction is an aesthetic choice: there is no scene physics to recover, only a curve fit. The fact that FCP ships *two* presets ("SDR to 100% HDR" and "SDR to 75% HDR", [1]) confirms this in product form, and Netflix's mastering guidance ([18]) explicitly recommends grading HDR first and trimming SDR from it, never the reverse. Any architecture that pushes SDR sources through an HDR transfer function and back out has performed a creative edit the user did not ask for, even if the math is "lossless float."

### 4b. Wide-gamut stretches nothing for already-Rec.709 sources

A Rec.709 source contains, by construction, no colors outside the Rec.709 gamut. Re-encoding it through Rec.2020 primaries gains nothing for that clip — the new bits at the edges of the wider gamut are zero. What it does buy is several opportunities for negative-component artifacts when wide-gamut intermediates are not gamut-compressed before being squeezed back into Rec.709 ([ACES Reference Gamut Compression, 15]; Stu Maschwitz's account of inverse-ODT fragility, [Prolost on ACES, 16]). It also incurs the "no-op tax" — each transform quantizes and propagates ±1-LSB drift, banding risk in shadow rolloff, and the chroma-subsampling round-trip losses ([Glenn Chan on chroma, 20]).

### 4c. The codec boundary is non-bijective for lossy formats

Even before color science enters the picture, the encoder/decoder pair for H.264 and HEVC is lossy. Adobe's own Smart Rendering documentation ([19]) calls out that smart-render (stream copy without re-encode) is not supported for H.264 in the typical TrailCut case, and stream-copy via FFmpeg's `-c copy` works only at GOP boundaries. TrailCut composites a map over the video on every export, so stream copy in the touched region is impossible. The codec round-trip is then unavoidable, and with it: chroma siting drift if filters aren't matched ([20]), studio/full-range scaling bugs ([thepostprocess on levels, 21]), and a small generation loss every encode. These are codec-level issues, not working-space-level ones — no choice of internal float buffer can fix them.

Taken together, these three reasons say: the cost of running a Rec.709 SDR source through a single universal HDR-wide working space is real and additive. Float precision makes it small. Proper dither makes it smaller. It is not zero, and on low-bitrate sources it can be visible.

## 5. The Load-Bearing Distinction: Primaries vs Transfer Function

This is the single most important conceptual fix in this report, and it dissolves most of the apparent contradiction. The "universal working space" question conflates two independent choices:

1. **Which primaries does the working space use?**
2. **Which transfer function does the working space use?**

These costs are not symmetric.

**Routing SDR through Rec.2020 primaries is free.** Rec.2020's gamut is a strict superset of Rec.709's. The conversion is a single 3×3 matrix in linear light. It is reversible to machine precision in fp32. No clipping occurs because no Rec.709 value can land outside the Rec.2020 gamut. This is just changing the basis vectors of the color space, not the data.

**But Rec.2020 is not a superset of every input gamut.** Rec.2020 contains every *delivery* gamut TrailCut will ever output (Rec.709, P3-D65, Rec.2100), but it does *not* contain pro cinema *source* gamuts: ARRI Wide Gamut 4, REDWideGamutRGB (used under RED IPP2), Sony S-Gamut3.Cine, and Canon Cinema Gamut all extend beyond Rec.2020 — particularly in saturated cyans, greens, and blues. This is exactly why Blackmagic engineered DaVinci Wide Gamut Intermediate: Rec.2020 was clipping their pro sources ([13]). For projects ingesting pro cinema log or wide-gamut sources, the working primaries must be widened to a true superset — **ACEScg AP1** ([14]) or **DaVinci Wide Gamut Intermediate** ([13]) are the two real choices. Both contain Rec.2020 with headroom and round-trip every delivery gamut exactly. Routing a consumer Rec.709 SDR source through ACEScg AP1 is still free (same matrix-only logic), so a project that *might* see a cinema-log clip can sit on ACEScg AP1 without penalising the rest.

**Routing SDR through a PQ or HLG transfer function and back is the tax.** PQ and HLG are designed for a much larger dynamic range. Quantizing an SDR signal into PQ code values and back through the inverse PQ EOTF introduces precision losses in deep shadows (PQ allocates many of its code values up at the bright end where SDR has no data) and forces decisions about peak luminance ("how many nits is SDR white?"; BT.2408 [6] documents the canonical 203-nit answer, but it is a convention not a derivation). Combined with any creative inverse-tone-map, you have left the realm of math and entered the realm of look.

The implication: a working space defined as "linear light, Rec.2020 primaries, fp32, with a transfer function chosen per project" is genuinely flexible. The same primaries, the same matrix, the same compositor — but SDR projects never enter the PQ/HLG transfer function, they live in linear-with-Rec.709-gamma-at-IO, and HDR projects live in linear-with-HLG-or-PQ-at-IO. The bug pattern in industry is the architecture that fixes the transfer function (e.g., "we always use ACEScct," meaning the ACES log transfer) and forces every clip through it. That is the architecture that nonlinearly damages SDR sources. We do not need to adopt it.

GIMP's precision documentation ([22]) is worth reading on this exact point: 16-bit *integer* linear has *less* shadow precision than 8-bit gamma, because gamma coding allocates code values where the eye is sensitive. The fix is fp32 linear, not int16 linear. TrailCut's working buffer is fp16/fp32 throughout, so this trap does not apply — but it explains why "just go linear" without the float-precision commitment makes things worse.

## 6. The Compositing Wrinkle (TrailCut-Specific)

TrailCut is not a grading suite. It is a transcode-plus-composite tool: every export overlays a map layer on top of a video clip. That single fact rewrites the question.

In any region where the map is opaque, the video pixel is replaced. In any region where the map has partial alpha (route stroke antialiasing, waypoint glyphs, tearaway edges), the output pixel is `srcAlpha * map + (1 - srcAlpha) * video`. This blend is only physically correct in linear light. Nvidia's GPU Gems 3 chapter 24, "The Importance of Being Linear" ([11]), is the canonical reference; the short version is that compositing in gamma-encoded space darkens midtones at edges and produces off-color halos.

This is the symptom captured in your project memory as "off-color map and blurry edges (preview/export divergence)." It is not a banding problem and dither will not fix it. It is a linear-light-compositing problem, and it is mandatory regardless of project mode. The map renderer must produce pixels in the same primaries as the compositor expects, the video must be inverse-OETF'd into linear before the blend, and the blend itself must happen in linear-light float. Only after the blend do we re-apply the OETF for the chosen output transfer.

This collapses the "lossless SDR passthrough" question. We were never going to bit-pass an SDR clip through TrailCut anyway — the moment the map touches a pixel, that pixel is computed, not copied. The right framing is: **make the computed pixels indistinguishable from the source in the regions the map does not occlude, and physically correct in the regions it does.** That is exactly what the adaptive-dispatch architecture below delivers.

It also aligns with the map-shared-data contract you've established: any MapSettings-derived map state lives in `src/lib/mapVisuals/`, never as direct `setPaintProperty` / `setLayoutProperty` calls inside `MapView`. The same contract extends naturally to color: the map renderer accepts a target color space as a parameter, and `resolveStaticPaints` / `buildPerFrameState` are the only places that decide what space the map pixels are emitted in. Preview and export then cannot diverge by construction.

## 7. Recommended Architecture for TrailCut

Adopt adaptive dispatch driven by (detected input transfer, user-chosen output transfer). The working space is project-scoped, not app-global. The dispatch table:

**Rec.709 in → Rec.709 out (SDR project).**
- Working space: Rec.709 primaries, fp32 linear (expanded inside the composite operator), Rec.709 gamma at IO.
- Video path: HEVC/H.264 decode → YCbCr→RGB in float, carrying explicit studio/full-range and chroma-siting metadata → inverse Rec.709 OETF to linear → composite with map (linear) → Rec.709 OETF → triangular dither → 8-bit yuv420p encode.
- Map path: render in linear Rec.709.
- Goal: perceptually-lossless. Bit-lossless is not achievable under the map because the codec is lossy; outside the map it is also not achievable because we never stream-copy. What is achievable: the output is indistinguishable from the source.

**HLG or PQ in → HLG or PQ out (HDR project).**
- Working space: linear-light Rec.2020 primaries, fp16/fp32 throughout.
- Video path: HEVC decode → HLG/PQ EOTF to linear scene-referred → composite with map (linear Rec.2020) → HLG/PQ OETF → 10-bit yuv420p10le encode, BT.2020 HLG or PQ tagged.
- Map path: render in linear Rec.2020.
- Goal: visually identical round-trip. 10-bit quantize gives ≤1 code drift per BT.2100 ([5]). Dolby Vision dynamic metadata (the RPU) is preserved by explicit per-profile pass-through, not by working-space magic — Profile 5 (PQ-only), Profile 8.1 (PQ base + RPU), and Profile 8.4 (HLG-compatible base + RPU, the iPhone capture format per Apple TN3145 [9] and Apple's Dolby Vision developer PDF [10]) each require their own handling.

**Mixed in → HDR out.**
- Working space: linear-light Rec.2020 throughout.
- SDR clips receive a **colorimetric** lift, not an inverse tone-map: identity in linear light, with SDR diffuse white anchored at the BT.2408-recommended graphics white nit level. No creative re-grading.
- Documented to the user as: "SDR clips will not gain HDR highlights — that would be a creative edit. They will sit at their native brightness on an HDR canvas."

**Mixed in → SDR out.**
- Working space: linear-light Rec.2020.
- HDR clips are tone-mapped down with a documented operator (BT.2446 Method A or equivalent, [7]).
- Documented as a creative loss, surfaced in the export UI.

**Camera-native log / wide-gamut cinema in → HDR or SDR out (Cinema project).**
- Working space: linear-light **ACEScg AP1** primaries (or DaVinci Wide Gamut Intermediate), fp32 throughout. Wider than Rec.2020 specifically to contain ARRI Wide Gamut 4, REDWideGamutRGB, S-Gamut3.Cine, and Canon Cinema Gamut without clipping.
- Video path: codec decode → camera-specific IDT (LogC3/C4-to-linear, Log3G10-to-linear with REDWideGamutRGB→AP1, S-Log3-to-linear with S-Gamut3.Cine→AP1, CLog2/3-to-linear with Cinema Gamut→AP1, V-Log-to-linear with V-Gamut→AP1, BMD Film Gen 5-to-linear with BMD Wide Gamut→AP1) → composite with map (linear AP1) → matrix to Rec.2020 or Rec.709 primaries at output → target transfer OETF → encode.
- IDT support priority, ordered by realistic TrailCut user base: ARRI LogC3/C4 (broad pro coverage, holds up after transcode to ProRes 4444), Sony S-Log3 + S-Gamut3.Cine (huge FX-line install base), RED Log3G10 / IPP2 (covers REDCODE-shot ProRes/DNxHR proxies even when the original .r3d is out of scope), Blackmagic Film Gen 5 ([13]) (Pocket Cinema and URSA users are a real TrailCut audience), Canon CLog3 + Cinema Gamut, Panasonic V-Log + V-Gamut, GoPro Protune / GP-Log, DJI D-Log / D-Log-M. The canonical IDT implementations live in the ACES dev repository ([26]).
- RAW source handling: **CinemaDNG** decoded natively via FFmpeg (covers older BMD Pocket bodies, some drones). **BRAW** (Blackmagic) deferred to Phase 4 SDK integration — the Blackmagic RAW SDK is freely licensed and the user base (Pocket Cinema 6K / 6K G2 / Pyxis / URSA Cine creators) is real and outdoor-camera-shaped. **ARRIRAW**, **REDCODE (.r3d)**, and **Canon Cinema RAW Light** require pre-transcode to ProRes/DNxHR mezzanine by the user, documented at import. This matches how every NLE except Resolve handles those formats; pros editing on Premiere/FCP already work from ProRes 4444 masters, not from the camera-original RAW.

**Metadata-poor input → SDR out (Salvage mode).**
- Source: cheap Android, dashcam, old DV-rip, mistagged web download — `color_primaries`, `color_trc`, `color_range` flags absent, wrong, or contradictory.
- Inference heuristics (applied only when stream tags are missing, never overriding present tags): SD resolution (≤576 lines) → BT.601 matrix; HD/UHD → BT.709 matrix; H.264/HEVC default to studio range; transfer defaults to BT.709 gamma when absent. Every inferred value is user-overridable per clip in the clip-settings UI, with a visible "inferred" badge so the user knows which clips need a sanity check.
- Working space: Rec.709 primaries, linear fp32 inside the composite operator (same as the SDR project mode — there is no benefit to a wider working space for sources this low-fidelity).
- Documented as: "We've inferred this clip's color metadata. If colors look wrong, adjust in clip settings." Tracked separately from confidently-tagged sources so future re-imports can update.

The ten design points that make this concrete:

1. Working space is project-scoped (mode chosen at project create / settable in project.json), never app-global.
2. 32-bit float throughout the working buffer. Non-negotiable. fp16 acceptable on GPU paths where bandwidth matters.
3. Compositing always happens in linear light, but for SDR projects the linear expansion happens *inside* the composite operator (two-tier): inputs/outputs at the operator boundary are Rec.709-gamma 8-bit, the math inside is linear fp32.
4. The map renderer accepts a target color space as a parameter. The decision of which primaries/transfer to emit is centralized in `src/lib/mapVisuals/`, per the shared-data contract.
5. HDR sources are decoded by transfer function, not by manufacturer. HLG sources (iPhone Profile 8.4 base layer per [9][10], Sony HLG capture, broadcast HLG, GoPro HDR HLG, Pixel/Galaxy Android HLG) inverse-EOTF to linear via the standard BT.2100 HLG curve. PQ sources (HDR10, HDR10+, Dolby Vision Profile 5 / 8.1) inverse-EOTF via the SMPTE ST 2084 PQ curve with the source's signaled peak luminance. Dolby Vision dynamic metadata (RPU) pass-through is per-profile (Profile 5, 8.1, 8.4 each handled differently) and tracked as a Phase 4 deliverable.
6. Studio/full-range and chroma siting are carried as per-clip metadata, set from stream tags when present, inferred from the documented heuristics in the Salvage-mode entry above when absent, user-overridable in all cases. Premiere's historical bugs ([4]) — inferring range from codec ID rather than the bitstream — are an antipattern to copy from. The cheap-Android end of the spectrum requires explicit detection plus a visible UI affordance to correct, not silent guessing.
7. Triangular dither at the final 8-bit quantize for SDR encodes. PDF-shaped TPDF is the standard choice; specific algorithm is an open question (section 9).
8. Filtergraph pixel format dispatch is explicit per project mode: `gbrpf32le` for the inside of the composite, `yuv420p10le` for HDR encode, `yuv420p` for SDR encode. Avoid letting `overlay`'s default land on `yuv420` and silently strip chroma — this is exactly the empirical-validation trap noted in your project memory.
9. No ACES, no OCIO framework. The linear-light compositing principle is what we want; the framework overhead, the look transforms, and the gamut-compression negative-component traps are not. ACES is a pipeline for grading rooms, not for a transcode-plus-composite app. OCIO ([17]) is plumbing for projects that need to ship many transforms — TrailCut needs three.
10. No "smart render / stream copy" path. The map composites every frame. Pretending otherwise would mean some pixels are codec-exact and adjacent pixels are computed, which would look worse than computing them all consistently.

## 8. What This Rejects

- **A single hard-coded universal working space for all projects.** Every shipping pro NLE rejected this years ago for the reasons in section 4. We should too.
- **Assuming Rec.2020 is wide enough for any source.** Rec.2020 contains every delivery gamut TrailCut will output, but ARRI Wide Gamut 4, REDWideGamutRGB, S-Gamut3.Cine, and Canon Cinema Gamut all exceed it. For Cinema projects, the working primaries must be ACEScg AP1 or DaVinci Wide Gamut Intermediate, both of which contain Rec.2020 with headroom. (Section 5.)
- **Routing SDR sources through a PQ or HLG transfer function and back.** This is the tax. We do not pay it for SDR projects. (Section 5.)
- **Inferring color metadata from codec ID or container.** Read the stream tags. When they are absent, use documented inference heuristics with a visible "inferred" badge in the UI. Silent guessing is the Premiere antipattern ([4]).
- **Native decode of ARRIRAW, REDCODE (.r3d), or Canon Cinema RAW Light.** These require vendor SDKs with restrictive licensing, are rare in TrailCut's adventure/outdoor use case, and pros editing on non-Resolve NLEs already work from ProRes/DNxHR mezzanines. Document as "pre-transcode required" and move on. BRAW is the one exception worth Phase 4 SDK integration — freely licensed, real user base.
- **Auto inverse-tone-mapping for SDR-in/HDR-out.** Creative, not invertible (BT.2446 [7], BT.2408 [6]). If the user wants this, it is an explicit mode they choose, with the tradeoff visible.
- **ACES RRT for SDR projects.** Maschwitz ([16]) documents why the ACES 1.0.3 RRT is fragile under inverse-ODT, and ACES 1.3's Reference Gamut Compression ([15]) exists precisely because earlier versions produced negative components that surprised people. Worth the cost on a grading floor; not worth it here.
- **Per-clip-native processing** (the opposite extreme — every clip stays in its own space until output). This breaks linear-light compositing the moment two clips meet the map. Composite needs *a* common space, even if the project is SDR-only.
- **Stream-copy / smart-render under the map.** Adobe's own docs ([19]) confirm this isn't available for H.264; LosslessCut and `-c copy` only work at GOP boundaries; and the map composite makes it irrelevant anyway.

## 9. Open Questions for You to Decide

1. **Project mode: auto-detect or user toggle?** Detect from the first imported clip's transfer characteristics, with a one-click override? Or always ask on project create? The Resolve model is "ask on create," the FCP model is "infer from first clip."
2. **Mixed-project default policy.** Three options: auto-promote to HDR (colorimetric SDR lift), tone-map down with a warning, or refuse and require the user to pick a mode explicitly. The Netflix guidance ([18]) is "always grade HDR first" — that biases toward auto-promote.
3. **Dolby Vision dynamic metadata pass-through.** Phase 4 in the brief. Worth deciding now whether the HDR encoder path preserves the DV RPU or strips it to HLG base only.
4. **Map render fidelity in linear light.** Two paths: (a) decode-and-convert — render the map in sRGB as MapLibre does today, then inverse-OETF into the linear compositor, or (b) native-target render — emit the map directly in the target color space. Path (b) is cleaner and avoids a round-trip; path (a) is closer to the current code.
5. **Specific dither algorithm at the 8-bit boundary.** Triangular PDF (TPDF) is the standard answer. Floyd-Steinberg adds spatial correlation that can look better on smooth gradients but introduces patterned noise. To decide based on actual export tests.
6. **Chroma siting and color-metadata inference.** For well-tagged consumer HEVC/H.264 (iPhone, modern Sony/Canon/Panasonic, modern Android), carry the VUI tags through verbatim. For mistagged or untagged sources (cheap Android, dashcam, web-rips, pre-2017 mobile, older DV transfers), pin down the inference heuristics — matrix from resolution, range default by codec, transfer default — and design the per-clip override UI. Empirical validation per your project memory, with a test corpus that includes at least one known-mistagged source per category.
7. **HLG vs PQ as default HDR delivery target.** HLG (relative, SDR-backward-compatible) matches consumer HDR capture (iPhone Profile 8.4 base, Sony HLG, Android HLG, GoPro HDR) and is broadcast-native. PQ / HDR10 is the broader streaming default and how cinema-log projects typically deliver. The right default likely depends on input class: HLG for consumer-HDR projects, PQ for Cinema projects, user-overridable per export.
8. **Studio vs full-range default for output.** YouTube and most streaming services expect studio range YCbCr. Web video sometimes wants full. Per-export setting with a sensible default ("studio for HEVC, studio for H.264").
9. **Working space primaries: tiered or unified?** Three real options: (a) Rec.2020 universally — simplest filtergraph, but clips cinema-log sources; (b) ACEScg AP1 universally — contains everything but every consumer SDR clip pays a (small) wide-gamut-stretches-nothing cost; (c) tiered — Rec.709 / Rec.2020 / ACEScg AP1 chosen per project based on input class. Resolve and FCP picked tiered; Nuke picked unified-wide. The tradeoff is filtergraph simplicity vs perfection. Decide based on whether cinema-log support is a real Phase 3 deliverable or a Phase 5+ aspiration.
10. **Camera IDT support priority.** Which camera-native log formats to support via embedded IDT in Phase 3, and which to defer to "transcode to ProRes/DNxHR before import"? My read: ARRI LogC3/C4 and Sony S-Log3 cover the bulk of pro/prosumer log capture; RED IPP2 covers REDCODE-shot footage even after transcode to ProRes 4444; Blackmagic Film Gen 5 covers BMD Pocket / URSA users. The rest (Canon CLog, Panasonic V-Log, GoPro Protune, DJI D-Log) can be Phase 4+ with documented "transcode to a Rec.709 mezzanine if you want it now."
11. **BRAW SDK integration as Phase 4.** Blackmagic's RAW SDK is freely licensed and covers a real outdoor-camera user segment (Pocket 6K G2, Pyxis, URSA Cine). ARRIRAW, REDCODE .r3d, and Canon Cinema RAW Light require restrictive vendor SDKs and are rare in TrailCut's target use case. Recommended stance: BRAW yes in Phase 4; the other three "pre-transcode required" with documented import-time error.
12. **Metadata-poor source corpus.** Build a test corpus of representative cheap-Android, dashcam, and web-rip samples to validate the Salvage-mode inference heuristics. Without empirical evidence, the matrix-from-resolution rule is a guess; with it, the rule becomes calibrated.

---

## References

[1] Apple Final Cut Pro — Use wide-gamut HDR color processing. <https://support.apple.com/guide/final-cut-pro/use-wide-gamut-hdr-color-processing-ver1cd9629a5/mac>

[2] Blackmagic DaVinci Resolve 18 manual — Choosing a Timeline Color Space. <https://www.steakunderwater.com/VFXPedia/__man/Resolve18-6/DaVinciResolve18_Manual_files/part295.htm>

[3] Adobe helpx — Premiere Pro color management options. <https://helpx.adobe.com/premiere/desktop/correct-color/set-up-color-management/color-management-options.html>

[4] Larry Jordan — The New Color Workflow in Adobe Premiere Pro 2025. <https://larryjordan.com/articles/the-new-color-workflow-in-adobe-premiere-pro-2025/>

[5] ITU-R BT.2100-2 — Image parameter values for HDR television. <https://glenwing.github.io/docs/ITU-R-BT.2100-2.pdf>

[6] ITU-R BT.2408-7 — Guidance for operational practices in HDR television production. <https://www.itu.int/dms_pub/itu-r/opb/rep/R-REP-BT.2408-7-2023-PDF-E.pdf>

[7] ITU-R BT.2446-1 — Methods for conversion of HDR and SDR content. <https://www.itu.int/dms_pub/itu-r/opb/rep/R-REP-BT.2446-1-2021-PDF-E.pdf>

[8] SMPTE ST 2065-1 — Academy Color Encoding Specification (ACES). <https://pub.smpte.org/pub/st2065-1/st2065-1-2021.pdf>

[9] Apple Developer TN3145 — HDR video metadata. <https://developer.apple.com/documentation/technotes/tn3145-hdr-video-metadata>

[10] Apple — Incorporating HDR video with Dolby Vision into your apps. <https://developer.apple.com/av-foundation/Incorporating-HDR-video-with-Dolby-Vision-into-your-apps.pdf>

[11] Nvidia GPU Gems 3, Chapter 24 — The Importance of Being Linear. <https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-24-importance-being-linear>

[12] ISO 22028-1:2016 — Photography and graphic technology, extended colour encodings. <https://cdn.standards.iteh.ai/samples/68761/d90cf953f097405db2fc6e151b8410c7/ISO-22028-1-2016.pdf>

[13] Blackmagic — DaVinci Wide Gamut Intermediate (Resolve 17). <https://documents.blackmagicdesign.com/InformationNotes/DaVinci_Resolve_17_Wide_Gamut_Intermediate.pdf>

[14] ACESCentral — ACES Working Spaces. <https://acescentral.com/knowledge-base-2/aces-working-spaces/>

[15] ACES — Reference Gamut Compression overview. <https://docs.acescentral.com/rgc/overview/>

[16] Stu Maschwitz (Prolost) — On ACES. <https://prolost.com/blog/aces>

[17] OpenColorIO — Concepts overview. <https://opencolorio.readthedocs.io/en/latest/concepts/overview/overview.html>

[18] Netflix Partner Help — Dolby Vision HDR Mastering Guidelines. <https://partnerhelp.netflixstudios.com/hc/en-us/articles/360000599948-Dolby-Vision-HDR-Mastering-Guidelines>

[19] Adobe helpx — Premiere Pro smart rendering. <https://helpx.adobe.com/premiere-pro/using/smart-rendering.html>

[20] Glenn Chan — Towards Better Chroma Subsampling. <http://www.glennchan.info/articles/technical/chroma/chroma1.htm>

[21] thepostprocess.com — How to deal with levels: Full vs Video. <https://www.thepostprocess.com/2019/09/24/how-to-deal-with-levels-full-vs-video/>

[22] GIMP documentation — Image precision. <https://docs.gimp.org/2.10/en/gimp-image-precision.html>

[23] Canva engineering — A journey through colour space with FFmpeg. <https://www.canva.dev/blog/engineering/a-journey-through-colour-space-with-ffmpeg/>

[24] HandBrake documentation — HDR. <https://handbrake.fr/docs/en/latest/technical/hdr.html>

[25] MovieLabs — Mapping BT.709 to HDR10. <https://www.movielabs.com/ngvideo/MovieLabs_Mapping_BT.709_to_HDR10_v1.0.pdf>

[26] Academy Software Foundation — ACES dev repository (canonical IDT implementations for ARRI LogC, RED Log3G10, Sony S-Log3, Canon CLog, Panasonic V-Log, and others). <https://github.com/AcademySoftwareFoundation/aces-dev>

[27] Manufacturer color-science white papers cited descriptively in section 7: ARRI publishes LogC3/C4 specifications on the ARRI knowledge-base portal; RED publishes the IPP2 / Log3G10 / REDWideGamutRGB tech notes; Sony publishes the S-Log3 / S-Gamut3.Cine technical summary; Blackmagic's color science Gen 5 documentation is shipped with the DaVinci Resolve installer and overlaps with [13]. URLs intentionally omitted as they rotate frequently; the ACES IDT repository [26] is the stable canonical source for the actual transforms.
