# IMPLEMENTATION — HDR/map color port (A+B+C+D)

> **The implementation tool.** Precise enough to build A+B+C+D from without re-deriving
> anything. Every Rust signature, `file:line`, filter string, and gate below is reconciled
> against the **live codebase** (not the auditor's guesses — those drifted and a few were
> wrong; see "Corrections to the audit" at the end).

## 0. Orientation — what's settled (read first)

Read `.spike/SESSION4_FINDINGS.md` before this file. It overturned the approved "16-bit"
composite and corrected the peaks/gain-filter facts. Settled facts you build on:

- **npl=100 everywhere** (HDR ingest + finishing). CONFIRMED by Matthew. Makes the working
  space absolute (`linear 1.0 = 100 nits`) and matches the existing npl=100 finishing → HDR
  video round-trips. npl=1000 is off the table.
- **The fix is a per-origin × per-delivery matrix**, not a "map-only" tweak. The map column is
  just the "SDR source" row of the matrix (§7).
- **Composite (C) = 10-bit `yuva444p10le` + headroom**, NOT 16-bit (overlay caps at 10-bit;
  `maskedmerge`/`blend` clamp float). `H=32`. **Gated to HDR delivery only.**
- **All gains go through one helper, `linear_gain_filter(factor)`** (colorchannelmixer chain).
  `geq` clamps [0,1]; `exposure` caps ±3 stops — both unusable. This serves BOTH the (B)
  anchor (×2.03) and the (C) headroom (÷32 / ×32).
- **Land A+B+C+D together.** Brightness isn't visibly corrected until C lands (the overlay
  clamp), so a partial landing reads as a regression.

The four parts:
- **(A)** HDR ingest npl 400/1000 → **100**.
- **(B)** SDR-origin → HDR delivery linear anchor **×2.03** (203/100 nits, BT.2408 ref white).
- **(C)** Composite headroom (÷H before each `yuva444p10le` lift, ×H after the post-overlay
  return to `gbrpf32le`), H=32, gated to HDR delivery.
- **(D)** HQ chroma subsample split in finishing for 4:2:0 targets.

---

## 1. The `linear_gain_filter` helper (shared by B and C)

New free function in `src-tauri/src/util/color_space.rs` (next to `default_npl_for`). It
emits a comma-joined `colorchannelmixer` **chain** that multiplies all of R/G/B by `factor`
in the working-space float buffer, decomposing `factor` into stages each within FFmpeg's
±2.0 per-coefficient cap. `colorchannelmixer` is clamp-free above 1.0 (verified Session 4),
unlike `geq` (clamps [0,1]) and `exposure` (±3-stop cap).

### Signature
```rust
/// Linear-light RGB gain by `factor`, as a comma-joined `colorchannelmixer`
/// CHAIN. Each stage multiplies R/G/B uniformly (rr=gg=bb=stage, off-diagonal
/// 0). `colorchannelmixer` caps every coefficient at ±2.0 and is clamp-free
/// for values >1.0, so a factor outside [0,2] is split into ≤2.0 stages whose
/// product equals `factor`. Operates on `gbrpf32le`; preserves values >1.0
/// (HDR headroom) — the property `geq` (clamps [0,1]) and `exposure` (±3-stop
/// cap) both fail.
///
/// `factor` must be finite and > 0. `factor == 1.0` returns an empty string
/// (identity — caller splices nothing).
pub fn linear_gain_filter(factor: f64) -> String
```

### Decomposition rule (authoritative)
The ±2.0 cap on a `colorchannelmixer` coefficient is an **upper** bound only — there is NO
lower positive bound (a single coefficient of `0.03125` is legal). So chaining is needed ONLY
when `factor > 2.0`; any `0 < factor ≤ 2.0` (including all down-gains) is a single stage.

```
if factor == 1.0      -> ""                                    (identity; splice nothing)
else if factor <= 2.0 -> one stage = factor                    (covers all 0 < factor ≤ 2.0)
else                  -> peel a 2.0 stage while remainder > 2.0;
                         final stage = remainder (lands in (1.0, 2.0])
```

Each stage emits `colorchannelmixer=rr={s}:gg={s}:bb={s}` (off-diagonal coefficients default
to 0; do not emit `aa` — alpha is untouched, and the working buffer is `gbrpf32le` with no
alpha anyway). Format each stage coefficient with enough precision to round-trip (use `{:}`
on the f64, or a fixed `{:.6}` — pick one and pin it in the byte-equality tests).

### Worked decompositions (PIN THESE IN A UNIT TEST)
| factor | stages | emitted string |
|---|---|---|
| `2.03` (B anchor) | `[2.0, 1.015]` (2.0 × 1.015 = 2.03) | `colorchannelmixer=rr=2:gg=2:bb=2,colorchannelmixer=rr=1.015:gg=1.015:bb=1.015` |
| `1.0/32.0` = 0.03125 (C ÷H) | `[0.03125]` (≤ 2.0 → one stage) | `colorchannelmixer=rr=0.03125:gg=0.03125:bb=0.03125` |
| `32.0` (C ×H) | `[2,2,2,2,2]` (2⁵ = 32) | five `colorchannelmixer=rr=2:gg=2:bb=2` stages, comma-joined |

