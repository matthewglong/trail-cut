# Judge Panel — Rewrite vs Refactor vs Hybrid

Three judges, each assigned to argue the strongest honest case for one strategy, each scoring all three strategies honestly (0–10) against the full 13-agent audit digest. Produced 2026-06-11.

| Judge (assigned stance) | Rewrite | Refactor | Hybrid | Recommended |
|---|---|---|---|---|
| rewrite | 4 | 6.5 | 8.5 | **hybrid** |
| refactor | 3 | 8 | 7 | **refactor** |
| hybrid | 2 | 7 | 8 | **hybrid** |

## Judge: rewrite advocate — recommended **hybrid**

### Argument
The honest rewrite case rests on three pillars. (1) Agential development pays its largest tax in misleading context, not code volume: four unsuperseded doc generations — PIPELINE_DECISIONS.md's abandoned ledger (10/12 falsely 'pending'), COLOR_PIPELINE_SPEC's LOCKED-but-implemented-differently sections, CLAUDE.md's wrong schema version and 'HDR near-term' — actively mislead every agent run. A fresh repo containing only harvested canon eliminates that structurally. (2) The biggest subsystem must be substantially rebuilt anyway: Chrome for Testing is not redistributable, so the renderer host changes before ship regardless; CDP/base64 is 96% of render cost; the composite IR (filtergraph.rs's 5x hand-expanded yuva-lift discipline, mod.rs's stringly triplicated channels) is grade-D for exactly the changes the roadmap needs. (3) The gems are unusually portable: color_space.rs, mapVisuals, cameraIntent, layout — pure modules carrying their own byte-equality and cross-language parity tests. Transplantation is low-risk by construction.

But scored honestly, the case collapses into hybrid: a 'rewrite' that transplants the export leaves, mapVisuals, the renderer's empirical knowledge, lib/, the migration corpus, and 1,200+ tests verbatim is a strangler wearing a new repo. What a true fresh start uniquely destroys is what the audit shows is irreplaceable: engine-fight knowledge embedded in non-pure code (readPixels-in-render-event validity window, idle-deadlock kills, raster-only painterPatch), and — fatally — the parity oracle that 'keep the old app running until parity' presupposes does not exist: no CI, no pixel/signal-level HDR verification (the diagnosed npl=203 bug passes the whole suite; I verified no '203' in src-tauri/src), no decoration golden frames, and the flagship parity test silently skips. You cannot rewrite toward a gate you haven't built. Two stranglers are already succeeding in-tree (color.rs→color_space.rs, compiled timeline). Verdict: hybrid, executed with the rewrite case's discipline — canonize context, build the oracles, then rebuild only the audited soup around transplanted deep modules.

