# Spike Records — Lessons Learned (receipt)

Reviewed: 2026-06-11, branch `feat/control-panel`. Scope: every record under `.spike/` named in
the review brief, plus the two repo-root HTML probes. The ~451 vendored markdown files under
`.spike/native-gl/` (upstream maplibre-native docs) were NOT read, per instruction.

Verification stamp: all "not absorbed" claims re-checked against the live tree this run —
`color_space.rs:211/220` still `npl: Some(400)`/`Some(1000)`, `default_npl_for` (`:332-336`)
still 400/1000; `delivery_finishing_filter` (`delivery.rs:175-185`) still the fused chain and
the test at `delivery.rs:465-472` still pins the pre-fix PQ string; `grep -rn
'sdr_origin_anchor_gain|linear_gain_filter|COMPOSITE_HEADROOM' src-tauri/src/` → 0 hits;
`painterPatch.ts:1-29` still lacks the raster-only-scope note.

These spikes represent months of expensive empirical work across two problem clusters:
**(1) HDR/SDR color math + overlay compositing for export quality**, and **(2) high-fidelity
map export (jitter, crispness, decoration edges)**. This receipt records each spike's
definitive conclusion, what is load-bearing for any future architecture (rewrite or in-place),
what is a dead end never to repeat, and what the main codebase has NOT yet absorbed.

---

## 1. Spike inventory and reading order

The color-port docs form an explicit supersession chain (stated at `.spike/HANDOFF.md:10-18`):

```
FINDINGS.md  (original spike; physics correct, pipeline-shape premise SUPERSEDED)
  └→ HANDOFF.md  (reframe: full input×output matrix; §2 evidence partially corrected by S4)
       └→ SESSION4_FINDINGS.md  (empirical overturn of the 16-bit composite; AUTHORITATIVE)
            └→ PORT_DESIGN.md  (the corrected design; §4C/§6/§7 updated in place)
                 └→ IMPLEMENTATION.md  (ready-to-build, file:line reconciled against live code)
```

| record | dates (file mtimes) | status |
|---|---|---|
| `.spike/FINDINGS.md` | May 29 – Jun 2 | partially superseded (see §2, §8) |
| `.spike/lever_subsample/RESULT.md` | Jun 2 | VERIFIED, conclusion stands |
| `.spike/lever_pq/RESULT.md` | Jun 2 | VERIFIED, conclusion stands |
| `.spike/lever_keyline/RESULT.md` + `HALO_RESULT.md` | Jun 2 | both REJECTED on aesthetics (see §5) |
| `.spike/PORT_DESIGN.md`, `HANDOFF.md`, `SESSION4_FINDINGS.md`, `IMPLEMENTATION.md` | Jun 3–4 | design COMPLETE + validated, **NOT LANDED** |
| `.spike/native-gl-jitter-handoff.md`, `.spike/native-gl/{VERDICT,jitter-report,SPEED,install-notes}.md` | Jun 4 | CONDITIONAL GO, decision pending |
| `map-sampling-explorer.html`, `scratchpad.html` (repo root) | untracked | educational probes, not experiments |

---

## 2. The original HDR map-quality spike (`.spike/FINDINGS.md`)

**Question:** why does the 4K HDR-HLG export of "Abel's Hike" look worse than the SDR preview
(off-color map, blurry decoration edges)?

### Definitive conclusions

**Exonerated (never re-suspect these):**
1. **The renderer.** Export-SSAA frame ≈ preview frame pixel-for-pixel; "the raw map the export
   feeds FFmpeg is good. Renderer fully exonerated." (`FINDINGS.md:24-26`)
2. **SSAA gamma-space downsample** (browser `drawImage` averages in sRGB-gamma, not linear).
   Technically incorrect but negligible: HF-energy ratio 0.995, dark-text contrast within ~2 DN.
   (`FINDINGS.md:27-29`)
3. **Hue.** Lime 72° / cyan 190° preserved end-to-end; no gamut rotation. (`FINDINGS.md:30`)
4. (Implicitly, per project memory `project_export_quality_symptoms`) **banding/dither was the
   wrong tree** — the regression is brightness + chroma-edge softness, not banding.

**Root cause — SDR→HLG reference white wrong.** The map (sRGB graphics) was being encoded with
default no-`npl` HLG finishing, landing SDR white at **~62% HLG signal (measured 158/255)**
instead of the **BT.2408 HDR reference white of 75% = 203 nits**. Measured: PSNR vs preview
12.1 dB → 34.8 dB with `npl=203`; lime trail HSV-V 69% → 94%; map white in the real composite
sat 40 SDR-levels darker than the HDR video beside it. npl sweep confirmed 203 optimal
(100→PSNR12, **203→35**, 300→24, 1000→18). (`FINDINGS.md:50-99`)

