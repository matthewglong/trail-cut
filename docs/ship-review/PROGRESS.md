# Ship-Review Execution — Progress Tracker

**Resume protocol (for a fresh session):** read this file top to bottom, then
read `NEXT ACTION`. The plan is [`ACTION_PLAN.md`](ACTION_PLAN.md); the findings
are [`SHIP_REVIEW.md`](../../SHIP_REVIEW.md). Update this file whenever a phase
advances, a gate is verified, or a decision lands — it is the only
cross-session state. Keep entries terse and dated.

---

## NEXT ACTION

**1) Re-gate Phase 4 eyeball sign-off on real HAND exports (blocking).**
The three `~/Desktop/trailcut-phase4-hdr-eyeball/` artifacts are **INVALID
for map-content/decoration checks** (found 2026-06-12): the throwaway driver
built `project_state` via the unit-test fixture builder
(`__tests__/setupFixture.ts` → `setup_fixture.cjs`), not the real
`exportRequest.ts` path, and substituted `default_pip_layout` 9:16 for the
project's configured layout. Their missing route trail + frozen POV are
harness artifacts — Matthew's hand export through the app shows the trail
correctly. Do NOT eyeball those files again (driver neutralized:
`/tmp/hdr_eyeball_render.rs.phase4-driver.INVALID-fixture-fed`).
Re-gate: Matthew exports HLG/PQ/SDR-H265 by hand through the app and runs
the decision-log #3 checklist on those: map at correct brightness next to
the footage in the HDR files, camera footage NOT darkened/brightened,
decorations/waypoint legible. From the 2026-06-12 partial eyeball of the
invalid files, the checks that exercised the REAL color chain stand as
supporting (not gating) evidence: footage unchanged PASS, rounded-corner
mask PASS, HLG map land bright (anchor fired; 0.722 measurement real).
To re-judge ONLY on hand exports: decoration graininess (route/POV are GL
line/circle layers, waypoints are baked SDF — known Phase 5 lane, not a
Phase 4 blocker unless illegible), PQ encode quality, SDR color cast
(measure ffprobe tags + map-land pixels before trusting screenshots —
EDR screen capture tone-maps), SDR blown highlights (known HDR→SDR
tone-map deferral unless whole image is lifted/milky).

**2) Phase 5 — parallel lanes (Threads 1/5/6/7 + doc lifecycle).** After
sign-off, fan out per ACTION_PLAN §Phase 5: each lane opens with its smallest
tracer slice (Oracle hardening: decorations in the golden-frame fixture +
per-frame paint-seam parity; Renderer strangle: current-renderer quick wins
then maplibre-native prototype; Soup zones: resurrect
`integration_export_parity` first; Ship deps: own-CI LGPL FFmpeg build;
Doc lifecycle: stale map-decorations docs + split-brained task ledgers).
Check the deferred ledger below when opening any lane — Phase 4 added
entries (HDR→SDR tone map, proxy-npl divergence).

## Phase status

| Phase | Status | Evidence / gate |
|---|---|---|
| 0 — Quarantine (attic) | ✅ done 2026-06-11 | See Phase 0 record below |
| 1 — Unstrand engine (Thread 0) | ✅ done 2026-06-11 | See Phase 1 record below |
| 2a — Data-loss fix (Thread 2) | ✅ done 2026-06-11 | See Phase 2a record below |
| 2b — Doc canon (Thread 4) | ✅ done 2026-06-11 | See Phase 2b record below |
| 3 — Tracer oracle (Thread 1 thin) | ✅ done 2026-06-11 | See Phase 3 record below; green CI run 27386190883 with verified red-by-design tracer |
| 4 — HDR port (Thread 3) | ✅ landed 2026-06-11, green CI 27389312554 — ⏳ eyeball gate INVALIDATED 2026-06-12 (fixture-fed artifacts); re-gate on hand exports | See Phase 4 record below + NEXT ACTION |
| 5 — Parallel lanes (Threads 1/5/6/7) | ⬜ pending (gated on Phase 4 sign-off) | Per-lane tracer slices, see ACTION_PLAN |

## Test baseline (canonical, post-Phase-4, on `main` @ acc1ec9)