---

## 2. Fix (A) — HDR ingest npl = 100

### Edits in `src-tauri/src/util/color_space.rs`
1. `ColorSpace::HDR_HLG_BT2020.npl` — `Some(400)` → **`Some(100)`** (currently line **211**).
2. `ColorSpace::HDR_PQ_BT2020.npl` — `Some(1000)` → **`Some(100)`** (currently line **220**).
3. `default_npl_for` (currently lines **332–338**):
   ```rust
   pub const fn default_npl_for(t: Transfer) -> Option<u32> {
       match t {
           Transfer::Hlg => Some(100),   // was Some(400)
           Transfer::Pq  => Some(100),   // was Some(1000)
           _ => None,
       }
   }
   ```
   This propagates to `with_overrides` (re-derives npl on transfer override) and
   `inferred_color_space` (uses `default_npl_for` at color.rs line ~691) automatically — no
   other edit needed for those.

### Doc comment fixes (same file, optional but keep honest)
The `HDR_HLG_BT2020` / `HDR_PQ_BT2020` doc comments and the `ColorSpace.npl` field comment
(lines ~159–164, 205, 214) still say "HLG reference 400, PQ reference 1000." Update to "npl
100 (absolute working space — Session 4 / PORT_DESIGN §4A)."

### Tests that MUST change (byte-equality — they PIN the old npl)
- `ingest_hlg_matches_legacy` (line **421**): expected string changes
  `…:t=linear:npl=400,…` → `…:t=linear:npl=100,…`. New full expected:
  `"zscale=tin=arib-std-b67:t=linear:npl=100,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc"`.
- `ingest_pq_matches_legacy` (fn at line **429**): `…:npl=1000,…` → `…:npl=100,…`. New full expected:
  `"zscale=tin=smpte2084:t=linear:npl=100,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc"`.
- `with_overrides_patches_named_axes_and_rederives_npl` (line ~525): `assert_eq!(cs.npl,
  Some(400))` → `Some(100)`.
- In `src-tauri/src/util/color.rs` tests:
  - `ingest_filter_for_hlg_uses_arib_std_b67_with_npl_400` (line ~848): rename + change the
    asserted substring `…:npl=400` → `…:npl=100` (rename to `…_with_npl_100`).
  - `ingest_filter_for_pq_uses_smpte2084_with_npl_1000` (line ~856): substring `…:npl=1000` →
    `…:npl=100` (rename to `…_with_npl_100`).
- In `src-tauri/src/export/delivery.rs`: `delivery_hlg_matches_legacy` /
  `delivery_pq_chain` are unaffected (delivery never emits npl — confirmed by
  `delivery_never_emits_npl`). No change.

Rename the two `ingest_*_matches_legacy` tests' DOC intent (they're no longer "legacy" — they
now pin the npl=100 absolute-space convention). Keep the test names if you prefer minimal
churn, but update the comment so a future reader doesn't "restore" 400/1000.

---

## 3. Fix (B) — SDR-origin → HDR delivery anchor (×2.03)

### 3.1 Registry additions in `src-tauri/src/util/color_space.rs`
```rust
/// zimg SDR diffuse white = linear 1.0 in the absolute working space.
pub const SDR_REF_WHITE_NITS: f64 = 100.0;
/// BT.2408 HDR graphics / diffuse reference white.
pub const HDR_REF_WHITE_NITS: f64 = 203.0;

/// Linear-light gain that anchors an SDR-ORIGIN source to the delivery's
/// reference white. Returns `Some(2.03)` IFF the source is SDR-origin
/// (`!source.transfer.is_hdr()`) AND the delivery is HDR
/// (`delivery.transfer.is_hdr()`); otherwise `None` (no scaling).
///
/// HDR-origin sources carry their own absolute nits and are NEVER anchored.
/// SDR→SDR is native (no anchor). Applied as a linear gain at the INGEST tail,
/// on the SDR-origin branch only, so the HDR video branch — which shares the
/// single finishing — is untouched. Proven equivalent to `npl=203` finishing
/// for HLG and PQ (PORT_DESIGN §2 / HANDOFF §2).
pub fn sdr_origin_anchor_gain(source: &ColorSpace, delivery: &ColorSpace) -> Option<f64> {
    (!source.transfer.is_hdr() && delivery.transfer.is_hdr())
        .then(|| HDR_REF_WHITE_NITS / SDR_REF_WHITE_NITS) // 2.03
}
```

### 3.2 Thread `delivery` into ingest — the chosen path (riskiest part, spelled out)

**Approach: thread `delivery_target: DeliveryTarget` (or its `ColorSpace`) as an EXPLICIT
parameter from the composite builder down to each ingest call. Do NOT post-process strings.**

The call chain (real signatures, current line numbers):