**Secondary, real, decoration-specific: 4:2:0 chroma-edge blur.** `yuv420p10le` (mandatory for
consumer HEVC main10 HDR) softens saturated lime/cyan decoration EDGES specifically: chroma
HF-energy −36%, lime-line chroma edge width **doubling 1.41→2.97 px**, luma untouched
(LapVar 251→250). This is the user's "blurry edges" and it never shows in preview (RGB on
screen). **Magnitude ranking: off-color HLG ≫ 4:2:0 decoration-edge blur ≫ SSAA gamma downsample
(negligible).** (`FINDINGS.md:32-48`)

**Residuals the fix does NOT close** (why preview still looks best): 4:2:0 edge softening;
~5–8 pt decoration desaturation from the BT.2020 limited-range 10-bit round-trip (present
equally in base and fix — NOT the dark-map bug); HLG quantization. (`FINDINGS.md:111-125`)

**Standing caveat on all color spikes:** every comparison decodes through a *BT.2408-correct
HLG→SDR view model* (npl=203) — "faithful but approximate"; ground against a real HDR display
remains an open validation item. (`FINDINGS.md:127-130`, repeated in every lever RESULT.)

### What was superseded
FINDINGS' fix ("`npl=203` on the HLG finishing step", `FINDINGS.md:86-99`) was validated in an
**`hstack` pipeline shape with separate per-branch finishing that the codebase does not use**.
On the real path (single shared finishing after a working-space overlay) the map-only anchor is
**inert** — see §8. The *physics* (203-nit anchor) is correct; the *placement* moved to ingest.
(`PORT_DESIGN.md:3-8`, `HANDOFF.md:39-47`)

---

## 3. Lever 1 — HQ chroma subsample (`.spike/lever_subsample/RESULT.md`) — VERIFIED

**Probe finding (corrects an intuitive assumption, permanently useful):** in the real finishing
chain `…,zscale=t=arib-std-b67:m=bt2020nc:p=bt2020:r=limited,format=yuv420p10le`, **zimg itself
fuses the matrix + 4:2:0 decimation in one step; FFmpeg does NOT auto-insert a swscale, and the
trailing `format=yuv420p10le` is a no-op** (verbose/debug-log proven, `RESULT.md:12-46`).
Chroma is therefore averaged in the **HLG-encoded non-linear YCbCr signal** (post-OETF,
post-matrix), with zimg's default bicubic + left/MPEG-2 siting. zimg has no linear-light-chroma
mode for a YCbCr target.

**Winning candidate (C2_sws_hq):** split the fused step — zimg matrices to full-res 4:4:4, a
high-quality swscale owns the 444→420 decimation:

```
zscale=t=arib-std-b67:m=bt2020nc:p=bt2020:r=limited,format=yuv444p10le,scale=flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp,format=yuv420p10le
```

Measured vs current: lime chroma edge-width 6.22→5.29 px (**recovers ~25% of the
subsample-attributable blur**), cyan fringing 55→82 (4:4:4 ceiling 120), PSNR-vs-444-ideal
43.40→44.22 dB, luma untouched, survives real libx265 main10 (+14–26% chroma-HF). **Free — no
perf/codec cost.** (`RESULT.md:92-114`)

**Hard ceiling (load-bearing):** a better filter recovers only ~25%; **the remaining ~75% of
the doubled edge width is intrinsic to 4:2:0 half-res chroma** and only erasable by not
subsampling — off the table for consumer HEVC main10. zimg-kernel-only variants
(lanczos/spline36) cap at ~15%. Linear-light decimation (libplacebo C3) was untestable —
**failed loud** on `VK_ERROR_INCOMPATIBLE_DRIVER` (no Vulkan on this Mac), and is bounded by
the same ~25% ceiling anyway. (`RESULT.md:118-136`)

---

## 4. Lever 3 — PQ 203-nit anchoring (`.spike/lever_pq/RESULT.md`) — VERIFIED

The PQ (`HdrPq`) target has the **identical dark-map bug**, same magnitude (PSNR 12.17→34.78,
SSIM 0.930→0.981, lime V 69→94%). Fix is `:npl=203` on the existing single
`t=smpte2084` finishing step (no ingest restructuring, unlike HLG). Verified that zscale's
`npl` on linear→PQ literally means "scene-linear 1.0 → N nits" (pure-white probe: npl=203 →
199.4 nits). Encoder tags already correct; verbose dry-run confirmed no silent scaler.
(`lever_pq/RESULT.md:19-37`)

**The trap this spike permanently disarms (`RESULT.md:96-110`):**
1. **203 nits = PQ signal 0.58 (594/1023), NOT HLG's 75%.** PQ is absolute-luminance; anchor on
   the *nit* target via npl, never reuse HLG's signal number.
