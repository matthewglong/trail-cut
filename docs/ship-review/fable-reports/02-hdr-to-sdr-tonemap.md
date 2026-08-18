# HDR→SDR Tone-Map — Design Report

**Status: PROPOSED (decision-grade). Phase 5 Oracle lane, first slice.**
**Scope: the tone-map operator that tames HDR-origin footage when it is delivered to an SDR target (`SdrH264` / `SdrH265`). Nothing else in the color pipeline changes.**

Author context: written against `docs/CANON.md` §1 (BINDING), the atomic-axes registry
(`src-tauri/src/util/color_space.rs`), and the export filtergraph. All ffmpeg claims below
were probed on the local ship-target build (`ffmpeg-full` 8.1.1, `--enable-gpl
--enable-version3 --enable-libplacebo --enable-libzimg`, no `--enable-vulkan`).

---

## TL;DR recommendation

1. **Splice point: per-clip ingest tail, SDR-delivery-gated, HDR-origin-only.** A new
   registry helper `sdr_tonemap_filter(source, delivery) -> Option<String>` that returns
   `Some(...)` **iff** `source.transfer.is_hdr() && !delivery.transfer.is_hdr()` — the exact
   mirror of the existing `sdr_origin_anchor_gain` (color_space.rs:408). It splices in
   `clip_chain::build_clip_video_subgraph` right where the ×2.03 anchor already splices
   (clip_chain.rs:164-168). This touches **only HDR-origin footage**; the map canvas, SDR
   clips, and every decoration stay byte-exact. Post-composite finishing was analyzed and
   **rejected** — it moves map/decoration colors that must not move (proven below).

2. **Operator: `tonemap=mobius`, explicit `peak`, `desat=0`.** Not `hable` (darkens the
   whole midrange), not `zscale` (has **no** tone-map operator — the "zscale tonemap" in the
   brief does not exist), not `libplacebo` (**fails on macOS** — no Vulkan driver, probed
   below). Mobius is near-identity below a transition and only compresses near the peak —
   the right behavior for outdoor footage that is mostly diffuse-SDR-range with highlight
   excursions in sky/snow/specular. Empirically it holds diffuse white at ~84% while status
   quo blows every value ≥1.0 to 100%.

3. **Oracle first.** Land `hdr_to_sdr_highlight_clip_baseline` (red-by-design, pins today's
   clip on a decoded highlight ramp) before the change, exactly like the
   `hdr_reference_white_tracer_*` pattern (color_fixtures.rs:1711).

4. **Invariants preserved.** `delivery_never_emits_npl` untouched (tone map is ingest-side,
   uses no npl). The ×2.03 anchor and fix-C′ PQ transport are in disjoint matrix cells and
   never co-fire with the tone map.

5. **Preview convergence (task 120).** The preview chains already tonemap (Hable), but at
   `npl=400/1000` (ffmpeg.rs:104-117). Recommend converging them onto the same
   `mobius`/npl=100-absolute operator so the preview faithfully shows the export look. This
   closes the proxy-npl divergence ledger item.

---

## A. Where the tone map belongs

### The problem, stated in working-space terms

The working space is linear-light BT.2020 at **npl=100 absolute** (linear 1.0 = 100 nits =
SDR diffuse white; color_space.rs:180-186, 349-352). HDR-origin footage is ingested with
true HLG/PQ linearization at npl=100 and therefore carries values **well above 1.0** —
CANON §1.12 and the composite comment (filtergraph.rs:625) both put HLG at "linear up to
~24.6", PQ up to 100. For an **SDR** delivery target:

- `sdr_origin_anchor_gain` returns `None` for HDR-origin sources (color_space.rs:408-411),
  so the footage is **not** anchored — it keeps its true >1.0 nits.
- The composite transport (fix C′) is gated `hdr_delivery` (filtergraph.rs:643-652), so on
  SDR delivery it is a no-op — the footage stays float and un-lifted.
- `delivery_finishing_filter(SdrH265)` = `zscale=t=bt709:...,format=yuv420p`
  (delivery.rs:192-206). The BT.709 OETF **hard-clips every input ≥ 1.0 to white.**

Empirically confirmed (raw gbrpf32le ramp, linear 0→4, through the real SDR finishing
chain): linear 1.0 → luma **253**, and linear 2.0, 2.5, 3.0, 3.5, 4.0 **all → 255**. Every
distinct highlight level above diffuse white collapses to the same clipped white. That is
Matthew's "blown out."