```
build_composite_filter_complex(... delivery_target: DeliveryTarget ...)   [filtergraph.rs:597]
   has delivery_target already ✓ → compute delivery_cs = delivery_target.output_color_space()
   |
   ├─ per-clip: ClipChainInputs { ... }            [filtergraph.rs:616-624]  ← ADD delivery field
   │     └─ build_clip_video_subgraph(&inputs)      [clip_chain.rs:89]
   │           └─ ingest_filter_for(class, trc)      [clip_chain.rs:135]      ← needs delivery
   │           └─ (override path) ingest_zscale_chain(effective_cs, WORKING, true)  [clip_chain.rs:129] ← needs anchor too
   │
   └─ map:  map_ingest_filter()                     [filtergraph.rs:654]      ← needs delivery
```

`delivery_target.output_color_space()` lives at `delivery.rs:122` and is already `pub`.

#### Step 1 — `ClipChainInputs` gains a delivery field (`clip_chain.rs:28-39`)
```rust
#[derive(Debug, Clone, Copy)]
pub struct ClipChainInputs<'a> {
    pub input_index: u32,
    pub clip: &'a Clip,
    pub source_dims: PixelDims,
    pub video_slot: PixelRect,
    pub fps: u32,
    /// Delivery target's output color space — needed for the SDR-origin
    /// BT.2408 anchor (ingest tail) and headroom gating. Thread from
    /// `DeliveryTarget::output_color_space()`.
    pub delivery: ColorSpace,
}
```
> Every construction site of `ClipChainInputs` must add `delivery`. There are **five** in the
> two filtergraph builders plus tests: video-only filter_complex (filtergraph.rs ~311 and
> ~369 audio), composite filter_complex (~617 video, ~876 audio), and any test fixtures. For
> Channel C (`build_video_only_filtergraph`) there is no delivery target visible — it is
> always ProRes Master (SDR_BT709). Pass `ColorSpace::SDR_BT709` there (anchor returns `None`,
> headroom off — identical to today). The composite builder passes
> `delivery_target.output_color_space()`.

#### Step 2 — `build_clip_video_subgraph` applies the anchor (`clip_chain.rs:89-156`)
After computing `ingest` (both branches), append the anchor gain if any:
```rust
// inside build_clip_video_subgraph, after the `let ingest = if has_override {…} else {…};`
let source_cs = if has_override {
    inputs.clip.effective_color_space()
} else {
    crate::util::color::source_color_space_for(
        inputs.clip.effective_color_class(),
        inputs.clip.color_trc.as_deref(),
    )
};
let anchor = crate::util::color_space::sdr_origin_anchor_gain(&source_cs, &inputs.delivery)
    .map(crate::util::color_space::linear_gain_filter)
    .filter(|s| !s.is_empty());
```
Then splice `anchor` between `ingest` and the final `format={pix}` in the format! at line 142.
The current format string is:
```
"[{idx}:v]trim=…,setpts=…,crop=…,scale=…,{ingest},format={pix}[v{idx}]"
```
Anchor goes AFTER `{ingest}` (after the working-space landing) and BEFORE `format={pix}`:
```
"…,{ingest}{anchor_csv},format={pix}[v{idx}]"
```
where `anchor_csv` = `format!(",{}", g)` when present, else `""`. (The anchor is a
`colorchannelmixer` chain on the `gbrpf32le` working buffer — it must run AFTER the second
zscale lands BT.2020 linear, which `ingest` already does, and the trailing `format={pix}` is a
no-op re-assert to `gbrpf32le`, so order is fine.)

> **Why both override and class branches:** an SDR clip the user force-tagged still anchors;
> an HDR clip never does. `source_cs.transfer.is_hdr()` is the single discriminator and works
> for both (override path uses `effective_color_space()`, class path uses
> `source_color_space_for`). Log variants develop to BT.709 SDR → SDR-origin → anchored. Good.

#### Step 3 — map ingest learns delivery (`color.rs:458-470`, `filtergraph.rs:654`)
The map is always `ColorSpace::SRGB` (SDR-origin), so the anchor depends only on delivery.
Add a delivery-aware form alongside the existing `map_ingest_filter()` / `map_ingest_filter_into`:
```rust
// color.rs — new fn, leaves map_ingest_filter() (no-arg) intact for Channel B / map_only.
pub fn map_ingest_filter_for_delivery(delivery: &ColorSpace) -> String {
    map_ingest_filter_into_for_delivery(&ColorSpace::WORKING, delivery)
}
pub fn map_ingest_filter_into_for_delivery(working: &ColorSpace, delivery: &ColorSpace) -> String {
    let base = ingest_zscale_chain(&ColorSpace::SRGB, working, true);
    match sdr_origin_anchor_gain(&ColorSpace::SRGB, delivery)
        .map(linear_gain_filter)
        .filter(|s| !s.is_empty())
    {
        Some(g) => format!("{base},{g}"),
        None => base,
    }
}
```
(Import `sdr_origin_anchor_gain`, `linear_gain_filter` into color.rs.)