2. **The HLG fix does NOT auto-cover PQ.** Finishing is per-target; each HDR transfer needs its
   own anchor.
3. `current ≡ npl=100` (byte-identical) proves the defect is the default ~100-nit scene-linear
   white assumption — same shape on both transfers.

---

## 5. Lever 2 — decoration crispness: keyline + halo (`.spike/lever_keyline/`) — REJECTED ON LOOKS

Two prototypes, both technically successful, **both set aside on aesthetics**. The final
disposition is in `FINDINGS.md:157-166` ("both were set aside on aesthetics — the look wasn't
good enough... intentionally left as an open DESIGN problem") and is restated as a hard
do-not-touch rule in `HANDOFF.md:173-174` and `IMPLEMENTATION.md:460-462`. Project memory
`project_decoration_crispness_levers` pins this: "keyline + soft glow both rejected on looks,
don't redo."

### The mechanism (the permanently valuable part, `RESULT.md:43-47`)
The decorations are high-chroma / low-luma-contrast edges; 4:2:0 keeps luma at full res but
chroma at half res, so the eye gets only a blurred chroma ramp. **"This is exactly how
broadcast graphics stay crisp through 4:2:0: the edge lives in luma."** Any future decoration
design that wants crisp edges through consumer delivery must give the boundary LUMA contrast.

### Hard 1px dark keyline (`RESULT.md`)
Technically decisive: edge luma LapVar ×170, lime luma edge-width **3.92 → 0.91 px** through
the full real HLG/4:2:0/libx265 chain. Light keylines do nothing (no luma contrast vs cream
paper). 2px is visually heavy. **Verdict on looks: "crisp but an obvious stuck-on black
outline — the rejected sticker look"** (`HALO_RESULT.md:71`).

### Soft dark halo / outer glow (`HALO_RESULT.md`)
Dark, sigma ~2 device px, strength ~0.6–0.7: recovers ~13% of the keyline's edge energy but
~23× the no-halo level, reads as a polished drop-shadow. Knee at sigma~2 — **more blur ≠ more
recovery** (r4/r8 become "smoky vignette / ring of grime"). Light halos invisible on cream;
a robust impl would pick polarity from local background luma. **NOTE THE CONFLICT:**
`HALO_RESULT.md:78-83` itself says "**Adopt** a soft dark outer-glow…", but the later
`FINDINGS.md` Session-2 update (and the project memory) overrode this — both variants were set
aside on looks and the lever is deliberately deferred. The later record wins.

### Implementation guidance preserved for whenever the design problem is reopened
Both RESULTs specify the contract-correct shape: emit from the shared
`resolveStaticPaints`/`buildPerFrameState` tuples (line casing / `line-blur` for trail, blurred
`circle-stroke` for waypoints), specify width/sigma in *logical/cssViewport* px so it scales
with pixelRatio/SSAA, never as an ad-hoc MapView `setPaintProperty` or post-process; keep the
fill sharp (glow is strictly an underlay); raises both surfaces, so no leveling-down.
(`RESULT.md:70-87`, `HALO_RESULT.md:85-102`)

---

## 6. Session 4 — the composite-intermediate overturn (`.spike/SESSION4_FINDINGS.md`) — AUTHORITATIVE

This session validated the approved fix's linchpin BEFORE touching the codebase and **overturned
it**. Its empirical "gain-filter law" is among the most expensive-to-rediscover knowledge in the
repo (`SESSION4_FINDINGS.md:12-33`):

| design said | measured reality |
|---|---|
| lift composite to 16-bit (`yuva444p16le`) through `overlay` | **`overlay` caps at 10-bit** — its `format` enum tops at `yuv444p10`; feeding 16-bit makes FFmpeg **silently auto-insert a scaler down to `yuva444p10le`** (verbose-confirmed). `gbrap16le` is accepted and **corrupts** (0.15 → 0.0625). True 16-bit overlay composite is **impossible**. |
| some float compositor could avoid the lift | `maskedmerge` and `blend` process `gbrpf32le` but **clamp to [0,1]**. **No float positioned compositor exists** in FFmpeg. |
| gain via `geq` ×2.03 | **`geq` clamps output to [0,1]** — silently inert for any gain >1. |
| HLG peaks ~12 at npl=100 → H=16 headroom | real iPhone HLG frame max = **linear 24.6** at npl=100 → **H=16 would clip real footage. Use H=32.** (PQ 100%-white = linear ~108; PQ >~3200 nit clips at H=32 — flagged known bound.) |
| 10-bit+headroom would band the map | 1024-step gradient distinct levels: 608 ceiling / 606 (16-bit ideal) / **381 (10-bit+headroom)** — far above the ~64–128 visible-banding threshold. Rejection was overstated. |
| headroom can be unconditional | **headroom must be gated to HDR delivery** — on SDR it regresses the gradient 209→85 levels. Gate: `delivery.transfer.is_hdr()`. |

**Gain-filter law (empirical, `SESSION4_FINDINGS.md:30-33`):** only `colorchannelmixer`
(clamp-free above 1.0, but ±2.0/coefficient cap → chain stages), `exposure` (clamp-free but
±3-stop cap = ×8 max), and `zscale`/`swscale` preserve float >1.0. `geq`, `gbrap16le`, integer
`format=` conversions, `maskedmerge`, `blend` all clamp/corrupt at [0,1].

Corrected mechanism, validated end-to-end on all three composite shapes (unmasked PIP, masked
alphamerge, Split): **10-bit `yuva444p10le` + headroom (÷32 in float before each lift, ×32
after the post-overlay return to `gbrpf32le`), gains via a `linear_gain_filter(factor)`
colorchannelmixer chain, gated to HDR delivery.** Map white lands 0xC0 = 75% = 203-nit ref;
HDR video round-trips ±3; masked edges blend coherently inside the headroom.
(`SESSION4_FINDINGS.md:22-41`)

Also: a python overlay+`geq` test rig kept returning all-black — a **harness bug, not the
mechanism**; validate headroom by building a real encoded composite and reading output signal
(`HANDOFF.md:203-205`).

---

## 7. The port redesign (`PORT_DESIGN.md` + `HANDOFF.md` + `IMPLEMENTATION.md`) — COMPLETE, NOT LANDED

### Why the original port was reframed
On the real codebase path (ingest → working-space overlay → **one shared finishing**), two
defects the hstack-shaped spike couldn't see (`PORT_DESIGN.md:10-34`, all measured):
1. The overlay's `format=yuva444p10le` lift **clamps working-space linear to [0,1] = 100
   nits** — both map AND video are clamped to ~63% (mutually coherent, both too dark). The
   map-only npl=203 anchor is **inert** on this path, and would be counterproductive if it
   weren't.
2. The HDR video is **independently darkened** because ingest npl (400/1000) ≠ finishing npl
   (zimg default = 100); measured `240→183` vs `240→239` identity when matched.

Matthew's direction (`HANDOFF.md:49-52`): the task is a **full input×output matrix** (SDR/HLG/PQ
source × SDR/HLG/PQ/ProRes delivery); the map is just the always-SDR-origin row; **correct the
video too**.

