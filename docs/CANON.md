# TrailCut Decision Canon

**Status: LIVING DOCUMENT — the single decision canon for TrailCut.**

This file exists because the repo root once carried five generations of pipeline docs
(PIPELINE_RESEARCH.md, PIPELINE_DECISIONS.md, PIPELINE_TEACHING_HANDOFF.md,
COLOR_PIPELINE_SPEC.md, UNIVERSAL_WORKING_SPACE_REPORT.md) that contradicted the code
and each other. Every still-binding decision from those docs was harvested here
(2026-06-11, ship-review Phase 2b) and the source docs were quarantined into `attic/`
(gitignored, deny-listed — **never read or restore from attic/**). Source citations of
the form "(was: DOC §N)" are provenance only; the source is intentionally unreachable
and every entry here is self-contained.

How to read an entry's status:

- **DECIDED** — the decision is made and implemented; **the code location cited is the
  authority**, not this doc. If this doc and the code disagree, the code wins; fix this doc.
- **BINDING** — a rule or invariant that constrains future work (conventions, contracts,
  hard-won empirical knowledge). Violating it is a defect.
- **OPEN** — diagnosed/known but not yet done. These are the live work items the harvest surfaced.
- **REJECTED** — explicitly rejected or superseded. **Never re-propose** without new evidence;
  the reason is recorded with each entry.

Where the rest of the truth lives:

- **Color**: `src-tauri/src/util/color_space.rs` (the atomic-axes registry) +
  `docs/color-pipeline/` + this doc. Note `docs/color-pipeline/ARCHITECTURE.md`'s
  delivery-formula table is dead (superseded by `DeliveryTarget` in
  `src-tauri/src/export/delivery.rs`) and the doc set predates the registry and schema v9.
- **Export**: `docs/export/PLAN.md` / `LAYOUT.md` (principles binding; the IPC wire shape
  and encode tables there are stale — code in `src-tauri/src/export/` wins).
- **Map rendering**: `MAP_RENDERING_PLAN.md` (implemented; historical record of the lever model).
- **Migration history**: `docs/migration/` (closed; the compiled-timeline model it built is live).
- **Decorations**: `docs/map-decorations/` (implemented; `data-model.md` has drifted —
  `src/types.ts` wins, and its "schema v8 terminal" claims are stale: **v9 is current**, §1.8).
- **Spikes**: `docs/spikes/` (rescued spike docs: HDR port build spec, native-gl jitter findings).
- **Deliberate scope cuts**: `EXPORT_GAPS.md` (live gap registry — keep maintained).

---

## 1. Color pipeline

### 1.1 Working space — linear-light BT.2020, full range, `gbrpf32le` — DECIDED

One fixed working space for every project: linear-light RGB, BT.2020 primaries, full
range, planar float (`gbrpf32le`). All compositing math happens here; color transforms
happen only at the borders (ingest/delivery). HDR-first makes BT.2020 primaries
non-negotiable.
**Authority**: `ColorSpace::WORKING` at `src-tauri/src/util/color_space.rs:178-184`;
boundary-contract test pins the strings at `src-tauri/src/util/color.rs:809-813`;
`delivery.rs:182` passes `&ColorSpace::WORKING` unconditionally (single space, every project).

### 1.2 Atomic-axes color-space registry — DECIDED

A color space is four independent axes — primaries × transfer × range × matrix — plus an
optional npl. Ingest and delivery zscale filter strings are **generated** from the
registry, never hand-authored. The module's stated acceptance test: adding a new
transfer/primary/range/matrix is ONE new enum arm + token strings; nothing else changes
(`HdrPq` delivery was landed as the extensibility proof).
**Authority**: `src-tauri/src/util/color_space.rs` (contract stated at :22-26).
(Was: COLOR_PIPELINE_SPEC §1's axis model — the one part of that spec that survived; see §5.5.)

### 1.3 Map canvas ingests as sRGB (`tin=iec61966-2-1`), never retagged to bt709 — DECIDED

The WebGL map canvas emits sRGB (IEC 61966-2-1) pixels per the Khronos WebGL and W3C HTML
specs. Ingesting with `tin=iec61966-2-1` is colorimetrically correct. The sRGB EOTF and
the BT.709/BT.1886 chain are genuinely different curves; the small dark/mid-tone shift a
viewer perceives vs the preview is the **preview** drifting from spec, not the export.
Retagging the canvas to `tin=bt709` would silently misinterpret it — do not "fix" it that way.
**Authority**: `ColorSpace::SRGB` at `src-tauri/src/util/color_space.rs:186-194`.
(Was: PIPELINE_RESEARCH §1.2/§6.1, direction A2 — decided ACCEPT in code.)

### 1.4 Two-step ingest shape — DECIDED

The generated ingest chain is load-bearing in its shape: the first zscale **only
linearizes, keeping source primaries**; then a `format=` hop to float; then a second
zscale does the primaries/matrix hop. For the map's rawvideo input, all four source tags
(primaries/transfer/matrix/range) must be stated explicitly or zimg fails filter planning
with error code 3074 ("no path between colorspaces").
**Authority**: `src-tauri/src/util/color_space.rs:260-276` (two-step shape :273-276,
explicit-tags requirement :268-271).

### 1.5 npl at ingest only, never on delivery — DECIDED

Nominal peak luminance is an ingest-side linearization parameter: HLG ingest uses
`npl=400`, PQ ingest uses `npl=1000`. The delivery chain deliberately emits **no npl** —
the encoder's `-color_trc` carries HDR signaling. (The old research recommendation to put
`npl=1000` on the HLG finishing filter is superseded — see §5.3.)
**Authority**: `src-tauri/src/util/color_space.rs:331-338` (ingest npl), :317-320
(delivery emits none); tests in `src-tauri/src/util/color.rs:826, 851, 859`.

### 1.6 Every `overlay` pins `:format=yuv444p10` — DECIDED

FFmpeg's `overlay` without an explicit `format=` silently auto-inserts a swscale that
downconverts to yuv420 **and strips color tags to `unknown`** (see §4.1). Every overlay in
the export filtergraph therefore pins `:format=yuv444p10`, asserted string-exact by tests.
**Authority**: `src-tauri/src/export/filtergraph.rs:730, 742, 772, 784, 850` + the
in-module tests (`mod tests` at filtergraph.rs:939+).

### 1.7 VUI duplication into x264/x265 params + `hvc1` — DECIDED

libx264/libx265 silently drop the global `-color_primaries`/`-color_trc` flags from the
bitstream VUI unless they are duplicated into `-x264-params`/`-x265-params`; without the
duplication the `colr` atom is wrong or missing. Every SDR/HDR software-encode target
emits both. All HEVC paths tag `-tag:v hvc1` (`hev1` does not play on Apple devices).
This approach **replaced** the researched `hdr-opt=1:repeat-headers=1` proposal (see §5.6).
**Authority**: `src-tauri/src/export/delivery.rs:188-199` (doc comment + `push_vui_params`
call sites); `hvc1` at delivery.rs:228, 237, 250+.

### 1.8 Schema v9 — project working space + per-clip color override — DECIDED

`CURRENT_SCHEMA_VERSION = 9`. v9 added: project-level
`working_color_space: WorkingColorSpaceId` (an enum with one variant today,
`LinearBt2020Full`) and per-clip `color_space_override: Option<PerAxisOverride>` (a
per-axis **source assertion**, parsed from zscale tokens). The migration is purely
additive (serde defaults).
**Authority**: `src-tauri/src/models.rs:68-92, 158, 272, 978`;
`migrate_v8_to_v9` at `src-tauri/src/commands/project.rs:392-410`;
override parsing at `src-tauri/src/util/color_space.rs:228-250`.

### 1.9 HDR is current and co-equal — DECIDED

HDR is a **shipped, current** delivery capability, not a near-term aspiration:
`DeliveryTarget` is `{SdrH264, SdrH265, HdrHlg, HdrPq, ProresAlpha}` today. HDR and SDR
channels are targeted equally; no "SDR-default" reasoning is admissible in any pipeline
decision (see §5.2).
**Authority**: `src-tauri/src/export/delivery.rs:58-82` (HdrPq at :77).

### 1.10 Delivery-target conformance details — BINDING

Hard-won conformance rules that are easy to get wrong (was: PIPELINE_RESEARCH §2, §1.7):

- **ProRes 4444 masters are tagged limited range** (`r=limited`), not full. Resolve and
  FCP honor the NCLC `colr` atom strictly; a full-range tag is a known cause of gamma
  shifts on import. Camera vendors (ARRI, Sony, RED) all ship ProRes masters limited-range.
- **HLG carries no MaxCLL/MaxFALL/SMPTE ST 2086 mastering metadata.** HLG is scene-referred
  (relative); static mastering metadata is a PQ-only concept. Do not add it to HLG exports.
- **`hvc1`, never `hev1`**, for every HEVC output (Apple playback requirement).
- Expected ffprobe tags per target: SDR = `bt709/bt709/bt709/tv`;
  HLG = `bt2020/arib-std-b67/bt2020nc/tv`; PQ = `bt2020/smpte2084/bt2020nc/tv`;
  ProRes 4444 = `bt709/bt709/bt709/tv` with `colr nclc 1 1 1`.

### 1.11 Loud test failures on missing preconditions — BINDING

Tests fail loudly when a precondition is missing (zscale-capable FFmpeg, sidecars, etc.) —
never silent skip-with-warning. Reference implementation: `assert_ffmpeg_has_zscale` at
`src-tauri/tests/color_fixtures.rs:63`. The three known violations (golden_frame_parity's
`TRAILCUT_CHROME_BIN` silent skip, 2× ffmpeg_runner eprintln+return) were converted to
loud panics in ship-review Phase 3 — zero silent skips remain.

---

## 2. Map rendering

### 2.1 Perceived-scale invariance + the lever model — DECIDED

Product-owner spec: the same route + export settings must look the same apparent scale
across aspect ratios AND resolutions — aspect changes shape/visible-area only, resolution
changes pixel density only. Implementation (the "lever model"): **cssViewport tracks the
slot shape; pixelRatio absorbs resolution** (multiplier =
`output_dims(aspect,res).w / output_dims(aspect,'1080p').w`); overlay paints are fixed
CSS-px constants against `PAINT_REFERENCE_WIDTH = 1080`, not viewport-tracking.
**Authority**: `canonical_map_viewport` at `src-tauri/src/export/layout.rs:119-134`,
mirrored in `src/lib/layout.ts`; `PAINT_REFERENCE_WIDTH` at `src/lib/mapVisuals/styleSpec.ts:50`.

Settled sub-decisions (do not relitigate): **no sub-1080p rendering** (720p = render
1080p + FFmpeg downsample; sub-1 pixelRatio puts MapLibre in a barely-tested regime —
label snap, dasharray, tile-zoom glitches); **per-clip camera zoom is one number**;
**preview keeps the `log2(pane/canonical)` compensation** for WYSIWYG authoring.
Negative knowledge: the early "render-then-crop" and "aspect-agnostic preview" drafts
were wrong — aspect must change the visible area.

### 2.2 SSAA supersampling ≥2× with on-GPU downsample — DECIDED

Every map export supersamples at a factor ≥ 2 (`map_supersample_factor`), **orthogonal to**
the lever model's pixelRatio: the renderer framebuffer = slot × factor, and the downsample
to slot size happens **on-GPU before readback**, so frames cross the CDP wire at slot size
(base64, hard 100 MB cap — higher throughput needs a non-CDP transport, not a bigger
factor). This is what closed the export-sharpness gap (see §4.5); the researched
alternative — rewriting `canonical_map_viewport` to a literal fixed `pixel_ratio = 2.0` —
was implemented differently and is superseded (see §5.4).
**Authority**: `src-tauri/src/export/layout.rs:136-173` (test asserts ≥2× at :544-545);
`src-tauri/src/export/mod.rs:480, 527`; `src-tauri/sidecars/renderer/page/init.ts:267-271, 669`.
Note: the renderer's effective DPR carries the supersample factor, so MAP_RENDERING_PLAN's
"pixelRatio ∈ {1, 4/3, 2} always" no longer describes the as-built composition.

### 2.3 mapVisuals single source of visual truth — BINDING

Anything derivable from `MapSettings` flows through `resolveStaticPaints` /
`buildPerFrameState` in `src/lib/mapVisuals/`. Both `MapView.tsx` (preview) and the
renderer sidecar apply the same returned tuples. Never write an ad-hoc
`setPaintProperty`/`setLayoutProperty` in `MapView` for `MapSettings`-derived state —
preview and export silently diverge. `lineMetrics: true` is required at all four
`addSource` sites (gradients break without it). Enforced structurally (one shared TS
module imported by both runtimes), not by discipline.

### 2.4 Map decorations are independent — BINDING

Route / Waypoints / POV each own their color/gradient configuration; there is no shared
palette. Linking is a one-shot copy button, never a live binding. Route + Waypoints
support gradients (parameterized by trail distance); per-clip waypoint overrides and POV
are solid-only. Decoration sizes are fractions of the 1080-CSS-px reference width
(perceived-scale invariance). Landed via the map-decorations commits (`9d498ad`…`bf4ebeb`);
see `docs/map-decorations/` (noting `data-model.md` has drifted — `src/types.ts` wins).

---

## 3. Export

### 3.1 Export filename schema and queue ordering — DECIDED

Filenames: `{slug}__{aspect}__{quality}__{channel}.{ext}`. Queue ordering: aspect →
channel display order, then quality tier ascending.
**Authority**: `src/lib/exportFilenames.ts`. (Was: EXPORT_REDESIGN_HANDOFF "Approved blueprint".)

### 3.2 Export architecture pointers — DECIDED (elsewhere)

The three-channel model (A composite / B map-only / C video-only as masked positional
ProRes 4444), the per-clip chain `trim → setpts → focal-crop → scale`, the renderer
IPC protocol, and "codec preference never silently falls back" are canon in
`docs/export/PLAN.md` + `LAYOUT.md` + `plans/export-controls.md`, with the caveat that the
wire-shape and encode tables there are stale — `src-tauri/src/export/protocol.rs` and
`delivery.rs` win.

---

## 4. Hard-won empirical knowledge (the gems) — all BINDING

### 4.1 FFmpeg overlay's silent yuv420 default

`overlay` with no `format=` auto-inserts a swscale that downconverts to yuv420 **and
strips the color tags to `unknown`**. Textual filtergraph reasoning cannot see FFmpeg's
auto-inserted scalers — always pair filtergraph changes with a `-loglevel verbose` dry-run
and look for `auto_scale_*` insertions. Encoded in code as §1.6.
(Was: PIPELINE_RESEARCH §1.5/§5.2.)

### 4.2 zscale's silent defaults + the dither placement rule

zscale's documented defaults are `d=none` (no dither) and `f=bilinear` (soft chroma
resample kernel); any depth-reduction or chroma-subsample step inherits them unless
overridden. Dither is only ever meaningful at depth reductions (float→10-bit/8-bit) —
adding it anywhere else in a float chain is a no-op. (Was: PIPELINE_RESEARCH §1.1/§3.2/§2.)

### 4.3 Primaries vs transfer asymmetry

Routing SDR through wide **primaries** (BT.2020/AP1) is free: a single exactly-invertible
3×3 matrix in linear float; no clipping because BT.2020 ⊃ BT.709. Routing SDR through an
HDR **transfer** (PQ/HLG) and back is the real tax: precision loss where the curve
allocates codes SDR doesn't use, the "how many nits is SDR white" convention, and any
creative inverse tone-map. This one distinction dissolves the "universal working space"
debate and is why the fixed BT.2020-linear working space is sound under HDR-first: every
project shares the primaries; SDR projects simply never enter an HDR transfer function.
Caveat preserved for a hypothetical Cinema tier: BT.2020 contains every **delivery** gamut
but not every **acquisition** gamut (ARRI Wide Gamut 4, REDWideGamutRGB, S-Gamut3.Cine,
Canon Cinema Gamut all exceed it — that's why ACEScg AP1 / DaVinci Wide Gamut exist).
(Was: UNIVERSAL_WORKING_SPACE_REPORT §5.)

### 4.4 The compositing wrinkle

TrailCut composites a map over the video on **every frame**, so "bit-pass the clip
through" is moot wherever the map touches: those pixels are computed, not copied. The
right quality goal is "indistinguishable from source where un-occluded, physically
correct where composited" — and linear-light blending
(`out = srcAlpha·map + (1−srcAlpha)·video` in linear float) is mandatory in every project
mode; gamma-space blending darkens midtones at edges and produces off-color halos
(GPU Gems 3 ch. 24). (Was: UNIVERSAL_WORKING_SPACE_REPORT §6.)

### 4.5 The export-softness mechanism

The preview runs at Retina DPR 2, giving 2× supersampling of MapLibre's SDF glyphs
(rasterized at 24-px design size, `GLYPH_PBF_BORDER = 3`); a 1×-rendered export gets none —
that was the sharpness gap. OpenFreeMap publishes sprites at 1× only (no `@2x` sheet), so
raster POI icons are the softest element at any pixelRatio > 1. Resolved in code by SSAA
≥2 (§2.2). Decoration-side crispness fixes (keyline, soft glow) were tried and **rejected
on looks — do not redo them**; the surviving decoration-side lever is high-res baked
symbol icons (edge AA in the icon alpha), validated in a spike but not yet ported to
`renderer/shapes.ts`. (Was: PIPELINE_RESEARCH §4.1/§4.4.)

### 4.6 sRGB-EOTF vs BT.1886 preview drift

The exported file is correct; the preview is what drifts (see §1.3). The residual between
sRGB's piecewise EOTF and BT.709-OETF→BT.1886-EOTF playback is concentrated below code 16
and under the visible-difference threshold for motion content. Ship the colorimetrically
correct path; revisit only with a demonstrable side-by-side. (Was: PIPELINE_RESEARCH §6.1.)

### 4.7 The two-symptom discipline

The real export-quality regressions were **(1) the map is off-color** (a color-space
problem) and **(2) edges are blurry** (a resolution/sampling problem) — both
preview-vs-export divergence. Every quality proposal must be tied to one of the two
symptoms or explicitly declared as addressing neither; the dither episode (§5.1) is the
cautionary tale of optimizing a symptom nobody observed. Research docs are maps, not
ground truth — confirm claims empirically before acting on them.
(Was: PIPELINE_TEACHING_HANDOFF "The two symptoms".)

### 4.8 BT.2408 reference white (the 203-nit convention)

SDR/graphics diffuse white composited onto an HDR canvas must be anchored at 203 nit
(75% HLG signal) per ITU-R BT.2408 — a **convention, not a derivation** ("how many nits is
SDR white" has no physics answer). Scene-linear 1.0 lands at ~62% HLG instead, which reads
visibly dark. This is the diagnosed root cause of the dark HDR map exports — see OPEN item §6.1.
(Was: UNIVERSAL_WORKING_SPACE_REPORT §5.)

---

## 5. Rejected approaches — never re-propose without new evidence

### 5.1 Dither as the headline export-quality fix — REJECTED (debunked)

The research's #1 recommendation ("the single highest-impact fix is dither",
`d=error_diffusion` on delivery finishing filters) was debunked: its "166→198 unique
greens" claim did not reproduce on a controlled input, and Matthew cannot reproduce
banding in real exports. Banding was never one of the two real symptoms (§4.7). No
`d=error_diffusion` exists anywhere in `src-tauri/src`, deliberately. Dither remains a
legitimate tool **iff** visible banding is ever actually demonstrated at a depth reduction —
but it is not a standing recommendation. (Was: PIPELINE_RESEARCH §1.1; DECISIONS A1-dither.)

### 5.2 SDR-simplification of the working space — REJECTED

The research suggested "simplify to sRGB-linear working space unless HDR is near-term"
and "mark HDR 'advanced'; primary marketing target is SDR." Both violate the binding
HDR-co-equal rule (§1.9): HDR ships today and is targeted equally with SDR. No
SDR-default reasoning, ever. (Was: PIPELINE_RESEARCH §1.6/§6.2–6.3, explicitly overridden
by the teaching handoff's hard constraints.)

### 5.3 `npl=1000` on HLG delivery — REJECTED (superseded)

The research recommended adding `npl=1000` to the HLG finishing zscale. The code
deliberately emits **no npl on delivery** — npl is an ingest-only linearization parameter
(§1.5); the encoder's `-color_trc` carries signaling. Code won. (Was: PIPELINE_RESEARCH §3.2.)

### 5.4 Literal `pixel_ratio = 2.0` rewrite of `canonical_map_viewport` — REJECTED (superseded)

The research proposed rewriting the lever model to a fixed pixel_ratio of 2.0 (shrinking
cssW, downsampling in FFmpeg with `f=spline36`). Implemented differently: the lever model
was kept intact and supersampling landed as a separate orthogonal SSAA factor with an
**on-GPU** downsample (§2.2). Side effects of the supersession: the accepted-on-paper
`f=spline36` chroma-kernel decision (DECISIONS A1-kernel) was never landed —
`spline36` appears nowhere in the tree — because SSAA addressed sharpness upstream; and
the researched MapLibre constructor flags (`canvasContextAttributes: { antialias: true,
preserveDrawingBuffer: true }`) were likewise not adopted (SSAA supersedes MSAA here; the
sticky `'render'`-listener readback workaround remains the path). Do not "finish
implementing" any of these from the old ledger. (Was: PIPELINE_RESEARCH §4.1/§4.2; DECISIONS A1-kernel/B1/B2.)

### 5.5 COLOR_PIPELINE_SPEC's node taxonomy, per-mode working spaces, and 4-layer cascade — REJECTED (implemented differently)

The spec's "LOCKED" sections were not built as written: no 7-node taxonomy /
renderer-validator / coalescer / snapshot performance contract (the registry generates the
two chain shapes directly — `ingest_zscale_chain` / `delivery_zscale_chain`); no per-mode
working spaces (ConsumerSdr ⇒ Rec709-linear etc. — one fixed BT.2020-linear space is used
for every project); no `ClipColor` 4-layer cascade re-probed at every resolve (shipped:
`working_color_space` selection + per-clip `PerAxisOverride` assertion, §1.8); no
chroma-siting setting; no BT.2446 `ToneMap` node. The axis model itself (§1.2) is the part
that survived. The code's simpler design won; do not resurrect the spec's machinery.
(Was: COLOR_PIPELINE_SPEC §2–§6.)

### 5.6 `hdr-opt=1:repeat-headers=1` on x265 — REJECTED (superseded)

The researched x265 flags for HDR VUI emission were never adopted; the VUI-duplication
approach (§1.7) covers the actual failure mode (libx264/x265 dropping global color flags).
(Was: PIPELINE_RESEARCH §1.7/§3.3; DECISIONS C3.)

### 5.7 Heavier color machinery rejected on principle — REJECTED

From the universal-working-space research, still standing: **no ACES/OCIO framework**
(grading-room pipeline overhead; TrailCut needs ~three transforms, not a transform-config
system); **no auto inverse tone-mapping** for SDR-in/HDR-out (creative, not invertible,
per BT.2446/BT.2408 — SDR clips get a colorimetric lift and sit at their native brightness
on the HDR canvas); **no per-clip-native processing** (breaks linear-light compositing the
moment clips meet the map); **no stream-copy/smart-render path** (the map composites every
frame); **no native ARRIRAW/REDCODE/Cinema-RAW-Light decode** (restrictive SDKs, rare in
the hiking use case — pre-transcode to ProRes/DNxHR is the documented answer; BRAW was the
one flagged maybe). (Was: UNIVERSAL_WORKING_SPACE_REPORT §8.)

### 5.8 Working pix_fmt `gbrapf32le` (alpha-preserving) — NOT ADOPTED (defer)

The research proposed migrating the working space to `gbrapf32le` so the map's native
alpha survives the linear leg; today `gbrpf32le` drops alpha and the chain re-attaches it
at the `yuva444p10le` lift. This is invisible while the basemap is opaque; it becomes real
only if a transparent-map / decorations-only mode ships. Not a standing TODO — re-evaluate
**when** such a mode is proposed. (Was: PIPELINE_RESEARCH §1.4/§3.4; DECISIONS C1.)

---

## 6. Open items (live, surfaced by the harvest)

### 6.1 npl=203 reference-white anchoring for HDR map exports — OPEN

Diagnosed, **not in code** (`203` appears nowhere in `src-tauri/src`): HDR-HLG/PQ map
exports are dark because the SDR map graphics are encoded scene-linear (white → ~62% HLG)
instead of anchored at BT.2408 reference white (203 nit / 75% HLG; PQ verified the same
bug — signal 0.58). Fix = `npl=203` anchoring at the map→working seam. Not a renderer,
subsampling, or hue problem. This is the single most valuable undone item the doc
reconciliation surfaced. (See §4.8 for the underlying convention.)

**Pinned by the Phase 3 tracer oracle (2026-06-11):** the
`hdr_reference_white_tracer_{hlg,pq}` tests in `src-tauri/tests/color_fixtures.rs` push
map-white through the real delivery chain and decode the result — measured 0.630 HLG /
0.509 PQ against the 0.75 / 0.58 reference. They are red-by-design in CI (dedicated
`hdr-tracer` job in `.github/workflows/ci.yml`) and go green when the Phase 4 fix lands.

### 6.2 Sidecar bundling (task 130) — OPEN, required before ship

ffmpeg/ffprobe/exiftool/node resolve via `PATH` today; only chrome-headless-shell is
bundled (`src-tauri/tauri.conf.json`). Bundling is deferred as "task 130" but **required
before ship** (the app goes to end users who do not have Homebrew FFmpeg). The task was
never authored.

### 6.3 Preview ≡ export parity gate (task 120) — OPEN, never authored

The only end-to-end check that export visually matches preview has been deferred since
2026-05-02 across a supersession chain (migration task 640 → export task 120 → never
authored) — while preview/export divergence became the headline quality pain. The golden-
frame test (`src-tauri/tests/golden_frame_parity.rs`) is a renderer-regression guard
against fixtures, not a preview-vs-export comparison. (Its former `TRAILCUT_CHROME_BIN`
silent skip was converted to a loud panic in ship-review Phase 3 — see §1.11.)

### 6.4 Live gap registry — OPEN (tracked elsewhere)

`EXPORT_GAPS.md` is the live registry of deliberate scope cuts; GAP-003 (CRF hardcoded at
18 in every software-encoder branch of `delivery_encoder_args`) re-verified true at the
2026-06 ship review. Keep maintaining it there, not here.

---

## 7. References

Preserved verbatim from the quarantined research docs — these bibliographies are curated
and worth keeping permanently.

### 7.1 Color science (was: PIPELINE_RESEARCH §7)

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

### 7.2 FFmpeg / zimg / zscale (was: PIPELINE_RESEARCH §7)

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

### 7.3 MapLibre (was: PIPELINE_RESEARCH §7)

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

### 7.4 Delivery target conformance (was: PIPELINE_RESEARCH §7)

- YouTube HDR upload spec: https://support.google.com/youtube/answer/7126552
- YouTube SDR recommended upload encoding settings: https://support.google.com/youtube/answer/1722171
- Apple ProRes White Paper (April 2022): https://www.apple.com/final-cut-pro/docs/Apple_ProRes.pdf
- Academy Software Foundation EncodingGuidelines (ProRes): https://github.com/AcademySoftwareFoundation/EncodingGuidelines/blob/main/EncodeProres.md
- Chromium issue 655417 (mp4 colr handling): https://bugs.chromium.org/p/chromium/issues/detail?id=655417
- Apple Developer forum thread 680798 (QuickTime colr tags): https://developer.apple.com/forums/thread/680798
- forum.logik.tv "Gamma issues with .mov colorspace metadata in QuickTime's NCLC tags": https://forum.logik.tv/t/gamma-issues-with-mov-colorspace-metadata-in-quicktimes-nclc-tags/1352
- EBU TR 038 (HLG subjective evaluation): https://tech.ebu.ch/docs/techreports/tr038.pdf
- Codec Wiki — VideoToolbox encoder: https://wiki.x266.mov/docs/encoders_hw/videotoolbox

### 7.5 Khronos / WebGL (was: PIPELINE_RESEARCH §7)

- Khronos WebGL 1.0 Spec §5.2 (premultipliedAlpha default): https://registry.khronos.org/webgl/specs/latest/1.0/
- Khronos WebGL 2.0 Spec §2.2 (sRGB output): https://registry.khronos.org/webgl/specs/latest/2.0/
- W3C HTML Living Standard §4.12.5 (canvas color space): https://html.spec.whatwg.org/multipage/canvas.html#color-spaces
- Apple TN2313 (color management): https://developer.apple.com/library/archive/technotes/tn2313/_index.html
- Microsoft DXGI format docs: https://learn.microsoft.com/en-us/windows/win32/api/dxgiformat/

### 7.6 Universal-working-space report references (was: UNIVERSAL_WORKING_SPACE_REPORT [1]–[27])

- [1] Apple Final Cut Pro — Use wide-gamut HDR color processing. https://support.apple.com/guide/final-cut-pro/use-wide-gamut-hdr-color-processing-ver1cd9629a5/mac
- [2] Blackmagic DaVinci Resolve 18 manual — Choosing a Timeline Color Space. https://www.steakunderwater.com/VFXPedia/__man/Resolve18-6/DaVinciResolve18_Manual_files/part295.htm
- [3] Adobe helpx — Premiere Pro color management options. https://helpx.adobe.com/premiere/desktop/correct-color/set-up-color-management/color-management-options.html
- [4] Larry Jordan — The New Color Workflow in Adobe Premiere Pro 2025. https://larryjordan.com/articles/the-new-color-workflow-in-adobe-premiere-pro-2025/
- [5] ITU-R BT.2100-2 — Image parameter values for HDR television. https://glenwing.github.io/docs/ITU-R-BT.2100-2.pdf
- [6] ITU-R BT.2408-7 — Guidance for operational practices in HDR television production. https://www.itu.int/dms_pub/itu-r/opb/rep/R-REP-BT.2408-7-2023-PDF-E.pdf
- [7] ITU-R BT.2446-1 — Methods for conversion of HDR and SDR content. https://www.itu.int/dms_pub/itu-r/opb/rep/R-REP-BT.2446-1-2021-PDF-E.pdf
- [8] SMPTE ST 2065-1 — Academy Color Encoding Specification (ACES). https://pub.smpte.org/pub/st2065-1/st2065-1-2021.pdf
- [9] Apple Developer TN3145 — HDR video metadata. https://developer.apple.com/documentation/technotes/tn3145-hdr-video-metadata
- [10] Apple — Incorporating HDR video with Dolby Vision into your apps. https://developer.apple.com/av-foundation/Incorporating-HDR-video-with-Dolby-Vision-into-your-apps.pdf
- [11] Nvidia GPU Gems 3, Chapter 24 — The Importance of Being Linear. https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-24-importance-being-linear
- [12] ISO 22028-1:2016 — Photography and graphic technology, extended colour encodings. https://cdn.standards.iteh.ai/samples/68761/d90cf953f097405db2fc6e151b8410c7/ISO-22028-1-2016.pdf
- [13] Blackmagic — DaVinci Wide Gamut Intermediate (Resolve 17). https://documents.blackmagicdesign.com/InformationNotes/DaVinci_Resolve_17_Wide_Gamut_Intermediate.pdf
- [14] ACESCentral — ACES Working Spaces. https://acescentral.com/knowledge-base-2/aces-working-spaces/
- [15] ACES — Reference Gamut Compression overview. https://docs.acescentral.com/rgc/overview/
- [16] Stu Maschwitz (Prolost) — On ACES. https://prolost.com/blog/aces
- [17] OpenColorIO — Concepts overview. https://opencolorio.readthedocs.io/en/latest/concepts/overview/overview.html
- [18] Netflix Partner Help — Dolby Vision HDR Mastering Guidelines. https://partnerhelp.netflixstudios.com/hc/en-us/articles/360000599948-Dolby-Vision-HDR-Mastering-Guidelines
- [19] Adobe helpx — Premiere Pro smart rendering. https://helpx.adobe.com/premiere-pro/using/smart-rendering.html
- [20] Glenn Chan — Towards Better Chroma Subsampling. http://www.glennchan.info/articles/technical/chroma/chroma1.htm
- [21] thepostprocess.com — How to deal with levels: Full vs Video. https://www.thepostprocess.com/2019/09/24/how-to-deal-with-levels-full-vs-video/
- [22] GIMP documentation — Image precision. https://docs.gimp.org/2.10/en/gimp-image-precision.html
- [23] Canva engineering — A journey through colour space with FFmpeg. https://www.canva.dev/blog/engineering/a-journey-through-colour-space-with-ffmpeg/
- [24] HandBrake documentation — HDR. https://handbrake.fr/docs/en/latest/technical/hdr.html
- [25] MovieLabs — Mapping BT.709 to HDR10. https://www.movielabs.com/ngvideo/MovieLabs_Mapping_BT.709_to_HDR10_v1.0.pdf
- [26] Academy Software Foundation — ACES dev repository (canonical IDT implementations for ARRI LogC, RED Log3G10, Sony S-Log3, Canon CLog, Panasonic V-Log, and others). https://github.com/AcademySoftwareFoundation/aces-dev
- [27] Manufacturer color-science white papers (ARRI LogC3/C4, RED IPP2/Log3G10/REDWideGamutRGB, Sony S-Log3/S-Gamut3.Cine, Blackmagic Gen 5): URLs rotate; the ACES IDT repository [26] is the stable canonical source for the actual transforms.
