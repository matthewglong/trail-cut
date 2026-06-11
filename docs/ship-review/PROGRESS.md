# Ship-Review Execution — Progress Tracker

**Resume protocol (for a fresh session):** read this file top to bottom, then
read `NEXT ACTION`. The plan is [`ACTION_PLAN.md`](ACTION_PLAN.md); the findings
are [`SHIP_REVIEW.md`](../../SHIP_REVIEW.md). Update this file whenever a phase
advances, a gate is verified, or a decision lands — it is the only
cross-session state. Keep entries terse and dated.

---

## NEXT ACTION

**Phases 2a + 2b — run as PARALLEL agents (disjoint files, no shared state):**

- **Phase 2a — Data-loss fix (Thread 2).** Atomic project saves, canonical
  save payload, TS↔Rust parity test. Touches save/load code
  (`commands/project.rs` save path, `useProject`/`useAutoSave`, models) — no
  doc files. Gate: atomic saves, canonical payload, TS↔Rust parity test.
- **Phase 2b — Doc canon (Thread 4).** Establish the canonical doc set;
  **harvest stale docs BEFORE moving them to attic**. Touches docs/ + root
  *.md only — no source files. Gate: a fresh agent answers schema/HDR/canon
  questions correctly.

Both phases branch from `main` @ `2f63d90` (post-Phase-1; schema v9 is on
main). See ACTION_PLAN for thread details.

## Phase status

| Phase | Status | Evidence / gate |
|---|---|---|
| 0 — Quarantine (attic) | ✅ done 2026-06-11 | See Phase 0 record below |
| 1 — Unstrand engine (Thread 0) | ✅ done 2026-06-11 | See Phase 1 record below |
| 2a — Data-loss fix (Thread 2) | ⬜ next (parallel w/ 2b) | Gate: atomic saves, canonical payload, TS↔Rust parity test |
| 2b — Doc canon (Thread 4) | ⬜ next (parallel w/ 2a) | Gate: fresh agent answers schema/HDR/canon questions correctly; harvest BEFORE moving stale docs to attic |
| 3 — Tracer oracle (Thread 1 thin) | ⬜ pending | Gate: CI on every push; HDR signal test red-by-design; zero silent skips |
| 4 — HDR port (Thread 3) | ⬜ pending | Gate: tracer green; SDR unchanged; Matthew eyeball checklist (ACTION_PLAN decision log #3) |
| 5 — Parallel lanes (Threads 1/5/6/7) | ⬜ pending | Per-lane tracer slices, see ACTION_PLAN |

## Test baseline (canonical, post-Phase-1, on `main` @ 2f63d90)

`npm run test:run` → **915 passed | 7 skipped (922), 0 failed**.
`cargo test` → **349 passed, 0 failed** (329 lib + 15 color_fixtures + 2
encoder_probe + 2 protocol/layout-parity + 1 other; 1 ignored). Any failure
from here is a regression.

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
