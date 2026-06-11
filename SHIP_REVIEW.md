# TrailCut Ship Review — June 2026

**Question:** surface the gems and start over cleanly with deep modules, or clean up in place?

**Verdict: do not start over. Run a hybrid/strangler: keep the deep engine leaves (which are most of the code), replace four shallow ligaments behind new pixel-level parity gates — and build those gates first, because today they don't exist.**

Produced by a 16-agent review: 6 code auditors, 3 doc reconcilers, 4 external-research agents (every technical claim below is source-verified, not guessed), and a 3-judge adversarial panel. Full evidence with file:line citations and URLs lives in [`docs/ship-review/`](docs/ship-review/README.md) — this document is the synthesis and the thread list.

---

## 1. The verdict, and why

The judge panel (each judge assigned to argue one strategy as hard as honestly possible, all scoring all three):

| Judge (assigned stance) | Rewrite | Refactor | Hybrid | Recommended |
|---|---|---|---|---|
| Rewrite advocate | 4 | 6.5 | 8.5 | **hybrid** |
| Refactor advocate | 3 | 8 | 7 | **refactor** |
| Hybrid advocate | 2 | 7 | 8 | **hybrid** |

Even the judge whose job was to make the rewrite case concluded it "collapses into hybrid: a rewrite that transplants the export leaves, mapVisuals, the renderer's empirical knowledge, lib/, and 1,200+ tests verbatim is a strangler wearing a new repo." Full arguments: [`judge-panel.md`](docs/ship-review/judge-panel.md).

Three findings drive this:

**The "soupy and shallow" diagnosis is wrong about the code.** Five of six code subsystems graded *keep-with-cleanup*; none graded *rewrite*. The deepest modules sit exactly in the hardest domains: `color_space.rs` is an atomic-axes registry where HdrPq landed as **one table entry with zero filter-code changes**; the mapVisuals single-source-of-truth contract **actually holds** (grep-verified: zero ad-hoc `setPaintProperty` sites in the entire frontend and sidecar); `cameraIntent.ts` gives structural preview/export camera parity by shared import; adding a new map decoration touches **zero Rust**. The renderer architecture was independently confirmed by external research to be exactly what the ecosystem (Mapbox's own tooling, Remotion, the official MapLibre video-export plugin) converged on.

**What feels like soup is mostly the documentation, plus four specific ligaments.** Four unsuperseded generations of markdown actively mislead every agent session: `PIPELINE_DECISIONS.md` marks 10 of 12 entries "pending" that the code decided months ago; `COLOR_PIPELINE_SPEC.md` has LOCKED sections implemented differently; `CLAUDE.md` says schema v8 (code is v9) and "HDR near-term" (HDR ships today). The code-side soup is real but *named and bounded*: `filtergraph.rs`'s composite logic hand-expanded five times, `mod.rs`'s stringly-typed channel dispatch, the frontend state/auto-save layer, and the per-frame paint seam.

**A rewrite has no oracle to rewrite against.** There is no CI at all. No test anywhere decodes an output frame and measures HDR signal values — the *diagnosed* HDR bug passes the entire suite, and one test (`delivery_never_emits_npl`) actively pins it. The golden-frame fixture contains no decorations and silently skips without a manually-set env var. "Keep the old app running until parity" presupposes a parity gate that doesn't exist; building that gate is the first task of *any* strategy, and once it exists, strangling beats restarting because the irreplaceable value here is empirical, non-derivable knowledge (§4) already encoded in working code and tests.

## 2. What is actually wrong (the honest pain list)

In priority order, with receipts:

1. **Active user data loss, today.** `useAutoSave` hand-assembles its payload and omits `working_color_space`, `start_camera`, and `default_entry_transition` — opening any project that has these set silently erases them from disk within ~1s. Saves are non-atomic writes under a 1s loop (corruption window), errors are swallowed by a documented-but-unfixed `catch(()=>{})`. → [`code-frontend-lib.md`](docs/ship-review/code-frontend-lib.md)
2. **The verification gap.** No CI; the working tree is currently red (1 stale ExportChip test); `golden_frame_parity` and two `ffmpeg_runner` tests silently skip (violating your own loud-failure rule); 2,160 lines of filtergraph *substring* assertions verify text, not pixels; byte-equality tests pin two known-wrong behaviors as canon. Decoration fidelity (`shapes.ts`, the pin under active repair) has zero tests. → [`code-tests-quality.md`](docs/ship-review/code-tests-quality.md)
3. **The HDR fix is diagnosed, validated, spec'd — and never landed.** The dark-HDR-map root cause (SDR graphics at ~62% HLG signal instead of BT.2408 graphics white, 75%) was found in `docs/spikes/FINDINGS.md`, refined through Session 4 into a build-ready, Matthew-confirmed port design (`docs/spikes/IMPLEMENTATION.md`: npl anchoring + ×2.03 SDR-origin gain + 10-bit headroom + HQ subsample, with verified file:line sites). **Zero of it is in the tree.** Every HDR export today ships the measured defect. External research verified the physics against ITU BT.2408-7 §5.6 and added a critical trap: npl is a working-space anchor, not a delivery knob — it must be one constant at ingest *and* delivery or camera footage darkens ~2×, and it must ship together with a BT.2446-A tone map for SDR targets. → [`docs-spikes.md`](docs/ship-review/docs-spikes.md), [`research-color-hdr.md`](docs/ship-review/research-color-hdr.md)
4. **The renderer host must change before ship anyway — for licensing, not quality.** Chrome for Testing binaries are governed by Google's ToS and are **not redistributable**; bundling the 343MB tree in the shipped .app is a licensing violation (and a ~350MB tax on every auto-update, since Tauri has no delta updates). → [`research-shipping-deps.md`](docs/ship-review/research-shipping-deps.md)
5. **Silent preview/export divergences in the renderer pair** — the exact class the mapVisuals contract exists to prevent: fractional pixelRatio (1440p × SSAA) breaks the SDF icon atlas so **waypoint icons vanish from 1440p exports**; the visited-mode waypoint rebuild drops `override_secondary_color`; the sidecar's anti-jitter patch forces fewer flags than the preview's. → [`code-renderer-mapvisuals.md`](docs/ship-review/code-renderer-mapvisuals.md)
6. **Two genuine code-soup zones**: `filtergraph.rs:597-899` (the yuva-lift/overlay discipline hand-expanded 5×; worst change-amplification point in the repo — grade D for adding a composite mode, vs grade A for adding delivery targets/decorations) and the frontend state lattice (11 lifted useState hooks, a 16-field param bag, ~45 props into ProjectView, a 1,070-line hand-maintained `types.ts` mirror of `models.rs` with no codegen and no parity test, drift already present). → [`code-export-pipeline.md`](docs/ship-review/code-export-pipeline.md), [`code-frontend-lib.md`](docs/ship-review/code-frontend-lib.md)
7. **Doc rot that actively misleads agents** — the real "soup." Three contradictory status ledgers; a preview≡export parity gate that was deferred across two supersession boundaries and *never authored* while divergence became the headline pain; spike docs whose later corrections live in other files. → [`docs-root-specs.md`](docs/ship-review/docs-root-specs.md), [`docs-tree.md`](docs/ship-review/docs-tree.md)

## 3. The recurring roadblocks now have researched answers

This is the "stop hitting the same wall" section — each was verified against primary sources, not recalled.

**HDR/SDR color and overlays** ([`research-color-hdr.md`](docs/ship-review/research-color-hdr.md)): Your npl=203 finding is *exactly* what BT.2408-7 §5.6 mandates (and what Resolve ships as a named checkbox). The complete recipe is known and validated: one `WORKING_NPL` constant at every HDR ingest and delivery + BT.2446-A tone map for SDR targets, shipped atomically (the spike explicitly forbids staging it — partial landing reads as a brightness regression). zscale remains the deterministic ship baseline; libplacebo is now the quality-superior engine (203-nit default, ITU tone maps, float compositing) but empirically fails on this Mac without MoltenVK — revisit only after sidecar bundling controls the FFmpeg build. One open question worth a test frame: whether sidecar readPixels RGBA is premultiplied while the filtergraph assumes straight alpha — a plausible contributor to decoration edge fringing.

**Map export fidelity** ([`research-map-export-fidelity.md`](docs/ship-review/research-map-export-fidelity.md)): The architecture is right; the transport is the weakness. Replace base64-RGBA-over-CDP with a binary WebSocket side-channel (kills the 100–256MB cap, +33% inflation, ~30-40ms/frame encode; CDP stays as control plane). Add `--force-color-profile=srgb` to Chrome launch args (the PNG parity path is currently host-display-profile-dependent). 4:2:0 delivery blur is inherent to every social platform; your 4:4:4 10-bit intermediate is the textbook mitigation, and the only remaining levers are the HQ single subsample, a 4K delivery rung, and graphics-aware CRF — not decoration redesigns (already rejected, don't redo). The renderer can never emit HDR (headless Chrome is sRGB-only); the npl=203 boundary in FFmpeg is the correct module seam.

**MapLibre native** ([`research-maplibre-native.md`](docs/ship-review/research-maplibre-native.md)): **"We'd have to fork native" is wrong as of June 2026.** The spike's measurements hold, but its mechanism claim doesn't: core mbgl has had the GL-JS-equivalent snap gate since 2023; the spike harness snapped because the *Node binding's* `jumpTo` clears the motion flags synchronously before each static render — a binding-surface gap, not a core limitation. Three escalating no-fork routes: (a) vector basemap needs nothing (spike GO stands); (b) raster: open maintainer-endorsed upstream PR #4137 deletes the snap gate (idle since April — your spike's quantitative jitter data is exactly the evidence it needs), and independently, public API `Map::setGestureInProgress(true)` already disables the snap and only needs ~10-20 lines of Node-binding exposure; (c) image/hillshade sources need one-line upstream fixes. Prebuilts exist for darwin/linux/win32 × x64/arm64. The real cost of native is strategic, not technical: it abandons parity-by-shared-TS-import, so it requires a cross-engine golden-frame gate first.

**Shipping the dependencies** ([`research-shipping-deps.md`](docs/ship-review/research-shipping-deps.md)): FFmpeg can be bundled without TrailCut going GPL (CLI exec is the FSF's canonical separate-programs case); baseline is an LGPL static build (videotoolbox/MF + zimg + prores_ks) — macOS arm64 needs your own CI build, no trusted one exists. AVC royalties are $0 under 100k units/yr. **Replace ExifTool rather than bundle it** — its two call sites are coverable by the `nom-exif` Rust crate (reads `com.apple.quicktime.creationdate` with timezone) + ffprobe. Don't ship Chrome for Testing (not licensed for it); the GO-rated maplibre-native renderer is the recommended replacement, download-at-first-run as an explicitly-marked stopgap.

## 4. The gems (must survive any strategy)

The full inventory with locations is in the receipts and `judge-panel.md`; the irreplaceable core:

- **`util/color_space.rs`** — atomic-axes color registry with byte-equality tests; collapses five copies of BT.709 knowledge into one table. (Currently uncommitted on this branch — see thread 0.)
- **`src/lib/mapVisuals/`** — the contract that actually holds, plus `shapes.ts`'s analytical SDF engineering with recorded disproofs.
- **`cameraIntent.ts` / `routeLocation.ts` / `layout.ts`** — pure, deeply-tested, shared verbatim across preview and export; `layout` has a TS↔Rust parity fixture consumed by both suites — *the parity-gate pattern everything else should copy*.
- **Export-pipeline leaves** — `clip_chain.rs`, `layout.rs` (lever model + even-dim invariants), orchestrator/protocol (interleaved OOM-avoiding frame assignment with a written proof; opaque `project_state` pass-through, which is *why* decorations touch zero Rust).
- **The empirical trap catalog** — months of debugging distilled into code+tests: FFmpeg overlay's silent yuv420 default, zimg error-3074 explicit-tags asymmetry, VUI duplication for x264/x265, fps-after-concat, corner-mask-in-RGB, readPixels-only-inside-MapLibre's-'render'-event, the CDP 100MB lesson, CreationDate fallback chain. External research called the readPixels finding "more rigorous than anything published."
- **The spike corpus** — `docs/spikes/IMPLEMENTATION.md` (build-ready HDR port), SESSION4 (16-bit compositing impossibility proof), keyline/halo *rejection record* (settled, do not re-litigate), native-gl VERDICT (now amended by research).
- **Test harnesses** — `color_fixtures.rs` (1,567 lines of executable color archaeology), golden-frame determinism design, the v1→v9 migration corpus with its load-never-writes-disk invariant.

## 5. Threads to pull, in order

Synthesized from the three judges (who converged on substance and near-converged on order). No human time estimates — sequencing is by dependency and risk.

**Thread 0 — Unstrand the engine work.** `color_space.rs` and the v9 schema fields are uncommitted on `feat/control-panel` mixed with unrelated UI work. Land them cleanly first; every parity baseline shifts mid-flight otherwise.

**Thread 1 — Build the oracle (everything else gates on this).** Stand up CI. Fix the red test. Convert every silent skip to loud failure. Add the missing instruments: a decode-a-frame HDR signal assertion (map white ≈75% HLG / 0.58 PQ), decorations (including the pin) in the golden-frame fixture, a parity test for the per-frame paint seam (`MapView.tsx:661` vs `renderer/index.ts:736` — the one hole in the mapVisuals contract), and the `-loglevel verbose` auto_scale dry-run check as a CI assertion. Until tests can see pixels, no strategy is verifiable.

**Thread 2 — Stop the data loss (small, interface-preserving, urgent).** Atomic temp+rename writes; auto-save serializes one canonical Project object instead of a hand-built payload; surface save errors; add a TS↔Rust Project-shape parity test (or codegen) for `types.ts`/`models.rs`.

**Thread 3 — Land the HDR port, atomically.** A+B+C+D from `docs/spikes/IMPLEMENTATION.md`, gated by thread 1's new pixel-level tests, deliberately retiring the byte-pins that encode the bug (`delivery_never_emits_npl`, the pre-fix PQ string at `delivery.rs:471`). All-or-nothing per the spike's own warning. This is the single highest-value engine change and it is already designed and confirmed.

**Thread 4 — Canonize the docs (cheap, early, compounding).** Archive the four stale generations under supersession banners; harvest binding decisions into one living canon doc; correct CLAUDE.md (v9, HDR-current, add `color_space.rs`); write the one corrected task index. The audit receipts' stale/conflict lists are the work order. This is what kills the "agents re-litigate settled decisions" tax.

**Thread 5 — Renderer strangle (forced by licensing, informed by research).** Prototype maplibre-native vector-basemap export behind the now-decorated golden-frame gate; comment the spike's jitter data on upstream PR #4137 and/or file the small `setGestureInProgress` binding exposure. Meanwhile, in the current renderer: binary WebSocket frame transport, `--force-color-profile=srgb`, fix the fractional-pixelRatio SDF bug and the painterPatch flag asymmetry (no leveling down while two renderers coexist). Design the cross-engine parity gate *before* the swap — it replaces the shared-TS-import guarantee.

**Thread 6 — Rebuild the two true soup zones behind their stable interfaces.** A typed composite IR/dispatcher emitting registry-validated nodes replaces `filtergraph.rs`'s 5× expansion and `mod.rs`'s stringly channels (this is finishing COLOR_PIPELINE_SPEC grills 5-6, not a rewrite), gated by resurrecting the dead `integration_export_parity` (B+C≡A) test. Then the frontend state-layer redesign around the canonical Project object from thread 2.

**Thread 7 — Ship the dependencies.** Own-CI LGPL FFmpeg build (gated on `assert_ffmpeg_has_zscale` + encoder probe against the bundled binary), `nom-exif` replacing ExifTool (parity-tested against the iPhone fixture corpus), renderer per thread 5, notarization release gate, Azure Artifact Signing for Windows.

## 6. Risks to hold in view

- **Wrong-oracle parity**: the byte-equality suites pin known-wrong strings; strangling "to parity" against them faithfully reproduces the bugs. Every re-baseline must be a deliberate, documented act gated on a decoded-frame assertion.
- **Strangler stall**: two in-tree migrations already show the drift pattern (`color.rs`→`color_space.rs` incomplete; v9 stranded on a feature branch). Each strangle needs an explicit completion gate or hybrid decays into the doc-ledger failure mode.
- **The renderer swap silently kills the parity contract** unless the cross-engine gate exists first — the exact divergence class this project exists to prevent.
- **Deferring thread 2 is leveling down shipped users** for architectural purity; the field-eraser is destroying state today.

---

*Receipts index: [`docs/ship-review/README.md`](docs/ship-review/README.md). Review run 2026-06-11, 16 agents, branch `feat/control-panel`.*