The fix must compress the >1.0 range into [0,1] **for SDR delivery only** (HDR targets must
keep the full range — CANON §1.9, no leveling down).

### Option 1 — per-clip ingest, SDR-gated, HDR-origin only (RECOMMENDED)

Splice a `tonemap` filter at the ingest tail of the HDR-origin clip subgraph, in exactly the
slot the ×2.03 anchor uses today (clip_chain.rs:156-171). Gate it with a new helper that is
the mirror of the anchor:

```rust
// color_space.rs — new, sits next to sdr_origin_anchor_gain
pub fn sdr_tonemap_filter(source: &ColorSpace, delivery: &ColorSpace) -> Option<String> {
    (source.transfer.is_hdr() && !delivery.transfer.is_hdr())
        .then(|| tonemap_filter_string(source.transfer)) // e.g. "tonemap=mobius:peak=6:desat=0"
}
```

```rust
// clip_chain.rs — appended after the anchor splice (mutually exclusive with it by construction)
let tonemap_csv = crate::util::color_space::sdr_tonemap_filter(&source_cs, &inputs.delivery)
    .map(|f| format!(",{f}"))
    .unwrap_or_default();
// ...,{ingest}{anchor_csv}{tonemap_csv},format={pix}[v{idx}]
```

Consequences:

- **The map is never tone-mapped.** The map ingest (`map_ingest_filter_for_delivery`,
  color.rs:483) has no tone-map branch — decorations are byte-exact vs today. This is the
  strongest possible answer to the brief's "the map must NOT get tone-mapped."
- **SDR clips are never tone-mapped** (`source.transfer.is_hdr()` is false).
- **HDR-target deliveries are untouched** (`!delivery.transfer.is_hdr()` is false → `None`).
- The composite then blends HDR footage that has **already been compressed to [0,1]** against
  the map (also ≤1.0). The linear-light overlay (CANON §4.4) now mixes two SDR-range
  operands, so anti-aliased decoration edges no longer get a >1.0 luminance bleed from the
  footage underneath — arguably *more* correct than compositing raw HDR against SDR graphics.
- Mixed timelines (one HLG clip + one SDR clip in the same SDR export) land uniformly: the
  HLG clip's diffuse white maps to ≈ SDR white (see peak tuning in §B), the SDR clip passes
  through at 1.0. A small residual diffuse-white offset is possible and is bounded by the
  peak choice (open question E1).

### Option 2 — post-composite finishing, SDR-gated (ANALYZED, REJECTED)

Splice the tone map between `[vout_w]` and the delivery zscale inside
`delivery_finishing_filter` (delivery.rs:178-210), or just before it in the composite
assembler (filtergraph.rs:801-804), gated on SDR delivery.

Why it fails — **it moves colors that must not move:**

- For SDR delivery the map sits at **linear 1.0** (no ×2.03 anchor — verified by the
  existing gate `sdr_delivery_map_white_stays_at_sdr_white`, color_fixtures.rs:1814).
  Decoration colors are sRGB-origin, gain 1.0, all within [0,1].
- A global tone-map shoulder (hable/mobius) does **not** leave 1.0 fixed. Measured: mobius at
  peak=10 maps diffuse white **1.0 → 215/255 (0.84)**; hable maps **1.0 → 158/255 (0.62)**.
  Applied post-composite, that pulls **map white and every decoration** down by 16–38% and
  shifts saturated decoration hues — the exact "distorts UI colors supposed to sit at
  reference white" hazard the brief flagged. Confirmed, not hypothetical.
- Even a bespoke "identity below 1.0" shoulder can't save it: linear-light compositing has
  **already** blended >1.0 footage into decoration AA edges before the finishing stage, so
  edge pixels would be tone-mapped while interior decoration pixels are not — visible edge
  ringing on graphics.

Post-composite is both harder to make correct and strictly worse. Rejected.

**Recommendation: Option 1.**

---

## B. Operator choice

Probed on the ship-target build. Two of the five brief candidates are eliminated outright:

