# Map/HDR color port — corrected, matrix-aware design

> Supersedes the implementation guidance in `FINDINGS.md` §"Application to the app".
> The spike's *physics* (SDR graphics must land at BT.2408 203-nit reference white) is
> correct, but it was validated in a pipeline shape the codebase does **not** use
> (`hstack` tiling with **separate per-branch finishing**). On the **real** codebase path
> (ingest → working-space overlay → **one shared finishing**) the situation is different
> and bigger. This doc is the empirically-grounded redesign.

## 1. What the codebase actually does, and why it's wrong (all measured)

Real composite path: each clip → working-space ingest; map → working-space ingest; both
overlaid in the **linear working space** (lifted to `yuv(a)444p10le` because `overlay`
can't consume float `gbrpf32le`); the result → **one** `delivery_finishing_filter`.

Measured facts (HLG target, `IMG_1137.MOV` + Abel's map frame, libx265 main10; HLG signal
read full-range, BT.2408 reference white = 0xBF = 191 = 75%):

| fact | measurement |
|---|---|
| zimg working linear is **absolute**: `1.0 = 100 nits` (SDR ref white), HDR sits **above 1.0** | HLG video ingest → working-linear **max ≈ 2.98** |
| The overlay lift `format=yuva444p10le` **clamps to [0,1]** = caps everything at **100 nits** | working-linear `2.98 → 1.0` through the lift |
| ⇒ in the real composite **both map and video are clamped to ~63%** (mutually coherent, both too dark) | video bright pixels all `161` (63%); map white `158-159` (62%) |
| zimg default HLG/PQ finishing npl = **100** | finishing `no-npl` ≡ `npl=100`, byte-identical |
| HDR round-trip needs **ingest npl == finishing npl** | HLG ingest`npl=400`→finish`default(100)` darkens `240→183`; ingest`npl=100`→finish`default` = **`240→239` identity** |
| The codebase mismatches them (ingest 400/1000 vs finish 100) ⇒ **video is independently darkened** *and* highlight-clamped | source `0xF0` → real composite `0xA1` (63%) |
| SDR-graphics→HDR anchor: **ingest gain ×2.03 + default finishing ≡ `npl=203` finishing** (HLG **and** PQ) | both → `0xC0` (75%) HLG / `0x95` PQ |
| Headroom rescale (`÷H` before lift, `×H` after) **preserves HDR** through the integer lift | round-trip `2.98 → 2.98` |
| `overlay` accepts **16-bit** intermediates | `yuva444p16le` / `gbrap16le` / `rgba64le` all OK |

**The spike's "map-only, video untouched" framing is invalid on the real path:** brightening
only the map would make it *brighter than the clamped video* — a new mismatch. The real defect
is that the whole HDR composite is clamped + npl-darkened (map and video equally). Per Matthew:
**correct the video too.**

## 2. The model (first principles)

The working space is **absolute linear light**, BT.2020 primaries, `gbrpf32le`, with
**linear 1.0 ≡ 100 nits** (SDR diffuse white). Everything else follows:

- **Ingest** places each source at its *true* luminance on that scale. SDR white → 1.0
  (100 nits). HDR decodes to its real nits (so highlights exceed 1.0). For zimg this means
  HDR ingest must use **`npl=100`** (the value that makes the scale absolute and that matches
  the finishing, so HDR round-trips).
- **Composite** happens in absolute linear light — map-over-video, splits, PIP blends all
  combine at physically correct relative luminance.
- **Delivery finishing** encodes the absolute working luminance to the target transfer.
  Because ingest npl == finishing npl (both 100), HDR video is reproduced unchanged.

**BT.2408 anchoring is a per-origin × per-delivery remap, not a map quirk.** Any *SDR-origin*
input (the map; an SDR-classified video clip; a future SDR title) delivered to an *HDR* target
must be scaled from its native 100-nit white to HDR graphics/diffuse reference white
**203 nits** → linear gain **203/100 = 2.03**. HDR-origin inputs carry their own absolute nits
and are never anchored.

## 3. The full input × output matrix

Source transfer (rows) × delivery transfer (cols). "anchor" = ×2.03 SDR→HDR ingest gain.

| source ↓ \ delivery → | **SDR** (H.264/H.265/ProRes) | **HDR** (HLG / PQ) |
|---|---|---|
| **SDR** video | native: white→100nit→SDR white. **no anchor.** ✓ (unchanged today) | **anchor ×2.03** → 203nit diffuse white |
| **HLG / PQ** video | ingest npl=100 → absolute; SDR finish clips >1.0 (**tone-map gap**, §6) | ingest npl=100 → finish(default 100) = **round-trip, FIXED** |
| **map** (always sRGB / SDR-origin) | white→100nit→SDR white. **no anchor.** ✓ (already correct) | **anchor ×2.03** → 203nit |

The map column is just the "SDR source" row — the anchor is one rule covering both.

## 4. Corrected pipeline — four changes

### (A) Absolute working space — HDR ingest `npl = 100`
Registry: `default_npl_for(Hlg|Pq)` → `100` (today 400 / 1000). Makes the working space
absolute and — because finishing is already `npl=100` (default) — makes **HDR video round-trip
exactly** (fixes the darkening). Verified `240→239`. No finishing change required for this.

### (B) Per-origin BT.2408 anchor — SDR-origin → HDR delivery, gain ×2.03
Registry concept (atomic, sits beside `default_npl_for`):
```rust
pub const SDR_REF_WHITE_NITS: f64 = 100.0;      // zimg SDR diffuse white = linear 1.0
pub const HDR_REF_WHITE_NITS: f64 = 203.0;      // BT.2408 HDR graphics/diffuse white

/// Linear-light gain anchoring an SDR-origin source to the delivery's reference white,
/// applied in the working space on the SDR-origin INGEST branch only (so the HDR video
/// branch — which shares the one finishing — is untouched). None ⇒ no scaling.
pub fn sdr_origin_anchor_gain(source: &ColorSpace, delivery: &ColorSpace) -> Option<f64> {
    (!source.transfer.is_hdr() && delivery.transfer.is_hdr())
        .then(|| HDR_REF_WHITE_NITS / SDR_REF_WHITE_NITS)   // 2.03
}
```
Applied as a linear gain at the tail of the ingest chain. `ingest_zscale_chain` /
`map_ingest_filter` gain the source by this factor when it returns `Some`. Proven equivalent
to `npl=203` finishing for HLG and PQ, so it reproduces the spike's verified result while
leaving the video branch alone.

**Gain filter: `colorchannelmixer` chain ONLY** — via the registry helper
`linear_gain_filter(factor)` (same helper fix (C) uses). NOT `geq` (Session 4 measured it
**clamps output to [0,1]**, so ×2.03 on map white 1.0 → 1.0 — silently inert), and NOT
`exposure` (caps at ±3 stops = ×8 max — fine for 2.03 alone but the shared helper must also
emit ÷32/×32 for (C), which `exposure` can't reach). `colorchannelmixer` is clamp-free for
values >1.0 but caps each `rr`/`gg`/`bb` coefficient at ±2.0, so 2.03 decomposes into the
two-stage chain `[2.0, 1.015]` (2.0 × 1.015 = 2.03). See §4C and the helper spec in
`IMPLEMENTATION.md` for the decomposition rule.

> **Threading:** ingest must now know the **delivery** ColorSpace. `ingest_filter_for` /
> `map_ingest_filter_into` gain a `delivery: &ColorSpace` argument. Composes with per-clip
> override + project working space (v9): override changes the *source* axes, working space is
> the *destination*, anchor depends on (source.is_hdr, delivery.is_hdr) — all three orthogonal.

### (C) Composite intermediate must preserve the HDR range (the clamp fix)
`overlay` can't take float, and the current `yuva444p10le` lift clamps the absolute range
(up to ~24.6 with npl=100) to 100 nits. Fix the lift to carry the full range via **headroom**:
`÷H` before the lift (float), `×H` after (float), so values >1.0 survive the integer lift.

> **⚠️ PREMISE OVERTURNED — Session 4 (see `SESSION4_FINDINGS.md`).** The "preferred 16-bit"
> design below is **physically impossible** and is corrected here. Empirically:
> - **`overlay` caps at 10-bit.** Its `format` enum tops at `yuv444p10`; feeding `yuva444p16le`
>   makes FFmpeg **silently auto-insert a scaler down to `yuva444p10le` before the overlay**
>   (verbose-confirmed). `gbrap16le` is accepted *and corrupts the value* (0.15 → 0.0625).
> - **No float positioned compositor exists.** `maskedmerge` and `blend` both process
>   `gbrpf32le` but **clamp to [0,1]** (bright HDR pixel → crushed to 100 nits).
> - ⇒ The only achievable HDR-preserving composite is **10-bit `yuva444p10le` + headroom**.
>
> **Corrected (C):**
> - Lift to **`yuva444p10le`** (unchanged from today's pixel format) with **headroom** carried
>   in float around it: `÷H` before each lift, `×H` after the post-overlay return to
>   `gbrpf32le`. `overlay` stays `format=yuv444p10`.
> - **Gain filter:** `colorchannelmixer` ONLY. `geq` clamps output to [0,1] (so any gain >1 is
>   crushed — the handoff wrongly listed it usable for ×2.03); `exposure` caps at ±3 stops (×8,
>   can't reach ÷32/×32). `colorchannelmixer` is clamp-free for values >1.0 but caps each
>   coefficient at ±2.0, so a factor >2 is emitted as a **chain** of ≤2.0 stages (the chain does
>   NOT clamp at the stages that cross 1.0 — verified). Use the registry helper
>   `linear_gain_filter(factor)` for both this and the (B) anchor.
> - **`H = 32`, not 16.** Real iPhone HLG peaks at linear **24.6** at npl=100 (the design's
>   assumed ~12 was wrong) → H=16 would CLIP real footage. H=32 covers HLG + PQ-to-~3200-nit.
>   PQ 100%-white (10000 nit) = linear ~108, so PQ content above ~3200 nit clips — a flagged
>   known bound (§6), same class as the HDR→SDR tone-map gap. (Future option: choose H
>   per-export from the source classes present.)
> - **Headroom is GATED to HDR delivery.** SDR delivery has no >1 values; applying H=32 there
>   bands SDR (gradient 209 → 85 levels). Gate: `delivery.transfer.is_hdr()`.
> - **Banding is fine.** 1024-step gradient distinct output levels: 608 (no-composite ceiling),
>   606 (16-bit+headroom ideal), **381 (10-bit+headroom, achievable)** — all far above the
>   visible-banding threshold (~64–128). The original rejection of 10-bit+headroom was overstated.
> - **All paths validated:** unmasked PIP, masked alphamerge edge, Split (setparams bg) — map
>   white lands at 0xC0 = 75% = 203-nit ref white; HDR video round-trips; masked edge blends
>   coherently inside the ÷32/×32 headroom.

**Superseded original text (kept for the record):** lift to a 16-bit overlay format and carry
headroom; alternatives 10-bit+headroom (thought to band) and npl=1000 normalization rejected.

### (D) HQ chroma subsample split (spike lever 1 — free ~25% edge recovery)
In `delivery_finishing_filter`, for 4:2:0 targets, split the fused matrix+decimation:
```
…:r=limited,format=yuv444p10le,scale=flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp,format=yuv420p10le
```
Video-safe (no color change), survives libx265. Applies wherever `finishing_pix_fmt` is 4:2:0
(HDR `yuv420p10le`; the 8-bit SDR `yuv420p` analogously — verify).

## 5. Why this composes / stays registry-shaped
- One new registry concept (`sdr_origin_anchor_gain`) + one constant change (`default_npl_for`).
- Anchor + npl + subsample are independent of per-clip override and project working space.
- Every generated chain stays byte-asserted (§ tests) and verbose-dry-run-verified (zimg
  silently fuses scalers — mandatory per project rule).

## 6. Known gaps (flag, don't silently cap)
- **HDR source → SDR delivery.** With the absolute working space, HDR highlights (>1.0) hit the
  SDR finishing and **hard-clip** to SDR white (blown highlights). ~status quo (today's lift
  clamps too) but now explicit. Proper fix = a tone-map operator (zscale `tonemap` /
  libplacebo) on the HDR→SDR delivery. Follow-up, not silent clipping. (No leveling-down: don't
  degrade the HDR→HDR path to hide this.)
- **PQ highlights above the composite headroom (Session 4).** The composite headroom `H=32`
  (§4C) clips working-space values above 32, i.e. PQ content brighter than ~3200 nits (PQ
  100%-white = 10000 nit = linear ~108). Typical HDR10 masters (1000 nit ≈ linear 10, 4000 nit
  ≈ linear 43 — partial clip) are mostly within H=32. Raising H protects extreme PQ but bands
  the map (precision is a fixed map/H ratio). Recommend H=32 + this flag; revisit with
  per-export-dynamic-H or tone-mapping if real PQ footage clips visibly.

## 7. Decisions
**Answered (DECIDED — Matthew has confirmed npl=100):** working-space normalization =
**npl=100** (confirmed — not "recommended", not pending; npl=1000 is OFF the table). Land
A+B+C+D together; HDR→SDR tone-mapping = follow-up; correct the HDR video too.

**Settled by Session 4 empirics (no longer open — physics decided them):**
1. **Composite intermediate (C):** 16-bit was the approved choice but is **physically
   impossible** (overlay caps at 10-bit; float compositors clamp). Achievable = **10-bit
   `yuva444p10le` + headroom**, measured perceptually equivalent (381 vs 606 gradient levels).
   This is a forced substitution, not a free choice — flagged to Matthew, proceeding unless he
   redirects.
2. **Headroom `H`:** `H=32` (real HLG peak 24.6 > the assumed 12 that motivated H=16).
3. **Headroom gating:** only for HDR delivery (`delivery.transfer.is_hdr()`); SDR delivery keeps
   today's plain lift (headroom would band SDR 209→85 levels).
4. **Gain filter:** `colorchannelmixer` chain via `linear_gain_filter()`; NOT `geq` (clamps)
   or `exposure` (±3 cap).

**Still genuinely open for Matthew:**
- PQ-above-~3200-nit composite clip (§6) — accept as flagged bound, or invest in
  per-export-dynamic-H / HDR→SDR tone-map. Low urgency (no PQ source footage in hand).

## 8. Validation plan (deliverables 4 & 5)
- **Loud unit tests** (extend `color_fixtures.rs` + `color_space.rs` byte-equality):
  generated ingest chain carries `npl=100` + (for SDR→HDR) the ×2.03 gain; finishing carries
  the subsample split; SDR delivery + HDR video chains regression-pinned.
- **Verbose dry-run** of the real composite (every matrix cell) confirming the emitted chains
  and **no silently-inserted scaler** (loglevel verbose).
- **Re-validate in the spike harness on the TRUE single-finishing composite path** (not the
  old `hstack`): map white → 75%, HDR video round-trip identity, SDR delivery unchanged,
  map↔video seam coherent at the 203-nit reference.
