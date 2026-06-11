# HANDOFF — HDR/map color port (matrix-aware redesign)

**State:** design complete + **empirically validated; fix (C) mechanism CORRECTED (Session 4);
reconciled against the real codebase into a step-by-step implementation tool
(`.spike/IMPLEMENTATION.md`).** All decisions answered (npl=100 CONFIRMED by Matthew; land
A+B+C+D together). No core code changed. **`IMPLEMENTATION.md` is ready for implementation
once Matthew greenlights** — it carries the verified file:line edit sites, real Rust
signatures, validated filter strings, and the full test plan.

**Read in order (UNDERSTAND):** this file → `.spike/SESSION4_FINDINGS.md` (the (C) premise
overturn + all measurements — READ THIS, it corrects both this file and the design) →
`.spike/PORT_DESIGN.md` (design, §4C/§6/§7 updated) → `.spike/FINDINGS.md` (original spike,
partially superseded).

**Read to BUILD:** `.spike/IMPLEMENTATION.md` — the implementation entry point. It assumes
you have read SESSION4_FINDINGS + PORT_DESIGN and turns them into exact edits; everything in
it is reconciled against the live codebase (signatures/line numbers verified, not the
auditor's guesses).

Memories: `project_hdr_map_reference_white` (Session 4 note appended),
`project_color_space_matrix`, `project_decoration_crispness_levers`.

> **⚠️ Session 4 correction (full detail in `SESSION4_FINDINGS.md`):** the approved
> "16-bit + headroom" composite is **physically impossible** — `overlay` caps at 10-bit
> (silently downconverts 16-bit inputs), and `maskedmerge`/`blend` clamp float to [0,1]. The
> achievable, validated fix is **10-bit `yuva444p10le` + headroom (H=32, gated to HDR delivery,
> gains via a `colorchannelmixer` chain — NOT `geq`, which clamps)**, measured perceptually
> equivalent (gradient 381 vs 606 ideal levels). Real HLG peaks at **24.6** at npl=100 (not
> ~12) so **H=16 would clip** → H=32. The §2 evidence rows about `geq`, 16-bit overlay, and the
> 2.98/12 peaks are corrected there.

---

## 0. TL;DR

The original task was "port two verified spike fixes (203-nit SDR→HDR anchor + HQ chroma
subsample) into the real codebase; leave HDR video untouched." **Investigation overturned that
framing.** The spike validated its fix in a pipeline shape the codebase does **not** use
(`hstack` tiling with *separate per-branch finishing*). On the **real** path (ingest →
working-space overlay → **one shared finishing**):

1. The overlay's `format=yuva444p10le` lift **clamps the working-space linear to [0,1] = 100
   nits**, so **both map and video are clamped to ~63%** — they're already mutually coherent,
   both too dark. The map-only anchor is **inert** (clamped right back) and would be
   *counterproductive* if it weren't.
2. The **HDR video is independently darkened** because ingest `npl` (400/1000) ≠ finishing
   `npl` (zimg default = 100). It's also highlight-clamped by the lift.

**Matthew's direction:** the task is really a **full input×output matrix** problem (SDR/HLG/PQ
video × SDR/HLG/PQ/ProRes delivery), the map (always SDR-origin sRGB) must combine dynamically
with whatever the working space holds, and **the video should be corrected too** (not preserved
as-is). Hence the redesign in `PORT_DESIGN.md`.

---

## 1. The model (first principles, empirically established)

Working space = **absolute linear light**, BT.2020, `gbrpf32le` (float), with
**linear 1.0 ≡ 100 nits** (SDR diffuse white); HDR sits **above 1.0** (measured HLG → ~3 at
the current npl=400, **24.6 at npl=100** — S4 corrects the earlier "~12" estimate; PQ
100%-white → ~108). Float, so >1.0 is fine — nothing clips in the buffer.

- **Ingest** = put each source at its true nits on that scale.
- **Composite** = combine in absolute linear light.
- **Finishing** = encode absolute luminance to the target transfer.
- **BT.2408 anchor** = a per-origin × per-delivery rule: any **SDR-origin** input (map, SDR
  video, future title) → **HDR** delivery scales 100→203 nits (×2.03). HDR-origin video is
  never anchored.