### The model (load-bearing for any future color architecture, `PORT_DESIGN.md:36-66`)
Working space = **absolute linear light**, BT.2020, `gbrpf32le`, **linear 1.0 ≡ 100 nits**
(SDR diffuse white); HDR sits above 1.0 (real HLG to 24.6, PQ 100%-white ~108). Ingest places
each source at its true nits; composite combines in absolute linear light; finishing encodes to
the target transfer. **BT.2408 anchoring is a per-origin × per-delivery rule** — any SDR-origin
input (map, SDR video, future title) → HDR delivery gets linear gain ×2.03 (203/100 nits) at
the ingest tail; HDR-origin is never anchored; SDR→SDR is native. Proven equivalent to npl=203
finishing for both HLG and PQ.

### The four-part fix (A+B+C+D, `IMPLEMENTATION.md:26-31`)
- **(A)** HDR ingest npl 400/1000 → **100** (matches default finishing → HDR video round-trips).
  **npl=100 CONFIRMED by Matthew** — npl is the linear normalization reference, not a clip
  ceiling; npl=1000 rejected (squeezes SDR/map into ~0.1–0.2 → banding). (`HANDOFF.md:140-146`)
- **(B)** registry fn `sdr_origin_anchor_gain(source, delivery) -> Option<f64>` returning
  `Some(2.03)` iff `!source.is_hdr() && delivery.is_hdr()`; applied at ingest tail via
  `linear_gain_filter` (stages `[2.0, 1.015]`).
- **(C)** composite headroom: 10-bit `yuva444p10le` + ÷32/×32 colorchannelmixer chain, gated to
  HDR delivery (the §6 corrected mechanism).
- **(D)** HQ chroma subsample split in `delivery_finishing_filter` for 4:2:0 targets (the §3
  C2_sws_hq chain), gated on `finishing_pix_fmt()` not the target enum.

**Land A+B+C+D together** — "Staging A+B+D without C is a trap — the overlay clamp means
brightness isn't visibly corrected until C lands, so a partial landing would look like a
regression with no payoff." (`HANDOFF.md:148-150`)

