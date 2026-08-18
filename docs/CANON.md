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

### 1.5 npl at ingest only, never on delivery; npl=100 absolute working space — DECIDED

Nominal peak luminance is an ingest-side linearization parameter. Since the Phase 4 HDR
port (2026-06-11): **HLG and PQ both ingest at `npl=100`** — the absolute working-space
convention (linear 1.0 = 100 nits), confirmed by Matthew (npl=1000 rejected; see
`docs/spikes/IMPLEMENTATION.md` §0). zimg's HLG/PQ *finishing* default is also npl=100,
so HDR video round-trips as identity (the pre-Phase-4 400/1000 ingest darkened HLG
240→183 across a round-trip). The delivery chain deliberately emits **no npl** — the
encoder's `-color_trc` carries HDR signaling, and the BT.2408 reference-white anchor for
SDR-origin content is an ingest-side ×2.03 linear gain (see §1.12), NOT an npl on
delivery. (The old research recommendation to put `npl=1000` on the HLG finishing filter
is superseded — see §5.3.)
**Authority**: `src-tauri/src/util/color_space.rs` (`default_npl_for`, the
`HDR_*_BT2020` constants; delivery chain emits none); tests
`ingest_{hlg,pq}_pins_npl_100_absolute_space`, `delivery_never_emits_npl` (same file),
and the round-trip identity tests `hdr_video_round_trip_{hlg,pq}_*` in
`src-tauri/tests/color_fixtures.rs`.

### 1.12 SDR-origin→HDR anchor (×2.03 at ingest) + HDR-gated composite PQ transport — DECIDED

The per-origin × per-delivery matrix: SDR-origin sources (the map canvas is always
sRGB/SDR-origin; SDR clips; developed log clips) delivered to an HDR target carry a
**×2.03 linear gain at the ingest tail** (`sdr_origin_anchor_gain` — 203-nit BT.2408
graphics white / 100-nit SDR diffuse white, proven byte-equivalent to `npl=203`
finishing). HDR-origin sources are NEVER anchored (they carry absolute nits); SDR→SDR is
native. Gains are emitted by `linear_gain_filter` (a clamp-free `colorchannelmixer`
chain, stages ≤2.0 — `geq` clamps [0,1] and `exposure` caps ±3 stops, both unusable).

The composite's 10-bit `yuva444p10le` overlay lift quantizes the working space onto a
10-bit INTEGER grid clamped to [0,1], so on HDR delivery every color-stream lift is
wrapped in a **PQ transport curve** (fix C′): `composite_transport_encode`
(`zscale=t=smpte2084`, linear→PQ) immediately before the lift, `composite_transport_decode`
(`zscale=tin=smpte2084:t=linear:npl=100`, PQ→linear at the npl=100 absolute convention)
immediately after the post-overlay return to `gbrpf32le`. PQ allocates 10-bit codes
perceptually, so the anchored SDR-origin map (linear 0–2.03) keeps its precision through
the grid: measured **256/256 distinct levels and ≤0.33° hue** vs a pure-float reference.
SDR delivery gets neither anchor nor transport (a PQ round-trip there would needlessly
requantize the gradient).

> **History — fix C → C′ (2026-06-12).** The original fix C wrapped the lift in a LINEAR
> ÷32/×32 headroom (`COMPOSITE_HEADROOM = 32`). Because the ÷32 ran in linear light it
> crushed the anchored map (linear 0–2.03) into the bottom ~6.3% of the grid — a 256-step
> ramp collapsed to **66 distinct levels** and flat decoration colors shifted hue up to
> **12.5°** (the HDR-only grit / wrong-hue / temporal shimmer Matthew saw on HLG+PQ hand
> exports; PQ worst because its EOTF stretches the bottom of the range hardest; footage
> spans ~77% of the range + sensor noise dithers, so it looked fine; SDR has no ÷32, so it
> was fine). Root-caused + empirically proven in `/tmp/hdr-grit-probe/`; fixed by the PQ
> transport above (probe `D_pq_transport.raw`). This **retires** the old "PQ source >3200
> nit clips at H=32" bound: PQ encodes absolute 0–10,000 nits, so at npl=100 (linear 1.0 =
> 100 nits) the transport covers linear 0–100 with no clipping — the new ceiling is PQ's
> own 10k-nit format limit.

4:2:0 finishing splits the fused `format=` hop into 4:4:4 → lanczos chroma resample →
4:2:0 (HQ subsample, both SDR and HDR).
**Authority**: `src-tauri/src/util/color_space.rs` (`sdr_origin_anchor_gain`,
`linear_gain_filter`, `composite_transport_encode`/`composite_transport_decode`),
`src-tauri/src/export/filtergraph.rs` (`build_composite_filter_complex`),
`src-tauri/src/export/delivery.rs` (`delivery_finishing_filter`); decoded-frame gates:
`hdr_reference_white_tracer_*`, `hdr_video_round_trip_*`, `composite_chains_verbose_dry_run_*`,
`sdr_delivery_map_white_stays_at_sdr_white`,
`composite_pq_transport_ramp_retains_distinct_levels`,
`composite_pq_transport_preserves_decoration_hue` in `src-tauri/tests/color_fixtures.rs`;
string pins `composite_transport_round_trip_strings`,
`composite_hdr_delivery_anchors_sdr_origins_and_wraps_lifts_in_pq_transport`,
`composite_sdr_delivery_emits_no_anchor_and_no_transport`.
Known bound (flagged, not hidden): HDR→SDR delivery still hard-clips highlights
(tone-map operator is a Matthew-confirmed follow-up, NOT part of Phase 4). The fix-C
"PQ >3200 nit at H=32" bound is RETIRED (see history above).

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
label snap, dasharray, tile-zoom glitches); **per-clip camera zoom is one number**.
Negative knowledge: the early "render-then-crop" and "aspect-agnostic preview" drafts
were wrong — aspect must change the visible area.
[2026-07-03 history: this entry originally said "preview keeps the `log2(pane/canonical)`
compensation" — that pane-width-coupled compensation was removed at 955d45c and the
preview's display anchoring is now §2.6's fixed screen-fit scale, which is NOT a function
of pane width.]

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
support gradients (parameterized by trail distance); POV is solid-only (single point,
nothing to gradient across). Decoration sizes are fractions of the 1080-CSS-px reference
width (perceived-scale invariance). Landed via the map-decorations commits
(`9d498ad`…`bf4ebeb`); see `docs/map-decorations/` (noting `data-model.md` has drifted —
`src/types.ts` wins).