| Candidate | Verdict | Evidence |
|---|---|---|
| **zscale `tonemap=…`** | **Does not exist** | `ffmpeg -h filter=zscale` has **no** tonemap option; zscale is a colorspace/resize converter only. The "zscale tonemap" in the brief is a misconception. |
| **libplacebo** (bt.2390/spline, peak-detect) | **Unusable on macOS** | Filter present, but running it fails: `VK_ERROR_INCOMPATIBLE_DRIVER … Failed creating Vulkan device`. The brew build has `--enable-libplacebo` but **not** `--enable-vulkan`, and macOS has no native Vulkan. GPU non-determinism would also break the decoded-frame gate. Fallback/future only. |
| **`tonemap` filter** (reinhard/hable/mobius) | **RECOMMENDED** | Pure libavfilter core (no external dep, in every build incl. a future LGPL bundle), CPU, deterministic. Operates on `gbrpf32le` in linear light — slots into the working space with no zimg 3074 and no fatal auto-scaler (verbose dry-run clean). |
| **`tonemapx` / other native BT.2446-A** | **Not present** | `Unknown filter 'tonemapx'`. No native BT.2446-A operator in libavfilter. Would require a hand-built `lut`/`geq` curve. |
| **generated `lut`/`geq` curve** | Fallback | Deterministic and buildable, but hand-rolling a shoulder reinvents mobius/hable with more maintenance surface. Use only if a specific curve is mandated. |

### Why `mobius`, not `hable`

Both give monotonic highlight rolloff. They differ in what they do to the **diffuse** range
(everything ≤ 1.0), which for TrailCut's content is most of the frame. Measured through the
real SDR finishing chain, working-space linear ramp with a 1000-nit (linear 10.0) peak:

| linear in | status-quo **clip** | **hable** (peak 10) | **mobius** (peak 10) | **mobius** (peak 6) |
|---:|---:|---:|---:|---:|
| 1.02 (diffuse white) | 253 | 158 | **215** | **219** |
| 2.00 | 255 | 192 | 235 | 241 |
| 4.00 | **255 (clipped)** | 224 | 247 | 255 |
| 6.00 | **255 (clipped)** | 240 | 252 | 255 |
| 10.00 | **255 (clipped)** | 255 | 255 | 255 |

- **clip** loses all detail above diffuse white — the defect.
- **hable** applies a filmic S-curve across the *whole* range, dragging a normally-exposed
  scene's diffuse white down to 62%. For content that is already mostly within SDR range,
  that reads as muddy/dark — trading "blown out" for "underexposed."
- **mobius** is near-identity through the diffuse range and only bends near the peak: diffuse
  white stays bright (84–86%) while sky/snow/specular highlights compress monotonically.
  This preserves the look and tames only what needs taming — the correct default for outdoor
  hiking footage.

**`peak` must be set explicitly.** The default `peak=0` is per-frame auto-detection, which
(a) pumps brightness frame-to-frame as the scene's max luminance changes and (b) is
non-deterministic, breaking any decoded-frame gate. Set peak from the source transfer:
`tonemap_peak_for(Hlg) = 6.0`–`10.0` (600–1000 nits at npl=100), `Pq` from mastering
`MaxCLL` when probed else the same default. Lower peak = diffuse white better preserved,
harder clip at the very top; higher peak = more highlight headroom retained, diffuse white
slightly darker. This is the aggressiveness dial (open question E1).

**`desat`** (default 2.0; preview uses `desat=0`) controls per-channel hue behavior on
near-clip colors. `desat=0` keeps colors vivid but can hue-skew a channel that clips before
the others (e.g. a saturated sunset skewing toward yellow); a small `desat` pulls near-clip
colors toward white to hold hue. Start at `desat=0` to match the preview, and let the
memory-color hue gate (§C, gate 2) decide whether to raise it.

**Registry fit.** The tone map is a `tonemap` filter, not a zscale string, so it does **not**
flow through `delivery_zscale_chain` (that generator stays untouched and npl-free). It lands
as one small generator `sdr_tonemap_filter` beside `sdr_origin_anchor_gain`, with the
operator/peak/desat constants defined in one place — the same "one concept, one location"
shape as `X265_DELIVERY_TUNING` (delivery.rs:393) and the anchor gain. Adding it is a
color_space.rs addition + one splice line in clip_chain.rs; nothing in `delivery.rs` changes.

