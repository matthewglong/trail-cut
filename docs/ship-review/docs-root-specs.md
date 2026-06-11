# Ship Review — Root-Level Design Docs: Reconciliation Receipt

**Date:** 2026-06-11
**Branch at review:** `feat/control-panel` (dirty working tree; `src-tauri/src/util/color_space.rs` untracked)
**Scope:** the 12 root-level markdown docs — ARCHITECTURE.md, MAP_RENDERING_PLAN.md, PIPELINE_RESEARCH.md, PIPELINE_DECISIONS.md, PIPELINE_TEACHING_HANDOFF.md, COLOR_PIPELINE_SPEC.md, UNIVERSAL_WORKING_SPACE_REPORT.md, EXPORT_REDESIGN_HANDOFF.md, EXPORT_GAPS.md, README.md, Untitled.md, CLAUDE.md — reconciled against each other and spot-checked against the code.
**Method:** every doc read in full; every load-bearing claim greped/read in the current working tree. Citations are `file:line` in this repo as of this review. The ~451 vendored markdowns under `.spike/native-gl/` were not read (per review ground rules).

---

## 1. Verdict table (one line per doc)

| Doc | Date | Verdict |
|---|---|---|
| `ARCHITECTURE.md` | Apr 6 | Founding design doc. Core product decisions still bind; tech sections heavily superseded. Archive after extracting §2 decisions. |
| `README.md` | Apr 5 | Untouched Vite template boilerplate. Zero project content. Replace or delete. |
| `MAP_RENDERING_PLAN.md` | May 17 | **Implemented.** Header still says "ready to implement" — stale. Decisions bind; doc is now a historical record, partially extended by SSAA. |
| `PIPELINE_RESEARCH.md` | May 21 | Research proposals: ~half adopted (often in modified form), several rejected/debunked, one headline claim disproven. Keep for citations; do not treat recommendations as decisions. |
| `PIPELINE_DECISIONS.md` | May 24 | The ACCEPT/REJECT ledger — **abandoned mid-process**. 10 of 12 entries still "pending walkthrough" while the code has since decided them. Misleading as a record. |
| `PIPELINE_TEACHING_HANDOFF.md` | May 26 | Session prompt; teaching happened. The two-symptom framing and constraints are gems; the doc itself is dead as a work item. |
| `COLOR_PIPELINE_SPEC.md` | May 28 | "LOCKED" sections were **not implemented as written** — the shipped `color_space.rs` is a simpler, different design. Spec is partially superseded by its own implementation. |
| `UNIVERSAL_WORKING_SPACE_REPORT.md` | May 28 | Research report; the deepest color-science gems in the repo. Architecture partially adopted (per-project working space stubbed). Keep §5–§6 forever. |
| `EXPORT_REDESIGN_HANDOFF.md` | May 17 | Session handoff for schema-v6 export grid. Work fully landed (schema now v9). Dead; its UX decisions still bind. |
| `EXPORT_GAPS.md` | May 17 | Live gap registry. GAP-003 (hardcoded CRF) re-verified true today. Keep and maintain. |
| `Untitled.md` | May 19 | Orchestrator prompt for the map-decorations redesign. Work fully landed (commits `9d498ad`…`bf4ebeb`). Dead; its anti-pattern list still binds (also encoded in CLAUDE.md/memory). |
| `CLAUDE.md` | May 28 | Mostly accurate, but drifted on schema version (says 8, code is 9), HDR framing ("near-term" vs current+PQ shipped), and omits `util/color_space.rs`. |

Note: `docs/color-pipeline/` (README, ARCHITECTURE, EXECUTION, phase-1/2 briefs) is the **newer authority** for color work — it postdates and operationalizes the root pipeline docs. Any future color question should start there and in `src-tauri/src/util/color_space.rs`, not in the root PIPELINE_* files.

---

## 2. Decisions that still bind the code today (verified)

