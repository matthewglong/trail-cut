# Ship Review → Execution: Action Plan

Companion to [`SHIP_REVIEW.md`](../../SHIP_REVIEW.md). Goal: get from the current
uncommitted, crufty working tree to a state where agents can execute the review's
threads in parallel — via quarantine (nothing deleted), unstranding, and a
tracer-bullet first slice.

**Operating principles**
- **Nothing is deleted.** Cruft moves to `attic/` — on disk, gitignored, and
  denied to Claude via `.claude/settings.json`. Tracked files moved there remain
  recoverable from git history.
- **Tracer bullet, not big bang.** Each phase lands the thinnest end-to-end slice
  that proves its path, then widens. The master tracer is Phase 3 → 4: one
  pixel-decoding test that is *red against today's live HDR bug*, then the HDR
  port that flips it green.
- **Sequential until the tree is clean** (Phases 0–2 mutate the working tree and
  cannot overlap), **then fan out** (Phase 5 tracks are independent agent lanes).

---

## Phase 0 — Quarantine (the attic)

*One agent, mechanical, no behavior changes. Everything here is reversible.*

1. Create `attic/` with subdirs `spike-artifacts/`, `concept-html/`,
   `superseded-docs/` (filled in Phase 2), `scratch/`. One-line `attic/README.md`
   for humans: "Quarantined cruft. Preserved, not maintained. Claude is denied
   read access — do not cite anything in here."
2. Make Claude ignore it: create `.claude/settings.json` with
   `"permissions": { "deny": ["Read(./attic/**)"] }`, and add one line to
   CLAUDE.md: `attic/` is quarantined — never read, search, or cite it.
3. Gitignore `attic/` (the spike artifacts are 1.4GB of binaries; tracked files
   moved in stay recoverable via history).