`npm run test:run` → **928 passed | 7 skipped (935), 0 failed**.
`cargo test` (no skips — the tracer exclusion is GONE) → **374 passed,
0 failed, 1 ignored** (344 lib + 21 color_fixtures + 1 encoder_probe + 2
layout_parity + 2 orchestrator + 4 project_parity). The
`hdr_reference_white_tracer_*` tests are GREEN and run in the main suite;
any failure anywhere is a regression. CI reproduces exactly these counts
(run 27389312554). Note: the suites PANIC (by design) on machines missing
ffmpeg / zscale / renderer bundles — local ffmpeg must be `ffmpeg-full`
(plain brew `ffmpeg` bottle has no libzimg).

## Deferred follow-ups ledger (standing — check when opening any phase)

Every deliberately-deferred item must have a forward owner here; never let one
live only inside a historical phase record.

- **Flush-on-close auto-save drop** (debounced save pending within 1s of
  closing a project is cancelled, edit lost) — owner: Phase 5 Soup-zones lane.
- **`rename_project` non-atomic write** (`std::fs::write`, same hazard class
  Phase 2a fixed for `save_project`) — owner: Phase 5 Soup-zones lane.
- **pip-vs-split seeded-layout divergence** (`App.makeSeededLayouts` seeds
  split, load-path `seededLayouts` seeds pip; preserved verbatim in 2a) —
  owner: Phase 5 Soup-zones lane.
- **docs/ subtree staleness** (`docs/map-decorations/data-model.md` +
  `IMPLEMENTATION-PLAN.md` v8-terminal claims; split-brained task ledgers in
  `docs/export/tasks/` + `docs/migration/`; duplicated body in
  `large-clip-count-composite.md`) — owner: Phase 5 Doc-lifecycle lane
  (added to ACTION_PLAN 2026-06-11).
- **Parity-test `working_color_space` exception** — self-removing: delete the
  exception when a second `WorkingColorSpaceId` variant lands (instructions in
  `src-tauri/tests/project_parity.rs`).
- task 130 sidecar bundling, task 120 parity gate — owned by Phase 5
  Ship-deps / Oracle lanes; also recorded in `docs/CANON.md` §6. (npl=203
  ref-white was RESOLVED by Phase 4; tracer graduation done; the
  `hdr-tracer` job and its chrome-glob stub are deleted with it.)
- **HDR-origin → SDR delivery hard-clips highlights** (working-space values
  >1.0 hit the SDR finishing unclamped-by-tone-map; ~status quo, now
  explicit — CANON §1.12 / §6.1 tail). Proper fix = tone-map operator
  (zscale `tonemap` / BT.2446-A / libplacebo); Matthew confirmed follow-up,
  deliberately NOT in Phase 4. Owner: Phase 5 Oracle lane (first slice: an
  HLG→SDR decoded-frame test that pins today's clip behavior, so the
  tone-map work lands against an oracle).
- **PQ source above ~3200 nit clips at `COMPOSITE_HEADROOM = 32`** (linear
  >32 clips in the composite lift; HDR10 1000-nit masters are fine). Flagged
  in CANON §1.12; revisit with per-export dynamic H or tone-mapping only if
  real PQ footage clips visibly (none in hand). Owner: Phase 5 Oracle lane
  (same slice as above).
- **Proxy/thumbnail npl divergence** (`commands/ffmpeg.rs` WS1/WS2 preview
  chains still linearize HLG@npl=400 / PQ@npl=1000 + Hable tone-map for
  their SDR outputs; the export pipeline is now npl=100 absolute — preview
  brightness of HDR clips can differ slightly from export). Deliberately
  untouched by Phase 4 (work order scoped to the export pipeline). Owner:
  Phase 5 Oracle lane via the task 120 preview≡export parity gate.

## Phase 4 record (landed 2026-06-11 — awaiting Matthew's eyeball sign-off)

- **Commit on `main` (pushed): `acc1ec9`** — the HDR port, A+B+C+D atomic per
  `docs/spikes/IMPLEMENTATION.md`. 9 files: `util/color_space.rs` (npl=100
  absolute working space; `sdr_origin_anchor_gain`, `linear_gain_filter`,
  `COMPOSITE_HEADROOM=32`), `util/color.rs`
  (`map_ingest_filter_for_delivery`), `export/clip_chain.rs`
  (`ClipChainInputs.delivery` + anchor splice), `export/filtergraph.rs`
  (composite anchor/headroom, all 5 branches; Channel B/C explicitly
  SDR-unchanged), `export/delivery.rs` (fix D finishing split),
  `tests/color_fixtures.rs`, `.github/workflows/ci.yml`, `docs/CANON.md`
  (§1.5 updated, §1.12 new DECIDED, §6.1 → RESOLVED), `CLAUDE.md`.