**Fallback.** If mobius/hable are ever judged insufficient, the fallback is a generated 1D
`lut`/`geq` shoulder (deterministic, dependency-free). libplacebo `bt.2390` is a *future*
option contingent on a Vulkan-enabled bundled ffmpeg (task 130) — do not depend on it for
ship.

---

## C. Oracle-first test plan (`color_fixtures.rs` style)

All tests: real production argv, decoded pixels, loud preconditions, no silent skips (CANON
§1.11). Add one precondition helper beside `assert_ffmpeg_has_zscale` (color_fixtures.rs:63):

```rust
fn assert_ffmpeg_has_tonemap() { /* panic if `ffmpeg -filters` lacks " tonemap " */ }
```

### Oracle (land BEFORE the change)

**`hdr_to_sdr_highlight_clip_baseline`** — red-by-design, mirrors the tracer pattern
(`hdr_reference_white_tracer_*`, color_fixtures.rs:1711-1725). Synthesize an HLG (and PQ)
source whose luma ramps from diffuse white up through the highlight range, run the **real**
`HLG → SdrH265` composite/finishing argv, decode the delivered luma, and assert the current
defect: **≥ N distinct input highlight levels above diffuse white decode to the same clipped
value (255).** This passes today (documenting the clip) and is the frame against which the
fix's monotonicity gate is measured; graduate it into the main job when it flips green, like
the reference-white tracer did.

### Post-change gates

1. **Highlight-rolloff monotonicity** — decode an `HLG → SdrH265` (and `PQ → SdrH264`) export
   of the highlight ramp; assert delivered luma is **strictly monotonic non-decreasing with
   no plateau at 255** across the input highlight levels. The direct anti-clip gate; inverts
   the oracle.

2. **No hue skew on memory colors** — synthesize sky-blue / foliage-green / snow-white / skin
   patches at HDR levels, deliver HDR→SDR, decode, and assert each patch's hue is within a
   bounded ΔH (e.g. ≤ 3–5°) of a colorimetric reference. This is the gate that ratifies the
   `desat` choice.

3. **SDR-origin footage is a byte no-op** — an SDR clip → `SdrH265` export must be **MD5-
   identical** with the tone-map code present, because `sdr_tonemap_filter(SDR_src, SDR_dst)`
   is `None`. Pin `None` directly as a unit test too (mirrors
   `sdr_origin_anchor_gain_none_for_sdr_delivery`, color_space.rs:701).

4. **HDR-target deliveries are a byte no-op** — an `HLG → HdrHlg` export **MD5-identical**
   with and without the tone map (it fires only on SDR delivery). Unit-pin
   `sdr_tonemap_filter(HLG_src, HDR_dst) == None`.

5. **Decoration / map colors unmoved** (the splice-choice gate) — composite a pure-white map
   frame + saturated decoration colors over an HDR clip to `SdrH265`; assert the decoded map
   white and decoration hues are **identical** to a build without the tone map. Because the
   splice is per-clip-ingest, the map path is literally untouched — this gate makes that
   structural fact observable and guards against a future regression that moves the tone map
   post-composite.

6. **Verbose scaler audit** — run the real composite argv with the tone map spliced under
   `-loglevel verbose` and assert **no `auto_scale_*` insertion** around `tonemap` and **no
   zimg code 3074** (standing rule, CANON §4.1). The float working space already carries
   `tonemap` in-domain, so a clean graph is expected; the gate makes silent regressions loud.

7. **String pins** — byte-pin the generated `sdr_tonemap_filter` output for each HDR source ×
   SDR delivery cell (mirrors `composite_transport_round_trip_strings`, color_space.rs:725),
   and the clip-subgraph tail order `…{ingest}{tonemap},format=gbrpf32le[v0]`.

---

## D. Interaction audit