### Must-survive salvage list
- src-tauri/src/util/color_space.rs — atomic-axes registry + byte-equality legacy tests (re-baseline consciously when npl=203 lands; tests currently pin the bug)
- src/lib/mapVisuals/ entire module + the single-source-of-truth contract (grep-verified zero ad-hoc setPaintProperty sites) — including shapes.ts SDF engineering with recorded disproofs
- src/lib/cameraIntent.ts + routeLocation.ts + layout.ts with the TS↔Rust parity fixture (layout_parity.json consumed by both suites)
- src-tauri/src/export/ leaves: clip_chain.rs, layout.rs (lever model + even-dim invariants), orchestrator/protocol (interleaved OOM-avoiding assignment, opaque project_state)
- Renderer empirical knowledge: page/init.ts readPixels-inside-render-event, idle-deadlock transition kills, page-side SDF rasterization (CDP 100MB lesson), painterPatch.ts (raster-only, load-bearing for satellite)
- Test harnesses: color_fixtures.rs (1,567-line executable color archaeology incl. assert_ffmpeg_has_zscale), golden-frame determinism design, protocol byte-identical frame tests, migration corpus v1→v9 + load-never-writes-disk invariant
- .spike/ HDR corpus: IMPLEMENTATION.md A+B+C+D port design (npl anchoring, ×2.03 SDR-origin gain, 10-bit+H=32 headroom, HQ subsample split), SESSION4_FINDINGS (16-bit overlay impossibility), lever_pq/lever_subsample RESULTs, keyline/halo rejection record (do not redo)
- .spike/native-gl VERDICT + research correction: vector basemap GO at RMS 0.008px; upstream PR #4137 / setGestureInProgress routes — no fork needed
- Empirical FFmpeg/QuickTime traps as code: VUI duplication, zimg error-3074 explicit-tags asymmetry, overlay format=yuv420 default, fps-after-concat, corner-mask-in-RGB, CreationDate fallback chain rationale
- Doc-audit binding-decisions lists (docs/ship-review/*) as the seed canon for the cleaned doc tree — everything else archived under supersession banners

### First threads (in order)
1. Stop active data loss: route auto-save through one canonical Project object (kills the useAutoSave field-eraser silently dropping working_color_space/start_camera/default_entry_transition), make save_project an atomic temp+rename write, un-swallow save errors, and add a TS↔Rust Project-shape parity test for types.ts/models.rs
2. Build the parity oracle: stand up CI; convert golden_frame_parity and ffmpeg_runner silent skips to loud failures; add pixel/signal-level HDR output verification (decode a frame, measure HLG/PQ signal) and a decorations golden frame including the pin shape — without this, no strategy is verifiable
3. Land the spike-validated HDR port (A+B+C+D from .spike IMPLEMENTATION.md: one WORKING_NPL constant at ingest AND delivery, ×2.03 SDR-origin anchor, 10-bit headroom gated to HDR, HQ 444→420 subsample) and consciously re-baseline the byte-equality tests that pin the buggy strings (delivery_never_emits_npl, delivery.rs:471)
4. Resolve the renderer host (forced by CfT non-redistributability before ship): prototype maplibre-native vector export per the GO spike, comment spike data on upstream PR #4137/issue #4132, and design the new preview≡export parity gate the shared-TS contract currently provides for free; binary-WebSocket transport as the interim CDP fix
5. Rebuild the one true soup zone as a deep module: collapse filtergraph.rs's 5x composite expansion and mod.rs's stringly channel triplication into a typed composite IR/dispatcher (COLOR_PIPELINE_SPEC grills 5-6 direction), with -loglevel verbose auto_scale dry-run checks promoted to CI; in parallel, canonize the doc tree (supersession banners, one corrected task index, fix CLAUDE.md v8→v9 and HDR-current)

### Risks
- Parity-oracle gap: until CI + pixel-level HDR/decoration tests exist, refactors in exactly the pain areas are unverifiable — and a rewrite's 'run until parity' gate would be theater; this risk applies to all three strategies but is fatal only to rewrite
- Byte-equality tests pin known-wrong behavior (npl absence, pre-fix PQ finishing string) — green suites give false confidence; every re-baseline must be a deliberate, documented act or the strangler freezes bugs as canon a second time
- Strangler stall: two in-flight migrations already show drift (color.rs→color_space.rs incomplete; v9 registry uncommitted on an unrelated feature branch) — hybrid needs explicit per-strangler completion gates or it decays into the doc-ledger failure mode
- Renderer replacement breaks the mapVisuals parity-by-shared-import contract (maplibre-native can't import the TS modules) — adopting it without first designing a replacement parity gate recreates the silent preview/export divergence class
- Doc soup keeps taxing agents under hybrid unless canonization is sequenced early — this is the rewrite case's strongest point and must not slip behind feature threads
- Data-corruption window: non-atomic project.json writes under a 1s auto-save loop plus the field-eraser are destroying user state today; any strategy that defers thread 1 is leveling down shipped users for architectural purity
- Fractional-pixelRatio SDF bug (waypoint icons vanish from 1440p exports) is a shipped silent-divergence defect independent of strategy choice — needs a regression test when fixed or it recurs in any rebuilt renderer host

## Judge: refactor advocate — recommended **refactor**

### Argument
The audit falsifies the rewrite premise. Five of six code subsystems graded keep-with-cleanup; the sixth (frontend state layer) graded redesign-interface — a localized interface redesign, not a teardown. The supposedly soupy areas are the deepest: color_space.rs is an atomic-axes registry where HdrPq landed as one table entry; the mapVisuals contract actually holds (I grep-verified zero ad-hoc paint writes); cameraIntent.ts gives structural preview/export camera parity; the renderer protocol has byte-identical golden-frame determinism. The soup is real but localized and named: filtergraph.rs composite triplication, mod.rs channel dispatch, the App.tsx hook lattice, and four generations of unpruned markdown.

Crucially, the recurring roadblocks are not architecture problems a rewrite would dissolve — they are unlanded, fully-specified fixes. The HDR darkness root cause is diagnosed to the constant (npl=203 / BT.2408), validated externally, and build-ready in .spike IMPLEMENTATION.md with verified file:line sites. Decoration fidelity gaps are a fractional-pixelRatio SDF bug and one missing parity tuple. A rewrite reproduces neither fix for free; it must re-cross every empirically-mined trap (zimg 3074, overlay's silent yuv420 default, VUI duplication, readPixels-in-render-event, painterPatch) without the 1,243 tests, byte-equality regressions, and cross-language parity fixtures that are the only verification currency agential development has. Rewrite forfeits the regression surface precisely where verification is hardest (color, compositing, headless rendering) — and external research confirms the renderer architecture is what the ecosystem converged on. No leveling down applies to codebases too: the worse layer (state/serialization, docs) gets fixed; the better layers don't get discarded.

The refactor sequence is concretely gated: land npl=203 with pixel-level HDR assertions, make saves atomic and the auto-save payload canonical, stand up CI with loud failures, tuple-ify the per-frame paint seam, then rebuild mod.rs dispatch and the composite IR behind golden frames. Every step is interface-preserving and verifiable with the test style already in the repo.

### Must-survive salvage list
- src-tauri/src/util/color_space.rs atomic-axes registry + byte-equality tests (flip pinned-bug expectations only against pixel-level ground truth, never delete)
- src/lib/mapVisuals/ tuple contract (resolveStaticPaints/buildPerFrameState) + shapes.ts SDF engine, consumed identically by MapView.tsx and the renderer sidecar
- src/lib/cameraIntent.ts compiled-timeline + Van Wijk module shared verbatim with the export sidecar (~1700 lines of tests)
- Renderer sidecar protocol + determinism playbook: setNow stepping, readPixels-in-render-event, CDP handshake, painterPatch (raster-only, load-bearing for satellite), loud protocol tests
- Cross-language layout parity fixture (layout.ts / layout.rs / fixtures/layout_parity.json) and the lever model (cssViewport=shape, pixelRatio=density)
- v1→v9 migration chain + test corpus incl. the load-never-writes-disk byte-equality invariant (commands/project.rs)
- color_fixtures.rs harness + assert_ffmpeg_has_zscale loud-precondition pattern
- Empirical FFmpeg trap fixes in place: overlay format=yuv444p10 pin, VUI duplication, zimg-3074 explicit tags, fps-after-concat, setparams on synthetic sources, corner-mask RGB semantics
- .spike HDR records as the build plan: IMPLEMENTATION.md / PORT_DESIGN.md / SESSION4_FINDINGS.md / HANDOFF.md (A+B+C+D land together, npl=100 working space, x2.03 SDR anchor) and native-gl VERDICT.md
- docs binding-decision gems (three time axes, BT.2408 anchor, Conventions A/B, Mercator-fraction gradients) extracted into one living canon doc before the stale generations are archived

### First threads (in order)
1. Land the spike-validated HDR port (A+B+C+D together per .spike/HANDOFF.md): WORKING_NPL anchoring in color_space.rs at ingest AND delivery, x2.03 SDR-origin gain, 10-bit+headroom composite, HQ 444→420 subsample — flipping delivery_never_emits_npl and the byte-pinned PQ string, and adding the suite's first decode-a-frame HDR signal assertion (map white ≈75% HLG / 0.58 PQ)
2. Stop active data loss: atomic temp+rename writes in save_project/recent/camera_presets, and replace useAutoSave's hand-assembled payload with serialization of one canonical Project object (restores working_color_space/start_camera/default_entry_transition, removes catch(()=>{}) and the empty-project skip)
3. Stand up CI and loud-failure compliance: fix the red ExportChip test, convert golden_frame_parity and ffmpeg_runner silent skips to loud failures, then extend the golden-frame fixture with decorations and fix the fractional-pixelRatio SDF bug that vanishes waypoint icons at 1440p
4. Close the last parity hole: tuple-ify the per-frame paint channel (the named-struct seam hand-mapped in MapView.tsx:661-723 and renderer index.ts:736-778) with a parity test, plus the override_secondary_color drop in sources.ts and the painterPatch moving/zooming/rotating flag asymmetry
5. With golden frames + verbose dry-run checks as the safety net, rebuild the two genuine soup spots behind their stable interfaces: filtergraph.rs composite IR (collapse the 5x yuva-lift expansion) and mod.rs channel dispatch; in the same pass, codegen or parity-test the types.ts↔models.rs mirror; archive the four stale doc generations with supersession banners after harvesting gems into one canon doc

### Risks
- Byte-equality tests pin bugs as faithfully as behavior — refactoring against them without pixel/signal-level ground truth re-pins new bugs; every flipped expectation needs a decoded-frame assertion first (the npl=203 thread is the template)
- The 2,160 lines of substring assertions create false refactor confidence: text-equal filtergraphs are not pixel-equal outputs (FFmpeg silently auto-inserts scalers); the composite-IR rebuild must be gated on golden frames + -loglevel verbose dry-runs, not string tests
- The state-layer redesign (the one redesign-interface grade) is where refactor approaches rewrite-scale churn; mis-sequencing it before atomic saves and a canonical Project object could widen the silent-erasure window it is meant to close
- Doc soup actively misleads agents mid-refactor (PIPELINE_DECISIONS' phantom 'pending' statuses, COLOR_PIPELINE_SPEC's LOCKED-but-superseded sections, wrong task ledgers) — archival/banners must be an early gate, not deferred hygiene, or refactor agents will relitigate settled decisions
- Without CI landing first, every refactor step's verification remains opt-in on one machine — the same condition that let the red tree, silent skips, and the never-authored preview≡export parity gate (task 120) persist
- Exogenous forcing functions could partially invalidate in-place renderer investment: Chrome-for-Testing is not redistributable and maplibre-native is GO on vector — a later renderer swap is plausible, so refactor effort there should concentrate on the parts that survive a swap (mapVisuals contract, protocol, parity tests), not Chromium-specific plumbing
- HDR remains shipping with measured defects until thread 1 lands — every export today carries the 62%-white map; the refactor plan's credibility depends on that fix being first, not folded into a later cleanup

## Judge: hybrid advocate — recommended **hybrid**

### Argument
The evidence kills a clean rewrite and reshapes the hybrid: the soup is not where the owner feels it. Five of six code subsystems graded keep-with-cleanup; the engine leaves (color_space.rs atomic-axes registry, clip_chain.rs, layout.rs with cross-language parity fixtures, cameraIntent.ts, mapVisuals/shapes.ts, the renderer determinism playbook) are the deepest modules in the repo. The value at risk in a rewrite is overwhelmingly empirical, non-derivable knowledge: zimg error 3074, overlay's silent yuv420 default, readPixels-only-inside-'render', VUI duplication, the CDP 100MB cap, npl semantics. A rewrite re-derives all of it with no oracle — there is no CI, no pixel-level HDR assertion, no decoration golden frame; the existing tests byte-pin current (sometimes wrong) strings, e.g. delivery.rs:471 pins the PQ string the spike proved incorrect.

But pure in-place refactor is also wrong, for three concrete reasons. (1) One engine subsystem MUST be replaced regardless: Chrome for Testing is not redistributable, so the Chromium renderer is a forced strangle (maplibre-native, vector GO at 0.008px RMS) behind golden-frame parity. (2) The audit's only redesign-interface grade is the state/serialization layer — useAutoSave is erasing working_color_space/start_camera from disk today; that is an interface rewrite (canonical Project store + generated/parity-tested TS mirror + atomic writes), not cleanup. (3) The composite IR (mod.rs stringly channels + filtergraph.rs's five hand-expanded yuva-lift blocks, grade-D change amplification) needs replacement by a typed dispatcher emitting registry-validated nodes, gated by the never-landed B+C≡A parity test.

So the honest hybrid keeps the deep leaves everywhere — engine and shell — and strangles four shallow ligaments behind new pixel-level gates, while landing the already-validated A+B+C+D npl port from .spike/IMPLEMENTATION.md as the first behavior swap. The rewrite's first task would be building exactly this parity harness anyway; hybrid strictly dominates.

### Must-survive salvage list
- src-tauri/src/util/color_space.rs — atomic-axes registry + byte-equality tests (extend, never re-derive; HdrPq landed as one table entry)
- src-tauri/src/export/clip_chain.rs and layout.rs + src-tauri/tests/fixtures/layout_parity.json (TS↔Rust shared fixture — the parity-gate pattern the whole strangle reuses)
- src/lib/cameraIntent.ts + routeLocation.ts — shared verbatim by preview and sidecar; structural camera parity
- src/lib/mapVisuals/ entire contract (styleSpec/perFrame/sources/shapes) — grep-verified zero ad-hoc setPaintProperty sites; the swap seam for any renderer replacement
- Renderer determinism playbook: setNow stepping, readPixels-inside-'render', idle-deadlock kills, painterPatch (raster-only, load-bearing for satellite), CDP handshake — preserve as tests/ADRs even as transport/engine changes
- .spike/IMPLEMENTATION.md + PORT_DESIGN.md + SESSION4_FINDINGS.md — build-ready A+B+C+D npl port with confirmed decisions (npl=100 absolute, ×2.03 anchor, 10-bit+H=32, HQ subsample)
- Migration machinery + corpus (commands/project.rs v1→v9 chain, load-never-writes-disk invariant) and color_fixtures.rs harness incl. assert_ffmpeg_has_zscale
- Frontend deep components: shared ColorSection/GradientEditor, LayoutConfigurator snap modules (~2400 lines of tests), ExportModal async-race handling, exportFilenames schema
- Empirical trap catalog from docs/spikes (zimg 3074 four-tag rule, overlay yuv420 default + verbose dry-run discipline, VUI duplication, BT.2408 per-transfer anchors, edges-must-live-in-luma, keyline/halo REJECTED-on-looks record)
- docs/ship-review/ receipts + the supersession map from docs-root-specs/docs-tree as the archival ledger

### First threads (in order)
1. Verification substrate first: stand up CI; convert every silent skip to loud failure (golden_frame_parity.rs:249-258, ffmpeg_runner.rs:240-262); fix the red ExportChip test; add the missing oracles — pixel/signal-level HDR decode assertions, decorations in the golden-frame fixture, per-frame paint tuple parity between MapView.tsx:661-723 and renderer index.ts:736-778, and the -loglevel verbose auto_scale dry-run check as a CI assertion. Nothing can be swapped 'behind parity tests' until the tests can see pixels.
2. Stop the live bleeding in the shell (small, interface-preserving): atomic project.json writes (commands/project.rs:35), auto-save serializing the canonical Project object instead of the hand-built payload (useAutoSave.ts:80-92 — currently erases working_color_space/start_camera/default_entry_transition), surface save errors; commit the stranded v9/color_space.rs work off feat/control-panel.
3. Land A+B+C+D atomically per .spike/IMPLEMENTATION.md, gated by the new HDR pixel-level tests; consciously retire the byte-pins that encode the bug (delivery_never_emits_npl at color_space.rs:477-483, the wrong PQ string at delivery.rs:471). This is the highest-value engine swap and it is already designed and Matthew-confirmed.
4. Renderer strangle (forced by CfT non-redistributability): start the maplibre-native vector-basemap export prototype behind the now-decorated golden-frame gate; engage upstream on PR #4137 / expose setGestureInProgress for raster; meanwhile fix the fractional-pixelRatio SDF atlas bug (1440p waypoint icons vanish) and the painterPatch flag asymmetry in the current renderer — no leveling down while two renderers coexist.
5. Composite IR: replace mod.rs's three stringly channel branches and filtergraph.rs:597-899's quintuplicated yuva-lift discipline with a typed dispatcher/coalescer emitting color_space.rs-validated nodes, gated by resurrecting the dead integration_export_parity (B+C≡A) test — finishing COLOR_PIPELINE_SPEC grills 5-6 rather than rewriting the builder.

### Risks
- Wrong-oracle parity: existing string/byte-equality tests pin diagnosed-buggy behavior (no-npl delivery, pre-fix PQ string); strangling 'to parity' against them faithfully reproduces the bugs. Pixel-level gates must exist before any behavior swap, and byte-pins must be broken deliberately, not preserved.
- A+B+C+D is all-or-nothing: HANDOFF.md:148-150 — staging without (C) reads as a brightness regression because the overlay clamp hides the fix; a cautious incremental landing is the one thing the spike explicitly forbids.
- The maplibre-native swap abandons the parity-by-import contract (preview and export share mapVisuals TS only while both run maplibre-gl-js); the per-frame paint seam is already duplicated with no test. Without tuple-level cross-engine golden frames, the contract that currently holds dies silently — the exact divergence class the project exists to prevent.
- Strangler half-states: two composite paths and two renderers alive simultaneously invite drift; without CI gating every PR, the interim state recreates today's headline pain. CI is thread 1 for this reason, not hygiene.
- 'Keep the shell' is not 'leave the shell alone': the state layer is the audit's only redesign-interface grade and is corrupting project files today; a hybrid that only touches the engine ships data loss.
- Doc-supersession hazard: un-bannered records (HALO_RESULT's 'adopt glow', native-gl VERDICT's wrong fork-required premise, PIPELINE_DECISIONS' phantom spline36 ACCEPT) will mislead future agents into re-litigating settled rejections unless the archival sweep lands early.
- Uncommitted engine work (color_space.rs, v9 fields) sits on feat/control-panel with unrelated UI changes; if strangling starts before it lands cleanly, every parity baseline shifts mid-flight.