- **Work-order reconciliation (documented divergence from the ACTION_PLAN
  bullet):** ACTION_PLAN §Phase 4 said "npl=203 WORKING_NPL at every HDR
  ingest AND delivery" + "BT.2446-A tone map for SDR targets" — that wording
  predates the spike's final reconciliation. Built to IMPLEMENTATION.md (the
  named work order): **npl=100 absolute working space + ×2.03 SDR-origin
  ingest anchor** (proven byte-equivalent to npl=203; Matthew CONFIRMED
  npl=100, npl=1000 off the table), and HDR→SDR tone map is a
  Matthew-confirmed FOLLOW-UP (deferred ledger above). Consequently
  `delivery_never_emits_npl` was NOT retired — the chosen design keeps
  delivery npl-free, so the pin still encodes a true invariant (comment in
  the test explains this).
- **Gate evidence — green CI run `27389312554`** on `acc1ec9`: single
  `Tests (macOS)` job (the expected-red `hdr-tracer` job is DELETED, the
  `--skip` dropped — graduation forced by its own unexpected-green
  enforcement, exactly as designed). Tracers GREEN: 0.75 HLG / 0.58 PQ
  (±0.02) measured through the production delivery-aware chain (the tracer
  now uses `map_ingest_filter_for_delivery`, which is what the composite
  builder splices).
- **New decoded-frame gates (all loud, zero skips), beyond the tracers:**
  `hdr_video_round_trip_{hlg,pq}_is_identity` (npl=100 round-trip; harness
  verified to have teeth — npl=400 measures 800→597 vs the ±0.015 tolerance,
  i.e. the "camera footage darkened" regression is detectable),
  `sdr_delivery_map_white_stays_at_sdr_white` (anchor gating),
  `composite_chains_verbose_dry_run_no_silent_chroma_downconvert` (every
  composite shape × {SdrH265, HdrHlg, HdrPq} runs the REAL production argv;
  overlay must negotiate 4:4:4 10-bit — the
  feedback_ffmpeg_filter_empirical_validation rule made executable).
- **SDR byte-stability:** ingest + composite chains for SDR delivery are
  byte-identical (existing string pins unchanged + explicit
  `composite_sdr_delivery_emits_no_anchor_and_no_headroom`). ONE deliberate
  SDR change, per the work order's explicit test-change list: the 4:2:0
  finishing now uses the HQ lanczos chroma split (fix D — the pipeline-side
  ~25% decoration-crispness recovery; no resize, flags-only `scale`). So SDR
  output bytes differ in chroma quality only; the "SDR exports
  byte-unchanged" gate phrase was interpreted per IMPLEMENTATION.md and the
  re-baseline is pinned in `delivery.rs` tests.
- **Re-baselined byte-pins, each documented in place:** HDR ingest npl
  strings 400/1000→100 (color_space.rs, color.rs, clip_chain.rs,
  filtergraph.rs tests); HdrPq finishing string + the three
  no-scale-pad finishing tests (now forbid only DIMENSIONED scale/pad and
  pin the split shape).
