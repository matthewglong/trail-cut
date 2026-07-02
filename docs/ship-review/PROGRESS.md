# Ship-Review Execution — Progress Tracker

**Resume protocol (for a fresh session):** read this file top to bottom, then
read `NEXT ACTION`. The plan is [`ACTION_PLAN.md`](ACTION_PLAN.md); the findings
are [`SHIP_REVIEW.md`](../../SHIP_REVIEW.md). Update this file whenever a phase
advances, a gate is verified, or a decision lands — it is the only
cross-session state. Keep entries terse and dated.

---

## NEXT ACTION

**1) Re-probe the composite seam — fix C′ eyeball FAILED 2026-07-01 on PQ
temporal crawl.** fix C′ (PQ transport curve) is WRITTEN in the working tree
(uncommitted) and both suites are green, but it is NOT landed and Phase 4 is
NOT closed. Matthew hand-exported HLG + PQ (2026-07-01) and the HDR map
still shimmers: **flat decoration colors crawl/sparkle frame-to-frame, PQ
worse than HLG.** fix C′ DID fix the *static* defect (ramp 66→256 distinct
levels, hue 12.5°→≤0.33°) — but the gate that proved that
(`composite_pq_transport_ramp_retains_distinct_levels` + the hue gate) is
**single-frame only**; it is blind to temporal stability, so it went green
while the crawl survived. **Working hypothesis (to MEASURE, not assume):**
PQ's steep low-end OETF slope — the same steepness that bought back the
distinct levels — *amplifies* a sub-LSB frame-to-frame wobble in the
renderer's flat fill (AA against the panning basemap) into a visible
multi-code swing; HLG's gentler curve amplifies less → PQ worse.
**Action:** build a TEMPORAL probe (N frames of a flat decoration patch
through the real PQ/HLG/SDR composite argv → per-pixel temporal std-dev in a
flat region; expect PQ≫HLG>SDR≈0), stage the decode to pin the injector
(before transport / after transport / after 4:2:0 finishing), then choose
the fix (dead-band/quantize before transport, gentler transport shaping, or
stabilize the renderer flat fill upstream). That probe becomes the missing
TEMPORAL gate so nothing can go green while still crawling. Do NOT commit
fix C′ as landed or touch the CANON/PROGRESS "closed" wording until the
temporal gate is green. This is a COLOR-seam bug, NOT the renderer —
decoration crispness + any native-renderer work stay Phase 5 renderer-lane
scope and cannot fix this crawl.

**fix C′ landed — record (2026-06-12):** `color_space.rs` —
`COMPOSITE_HEADROOM` removed; `composite_transport_encode()`
(`zscale=t=smpte2084`) + `composite_transport_decode()`
(`zscale=tin=smpte2084:t=linear:npl=100`, npl tied to
`default_npl_for(Pq)`) added. `filtergraph.rs` — `down`/`up` now splice the
PQ encode/decode (same HDR-only gate, same splice points, all 5 branches
untouched in structure); load-bearing comment block rewritten. Tests:
`linear_gain_filter_decompositions` dropped the obsolete ÷32/×32 cases (kept
the ×2.03 anchor); new `composite_transport_round_trip_strings` byte-pin;
the composite HDR string test renamed →
`…wraps_lifts_in_pq_transport` (asserts every lift is PQ-encode-wrapped + no
`colorchannelmixer=rr=0.03125` survives); the SDR negative renamed →
`composite_sdr_delivery_emits_no_anchor_and_no_transport` (asserts no
`zscale=t=smpte2084,format=yuva444p10le` / decode on SDR — byte-stable).
NEW decoration-fidelity decoded-frame gates in `color_fixtures.rs`:
`composite_pq_transport_ramp_retains_distinct_levels` (≥250/256 through the
real PQ sandwich; teeth verified — old ÷32 sandwich measures 66) +
`composite_pq_transport_preserves_decoration_hue` (<1° on the three probe
colors). Empirically validated with a `-loglevel verbose` dry-run (overlay
still negotiates 4:4:4 10-bit — no silent scaler). Probe artifacts:
`/tmp/hdr-grit-probe/`.

