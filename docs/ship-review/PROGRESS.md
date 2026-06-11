# Ship-Review Execution — Progress Tracker

**Resume protocol (for a fresh session):** read this file top to bottom, then
read `NEXT ACTION`. The plan is [`ACTION_PLAN.md`](ACTION_PLAN.md); the findings
are [`SHIP_REVIEW.md`](../../SHIP_REVIEW.md). Update this file whenever a phase
advances, a gate is verified, or a decision lands — it is the only
cross-session state. Keep entries terse and dated.

---

## NEXT ACTION

**Phase 3 — Tracer oracle (Thread 1, thin slice).** Stand up the first
end-to-end oracle slice: CI on every push; the HDR signal test red-by-design
(npl=203 reference-white fix not yet landed — see `docs/CANON.md` §6 open
items); zero silent skips (incl. fixing the known `golden_frame_parity.rs`
TRAILCUT_CHROME_BIN silent-skip violation, flagged in CANON §1 BINDING
loud-failures entry). See ACTION_PLAN Thread 1 for scope.

Branch from `main` (post-Phase-2: merges `2be86ae` + `95a0df5`, plus this
tracker commit). Test baseline updated below.

## Phase status

| Phase | Status | Evidence / gate |
|---|---|---|
| 0 — Quarantine (attic) | ✅ done 2026-06-11 | See Phase 0 record below |
| 1 — Unstrand engine (Thread 0) | ✅ done 2026-06-11 | See Phase 1 record below |
| 2a — Data-loss fix (Thread 2) | ✅ done 2026-06-11 | See Phase 2a record below |
| 2b — Doc canon (Thread 4) | ✅ done 2026-06-11 | See Phase 2b record below |
| 3 — Tracer oracle (Thread 1 thin) | ⬜ next | Gate: CI on every push; HDR signal test red-by-design; zero silent skips |
| 4 — HDR port (Thread 3) | ⬜ pending | Gate: tracer green; SDR unchanged; Matthew eyeball checklist (ACTION_PLAN decision log #3) |
| 5 — Parallel lanes (Threads 1/5/6/7) | ⬜ pending | Per-lane tracer slices, see ACTION_PLAN |

## Test baseline (canonical, post-Phase-2a, on `main` @ 95a0df5)

`npm run test:run` → **928 passed | 7 skipped (935), 0 failed** (baseline
915 + 13 new projectPersistence tests).
`cargo test` → **356 passed, 0 failed, 1 ignored** (332 lib incl. 3 new
write_atomic tests + 15 color_fixtures + 4 project_parity new + 2
encoder_probe + 2 layout-parity + 1 other). Any failure from here is a
regression. (Pre-Phase-2 baseline was 915/7 + 349.)

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