**Flagged known bounds (flag, don't hide — `PORT_DESIGN.md:163-174`):** HDR source → SDR
delivery hard-clips highlights (tone-map gap; Matthew chose follow-up; explicitly NOT to be
"fixed" by degrading the HDR→HDR path); PQ content above ~3200 nits clips at H=32 (no PQ
footage in hand; revisit with per-export-dynamic-H or tone-mapping only if it bites).

### IMPLEMENTATION.md is a ready-to-build artifact
603 lines: exact verified `file:line` edit sites (e.g. `HDR_HLG_BT2020.npl` at
`color_space.rs:211` — **still accurate as of this review**), real Rust signatures, the
threading plan for `delivery` through `ClipChainInputs` (`IMPLEMENTATION.md:156-277`), all six
composite-branch splice sites (`:305-372`), every byte-equality test that must change, a
per-matrix-cell loud integration test plan (`:487-508`), the mandatory verbose dry-run rule
made executable (`:510-520`), and a "Corrections to the codebase audit" section (`:580-603`)
recording where an auditor's guesses were wrong (e.g. `colorchannelmixer=ar=2.03` uses ALPHA
coefficients and exceeds the ±2 cap — never copy that string).

### Verified NOT absorbed (as of 2026-06-11)
- `src-tauri/src/util/color_space.rs:211` still `npl: Some(400)`; `:220` still `Some(1000)`;
  `default_npl_for` (`:332`) still returns 400/1000. Doc comment `:161` still says "HLG
  reference 400, PQ reference 1000".
- `grep -rn 'sdr_origin_anchor_gain\|linear_gain_filter\|COMPOSITE_HEADROOM' src-tauri/src/`
  → no hits. (B) and (C) do not exist.
- `src-tauri/src/export/delivery.rs:471` test still pins the old fused PQ chain
  `"zscale=t=smpte2084:m=bt2020nc:p=bt2020:r=limited,format=yuv420p10le"`; no `lanczos`, no
  `npl=203` anywhere in the file. (D) and the anchor are not landed.
- Session 4 explicitly reverted its one exploratory edit: "the file is back to npl 400/1000, no
  anchor/gain additions" (`SESSION4_FINDINGS.md:5-7`).

**This is the single largest body of validated-but-unshipped work in the repo.** HANDOFF.md:5
says it is "ready for implementation once Matthew greenlights."

---

## 8. Native renderer spike (`.spike/native-gl/`) — CONDITIONAL GO, decision pending

**Question** (`native-gl-jitter-handoff.md:7-9`): can `maplibre-native` render a smoothly
moving 4K camera path without the pixel-grid jitter that forced us back to headless GL JS — and
if it jitters, which layer, and how deep is the fix? (NB: the handoff's "Status: not started"
header at `:4` is stale — the spike completed; trust `VERDICT.md`.)

### Verdict (`.spike/native-gl/VERDICT.md`)
**CONDITIONAL GO — vector basemap is an outright GO; raster needs a core fix.**
- Headline number: native vector-basemap residual RMS **0.0080 px** vs GL JS reference
  **0.0070 px** — 12× inside the 0.10 px PASS threshold, no sawtooth, confirmed in both 16:9
  and 9:16. Crispness: native vector ≥ GL JS (acutance ratio 1.02). (`VERDICT.md:12-20`)
- **The original rejection's fear ("slow pans render jittery on native") does not happen on our
  vector basemap.** Jitter lives in **raster layers only** — and native raster snaps
  *identically* to unpatched GL JS (RMS 0.8754 / max 1.506, **matched to 4 decimal places** —
  same mechanism: raster tweaker requests the pixel-`aligned` snapped projection matrix).
  (`VERDICT.md:21-34`, `jitter-report.md:12-26`)
- **Raster is in-scope and blocking** (satellite, custom raster tiles, video sources all
  inherit the raster draw path). Every no-fork mitigation was characterized and fails
  (`VERDICT.md:67-93`): SSAA is **useless for jitter** (the snap is in point space, which is
  resolution-invariant); harness-side de-snap tops out at 0.279 px with residual shimmer and
  can't handle mixed raster+vector frames; render-big-once/pan-by-crop is too narrow. **The
  only true fix is core mbgl `aligned=false` in the raster tweaker** — a C++ core change, not a
  binding change (the Node binding exposes no alignment knob), so it means per-platform
  from-source builds unless **upstreamed** (preferred: small PR mirroring GL JS's `moving`
  concept, keeps prebuilt binaries).
- macOS arm64 install: **frictionless** — prebuilt binary, 7 s, zero compile
  (`install-notes.md:11-17`). Best-case platform; **Windows/Linux prebuilt availability for the
  shipped node ABI is an unverified follow-up**, and the binding is pinned to node ABI
  (node-v127) (`install-notes.md:27-35`).