4. **Rescue the gems before the sweep** — these are load-bearing inputs to later
   phases and must be *committed*, not atticked:
   - `.spike/IMPLEMENTATION.md`, `PORT_DESIGN.md`, `FINDINGS.md`,
     `SESSION4_FINDINGS.md`, `HANDOFF.md`, `native-gl-jitter-handoff.md`
     → `docs/spikes/` (IMPLEMENTATION.md is the build spec for Phase 4; the
     jitter data is the evidence for upstream PR #4137 in Thread 5).
   - `SHIP_REVIEW.md` + `docs/ship-review/` (incl. this file) → commit as-is.
5. Sweep to attic:
   - `.spike/` remainder (cand/, ff/, lever_*/, native-gl/, out/, port_probe/,
     validate/, *.png, base_payload.json, *.mjs, *.sh, export-pipeline.html)
     → `attic/spike-artifacts/`
   - Untracked scratch: `scratchpad.html`, `map-sampling-explorer.html`
     → `attic/scratch/`
   - Tracked concept HTML (git mv): `export-modal-concept.html`,
     `map-positioning-concepts.html`, `map-positioning-concepts-v2.html`,
     `map-toolbar-responsive-concepts.html`, `rgb-yuv-lab.html`,
     `selector-explorations.html`, `selector-explorations-v2.html`,
     `style-guide.html` → `attic/concept-html/`
     (`style-guide.html` verified safe to quarantine: every hex in it already
     lives in `src/theme/tokens.ts` as the named brand palette — nothing to
     harvest.)
     ⚠️ `index.html` is the Vite entry point — **not cruft, do not move.**
   - `Untitled.md` → `attic/scratch/`
6. Commit: `chore: quarantine cruft into attic/, rescue spike docs to docs/spikes/`

**Gate:** `git status` shows only the real engine/UI diff (Phase 1's input);
`npm run test:run` / `cargo test` results unchanged from before the move
(nothing live referenced the moved files).

## Phase 1 — Unstrand the engine (Thread 0)

*One agent. The working-tree diff (~1,350 insertions, 25 files) mixes two
workstreams; split it into two clean commits.*

1. **Commit A — engine (color-space registry + schema v9):**
   `src-tauri/src/util/color_space.rs` (new), `models.rs` (v8→v9),
   `commands/project.rs` (migration), `util/color.rs`, `util/mod.rs`,
   `util/exiftool.rs`, all of `src-tauri/src/export/*`,
   `tests/color_fixtures.rs`, `tests/encoder_probe.rs`, plus the v9-shaped hunks
   of `src/types.ts` and `src/lib/exportFilenames.ts`.
2. **Commit B — control-panel UI tail:** `DecorationPanel.tsx`, `MapView.tsx`,
   `src/lib/mapVisuals/*` (incl. `shapes.ts` + `styleSpec.test.ts`),
   `ExportChip.tsx` — **fixing the stale red ExportChip test in this commit**
   (the tree must go green here, not in Phase 3).
3. The renderer sidecar diff (`index.ts`, `page/init.ts`, `setupFixture.ts`) and
   mixed files (`types.ts`, `MapView.tsx`) need hunk-level triage (`git add -p`);
   the agent assigns each hunk to A or B and runs both suites after each commit.
4. Merge the whole `feat/control-panel` branch to `main`. **Decided:**
   cherry-picking the engine commit alone is infeasible — `main` is on schema
   **v6**; this branch carries v6→v7→v8 (the entire decoration system) plus the
   uncommitted v8→v9, so the engine work transitively depends on the branch.
   Remaining control-panel polish continues as new short-lived branches off
   main (SHIP_REVIEW §6 names "v9 stranded on a feature branch" as the
   strangler-stall drift pattern to avoid).

**Gate:** `main` contains v9 + `color_space.rs`; `cargo test` and
`npm run test:run` fully green; `git status` clean.

## Phase 2 — Stop the bleeding + canonize the docs (Threads 2 + 4)

*Two agents, parallelizable after Phase 1 (disjoint files).*

**2a — Data-loss fix (Thread 2, urgent — shipped users lose state today):**
- Auto-save serializes one canonical `Project` object (kills the hand-built
  payload that drops `working_color_space`, `start_camera`,
  `default_entry_transition`).
- Atomic temp-file + rename writes; surface save errors (remove `catch(()=>{})`).
- TS↔Rust Project-shape parity test for `types.ts` ↔ `models.rs` (copy the
  pattern from `layout`'s shared fixture).
- Work order: [`code-frontend-lib.md`](code-frontend-lib.md).

**2b — Doc canon (Thread 4): harvest, then quarantine.**
- Harvest every still-binding decision from the four stale generations
  (`PIPELINE_RESEARCH.md`, `PIPELINE_DECISIONS.md`, `PIPELINE_TEACHING_HANDOFF.md`,
  `COLOR_PIPELINE_SPEC.md`, `UNIVERSAL_WORKING_SPACE_REPORT.md`) into one living
  canon doc (`docs/CANON.md`). The stale/conflict lists in
  [`docs-root-specs.md`](docs-root-specs.md) / [`docs-tree.md`](docs-tree.md)
  are the work order — decisions the *code* already made get recorded as DECIDED.
- Correct CLAUDE.md: schema v9, HDR is current, `color_space.rs`, `docs/spikes/`,
  the attic rule, pointer to CANON.md.
- *Then* `git mv` the harvested stale docs → `attic/superseded-docs/`.
  Harvest strictly before move — once in the attic, agents can't read them.

**Gate (2b):** a fresh agent session given CLAUDE.md + CANON.md answers
"what's the schema version / is HDR shipped / where do color decisions live"
correctly, with zero contradicting documents reachable.

## Phase 3 — The tracer bullet: a minimal oracle that sees the live bug (Thread 1, thin slice)

*One agent. Thinnest end-to-end verification path — CI → build → render →
decode → assert — deliberately landing **red-by-design** on one known defect.*

1. GitHub Actions workflow on `macos` runner: `cargo test` + `npm run test:run`,
   with `ffmpeg` (zscale) + `exiftool` via brew — `assert_ffmpeg_has_zscale`
   already enforces loud failure on a bad runner.
2. One new pixel-level test (slots into the `color_fixtures.rs` harness): push a
   known SDR-white synthetic frame through the real HdrHlg delivery chain,
   decode the output frame, assert map-graphics white ≈ 75% HLG signal
   (and 0.58 PQ). **This test fails today** — that's the point: it proves the
   instrument can see the diagnosed defect before anyone trusts it as a gate.
   Mark it as the expected-red tracer (visible-but-allowed-to-fail in CI status,
   never silently skipped).
3. Convert the three known silent skips (`golden_frame_parity`, 2 ×
   `ffmpeg_runner`) to loud failures per the loud-failure rule.

**Gate:** CI runs on every push; every test either passes or fails loudly; the
HDR signal assertion is red for the documented reason. **No silent skips remain.**

## Phase 4 — First payload through the tracer: the HDR port (Thread 3)

*One agent, gated by Phase 3. Already designed and confirmed —
`docs/spikes/IMPLEMENTATION.md` (A+B+C+D), atomic per the spike's own warning.*

- `npl=203` working-space anchor (one `WORKING_NPL` constant at **every** HDR
  ingest *and* delivery — partial landing darkens camera footage ~2×), ×2.03
  SDR-origin gain, 10-bit headroom, HQ subsample, BT.2446-A tone map for SDR
  targets — shipped together.
- Deliberately retire the byte-pins that encode the bug
  (`delivery_never_emits_npl`; pre-fix PQ string at `delivery.rs:471`) — each
  re-baseline documented, justified by the decoded-frame assertion (the
  wrong-oracle risk, SHIP_REVIEW §6).

**Gate:** Phase 3's red tracer test goes green; full suite green; a real HDR
export visually checked (map at correct brightness, camera footage unchanged).

## Phase 5 — Widen: parallel agent lanes

*The tree is clean, the oracle is live and trusted, docs are canon. Fan out —
these lanes are independent:*

| Lane | Thread | First tracer slice |
|---|---|---|
| **Oracle hardening** | 1 (rest) | Decorations + pin in the golden-frame fixture; parity test for the per-frame paint seam (`MapView.tsx` ↔ `renderer/index.ts`); `-loglevel verbose` auto_scale assertion in CI |
| **Renderer strangle** | 5 | Quick wins in current renderer first (`--force-color-profile=srgb`, fractional-pixelRatio SDF fix, painterPatch flag parity), then maplibre-native vector-basemap prototype behind the now-decorated golden gate; comment jitter data on upstream PR #4137 |
| **Soup zones** | 6 | Resurrect `integration_export_parity` (B+C≡A) *first*, then typed composite IR for `filtergraph.rs:597-899`; frontend state redesign around Phase 2a's canonical Project object — incl. the 2a deferred fixes: flush-on-close auto-save, atomic `rename_project`, pip-vs-split seeded-layout unification |
| **Ship deps** | 7 | Own-CI LGPL FFmpeg build gated on `assert_ffmpeg_has_zscale` + encoder probe; `nom-exif` replacing ExifTool (parity vs iPhone fixture corpus); notarization gate |
| **Doc lifecycle** | 4 (rest) | Per docs-tree.md §7: refresh or supersession-banner `docs/map-decorations/data-model.md` + `IMPLEMENTATION-PLAN.md` (v8-terminal claims — repo is v9), fix the split-brained task ledgers in `docs/export/tasks/` + `docs/migration/`, de-duplicate `large-clip-count-composite.md` |

Each lane opens with its smallest end-to-end proof (the tracer pattern) before
widening; each strangle gets an explicit completion gate (SHIP_REVIEW §6,
strangler-stall risk).

---

## Decision log

1. **`style-guide.html` → attic** (decided 2026-06-11). Its full palette already
   lives in `src/theme/tokens.ts`; nothing to harvest.
2. **Merge all of `feat/control-panel` to main** (decided 2026-06-11).
   Cherry-pick infeasible: main is schema v6, the engine work depends on the
   branch's v7/v8 history.
3. **Phase 4 sign-off is an eyeball check, not a calibration task.** The pixel
   gate asserts the numbers (map graphics white ≈ 75% HLG signal / 0.58 PQ —
   the BT.2408 graphics-white standard, same anchor YouTube and Resolve use).
   Matthew confirms with the first corrected export, on an HDR display:
   - **HDR export:** the map pane no longer looks dim/grayed next to the camera
     footage; map whites read as "paper white," sitting naturally beside the
     video rather than a step darker. Expect the map roughly **2× brighter**
     than today's defective HDR output — that is the fix, not a regression.
   - **Camera footage in the HDR export:** unchanged vs. today. (If footage got
     darker, the npl anchor was applied one-sided — hard fail, do not ship.)
   - **SDR export of the same project:** unchanged vs. before the patch.
   - **HDR vs SDR side by side:** the map-to-footage brightness *relationship*
     feels the same in both.
