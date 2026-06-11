# Ship Review — docs/ Tree Reconciliation (excluding docs/ship-review/)

**Date**: 2026-06-11
**Scope**: `docs/export/` (PLAN, LAYOUT, plans/, tasks/), `docs/migration/` (SCORECARD, COMPILED_TIMELINE_PLAN, VALIDATION_REPORT, tasks/), `docs/color-pipeline/` (README, ARCHITECTURE, EXECUTION, phase-1/, phase-2/, background/), `docs/map-decorations/` (all seven docs + wireframes.html).
**Method**: every doc read or section-skimmed; every claim of "done / live / dead" cross-checked against the working tree on branch `feat/control-panel` (HEAD `0f51a8a`). Citations are `file:line` in this repo.
**Verdict context**: this feeds the "restart clean vs clean in place" decision. Sections: per-area reconciliation → binding decisions → conflicts → stale/archive list → gems → systemic observations.

---

## 1. docs/migration/ — the compiled-timeline migration: MODEL LIVE, DOCS CLOSED

### What it describes

A completed architectural migration (the "500-series", branch `migration/cameraAt`, May 1–3 2026) from wall-clock camera anchors (`MapAnchor`/`MapTrack`) to a **compiled project-timeline model**: a pure compiler (`compileTimeline`) turns the ordered clip list into `ClipSpan[]` + `TransitionSpan[]`, and a pure evaluator `cameraAt(timeline, t)` drives both preview and export on a derived project-time axis. Plan: `docs/migration/COMPILED_TIMELINE_PLAN.md` (483 lines, dated 2026-05-01).

### Live or dead?

**The model is fully live; the documents are historical records of a finished job.**

- `compileTimeline` exists at `src/lib/cameraIntent.ts:866`; `cameraAt(timeline: CompiledTimeline, t: number)` at `src/lib/cameraIntent.ts:1230`. The wall-clock anchor code is gone (task 570, commit `eb38179` per `SCORECARD.md:27`).
- The schema bump it introduced (v2→v3) is now five migrations deep — `migrate_v2_to_v3_value` survives in the chain at `src-tauri/src/commands/project.rs:215`.
- The plan's authored types (`ProjectStartCamera`, `ClipEntryTransition`, `entryBias` in [-1,1], destination-owns-transition) are in `src/types.ts` / `src-tauri/src/models.rs` and bind the product today.
- `SCORECARD.md:51`: hard-stop cleared 2026-05-03 with user sign-off; `COMPILED_TIMELINE_VALIDATION_REPORT.md:7` verdict **PASS**.

### The 600-series: superseded twice

The export half (600–640: hidden-Tauri-webview renderer, PNG output) was superseded **before any code landed** (`docs/migration/tasks/_superseded/README.md:1-17`, `SCORECARD.md:31-47`) and replaced by `docs/export/PLAN.md`. Note the supersession is itself stale one level deeper: `_superseded/README.md:21` describes the replacement as "`@maplibre/maplibre-gl-native`" and `:30` says "the frontend pre-resolves cameras via `resolveIntent` and ships `FrameSpec[]`" — both of which were *also* superseded later (chromium renderer per tasks 115–119; workers now receive project state and call `cameraAt` themselves, per `docs/export/PLAN.md:26`).

### Loose ends

1. **The one deferred validation item is still open.** `COMPILED_TIMELINE_VALIDATION_REPORT.md:150-156` and `:326`: "Export at any project-time `t` matches preview at the same `t` — **DEFERRED to task 640**." Task 640 was superseded; its replacement is export task **120 "Render parity verification"** (`docs/export/tasks/README.md:35`), which is **still ⬜ and was never even authored** (`tasks/README.md:52`). The single quality gate that asserts preview ≡ export *visually* has been deferred since 2026-05-02 — and preview/export visual divergence (map color, edge sharpness) is precisely the project's current headline pain. The 117 golden-frame test (`src-tauri/tests/golden_frame_parity.rs`) is a *renderer-regression* guard against fixtures, not a preview-vs-export comparison; it does not close this gap.
2. The opt-in validation probe `src/lib/cameraIntent.validation.test.ts` still exists; `VALIDATION_REPORT.md:338-341` says it "can be deleted" after sign-off. Never deleted.
3. Every per-file task status in `docs/migration/tasks/5*.md` still says `**Status**: pending` (e.g. `500-authored-types-and-schema-v3.md:` status line) while `SCORECARD.md:20-29` marks all ten ✅ with commit hashes. Only the index was maintained.
4. `COMPILED_TIMELINE_PLAN.md:15` calls itself "the forward-looking source of truth", and its §Export Semantics (`:239-254`, "jumpTo … wait for tiles … capture frame") describes the dead webview approach. A reader trusting the self-description gets a wrong export model.