### Map rendering / perceived scale
- **Product-owner perceived-scale spec** (MAP_RENDERING_PLAN.md:5-12, quoted verbatim there): same route + settings ⇒ same apparent scale across aspect AND resolution; aspect changes shape/visible-area only, resolution changes density only. **Implemented**: `canonical_map_viewport` lever model at `src-tauri/src/export/layout.rs:119-134` (multiplier = `output_dims(aspect,res).w / output_dims(aspect,'1080p').w`; cssViewport tracks slot shape; pixelRatio absorbs resolution), mirrored in `src/lib/layout.ts`.
- **`PAINT_REFERENCE_WIDTH = 1080`** — overlay paints are fixed CSS-px constants, not viewport-tracking (MAP_RENDERING_PLAN.md:71-84). Implemented at `src/lib/mapVisuals/styleSpec.ts:50`.
- **No sub-1080p rendering** (720p = render 1080p + FFmpeg downsample), **per-clip camera zoom is one number**, **preview keeps the `log2(pane/canonical)` compensation** for WYSIWYG authoring (MAP_RENDERING_PLAN.md:86-104). These are recorded as "settled — do not relitigate."
- **SSAA supersampling ≥2× with on-GPU downsample** — newer than the plan doc: `map_supersample_factor` at `src-tauri/src/export/layout.rs:173` (test asserts every export ≥2×, layout.rs:544-545); framebuffer = slot × factor (`src-tauri/src/export/mod.rs:480, 527`); downsample on-GPU before readback (`src-tauri/sidecars/renderer/page/init.ts:267-271, 669`). Frames cross CDP at slot size (100 MB base64 cap — see memory `project_renderer_frame_transport`).

### mapVisuals single-source-of-truth contract
- All MapSettings-derived map state flows through `src/lib/mapVisuals/` (`resolveStaticPaints` / `buildPerFrameState`); never ad-hoc `setPaintProperty` in `MapView.tsx`, or preview/export silently diverge. Stated in CLAUDE.md (Key design decisions), enforced as an auto-reject anti-pattern in Untitled.md:182-207 (incl. `lineMetrics: true` required at all four `addSource` sites), and echoed in UNIVERSAL_WORKING_SPACE_REPORT.md §6.