| Existing mechanism | Touched? | Reasoning |
|---|---|---|
| **×2.03 SDR-origin anchor** (color_space.rs:408, clip_chain.rs:164) | **No** | Anchor fires on SDR-src→HDR-dst; tone map fires on HDR-src→SDR-dst. **Disjoint matrix cells** — they can never co-fire on one stream. The tone-map splice sits adjacent to the anchor splice but is mutually exclusive with it by the `is_hdr()` guards. |
| **Fix C′ PQ composite transport** (color_space.rs:383, filtergraph.rs:643) | **No** | Gated `hdr_delivery`; the tone map is gated `!hdr_delivery`. Disjoint on delivery. On SDR delivery the transport is already a no-op, unchanged. |
| **`delivery_never_emits_npl` pin** (color_space.rs:595) | **No** | The `tonemap` filter is ingest-side and takes **no npl** at all. `delivery_zscale_chain` is not modified. Pin stays valid. |
| **Proxy/thumbnail npl preview divergence** (ffmpeg.rs:104-117, 402-412) | **Yes — recommend converging** | The preview already tone-maps (Hable, `desat=0`) but at `npl=400/1000`, not the npl=100 absolute space, and with a different operator than proposed here. For preview≡export parity (task 120), bring the preview onto the **same operator + npl=100-absolute + explicit peak**. This is a genuine, in-scope touch: it closes the divergence ledger item and lets Matthew tune aggressiveness against a faithful preview. (The preview scales in linear light already — ffmpeg.rs:104 — so only the npl and operator/peak constants change.) |

---

## E. Open questions for Matthew (product calls)

1. **How aggressive should the highlight rolloff look?** This is the operator + peak choice.
   My recommendation: **`tonemap=mobius:peak=6:desat=0`** — diffuse white preserved (~86%),
   sky/snow highlights compress smoothly, colors stay vivid. Alternatives to eyeball on real
   hand exports: `peak=10` (more highlight headroom, diffuse white a touch darker), or
   `hable` (more filmic/darker mids — closer to a "cinematic" look if you want the whole
   image toned down, not just the highlights). Decide on 2–3 real HDR hiking clips.

2. **Change the preview to match now, or defer to task 120?** Recommend **now** — it is a
   constants-only change to the existing preview tone-map chains, closes the proxy-npl
   divergence, and gives you a faithful preview while tuning E1. The alternative (leave
   preview at Hable/npl=400 until task 120) means you'd be tuning the export blind.

3. **`desat` / hue safety.** Recommend **`desat=0`** to start (matches the preview, keeps
   colors saturated), and only raise it if the memory-color hue gate (§C gate 2) fails on
   real content. The tradeoff: `desat=0` risks a hue skew where one channel clips before the
   others (vivid sunsets); a small `desat` trades a little highlight saturation for hue
   stability. Data-driven, so I'd let the gate decide rather than pre-commit.

---

## Appendix — empirical probes (ship-target `ffmpeg-full` 8.1.1)

- **`tonemap` operators:** none, linear, gamma, clip, reinhard, hable, mobius. Params:
  `tonemap`, `param`, `desat` (default 2), `peak` (default 0 = auto).
- **`zscale`:** no tonemap option (confirmed absent). **`tonemapx`:** not a filter.
- **`libplacebo`:** present but runtime-fails on macOS — `VK_ERROR_INCOMPATIBLE_DRIVER`,
  no Vulkan device (build lacks `--enable-vulkan`).
- **Status-quo clip (raw linear ramp → real SDR finishing):** linear 1.0 → luma 253; linear
  2.0/2.5/3.0/3.5/4.0 → 255 (all clipped). Highlight detail above diffuse white is lost.
- **Operator comparison (linear-10-peak ramp → SDR):** see §B table. Mobius holds diffuse
  white at 84–86%; hable at 62%; both roll off highlights monotonically.
- **`peak` explicit vs auto:** identical only when the frame max equals the explicit peak;
  auto is per-frame (temporal pumping) and non-deterministic → must be set explicitly.
- **Graph validity:** `tonemap=…` on `gbrpf32le` in the linear working space plans cleanly
  (no zimg 3074, no fatal auto-scaler in the verbose dry-run).

---

## Adversarial verification (independent agent, 2026-07-07)

Every file:line citation, invariant, and empirical claim below was independently re-checked
against the code and re-probed on the ship-target `ffmpeg-full` 8.1.1. Probes were run
read-only in the scratchpad against synthetic ramps tagged into the exact production ingest.

### Verdict summary

