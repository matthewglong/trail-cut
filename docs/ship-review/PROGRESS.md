# Ship-Review Execution — Progress Tracker

**Resume protocol (for a fresh session):** read this file top to bottom, then
read `NEXT ACTION`. The plan is [`ACTION_PLAN.md`](ACTION_PLAN.md); the findings
are [`SHIP_REVIEW.md`](../../SHIP_REVIEW.md). Update this file whenever a phase
advances, a gate is verified, or a decision lands — it is the only
cross-session state. Keep entries terse and dated.

---

## NEXT ACTION

**Phase 4 — HDR port (Thread 3).** Work order: `docs/spikes/IMPLEMENTATION.md`
(A+B+C+D, atomic per the spike's own warning — partial landing darkens camera
footage ~2×). `npl=203` WORKING_NPL anchor at every HDR ingest AND delivery,
×2.03 SDR-origin gain, 10-bit headroom, HQ subsample, BT.2446-A tone map for
SDR targets. Gated on the Phase 3 tracer: the two
`hdr_reference_white_tracer_*` tests (red today: 0.630 HLG / 0.509 PQ vs
0.75 / 0.58 expected) must go GREEN — then graduate them into the main CI
job (drop the `--skip hdr_reference_white_tracer` in `.github/workflows/
ci.yml`'s test job and delete the `hdr-tracer` job; its report step goes red
on unexpected-green precisely to force this). Deliberately retire the
byte-pins that encode the bug (`delivery_never_emits_npl`; pre-fix PQ string
in delivery.rs tests) — each re-baseline documented. Sign-off: Matthew's
eyeball checklist, ACTION_PLAN decision log #3.

## Phase status

| Phase | Status | Evidence / gate |
|---|---|---|
| 0 — Quarantine (attic) | ✅ done 2026-06-11 | See Phase 0 record below |
| 1 — Unstrand engine (Thread 0) | ✅ done 2026-06-11 | See Phase 1 record below |
| 2a — Data-loss fix (Thread 2) | ✅ done 2026-06-11 | See Phase 2a record below |
| 2b — Doc canon (Thread 4) | ✅ done 2026-06-11 | See Phase 2b record below |
| 3 — Tracer oracle (Thread 1 thin) | ✅ done 2026-06-11 | See Phase 3 record below; green CI run 27386190883 with verified red-by-design tracer |
| 4 — HDR port (Thread 3) | ⬜ next | Gate: tracer green; SDR unchanged; Matthew eyeball checklist (ACTION_PLAN decision log #3) |
| 5 — Parallel lanes (Threads 1/5/6/7) | ⬜ pending | Per-lane tracer slices, see ACTION_PLAN |

## Test baseline (canonical, post-Phase-3, on `main` @ b44ae9a)

`npm run test:run` → **928 passed | 7 skipped (935), 0 failed**.
`cargo test -- --skip hdr_reference_white_tracer` → **356 passed, 0 failed,
1 ignored, 2 filtered** (332 lib + 15 color_fixtures + 1 encoder_probe + 2
layout_parity + 2 orchestrator + 4 project_parity). The 2 filtered are the
`hdr_reference_white_tracer_*` tests — **red-by-design until Phase 4**
(plain `cargo test` shows them as the only 2 failures; that is correct, not
a regression). Any other failure is a regression. CI reproduces exactly
these counts (run 27386190883). Note: the suites now PANIC (by design) on
machines missing ffmpeg / zscale / TRAILCUT_CHROME_BIN-with-feature — local
ffmpeg must be `ffmpeg-full` (plain brew `ffmpeg` bottle has no libzimg).

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
- npl=203 ref-white, task 130 sidecar bundling, task 120 parity gate —
  already owned by Phases 4 / 5 Ship-deps / 5 Oracle lanes; also recorded in
  `docs/CANON.md` §6. (The three silent test skips were resolved in Phase 3.)
- **CI chrome-glob stub in the `hdr-tracer` job** (placeholder dir satisfies
  tauri.conf.json's `binaries/chrome-*/**/*` bundle.resources glob; the test
  job provisions the real thing via `npm run build:renderer`) — remove when
  task 130 lands real sidecar provisioning. Owner: Phase 5 Ship-deps lane.
- **Tracer graduation** (when Phase 4 lands: drop `--skip
  hdr_reference_white_tracer` from the CI test job, delete the `hdr-tracer`
  job) — owner: Phase 4; mechanically enforced (the job goes red on
  unexpected-green).

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