**2) Hand-export re-gate results 2026-06-12 (decision-log #3) — record:**
PASS: HDR footage identical to source (both HLG+PQ — the atomic-landing
risk held), corners decent, no banding, motion clean on SDR. FAIL: HDR map
hue wrong + gritty + shimmery in both HLG/PQ (root cause above, fix C′).
Surfaced, known-deferred: SDR delivery of HDR-origin footage is BLOWN OUT —
Matthew flags it as "not in a good state"; it's the HDR→SDR tone-map
deferral (ledger below) — bump it to the FIRST slice of the Phase 5 Oracle
lane. Decoration crispness (route/POV GL layers vs waypoints' baked SDF)
remains Phase 5 renderer-lane scope; re-judge after C′ lands since the
quantization grit currently masks it.

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
| 4 — HDR port (Thread 3) | ⚠️ NOT closed. HDR port landed `acc1ec9`; static-quantization FAIL → fix C′ (PQ transport) WRITTEN but UNCOMMITTED, suites green; re-eyeball 2026-07-01 FAILED on PQ flat-color temporal crawl — static gate is blind to it. Re-probing composite seam for temporal amplification (see NEXT ACTION). | See Phase 4 record + fix C′ record + session log |
| 5 — Parallel lanes (Threads 1/5/6/7) | 🟨 renderer-strangle lane DONE 2026-07-02 (native cutover complete, chrome stripped — see session log + CANON §2.5); other lanes pending | Golden gate `golden_frame_parity_native` + PRODUCTION_WORKER_GATES.md + hand-export pass; other lanes: per-lane tracer slices, see ACTION_PLAN |

## Test baseline (canonical, post-cutover `8110f70` + fix C′ in the working tree)

`npm run test:run` → **928 passed | 7 skipped (935), 0 failed** (frontend
untouched by fix C′ and the cutover).
`cargo test` (no skips) → **381 passed, 0 failed, 1 ignored** (346 lib +
23 color_fixtures + 1 ignored + 1 encoder_probe + 2 layout_parity + 4
orchestrator + 4 project_parity + 1 native_hdr_composite). Includes fix C′
(uncommitted: lib +1 `composite_transport_round_trip_strings`,
color_fixtures +2 `composite_pq_transport_*`); the cutover removed the two
chrome-path resolution tests and kept the 4 orchestrator e2e tests
(default-path n1/n2 + explicit-pin native_n1/n2, all native now). The
`hdr_reference_white_tracer_*` tests stay GREEN; any failure anywhere is a
regression. `npm run test:renderer` → **18 passed** (backendSelect,
tileCache units + protocol/tileCacheKeyParity process-level on native).
Golden gate (`cargo test --features integration_export --test
golden_frame_parity`) → 1 passed, native-only. Note: the suites PANIC (by
design) on machines missing ffmpeg / zscale / renderer bundles / the
staged mbgl-native binding — local ffmpeg must be `ffmpeg-full` (plain
brew `ffmpeg` bottle has no libzimg).

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
  deliberately NOT in Phase 4. **2026-06-12: Matthew eyeballed the real SDR
  export of HDR-origin footage as "blown out / not in a good state" — bump
  to the FIRST slice of the Phase 5 Oracle lane.** Owner: Phase 5 Oracle
  lane (first slice: an HLG→SDR decoded-frame test that pins today's clip
  behavior, so the tone-map work lands against an oracle).
- ~~**PQ source above ~3200 nit clips at `COMPOSITE_HEADROOM = 32`**~~ —
  **RETIRED 2026-06-12 by fix C′.** `COMPOSITE_HEADROOM` is gone; the PQ
  transport curve covers linear 0–100 (10,000 nits) with no headroom
  constant, so the bound is now PQ's own 10k-nit format ceiling. No further
  action.
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
- **2026-06-12 (later)** — Hand-export re-gate run by Matthew: HDR footage
  identical to source (PASS — the atomic-landing risk held), corners PASS,
  no banding, SDR map/decorations true to preview; but HDR map in BOTH
  HLG+PQ has wrong decoration hue + grit + temporal shimmer (PQ worst), and
  SDR-of-HDR-footage blown out (known tone-map deferral, flagged as bad).
  Root cause FOUND + PROVEN empirically (ffmpeg probes in
  `/tmp/hdr-grit-probe/`, production filter strings): fix C's ÷32 linear
  headroom runs before the `format=yuva444p10le` overlay lift, quantizing
  the anchored map (linear 0–2.03) into the bottom 6.3% of the 10-bit range
  in LINEAR light — ramp collapses 256→66 distinct levels; flat decoration
  colors shift hue up to 12.5° (red) / 3.8° (green). Footage spans ~77% of
  the range + sensor noise dithers → looks fine; SDR has no ÷32 → fine.
  Candidate fix VALIDATED in the same probes: PQ transport curve around the
  lift (`zscale=t=smpte2084` … `zscale=tin=smpte2084:t=linear:npl=100`,
  HDR-gated like today) → 256/256 levels, hue delta ≤0.33°, SDR
  byte-identical, retires the PQ>3200-nit headroom bound. Scoped as fix C′
  in NEXT ACTION; awaiting Matthew's go to implement.
- **2026-06-12 (fix C′ landed)** — Replaced fix C's linear ÷32/×32 composite
  headroom with the PQ transport curve. `color_space.rs`: removed
  `COMPOSITE_HEADROOM`, added `composite_transport_encode`/`_decode` (npl
  tied to `default_npl_for(Pq)`=100). `filtergraph.rs`: `down`/`up` now
  splice the PQ encode/decode — identical HDR-only gate, splice points, and
  5-branch structure; comment block rewritten. Re-pinned the composite
  string tests; added two decoded-frame fidelity gates in `color_fixtures.rs`
  (`composite_pq_transport_ramp_retains_distinct_levels` ≥250/256;
  `composite_pq_transport_preserves_decoration_hue` <1°). Teeth confirmed by
  a standalone probe: the OLD ÷32 sandwich measures 66 distinct levels, the
  new PQ sandwich 256, pure-float ref 256. Empirically validated with a
  `-loglevel verbose` dry-run (overlay still negotiates 4:4:4 10-bit, no
  silent scaler). Suites: Vitest 928/7/0 (untouched), cargo 377/0/1 (lib +1,
  color_fixtures +2). CANON §1.12 amended (C→C′, history block, PQ>3200
  bound retired); §6.1 pointer updated; deferred-ledger PQ>3200 entry struck.
  STOPPED for Matthew to re-eyeball HLG+PQ hand exports.
- **2026-07-01 — re-eyeball FAILED; fix C′ NOT committed; suites re-confirmed
  green on resume.** Session resumed after the Fable outage. Confirmed fix C′
  is uncommitted in the working tree (` M` on color_space.rs, filtergraph.rs,
  color_fixtures.rs, CANON.md, PROGRESS.md — nothing staged). Re-ran both
  suites on the working tree: Vitest 928/7/0, cargo 377/0/1 — fix C′ verified
  green. Matthew hand-exported HLG + PQ through the real app path and
  eyeballed: HDR map still shimmers — **flat decoration colors crawl,
  PQ worse than HLG** (characterization confirmed via question). Diagnosis:
  the static ramp/hue gate is blind to temporal stability, so fix C′ fixed
  the banding but not the crawl. Held all commits (per Matthew). Recorded the
  failure + re-probe plan in NEXT ACTION item 1. Also spun up a parallel
  Fable session on the SEPARATE Phase 5 renderer-strangle lane (native
  maplibre prototype on the VECTOR basemap; satellite/raster snap flagged as
  the OPEN case, not solved) — handoff brief written; that lane cannot and
  must not be expected to fix this color-seam crawl. Next: temporal probe +
  seam localization (this session, color lane).
- **2026-07-02 — renderer-strangle lane: native-gl jitter spike EXECUTED
  (measured, not inherited).** The prior Fable session died right after env
  setup; this session ran the full spike per
  `docs/spikes/native-gl-jitter-handoff.md`. **Vector: GO** — native residual
  RMS 0.0056 px vs GL JS baseline 0.0040 px on the identical 150-pose
  sub-pixel 4K pan (bar: 0.10); re-confirmed 9:16 (0.0060); crispness native
  ≥ GL JS everywhere. **Satellite/raster: NO-GO as shipped, but localized
  with no core fork needed** — RMS 0.93 px sawtooth (±0.5 CSS px, period 3.1
  fr) from `raster_layer_tweaker.cpp:97` `aligned=!state.isChanging()`,
  always-false in the node binding's still renders. Mechanism proven 3 ways
  (amplitude+period prediction match; integer-px falsification collapses
  residual 3,400×; GL JS unpatched reproduces the identical 0.9345 signature).
  Reachable switch `Map::setGestureInProgress(bool)` is public core API
  already in the shipped binary — fix = ~15-line node-binding patch /
  upstream PR; patched-native satellite end state deliberately left
  UNMEASURED (no "smooth now" claim) pending a from-source binding build.
  Receipts: `.spike/native-gl/VERDICT.md` + `jitter-report.md` + videos.
  Color-seam lane untouched by design.
- **2026-07-02 (cont.) — satellite fix BUILT AND MEASURED: GO.** Built the
  node binding from source at the same tag (`node-v6.4.1`, upstream preset
  `macos-metal-node`; from-source build is ~5 min wall, and renders
  byte-identical to the shipped prebuilt — knob-off jitter stats match to
  12+ digits) with `expose-setGestureInProgress.patch` (53 lines,
  `platform/node/src/node_map.{cpp,hpp}` only, zero core changes; verified
  to also apply clean to node-v6.5.0-pre.1). A/B on the identical harness:
  raster gesture-ON **RMS 0.0795 px** (bar 0.10; statistically = the GL JS
  patched-raster 0.0830 our shipped renderer produces for satellite today),
  vector unchanged (0.00558), no static crispness penalty (Sobel 113.4 vs
  shipped GL JS 116.1). Production route + integration contract:
  `.spike/native-gl/PRODUCTION_PATH.md` (prefer upstream PR — not posted,
  Matthew's call; interim fork rides upstream's node-release.yml prebuilt
  matrix incl. win32). Both native viability gates (speed 57×, jitter) now
  green on macOS; full strangle still needs protocol port + cross-engine
  golden-frame parity gate + HDR-through-native (unstarted).
- **2026-07-02 (cont. 2) — renderer-strangle lane: MECHANICAL-CORRECTNESS GATE
  RUN — GO.** Full write-up + numbers: `.spike/native-gl/MECHANICAL_VERDICT.md`.
  Reference-free/ground-truth only; golden frames deliberately NOT seeded
  (color lane unresolved — no approved look exists to snapshot).
  **(1) Temporal on real content:** decorations driven through the REAL
  `mapVisuals` surface (esbuild bundle of `resolveStaticPaints` /
  `buildPerFrameState` / `buildAllShapeIcons` / `compileTimeline`; per-frame
  translation copied verbatim from renderer/index.ts) — decorated vector RMS
  **0.0056** px (= bare basemap; decorations add zero jitter), decoration-only
  symbol-isolation **0.0146** (a symbol snap would be 50× larger — none),
  decorated satellite **0.0665** (= shipped GL JS level 0.0688), bearing
  **0.0858** / zoom **0.0120** / pitch-45 **0.0057** — all under the 0.10 bar,
  no sawtooth anywhere. POV marker centroid pixel-stationary at exact buffer
  center across the pan (both styles). **(2) Colorimetric readback contract:**
  native buffer = 8-bit RGBA, sRGB-encoded, 14/14 style literals BIT-EXACT,
  PREMULTIPLIED alpha, gamma-space blending, ratio-invariant — and GL JS
  gl.readPixels is byte-identical on every probe → CANON §1 ingest anchor
  carries over with NO contract change. **(3) Semantic parity:** lever model
  holds exactly on native (aspect: bit-identical decoration bboxes, centroid
  shift = exact viewport delta; resolution: 2.0× bbox scaling, ≤0.3 px CSS
  agreement); cross-engine icon placement agrees to ≤0.05 CSS px; the
  "dashed green trail absent in GL JS" crispness-crop claim was WRONG —
  root-caused to liberty `park` `fill-outline-color` hairline drawn in BOTH
  engines pixel-aligned, GL JS at ~54% amplitude (thin-line AA, a look-lane
  question). **Divergences found (all root-caused, none blocking):** (a)
  translucent CIRCLE layers draw once per overlapping tile in native
  (n=2 in tile-buffer bands, n=4 at corners; brightness pops G 138→192 at
  band crossings — invisible to jitter oracles; POV pulse/halo affected) —
  **mitigation VALIDATED: `buffer: 0` on point sources → n=1, circle complete**;
  (b) native rejects the app's empty-LineString placeholder (normalize to
  empty FeatureCollection); (c) port contracts: NO GeoJSON setData (per-frame
  remove/re-add measured jitter-free), addImage 1024-texel cap → SDF icons
  break at pixelRatio>8, addImage takes (id, Buffer, {w,h,pixelRatio,sdf}).
  Unmeasured, listed in the verdict: Windows/ANGLE, golden frames (deferred to
  look approval), production-protocol speed, dense-label collision parity,
  3D buildings, HDR composite fed by native frames. Color-seam lane untouched.
- **2026-07-02 (cont. 3) — renderer-strangle lane: PRODUCTION PORT LANDED
  (backend split + native backend), all reference-free gates GREEN; awaiting
  Matthew's hand-export eyeball (gate d) + cutover sign-off.** The worker
  (`sidecars/renderer/index.ts`) is now a protocol shell over two backends
  behind one interface: `chromeBackend.ts` (extracted verbatim, still the
  DEFAULT) and `nativeBackend.ts` (mbgl in-process, all five port contracts
  implemented — gesture knob mandatory/loud, buffer:0 on live-marker AND
  waypoints, empty-LineString normalization at the native boundary,
  stacking-order-preserving remove/re-add source refresh (binding addLayer
  has no beforeId — rebuilds the decoration stack from the lowest changed
  source up), pixelRatio≤8 addImage guard). Engine-agnostic per-frame
  translation extracted to `scene.ts` (consumed by BOTH backends — parity by
  shared derivation). SSAA on native = worker-side exact integer box filter,
  premultiplied gamma space, documented in `nativeBackend.ts` + CANON §2.5
  (map alpha measured 255 everywhere on both backends; corner mask owns
  alpha downstream, so premult-vs-straight has zero exposure).
  Backend select: `TRAILCUT_RENDERER_BACKEND=chrome|native` (typos fail
  loud); Rust `OrchestratorConfig.renderer_backend` pins per-worker for
  tests; `TRAILCUT_MBGL_NATIVE_DIR` resolved orchestrator-side like chrome.
  Binding: patch vendored at `sidecars/renderer/native/` +
  `ensure-binding.mjs` (verify-or-build-from-source, staged at
  `src-tauri/binaries/mbgl-native-<triple>/`, wired into build:renderer +
  CI with cache; upstream PR still NOT posted — draft package written to
  `.spike/native-gl/UPSTREAM_PR_DRAFT.md` for Matthew's call).
  **Gates (receipts: `.spike/native-gl/PRODUCTION_WORKER_GATES.md`):**
  (a) suites green both backends — Vitest 928/7/0, cargo **383**/0/1
  (+5 orchestrator/native tests incl. 2 native e2e integration tests that
  panic loudly without the binding; +1 native HDR gate), renderer vitest
  25/25; (b) spike oracles re-run THROUGH the production worker — jitter
  vector 0.0188 / satellite 0.0686 px RMS (bar 0.10, production recycle
  cadence exercised, no sawtooth), colorimetry byte-pins exact (literals +
  alpha=255 through the native SSAA downsample), placement ≤0.03 CSS px
  native-vs-chrome, lever invariance exact (bit-identical bboxes across
  aspect; exact 2× across resolution); waypoints buffer:0 symbol-placement
  probe PASS (0.000 px icon shift; halo double-draw reproduced at default
  buffer G=195, fixed at buffer:0 G=135); (c) HDR through native —
  `tests/native_hdr_composite.rs` (ungated, loud preconditions) drives the
  REAL `render_export_inner` composite argv with native map frames for
  SdrH265/HdrHlg/HdrPq: white anchors measured 1.0137 / **0.7511** /
  **0.5822** vs 1.0 / 0.75 / 0.58 expected. Golden frames still deliberately
  NOT seeded (color lane unresolved). **Also fixed en route (pre-existing,
  found while building gate c):** feature-gated integration tests were
  un-runnable since Phase 1 — stale strip-lists leaked the fixture's
  `readback` key into project_state (duplicate wire key, last-wins → frame
  size mismatch; fixed in render_export_{composite,map_only}.rs) and
  synthetic clips lacked x264 VUI colorimetry (decoded frame props
  unspecified → zimg 3074 "no path between colorspaces" in the Phase-4
  ingest; fixed in render_export_{composite,video_only}.rs +
  native_hdr_composite.rs — real footage always carries VUI tags). Two
  REMAINING pre-existing failures there, NOT renderer-lane scope, for the
  Soup-zones/Oracle ledger: composite pip_map_inset content assertion
  (route:null → null-island ocean ≈ testsrc blue at the sampled pixel) and
  video_only full-bleed alpha=0 at center (ProRes-alpha path, no map
  involvement). **NEXT for this lane:** Matthew hand-exports the same
  project through both backends × {SdrH265, HdrHlg, HdrPq} (flip via
  `TRAILCUT_RENDERER_BACKEND=native npm run tauri dev`) for the gate-d
  eyeball; DEFAULT STAYS CHROME until his sign-off + the cross-engine
  golden-frame gate (blocked on the color lane's approved look). CANON §2.5
  records the decision + port contracts. PROGRESS/CANON edits left
  uncommitted alongside the color lane's (staging by path would sweep the
  color-lane hunks); port code committed separately by explicit path.
  [SUPERSEDED by the 2026-07-02 cutover entry below — the "cross-engine
  golden-frame gate blocked on the color lane" clause was a conflation; see
  the corrected CANON §2.5.]
- **2026-07-02 (cont. 4) — renderer-strangle lane: CUTOVER EXECUTED. Native
  is the default and only backend; chrome stripped.** Matthew hand-exported
  a real project through the native backend, confirmed it works well
  (informal parity pass), and authorized the cutover. Four commits, in order:
  **(1) `7dee105`** golden-frame gate extended to native — and the ENTIRE
  golden gate found ROTTED: the fixture's hand-inlined `mapSettings`
  predated the camera/route/waypoints/pov restructure, so BOTH engines
  failed at worker setup; invisible because the gate is feature-flag opt-in
  (`--features integration_export`) and CI never runs it. Fixture revived —
  `generate_setup.mjs` now builds its wire shape through the shared
  `setupFixture.ts` builder (cannot rot silently again; decorations now
  render in the golden frames), `readback` added to the wire-key
  strip-lists. Native goldens committed after eyeball vs chrome (only
  divergence: one dense-label collision outcome). Determinism measured, not
  assumed: mbgl/Metal wobbles ±1 LSB on 0–10 of 518,400 px across worker
  boots (byte-identical within one map instance) → native pin allows
  exactly delta ≤ 1 on ≤ 0.01% of pixels; chrome pin stayed byte-exact
  while it existed. **(2) `7988c2a`** default flipped to native —
  `selectBackendName` extracted pure into backend.ts with a unit pin
  (default=native, loud throw on typos); Rust `OrchestratorConfig` default
  unchanged (None = inherit env, worker default applies), comments +
  `default_config_pins_no_backend` updated. Renderer vitest 29/29 with the
  worker-spawning tests now exercising native (2.3s vs ~30s under chrome).
  **(3) `8110f70`** chrome STRIPPED: chromeBackend.ts, page bundle
  (painterPatch.ts et al.), bootstrap.html.ts, trailcutFetch.ts, chrome
  transport probes + their tests, chrome goldens, CfT download in
  build.mjs, puppeteer-core/@puppeteer/browsers/pngjs deps,
  `TRAILCUT_CHROME_BIN` + `chrome_path`/`resolve_chrome` in orchestrator.rs
  (RendererBackend keeps only Native as the explicit-pin seam),
  tauri.conf.json resources glob chrome-* → mbgl-native-*.
  `TRAILCUT_RENDERER_BACKEND` kept as a loud single-value switch ('chrome'
  throws a removal notice). protocol.test.ts + tileCacheKeyParity.test.ts
  ported to native (binding-staged precondition; the sha256(originalUrl)
  disk-key contract stays pinned end-to-end). **(4)** docs: CANON §2.5
  rewritten to DECIDED/cutover-complete and the gate CONFLATION fixed —
  the golden gate pins raw renderer frames pre-composite (zero color-lane
  dependency); only a delivered-HDR-look approval gate needs the color
  lane, and that stays deferred in the Oracle lane. CANON §6.2 bundling
  note updated (mbgl-native dir is what task 130 ships now).
  **Verified after strip:** cargo suites green (zero chrome remnants),
  frontend Vitest 928/7/0, renderer Vitest 18/18, native golden gate
  green, feature-gated render_export tests show exactly the two documented
  pre-existing out-of-lane failures (pip_map_inset content assert;
  video_only full-bleed alpha) and nothing new. Local-only — NOTHING
  pushed, per standing rule. Leftover ~600 MB CfT dir at
  `src-tauri/binaries/chrome-<triple>/` is gitignored; safe to hand-delete.
  Worker-count default (2) still carries chrome-era tuning — perf
  follow-up flagged in orchestrator.rs. Color-seam lane untouched (fix C′
  still uncommitted in the working tree by design).