**Disposition**: archive the whole directory as history. Extract the gems (§5 below) first — several of the best ideas in the codebase live only here.

---

## 2. docs/export/ — architecture docs mostly binding; task index half-stale; per-file statuses dead

### 2.1 PLAN.md (2026-05-05, revised post-118)

Defines the three channels (A composite / B map-only / C video-only), the Node-sidecar + headless-Chromium renderer, the stdio IPC, cross-platform bundling, and the two load-bearing principles ("single source of camera truth", "single source of visual truth" — `PLAN.md:26-27`).

**Live**: channels dispatch exactly as specced (`src-tauri/src/export/mod.rs:370-371` matches `"map_only"`/`"video_only"`/composite; `src/types.ts:904` `ExportChannel`). The cmd protocol (setup/render/recycle/shutdown, line-delimited JSON in, length-prefixed RGBA out) survives: `src-tauri/src/export/protocol.rs:96-108` (`render_line`, `recycle_line`, `shutdown_line`), renderer writes the 4-byte big-endian prefix at `src-tauri/sidecars/renderer/index.ts:951`. The mapVisuals/cameraAt sharing is real (`src/lib/mapVisuals/index.ts` exports `buildStaticSourceData`, `buildPerFrameState`; renderer imports them).

**Stale in detail**:
- The IPC contract (`PLAN.md:198-207`) shows `"viewport": {"w","h"}`; the real `SetupPayload` is the MAP_RENDERING_PLAN lever model: `cssViewport` / `framebuffer` / `readback` / `pixelRatio` (`src-tauri/src/export/protocol.rs:39-51`). Anyone implementing against PLAN.md's wire shape today writes a broken worker.
- `PLAN.md:174` says `fps: number // 30 or 60`; the export-controls plan added 24 and an Auto mode (`docs/export/plans/export-controls.md:12`).
- §Performance (`PLAN.md:263-303`) is entirely maplibre-native-era numbers (CPU renders, Metal speculation) — historical.
- `PLAN.md:93-98` claims ffmpeg ships as a bundled sidecar via `externalBin`; in reality only `binaries/chrome-*/**` is bundled (`src-tauri/tauri.conf.json:43-45`) and ffmpeg/exiftool/node resolve via `PATH` (CLAUDE.md "task 130 … required before ship"). Task 130 was never authored.
- The frame transport between page and Node is base64 over CDP with a PNG escape hatch (`renderer/index.ts:55,545,857-863`) — invisible at PLAN.md's altitude but the relevant constraint for any throughput work (100 MB CDP cap).

### 2.2 LAYOUT.md (2026-05-05)

The locked layout/channel-format decisions. **Mostly binding and faithfully implemented**: PiP + Split modes, swap, divider orientation locked by aspect, per-project-per-aspect storage, map-viewport-equals-slot invariant, masked positional B/C exports as ProRes 4444 (`src-tauri/src/export/mod.rs:426,694` "ProRes 4444 with alpha — Channel B's/C's compositing intermediate"), per-clip chain `trim → setpts → focal-crop → scale` shared between A and C (`src-tauri/src/export/clip_chain.rs:1-13` cites "LAYOUT.md §7 invariant" directly), hidden-clips-excluded, focal zoom ≥ 1, audio passthrough + chained `atempo`.

**Superseded in two places**:
- §2/§6 fixed output dims ("Output dimensions are fixed by the chosen aspect", 1080×1920 etc., `LAYOUT.md:52-60,121-126`) — superseded by the export-controls resolution knob (`720p|1080p|1440p|2160p`, `docs/export/plans/export-controls.md:11`) and the per-job quality chips in the export grid.
- §6/§10 "Channel A: H.265 in `.mp4`, CRF ~17" (`LAYOUT.md:123,255`) — superseded twice: export-controls sets CRF 19 (HEVC) / 20 (H.264) (`export-controls.md:18`), and Channel A now accepts the full delivery-target set including **HdrHlg** and **HdrPq** (`src-tauri/src/export/delivery.rs:58-82`). LAYOUT.md §10's decisions index still reads SDR-only — a reader gets the pre-HDR product.
- §9 open UI questions — explicitly superseded by `plans/layout-ui.md` (its own header says so).

### 2.3 plans/