### Instrument quality (a gem in itself, `jitter-report.md:27-39`)
The measurement (cv2.phaseCorrelate on raw PNGs, Hanning-windowed, residual vs linear fit) was
validated with **two positive controls** — a synthetic whole-pixel snap (flagged, RMS 0.4996)
and a REAL genuinely-snapping render (GL JS raster unpatched, RMS 0.8754, 110× above native
vector) — so "smooth" is trustworthy, not instrument blindness. Numeric analysis ran on raw
PNGs, never compressed video.

### Side finding about the CURRENT app (`jitter-report.md:72-75`, `VERDICT.md:106-107`)
**Our shipped painter patch (`src-tauri/sidecars/renderer/page/painterPatch.ts`) is a no-op on
the vector liberty basemap** (patched and unpatched GL JS were byte-identical there). It only
does real work on raster/hillshade — it is the thing keeping satellite exports smooth today.
"Don't let it be 'simplified' away." The patch is present and active in the codebase
(`painterPatch.ts:27` forces `moving: true`).

### Speed benchmark (`.spike/native-gl/SPEED.md`) — the strategic fork in the road
4K per-frame, warm cache, same Metal GPU: **native 9.2 ms (~108 fps) vs GL JS 524 ms
(~1.9 fps) — 57× faster**. But the decomposition is the load-bearing part: GPU render is
comparable (9 vs 18 ms); **96% of GL JS's time is "browser tax"** — 116 ms in-page base64
encode + **384 ms CDP round-trip of a ~44 MB base64 string**. 30 s @ 30 fps clip: native ~8 s,
GL JS ~8 min. Strategic read (`SPEED.md:38-49`): a **non-CDP transport (shared memory/socket,
raw bytes)** could take GL JS toward ~30–60 ms/frame — keeping the HDR/color pipeline fully
intact, much smaller risk than an engine swap — "strong near-term candidate"; native is faster
still but blocked on the raster-aligned fix and needs its own HDR validation. This matches
project memory `project_renderer_frame_transport` (base64-over-CDP with 100 MB cap; higher
throughput needs a non-CDP transport, not a bigger factor).

---

## 9. The repo-root HTML probes

- **`map-sampling-explorer.html`** ("TrailCut · Map Sampling Explorer") — a self-contained
  faithful re-implementation of the production map sampling chain (the lever model:
  `multiplier` resolution lever from `layout.rs canonical_map_viewport`, SSAA tier from
  `layout.rs map_supersample_factor`, downsample-to-slot) with three live MapLibre panes
  (no-SSAA / export-SSAA / preview-Retina) and a pixel magnifier. It is an *explainer/probe* of
  why SSAA headroom survives 4:2:0 ("the downsample back to the slot is where that headroom is
  cashed in as crisp, colour-rich edges that survive 4:2:0 chroma subsampling",
  `map-sampling-explorer.html:216`), including the rule that 720p never renders sub-1080p.
  Useful documentation-as-tool for the MAP_RENDERING_PLAN lever model; not an experiment with a
  verdict.
- **`scratchpad.html`** — a MapLibre 3D-buildings page instrumented with the three-lever
  viewport model spelled out in comments (`scratchpad.html:217-223`): cssViewport = framing/
  shape, pixelRatio = resolution dial, SSAA = antialiasing dial, framebuffer = css × pr × SSAA,
  readback = framebuffer ÷ SSAA; plus a "Snapshot PNG (export path)" button and an
  `#export-view` canvas showing the last export readback at 1:1 so Playwright can screenshot
  the real exported pixels. A hand-driven probe of the export readback path. Disposable.

Both restate (and were presumably used to develop intuition for) the binding **perceived-scale
invariance** lever model; neither contains unique results not captured elsewhere.

---

## 10. Consolidated: load-bearing conclusions for ANY future architecture

These survive a rewrite; losing them re-incurs the full spike cost.

**Color / compositing physics:**
1. SDR-origin graphics into HDR delivery must anchor at **BT.2408 203-nit reference white**;
   per-target (HLG signal 75%; PQ signal 0.58 — anchor on nits, never reuse signal numbers).
2. zimg working linear is **absolute, 1.0 = 100 nits** only when ingest npl = finishing npl =
   100; HDR round-trip requires the match. Real iPhone HLG peaks at **linear 24.6** (not
   nominal ~10–12).
3. **FFmpeg has no >10-bit and no float positioned compositor.** `overlay` caps at yuv444p10
   and silently downconverts 16-bit inputs; `maskedmerge`/`blend` clamp float to [0,1]. The
   only HDR-preserving composite is 10-bit + ÷H/×H headroom (H=32, HDR-gated).
4. **Gain-filter law:** `colorchannelmixer` (chained, ±2.0/coeff) is the only general
   clamp-free float gain; `geq` clamps [0,1]; `exposure` caps ±3 stops.