- **Eyeball artifacts (decision log #3) — INVALIDATED 2026-06-12 for
  map-content checks.** The driver did call the real `render_export_inner` +
  renderer worker + delivery targets/encoders, BUT it built `project_state`
  by piping the project's fields through the unit-test fixture builder
  (`setupFixture.ts` → `setup_fixture.cjs`) instead of the real
  `exportRequest.ts` path, and used `default_pip_layout` 9:16 instead of the
  project's configured layout. Result: route trail missing + POV frozen in
  the artifacts — harness artifacts, NOT product bugs (Matthew's hand export
  through the app shows the trail). Still-valid signals from these files:
  color-transform chain was real — HLG map-inset 0.722 vs 0.75 graphics
  white (pre-fix ~0.60), tags arib-std-b67/bt2020/bt2020nc correct, footage
  unchanged, corner mask clean. Sign-off re-gated on hand exports (see NEXT
  ACTION). Driver renamed to
  `/tmp/hdr_eyeball_render.rs.phase4-driver.INVALID-fixture-fed`; if a
  reproducible artifact generator is ever wanted, it must build
  `project_state` via the real `exportRequest.ts` path.
- **Known bounds shipped-and-flagged (CANON §1.12):** HDR→SDR highlight
  clipping (tone-map follow-up), PQ >3200 nit at H=32, proxy-npl divergence
  — all in the deferred ledger with owners.

## Phase 3 record (done 2026-06-11)

- **Commits on `main` (pushed to origin — push approved for this phase):**
  `60a4c9a` (tracer test + loud-skip conversions + CI workflow), `9f7ad36`
  (ffmpeg-full provisioning + CLAUDE.md dev-deps fix), `97897b5` (chrome-glob
  stub + tracer-report hardening), `b44ae9a` (renderer-sidecar provisioning
  for orchestrator tests).
- **Gate met — evidence: green CI run `27386190883`**
  (https://github.com/matthewglong/trail-cut/actions/runs/27386190883):
  `Tests (macOS)` job green (Vitest 928/7 + cargo 356/0/1, identical to
  local); `hdr-tracer` job green with the loud "HDR tracer RED (expected)"
  warning annotation, grep-verified against the actual BT.2408 assertion
  text (a build failure can no longer masquerade as the expected red — that
  false positive happened on run 27385745706 and is now a hard job failure).
- **Tracer oracle** (`hdr_reference_white_tracer_{hlg,pq}` in
  `src-tauri/tests/color_fixtures.rs`): pure-white map frame →
  `map_ingest_filter()` → `delivery_finishing_filter(target)` → the encoder
  `select_encoder_for_target` actually picks → decode → central-region luma
  vs BT.2408 reference white (0.75 HLG / 0.58 PQ ±0.02). **Red-by-design:
  measures 0.630 HLG / 0.509 PQ** — exactly CANON §6.1's diagnosed npl=203
  defect ("~62% HLG"). Never `#[ignore]`d; runs visibly in CI's dedicated
  `hdr-tracer` job (allowed to fail with annotation; goes RED itself on
  unexpected-green or non-documented failure).
- **Zero silent skips**: `golden_frame_parity.rs` now panics without
  `TRAILCUT_CHROME_BIN` (was return-green); both `ffmpeg_runner.rs` tests
  panic without ffmpeg (were eprintln+return). CANON §1.11 / §6.3 updated.
- **Also fixed en route**: pre-existing compile break in the feature-gated
  golden-frame tests (`SetupPayload.readback` added in Phase 1; fixture
  predates SSAA → `readback == framebuffer`); CLAUDE.md's wrong
  `brew install ffmpeg` dev instruction (core bottle has no libzimg —
  proven by CI run 27385616028; correct formula is `ffmpeg-full`).
- **CI shape** (`.github/workflows/ci.yml`): macOS runner, every push + PR.
  Provisioning: `ffmpeg-full` (keg-only → GITHUB_PATH) + exiftool via brew,
  fail-fast zscale assert, Node 22 + npm ci, stable Rust + rust-cache,
  `npm run build:renderer` (renderer bundles + pinned Chrome for Testing —
  the orchestrator integration tests drive the real chromium worker and
  PASS on the runner, incl. real OpenFreeMap tile fetches).

## Phase 2a record (done 2026-06-11)

- **Branch `fix/data-loss-save`, commit `e41c675`, merged to main `2be86ae`.**
  10 files: new `src/lib/projectPersistence.ts` (canonical module:
  `hydrateProjectState` / `buildSavePayload` / `mergeMapSettings` moved from
  useProject incl. the `full_width→width` shim), rewritten `useAutoSave.ts`,
  `useProject.ts` load path, `App.tsx` (owns `baseProject` + `saveError`),
  `commands/project.rs` (atomic save), new `util/fs.rs::write_atomic` (temp
  file same dir + fsync + rename, +3 tests), `models.rs` (vestigial
  `Project.version` now `#[serde(default)]`), new shared fixture
  `src-tauri/tests/fixtures/project_parity.json` + `tests/project_parity.rs`
  (4 tests) + `src/lib/__tests__/projectPersistence.test.ts` (13 tests).
- **Canonical payload**: App holds the full deserialized `Project` as loaded
  (`baseProject`); save = spread base, overlay only the 10 live-edited
  fields. `working_color_space` / `start_camera` / `default_entry_transition`
  / unknown future fields ride the spread untouched. `baseProject` is also
  the arming switch: auto-save refuses to run pre-hydration (kills
  overwrite-with-empty hazard) and the `clips.length === 0` guard is gone, so
  removing the last clip persists.
- **Parity test**: fixture populates every persisted field non-default; Rust
  side does per-key exact round-trip + real load→save tempdir round-trip
  (extra/missing keys fail by name; fixture `schema_version` asserted ==
  `CURRENT_SCHEMA_VERSION` so bumps force re-authoring); TS side runs the
  fixture through the real hydrate→buildSavePayload path with deep equality +
  `PROJECT_WIRE_KEYS satisfies Record<keyof Project, true>` compile-time
  exhaustiveness. Documented exception: `working_color_space` (single-variant
  enum, `skip_serializing_if` always drops it; delete exception when a second
  working space lands).
- **Save errors surface** in the shared error banner (same as import errors)
  in both ProjectView and HomeScreen; self-clears on next successful save.
- **Verified**: both suites green on main post-merge (counts above);
  independent sonnet audit of the full diff: **PASS on all six gate items**
  (canonical payload, no premature save, atomic write, loud errors, parity
  fails loud with no silent skips, no regression risk; migration chain
  untouched).
- Known follow-ups (pre-existing, deliberately not done here): flush-on-close
  for a debounced save pending within 1s of closing a project;
  `rename_project` still uses non-atomic `std::fs::write`; pip-vs-split
  seeded-layout divergence preserved verbatim.

## Phase 2b record (done 2026-06-11)

- **Branch `docs/canon`, commits `b7c34bf` (harvest + CLAUDE.md) → `72b3034`
  (quarantine) → `53883ee` (staleness flag), merged to main `95a0df5`.**
- **`docs/CANON.md` created** (~540 lines, the living decision canon): §1
  color pipeline (9 DECIDED + 2 BINDING), §2 map rendering (2 DECIDED + 2
  BINDING), §3 export (2 DECIDED), §4 gems (8 BINDING), §5 rejected (8
  anti-decisions incl. dither debunk, SDR simplification, npl=1000-on-delivery,
  literal pixel_ratio=2.0), §6 open items (npl=203 ref-white, task 130
  sidecar bundling, task 120 parity gate, EXPORT_GAPS pointer), §7 references
  (PIPELINE_RESEARCH §7 bibliography + UWSR [1]–[27] verbatim). Totals: 13
  DECIDED, 12 BINDING, 8 REJECTED, 4 OPEN.
- **CLAUDE.md corrected**: v8→v9 at 3 sites; HDR bullet → "first-class and
  CURRENT" with all five DeliveryTargets shipped; `color_space` added to
  util/ listing; design-docs section now points at CANON.md as canon +
  color-authority statement + `docs/spikes/`; stale `feat/control-panel`
  branch mention dropped.
- **Harvest-then-quarantine order held**: only after CANON.md+CLAUDE.md were
  committed were the five stale docs (PIPELINE_RESEARCH, PIPELINE_DECISIONS,
  PIPELINE_TEACHING_HANDOFF, COLOR_PIPELINE_SPEC,
  UNIVERSAL_WORKING_SPACE_REPORT) moved to `attic/superseded-docs/`
  (deletions staged; content recoverable from git history; attic copies
  restored in the main checkout via `git show 0eaf709:<file>`).
- **Gate verified by a FRESH sonnet agent given only CLAUDE.md + CANON.md**:
  answered schema = v9, HDR = shipped/current (HdrHlg + HdrPq co-equal),
  color authority = `util/color_space.rs` + `docs/color-pipeline/` +
  CANON §1 — all correct, zero contradictions found. Independent haiku
  contradiction scan: **PASS** (no live references to the five moved docs;
  no v8-as-current or HDR-near-term claims in reachable docs; the five files
  gone from `git ls-files`). Known residual, by design: `docs/map-decorations/
  data-model.md` + `IMPLEMENTATION-PLAN.md` still say "v8 terminal" — that doc
  set is a later phase's scope, flagged stale in CANON's pointer.
- Phase 1 backups (`/tmp/trailcut-pre-phase1.patch`,
  `/tmp/color_space.rs.phase1-backup`) are now disposable (sandbox denies
  `rm`; left in /tmp for OS cleanup).

## Phase 1 record (done 2026-06-11)

- **Commit A (engine) `b5ce396`** — color-space registry (`color_space.rs`,
  551 lines), schema v8→v9 (`models.rs` + migration in `commands/project.rs`),
  `hdr_pq` delivery target, SSAA map supersampling (`readback` field through
  protocol.rs / export/mod.rs / sidecar), util/color.rs, all export/*, both
  Rust test files, v9 hunks of `types.ts`, `exportFilenames.ts`, setupFixture
  (readback + waypoints). 20 files.
- **Commit B (control-panel UI) `2f63d90`** — `outlineThicknessCanvasPx`
  moved into mapVisuals/shapes.ts, page-side SDF shape-icon rasterization in
  the renderer (kills the >100MB CDP atlas payload; export now honors user
  stroke width), DEFAULT_MAP_SETTINGS size bumps, DecorationPanel stepper max
  120, ExportChip HLG/PQ tokens + **stale test fixed** (`'4K·30·HDR'` →
  `'4K·30·HLG'`, PQ case added). 10 files.
- Hunk triage of the mixed files (`types.ts` 6/9 hunks→A, sidecar `index.ts`
  3/7→A, `page/init.ts` 4/7→A) done via filtered patches + `git apply
  --cached`; `MapView.tsx` turned out pure UI (wholesale B).
- Verified: Commit A tested in isolation (B tail stashed): cargo 349/0,
  Vitest 915/0 — the ExportChip test only goes stale once B's HLG token
  lands, so A is green standalone. After B: both suites green (above).
  Independent sonnet audit: **PASS** — no UI hunks in A, no engine hunks in
  B, A+B reproduce the pre-split tree exactly (27 files incl. the test file).
- **Merged `feat/control-panel` → `main` (fast-forward to `2f63d90`)**; gate
  re-verified on main: `CURRENT_SCHEMA_VERSION = 9` (models.rs:978),
  color_space.rs present, both suites green, `git status` clean.
- Backups (delete when Phase 2 lands): `/tmp/trailcut-pre-phase1.patch`,
  `/tmp/color_space.rs.phase1-backup`.

## Phase 0 record (done 2026-06-11)

- `attic/` created (gitignored; Claude denied via `.claude/settings.json`
  `Read(./attic/**)` deny). Layout in `attic/README.md`.
- Rescued to `docs/spikes/` (committed): IMPLEMENTATION.md (HDR port build spec),
  PORT_DESIGN.md, FINDINGS.md, SESSION4_FINDINGS.md, HANDOFF.md,
  native-gl-jitter-handoff.md. `SHIP_REVIEW.md` links updated `.spike/` →
  `docs/spikes/`.
- Swept to attic: `.spike/` remainder (~1.4GB → `attic/spike-artifacts/spike/`),
  8 concept HTMLs + `Untitled.md` (were tracked; deletions staged, recoverable
  from git history), `scratchpad.html`, `map-sampling-explorer.html`.
- Committed: SHIP_REVIEW.md, docs/ship-review/ (15 receipts + ACTION_PLAN.md +
  this file), docs/spikes/, .claude/settings.json, .gitignore, CLAUDE.md
  pointers, stale `.playwright-mcp` deletions.
- Verified: haiku ref-scan found no live code references to moved files (one
  provenance comment in `LayoutPreview.tsx:349`, left as-is); Vitest before ==
  after (1/914/7); residual `git status` is exactly the Phase 1 input.
- Note for future sessions: the Bash sandbox denies compound/glob `mv` chains
  and anything containing `rmdir`/`rm` — use single absolute-path `mv` per call.

## Session log

- **2026-06-11** — Ship review produced (16-agent run). ACTION_PLAN.md authored;
  three open decisions resolved (style-guide→attic, merge-all-to-main,
  HDR sign-off = eyeball checklist backed by pixel gate). Phase 0 executed.
- **2026-06-11** — Phase 1 executed: working tree split into engine commit
  `b5ce396` + UI commit `2f63d90`, both audited clean (sonnet PASS);
  `feat/control-panel` fast-forward-merged to `main`; both suites fully green
  on main; gate verified. Next: Phases 2a + 2b as parallel agents.
- **2026-06-11** — Phases 2a + 2b executed as parallel worktree agents off
  main `0eaf709`. 2a (`e41c675` → merge `2be86ae`): canonical save payload,
  atomic writes, loud save errors, TS↔Rust project parity test; suites
  928/7/0 + 356/0 on main; sonnet audit PASS (all 6 gate items). 2b
  (`b7c34bf`..`53883ee` → merge `95a0df5`): docs/CANON.md harvested from the
  five stale pipeline docs, CLAUDE.md drift fixed (v9, HDR current), docs
  quarantined to attic/superseded-docs/; fresh-agent gate quiz PASS, haiku
  contradiction scan PASS. Next: Phase 3 — tracer oracle (Thread 1 thin
  slice).
- **2026-06-11** — Phase 3 executed: red-by-design HDR reference-white tracer
  (`hdr_reference_white_tracer_{hlg,pq}`, measured 0.630/0.509 vs 0.75/0.58),
  three silent skips → loud panics, GitHub Actions CI on every push (macOS,
  ffmpeg-full + exiftool + renderer sidecar provisioned). Four pushes to get
  CI green — each failure was the loud-failure machinery working: run
  …616028 caught brew `ffmpeg` shipping without libzimg (→ ffmpeg-full +
  CLAUDE.md fix), …745706 caught the empty chrome bundle-resources glob AND
  a tracer false positive (build failure masqueraded as expected-red → report
  step now grep-verifies the BT.2408 assertion), …966063 caught the missing
  renderer bundles (→ provision via build:renderer, orchestrator tests drive
  real Chrome on the runner). **Green: run 27386190883** — gate met, zero
  silent skips, tracer visibly red for the documented reason. Also fixed
  pre-existing integration_export compile break (SetupPayload.readback).
  Next: Phase 4 — HDR port (Thread 3), work order docs/spikes/
  IMPLEMENTATION.md, gated on the tracer flipping green.
- **2026-06-11** — Phase 4 executed: HDR port landed atomically on `main`
  (`acc1ec9`, pushed): npl=100 absolute working space (A), ×2.03 SDR-origin
  BT.2408 anchor at ingest (B — implemented per IMPLEMENTATION.md, NOT the
  ACTION_PLAN's stale "npl=203 on delivery" wording; equivalence proven),
  HDR-gated ÷32/×32 composite headroom (C), HQ lanczos chroma subsample in
  4:2:0 finishing (D). Phase 3 tracers flipped GREEN (0.75/0.58) and
  graduated into the main CI job; the expected-red `hdr-tracer` job deleted
  — its unexpected-green enforcement fired exactly as designed. New
  decoded-frame gates: HLG/PQ round-trip identity (instrument verified
  against npl=400: 800→597), SDR map-white pin, verbose dry-run over every
  composite shape × target (4:4:4 overlay negotiation). Suites: Vitest
  928/7, cargo 374/0/1 with zero skips; green CI run 27389312554.
  `delivery_never_emits_npl` deliberately KEPT (still true under the chosen
  design — documented in the test). Three "Abel's Hike" exports rendered to
  `~/Desktop/trailcut-phase4-hdr-eyeball/` for the decision-log #3 eyeball
  checklist (HLG map-inset measures 0.722 vs 0.75 graphics white). STOPPED
  for Matthew's sign-off; Phase 5 fans out after.
- **2026-06-12** — Phase 4 eyeball gate INVALIDATED: Matthew's eyeball of the
  Desktop artifacts showed missing route trail + frozen POV + grainy
  decorations; his hand export through the app showed the trail fine.
  Provenance traced: the throwaway driver fed `project_state` through the
  unit-test fixture builder (`setupFixture.ts`) and a default 9:16 PiP
  layout, not the real `exportRequest.ts` path — so the artifacts
  misrepresent the product for all map-content/decoration checks. Record
  corrected (NEXT ACTION + Phase 4 record), driver renamed `.INVALID-*`.
  Eyeball checks that exercised the real color chain held: footage
  unchanged, corner mask clean, HLG map land bright. Decoration graininess
  (route/POV = GL layers vs waypoints' baked SDF) confirmed as a real
  pre-existing gap but stays Phase 5 renderer-lane scope, NOT a Phase 4
  blocker. Sign-off re-gated on hand exports of all three targets.
