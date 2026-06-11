# Ship-Review Execution — Progress Tracker

**Resume protocol (for a fresh session):** read this file top to bottom, then
read `NEXT ACTION`. The plan is [`ACTION_PLAN.md`](ACTION_PLAN.md); the findings
are [`SHIP_REVIEW.md`](../../SHIP_REVIEW.md). Update this file whenever a phase
advances, a gate is verified, or a decision lands — it is the only
cross-session state. Keep entries terse and dated.

---

## NEXT ACTION

**Phase 1 — Unstrand the engine.** Split the uncommitted working-tree diff
(25 modified files + untracked `src-tauri/src/util/color_space.rs`) into:
- **Commit A (engine):** `color_space.rs`, `models.rs` (v9), `commands/project.rs`,
  `util/color.rs`, `util/mod.rs`, `util/exiftool.rs`, `src-tauri/src/export/*`,
  `tests/color_fixtures.rs`, `tests/encoder_probe.rs`, v9 hunks of `src/types.ts`,
  `src/lib/exportFilenames.ts`
- **Commit B (control-panel UI):** `DecorationPanel.tsx`, `MapView.tsx`,
  `src/lib/mapVisuals/*`, `ExportChip.tsx` + **fix the stale red ExportChip test**
- Hunk-level triage needed for: `types.ts`, `MapView.tsx`, renderer sidecar files
- Then merge all of `feat/control-panel` → `main` (decided — see ACTION_PLAN
  decision log; cherry-pick infeasible, main is schema v6)

Safety backups from Phase 0 (recreate if stale):
`/tmp/trailcut-pre-phase0.patch`, `/tmp/color_space.rs.phase0-backup`.

## Phase status

| Phase | Status | Evidence / gate |
|---|---|---|
| 0 — Quarantine (attic) | ✅ done 2026-06-11 | See Phase 0 record below |
| 1 — Unstrand engine (Thread 0) | ⬜ next | Gate: main has v9 + color_space.rs; both suites green; status clean |
| 2a — Data-loss fix (Thread 2) | ⬜ pending (parallel w/ 2b) | Gate: atomic saves, canonical payload, TS↔Rust parity test |
| 2b — Doc canon (Thread 4) | ⬜ pending (parallel w/ 2a) | Gate: fresh agent answers schema/HDR/canon questions correctly; harvest BEFORE moving stale docs to attic |
| 3 — Tracer oracle (Thread 1 thin) | ⬜ pending | Gate: CI on every push; HDR signal test red-by-design; zero silent skips |
| 4 — HDR port (Thread 3) | ⬜ pending | Gate: tracer green; SDR unchanged; Matthew eyeball checklist (ACTION_PLAN decision log #3) |
| 5 — Parallel lanes (Threads 1/5/6/7) | ⬜ pending | Per-lane tracer slices, see ACTION_PLAN |

## Test baseline (canonical, pre-Phase-1)

`npm run test:run` → **1 failed | 914 passed | 7 skipped (922)**.
The 1 failure is the known stale ExportChip test (`'4K·30·HDR'`) — SHIP_REVIEW
§2.2; scheduled to be fixed in Phase 1 Commit B. Any other failure is a
regression. `cargo test` untouched by Phase 0 (no Rust files moved).

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