5. zimg **fuses matrix + 4:2:0 decimation** (trailing `format=` is a no-op; decimation happens
   in the non-linear encoded signal); the HQ split (zimg→444, swscale
   lanczos+full_chroma→420) recovers ~25% of decoration edge blur for free; the other ~75% is
   intrinsic to 4:2:0.
6. Decoration edges survive 4:2:0 only if the boundary has **luma** contrast (broadcast-
   graphics principle) — the mechanism is proven; the visual treatment is an open design
   problem (keyline and halo both rejected on looks).
7. Textual filter_complex inspection is insufficient: FFmpeg silently auto-inserts scalers —
   **`-loglevel verbose` dry-runs are mandatory** for every chain (made executable in
   IMPLEMENTATION.md §6.4).

**Renderer / map export:**
8. Pixel-grid jitter splits purely by **layer class** in both engines: vector = `aligned=false`
   = smooth; raster/hillshade = `aligned=true` = snaps. maplibre-native is **jitter-free on the
   vector basemap at 4K** (GO); raster needs a core-mbgl `aligned` fix (upstream PR preferred).
9. **SSAA cannot fix raster jitter** (point-space snap is resolution-invariant); de-snap
   shifting caps at 0.28 px with shimmer.
10. Our **painterPatch is raster-only** — a no-op on the vector basemap, essential for
    satellite exports; must not be removed as "dead code".
11. The GL JS speed problem is **transport (96%), not rendering** — non-CDP transport is the
    low-risk speed unlock; native is the 57×-but-conditional one.

**Process lessons embedded in the records:**
12. Validate the fix **in the pipeline shape the codebase actually uses** — FINDINGS' npl=203
    finishing fix was correct physics but inert on the real single-finishing path; the whole
    Session-3/4 reframe exists because the spike harness used `hstack` per-branch finishing.
13. Validate the linchpin mechanism empirically **before** writing the implementation —
    Session 4 caught a physically impossible approved design (16-bit overlay) pre-code.
14. Calibrate the instrument with **positive controls** (the jitter spike's synthetic-snap +
    real-snap controls are why "smooth" is believable).
15. Record install/build friction **as data** (install-notes.md) — it was half the original
    native rejection rationale.

---

## 11. Dead ends — never repeat

| dead end | why | where recorded |
|---|---|---|
| 16-bit overlay composite (`yuva444p16le`/`gbrap16le`/`rgba64le` through `overlay`) | overlay caps at 10-bit, silently downconverts; gbrap16le corrupts values | `SESSION4_FINDINGS.md:15` |
| `geq` for any gain >1 | clamps output to [0,1], silently inert | `SESSION4_FINDINGS.md:17` |
| `exposure` for headroom ÷32/×32 | ±3-stop (×8) cap | `SESSION4_FINDINGS.md:30-33` |
| `maskedmerge`/`blend` as float compositors | clamp to [0,1] | `SESSION4_FINDINGS.md:16` |
| H=16 headroom | real HLG peaks at linear 24.6 → clips | `SESSION4_FINDINGS.md:18` |
| Unconditional (SDR-too) headroom | bands SDR gradient 209→85 levels | `SESSION4_FINDINGS.md:20` |
| npl=1000 working space | squeezes SDR/map into linear ~0.1–0.2 → map banding | `HANDOFF.md:144-146` |
| Map-only npl=203 finishing fix on the real composite path | inert (clamped right back by the overlay lift); validated only in the unused hstack shape | `PORT_DESIGN.md:30-34` |
| Light keyline / light halo on the cream basemap | no luma contrast → no effect (LapVar ~1.0×) | `lever_keyline/RESULT.md:40-41`, `HALO_RESULT.md:41` |
| Hard dark keyline / soft dark halo as shipped looks | rejected on aesthetics ("sticker" / "ring of grime" at width); deliberately deferred design problem — don't rebuild the prototypes | `FINDINGS.md:157-166` |
| zimg-kernel-only subsample tweaks (`f=lanczos`/`spline36`) | ~15% recovery vs C2's 25%; siting/interp is the lever, not the kernel | `lever_subsample/RESULT.md:111-114` |
| Chasing >25% chroma-edge recovery pipeline-side | remaining ~75% intrinsic to 4:2:0; only non-subsampling erases it (off the table for consumer HEVC) | `lever_subsample/RESULT.md:120-126` |
| Blaming the renderer / SSAA gamma downsample / hue for export quality | all exonerated with measurements | `FINDINGS.md:23-30` |
| SSAA / higher pixelRatio to fix raster jitter | snap is point-space, resolution-invariant | `VERDICT.md:76` |
| Harness-side de-snap compositor shift | 0.279 px ceiling + shimmer; can't fix mixed raster+vector frames | `VERDICT.md:77` |
| Render-big-once, pan-by-crop | constant-zoom bounded-extent only; too narrow | `VERDICT.md:78` |
| Judging native renderer speed from the jitter harness | explicitly out of scope there (possible software raster); SPEED.md did it properly later | `native-gl-jitter-handoff.md:39` |
| python overlay+geq probe rig | returned all-black — harness bug, not mechanism; validate via real encodes | `HANDOFF.md:203-205` |
| `colorchannelmixer=ar=2.03` and `cscale=w=iw*0.5` (auditor-invented strings) | ar/ag/ab are alpha coefficients; 2.03 exceeds ±2 cap; cscale form wrong | `IMPLEMENTATION.md:596-599` |
| libplacebo linear-light chroma decimation on this hardware | no Vulkan device (fails loud, as required); bounded by the same ~25% ceiling anyway | `lever_subsample/RESULT.md:131-136` |