**Everything is per-clip overridable (2026-07-07 revision).** Every MapSettings-derived
decoration control carries full capability parity in clip scope: route color (solid AND
gradient), all three halos, waypoint colors/gradients, and a clip-level default waypoint
marker. The earlier "route color is project-wide" and "halo is project-level only" rules
are REJECTED — the only project-pinned MapSettings field is the `marker_images` asset
library. Object-valued override leaves (`color`, `halo`, `marker`) diff by deep-equal
comparators in `src/types.ts` (`decorationColorEquals`, `haloSettingsEquals`,
`povMarkerEquals`), never by reference. The clip-level waypoint marker override is one
atomic `{shape, marker_image_id?}` leaf (a sparse two-field diff can't express "image
cleared"). PER-WAYPOINT entity overrides (`Waypoint.color`/`shape`/`marker_image_id`,
solid-only) are unchanged and win per feature over the clip-level values; in clip scope
the panel stacks both surfaces (clip-level control first, associated-waypoint control
below it).

### 2.5 Export map renderer — maplibre-gl-native, cutover complete — DECIDED

**Decision (Phase 5 renderer strangle; port landed 2026-07-02, cutover completed
2026-07-02).** The export renderer worker (`src-tauri/sidecars/renderer/index.ts`) is a
protocol shell over one rendering backend behind the `backend.ts` interface:
`nativeBackend.ts` — maplibre-gl-native **in-process**, no Chrome/CDP. The pre-strangle
chrome backend (headless Chrome + maplibre-gl-js) shipped behind the same interface
during the strangle window and was **removed after the cutover** (git history has it;
the strip commit lists everything it took with it — CfT download, page bundle,
`TRAILCUT_CHROME_BIN`, the chrome golden set). `TRAILCUT_RENDERER_BACKEND` survives as
a loud single-value switch (`native`; a stale `chrome` throws a removal notice — no
silent fallback), and the orchestrator can still pin per-worker via
`OrchestratorConfig::renderer_backend` so a stale parent env never decides what a test
renders with. The stdio wire format (`export/protocol.rs`, unchanged) is
backend-invariant. The engine-agnostic per-frame translation lives in `scene.ts` —
parity with the preview by shared derivation (measured ≤0.03 CSS px cross-engine
decoration placement while both engines existed).

**Cutover evidence**: golden-frame pixel gate on the native backend
(`golden_frame_parity_native`, `src-tauri/tests/golden_frame_parity.rs` — raw
`render_map_frames` output vs committed `native-frame-*.png`, ±1-LSB measured GPU
tolerance), all reference-free oracles green through the production worker
(`PRODUCTION_WORKER_GATES.md`), HDR anchors through the real composite argv
(`native_hdr_composite.rs`), and Matthew's hand-export parity pass (2026-07-02).
A prior wording of this section claimed the cutover needed a "cross-engine golden-frame
gate that cannot exist until the color lane lands and a look is approved" — that was a
conflation. The golden gate pins RAW RENDERER FRAMES, captured before any FFmpeg
compositing or delivery-target color handling, so it has ZERO dependency on the color
lane. The thing that does depend on the color lane is a full **delivered-HDR-look
approval gate** — a separate, still-deferred piece of work (Oracle lane), not a cutover
prerequisite. En route, the golden fixture itself was found rotted (hand-inlined
pre-restructure `mapSettings` — both engines failed at worker setup; invisible because
the gate is feature-flag opt-in and CI never ran it); it now builds its wire shape
through the shared `setupFixture.ts` builder so it tracks the live types.

**Why native**: 57× map-frame speed (2026-06-04 spike), and it retires the
Chrome-for-Testing redistribution problem (the ship forcing-function). Jitter and
mechanical correctness were gated before the port: `.spike/native-gl/jitter-report.md`,
`MECHANICAL_VERDICT.md`; the port re-ran the oracles THROUGH the production worker:
`PRODUCTION_WORKER_GATES.md` (vector 0.0188 / satellite 0.0686 px RMS with production
recycles; lever model exact; colorimetry byte-pins; HDR anchors 0.7511/0.5822 measured
vs 0.75/0.58 expected through the real composite argv —
`src-tauri/tests/native_hdr_composite.rs`).