- **`chromium-renderer.md`** — self-declared "**Complete (2026-05-08)** … preserved as a historical record". Accurate. `@maplibre/maplibre-gl-native` is gone from both package.json files (verified). Excellent ADR (see gems).
- **`layout-ui.md`** — header says "**Status: Design — not yet implemented**" (2026-05-09). **Stale: it is implemented.** Map Positioning modal exists (`src/components/MapPositioningModal/MapPositioningModal.tsx`, `TriptychTile.tsx:76` reuses the chromeless `LayoutConfigurator` exactly as §3 specs); snap threshold bumped to 0.05 per §3 ("bump to 0.05–0.06") at `src/components/LayoutConfigurator/snap.ts:3`; single Export button (`src/screens/ProjectView.tsx:523`). Its §4 export modal (aspect checkboxes + channel toggles) was then **superseded again** by the root `EXPORT_REDESIGN_HANDOFF.md` 3×3 grid (`ExportGrid` cells of `ExportConfig{quality,fps}` chips — `src/types.ts:924,965`, `src/components/ExportModal/ExportGrid.tsx`). So layout-ui.md is one generation stale on its own headline surface.
- **`export-controls.md`** — Phases 1–4 merged per `EXPORT_REDESIGN_HANDOFF.md:24-30` ("OutputResolution, CodecPreference, FrameRateChoice all exist … fps consumed end-to-end"). Contains the binding "codec preference does NOT silently fall back" decision (`export-controls.md:37,219`).
- **`large-clip-count-composite.md`** — "Design — not yet implemented" — **accurate; nothing implemented**. No pre-pass concat, no persistent probe cache (`src-tauri/src/export/ffprobe.rs:6` "persistent on disk is deferred; v1 caches in-process"). **The file contains the entire document twice** — a verbatim duplicate starts at line ~580 (`grep -n '^## 1. Problem'` hits lines 10 and 580; `diff` of the halves shows only the header missing from the copy). Pure paste accident, never noticed.

### 2.4 tasks/ — the status ledger is split-brained

`tasks/README.md:18-46` (the index) vs the individual files vs the code:

| Range | Index says | File header says | Code says |
|---|---|---|---|
| 010–119 (pipeline + chromium migration) | ✅ done | `**Status**: pending` in nearly every file (e.g. `010-shared-mapvisuals-module.md:5`, `115-…md`, `118-…md`, `119-…md`; only 030 and 035 say "done") | **Done.** mapVisuals module, sidecar, orchestrator, tile cache, encoder probe, layouts, channels A/B/C, configurator, chromium cutover, native removal — all verified present. |
| 120 (preview↔export parity) | ⬜, "not yet authored" (`README.md:52`) | file does not exist | **Never executed.** See §1 loose-end #1 — this is the deferred gate from the migration. |
| 130 (sidecar bundling/Windows) | ⬜, not authored | file does not exist | Not done; only chrome-headless-shell is bundled (`tauri.conf.json:43-45`). CLAUDE.md flags it "required before ship". |
| 200–230 (Map Positioning modal) | ⬜ pending | pending | **Done** (MapPositioningModal + snap 0.05 + LayoutConfigurator-in-triptych). |
| 240–290 (export modal/queue) | ⬜ pending | pending | **Done, but per a different spec**: the shipped modal is the `EXPORT_REDESIGN_HANDOFF.md` grid, not task 240's scaffold. Filenames (`src/lib/exportFilenames.ts`), estimate (`src/lib/exportEstimate.ts`), queue (`src/hooks/useExportQueue.ts`), persisted selection (`models.rs:1056 last_export_selection: Option<ExportGrid>`, restructured v5→v6 per `EXPORT_GAPS.md` GAP-001), temp buttons removed (single button `ProjectView.tsx:523`). |

So the README is accurate for 010–119, wrong (pending-but-shipped) for 200–290, and the per-file `Status:` headers are accurate **nowhere**. Three status ledgers, zero fully maintained.

---

## 3. docs/color-pipeline/ — the most load-bearing doc set; live, with a stale delivery table and a missing chapter

### Live and binding

