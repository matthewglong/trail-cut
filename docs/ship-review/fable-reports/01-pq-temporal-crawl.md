# PQ/HLG map-decoration temporal crawl — fix-family analysis, temporal gate spec, open questions

**Status:** decision-grade analysis, no code changed. The one remaining HDR-map
defect after fix C′ (commit `5a6030d`) and the libx265 encoder fix (`1345ded`).
Read alongside `docs/ship-review/PROGRESS.md` NEXT ACTION item 1 + the
2026-07-03 cont. 4 audit, and `docs/CANON.md` §1.5 / §1.12 / §2.5 (all binding).

---

## 0. The mechanism, stated precisely (so every fix below is judged against it)

The defect: in `HdrHlg` and `HdrPq` exports, flat map-decoration fills (route
line, POV marker/pulse, waypoint discs) **crawl / sparkle frame-to-frame**; PQ
visibly worse than HLG; SDR clean. It survived fix C′ because the two static
gates (`composite_pq_transport_ramp_retains_distinct_levels`,
`composite_pq_transport_preserves_decoration_hue`, `color_fixtures.rs:2319/2385`)
are single-frame and blind to temporal stability.

The chain has two independent parts, and the 2026-07-03 audit already localized
which is which. Both are load-bearing for the ranking, so restate them exactly:

**SOURCE — a genuinely small, mostly-legitimate input wobble (~1 LSB at the 8-bit
map wire).** The native renderer hands the composite an **8-bit** premultiplied
sRGB RGBA frame. SSAA renders at `framebuffer = slot × factor` and the reduction
to `readback` dims is an exact integer box filter — on-GPU under Metal, JS
`boxDownsample` as the executable spec (`nativeBackend.ts:262-306`, divisor
`factor²`, `(sum + n/2)/n` **truncated**). That final average is snapped back to
**8-bit** (`nativeBackend.ts:842-880`; the wire is 8-bit RGBA, CANON §2.5 "SSAA +
alpha convention"). Because decorations are geo-anchored and the export camera
pans sub-pixel every frame (route-follow), an anti-aliased decoration EDGE covers
a slightly different fraction of each output pixel each frame, and translucent
decorations (halos, POV pulse) additionally show a *different slice of the moving
basemap* through them. The continuous coverage/blend value varies smoothly, but
the 8-bit box-filter average crosses integer code boundaries as it moves → the
wire value of edge/translucent pixels oscillates by ~1 LSB frame-to-frame. This
is **correct sub-pixel rendering of moving content**, not a rasterization bug.

**AMPLIFIER — the delivery OETF's steep low end (the real lever).** At delivery
the working-space linear value is encoded to the target transfer by
`delivery_zscale_chain` (`color_space.rs:326-334`) → 10-bit
(`delivery_finishing_filter`, `delivery.rs:178-208`). PQ's inverse-EOTF is
steepest at the bottom of the range; HLG less so; BT.709/SDR least. The audit
measured, through production-reconstructed chains, that the **honest float
baseline (no composite lift at all) already swings 1–5 delivered codes per 1-LSB
input wobble** (PQ gain ≈ 4/4/2/2/1 across luminance bins, no-op baseline
5/3/3/2/1). That is the amplifier, and it is the delivery curve — *not* the
composite transport.

**fix C′ is NEUTRAL.** `composite_transport_encode/decode` (`color_space.rs:383`,
`:389`; spliced as `down`/`up` at `filtergraph.rs:643-652`) is a PQ round-trip
*inside* the composite that decodes back to linear before delivery. It tracks the
float baseline exactly. The old fix C (`÷32` linear headroom) had delivered-gain
**0.0** — an *accidental temporal dead-band* whose coarse linear bin swallowed
the sub-LSB wobble, which was the *same coarseness* that produced the 66-level
banding and 12.5° hue error. Reverting to it hides the crawl behind worse banding
= leveling down, off the table (memory: [[feedback_no_leveling_down]]).

**Why real footage looks fine and clean decorations don't.** Camera footage
occupies ~77% of the range and carries sensor noise of several codes σ that
*dithers* the same OETF quantization — the eye integrates unstructured noise and
sees no crawl. Decorations are **noise-free synthetic flat fills**, so the same
1–2-code oscillation is *spatially correlated and temporally structured*, which
is exactly what the visual system locks onto as "crawl/sparkle." This asymmetry
is the single most important fact for choosing a fix: the decorations don't need
*less* quantization error than footage — they need it to be *unstructured* like
footage's.

**Consequence for the ranking.** The source wobble is small and largely not-a-bug;
the amplifier is fixed colorimetry we will not bend; the difference between "looks
broken" and "looks like footage" is whether the residual quantization noise is
*structured*. That points the real fix at the amplifier seam (decorrelate the
crawl) or at acceptance (it may already be below threshold post-encoder-fix), and
points *away* from chasing the source.

---

## A. Fix-family analysis

Axes each family is scored on (from the brief): correctness risk · interaction
with npl=100 absolute space + ×2.03 SDR-origin anchor · SDR byte-stability · HLG
vs PQ behavior · testability.

### Family 1 — Stabilize the SOURCE (make the renderer flat fills temporally stable)

Concrete sub-options, each measured against "does it remove a ~1-LSB, 8-bit,
sub-pixel-motion wobble?":

- **Higher SSAA factor.** Averages more sub-samples, so each frame's *true*
  coverage average is finer-grained — but the readback is re-snapped to **8-bit**
  with the truncating box divisor (`nativeBackend.ts:262`, `:842-880`). Higher
  SSAA moves *where* the code boundaries fall; it does **not** lift the wire off
  the 8-bit grid, so the frame-to-frame ±1-LSB crossing survives. It reduces
  spatial aliasing (already handled, CANON §2.2) but is close to a **no-op on
  temporal stability**. Cost: framebuffer memory and the pixelRatio ≤ 8 addImage
  ceiling (`nativeBackend.ts:412`). Not worth it for this defect.

- **Carry the map wire at >8-bit.** The genuine version of "stabilize the source":
  a 16-bit (or float) readback would keep the coverage value off the coarse 8-bit
  grid, so the ×2.03 anchor + linearize + PQ-encode chain quantizes it *once* (at
  delivery 10-bit) instead of twice (8-bit wire, then 10-bit delivery). This
  shrinks the wobble but does **not** eliminate it: the delivery 10-bit
  quantization still crosses boundaries as the continuous value pans, and PQ's
  steep low end still amplifies it. Now-cheaper than it was — the renderer is
  in-process (no CDP 100 MB wire cap; [[project_renderer_frame_transport]] is
  obsolete post-cutover) — but it is a **wide** change: readback format, the box
  filter, `map_ingest_filter_for_delivery` input pix_fmt (`filtergraph.rs:704`),
  and every colorimetry byte-pin that assumes rawvideo `rgba` (the
  `ingest_map_matches_legacy` string at `color_space.rs:555`, the golden gate's
  8-bit premult contract at CANON §2.5). Correctness risk: **high** (touches the
  ingest anchor's input assumptions and the golden gate). SDR: would change SDR
  bytes too unless gated. Verdict: a real but partial lever with a large blast
  radius; **not first choice**, and even done perfectly it only *attenuates*.

- **Render decorations on a separate stable pass.** Does not help: the sub-pixel
  motion is in the *geometry-to-pixel-grid* mapping, so a decoration-only buffer
  still has moving AA edges, and translucent halos/pulse still must blend over the
  moving basemap somewhere. Isolating the pass changes nothing about the temporal
  variance and adds a compositing stage. Reject.

- **Is this the mbgl/Metal ±1-LSB boot wobble?** No — rule it out explicitly. That
  determinism bound (CANON §2.5, "Determinism bound") is **boot-to-boot**: two
  *worker processes* rendering an *identical* frame differ on 0–10 of 518,400 px.
  *Within one map instance* renders are byte-identical, and an export is one
  instance for all frames (`NativeBackend` holds a single `this.map`,
  `nativeBackend.ts:346`). The crawl is *frame-to-frame within one export*, driven
  by camera motion, so the boot-wobble is a different phenomenon and not the
  source. (It does mean the temporal gate in §B must render its frames through a
  single backend/ffmpeg invocation, not compare across processes.)

**Family 1 verdict: LOW value.** The source wobble is legitimate sub-pixel AA +
translucency, already at ~1 LSB (footage's own order of magnitude). The only
sub-option that attenuates at all (higher-bit wire) is a wide, high-risk change
that still leaves PQ-amplified residual. Do not lead here.

### Family 2 — Damp at the AMPLIFIER (a deliberate, documented temporal treatment)

This is where the mechanism says the lever is. Three shapes:

- **Temporal dead-band** (hold a pixel if it moved < ε vs last frame). This is
  *exactly what fix C did by accident* (gain 0.0), and it is leveling-down in a
  new costume: it also freezes real low-amplitude motion (slow pans, gradient
  crawl on the trail) and re-introduces stair-stepping. Architecturally hostile
  too — the export feeds frames one-at-a-time over stdin
  (`color_fixtures.rs:2653-2679` shows the per-frame pipe; the composite argv has
  no temporal filter state), so a dead-band needs a stateful FFmpeg temporal
  filter (e.g. `tmix`/`tblend` or a custom `lut`) inserted HDR-only. **Reject** on
  the leveling-down rule.

- **Temporal (spatiotemporal) dither before the delivery OETF.** The principled
  option. The crawl is visible because it is *structured*; footage's identical
  quantization is invisible because sensor noise *dithers* it. Add a small
  time-varying dither to the pre-delivery signal so the decorations' quantization
  decorrelates into footage-like grain instead of a coherent shimmer. Key
  distinctions and constraints:
  - **This is NOT the §5.1 dither debunk.** CANON §5.1 rejected `d=error_diffusion`
    as the headline fix for a *static banding* symptom **that nobody could
    reproduce** ("optimizing a symptom nobody observed", §4.7). Here the symptom
    is *observed, temporal, and root-caused*. Different symptom, different
    mechanism (temporal decorrelation vs spatial band-hiding). It must be framed
    that way in CANON or it will read as a re-proposal of a rejected idea.
  - **Static zscale dither is spatial, not temporal** (CANON §4.2: dither is only
    meaningful at a depth reduction, and zscale's is a within-frame pattern). A
    within-frame ordered/error-diffusion dither at the delivery 10-bit reduction
    *does* partially help because the pattern rides the moving content, but the
    clean temporal lever is an explicit time-varying noise (e.g. an FFmpeg `noise`
    injection of ≥1 delivered-code σ, or a frame-index-seeded ordered matrix) on
    the map-band signal *immediately before* `delivery_finishing_filter`'s OETF.
  - **HDR-only, SDR byte-stable.** Gate it on `hdr_delivery` exactly like `down`/`up`
    (`filtergraph.rs:643-652`) so SDR argv stays byte-identical (the standing SDR
    invariant, `composite_sdr_delivery_emits_no_anchor_and_no_transport`). SDR is
    clean anyway.
  - **Must keep the static gates green.** The dither amplitude has to sit under the
    hue/level tolerances (`<1°`, `≥250/256`) — a ≥1-code σ noise is well inside
    ~0.008 linear ramp spacing and averages to zero hue bias. Testable: the §B
    gate measures whether it actually reduced delivered temporal σ, and the static
    gates guard the ceiling.
  - **HLG vs PQ:** apply in the same working-space seam for both; PQ needs more of
    it (steeper amplifier) but a fixed pre-OETF σ is self-scaling because the OETF
    maps it into more delivered codes exactly where the crawl is worst.
  - **Interaction with npl=100 / ×2.03 anchor:** none, if injected in linear
    working space before the OETF — it is additive noise on values the anchor
    already produced; it does not move white or hue.
  - Correctness risk: **medium** — it's additive noise, reversible, gated, but it
    *does* raise the HDR noise floor (by design) and changes HDR bytes, so it
    needs the §B gate + the static gates + an eyeball before it lands.

- **Gentler shaping in the crawl-prone luminance band** (bend the delivery curve
  to be less steep at the bottom). **Reject** — that *is* the delivery colorimetry
  (the 0.58 PQ / 0.75 HLG reference-white anchoring the whole Phase 4 port fixed,
  CANON §1.5/§6.1). Bending it re-introduces the dark-map defect. Off the table.

**Family 2 verdict: temporal dither is the only real amplifier lever, MEDIUM
risk, HDR-only, gated.** It is the fix that makes decorations behave like the
footage that already looks fine — a "level the worse surface UP to the better
one" move, not down.

### Family 3 — Gate-and-accept (measure, compare to footage, decide visibility)

- **Re-eyeball first — severity may have changed and nobody has looked since
  `1345ded`.** Every prior eyeball of this crawl (2026-07-01) was through the
  `hevc_videotoolbox` path, which *also* crushed decoration chroma edges (CANON
  §3.3) — encoder mush sat **on top of** the quantization crawl. That path is gone
  (libx265 now). The crawl's *visibility* against a now-crisp encode is unmeasured.
  It could read as more prominent (no mush masking it) or as acceptable film-grain
  (crisp but low-amplitude). This is cheap and gates everything else.
- **Quantify vs footage sensor noise.** The §B gate produces exactly the number
  needed: delivered per-pixel temporal σ (in codes) for a flat decoration patch,
  side-by-side with the same measurement on a flat patch of *real HDR footage*.
  If decoration σ ≤ footage σ, the decorations are — by construction — no noisier
  than content the eye already accepts; the only residual issue is *structure*,
  which a sub-code temporal dither (Family 2) removes without raising σ to footage
  levels. This turns "is it acceptable" from taste into a measured comparison.
- Correctness risk: **zero** (measurement only). SDR/anchor/HLG-PQ: N/A. Testability:
  it *is* the test.

**Family 3 verdict: do this FIRST — it is free and may retire the defect.**

### Ranking & recommendation

| Rank | Family | Value | Risk | Blast radius |
|---|---|---|---|---|
| 1 | 3 — re-eyeball + quantify vs footage | high (may close it) | none | none |
| 2 | 2 — temporal dither at the amplifier, HDR-only, gated | high (targets the real lever, levels UP) | medium | delivery seam, HDR bytes |
| 3 | 1 — higher-bit map wire | partial (attenuates only) | high | ingest anchor + golden gate + pins |
| — | 1 — higher SSAA / separate pass | ~none | — | — |
| — | 2 — dead-band; 2 — curve shaping | negative (leveling down / breaks colorimetry) | — | — |

**Recommended sequence:**

1. **Build the §B temporal gate** (do this regardless — it is the missing oracle;
   nothing about the crawl should be allowed to go green blind again, and it
   produces the footage-comparison number).
2. **Re-eyeball HLG+PQ hand exports post-`1345ded`** (Matthew) and read the gate's
   decoration-σ-vs-footage-σ number. If the crawl is below threshold against the
   crisp encode → **accept, close Phase 4 on this defect, commit fix C′.**
3. **Only if still objectionable:** land a **HDR-only, pre-OETF temporal dither**
   (Family 2) sized by the gate to pull decoration σ *structure* down to footage
   behavior while staying under the static hue/level tolerances. Commit fix C′
   either way (the audit already cleared it; the crawl exists independent of it).

This sequence never degrades the clean SDR path, never bends the delivery
colorimetry, and treats "fix C′ ≈ float baseline" as correct throughout.

---

## B. Temporal gate spec — `composite_temporal_stability_bounds_decoration_crawl`

A new test in `src-tauri/tests/color_fixtures.rs`, modeled structurally on
`delivery_encode_preserves_decoration_chroma_edges` (`:2613`) — same "drive the
REAL production `build_composite_filtergraph` argv, tap `[vout]` with FFV1"
skeleton — and on the flat-patch helpers already present
(`run_working_space_color_path`, `decode_yuv420_planes`).

### B.1 What it asserts (in one sentence)

For a flat decoration patch fed a **controlled 1-LSB temporal wobble** at the map
wire, the **delivered-code temporal standard deviation** in the flat region,
divided by the injected input wobble (a **delivered/input gain**), lands inside a
per-target band whose **floor rejects the fix-C dead-band (gain 0.0)** and whose
**ceiling bounds visible crawl**, with the ordering **PQ ≫ HLG > SDR ≈ 0**, and
`float-baseline ≈ fix-C′` both PASS.

### B.2 Frames and the injected sub-LSB wobble (the teeth)

- Reuse `synth_decoration_map_frame`-style flat fills but simplify to a **uniform
  flat decoration patch** filling the map slot with one saturated decoration color
  (run the three probe colors of `composite_pq_transport_preserves_decoration_hue`,
  `:2390`, plus one near-black low-luma color — PQ's worst region). A uniform patch
  isolates the amplifier from spatial AA, which is what gives the gate clean teeth.
- **Injection:** the flat value **alternates between adjacent 8-bit codes
  frame-to-frame** — `v` on even frames, `v+1` on odd frames (a pure 1-LSB temporal
  square wave at the 8-bit wire). This is the controllable analogue of the real
  sub-pixel-motion wobble, feedable directly as the per-frame map stdin bytes (the
  loop at `:2669` writes a *different* frame each tick instead of the same one).
  Amplitude is exactly 1 code by construction, so the measured delivered σ *is* the
  gain, and any config that flattens it to ~0 (fix C's dead-band) is detected as
  anomalous.
- **N frames:** ≥ 16 (enough for a stable σ; the encode also needs a few GOP
  frames — reuse the `FRAMES + 2` pipe convention at `:2669`).
- Drive it through **the real argv per target** via `build_composite_filtergraph`
  (same call shape as `:2725-2739`) for `SdrH265`, `HdrHlg`, `HdrPq`. Include a
  **float-baseline variant** (a modified filtergraph with `down`/`up` forced empty
  — i.e. the honest no-lift chain) and, for the deadband teeth, a **fix-C variant**
  (splice a `colorchannelmixer=rr=0.03125…`/`×32` sandwich) built only inside the
  test so the gate can prove it *fails* the floor. These two variants are the
  calibration anchors, not shipped code.

### B.3 Staged decode taps (localize where the amplifier lives)

For each target build the argv once and tap it at four stages by re-`-map`-ing
intermediate labels + FFV1 (the `:2742-2757` tap technique, generalized):

1. **before transport** — tap `[map]` (post-ingest, pre-`down`): expect σ ≈ the
   input 1-LSB, linearized. Confirms the injector reached the working space.
2. **after transport** — tap `[vout_w]` (post-`up`, back in `gbrpf32le`): expect
   σ ≈ stage 1 (fix C′ is neutral — this is the "fix C′ ≈ float baseline" reading
   the record demands the gate treat as CORRECT). The **fix-C variant collapses σ
   here to ~0** → the dead-band, caught.
3. **after 4:2:0 finishing** — FFV1 tap of `[vout]` (post-`delivery_finishing_filter`,
   the delivery OETF + chroma subsample): this is where PQ's steep low end
   amplifies stage-2 σ into multiple delivered codes. **This is the amplifier
   stage** — expect PQ σ ≫ HLG σ > SDR σ.
4. **after delivery encode** — decode the delivered `.mp4` (`decode_yuv420_planes`,
   `:2548`): libx265 may add or smooth a little; the primary assertion is on stage
   3 (encoder-independent), with stage 4 as an informational secondary so encoder
   regressions surface too.

σ is computed **per pixel across the N frames, then averaged over the flat crop**
(temporal σ, not spatial): for each pixel, std-dev of its value over frames; mean
over the patch. Chroma planes are the decoration-relevant ones (near-zero luma
contrast, CANON §3.3), but measure Y too since the anchor lift touches luma.

### B.4 Assertions & calibration

- **Ordering (stage 3, per color):** `sigma_pq > k1 * sigma_hlg` and
  `sigma_hlg > k2 * sigma_sdr`, with `sigma_sdr ≈ 0` (a small absolute floor, e.g.
  SDR σ < 0.3 code). Encodes the measured PQ ≫ HLG > SDR ≈ 0 signature.
- **fix-C′ ≈ float-baseline (the correctness anchor):** `|gain_pq(fixC′) −
  gain_pq(float)| < tol` at stage 3 — the record's explicit requirement that the
  gate gates *delivered crawl amplitude, not the transport*. If fix C′ ever starts
  amplifying beyond the float baseline, that is the regression this catches.
- **Dead-band floor (teeth):** `gain_pq(config) ≥ g_lo` where `g_lo` is set so the
  **float baseline and fix C′ pass** (their gain ≈ 1–5 codes/LSB) but **fix C's
  gain-0.0 dead-band fails** (`g_lo` e.g. 0.8 codes/LSB). This makes "hiding the
  crawl behind banding" a hard failure — leveling-down is un-shippable by
  construction.
- **Crawl ceiling (soft, product-owned):** `gain_pq ≤ g_hi`. `g_hi` is the
  *visibility* threshold and is **Matthew's call** (§C) — seed it from the
  footage-σ comparison (B.5) and mark it clearly as the one taste-tunable number.
  If a temporal dither (Family 2) lands, this is the assertion that proves it
  reduced delivered structure.

### B.5 Footage baseline (turns acceptance into a measurement)

Add a companion measurement (same helper): decode a flat region of a **real HDR
clip** (or the existing HDR fixtures used by `hdr_video_round_trip_*`) and compute
its per-pixel temporal σ. Emit both numbers with `eprintln!` (like the crispness
gate's retention line, `:2786`). The gate does not *assert* on footage σ (it
varies by clip) — it **reports decoration-σ / footage-σ** so the visibility
decision is grounded.

### B.6 Loud preconditions (hard project rule — CANON §1.11)

`assert_ffmpeg_on_path()` + `assert_ffprobe_on_path()` + `assert_ffmpeg_has_zscale()`
+ `assert_ffmpeg_has_libx265()` (`:2468`) at the top — **panic, never skip**. A
box missing zscale/libx265 cannot produce a valid delivered HDR frame and the
suite must say so, exactly like the sibling gates.

### B.7 Why this can't go green while still crawling

The static gates pass on a single frame; this gate needs **≥16 frames with a known
inter-frame delta** and asserts on the *variance* of the delivered result. A
config that banded the crawl away (fix C) fails the dead-band floor; a config that
amplified it (a worse transport, or a delivery-curve regression) fails the ceiling
or the fix-C′-≈-float anchor. There is no green path that also crawls.

---

## C. Open questions for Matthew (only the genuinely his-call ones)

1. **Visibility acceptance — is the crawl shippable as-is against the crisp
   (`1345ded`) encode?** You have not eyeballed HLG/PQ since the encoder fix
   removed the VT mush that used to sit on top of the crawl. **Recommendation:**
   re-export HLG+PQ by hand, look; then read the §B gate's decoration-σ vs
   footage-σ number. If decoration σ ≤ footage σ and it reads as grain not
   shimmer, **accept and close** — this is the cheapest outcome and may be the
   right one.

2. **If not acceptable: authorize an HDR-only pre-OETF temporal dither?** It
   deliberately raises the HDR noise floor by a sub-code amount to trade *structured
   crawl* for *footage-like grain* — a level-up, SDR untouched, static gates held.
   **Recommendation:** yes, gated by §B, if and only if (1) fails the eyeball.

3. **Set the crawl-ceiling `g_hi` in the §B gate.** Everything else in the gate is
   mechanically derivable; the visibility ceiling is the one taste number.
   **Recommendation:** seed it at the measured footage-σ gain from B.5 and treat
   any future tightening as a look decision, not a code one.

4. **Commit fix C′ now, independent of the crawl?** The 2026-07-03 audit cleared
   it (true round-trip identity, static gates green, crawl exists with or without
   it). **Recommendation:** commit it — holding it does not help the crawl and
   leaves the tree carrying uncommitted color-lane hunks that entangle every other
   commit (PROGRESS notes this friction repeatedly).

---

## Adversarial verification (independent agent, 2026-07-07)

Attacked the analysis before implementation. Bottom line: the **diagnosis is
sound and the citations hold, but the recommended fallback fix (Family 2,
pre-OETF temporal dither) is empirically defeated by the delivery encoder**, and
the §B gate measures the wrong statistic to bound visible crawl. Steps 1–2 of the
sequence survive; step 3 does not, as specified.

### Verdict summary

| # | Claim | Verdict |
|---|---|---|
| 1 | Citation audit (every file:line) | **CONFIRMED** — all accurate |
| a | Higher SSAA ≈ no-op on temporal stability (wire re-snaps to 8-bit) | **CONFIRMED** |
| b | Crawl source = legit sub-pixel AA of geo-anchored decorations under pan | **CONFIRMED** (plausible; boot-wobble ruled out in code) |
| c | Amplifier = delivery OETF, PQ ≫ HLG > SDR | **CONFIRMED** (colorimetric) |
| d | Footage fine because sensor noise dithers the quantization | **CONFIRMED for footage** — but does NOT transfer to flat decorations (see e) |
| e | Pre-OETF temporal dither trades crawl for grain w/o the encoder undoing it | **REFUTED** (measured: libx265 crf17 zeros a ≤3-code flat dither) |
| §B | Temporal gate spec | **WEAKENED / partly REFUTED** — floor+anchor have teeth; "bounds visible crawl / no green path that crawls" is false |
| MA | Higher-bit-wire dismissal / ranking | **WEAKENED** — blast radius overstated; it out-ranks the dither once (e) falls |
| — | Overall sequence (build gate → re-eyeball → accept; else dither) | **WEAKENED** — steps 1–2 hold; step 3 (dither) must change |

### 1. Citation audit — CONFIRMED

Every cited line says what the report claims. Spot-checks that could have gone
wrong but didn't:

- `nativeBackend.ts:262-306` box filter: `n = factor²`, `half = n>>1`,
  `out = ((acc+half)/n)|0` — round-half-up, then truncate. Matches.
- The **GPU downsample** (`native/readback-downsample.patch:315-316`) uses
  `(sum + n/2)/n`, and the patch's own comment (`:284-286`) documents byte-identity
  to the JS filter via exact unorm→float recovery. So the report's premise for (a)
  — the on-GPU path re-snaps to the *same* 8-bit grid as the JS spec — is correct.
- `[vout_w]` **is a real label** (`delivery.rs:166-169`: finishing splices
  `[vout_w]{chain}[vout]`); the report did not invent it.
- FFV1 in this ffmpeg-full build **supports `gbrpf32le`** (`ffmpeg -h encoder=ffv1`),
  so the float-stage taps are pixel-format-feasible.
- Static-gate tolerances are exactly as cited: `pq_levels >= 250`
  (`color_fixtures.rs:2358`) and hue `delta < 1.0` (`:2429`).
- Single `this.map` per export (`nativeBackend.ts:346`) confirms the boot-wobble
  rule-out in (b): the crawl is intra-instance/inter-frame, a different phenomenon.

No stale or overstated citations found.

### 2(e). The temporal dither is REFUTED by the encoder — the load-bearing failure

The report roots Family 2 in (d): footage's sensor noise dithers the same
quantization, so add a footage-like dither to decorations. It flags encoder
interaction only in passing — §B.3 stage 4 says libx265 "may add or smooth a
little" and demotes the post-encode measurement to "informational secondary."
That inversion is fatal, because **the dither's entire purpose is a post-encode,
on-screen effect, and the decorations are flat fills — the worst case for
surviving a rate-controlled encoder.**

Measured directly (scratchpad probe, production HDR-PQ settings: libx265 main10
`veryfast` `crf 17` `cbqpoffs=-2:crqpoffs=-2`, 10-bit, flat low-luma patch, per-pixel
temporal σ measured on a 128² crop, 24 decoded frames after GOP warm-up):

```
DITHER σ_in=0.7:  per-pixel 0.74 -> 0.00  (  0% survives)
DITHER σ_in=1.5:  per-pixel 1.49 -> 0.00  (  0% survives)
DITHER σ_in=3.0:  per-pixel 2.94 -> 0.00  (  0% survives)
CRAWL 1-LSB sqr:  per-pixel 0.50 -> 0.50   coherent 0.50 -> 0.50  (survives intact)
```

At the report's proposed amplitude ("≥1 delivered-code σ"), libx265 **annihilates
the dither to exactly zero** on the flat decoration region, while the structured
1-LSB crawl analogue **survives perfectly**. The mechanism is the encoder's
frequency bias, and it runs exactly opposite to the fix: a uniform ±1-code shift
is a cheap DC residual the encoder keeps; per-pixel white noise is high-frequency
AC that AQ + flat-region prediction zero out first. So the encoder **preferentially
preserves the coherent crawl and discards the masking grain.** A dither validated
at stage 3 (pre-encoder, where the report puts the load-bearing assertion) is dead
at stage 4 (what ships). This defeats Family 2 *as specified* (pre-OETF, sub-/~1-code,
gated pre-encode). Larger amplitudes (σ=3 already died; going higher raises the
visible floor toward footage and abandons the "sub-code" framing), an ordered-matrix
variant (spatial structure = its own crawl, and still sub-quantization on flats),
or encoder de-tuning are all untested and face the same flat-region prediction wall.

Note this also bounds (d): footage noise survives because footage is *textured and
moving* (the encoder spends bits there); the identical mechanism does **not** rescue
noise injected onto flat synthetic fills. (d) is true for footage and does not
transfer to the fix.

### 3. §B gate — teeth in the right places, but it does NOT bound visible crawl

The gate is implementable and its **deadband floor** and **fix-C′≈float anchor** have
real teeth (both are amplifier-gain questions the ÷32 dead-band fails and float/fix-C′
pass; loud preconditions per §B.6 are correct and match the sibling gates). Keep those.

But the headline claims — §B.1 "ceiling bounds visible crawl" and §B.7 "there is no
green path that also crawls" — are **REFUTED**, for three independent reasons, the
first empirical:

1. **Wrong statistic.** The gate measures per-pixel temporal σ, averaged over the
   crop (§B.3). That is *amplitude*, blind to *spatial coherence* — which §0 itself
   says is what the eye locks onto. My probe proves the divergence: the invisible
   dither scores per-pixel σ = 11.9 while the visible crawl scores 0.50 — the gate
   would rank the *grain* 24× worse than the *crawl*, exactly backwards. The metric
   that tracks visibility is the temporal σ of the **spatial mean** (or the ratio
   `σ(frame_mean)/mean(per_pixel_σ)`): structured crawl → ≈1, dither → ≈1/√N. In the
   probe: crawl coherent σ = 0.50, dither coherent σ = 0.08. **The gate must measure
   coherent σ, not per-pixel σ, to have any bearing on crawl visibility.**
2. **Wrong stimulus.** §B.2 uses a *uniform* flat patch "to isolate the amplifier
   from spatial AA" — but spatial AA at edges/translucency *is* the crawl source (§0).
   A uniform patch measures amplifier gain; it does not reproduce the crawl's spatial
   structure, so it cannot answer "is the crawl visible."
3. **Wrong stage.** The primary assertion is pre-encode (stage 3). Per 2(e) the
   encoder materially changes flat-region temporal behavior, so a visibility/dither
   claim must live at stage 4.

Corrected framing: the §B gate is a **regression guard + reporting instrument**
(deadband floor, fix-C′ anchor, footage-σ number), not a crawl-visibility oracle.
Visibility stays the eyeball call Family 3 already makes. Downgrade §B.1/§B.7
accordingly and the gate is worth building.

Minor implementability note: intermediate taps `[map]` and `[vout_w]` are *internally
consumed* labels, so they cannot be tapped by the `:2742-2757` "re-`-map`" trick
(which works only because `[vout]` is terminal). Tapping them needs filter_complex
surgery (truncate at the label or insert `split`), not a changed `-map`. Stage 3
(`[vout]`, terminal) reuses the technique cleanly.

### 4. Missing alternative / ranking — higher-bit wire out-ranks the dither

The report's dismissal of the >8-bit map wire as "wide, high-risk, touches the
ingest anchor and golden gate" is **overstated**. The composite already ingests the
map via `map_ingest_filter_for_delivery` → zscale into `gbrpf32le`
(`filtergraph.rs:704-705`); zscale is pixel-format-agnostic on input, so feeding
`rgba64le` instead of `rgba` is a localized change to the rawvideo input pix_fmt +
the renderer readback format — the colorimetry strings (`ingest_map_matches_legacy`)
are about primaries/transfer/range, not bit depth, and need not change. The report
is right that it only *attenuates* (delivery 10-bit still quantizes once, PQ still
amplifies) — but it attenuates the **source amplitude that feeds the coherent crawl
the encoder preserves**, and unlike the dither it is not undone downstream. Given
2(e) removes the dither from contention, the ranking's #2 and #3 should **swap**:
if the eyeball (step 2) fails, the surviving levers are the higher-bit wire and/or
acceptance — not a pre-OETF dither.

### Corrections the implementing session MUST apply

1. **Do not implement the Family 2 pre-OETF temporal dither on the strength of a
   pre-encode gate.** Measured: libx265 crf17 zeros a ≤3-code flat-region temporal
   dither while preserving the structured crawl. If a dither is attempted at all, it
   must be proven to survive at **stage 4 (post-encode)** on a flat patch first.
2. **If you build the §B gate, measure coherent temporal σ (σ of the spatial mean),
   not per-pixel σ.** Per-pixel σ ranks the invisible grain worse than the visible
   crawl (11.9 vs 0.50 in probe). Keep the deadband floor and fix-C′≈float anchor
   (those are legitimately amplitude questions); drop the §B.1/§B.7 "bounds visible
   crawl / no green path that crawls" claim.
3. **Intermediate taps need graph surgery**, not a re-`-map` (only `[vout]` is
   terminal).
4. **Steps 1 (build the oracle, re-specified per #2) and 2 (re-eyeball + footage-σ
   compare) stand and are the right first moves.** Committing fix C′ (Q4) stands.
5. If step 2 fails the eyeball, evaluate the **higher-bit map wire** (attenuates the
   source, survives the encoder) or **accept** — not the dither.