**Port contracts (all measured, all BINDING while the native backend exists):**
1. `map.setGestureInProgress(true)` once after construction, unconditionally, on every
   export map (`nativeBackend.ts::setup`). Requires the PATCHED binding
   (`sidecars/renderer/native/`, provisioned by `ensure-binding.mjs`); the backend
   refuses to render without it (satellite would sawtooth 0.93 px RMS). (The retired
   chrome page's `painterPatch.ts` was the GL JS spelling of the same knob.)
2. `buffer: 0` on both point GeoJSON sources (`live-marker`, `waypoints`) at the native
   boundary (`NATIVE_SOURCE_BUFFER_ZERO`) — translucent circles otherwise draw once per
   overlapping tile (halo/pulse brightness pops G 138→192 at tile-band crossings).
   Symbol placement is unaffected by buffer:0 (measured: identical pixel counts,
   0.000 px centroid shift for boundary-anchored icons — `probe-waypoints-buffer.js`).
3. Empty-LineString placeholders normalize to an empty FeatureCollection at the native
   boundary only (`normalizeGeojson`); `sources.ts` stays untouched (feeds the preview).
4. No GeoJSON `setData` in the node binding: per-frame source refresh = removeLayer(s) →
   removeSource → addSource → addLayer(s) → re-apply paints/layouts. The binding's
   `addLayer` takes no `beforeId`, so the refresh rebuilds the decoration stack from the
   lowest changed source upward (`refreshSources`) — the decoration layers occupy the
   contiguous top of the style, so re-adding in static order restores exact stacking.
5. `addImage` caps textures at 1024 texels → `pixelRatio ≤ 8` guard (icons are
   128×pixelRatio; production pixelRatio ≤ 4 today). Signature:
   `(id, Buffer, {width, height, pixelRatio, sdf})`. The binding's `index.d.ts` is stale
   — trust the runtime prototype.

**SSAA + alpha convention**: native's constructor-time `ratio` carries the full
pixelRatio (resolution multiplier × SSAA factor); the framebuffer → readback reduction
is an exact integer box filter in **premultiplied, gamma (sRGB) space**, and the wire
buffer stays premultiplied — byte-identical semantics to GL JS `gl.readPixels`
(MECHANICAL_VERDICT §2). Downstream exposure is nil: the map paints an opaque basemap
(alpha=255 measured on every pixel) and the composite replaces map alpha wholesale with
the Rust corner mask (§4.4 / corner_mask.rs). The §1.3 sRGB ingest anchor carries over
with NO contract change.

**SSAA reduction venue (DECIDED 2026-07-03 — in-binding, on-GPU).** The reduction runs
INSIDE the patched binding via the render option `downsample: {factor, width, height}`
(`native/readback-downsample.patch`): a Metal compute pass over the offscreen color
texture, so only the slot-sized buffer (e.g. 7.6MB, not 42MB) crosses GPU→CPU and the
worker does zero per-pixel CPU work. `nativeBackend.ts::boxDownsample` survives as the
executable spec; the binding must match it byte-for-byte (zero-pad, divisor stays
factor², `(sum+n/2)/n` truncated) — pinned by
`sidecars/renderer/__tests__/readbackDownsample.test.ts`, whose flat-scene case is an
exact rounding-mode probe. At factor 1 the option is omitted (byte-identical pre-patch
readback path — what `golden_frame_parity_native` pins; gate re-run green 2026-07-03).
The backend fails LOUD on a binding without the `mbgl.readbackDownsample` capability
whenever the export is supersampled — no CPU-filter fallback (§1.11 loud-failure rule).
History: the worker briefly did this reduction as a single-threaded JS box filter
(cutover..2026-07-03) — measured 55–90% of per-frame time at the 9:16 4K cell and
2.5–6× worse under CPU contention (the "8× export slowdown" report, which forensics
showed was two different grid cells plus that contention — no engine regression).
Isolated A/B at fb 3676×2068 factor 2: render+reduce+readback 81ms → 12ms median.
Related correction: the 2026-06-04 spike's "57×" number compared full-framebuffer PNG
writes vs CDP base64 screenshots — NEITHER side included this reduction; treat it as
directional only. Non-Metal backends (future win32/ANGLE route) inherit a shared CPU
fallback in core with identical semantics (`gfx/headless_backend.cpp`) — a GL fast path
is an optimization to make when task 130 lands that platform.

**Determinism bound (measured 2026-07-02)**: mbgl/Metal re-renders of an identical
frame wobble by ±1 LSB on a handful of AA edge pixels across worker boots (0–10 px of
518,400, always channel delta 1); within one map instance renders are byte-identical.
The golden gate's tolerance encodes exactly that class (delta ≤ 1 on ≤ 0.01% of pixels)
and nothing more. (The retired GL JS stack was byte-deterministic across boots.)

**Binding distribution (interim)**: vendored patch + build-from-source
(`sidecars/renderer/native/ensure-binding.mjs`, staged at
`src-tauri/binaries/mbgl-native-<triple>/`, CI-cached; `tauri.conf.json` bundles the
staged dir via `bundle.resources`). The upstream PR is the exit ramp — NOT posted;
Matthew decides when (draft package: `.spike/native-gl/UPSTREAM_PR_DRAFT.md`). Task 130
ships the staged dir per platform; Windows rides upstream's prebuilt matrix (win32
included) — darwin-arm64 is the only measured platform today.

### 2.6 Reference space + honest preview scale (the B1/B2 framing fix) — DECIDED