In `build_composite_filter_complex` (filtergraph.rs:654) replace
```rust
let map_ingest = map_ingest_filter();
```
with
```rust
let map_ingest = crate::util::color::map_ingest_filter_for_delivery(
    &delivery_target.output_color_space(),
);
```

> **Channel B (`build_map_only_filtergraph` → `build_filter_complex`, filtergraph.rs:140-182)
> stays on the no-arg `map_ingest_filter()`** — Channel B is locked to ProRes Master (SDR),
> never HDR, so no anchor. Leaving it untouched keeps the existing Channel B tests green and
> the `map_ingest_filter_runs_on_bare_rawvideo_rgba` integration test valid.

> **Why not thread `delivery` through `ingest_filter_for` itself?** `ingest_filter_for` is
> also called by WS1/WS2 (proxy/thumbnail) and by `clip_chain` for the class path; those
> non-composite call sites have no delivery concept and always want SDR-origin behavior. Keep
> `ingest_filter_for` delivery-agnostic; apply the anchor in `build_clip_video_subgraph`
> (which DOES know delivery via `ClipChainInputs.delivery`). One seam, no signature churn on
> the shared ingest fn. This is the chosen path.

---

## 4. Fix (C) — composite headroom (10-bit yuva444p10le + ÷H/×H), H=32, HDR-gated

### 4.1 Constant + gate (in `color_space.rs` or `filtergraph.rs` — keep with the helper)
```rust
/// Composite headroom factor. Real iPhone HLG peaks at linear 24.6 at npl=100
/// (Session 4) → H must exceed that; H=16 clips. H=32 covers HLG + PQ to
/// ~3200 nit. PQ above ~3200 nit clips (PORT_DESIGN §6 known bound).
pub const COMPOSITE_HEADROOM: f64 = 32.0;
```
Gate: headroom is applied **iff `delivery_target.output_color_space().transfer.is_hdr()`**.
SDR delivery keeps today's plain lift (Session 4: H=32 on SDR regresses the gradient 209→85).