| # | Claim | Verdict |
|---|---|---|
| 1 | Splice = per-clip ingest tail, `is_hdr(src) && !is_hdr(dst)`, mirror of the ×2.03 anchor at clip_chain.rs:164 | **CONFIRMED** |
| 2 | Map / decorations / SDR clips never tone-mapped (map ingest color.rs:483 has no tonemap branch) | **CONFIRMED** |
| 3 | `zscale` has no tonemap; `libplacebo` runtime-fails on macOS (no Vulkan); `tonemapx` absent | **CONFIRMED** |
| 4 | `tonemap` binds `gbrpf32le` with no silent auto-scaler / no zimg 3074 (clean 4:4:4 float path) | **CONFIRMED** |
| 5 | Operator numbers (clip clips ≥1.0; hable diffuse-white ~0.62; mobius ~0.85) | **CONFIRMED (relative)** — but measured in FULL range; production is LIMITED range (see C1) |
| 6 | Invariants: `delivery_never_emits_npl`, SDR no-op, HDR no-op, string/round-trip pins | **CONFIRMED** |
| 7 | Tone map is in disjoint matrix cells vs the anchor and fix C′ (never co-fires) | **WEAKENED** — enumeration omits the `Prores` delivery cell (see C2, blocking) |
| 8 | Recommended default `peak=6` | **REFUTED as the default** — reintroduces a hard clip and fails the report's own gate 1 (see C3, blocking) |
| 9 | Mixed SDR+HDR timeline lands "≈ SDR white"; mobius "near-identity" through diffuse range | **WEAKENED** — mobius pulls diffuse white to ~0.85, a ~15% seam vs a passthrough SDR clip (see C4) |
| 10 | Preview convergence gives a "faithful preview while tuning aggressiveness" (task 120) | **WEAKENED** — proxies are baked once at import; per-export `peak` won't track without proxy regen (see C5) |
| 11 | "HLG linear up to ~24.6 at npl=100" (quoted from filtergraph.rs:625 / CANON §1.12) | **CORRECTED** — probe shows HLG max = linear **10.0** at npl=100; the report's own peak table already uses 10.0 (see C6) |

**Overall: the splice ARCHITECTURE is sound and confirmed — the hard part (where it goes, map
untouched, clean float negotiation) holds up under attack. But the design MUST NOT ship as
written.** Two blocking corrections (C2, C3) and three that the implementer must fold in
(C1, C4, C5).

### Empirical receipts

- **Operator table reproduced** (linear gbrpf32le ramp tagged bt2020/linear/full → real SDR
  finishing `zscale=t=bt709…,format=yuv444p,scale=lanczos…,format=yuv420p`), FULL range:
  `clip` 1.0→255, ≥1.02→255; `hable:peak=10` 1.02→**158**, 2.0→192, 4.0→224, 6.0→240, 10.0→255;
  `mobius:peak=10` 1.02→**216**, 2.0→235, 6.0→251, 10.0→255; `mobius:peak=6` 4.0→250, **6.0→255,
  10.0→255**. Matches §B within ±1–5 LSB.
- **HLG max at npl=100** — inverse-HLG of signal 1.0 through the exact production ingest
  (`zscale=tin=arib-std-b67:t=linear:npl=100`) = **linear 10.0** (signal 0.75→2.03, 0.9→5.22).
  Not 24.6.
- **libplacebo** — `VK_ERROR_INCOMPATIBLE_DRIVER … Failed creating Vulkan device` (build has
  `--enable-libplacebo`, no `--enable-vulkan`). Unusable on macOS. Confirmed.
- **Scaler audit** — `-loglevel debug` on `…{ingest},tonemap=mobius:peak=10:desat=0,format=gbrpf32le`
  shows the parsed chain `crop → scale → zscale → format → zscale → tonemap → format` with **no
  inserted `auto_scale_*`** and gbrpf32le carried straight into `tonemap`. Clean.

### Corrections the implementing session MUST apply

**C2 (BLOCKING) — the `Prores` delivery cell is unhandled.** `DeliveryTarget::Prores`'s
`output_color_space()` is `SDR_BT709` (delivery.rs:127), so `!delivery.transfer.is_hdr()` is
**true** for it — the proposed gate would tone-map HLG/PQ footage on every `Prores` export.
But `Prores` is described in-code as "the archival master for composite" **and** the only legal
target for `map_only`/`video_only` lossless compositing intermediates (delivery.rs:81-84,
156-160), and it *is* in `all()` (delivery.rs:96) as a selectable composite target. Baking a
lossy SDR tone-map into an archival master / lossless intermediate contradicts that contract
(and the "no leveling down" canon). The report's scope says "SdrH264 / SdrH265" but the gate is
broader. **Decide explicitly:** either exclude `Prores` from the tone map (gate on the specific
H.26x SDR targets or add a "preserve full range" predicate on the target, not on
`is_hdr(delivery)`), or consciously ratify HDR→ProRes tone-mapping and document why the
mezzanine contract is not violated. The "disjoint matrix cells" enumeration in §D must gain the
`Prores` column before it is trustworthy.