**Decision (2026-07-03, Matthew's world-pick after the anchor/world spike rounds).**
There is ONE map scale space — the **reference space**: the canonical 1080p-class CSS
frame per aspect (short side 1080). `mapSettings.camera.zoom` and every decoration-size
fraction are denominated in it; **exports render it verbatim** (aspect = frame shape,
layout's map slot = crop window, pixelRatio = resolution — none of them touch scale).
Consequences Matthew explicitly chose (α = 0 in the spike's interpolation family):
growing the map band's share of the frame shows MORE WORLD at the same scale — never a
rescale; the perceived-scale-invariance spec (§2.1) is preserved, and World 2
("one composition", band-fraction rescaling) is REJECTED for the knobs (region-fit
intents remain intrinsically per-band).

**The preview was the only broken surface**: it displayed reference values 1:1 in its
own pane CSS px, so played-back exports (compressed by playback fit) read ~2× smaller
than the pane (measured 2.08× for 9:16, 1.38× for 16:9). Fix — the pane renders the
reference space at the fixed factor **`previewDisplayScale(aspect, screen)`** =
fullscreen-fit of the canonical frame on the current display: camera `zoom +
log2(scale)` (`withDisplayScale`), decoration paints `× scale` (the `surfaceScale`
parameter threaded through `resolveStaticPaints` / `buildPerFrameState` — §2.3 contract
intact; the renderer resolves at scale 1, proven byte-identical by the untouched golden
gate). The factor depends only on (aspect, screen) — NEVER pane width — so dragging the
pane reveals/crops geography at constant perceived scale, and stored knob values remain
machine-independent (no schema change; existing projects' exports are unchanged).
Camera intents in the preview resolve against the aspect's canonical MAP-SLOT css dims
(`canonicalSlotCss`, = the renderer's cssViewport), closing the region-fit divergence
(preview used to fit against the full frame).

Empirical gate (production worker, Abel's Hike, `.spike/refspace-gate/`): POV dot
30.00 pt pane vs 30.43 pt fullscreen-played export (9:16), 46.50 vs 46.86 pt (16:9);
trail 5.00 vs 5.11 pt (9:16), 8.00 vs 7.88 pt (16:9) — was 2.08×/1.38× off. Divider
demo: band h 0.269→0.45 at same zoom = identical decoration px, 67% more world.
Accepted approximations (do not "fix" without a real complaint): basemap label/road
styling follows the style's own zoom curves rather than exact ×scale (near-invisible in
the gate renders); perceived parity is exact at fullscreen playback on the editing
display and proportional elsewhere — a compromise Matthew accepted, since a shipped
file has no physical scale until a player sizes it.
**Authority**: `src/lib/layout.ts` (`canonicalSlotCss`, `previewDisplayScale`),
`src/lib/cameraIntent.ts` (`withDisplayScale`), `surfaceScale` params in
`src/lib/mapVisuals/{styleSpec,paints,perFrame}.ts`, applied in
`src/components/MapView.tsx`.

### 2.7 Halo group-opacity compositing — engine-level, BOTH engines, ship together — DECIDED

**Decision (2026-07-07, from the halo-composite spike GO — `.spike/halo-composite/VERDICT.md`).**
Translucent halos double-blend wherever the decoration overlaps itself (out-and-back
retrace: the exact `1−(1−o)²` artifact; GPS-jitter sunbursts; X-crossing corners).
There is NO style-spec fix — MapLibre blends each layer against the map with plain
alpha. The shipped fix is **group-opacity compositing in the engine**, on both engines
at once: each halo layer pair renders into a full-viewport TRANSPARENT offscreen target
(with depth+stencil — line layers stencil-clip their tiles) at remapped in-FBO
opacities, members are skipped in the main translucent pass, and one fullscreen quad
composites the group src-over at opacity `g` at the topmost member's z-slot. The FBO
saturates instead of re-blending, so any number of self-crossings renders as ONE coat.

- **Policy lives in mapVisuals** (§2.3 contract): `haloGroupPolicy(outer, core)` →
  `g = 1−(1−outer)(1−core)` (today's on-line peak), in-FBO `outerIn = outer/g`,
  `coreIn = core>0 ? 1 : 0` (the general peak-match formula collapses to 1 because
  `g−outer = core·(1−outer)` identically). Point-identical to the old direct blend
  everywhere the halo does NOT self-overlap — proven algebraically in the code comment
  and measured to 4 decimals on both engines. `resolveStaticPaints` emits the in-FBO
  values as the halo layers' own opacities plus a fourth bucket
  `haloComposites` (FOUR groups: route-full, route-trail, waypoints, live-marker pairs
  — waypoint/POV circle halos get the fix for free). Per-clip halo-opacity overrides
  re-resolve `g` at cuts; the export worker re-sends on change (JSON-compare), the
  preview re-applies via the statics effect.
- **Engines**: export = native patch 3 (`sidecars/renderer/native/group-composite.patch`,
  capability `mbgl.groupComposite`); preview = vendored maplibre-gl patch
  (`patches/maplibre-gl+5.22.0.patch` via patch-package on the UNMINIFIED dev bundle +
  exact-match Vite alias, capability `maplibregl.groupComposite`). Both consumers FAIL
  LOUD on a missing capability (§1.11 discipline) — the resolver's in-FBO opacities are
  only correct under the composite, so an unpatched engine is a build defect.
  **Ship rule: the two patches travel together or not at all.**
- **Measured** (native: `.spike/halo-composite/`; GL JS: `scripts/gljs-halo-parity/`):
  out-and-back overlap 0.749→0.497/0.503 σ=0 (= single coat, both engines); jitter
  bounded by one coat; falloff-0.7 single-coat profile unchanged (0.311→0.3115, both);
  gradient crossings resolve as clean occlusion; feature off = byte-identical (MD5)
  on BOTH engines; +2.3 ms/frame at a 4K framebuffer ≈ +3% of a healthy export frame.
- **The trap pair (both live in the offscreen stencil path)**: native — tile clipping
  masks drawn in the offscreen pass poison the main pass's mask bookkeeping
  (`resetTileClippingMasks()` around each independent stencil attachment); GL JS —
  `createFramebuffer(w,h,depth,stencil)` creates attachment WRAPPERS only, and a
  color-only FBO is still framebuffer-complete, so a missing
  `depthAttachment.set(createRenderbuffer(DEPTH_STENCIL,…))` silently disables tile
  discrimination (coverage stacks `1−(1−α)^k` near tile boundaries; invisible at
  falloff 0, caught by the falloff-0.7 policy-fidelity gate).
- **Bounds**: group members must be z-contiguous (true for our pairs by scene.ts /
  MapView construction — the composite draws at the topmost member's slot);
  `waypoints-active-halo` (the "you are here" ring) is deliberately NOT grouped; the
  native base `createOffscreenTexture(size,type,depth,stencil)` fallback ignores the
  flags on non-Metal backends — must be honored per-backend before any upstream PR
  (same unposted-PR status as §2.5).

**Authority**: `haloGroupPolicy` + `haloComposites` in `src/lib/mapVisuals/styleSpec.ts`;
applied in `src-tauri/sidecars/renderer/{scene,backend,nativeBackend}.ts` (export) and
`src/components/MapView.tsx` (preview). Gates: `scripts/gljs-halo-parity/run.mjs`
(README has the full parity table) + the untouched native golden gate.

### 2.8 Per-aspect map magnification `k` — the third viewport lever — DECIDED

**Decision (2026-08-12, Matthew's pick after the 9:16 "everything is half size"
complaint — the "real complaint" §2.6 reserved judgment for).** A per-aspect factor
`k` (default 1.0, valid **[0.5, 2.0]**, rejected loudly — never clamped — outside it)
that magnifies the ENTIRE map render relative to the frame: basemap, labels,
decorations, and world scale together, with correspondingly less geography visible.
Rationale: the liberty basemap is desktop cartography; §2.1's perceived-scale
invariance assumed one viewing condition, but phone-native aspects are consumed
full-bleed at phone size, wanting ~2× the frame-relative symbology of a
desktop-viewed 16:9. `k` is per-aspect because consumption medium correlates with
aspect. **§2.1 is hereby scoped: invariance holds at default `k`; a non-default `k`
is an explicit per-aspect creative choice.**

- **Mechanism** — the css/device-pixel boundary moves; content math never does.
  Export: `cssViewport = round(slot / (multiplier·k))`, `pixelRatio =
  multiplier·k·ssaa` — applied INSIDE `build_setup_payload`
  (`src-tauri/src/export/mod.rs`), the SSAA precedent, so `canonical_map_viewport`
  stays k-free as the TS↔Rust parity surface (`layout_parity.json` untouched). The
  framebuffer stays slot×SSAA: nothing downstream of the sidecar changes, and the
  sidecar itself needed ZERO changes (magnification never crosses the wire — the
  renderer sees only the derived viewport). The three levers are orthogonal
  (resolution → density, `k` → apparent scale, SSAA → sample count; `k` must NEVER
  feed `map_supersample_factor`).
- **Preview honesty (§2.6 extended)**: `k` enters `MapView` in exactly two forms —
  intent viewport `canonicalSlotCss(layout, aspect, k)` and `effectiveScale =
  previewDisplayScale × k` (threaded as `surfaceScale` / `withDisplayScale`, and
  into marker-texture bake density). The pane keeps showing exactly what the
  k-magnified export looks like played fullscreen.
- **Persistence**: `Project.map_magnification` `{"9_16","4_5","16_9"}`, additive —
  NO schema bump, no migration. Identity is written as ABSENCE (frontend deletes
  the field when all three are exactly 1.0; Rust `skip_serializing_if` on `None`),
  so untouched bundles stay byte-identical. Transport rides the typed
  `LayoutDescriptor.magnification` (serde default 1.0) — never the flattened
  `project_state` (key-collision trap). Per-export-job by construction: the css
  viewport is laid out once per job, so `k` is NOT per-clip overridable.
- **Bounds**: 2.0 is principled — the native binding throws above `pixelRatio 8`
  (`NATIVE_ADDIMAGE_MAX_PIXEL_RATIO`), and 2160p×k2×SSAA2 lands exactly on 8.
  Raising the ceiling requires icon re-tiling (the error message names it).
- **Proven**: `k = 1.0` is bit-exact with the pre-lever pipeline (IEEE ÷1.0/×1.0
  identities; swept 3 aspects × 4 resolutions × 5 slot shapes), so goldens are
  untouched and no existing project re-renders differently. Anchor case: 9:16 slot
  1080×919 @1080p, k=2 → css 540×460, pixelRatio 6.0, framebuffer 3240×2757,
  rounding drift exactly on the `pixelRatio·0.5` bound.

**Authority**: `build_setup_payload` + `validate_request` in
`src-tauri/src/export/mod.rs`; `MapMagnifications` / `MAGNIFICATION_*` /
`canonicalSlotCss` in `src/lib/layout.ts`; `effectiveScale` in
`src/components/MapView.tsx`; UI in `src/components/MapPositioningModal/`
(per-tile stepper; tile reset also resets `k` to 1.0).

### 2.9 Transition — playhead travel + seam eases (its own decoration) — DECIDED

**Decision (2026-08-13, Matthew's toggle request; restructured twice same
day on Matthew's design — first into a first-class decoration, then renamed
TRAVEL → TRANSITION when the seam eases joined it).** Opt-in TOP-LEVEL
`MapSettings.transition` (additive `Option<TransitionSettings> { travel?,
ease_in?, ease_out? }` — NO schema bump, halo precedent; atomic per-clip
override blob `MapOverrides.transition` diffed by
`transitionSettingsEquals`; its own TRANSITION toolbar section alongside
Route/Waypoints/POV). Three optional LAYERS that stack:

- **`travel`** (`TravelSettings { enabled, show_playhead?, sync?, playhead?,
  draw_route? }`): during the existing inter-clip `TransitionSpan` window
  the traveling playhead runs ALONG THE ROUTE PATH between the wall-clocks
  the playhead occupies at the window edges, instead of teleporting at
  `cutMs`. The optional toggles read absent-as-TRUE (`travelShowPlayhead` /
  `travelSync` / `travelDrawRoute` normalizers; comparator normalizes too,
  so `{enabled:true}` equals its spelled-out twin).
- **`ease_in` / `ease_out`** (`SeamEase { style: pop|fade|grow, speed:
  slow|medium|fast }`, absent = none = today's hard jump): how a clip's
  playhead animates in/out at seams — the "sense of place" punctuation for
  short back-to-back clips that travel smooths away. Pure multiplicative
  {scale, opacity} ENVELOPE over the whole marker stack (body + pulse +
  halo; fade dims the live-marker halo composite's `g`), FIXED per-phase
  duration from speed (650/400/250 ms — deliberately independent of window
  length so short clips get the same snap), curves in
  `mapVisuals/animations.ts` (`easeEnvelopeSample` / `seamEnvelopeAt`).
  Anchors at every marker DISCONTINUITY, one mechanism stacking onto
  whatever the seam does (verified: no prior style easing existed to
  duplicate — travel eases position only, style hard-swaps):
  - non-traveled seam (travel off/bailed/zero window): the teleport at
    `cutMs` — out-phase = SOURCE clip's `ease_out`, in-phase = DESTINATION
    clip's `ease_in` (a seam reads TWO clips' resolved blocks; per-clip
    resolution doing its normal job);
  - traveled seam: position is continuous but STYLE swaps at the window
    edges — entry crossfade (clip marker → traveling marker) governed by
    the source's `ease_out` on both phases, exit crossfade by the
    destination's `ease_in`;
  - project start (`t=0`, first clip's `ease_in`) and end
    (`totalDurationMs`, last clip's `ease_out`).
  `classifyTravelWindow` is the ONE traveled-or-not predicate shared by
  `travelTraceAt` and the instant builder (`seamInstantsNear`, horizon
  prefiltered by `EASE_MAX_PHASE_MS`). Envelope scale folds into the
  effective POV style block before `povStyleTuples`/`buildPerFramePaints`
  (all size fields linear; halo spread scales via `halo.size`); a
  fully-empty transition blob collapses to absent so "everything off"
  serializes like "never touched".

- **Playhead and route drawing are INDEPENDENT toggles.**
  `show_playhead: false` hides the whole traveling marker stack for the
  window by shipping an EMPTY `live-marker` source (every marker-stack
  layer renders from it — one move, automatic restore). `draw_route: true`
  (default) drives the visited trail head from the synthesized clock and
  FORCES the trail trio visible during the window when the route
  decoration mode is 'none' (`routeTrailVisibilityTuples(route,
  forceTrail)`, route's own resolved style, on/off only by design);
  `draw_route: false` keeps the trail on the pre-travel clock (advances
  with the source clip, holds, snaps at window exit) while only the
  playhead travels.
- **Sync = destination owns the LOOK for the whole window.** `sync: true`
  (default) dresses the traveling playhead in the DESTINATION clip's full
  resolved POV style — marker, colors, sizes, pulse, halo — end to end (no
  mid-flight style flip at the cut). `sync: false` consumes
  `travel.playhead`, a full `PovSettings`-shaped custom style with total
  POV capability parity (inside it, absent `marker` = the dot — normal
  PovSettings semantics; there is no "track" state, that intent is sync).
  The UI seeds the custom block by one-shot-copying the current resolved
  POV on unsync (decoration-linking precedent) and keeps it across
  re-sync/off round trips (disabled-halo precedent).
- **Style flows through per-frame buckets shared with the static resolver**
  — `povStyleTuples` (extracted from `resolveStaticPaints`) emits the ONE
  tuple set for a POV-style block; `buildPerFrameState` re-emits it every
  frame from the travel-effective style into `PerFrameState.povPaints` +
  `.layouts`, plus `.haloComposites` (fixed four groups via
  `haloCompositesFor`, live-marker entry travel-effective). Outside a
  window every bucket equals the static resolution, so restore is
  automatic — no entry/exit handshake. Export appends povPaints after the
  static paints and BEFORE the per-frame pulse scalars (last-write-wins);
  preview applies them with diff caches cleared by the static-apply
  effect.
- **Camera untouched** — the Van Wijk arc (`evaluateTransitionSpan`) is
  unchanged; only the marker/trail travels under it.
- **Destination clip owns the window** — the transition INTO clip N+1 is
  governed end-to-end by `resolveMapSettings(project,
  toClip.map_overrides).transition.travel` (and, under sync, `.pov`); no
  mid-flight flips at the cut. The SOURCE clip's resolved block contributes
  exactly one thing to the seam: its `ease_out`.
- **Zero added frames** — travel rides the existing window;
  `totalDurationMs` untouched (the FFmpeg concat has no matching gap and
  would desync — this is why a "real gap" design was rejected).
- **Endpoints at span edges, not mediaOut/mediaIn** — same convention (and
  same `easeInOut` curve) as the camera arc, so the marker is continuous at
  both window edges by construction.
- **One synthesized wall-clock** — eased distance-parameterized interpolation
  (`distanceAtWallClock` / `wallClockAtDistance` in `routeLocation.ts`,
  geodesic space) yields a wall-clock that drives marker position, visited
  trail head, gradient progress, and waypoint activation through the
  EXISTING consumers — parity on both engines for free. Waypoint
  activation always rides the travel clock (marker semantics), even when
  `draw_route` holds the trail back. Stationary-plateau inversions clamp
  into the window's wall-clock range; sub-0.5 m windows time-lerp.
- **Bail-outs reproduce the pre-travel teleport exactly**: project-start
  transition (null `fromClipId`), zero-duration span, no route, either
  endpoint off-GPX (never animate between a fallback-GPS position and a
  route position). Mid-window >60 s GPX holes momentarily show the existing
  fallback — accepted v1 limitation. An unsynced block with no stored
  `playhead` falls back to sync behavior defensively.
- **Known limitation (shared with per-clip POV overrides)**: the POV shape
  atlas rasterizes its outline band once at setup from project `pov.size`;
  a custom travel style re-resolves icon-size per frame but does not
  re-rasterize the outline band mid-export.

**Authority**: `classifyTravelWindow` / `travelTraceAt` /
`seamInstantsNear` + the per-frame buckets in
`src/lib/mapVisuals/perFrame.ts`; `easeEnvelopeSample` / `seamEnvelopeAt` /
`EASE_PHASE_MS` in `src/lib/mapVisuals/animations.ts`; `povStyleTuples` /
`routeTrailVisibilityTuples` / `haloCompositesFor` in
`src/lib/mapVisuals/styleSpec.ts`; `distanceAtWallClock` /
`wallClockAtDistance` in `src/lib/routeLocation.ts`; `TransitionSettings` /
`SeamEase` / `transitionSettingsEquals` / `travelSettingsEquals` /
`povStyleEquals` in `src/types.ts` (Rust mirror in `models.rs`); UI = the
TRANSITION decoration panel (`TransitionPanelBody` + `EaseSection` +
`PovStyleControls` in `DecorationPanel.tsx`); registration/delete-revert in
`src/lib/markerLibrary.ts` + `nativeBackend.ts::registerMarkerImages`.

### 2.10 Per-clip basemap (`camera.map_style`) swaps at the CUT — DECIDED (2026-08-15)

- **What**: `map_style` (`default` / `3d` / `satellite`) is per-clip overridable
  and the export honors it: the sidecar resolves the basemap for the clip
  `activeClipIdAt(timeline, t)` returns and swaps the loaded style when its id
  changes — i.e. at the transition span's `cutMs`, the same instant the video
  hard-cuts and the active clip flips. Not at the transition window's start,
  not cross-faded.
- **Why the cut**: a basemap change reads as an edit; aligning it with the
  picture cut makes it ONE edit rather than two, and the camera arc is usually
  near its zoomed-out apex there. A style cross-fade would need two engines +
  an FFmpeg blend (2× frame cost) — deferred, not rejected.
- **Mechanism**: `buildBasemapSpec(mapSettings)` in `styleSpec.ts` is the whole
  basemap decision (`styleId`, style, `defaultPitch`, buildings layer) as one
  value; `buildFramePayload` emits `frame.basemap` per frame; the native
  backend's `maybeSwapBasemap` compares `styleId` against `loadedStyleId` and
  on change runs `map.load(style)` + `applyScene()` (sources → layers → images
  → statics → group composite, MapView-onStyleLoad order). Everything MUST be
  re-added: `Style::Impl::parse` clears sources, layers AND images
  (`.mbgl-src/src/mbgl/style/style_impl.cpp`); the camera and group composite
  survive. `renderStill` already blocks on `rendererFullyLoaded`, so a
  half-tiled swap frame is impossible. `recycle()` keeps the last frame's
  basemap (never resets to the project default mid-clip). Pitch was ALREADY
  per-clip: `cameraIntent.ts` compiles each clip's anchor from the
  clip-resolved settings, so a `3d` override pitches the arc across the whole
  transition span while the buildings pop in at the cut — inherent to a
  continuous camera + a discrete swap.
- **Preview**: swaps on the SELECTED clip (`MapView` style effect); export on
  the ACTIVE clip at `t`. Each is right for its surface; both use
  `buildBasemapSpec`.
- **Known dead field**: top-level `MapOverrides.map_style` (v7 legacy) is
  ignored by `resolveMapSettings` (only `overrides.camera.map_style` merges);
  the UI writes the camera form. Same on both surfaces, so no divergence — a
  v7-migrated project's per-clip style is inert until re-picked. Open item.

**Authority**: `buildBasemapSpec` (`styleSpec.ts`), `buildFramePayload`
(`scene.ts`), `maybeSwapBasemap` / `applyScene` (`nativeBackend.ts`), gate
`__tests__/basemapSwap.test.ts`.

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

### 3.3 HEVC delivery encodes through SOFTWARE libx265; hardware is fallback-only — DECIDED

Root cause of the fuzzy delivered decorations (the sharpness half of B1; the sizing half
was §2.6): the encoder stage, not the pipeline. The 2026-07-03 stage-separation probe
(renderer readback → lossless FFV1 tap of `[vout]` → delivered file, production argv,
three aspect×resolution configs) measured the composite filtergraph essentially
transparent (SDR 4:4:4 tap keeps 94.5% of decoration-band edge energy) and 4:2:0
subsampling bounded and not the visible ceiling at 4K — but `hevc_videotoolbox -q:v 50`
retained only ~0.55 of the decorations' Cr-plane edge energy (starved ~13 Mbps at 4K
AND structurally poor on chroma-only edges: at `-q:v 80` with 5× the bits it still
measured below libx265 crf18). Decorations are exactly that failure mode — flat
high-chroma shapes with near-zero luma contrast.

Decision: `EncoderClass::Hevc` candidates prefer libx265 on every platform (VT / nvenc /
qsv / amf are fallback-only, VT bumped q:v 50→65 so the fallback doesn't starve);
delivery settings `-preset fast -crf 17` + `cbqpoffs=-2:crqpoffs=-2` (measured: SdrH265
Cr retention 0.55→0.90, HdrHlg Cb 0.76→0.97, HdrPq Cr 0.54→1.16; export wall ≈1.4–1.7×
VT — the float filtergraph dominates). SdrH264 (libx264 crf18, healthy) and ProRes
unchanged. The probe cache is policy-versioned (`ENCODER_POLICY_VERSION`) so warm caches
pick up candidate-order changes. Enforced by the decoded-frame gate
`delivery_encode_preserves_decoration_chroma_edges` (Cb/Cr edge retention ≥0.80 through
the real argv per codec target + libx265-selection pin + loud no-libx265 precondition).
**Authority**: `src-tauri/src/export/encoder.rs` (candidate order + policy version),
`delivery.rs` (per-target argv), `tests/color_fixtures.rs` (gate). Commit `1345ded`.
Licensing note for task 130 (§6.2): libx264/libx265 are GPL — the "own-CI LGPL FFmpeg
build" plan conflicts with both this and the pre-existing SdrH264 path; resolve in the
ship-deps lane.

Same-day follow-up (2026-07-03, preset relaxation): the "≈1.4–1.7× VT" wall estimate did
NOT hold at 4K on real content — a 152-frame 16:9 4K HdrPq hand export measured 1m51s
wall, of which ~81s was the libx265 `fast` encode alone (~5× the per-frame cost of the
old VT path; at 4K the encoder dominates, not the float filtergraph). Preset sweep
through the retention gate on an M1 Pro (152×4K real frames): `fast` 80.8s / gate
0.98–1.05; **`veryfast` 41.7s / gate 0.95–1.05 — parity, now shipped**; `superfast`
43.4s / 0.91–1.07 (early ringing signs, no speed win over veryfast); `ultrafast`
REJECTED — its 1.19–1.29 "retention" is SAO-off ringing inflating gradient energy, a
reminder that the gate floor alone cannot rank presets (energy ratios far above 1.0 are
an artifact signature, not fidelity). Explicit x265 pool/frame-thread tuning measured
zero effect (x265 already saturates the machine at 4K). crf and the chroma QP offsets
unchanged.

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
visibly dark. This was the diagnosed root cause of the dark HDR map exports — fixed by the
Phase 4 HDR port (DECIDED §1.12; history in §6.1).
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

### 6.1 npl=203 reference-white anchoring for HDR map exports — RESOLVED (Phase 4, 2026-06-11)

Was the single most valuable undone item the doc reconciliation surfaced: HDR-HLG/PQ map
exports were dark because SDR map graphics were encoded scene-linear (white → ~62% HLG)
instead of anchored at BT.2408 reference white (203 nit / 75% HLG; PQ same bug — 0.58
signal). **Fixed by the Phase 4 HDR port** — implemented as the ×2.03 SDR-origin ingest
anchor (proven equivalent to npl=203 finishing), npl=100 absolute working space, and the
HDR-gated composite PQ transport curve (fix C′, which replaced fix C's linear ÷32/×32
headroom — see §1.12 history); see DECIDED §1.5 + §1.12 (which now carry the convention)
and §4.8 for the underlying 203-nit convention.

The Phase 3 tracer oracle (`hdr_reference_white_tracer_{hlg,pq}` in
`src-tauri/tests/color_fixtures.rs`, red-by-design at 0.630 HLG / 0.509 PQ) went green
with the fix and is graduated into the main CI test job (the expected-red `hdr-tracer`
job is deleted). Remaining known bound from the same work: HDR-origin → SDR delivery
hard-clips highlights — tone-map operator (e.g. zscale tonemap / BT.2446-A) is a
Matthew-confirmed follow-up, tracked as the open tail of this item.

### 6.2 Sidecar bundling (task 130) — OPEN, required before ship

ffmpeg/ffprobe/exiftool/node resolve via `PATH` today; only the patched
maplibre-gl-native binding dir is bundled (`src-tauri/tauri.conf.json`
`bundle.resources` — the Chrome-for-Testing bundle it replaced was removed at the §2.5
cutover). Bundling is deferred as "task 130" but **required before ship** (the app goes
to end users who do not have Homebrew FFmpeg). The task was never authored.

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