In `build_composite_filter_complex`, compute once near the top:
```rust
let hdr = delivery_target.output_color_space().transfer.is_hdr();
let down = if hdr { crate::util::color_space::linear_gain_filter(1.0 / COMPOSITE_HEADROOM) } else { String::new() };
let up   = if hdr { crate::util::color_space::linear_gain_filter(COMPOSITE_HEADROOM) } else { String::new() };
// helper closures to splice cleanly:
let pre  = |s: &str| if down.is_empty() { String::new() } else { format!("{down},") };  // before a lift
let post = |s: &str| if up.is_empty()   { String::new() } else { format!(",{up}")    };  // after the restore
```
(Or inline; the point is: when SDR, `down`/`up` are empty and the strings collapse to exactly
today's chains — keeping every existing SDR composite test byte-identical.)

### 4.2 The six edit sites (real labels, current lines)

Each branch has (i) one or more `…format=yuva444p10le…` **lift** lines and (ii) one
`[…]format={WORKING_SPACE_PIX_FMT}[vout_w]` **restore** line. **÷H goes immediately before
each lift's input stream; ×H goes immediately after the restore produces the working-space
buffer.** Because `linear_gain_filter` operates on `gbrpf32le` (the format BEFORE the lift and
AFTER the restore), this is exact: lift inputs are `gbrpf32le`, restore output is `gbrpf32le`.

> **Splice shape per lift:** turn `[X]format=yuva444p10le[Y]` into
> `[X]{down},format=yuva444p10le[Y]` (when HDR; when SDR `{down}` is empty → unchanged).
> **Splice shape for restore:** turn `[Z]format={pix}[vout_w]` into
> `[Z]format={pix}{,up}[vout_w]` — i.e. apply ×H AFTER landing gbrpf32le, still feeding
> `[vout_w]`. Equivalent and simpler: append the up-gain as its own step
> `;[vout_pre]{up}[vout_w]` if you prefer not to fuse; but fusing keeps the label count
> identical to today (less test churn). **Fuse it: `[Z]format={pix},{up}[vout_w]`** (drop the
> leading comma logic so it reads `format=gbrpf32le,colorchannelmixer=…[vout_w]`).

#### (1) PipMapInset — masked (filtergraph.rs ~718-737)
Lift lines (each gets `{down},` prepended to the `format=yuva444p10le`):
- `[map]format=yuva444p10le[map_a]`              → `[map]{down},format=yuva444p10le[map_a]`
- `[map_a][mask]alphamerge[map_masked]`          → **unchanged** (alphamerge is not a lift; map already lifted; mask is alpha)
- `[vc]format=yuva444p10le[vc_a]`                → `[vc]{down},format=yuva444p10le[vc_a]`
- overlay `[vc_a][map_masked]overlay=…:format=yuv444p10[vout_masked]` → **unchanged**
Restore (line ~734):
- `[vout_masked]format={pix}[vout_w]`            → `[vout_masked]format={pix},{up}[vout_w]`

> **Mask note:** the mask is `[{mask_idx}:v]format=gray[mask]` (alpha plane), NOT a color
> stream — do NOT apply ÷H to it. Session 4 validated the masked edge blends coherently inside
> the ÷32/×32 headroom because BOTH color inputs (`map`, `vc`) are scaled identically before
> alphamerge/overlay and unscaled identically after. Apply ÷H to `[map]` and `[vc]` only.

#### (2) PipMapInset — unmasked (filtergraph.rs ~739-749)
- `[vc]format=yuva444p10le[vc_nm]`               → `[vc]{down},format=yuva444p10le[vc_nm]`
- `[map]format=yuva444p10le[map_nm]`             → `[map]{down},format=yuva444p10le[map_nm]`
- overlay `[vc_nm][map_nm]overlay=…[vout_lifted]` → unchanged
- restore `[vout_lifted]format={pix}[vout_w]`    → `[vout_lifted]format={pix},{up}[vout_w]`

#### (3) PipVideoInset — masked (filtergraph.rs ~768-779)
- `[vc]format=yuva444p10le[vc_a]`                → `[vc]{down},format=yuva444p10le[vc_a]`
- `[vc_a][mask]alphamerge[vc_masked]`            → unchanged
- `[map]format=yuva444p10le[map_a]`             → `[map]{down},format=yuva444p10le[map_a]`
- overlay `[map_a][vc_masked]overlay=…[vout_masked]` → unchanged
- restore `[vout_masked]format={pix}[vout_w]`    → `[vout_masked]format={pix},{up}[vout_w]`

#### (4) PipVideoInset — unmasked (filtergraph.rs ~781-791)
- `[map]format=yuva444p10le[map_nm]`             → `[map]{down},format=yuva444p10le[map_nm]`
- `[vc]format=yuva444p10le[vc_nm]`              → `[vc]{down},format=yuva444p10le[vc_nm]`
- overlay `[map_nm][vc_nm]overlay=…[vout_lifted]` → unchanged
- restore `[vout_lifted]format={pix}[vout_w]`    → `[vout_lifted]format={pix},{up}[vout_w]`

#### (5) Split (filtergraph.rs ~826-866)
Split synthesizes `[bg]` (black canvas in working space, gbrpf32le with setparams). The bg is
already at linear 0 (black) so ÷H is mathematically a no-op on it, but apply it uniformly to
all three lifts for symmetry and so the post-overlay ×H is exact:
- `[bg]format=yuva444p10le[bg_a]`                → `[bg]{down},format=yuva444p10le[bg_a]`
- `[map]format=yuva444p10le[map_a]`             → `[map]{down},format=yuva444p10le[map_a]`
- `[vc]format=yuva444p10le[vc_a]`              → `[vc]{down},format=yuva444p10le[vc_a]`
- overlay 1 `[bg_a][map_a]overlay=…[bg_with_map]` → unchanged
- overlay 2 `[bg_with_map][vc_a]overlay=…[vout_lifted]` → unchanged
- restore `[vout_lifted]format={pix}[vout_w]`    → `[vout_lifted]format={pix},{up}[vout_w]`

> That is **6 restore-site edits across 5 branches + their lift edits** = the "SIX edit sites"
> the audit referenced (PipMapInset masked, PipMapInset unmasked, PipVideoInset masked,
> PipVideoInset unmasked, Split — Split is one branch with one restore but three lifts). Count
> by restore site: PipMapInset has two (masked/unmasked), PipVideoInset has two, Split has one
> = 5 restores; the "six" in the audit conflated lift+restore. Either way: **edit every
> `format=yuva444p10le` lift of a COLOR stream (map/vc/bg) and every `format={pix}[vout_w]`
> restore, in all branches.** Do not touch mask/alphamerge/overlay lines.

### 4.3 Interaction with (B)
The anchor (×2.03) is applied at INGEST (in `build_clip_video_subgraph` and the map ingest),
BEFORE concat/overlay — so by the time the composite headroom ÷H runs, the map/SDR-video are
already at 203-nit reference. ÷32 then ×32 is a lossless round-trip around the integer lift
(10-bit gives 381 distinct gradient levels — far above the ~64-128 visible-banding floor).
Anchor and headroom compose cleanly: anchor sets the value, headroom protects it through the
lift. Both are gated to HDR delivery, so SDR delivery sees neither.

---

## 5. Fix (D) — HQ chroma subsample split in finishing (4:2:0 targets)

### Edit `delivery_finishing_filter` (`delivery.rs:175-185`)
Current:
```rust
pub fn delivery_finishing_filter(target: DeliveryTarget) -> String {
    format!(
        "{chain},format={pix}",
        chain = delivery_zscale_chain(&ColorSpace::WORKING, &target.output_color_space()),
        pix = target.finishing_pix_fmt(),
    )
}
```
The fused `format={420}` is where FFmpeg silently does box-filter chroma decimation. Split it
for 4:2:0 targets into: matrix to full-chroma 4:4:4 at the target depth → lanczos high-quality
chroma resample → final 4:2:0 at the target depth.

```rust
pub fn delivery_finishing_filter(target: DeliveryTarget) -> String {
    let chain = delivery_zscale_chain(&ColorSpace::WORKING, &target.output_color_space());
    let pix = target.finishing_pix_fmt();
    match pix {
        // HDR 10-bit 4:2:0 — split via 4:4:4-10 then lanczos chroma.
        "yuv420p10le" => format!(
            "{chain},format=yuv444p10le,\
             scale=flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp,\
             format=yuv420p10le"
        ),
        // SDR 8-bit 4:2:0 — 8-bit analogue (yuv444p → yuv420p).
        "yuv420p" => format!(
            "{chain},format=yuv444p,\
             scale=flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp,\
             format=yuv420p"
        ),
        // Non-4:2:0 targets (ProRes yuva444p10le): no decimation, leave fused.
        _ => format!("{chain},format={pix}"),
    }
}
```

> **Gate on `finishing_pix_fmt()` (the 4:2:0 pixel format), NOT on the target enum** — that
> keeps it registry-shaped (a future 4:2:0 target gets HQ subsample automatically). ProRes
> (`yuva444p10le`) and any future 4:4:4 target fall through to the unchanged fused form.
>
> **`scale=` with no `w=`/`h=` means "same size"** — it only re-samples chroma per the flags;
> it does NOT resize the frame (the canvas is already at the validated output dims; D adds no
> scale/pad — the existing `finishing_filter_*_emits_no_scale_pad` tests must be RELAXED to
> allow `,scale=flags=…` while still forbidding a dimensioned `scale=w=`/`pad=`; see §6).
> The 8-bit `format=yuv444p` analogue is flagged "verify" in PORT_DESIGN §4D — confirm with a
> verbose dry-run (§6) that no extra scaler sneaks in and the SDR path is video-safe.

### Tests that change in `delivery.rs`
- `hdr_pq_target_generates_pq_bt2020_finishing_and_encoder_flags` (line ~465): the expected
  finishing string changes from
  `"zscale=t=smpte2084:m=bt2020nc:p=bt2020:r=limited,format=yuv420p10le"` to the split form:
  `"zscale=t=smpte2084:m=bt2020nc:p=bt2020:r=limited,format=yuv444p10le,scale=flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp,format=yuv420p10le"`.
- `finishing_filter_sdr_targets_use_bt709_yuv420p_and_emit_no_scale_pad` (line ~531): now
  contains `,scale=flags=lanczos…` — change the assertion from "no `,scale=`" to "no
  **dimensioned** scale": forbid `scale=w=`/`scale=...:w=` and `pad=`, ALLOW
  `scale=flags=lanczos…`. Assert the split shape `format=yuv444p,…format=yuv420p` is present.
- `finishing_filter_hdr_uses_hlg_bt2020_yuv420p10le_and_emits_no_scale_pad` (line ~553): same
  relaxation; assert split `format=yuv444p10le,scale=flags=…,format=yuv420p10le`.
- `finishing_filter_prores_preserves_alpha_no_scale_pad` (line ~570): ProRes is `yuva444p10le`
  → falls through → unchanged; this test stays as-is (still no scale/pad).

---

## 6. Test plan

### 6.1 Hard rules (project-wide, non-negotiable)
- **No codebase change ships without each generated chain (a) byte-asserted in a unit test AND
  (b) verified by an `ffmpeg -loglevel verbose` dry-run showing NO silently auto-inserted
  scaler.** Textual filter tests cannot see zimg/swscale fusion
  (`feedback_ffmpeg_filter_empirical_validation`).
- **Tests fail LOUD on missing preconditions** (zscale/zimg, ffmpeg, ffprobe). Reuse
  `assert_ffmpeg_has_zscale()` (color_fixtures.rs:63) — never silent skip
  (`feedback_loud_test_failures`).
- **DO NOT touch decoration-side edge crispness** (luma keyline / soft glow, `lever_keyline/`)
  — rejected on aesthetics, redesigned later (`project_decoration_crispness_levers`).

### 6.2 Byte-equality unit tests to ADD / CHANGE
- **(A)** the four ingest npl tests → npl=100 (§2).
- **(B)** new `color_space.rs` tests:
  - `sdr_origin_anchor_gain_some_for_sdr_to_hdr`: `sdr_origin_anchor_gain(&SRGB, &HDR_HLG_BT2020)
     == Some(2.03)`; same for PQ delivery; SDR_BT709 source too.
  - `sdr_origin_anchor_gain_none_for_hdr_source`: HLG/PQ source → any delivery → `None`.
  - `sdr_origin_anchor_gain_none_for_sdr_delivery`: SDR source → SDR delivery → `None`.
  - `linear_gain_filter_decompositions`: pin the three worked strings (§1 table) +
    `linear_gain_filter(1.0) == ""`.
- **(B) in clip_chain.rs**: new test that `build_clip_video_subgraph` with
  `delivery = HDR_HLG_BT2020` on an SDR clip contains the 2.03 colorchannelmixer chain between
  the ingest tail and `format=gbrpf32le`; with `delivery = SDR_BT709` it does NOT (byte-identical
  to today). Same with an HLG clip + HDR delivery → NO anchor.
- **(B) map**: `map_ingest_filter_for_delivery(&HDR_HLG_BT2020)` ends with the 2.03 chain;
  `map_ingest_filter_for_delivery(&SDR_BT709) == map_ingest_filter()` (byte-identical).
- **(C) in filtergraph.rs**: for each composite mode × {HDR delivery, SDR delivery}: HDR
  contains `colorchannelmixer=rr=0.03125…` before every color-stream lift and the ×32 chain
  (`colorchannelmixer=rr=2…` ×5) after the restore; SDR delivery is byte-identical to today
  (no headroom). The existing `ws3_*` parity tests (color_fixtures.rs:1163, 1327) must be
  re-pinned: they build with `DeliveryTarget::Prores` (SDR) → headroom MUST be absent (good,
  they assert the existing labels). Add HDR-delivery variants.
- **(D)** the four `delivery.rs` finishing tests (§5).

### 6.3 New LOUD integration tests (extend `color_fixtures.rs`)
Per matrix cell (source transfer × delivery transfer), drive a real encode (like
`run_delivery_finishing_for_test` at color_fixtures.rs:997 and the synthetic clip builder at
:935) and assert the OUTPUT signal. Matrix cells:

| source | delivery | assertion |
|---|---|---|
| SDR | SDR | output unchanged vs today (regression pin); SDR gradient ≈ 209 levels |
| SDR | HLG | map/SDR white → 0xC0 ≈ 75% = 203-nit ref; no banding (≥381 grad levels) |
| SDR | PQ | map/SDR white → 0x95 (PQ 203-nit codeword); anchored |
| HLG | HLG | round-trip identity (240→239); video NOT darkened |
| HLG | SDR | highlights hard-clip (known gap §7; assert it clips, don't pretend) |
| PQ | PQ | round-trip identity; ≤3200-nit preserved |
| PQ | SDR | clips (known gap) |
| map (sRGB) | HLG/PQ | white → 203-nit ref (0xC0 / 0x95) — same as SDR-source row |
| map (sRGB) | SDR | white → SDR white, no anchor (unchanged) |

Plus the **three composite shapes** (PipMapInset, PipVideoInset, Split) each at HDR delivery:
build via `build_composite_filtergraph` and assert the headroom chains are present AND a
verbose dry-run shows no auto-scaler. (Full pixel-level composite needs the
`integration_export` renderer bundle — gate the pixel assertions behind that feature as the
existing composite tests do; the chain + verbose assertions run unconditionally.)

### 6.4 Verbose dry-run per cell (mandatory)
For every matrix cell and every composite shape, run the real `filter_complex` through
`ffmpeg -loglevel verbose … -f null -` (1 frame) and grep the stderr for auto-inserted
scalers. Specifically assert:
- No `auto_scale` / inserted `scale`/`swscale` between the lifts and the overlay (would mean a
  silent 4:2:0 chroma drop — the bug WS3 fixed; headroom must not reintroduce it).
- The overlay reports `yuva444p10` / `yuv444p10` internal format, not yuv420.
- zimg planning succeeds (no `code 3074`).
Fail loud (panic with the stderr) if any auto-scaler appears. This is the
`feedback_ffmpeg_filter_empirical_validation` rule made executable; do it BEFORE trusting any
byte-equality green.

### 6.5 Fail-loud on missing zscale/zimg
Every new integration test calls `assert_ffmpeg_has_zscale()` first (color_fixtures.rs:63).
Do not add a `#[ignore]` or silent skip.

---

## 7. The input × output matrix (behavior per cell)

Source transfer (rows) × delivery transfer (cols). "anchor" = ×2.03 SDR→HDR ingest gain
(fix B). "headroom" = ÷32/×32 around the composite lift (fix C, HDR delivery only).

| source ↓ \ delivery → | **SDR** (H264/H265/ProRes) | **HDR** (HLG / PQ) |
|---|---|---|
| **SDR** video | native: white→100nit→SDR white. **no anchor, no headroom.** Byte-identical to today. ✓ | **anchor ×2.03** → 203nit; **headroom on**. Round-trips through lift. |
| **HLG / PQ** video | ingest npl=100 → absolute; SDR finish **clips** >1.0 (**tone-map gap, §known-bounds**) | ingest npl=100 → finish(default 100) = **round-trip, FIXED** (was darkened by npl mismatch); headroom carries the >1.0 range through the lift |
| **map** (always sRGB / SDR-origin) | white→100nit→SDR white. **no anchor.** ✓ (already correct) | **anchor ×2.03** → 203nit; headroom on |

The map row ≡ the SDR-source row — one rule (`sdr_origin_anchor_gain`) covers both.

---

## 8. Known bounds — FLAG, do not hide (PORT_DESIGN §6)

- **PQ content above ~3200 nit clips at H=32.** PQ 100%-white (10000 nit) = linear ~108; H=32
  caps the composite at 32 (= 3200 nit). HDR10 1000-nit masters (linear ~10) and most 4000-nit
  (linear ~43, partial) are within/near H=32. Raising H protects extreme PQ but bands the map
  (precision is a fixed map/H ratio). Ship H=32 + this flag; revisit with per-export-dynamic-H
  or tone-mapping only if real PQ footage clips visibly. No PQ source footage in hand.
- **HDR source → SDR delivery hard-clips highlights** (absolute >1.0 into SDR finishing).
  ~status quo (today's lift also clamps), now explicit. Proper fix = tone-map operator (zscale
  `tonemap` / libplacebo) on the HDR→SDR path. Matthew chose **follow-up**. No leveling-down:
  do NOT degrade the HDR→HDR path to hide this.

---

## 9. Validation hooks — `.spike/port_probe/` artifacts to reproduce

The implementation's integration tests must reproduce these Session 4 measurements (read with
the harness one-liners in HANDOFF §6 — full-range signal:
`…,{CHAIN},zscale=rin=tv:r=full,format=rgb24,crop=1:1:X:Y`; working-linear float:
`…,{CHAIN},crop=1:1:X:Y` → `gbrpf32le` → `struct.unpack('<fff', …)` planar G,B,R):

| artifact | what it pins | expected |
|---|---|---|
| `ref_id.mkv` | identity ref (video ingest npl=100 → finish, no composite) | HDR video round-trip target: `c9c4c2` (bright), `60705d` (mid) |
| `comp32.mkv` | unmasked PIP, H=32 | map white **`c0c0c0`** (0xC0=75%=203nit); HDR video `c7c4c1` / `63735e` (±3, no clamp) |
| `comp_masked.mkv` | masked alphamerge, H=32 | map white **`bebebe`** (≈0xC0); uncovered video `5f6e5b`; 50%-edge `d8d8d8` blends video↔map coherently |
| `comp_split.mkv` | Split (setparams bg + 2 overlays), H=32 | map white **`c0c0c0`** |
| `sdr_plain.mkv` vs `sdr_head.mkv` | SDR gradient: plain lift vs H=32 headroom | **209** (plain, KEEP) vs 85 (headroom — proves headroom must be HDR-gated) |
| `grad_direct.mkv` / `g_h32.mkv` / `g_h16bit.mkv` | 1024-step gradient distinct levels | 608 (ceiling) / **381** (10-bit+headroom, achievable) / 606 (16-bit ideal) |
| `pq_203.mkv` (vs `pq_100`/`pq_1000`) | anchor≡npl=203 for PQ | map white `0x95` |
| `rt_100.mkv` vs `rt_400.mkv` | round-trip identity, npl=100 vs 400 | npl=100 → `240→239` (identity); npl=400 → darkened |

Acceptance: SDR delivery byte-identical to today (209 unchanged); HDR map white at 0xC0/0x95;
HDR video round-trips; gradient ≥ 381 levels; masked edge coherent.

---

## Corrections to the codebase audit (so the implementer doesn't trust a wrong guess)

- `delivery_finishing_filter` takes **`(target: DeliveryTarget)` only** (delivery.rs:175) — NOT
  `(target, output)`. The composite builder already calls it single-arg
  (filtergraph.rs:753/795/865). The audit's "≈L175-185" range is right; the signature note in
  some earlier text implying an `output` arg is wrong.
- `ingest_filter_for(class, source_trc)` and `ingest_filter_into(class, source_trc, working)`
  — the audit said "≈L114-176"; correct. They do **not** currently take `delivery`. The chosen
  path (§3.2 Step 2) keeps them delivery-agnostic and applies the anchor in
  `build_clip_video_subgraph` instead, because they're shared with WS1/WS2. Do not add
  `delivery` to `ingest_filter_for`.
- `map_ingest_filter()` / `map_ingest_filter_into(working)` (color.rs:458/468) take no
  delivery; add the NEW `map_ingest_filter_for_delivery` rather than changing them (Channel B
  still needs the no-arg form).
- `ClipChainInputs` (clip_chain.rs:28) has **no delivery field** — add it (§3.2 Step 1). The
  composite builder DOES have `delivery_target` (filtergraph.rs:605); thread it down.
- **IGNORE the audit's wrong filter strings:** `colorchannelmixer=ar=2.03…` (ar/ag/ab are
  ALPHA coefficients and 2.03 exceeds the ±2 cap) and `cscale=w=iw*0.5`. Use this doc's
  validated strings: gains via `rr/gg/bb` through `linear_gain_filter`; subsample via the
  `format=yuv444p…,scale=flags=lanczos…,format=yuv420p…` split.
- Line numbers in `color_space.rs` shifted slightly from the audit (the file is the untracked
  new module): `HDR_HLG_BT2020.npl` is **L211**, `HDR_PQ_BT2020.npl` **L220**, `default_npl_for`
  **L332-338**, `ingest_hlg_matches_legacy` fn **L421**, `ingest_pq_matches_legacy` fn **L429**.
  Re-grep before editing — they may drift again.