### The input × output matrix
| source ↓ \ delivery → | **SDR** (H264/H265/ProRes) | **HDR** (HLG/PQ) |
|---|---|---|
| **SDR** video | native, **no anchor** ✓ (unchanged today) | **anchor ×2.03** → 203nit |
| **HLG/PQ** video | absolute; SDR-finish clips >1.0 (**tone-map gap**, §5) | ingest npl=100 → finish(default 100) = **round-trip, video FIXED** |
| **map** (always sRGB) | white→100nit→SDR white ✓ (already right) | **anchor ×2.03** → 203nit |

---

## 2. Evidence (all measured; reproduce via the harness in §6)

HLG target, `IMG_1137.MOV` + Abel's map frame `out/export/f8000.png`, libx265 main10. HLG
signal read full-range; BT.2408 reference white = **0xBF = 191 = 75%**.

| claim | measurement |
|---|---|
| working linear is absolute, 1.0 = 100 nits; HDR > 1.0 | HLG ingest → working-linear **max ≈ 2.98** (npl=400) |
| overlay lift `format=yuva444p10le` **clamps to [0,1]** | working-linear `2.98 → 1.0` through the lift |
| ⇒ real composite clamps **both** map & video to ~63% | video bright pixels all `161` (63%); map white `158-159` (62%) |
| zimg default HLG/PQ finishing npl = **100** | finishing no-npl ≡ `npl=100` (byte-identical: both map white → 158) |
| HDR round-trip needs **ingest npl == finishing npl** | ingest`400`→finish`100`: `240→183` (dark). ingest`100`→finish`100`: `240→239` (identity) |
| anchor = **ingest gain ×2.03 + default finishing ≡ `npl=203` finishing** (HLG **and** PQ) | both → `0xC0` (75%) HLG; `0x95` PQ |
| headroom rescale (`÷H` pre-lift, `×H` post) **preserves HDR** | round-trip `2.98 → 2.98` |
| ~~`overlay` accepts **16-bit** intermediates~~ **← WRONG (S4):** overlay caps at 10-bit, silently downconverts `yuva444p16le`→`yuva444p10le`; `gbrap16le` corrupts | `yuva444p16le` / `gbrap16le` / `rgba64le` accepted as INPUT only |
| working linear-gain filter on `gbrpf32le` **(S4: `geq` CLAMPS [0,1] — do NOT use; use `colorchannelmixer` chain only; `exposure` caps ±3 stops)** | `colorchannelmixer` clamp-free, coeff cap ±2.0 → chain for factors >2 |

---

## 3. The four-part fix (see PORT_DESIGN.md §4 for detail)

- **(A) Absolute working space — HDR ingest `npl = 100`.** Registry: `default_npl_for(Hlg|Pq)`
  100 (today 400/1000). Makes the space absolute AND matches the (already npl=100) finishing →
  **HDR video round-trips, fixing the darkening.** No finishing change for this part.
  *NB:* this is NOT "destroying HDR" — npl is the linear normalization reference, not a clip
  ceiling; lower npl spreads HDR *higher* on the float scale. See PENDING decision in §4.
- **(B) Per-origin anchor.** New registry fn `sdr_origin_anchor_gain(source, delivery) ->
  Option<f64>` returning `Some(203.0/100.0)` iff `!source.transfer.is_hdr() &&
  delivery.transfer.is_hdr()`. Applied as a linear gain at the **ingest** tail (so the HDR
  video branch is untouched). Ingest generators (`ingest_filter_for`, `map_ingest_filter_*`)
  gain a `delivery: &ColorSpace` argument.
- **(C) Composite intermediate must preserve the HDR range** (the actual clamp fix).
  **CORRECTED (S4): 10-bit `yuva444p10le` + headroom** (`÷H` pre-lift in float, `×H` post),
  **H=32**, **gated to HDR delivery**, gains via `colorchannelmixer` chain (`linear_gain_filter`).
  16-bit was approved but is impossible (overlay caps at 10-bit; float compositors clamp) —
  see `SESSION4_FINDINGS.md`. Measured perceptually equivalent.