---

## 12. Spike conclusions NOT yet absorbed by the main codebase

1. **The entire A+B+C+D color port** — designed, empirically validated, implementation-spec'd
   (`IMPLEMENTATION.md`), confirmed decisions (npl=100, land together), **zero of it landed**:
   - `color_space.rs:211/220/332` still npl 400/1000; doc comments still describe the old
     convention.
   - No `linear_gain_filter`, `sdr_origin_anchor_gain`, `SDR_REF_WHITE_NITS`,
     `COMPOSITE_HEADROOM` anywhere in `src-tauri/src/`.
   - `delivery.rs` finishing still the fused chain (test at `delivery.rs:469-471` pins the
     pre-fix string); no HQ subsample split, no 203-nit anchor on any path.
   - Consequence: **every HDR export today still ships the measured defects** — map ~25% too
     dark (PSNR 12 vs preview), HDR video npl-darkened and highlight-clamped by the overlay
     lift, and the free ~25% chroma-edge recovery unclaimed. This was gated only on Matthew's
     greenlight (`HANDOFF.md:5-8`).
2. **Native-renderer strategic decision** — vector GO + transport analysis delivered; no
   follow-up visible (no non-CDP transport work, no native prototype, no Windows/Linux prebuilt
   check, no upstream `aligned` PR). The renderer sidecar still pays the 96% browser tax.
3. **Decoration crispness design** — deliberately deferred (correctly recorded everywhere), but
   note the internal contradiction: `HALO_RESULT.md` recommends adoption while the later
   `FINDINGS.md` update rejects both; anyone reading only HALO_RESULT would re-litigate a
   settled rejection.
4. **Real-HDR-display validation** — flagged as an open item in every color spike
   (`FINDINGS.md:127-130`, `lever_pq/RESULT.md:104-106`, `HALO_RESULT.md:105`); never done.
5. **painterPatch raster-only documentation** — the side finding ("no-op on vector; the thing
   keeping satellite exports smooth") is in the spike records and project memory but NOT in the
   patch's own header comment (`painterPatch.ts:1-27` explains the mechanism but not the
   raster-only scope / don't-delete warning).
6. **Stale headers inside the spike records themselves**: `native-gl-jitter-handoff.md:4` says
   "Status: not started" though the spike completed; `HANDOFF.md` §2's evidence table still
   contains the struck-through wrong rows (intentionally, with corrections inline) — safe only
   if read with SESSION4_FINDINGS, as instructed.
7. **CLAUDE.md schema-version drift** (observed while verifying): CLAUDE.md says
   `CURRENT_SCHEMA_VERSION = 8` / "currently v8", but `models.rs:978` is `9` — and the spike
   records consistently assume v9 (`FINDINGS.md:211` "schema v9", `PORT_DESIGN.md:105`
   "project working space (v9)"). The spikes are ahead of the project doc, not the code.

---

## 13. Verdict-relevant observations (for the rewrite-vs-cleanup decision)

- The spike corpus is the **opposite of the "soupy" problem**: each record states its question,
  its instrument, its numbers, its supersession chain, and its disposition. The lessons are
  crisp; the *codebase* hasn't absorbed them. A rewrite that loses `.spike/` (or this receipt)
  loses the expensive part; a rewrite that keeps it inherits validated physics +
  `IMPLEMENTATION.md`-grade build plans.
- `IMPLEMENTATION.md` is written against the **current** module layout (`color_space.rs`,
  `delivery.rs`, `clip_chain.rs`, `filtergraph.rs` with verified line numbers). A
  start-over-cleanly verdict invalidates its file:line scaffolding but NOT its physics, filter
  strings, gain-filter law, test matrix, or known-bounds — those port directly into any deep
  "color registry" module.
- The two strategic unknowns a rewrite would want settled first are exactly the two this corpus
  already measured: (a) the color matrix model (settled, awaiting landing), (b) the renderer
  engine/transport choice (measured, decision pending between native-vector GO and
  GL-JS+non-CDP-transport).