**C3 (BLOCKING) — `peak=6` reintroduces the clip and fails gate 1.** HLG content reaches linear
**10.0** at npl=100 (probed). With `peak=6`, everything from linear 6.0→10.0 (600–1000 nits:
snow, specular, sun — exactly what iPhone HLG captures) collapses to 255: `mobius:peak=6` gives
6.0→255 and 10.0→255, a **plateau at 255**. That directly violates the report's own §C gate 1
("strictly monotonic non-decreasing with **no plateau at 255**"). `peak` is not a free
"aggressiveness dial" — lowering it below the true source max *re-creates the very defect the
tone map exists to remove*. `peak=10` (the true HLG max) passes gate 1 (6.0→251, only 10.0→255)
and is the correct HLG default; for PQ, `peak` must be the probed `MaxCLL` (or the linear-100
format ceiling), never a fixed 6. Change the recommended default from `peak=6` to `peak = the
source's true working-space max` and reframe E1: the real dial is diffuse-white brightness at a
*fixed, content-driven* peak (raise peak → darker diffuse white; you cannot lower it without
clipping).

**C1 (must fold in) — the §B / appendix luma numbers are FULL range; production is LIMITED
range.** The real `SdrH264`/`SdrH265` finishing emits `r=tv` (`output_color_space` =
`SDR_BT709`, range Limited; `delivery_zscale_chain` emits `r={range}`). Re-probed at `r=tv`:
diffuse white 1.0 → Y **235** (legal white), not 253/255; the clip still saturates (2.0+→255).
The qualitative story is unchanged, but every absolute luma value in §B and the appendix should
be restated in limited range, and the oracle/gate assertions must decode against **235-anchored
limited-range luma**, or they will mis-fire.

**C4 (must fold in) — no cross-clip diffuse-white consistency; "≈ SDR white" is optimistic.** In
a mixed SDR+HDR timeline to SDR delivery, the SDR clip passes through at diffuse white 1.0 while
the tone-mapped HDR clip's diffuse white lands at ~0.85 (mobius) — a ~15% brightness step at the
clip boundary. §A calls this "≈ SDR white" and "a small residual offset"; it is neither
negligible nor removable by the peak dial (higher peak makes it worse). Surface it as a real
product tradeoff in E1, and add a gate (or at least an oracle) that measures the SDR-clip /
HDR-clip diffuse-white delta on a mixed timeline.

**C5 (must fold in) — preview convergence cannot "track aggressiveness" as claimed.** Proxies
are baked once at import (`generate_proxy`), but `peak` is a per-export tuning parameter. A
constants-only swap to `mobius`/npl=100 in ffmpeg.rs:104-117 is a legitimate improvement and
closes the npl-divergence ledger item, but it will only ever reflect ONE baked peak — changing
the export peak will NOT update the proxy. "Faithful preview while tuning E1" overpromises;
either regenerate proxies on peak change or drop that justification. Task-120 parity is
partially advanced, not closed.

**C6 (note) — the "~24.6" figure is wrong for HLG.** filtergraph.rs:625 / the report's prose say
HLG reaches ~24.6 at npl=100; the probe says **10.0**. The report's peak table already uses 10.0
(so the design math is fine), but the citation should be dropped or the code comment corrected,
lest a future implementer size `peak` against 24.6.

### What held up

The load-bearing structural claims survived the attack: the splice slot mirrors the anchor
exactly and is per-clip-ingest so the **map path is literally untouched** (strongest answer to
the brief); the operator survey is correct (zscale has no tonemap, libplacebo is dead on macOS,
mobius vs hable behave as tabled); the float negotiation is clean with no silent scaler; the
`delivery_never_emits_npl` / SDR-no-op / HDR-no-op invariants are preserved; and the oracle-first
plan mirrors the existing tracer pattern and correctly mandates an **explicit** peak (which does
neutralize the temporal-pumping / non-determinism hazard). Fix C2 and C3, fold in C1/C4/C5, and
the design is sound.