- **(D) HQ chroma subsample split** in `delivery_finishing_filter` for 4:2:0 targets:
  `…:r=limited,format=yuv444p10le,scale=flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp,format=yuv420p10le`.

### Code locations
- `src-tauri/src/util/color_space.rs` — `ColorSpace`, `ingest_zscale_chain`,
  `delivery_zscale_chain`, `default_npl_for` (A); new `sdr_origin_anchor_gain` + constants (B).
- `src-tauri/src/util/color.rs` — `ingest_filter_for`/`ingest_filter_into`,
  `map_ingest_filter`/`map_ingest_filter_into` (thread `delivery`, apply gain) (B).
- `src-tauri/src/export/delivery.rs` — `delivery_finishing_filter` / `finishing_pix_fmt` (D);
  `output_color_space` already exists.
- `src-tauri/src/export/filtergraph.rs` — the composite `build_composite_filter_complex`
  (PipMapInset / PipVideoInset / Split branches): the yuva444p10le lifts → 16-bit + headroom (C).
- `src-tauri/tests/color_fixtures.rs` + `color_space.rs` unit tests — byte-equality + verbose
  dry-run validation (§5).

---

## 4. Decisions

**Answered by Matthew:**
- Composite intermediate (C): 16-bit was approved but is **physically impossible** (Session 4).
  Substituted with the achievable, validated **10-bit `yuva444p10le` + headroom (H=32, gated to
  HDR delivery, gains via `linear_gain_filter` colorchannelmixer chain)**. Flagged as a forced
  substitution; proceeding. ✓
- HDR→SDR tone-mapping (§5): **follow-up**, not in this change. ✓
- Correct the HDR video too (not preserve as-is). ✓
- **Working-space normalization: `npl=100` — CONFIRMED.** No longer open. `1.0 = 100 nits`, HDR
  up to ~24.6 (real HLG, Session 4), SDR/map at full precision; matches the existing npl=100
  finishing so HDR video round-trips. npl=1000 is rejected (would squeeze SDR/map into linear
  ~0.1–0.2 → map-graphics banding, and force a finishing-npl + anchor recompute). The "isn't
  100 destroying HDR?" concern is answered: npl is the linear normalization reference, not a
  clip ceiling — lower npl spreads HDR *higher* on the float scale.

**Scope (confirmed):** land **A+B+C+D together** as one change. Staging A+B+D without C is a
trap — the overlay clamp means brightness isn't visibly corrected until C lands, so a partial
landing would look like a regression with no payoff.