- The **working-space contract** (`ARCHITECTURE.md:15-24`: linear-light RGB, BT.2020 primaries, full range, `gbrpf32le`, transforms only at the borders) is implemented and *test-asserted*: `src-tauri/src/util/color.rs:40-56` quotes the doc table verbatim in a comment, and `color.rs:809-813` hard-asserts `WORKING_SPACE_PIX_FMT == "gbrpf32le"`, primaries `bt2020`, matrix `bt2020nc`.
- **Ingest classification** (`ARCHITECTURE.md:48-58`: SdrBt709 / HlgBt2020 / PqBt2020 / DolbyVision / Unknown, HLG `npl=400`, PQ `npl=1000`) is live in `color.rs` (tests at `:712,745,851`) and in the proxy path (`src-tauri/src/commands/ffmpeg.rs:104-115` — zscale linearize → tonemap → bt709 for SDR proxies, exactly WS1's design).
- **Phase 2 (log)** shipped: `src-tauri/src/util/log_detection.rs`, `src/lib/sourceFormat.ts`, five vendor LUTs at `src-tauri/resources/luts/` (Canon CLog/2/3, DJI DLog, GoPro Protune) — matching WS8/WS9/WS10. "Auto-detect HDR, manually declare log" (`ARCHITECTURE.md:121`) is enforced in code comments (`color.rs:13-16`).
- The "three bugs" origin story (`README.md:9-13`: washed-out video, PiP map saturation, QuickTime per-frame warnings → root cause "no color management") is the canonical motivation record.

### Stale / superseded

1. **The delivery-formula table is dead.** `ARCHITECTURE.md:80-88` defines aspect-baked targets (`social_sdr_vertical`, `social_sdr_square`, `youtube_sdr_4k`, `youtube_hdr_4k`, `prores_master`). The shipped model is orthogonal: `DeliveryTarget { SdrH264, SdrH265, HdrHlg, HdrPq, ProresAlpha }` — five variants, `HdrPq` added on the current branch as the registry-extensibility proof (`src-tauri/src/export/delivery.rs:58-82`; note `mod.rs:113`'s doc comment still says "four `DeliveryTarget` variants" — code-comment staleness mirroring the doc staleness) × aspect × resolution × fps via the export grid. Nobody should implement from this table.
2. **The doc set predates the atomic-axes registry.** `src-tauri/src/util/color_space.rs` (new, currently untracked on `feat/control-panel`) makes primaries×transfer×range×matrix a typed registry from which ingest/delivery zscale strings are *generated*; `color.rs:57-66` now says the doc-named constants are "DERIVED from the registry … the registry is the single source of truth", and `color.rs:120` references per-clip working-space overrides "(schema v9)". `CURRENT_SCHEMA_VERSION` is already **9** (`src-tauri/src/models.rs:978`, `migrate_v8_to_v9_value` at `commands/project.rs:392`). None of this is in docs/color-pipeline/. The newer root docs (`PIPELINE_RESEARCH.md` / `PIPELINE_DECISIONS.md` / `PIPELINE_TEACHING_HANDOFF.md`) layer on top without back-pointers from this directory.
3. **The HDR-map chapter is missing.** The known HDR-HLG map-darkness root cause (SDR map graphics need BT.2408 reference-white anchoring, `npl=203`, at the map→working / working→HLG seam) appears nowhere here; `ARCHITECTURE.md:65-74` (`F_map_to_working`) specifies the map ingest with no npl and no reference-white discussion. Root `PIPELINE_DECISIONS.md` Cluster C item C1 (gbrpf32le → gbra**p**f32le, alpha-preserving) is "pending walkthrough" (`PIPELINE_DECISIONS.md:61-62`) and would amend this doc's working-space table if accepted.
4. `EXECUTION.md` is an agent-dispatch script for a plan that has been executed — operationally dead, historically interesting (see §6).
5. Phase-1/phase-2 WS briefs carry no status headers at all; all ten are executed.

---

## 4. docs/map-decorations/ — implemented through Step 8; the "canonical" data-model doc has been outgrown

### Implemented (this is the current branch's subject)

The seven-doc set (DESIGN → data-model → rendering → color-gradient → shapes-pov → panel-ux → IMPLEMENTATION-PLAN) designed the v7→v8 decorations redesign. Build sequence Steps 1–8 are all in the tree:

- Nested `MapSettings` (camera/route/waypoints/pov), `DecorationColor`, `GradientStop`, hand-curated `MapOverrides`, `Waypoint.color/.shape` — `src/types.ts` (e.g. `WaypointShape` at `:380`, `OverridePath` union at `:736`), `migrate_v7_to_v8_value` at `src-tauri/src/commands/project.rs:350`.
- Gradients bucket in `ResolvedStaticPaints` exactly as specced (`src/lib/mapVisuals/styleSpec.ts:373-394`, `lineMetrics`/`line-gradient` per `rendering.md`).
- Active-waypoint **halo** per IMPLEMENTATION-PLAN "[DECIDED]" Q2 (`src/lib/mapVisuals/paints.ts:28,40-46,118` — including "per [DECIDED] Q1" in a comment).
- Pulse styles per [DECIDED] Q3: `pulse_style`/`pulse_rate` on `PovSettings` + `MapOverrides.pov` (`src/types.ts:491-492,525-526,572-573`).
- `react-colorful@^5.7.0` pinned exactly as headline choice #4 (`package.json:29`).
- UI: `MapToolbar/DecorationPanel/`, `ColorSection/` (with `GradientEditor.tsx`, `gradientMath.ts`, `swatches.ts`), `ShapeSection/` all exist.

### Where code has moved past the docs

1. **`data-model.md` declares itself "Status: canonical … other docs defer to the types defined here" (`data-model.md:3-6`) but the canon has drifted.** Code adds: `PovSettings.secondary` color (`src/types.ts:485-487`), `Waypoint.secondary_color` (`src/types.ts:346-351`), a `waypoints-secondary` symbol layer (`src/types.ts:305-307`), and the pulse fields. None are in data-model.md §2/§6. The doc that promises to be the type authority is now a subset of reality.
2. **`panel-ux.md` §3 "Panel Shape Decision — Anchored Floating Popover"** (anchored to the trigger, recomputed with the toolbar's ResizeObserver; `IMPLEMENTATION-PLAN.md:233-236` same) — superseded by the tear-away model: `src/components/MapToolbar/MapToolbar.tsx:221` "floating windows — there is no 'docked' mode. Position, size…" (commit `95135ed` "tearaway controls"). The panels are now free-floating windows, not anchored dropdowns.
3. **Schema**: the whole doc set targets "v8 terminal" (`data-model.md:14`, `IMPLEMENTATION-PLAN.md:13`); the repo is at v9 (`models.rs:978`). The v8 design itself survived intact — v9 stacked color-space fields on top — but every "CURRENT_SCHEMA_VERSION = 8" statement is now wrong, including in CLAUDE.md.
4. `shapes-pov.md` Part 1's shape inventory (circle/ring/pin/square/diamond/numbered-circle) matches `src/types.ts:380-385`; the pin shape was being fixed as recently as commit `8f27b8c` — design live, implementation in active polish.

### Quality note

This is the **best-reconciled doc set in the repo**: DESIGN.md carries a "Resolved decisions (since this doc was first written)" section (`DESIGN.md:183-199`) that retro-amends itself (e.g. "POV per-clip overridable for everything — earlier drafts said project-only; that decision is reversed"), and IMPLEMENTATION-PLAN's "[DECIDED]" block (`IMPLEMENTATION-PLAN.md:411-434`) closes its own open questions. Only data-model.md was left behind.

---

## 5. Binding decisions extracted (still bind the codebase today)

Camera / timeline (docs/migration/):
- **B1** `cameraAt(timeline, t)` is the single source of camera truth for preview AND export; project-time is fully derived, never persisted (`COMPILED_TIMELINE_PLAN.md:60-75`; `cameraIntent.ts:866,1230`).
- **B2** Three named time axes (clip-local / wall-clock / project-time) with explicit translation at the seams (`COMPILED_TIMELINE_PLAN.md:51-75`).
- **B3** Destination clip owns the entry transition; `entryBias ∈ [-1,1]`; independent-side clamping; continuity invariants are gating tests (`COMPILED_TIMELINE_PLAN.md:77-147,256-270`).
- **B4** Authored `durationMs` is literal; `transitionFeel` applies only to auto-derived durations (`:223-237`).

Export (docs/export/):
- **B5** Single source of visual truth: every MapSettings-derived visual decision lives in `src/lib/mapVisuals/` and both preview and the renderer sidecar consume it; animations are project-time pure functions (`PLAN.md:27`; enforced structurally per `tasks/README.md:54-58`).
- **B6** Headless, parallel, deterministic rendering — `(timeline, t, viewport) → pixels`; frozen clock + zero-duration transitions + tile cache keyed on original URLs (`PLAN.md:25,117-124`).
- **B7** Three channels; B/C are masked positional ProRes 4444 exports at full frame dims (stackable in any NLE with zero positioning) (`PLAN.md:29-43`; `LAYOUT.md:117-149`; `mod.rs:426,694`).
- **B8** Per-clip video chain `trim → setpts → focal-crop → scale` is one builder shared by A and C (`LAYOUT.md §7`; `clip_chain.rs:1-13`).
- **B9** Map render viewport = layout slot dims, not output dims (`LAYOUT.md:98-109`; lever-model `SetupPayload`, `protocol.rs:39-51`).
- **B10** Layout per project per aspect; per-clip layout geometry deferred to v2 *together with* animated transitions (`LAYOUT.md:72-96`).
- **B11** Exports read originals, never proxies (`LAYOUT.md:196-198`; `ARCHITECTURE.md` decision 3).
- **B12** Hidden clips contribute nothing — no video, audio, or time (`LAYOUT.md:200-206`).
- **B13** Chromium renderer because of the native-painter sub-pixel wobble; the `moving:true` painterPatch is the load-bearing fix (`plans/chromium-renderer.md:1-15`; `PLAN.md:47-51`).
- **B14** Codec preference never silently falls back; HEVC-unavailable = clean error (`plans/export-controls.md:37,219`).

Color (docs/color-pipeline/):
- **B15** One working space — linear-light, BT.2020 primaries, full range, `gbrpf32le`; color math only at the borders (ingest/delivery) (`ARCHITECTURE.md:5-26`; asserted `color.rs:809-813`). HDR delivery from any project is the point of BT.2020.
- **B16** Auto-detect HDR; log is user-declared, never auto-applied (false positives destructive) (`ARCHITECTURE.md:104-121`; `color.rs:13-16`).
- **B17** Proxies are always SDR (WKWebView constraint); preview-matches-export holds in SDR terms (`ARCHITECTURE.md` decision 4).
- **B18** Every output carries explicit `-color_primaries/-color_trc/-colorspace/-color_range` tags (`ARCHITECTURE.md:88`).

Decorations (docs/map-decorations/):
- **B19** Route / Waypoints / POV are independent decorations with independent color systems; linking is a one-shot copy, never a binding (`DESIGN.md:77-127`).
- **B20** Gradient parameter is **Web Mercator** line-progress fraction, not geodesic distance (`color-gradient.md:31-48`; `routeLocation.ts:268 progressUpTo`).
- **B21** Override taxonomy: per-clip packets (Convention A) vs per-entity fields (Convention B); waypoint color/shape are per-Waypoint solid-only; route color project-only; POV fully per-clip (`data-model.md §10, :20-31`).
- **B22** `MapOverrides` is hand-curated, not `DeepPartial` — the type system encodes which overrides are legal (`data-model.md:34-64`).
- **B23** Decoration sizes are fractions of the 1080-CSS-px reference width (perceived-scale invariance) (`DESIGN.md:178-181`).

---

## 6. Conflicts (docs vs docs, docs vs code)

**C1 — Schema version three-way split.** `models.rs:978` says `CURRENT_SCHEMA_VERSION = 9` (with `migrate_v8_to_v9_value` at `project.rs:392`); CLAUDE.md says "CURRENT_SCHEMA_VERSION = 8"; `docs/map-decorations/data-model.md:14` and `IMPLEMENTATION-PLAN.md:13` treat v8 as current/terminal. The v9 bump (color-space fields, per `color.rs:120`) is documented nowhere in docs/.

**C2 — Task-status ledgers contradict each other and the code.** `docs/export/tasks/README.md:37-46` marks 200–290 ⬜ pending; all are shipped (§2.4). Nearly every individual task file in `docs/export/tasks/` and `docs/migration/tasks/` says `Status: pending` while its index says ✅ done. Three ledgers, none authoritative.

**C3 — Delivery-target model.** `docs/color-pipeline/ARCHITECTURE.md:80-88` (aspect-baked targets, `social_sdr_vertical` …) vs shipped orthogonal `DeliveryTarget{SdrH264,SdrH265,HdrHlg,HdrPq,ProresAlpha}` × `ExportGrid` (`delivery.rs:58-82`, `types.ts:924,965`).

**C4 — Channel-A encode spec.** `LAYOUT.md:123,255` "H.265 in .mp4, CRF ~17", SDR-only framing vs `export-controls.md:21` CRF 19/20 + codec preference vs the HdrHlg first-class delivery channel. LAYOUT.md's decisions index reads SDR-default — against the project's HDR-co-equal rule.

**C5 — Renderer IPC wire shape.** `PLAN.md:198-207` `viewport:{w,h}` vs `protocol.rs:39-51` `cssViewport/framebuffer/readback/pixelRatio`. PLAN.md also still claims ffmpeg is a bundled sidecar (`PLAN.md:93-97`) vs PATH resolution + `tauri.conf.json:43-45` bundling only chrome.

**C6 — Panel anchoring.** `panel-ux.md` §3 + `IMPLEMENTATION-PLAN.md:233-236` (popover anchored to trigger) vs `MapToolbar.tsx:221` "floating windows — there is no 'docked' mode" (tear-away rewrite, commit `95135ed`).

**C7 — "Canonical" data model is a subset of the code.** `data-model.md:3` ("canonical… other docs defer to the types defined here") vs `types.ts:346,485-492` (`secondary_color`, `PovSettings.secondary`, `pulse_style`, `pulse_rate`, `waypoints-secondary` layer) — none present in the doc.

**C8 — Silent test skip vs the loud-failure rule.** `src-tauri/tests/golden_frame_parity.rs:250-257`: if `TRAILCUT_CHROME_BIN` is unset the parity test prints "SKIP …" to stderr and `return`s green. This is the exact silent-skip-on-missing-precondition pattern the project has ruled a defect (cf. `assert_ffmpeg_has_zscale` done correctly in `src-tauri/tests/color_fixtures.rs`). `docs/export/tasks/117-golden-frame-parity.md` does not mention the skip, so the doc neither sanctions nor records it.

**C9 — Self-describing staleness.** `COMPILED_TIMELINE_PLAN.md:15` "forward-looking source of truth" + §Export Semantics describing the dead webview flow; `plans/layout-ui.md` header "not yet implemented" for a shipped feature; `_superseded/README.md:21,30` describing its replacement in terms (maplibre-native, frontend-pre-resolved `FrameSpec[]`) that were themselves replaced.

**C10 — Deferred parity gate lost in the supersession chain.** `VALIDATION_REPORT.md:326` defers "export matches preview" to task 640 → 640 superseded → re-specced as export task 120 (`tasks/README.md:35`) → 120 never authored (`:52`). No doc records that the project's *only* end-to-end preview≡export visual check has been pending for five weeks while preview/export divergence became the headline quality problem.

**C11 — Duplicate document body.** `docs/export/plans/large-clip-count-composite.md` contains its full text twice (second copy begins ~line 580).

---

## 7. Stale / redundant — archive candidates

1. **`docs/migration/` — entire directory.** Executed, signed off, superseded. Keep as history; harvest gems first. (`SCORECARD.md`, plan, validation report, 500-series tasks, `_superseded/` 600-series.)
2. **`docs/export/tasks/010–119`** — done; per-file Status headers wrong throughout. `200–290` — done; index wrong. Archive after fixing the README to record final state.
3. **`docs/export/plans/chromium-renderer.md`** — self-declared historical (keep; it is the wobble ADR of record).
4. **`docs/export/plans/layout-ui.md`** — implemented; its export-modal half superseded by root `EXPORT_REDESIGN_HANDOFF.md`.
5. **`docs/export/PLAN.md`** §Performance (native-era numbers), §IPC payload shape, sidecar-bundling claims — needs a revision pass or a stale-banner; the principles sections remain canon.
6. **`docs/export/LAYOUT.md`** §2 fixed dims, §6 CRF/codec table, §9 (already superseded by layout-ui) — same treatment; §§1,4,5,7,8,10 (minus encode rows) remain canon.
7. **`docs/color-pipeline/EXECUTION.md`** — an agent-dispatch runbook for a completed plan; dead operationally.
8. **`docs/color-pipeline/ARCHITECTURE.md`** delivery table (§Delivery formulas) — dead; rest is the single most load-bearing doc in the repo and should instead be *updated* (atomic-axes registry, v9, HDR-map reference-white chapter).
9. **`docs/map-decorations/`** — implemented; `data-model.md` either gets a v9-era refresh (it claims canon status) or a supersession banner pointing at `src/types.ts`. `wireframes.html`, ASCII mockups in `panel-ux.md`/`color-gradient.md` — historical. `panel-ux.md` §3 anchoring decision — superseded by tear-away.
10. **`docs/export/plans/large-clip-count-composite.md`** — delete the duplicated second half; the design itself is live-but-unexecuted (still the plan of record for N≈70 startup cost).

---

## 8. Gems — ideas worth carrying into any rewrite

**G1 — The three-time-axes table.** `COMPILED_TIMELINE_PLAN.md:51-75`. "Most of the design questions in this doc reduce to 'which axis does this quantity live on?'" — plus the rules (authored = clip-local, GPX = wall-clock, evaluator = project-time, translation only at the seam). This one table prevented an entire class of bugs and is the cleanest piece of domain modeling in the project.

**G2 — Continuity invariants as gating tests + the ε-probe methodology.** `COMPILED_TIMELINE_PLAN.md:256-270` (six invariants any compiler/evaluator pair must satisfy) and `VALIDATION_REPORT.md:199-238` (evaluate `‖cam(b−ε) − cam(b+ε)‖` at every span boundary; max delta 1.336e-7). A reusable template for validating any pure-function timeline evaluator.

**G3 — "Single source of visual truth" and the task-010 story.** `PLAN.md:27` + `tasks/README.md:54-58`: the original IPC treated the worker as a thin pixel renderer taking `style_url` + static geojson; scoping revealed it would silently diverge from preview's much richer surface, so the fix was *structural* — one shared TS module both runtimes import, "enforced structurally rather than by discipline." This is precisely the deep-module move the owner wants more of, already articulated in-house.

**G4 — Conventions A & B for overrides.** `data-model.md §10 (:763-803)`: per-clip override *packets* (settings type + hand-curated mirror + 14-line resolve + leafPaths + computeOverrides) vs per-entity override *fields* (entity.field ?? project default, baked into feature properties). Named, reusable, with the explicit note that the older `ClipEntryTransition` shape is not the recommended pattern. Ready-made architecture vocabulary for color grading, audio, future decorations.

**G5 — Mercator-fraction gradient parameterization.** `color-gradient.md:31-48`: `line-gradient`/`line-progress` are parameterized in Web Mercator projected length, geodesic fractions disagree "by tens of pixels at high zoom / high latitude"; store drag-pixel fractions, derive the km label for display only. Empirical, non-obvious, and already encoded at `routeLocation.ts:268` (`cumulativeMercatorMeters`).

**G6 — The working-space contract as a one-table seam.** `ARCHITECTURE.md:15-26` + the derived constants + boundary assertion test (`color.rs:57-66,809-813`). "Working space changes are a registry edit; the aliases follow automatically" is the borders-only color model done right — and the registry evolution (`color_space.rs`) shows the doc's abstraction held under extension.

**G7 — Masked positional exports.** `LAYOUT.md:117-149`: B/C as full-frame ProRes-4444-with-alpha at slot positions so any NLE reconstructs the composite by stacking, zero positioning work. A sharp, user-back-derived product decision with codec rationale.

**G8 — The wobble ADR.** `plans/chromium-renderer.md`: root cause (painter `options.moving` forced false on long animations → sub-pixel deltas snap to integer grid), the 4-line patch, and a five-option decision table with external citations (Remotion precedent, headless-shell sizing). Model ADR; also the historical justification for the 120 MB bundle.

**G9 — Determinism recipe for headless MapLibre.** `PLAN.md:117-124`: freeze the clock (`setNow`), zero out style transitions, `addProtocol` tile bridge hashed on the original URL, idle + two rAFs per frame. Hard-won; applies to any future renderer (incl. the maplibre-native spike).

**G10 — N-input FFmpeg startup decomposition.** `plans/large-clip-count-composite.md §1`: startup cost = container probes (with the iPhone `apac` spatial-audio codec-lookup stall) + filtergraph compilation + simultaneous decoder init vs fd limits; then options compared with a cache-keyed pre-pass recommendation. The diagnosis is durable even if the fix is reshaped.

**G11 — Tool-per-decoration over tool-per-property.** `DESIGN.md:40-46`: grouping controls by the *thing being styled* ("I want to style my waypoints"), explicitly tied to the pane-level-thinking lesson. A reusable UX principle, not just a panel layout.

**G12 — Honest scope-cut registers.** `EXPORT_GAPS.md` (root, referenced from CLAUDE.md) and DESIGN.md's "Rejected alternatives (do not revisit without strong reason)" (`DESIGN.md:119-127`). Writing down *deliberate* gaps and *rejected* designs with reasons is the only thing in this tree that has reliably prevented re-litigation.

---

## 9. Systemic observations (for the rewrite-vs-cleanup verdict)

1. **The decision content is excellent; the lifecycle management is broken.** Nearly every conflict above is a *bookkeeping* failure (statuses, supersession banners, version numbers), not a design failure. The designs themselves were implemented with unusual fidelity — code comments cite doc sections by name (`clip_chain.rs:4` "LAYOUT.md §7 spec", `color.rs:43` quoting the ARCHITECTURE table, `paints.ts:118` "per [DECIDED] Q1").
2. **Supersession chains are append-only and never compacted.** 600-series → PLAN.md(native) → chromium; layout-ui → EXPORT_REDESIGN_HANDOFF; flat MapSettings → v8 nested → v9 color-space; each generation's doc still presents itself as current. The cost is real: three of the four doc areas would mislead a fresh agent on at least one load-bearing detail (IPC shape, delivery targets, schema version, panel anchoring).
3. **Status truth lives in code, not docs — already.** Every "is this live?" question in this review was answered by grep, not by the docs' own status fields. Whatever the verdict, per-file `Status:` headers should be abolished in favor of one index that links to verifying code locations, or nothing.
4. **The one process gap with product consequences**: deferred gates that cross a supersession boundary get lost (C10 — preview≡export parity, deferred 2026-05-02, still nonexistent, now the pain point). A rewrite that doesn't fix the *gate-tracking* failure will reproduce it.