### Color pipeline
- **Working space: linear-light, BT.2020 primaries, full range, `gbrpf32le`** — `ColorSpace::WORKING` at `src-tauri/src/util/color_space.rs:178-184`; boundary-contract test pins the strings at `src-tauri/src/util/color.rs:809-813`. HDR-first means BT.2020 primaries are non-negotiable (PIPELINE_TEACHING_HANDOFF.md:53 explicitly overrides PIPELINE_RESEARCH §1.6's SDR-simplification suggestion).
- **Atomic-axes registry**: a color space = 4 independent axes (+ optional npl); ingest/delivery zscale strings are *generated*, never hand-authored; "adding a new transfer/primary/range/matrix is ONE new enum arm + token strings, NOTHING else changes" (`color_space.rs:22-26` — the module's stated acceptance test). This is the executable descendant of COLOR_PIPELINE_SPEC §1's axis model.
- **Map canvas ingests as sRGB (`tin=iec61966-2-1`), not BT.709** — `ColorSpace::SRGB` at `color_space.rs:186-194`; rationale in PIPELINE_RESEARCH.md §1.2 ("Do not 'fix' this by retagging to tin=bt709"). Direction A2 effectively decided ACCEPT in code even though PIPELINE_DECISIONS.md still says "pending walkthrough."
- **Two-step ingest shape is load-bearing**: first zscale only linearizes (keeps source primaries), `format=` hop, second zscale does the primaries/matrix hop (`color_space.rs:273-276`). Map form must state all four source tags explicitly or zimg fails planning with code 3074 (`color_space.rs:268-271`).
- **npl at ingest only, never on delivery**: HLG ingest `npl=400`, PQ ingest `npl=1000` (`color_space.rs:331-338`); delivery chain deliberately emits no npl — encoder `-color_trc` carries signaling (`color_space.rs:317-320`). This **supersedes** PIPELINE_RESEARCH §3.2's `npl=1000` in the HLG finishing filter.
- **Every `overlay` pins `:format=yuv444p10`** — `src-tauri/src/export/filtergraph.rs:730, 742, 772, 784, 850`; asserted verbatim in the in-module tests (e.g. filtergraph.rs tests at offsets ~657, 804, 867, 944, 1918-1924 inside `mod tests` at filtergraph.rs:939+). This is PIPELINE_RESEARCH §1.5 / decision C2, substantively landed.
- **VUI duplication guard (WS6)**: libx264/libx265 silently drop `-color_primaries`/`-color_trc` from the bitstream VUI unless duplicated into `-x264-params`/`-x265-params`; every SDR/HDR target emits both (`src-tauri/src/export/delivery.rs:188-199` doc comment + `push_vui_params` call sites). `-tag:v hvc1` on all HEVC paths.
- **Schema v9**: project-level `working_color_space: WorkingColorSpaceId` + per-clip `color_space_override: Option<PerAxisOverride>` (`src-tauri/src/models.rs:68-92, 158, 272, 973-974`; `CURRENT_SCHEMA_VERSION = 9` at models.rs:978; purely-additive `migrate_v8_to_v9` at `src-tauri/src/commands/project.rs:392-410`).
- **Dither deferred** — banding is not a real symptom; the research's "166→198 unique greens" claim did not reproduce (PIPELINE_DECISIONS.md A1-dither; PIPELINE_TEACHING_HANDOFF.md:17). Confirmed: no `d=error_diffusion` anywhere in `src-tauri/src`.

### Export / product
- **Export filename schema** `{slug}__{aspect}__{quality}__{channel}.{ext}` and queue ordering (aspect→channel display order, then quality tier ascending) — EXPORT_REDESIGN_HANDOFF.md:63-73; lives in `src/lib/exportFilenames.ts`.
- **Map decorations are independent** (Route/Waypoints/POV own color/gradient configs; copy-button linking; clip overrides + POV solid-only) — CLAUDE.md Key design decisions; landed via the map-decorations commits (`9d498ad`…`bf4ebeb`).
- **Founding product decisions from ARCHITECTURE.md that survived intact**: no media copying (paths only, originals read at export — ARCHITECTURE.md:18-19); auto-order by timestamp, no manual reorder (:21-22); focal point per clip (:24-25); **map transitions ARE the transitions** (:27-28); GPX timestamp sync beats embedded GPS (:30-31); user-configurable layout per export (:33-40); MapLibre + OpenFreeMap, FFmpeg CLI, ExifTool, Tauri 2, JSON project file.
- **Loud test failures on missing preconditions**: `assert_ffmpeg_has_zscale` at `src-tauri/tests/color_fixtures.rs:63` (called at :728). Binding convention, not just a memory note.
- **EXPORT_GAPS.md is live**: GAP-003 (hardcoded CRF) re-verified — `-crf 18` is baked into every software-encoder branch of `delivery_encoder_args` (`delivery.rs:215, 230, 262`); GAP-001/002/004/005 remain open by inspection of the named files.

---

## 3. Conflicts (doc vs doc, doc vs code)

1. **CLAUDE.md vs code — schema version.** CLAUDE.md says "`CURRENT_SCHEMA_VERSION = 8`" and "v1→v8 migration chain"; code is **v9** (`models.rs:978`; `migrate_v8_to_v9` at `commands/project.rs:392-410`). CLAUDE.md is stale.
2. **CLAUDE.md vs code/memory — HDR framing.** CLAUDE.md: "`HdrHlg` delivery is near-term." Code ships `DeliveryTarget::HdrHlg | HdrPq` *today* (`delivery.rs:243`); the project stance (memory `project_hdr_is_current`) is HDR co-equal NOW. **No root doc mentions the HdrPq target at all.**
3. **PIPELINE_DECISIONS.md vs code — A1-kernel.** A1-kernel `f=spline36` is marked **ACCEPT** (PIPELINE_DECISIONS.md:24-28) but `spline36` appears **nowhere** in `src/` or `src-tauri/` (repo-wide grep, 0 hits). An accepted decision was never implemented (or was implemented differently via SSAA and the ledger never updated).
4. **PIPELINE_DECISIONS.md vs reality — the ledger is abandoned.** A2–A5, B1–B4, C1–C3 all read "pending walkthrough" while the code has since decided them: A2 adopted (`ColorSpace::SRGB` keeps `iec61966-2-1`), A3 adopted (BT.2020 working space kept), B1 adopted in modified form (SSAA, `layout.rs:173`), C2 substantively adopted (overlay format pinned + tested), C1 **not** adopted (still `gbrpf32le`, `color_space.rs:256-258`), C3 **not** adopted (no `hdr-opt`/`repeat-headers` anywhere — replaced by the WS6 VUI-duplication approach at `delivery.rs:188-199`). Anyone reading the ledger today gets the wrong picture.
5. **PIPELINE_RESEARCH.md §1.6/§6.2–6.3 vs the HDR-first constraint.** The research recommends "simplify to sRGB-linear working space unless HDR is near-term" and "mark HDR 'advanced'; primary marketing target is SDR." Both directly violate the binding HDR-co-equal constraint; PIPELINE_TEACHING_HANDOFF.md:53 explicitly instructs rejecting this argument. The research doc itself contains the SDR-default reasoning the project has banned.
6. **PIPELINE_RESEARCH.md §3.2 vs code — npl on delivery.** Research: add `npl=1000` to the HLG finishing zscale. Code: deliberately **no npl on delivery**, npl is ingest-only (`color_space.rs:160-164, 317-320`). Code wins; research superseded.
7. **PIPELINE_RESEARCH.md §4.1 (B1) vs MAP_RENDERING_PLAN vs code.** Research proposed rewriting `canonical_map_viewport` to a fixed `pixel_ratio = 2.0` (shrinking cssW). The plan's lever model was implemented *instead* (`layout.rs:119-134`), with supersampling delivered as a **separate orthogonal SSAA factor** (`layout.rs:136-173`) and an on-GPU downsample so wire frames stay slot-sized. Consequently MAP_RENDERING_PLAN.md:68's claim "`pixelRatio ∈ {1, 4/3, 2}` always" no longer describes the effective DPR — the renderer's DPR carries the supersample factor (`init.ts:57-68`). Neither doc describes the as-built composition.
8. **COLOR_PIPELINE_SPEC.md §6 [LOCKED] vs shipped v9.** Spec: project `color_setting: PartialColorSpace` + per-clip `ClipColor { setting, chroma_siting_setting }` with a 4-layer cascade (clip → project → stream tag → inferred floor) recomputed via ffprobe at every `resolve()`. Shipped: project `working_color_space: WorkingColorSpaceId` (an enum with **one** variant, `LinearBt2020Full` — `models.rs:68-92`) + per-clip `color_space_override: Option<PerAxisOverride>` parsed from zscale tokens (`color_space.rs:228-250`). Different fields, different semantics (working-space *selection* vs per-axis source *assertion*); no chroma-siting setting; the §6.6 migration description ("sets `color_setting = default()` on every clip") doesn't match the purely-additive serde-default migration that shipped.
9. **COLOR_PIPELINE_SPEC.md §2–§5 [LOCKED] vs code.** The 7-node taxonomy, renderer-validator, coalescer, and snapshot performance contract were not built; `color_space.rs` generates the two chain shapes directly (`ingest_zscale_chain` / `delivery_zscale_chain`, :277-329). The `ToneMap` (BT.2446) operator and the `Compositor`-as-node abstraction do not exist as such. §4's per-mode working spaces (ConsumerSdr ⇒ Rec709-linear) conflict with the single fixed BT.2020 working space used for every project (`delivery.rs:182` passes `&ColorSpace::WORKING` unconditionally). The spec calls these sections "settled and implementable" — they were settled and then implemented *differently*.
10. **ARCHITECTURE.md vs CLAUDE.md — timestamp field.** ARCHITECTURE.md:71, 314 names `CreateDate` as the key field; CLAUDE.md's decision is **`CreationDate` over `CreateDate`** (CreateDate corrupted by transfers; fallback chain CreationDate → CreateDate → MediaCreateDate). CLAUDE.md/code win.
11. **ARCHITECTURE.md vs reality — sidecar bundling.** ARCHITECTURE.md:179 "Recommendation: Bundle both as Tauri sidecars for V1." Reality: ffmpeg/exiftool resolved via `PATH`, bundling deferred as "task 130" but required before ship (CLAUDE.md, Tech stack note). Open ship-blocker, not a doc nit.
12. **ARCHITECTURE.md vs the color docs — grading plan.** ARCHITECTURE.md:62 plans slider grading with FFmpeg `eq`/`colorchannelmixer`/`colortemperature`; the entire later color-pipeline effort (UWSR, COLOR_PIPELINE_SPEC, `color_space.rs`, docs/color-pipeline) supersedes this with linear-light working-space architecture. Also ARCHITECTURE.md:66 plans `xfade` crossfades — `xfade` appears nowhere in the code; map transitions carry that role.
13. **MAP_RENDERING_PLAN.md header vs reality.** "Status: ready to implement" — it is implemented (see §2). A reader can't tell plan from history.
14. **PIPELINE_RESEARCH.md §1.1 headline vs its own decision record.** "The single highest-impact fix is dither" — the verification subagent could not reproduce the doc's numbers, the owner cannot reproduce banding in real exports, and the real symptoms (off-color map, blurry edges) are elsewhere (PIPELINE_DECISIONS.md A1-dither; PIPELINE_TEACHING_HANDOFF.md:17). The research doc was never annotated with the debunk.
15. **Known-but-unlanded fix — HDR map reference white (npl=203).** Memory (`project_hdr_map_reference_white`) records the diagnosed root cause of dark HDR-HLG/PQ map exports: SDR map graphics encoded scene-linear instead of anchored at BT.2408 ref white (203 nit), fix = `npl=203` anchoring. `203` appears **nowhere** in `src-tauri/src` — the documented conclusion has not reached the code. UWSR §5 carries the underlying 203-nit convention ("BT.2408 documents the canonical 203-nit answer"). This is the single most valuable *undone* item surfaced by this reconciliation.

---

## 4. Stale / superseded docs (archive candidates)

- **README.md** — Vite template boilerplate, zero TrailCut content. Replace with a real README or delete.
- **Untitled.md** — completed orchestration prompt for the map-decorations redesign (work landed in commits `9d498ad`…`bf4ebeb`; schema v8 shipped and has since moved to v9). Archive. Before archiving, note its anti-pattern list (Untitled.md:177-207) is independently preserved in CLAUDE.md + memory.
- **EXPORT_REDESIGN_HANDOFF.md** — schema-v6-era session handoff; all 6 commits landed long ago. Archive; the filename schema + queue-ordering decisions (its §"Approved blueprint") should be noted as binding wherever export docs live.
- **PIPELINE_TEACHING_HANDOFF.md** — the teaching session it scripts has happened (its outputs are the memory entries and `color_space.rs`). Archive; extract the two-symptom framing first (§"The two symptoms").
- **MAP_RENDERING_PLAN.md** — implemented; the "ready to implement" header and the §"What changes in the code" task list are dead. Keep §"Product-owner spec" and §"Decisions (settled)" as the permanent record (or fold them into ARCHITECTURE/CLAUDE) and archive the rest.
- **PIPELINE_RESEARCH.md** — superseded as a recommendation source by code + `docs/color-pipeline/`; several of its recommendations are now anti-recommendations (§1.1 dither, §1.6 SDR-simplification, §3.2 delivery npl, §4.1 literal pixel_ratio rewrite). Keep §7 (citations) and the empirical traps (§1.5, §5.2); mark the rest historical.
- **PIPELINE_DECISIONS.md** — abandoned ledger whose "pending" statuses misstate decided reality and whose one ACCEPT (A1-kernel) never landed. Either back-fill it to match the code or archive it with a pointer to `color_space.rs` + `docs/color-pipeline/`.
- **COLOR_PIPELINE_SPEC.md** — its LOCKED data-model and node-taxonomy sections were implemented differently (see Conflict 8–9); its TBD-grill sections (§7–§14) were largely mooted by the simpler shipped design. Archive with a "superseded by `util/color_space.rs` + docs/color-pipeline" banner.
- **ARCHITECTURE.md** — the only general architecture doc, but ~60% describes Apr-2026 plans (FIT/`fitparser` never shipped — only `roxmltree` in `src-tauri/Cargo.toml:24`; v1 project-JSON example vs v9 reality; `scan_directory`/command list drift; sidecar bundling "recommendation" vs deferred task 130; eq-filter grading; xfade). Needs a rewrite or an explicit "historical — see CLAUDE.md" banner. CLAUDE.md is currently the de-facto architecture doc.
- **CLAUDE.md** — keep (it's the best current map) but fix: schema 8→9, HDR "near-term"→current (+ HdrPq), add `util/color_space.rs` to the structure listing.

---

## 5. Gems — hard-won knowledge worth preserving regardless of doc fate

1. **BT.2408 reference white / npl=203** — SDR graphics composited onto an HDR canvas must anchor diffuse white at 203 nit (75% HLG), not scene-linear 1.0 (→ 62% HLG, visibly dark). UWSR §5 (the "203-nit answer is a convention, not a derivation" passage) + memory `project_hdr_map_reference_white` (PQ verified same bug, signal 0.58). **Fix not yet in code** — no `203` in `src-tauri/src`.
2. **The lever model** — cssViewport tracks slot *shape*, pixelRatio absorbs *resolution*, paints are fixed CSS-px against `PAINT_REFERENCE_WIDTH = 1080`; perceived-scale invariance falls out as a table (MAP_RENDERING_PLAN.md:55-84). Implemented: `layout.rs:119-134`, `styleSpec.ts:50`. Also the negative knowledge: sub-1 pixelRatio puts MapLibre in a barely-tested regime (label snap, dasharray, tile-zoom glitches), and the original plan's "render-then-crop" and "aspect-agnostic preview" drafts were wrong (MAP_RENDERING_PLAN.md:257-261).
3. **FFmpeg overlay's silent default** — `overlay` without `format=` auto-inserts a swscale that downconverts to yuv420 **and strips color tags to `unknown`**; textual filtergraph reasoning cannot see auto-inserted scalers, so always pair with a `-loglevel verbose` dry-run (PIPELINE_RESEARCH §1.5, §5.2; memory `feedback_ffmpeg_filter_empirical_validation`). Encoded in code as `:format=yuv444p10` on every overlay (`filtergraph.rs:730` et al.) + string-exact tests.
4. **zscale's silent defaults** — `d=none` (no dither) and `f=bilinear` (soft chroma kernel) are the documented defaults; any depth-reduction or chroma-subsample step inherits them unless overridden (PIPELINE_RESEARCH §1.1, §3.2). Related placement rule: dither matters only at depth reductions, nowhere else (§2 "Dither placement rule").
5. **Primaries vs transfer asymmetry** — routing SDR through wide primaries (BT.2020/AP1) is a free, exactly-invertible 3×3 in linear float; routing SDR through an HDR *transfer* (PQ/HLG) and back is the real tax (precision + the npl convention + creative inverse-tone-map). This single distinction dissolves the "universal working space" debate and justifies keeping BT.2020-linear as the working space under HDR-first (UWSR §5).
6. **The compositing wrinkle** — TrailCut composites a map every frame, so "bit-pass the clip through" is moot in map-covered regions; the right goal is "indistinguishable where un-occluded, physically correct where composited," and linear-light blending is mandatory in every project mode (UWSR §6; GPU Gems 3 ch. 24 citation).
7. **sRGB-EOTF vs BT.709/BT.1886 residual** — the WebGL canvas is sRGB (IEC 61966-2-1) per Khronos/W3C; ingesting it with `tin=iec61966-2-1` is colorimetrically correct, and the perceived shift vs preview is the *preview* drifting, not the export. Don't "fix" by retagging to bt709 (PIPELINE_RESEARCH §1.2, §6.1; code: `ColorSpace::SRGB` at `color_space.rs:186-194`).
8. **The two-step ingest shape is load-bearing** — linearize first (keeping source primaries), `format=` to float, then the primaries/matrix hop; and bare rawvideo needs all four source tags explicit or zimg fails planning with code 3074 "no path between colorspaces" (`color_space.rs:260-276`).
9. **VUI duplication (WS6)** — libx264/libx265 silently drop the global `-color_primaries`/`-color_trc` from the bitstream VUI unless duplicated into `-x264-params`/`-x265-params`; without it the `colr` atom is wrong/missing. Lives only in code comments (`delivery.rs:188-199`) — in no root doc.
10. **The export-softness mechanism** — preview runs at Retina DPR 2 (2× SDF supersampling for glyphs rasterized at 24-px design size, `GLYPH_PBF_BORDER = 3`) while a 1×-rendered export gets none — that's the sharpness gap; OpenFreeMap sprites are published 1×-only (no `@2x` sheet), so raster POI icons are the softest element at any pixelRatio > 1 (PIPELINE_RESEARCH §4.1, §4.4). Resolved in code by SSAA ≥2 (`layout.rs:136-173`); decoration-side crispness fixes (keyline/glow) were tried and **rejected on looks** — don't redo (memory `project_decoration_crispness_levers`).
11. **The dither debunk + two-symptom discipline** — the research's headline fix targeted a symptom (banding) nobody observed; the real symptoms were off-color (color path) and blur (sampling path), and every proposal should be tied to one of the two or explicitly to neither. "The doc is a useful map, not ground truth — confirm before teaching" (PIPELINE_TEACHING_HANDOFF.md:9-21, 71).
12. **Delivery-target conformance details** — ProRes 4444 masters must be tagged limited-range (full-range NCLC causes gamma shifts in Resolve/FCP); HLG needs no MaxCLL/MaxFALL/ST 2086 (scene-referred, that metadata is PQ-only); `hvc1` not `hev1` for Apple playback (PIPELINE_RESEARCH §2, §1.7 — hvc1 present at `delivery.rs:228, 237, 250+`).
13. **iPhone GPS is a single point per clip** (where recording started) — the entire reason GPX sync is the product's backbone (ARCHITECTURE.md:320), plus the CreationDate-over-CreateDate timestamp lesson (CLAUDE.md).
14. **PIPELINE_RESEARCH §7's citation library** — the ITU/SMPTE/Khronos/MapLibre/zimg references with section numbers are a curated bibliography that took real effort; keep regardless of the doc's fate. Same for UWSR's references [1]–[27].

---

## 6. Code spot-check evidence index

| Claim | Where verified |
|---|---|
| Schema v9 current | `src-tauri/src/models.rs:978`; migration `src-tauri/src/commands/project.rs:81-122, 392-410` |
| Working space BT.2020-linear `gbrpf32le`, single fixed | `src-tauri/src/util/color_space.rs:178-184, 256-258`; `src-tauri/src/util/color.rs:809-813`; `delivery.rs:182` |
| `WorkingColorSpaceId` has one variant | `models.rs:68-92` |
| Per-clip `color_space_override` | `models.rs:158, 272, 291`; `color_space.rs:228-250` |
| Lever model implemented | `src-tauri/src/export/layout.rs:119-134`; tests :836+ |
| `PAINT_REFERENCE_WIDTH = 1080` | `src/lib/mapVisuals/styleSpec.ts:50` |
| SSAA ≥2, GPU downsample, framebuffer = slot × factor | `layout.rs:136-173, 523-554`; `export/mod.rs:480-527`; `sidecars/renderer/page/init.ts:57-68, 267-271, 669`; `sidecars/renderer/index.ts:108-116, 865-884` |
| No dither / no spline36 / no hdr-opt / no npl=203 anywhere | repo-wide greps, 0 hits each in `src-tauri/src` |
| npl ingest-only (HLG 400 / PQ 1000) | `color_space.rs:160-164, 282-285, 331-338`; tests `color.rs:826, 851, 859` |
| overlay pins format=yuv444p10 + tested | `filtergraph.rs:730, 742, 772, 784, 850`; `mod tests` at :939 (assertions at offsets ~657, 804, 867, 944, 1918-1924) |
| VUI duplication + hvc1 | `delivery.rs:188-199, 228-262` |
| `HdrPq` target exists | `delivery.rs:243` (`DeliveryTarget::HdrHlg | DeliveryTarget::HdrPq`) |
| CRF hardcoded (GAP-003 live) | `delivery.rs` (`-crf 18` in SdrH264/SdrH265/HDR software branches) |
| No `canvasContextAttributes`/`antialias:true` in renderer (B2 not adopted) | grep of `sidecars/renderer/page/init.ts`, 0 hits (only comments about the preserveDrawingBuffer workaround at :541-550, 656) |
| GPX only, no FIT | `src-tauri/Cargo.toml:24` (`roxmltree`), no `fitparser` |
| Loud zscale precondition | `src-tauri/tests/color_fixtures.rs:63, 728` |
| Map-decorations work landed (Untitled.md done) | `git log`: `9d498ad`, `6ead4f6`, `5e64551`, `8c63dd9`, `7d95618`, `bf4ebeb` |
| `docs/color-pipeline/` is the newer color authority | `docs/color-pipeline/README.md` (WS0–WS10 phase plan; names the three user-reported symptoms; explicitly scopes out ACES) |

---

## 7. Reading the situation (for the rewrite-vs-cleanup verdict)

- The root docs are **four generations** layered without pruning: founding plan (ARCHITECTURE, Apr) → map-rendering sprint (MAP_RENDERING_PLAN, May 17) → color research/teaching arc (PIPELINE_* + UWSR + COLOR_PIPELINE_SPEC, May 21–28) → and the actual authority migrated *out of the root* into `docs/color-pipeline/`, code comments, and memory. Nothing was ever marked superseded, which is exactly the "months of conflicting spec markdown" pain.
- The decision *content* is in better shape than the docs suggest: the load-bearing decisions (lever model, working space, ingest shapes, overlay pinning, decorations model) are implemented, tested, and internally consistent **in the code**. The conflicts above are overwhelmingly doc-staleness, not code incoherence — with two true open wounds: the unlanded npl=203 HDR map-white fix (Conflict 15) and the unbundled CLI sidecars (Conflict 11).
- The single most dangerous artifact is **PIPELINE_DECISIONS.md**: it presents itself as the decision ledger while being abandoned, and its one ACCEPT never shipped. Second most dangerous is **COLOR_PIPELINE_SPEC.md**'s LOCKED label on a design the code declined. Both should be banner-marked or archived before any agent treats them as instructions.