**Still genuinely open for Matthew (low urgency, flag-don't-hide):**
- PQ content above ~3200 nit clips at the composite headroom H=32 (PORT_DESIGN §6). No PQ
  source footage in hand; accept as a flagged bound or invest in per-export-dynamic-H later.
- HDR source → SDR delivery hard-clips highlights (tone-map gap, §5) — Matthew chose follow-up.

---

## 5. Validation plan + hard rules (deliverables 4 & 5)
- **Loud tests** (extend `color_fixtures.rs` + `color_space.rs` byte-equality): ingest chain
  carries `npl=100` + (SDR→HDR) the ×2.03 gain; finishing carries the subsample split; SDR
  delivery + HDR-video chains regression-pinned. Tests **fail loud** on missing preconditions
  (zscale/zimg) — never silent skip (project rule).
- **Verbose dry-run** (`ffmpeg -loglevel verbose`) of the real composite for **every matrix
  cell** — confirm emitted chains and **no silently auto-inserted scaler** (zimg fuses/inserts;
  textual filter tests can't see it — mandatory per `feedback_ffmpeg_filter_empirical_validation`).
- **Re-validate in the spike harness on the TRUE single-finishing composite path** (NOT the old
  `hstack`): map → 75%, HDR video round-trip identity, SDR delivery unchanged, seam coherent at
  203-nit reference.
- **Known gap, flag don't hide (§5/PORT_DESIGN §6):** HDR source → SDR delivery hard-clips
  highlights (absolute >1.0 into SDR finishing). ~status quo; proper fix = tone-map operator
  (zscale `tonemap`/libplacebo) — Matthew chose follow-up.
- **DO NOT touch decoration-side edge crispness** (luma keyline / soft glow) — prototyped in
  spike `lever_keyline/`, rejected on aesthetics, Matthew redesigns later. (`project_decoration_crispness_levers`.)

---

## 6. The probe harness (reproduce everything)

Built during this session, lives in **`.spike/port_probe/`**. ffmpeg 8.1.1 w/ zimg+libx265.
Key strings (exact codebase chains):
```
MAP_INGEST = zscale=pin=bt709:tin=iec61966-2-1:min=gbr:rin=full:p=bt709:t=linear:m=gbr:r=full,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc
HLG_INGEST = zscale=tin=arib-std-b67:t=linear:npl=400,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc
HLG_FINISH = zscale=t=arib-std-b67:m=bt2020nc:p=bt2020:r=limited      (no npl == npl=100)
PQ_FINISH  = zscale=t=smpte2084:m=bt2020nc:p=bt2020:r=limited
```
Inputs: real HLG clip `/Users/personal/Downloads/trail-vids/IMG_1137.MOV` (frame 250 used);
map frames `.spike/out/export/f8000.png` (export-SSAA) and `.spike/out/preview/f8000.png`.

Useful one-liners (run from `.spike/port_probe/`):
- **Read HLG signal at a pixel (full-range):** `…,${CHAIN},zscale=rin=tv:r=full,format=rgb24,crop=1:1:X:Y` → `-f rawvideo -pix_fmt rgb24 - | xxd -p`.
- **Read working-space linear float:** `…,${CHAIN},crop=1:1:X:Y` → `-f rawvideo -pix_fmt gbrpf32le -` then `struct.unpack("<fff", …)` (planar **G,B,R** order).
- **Frame max linear:** ingest → `scale=192x108` → `-pix_fmt gbrpf32le` → `array('f')` min/max.
- **Round-trip identity test:** `${HLG_INGEST with npl=N},${HLG_FINISH}[:npl=N]` and compare to source.
- **Equivalence (anchor≡npl):** `${MAP_INGEST},geq=r='2.03*r(X,Y)':g='2.03*g(X,Y)':b='2.03*b(X,Y)',${HLG_FINISH}` vs `${MAP_INGEST},${HLG_FINISH}:npl=203` → both `0xC0`.
- **Faithful Split composite:** see `port_probe`'s `build_split` shape (video left 2624×2160 @x0,
  map right 1216×2160 @x2624, black bg working space, lift all to yuva444p10le, two overlays,
  back to gbrpf32le, shared finish, libx265 main10). `comp_real.mp4` reproduced the 62/63% bug.
  (Single-frame mp4 + this fc occasionally trips a muxer "Not yet implemented" — use `-frames:v 1`
  to a `.mkv`/ffv1 or multi-frame to avoid it.)

Gotcha: a python overlay+`geq` test rig kept returning all-black (harness bug, NOT the
mechanism — production overlay works). Validate the headroom path by building a real encoded
composite and reading the output signal, not the isolated python overlay rig.

---

## 7. File map
- `.spike/PORT_DESIGN.md` — **the design** (model, matrix, 4-part fix, registry sketch, open decisions).
- `.spike/HANDOFF.md` — this file.
- `.spike/FINDINGS.md` — original spike (correct physics; **`hstack`/per-branch-finishing
  premise superseded** for the real path — see §0).
- `.spike/port_probe/` — this session's probes + `white.png`, `comp_real.mp4`, `pq_*.mkv`.
- `.spike/lever_subsample/`, `lever_pq/` — KEEP (HQ subsample + PQ verification). `lever_keyline/`
  — DEFERRED/exploratory, do not redo.
