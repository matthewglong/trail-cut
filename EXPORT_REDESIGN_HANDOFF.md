# Export Modal Redesign — Session Handoff

This file exists to let a fresh Claude Code session pick up the in-progress
implementation without re-reading the entire prior conversation.

## What the user asked for (the original task, condensed)

Migrate `src/components/ExportModal/ExportModal.tsx` to match the design in
`export-modal-concept.html` at the repo root. Replace the current flat
axes (aspect checkboxes + channel toggles) with a 3×3 grid (aspect × channel)
where each cell holds N "configured exports" — chips like `1080·30`,
`4K·30`. Empty cells show a dashed `+` that opens a secondary 480px modal
scoped to that cell, where the user picks **quality** and **fps**. Chips
reopen the same secondary modal in edit mode; chip hover reveals an `✕`.

The mockup at `/Users/personal/Documents/trail-cut/export-modal-concept.html`
is the visual + interaction source of truth. Read it in full, including
every `.note` div (the IA reasoning lives there).

**Backend (export-controls plan)**: Phases 1–4 of
`docs/export/plans/export-controls.md` are merged. `OutputResolution`,
`CodecPreference`, `FrameRateChoice` all exist, the pipeline is fully
resolution-aware (`output_dims` and `resolve_slots` are 2-ary on both sides),
fps is consumed end-to-end, codec_preference + audio_bitrate_kbps are wired
into the composite branch. **No Rust pipeline changes are required for the
grid-modal redesign** — just plumb per-job quality + fps through the
existing fields.

The "Coming later" panel in the secondary modal (codec / color profile /
bitrate / HDR / stabilization passthrough) is **out of scope**. Build the
data model so they slot in later without IA changes.

## Approved blueprint (user signed off — go-ahead given)

### Data model — TS
```ts
type CellKey = `${AspectRatio}-${ExportChannel}`;
type ExportFps = 24 | 30 | 60;
interface ExportConfig { id: string; quality: OutputResolution; fps: ExportFps; }
interface ExportGrid { cells: Partial<Record<CellKey, ExportConfig[]>>; output_dir: string | null; }
interface ExportJob {
  id: string;                       // `${aspect}-${channel}-${quality}-${fps}-${config.id}`
  aspect: AspectRatio;
  channel: ExportChannel;
  quality: OutputResolution;
  fps: ExportFps;
  outputPath: string;
}
```

### Data model — Rust (`src-tauri/src/models.rs`)
```rust
pub struct ExportConfig { pub id: String, pub quality: OutputResolution, pub fps: u32 }
pub struct ExportGrid {
  #[serde(default)] pub cells: HashMap<String, Vec<ExportConfig>>,
  pub output_dir: Option<PathBuf>,
}
// Project.last_export_selection: Option<ExportGrid>
// CURRENT_SCHEMA_VERSION = 6
```

### Filename schema (matches mockup)
`{slug}__{aspect_token}__{quality_token}__{channel_token}.{ext}`
- aspect_token: `9_16` → `9x16`, `4_5` → `4x5`, `16_9` → `16x9`
- quality_token: `720p`→`720`, `1080p`→`1080`, `1440p`→`1440`, `2160p`→`4k`
- channel_token: `composite`, `map-only`, `video-only`
- Example: `cascade-pass-traverse__16x9__4k__composite.mp4`

### Queue ordering
Cells walked in (aspect, channel) display order — aspects `['16_9','4_5','9_16']`,
channels `['composite','map_only','video_only']`. Stable sort by quality tier
afterward (720 → 1080 → 1440 → 4K), so faster jobs run first.

### Persistence migration
**Clean break** — v5 `last_export_selection` (flat `{aspects, channels, output_dir}`)
is dropped on the v5→v6 migration; users re-configure once on first open
post-upgrade. Logged as GAP-001.

### Components
- **New**: `ExportGrid.tsx`, `ExportCell.tsx`, `ExportChip.tsx`,
  `ConfigExportModal.tsx`, `ExportModal.module.css`
- **Kept**: `ExportModal.tsx` (shell rewritten in commit 4),
  `QueueView.tsx`, `QueueSummary.tsx`
- **Deleted**: `AspectCheckboxes.tsx`, `ChannelToggles.tsx`,
  `JobSummary.tsx`, `ChannelSchematic.tsx` (already deleted in commit 1)

### User-confirmed UX decisions
1. **Auto-numbered output folder**: default `~/Movies/TrailCut/{ProjectName}`;
   **increment whenever the folder exists** (not just non-empty) — append ` 2`,
   ` 3`, … to find the next free name. Needs a Rust command
   `resolve_output_dir(base, name)` for filesystem probing.
2. **Source < output quality/fps** (for composite + video_only): hard-disable
   the button in the secondary modal with a tooltip like
   `"Source 1920×1080 — would require upsample"`. `map_only` is procedural
   so it always allows everything.
3. **Duplicate chips per cell**: disable conflicting `{quality, fps}` combos
   in the secondary modal in add mode; in edit mode the current chip's own
   values are not disabled.
4. **Quality tiers surfaced**: all four — 720 / 1080 / 1440 / 4K.

### Implementation commits (in order)
1. ✅ **Data model + types** — Rust + TS. v5→v6 migration drops old field.
2. **`buildJobRequest` per-job quality + fps** — `ExportRequestContext.frameRate`
   removed; threaded from `ExportJob`.
3. **New UI components in isolation** — Grid, Cell, Chip, ConfigModal +
   CSS module. Vitest coverage. `ExportModal.tsx` not yet wired.
4. **Wire new UI into ExportModal** — full UI swap; auto-default
   `output_dir`; new Rust command `resolve_output_dir`. Delete dead files
   that weren't already removed.
5. **Mockup-style QueueView + QueueSummary** — running banner, done banner,
   channel tag badges, CSS module styling.
6. **Filename tests + `EXPORT_GAPS.md`** — full coverage of the new
   filename schema; create the gap log at repo root.

### EXPORT_GAPS.md entries to capture in commit 6
- **GAP-001** v5→v6 migration drops `last_export_selection`
- **GAP-002** No real per-job ETA estimator; placeholder remains
- **GAP-003** Hardcoded CRF in `src-tauri/src/export/encoder.rs`
- **GAP-004** Auto-numbered folder probes filesystem at modal-open and
  again at render-time (race exists between user-visible name and
  on-disk reality)
- **GAP-005** No "retry failed job" affordance — "Render again" resets
  the whole modal to the select view

## Current state (as of handoff)

Branch: `feat/map-positioning-triptych` — note this branch was started for
unrelated map-positioning work, but the user is doing the export redesign
on top of it. Commits aren't being staged yet; the workspace is dirty.

### Commit 1 work — done, both test suites green for TS

**TS files edited**:
- `src/types.ts` — added `CellKey`, `ExportFps`, `ExportConfig`,
  `ExportGrid`. Re-export `OutputResolution` from `lib/layout.ts`.
  `Project.last_export_selection` retyped to `ExportGrid | null`.
- `src/lib/exportFilenames.ts` — rewritten. New `ExportJob` shape
  (carries `quality`, `fps`). New `deriveFilename` signature. New
  `deriveJobs(projectName, outputDir, grid: ExportGrid)`. Helpers:
  `gridJobCount`, `configsInCell`. `ASPECT_ORDER` and `CHANNEL_ORDER`
  exported as readonly arrays.
- `src/lib/exportRequest.ts` — `buildJobRequest` reads
  `job.quality` and `job.fps`, passes as `resolution` and
  `frameRate: { kind: 'explicit', fps: job.fps }`.
  `ExportRequestContext.frameRate` field removed.
- `src/components/ExportModal/ExportModal.tsx` — rewritten as a
  type-compatible stub with the new `ExportGrid` prop. Select view shows
  a placeholder `<div>` reading "The configure grid lands in a follow-up
  commit." Render path (collision check, queue.start, etc.) still works
  if you manually inject a populated `ExportGrid`. Restyled to the
  mockup's color tokens preemptively. **This stub UI is intentional — it
  gets replaced in commit 4 by the real grid components.**
- `src/components/ExportModal/__tests__/ExportModal.test.tsx` — slimmed
  down to lifecycle + folder-picker + prefill + render-flow tests that
  don't depend on the old UI. Grid-interaction tests come back in commit 4.
- `src/components/ExportModal/__tests__/JobSummary.test.tsx` — deleted
- `src/components/ExportModal/AspectCheckboxes.tsx` — deleted
- `src/components/ExportModal/ChannelToggles.tsx` — deleted
- `src/components/ExportModal/ChannelSchematic.tsx` — deleted
- `src/components/ExportModal/JobSummary.tsx` — deleted
- `src/lib/__tests__/exportFilenames.test.ts` — rewritten for the new
  schema (full filename + ordering + uniqueness coverage).
- `src/App.tsx` — `ExportGrid` instead of `ExportSelection`.
- `src/screens/ProjectView.tsx` — `ExportGrid` types; initial state
  `{ cells: {}, output_dir: null }`.
- `src/hooks/useAutoSave.ts` — `ExportGrid` type.
- `src/hooks/useProject.ts` — `ExportGrid` type.

**Rust files edited**:
- `src-tauri/src/models.rs` — added `ExportConfig`, `ExportGrid`. Deleted
  old `ExportSelection` struct. Bumped `CURRENT_SCHEMA_VERSION` to 6.
  Imports `OutputResolution` from `crate::export::resolution`. Imports
  `std::collections::HashMap`. Updated unit tests for the new shape.
- `src-tauri/src/commands/project.rs` — added `migrate_v4_to_v5_value`
  (the prior `migrate_v4_to_v5` returning `Project` is preserved as a
  `#[cfg(test)]`-gated helper). Added `migrate_v5_to_v6` that drops the
  old field. Updated the chained migration in `load_project`. Tests
  added: `migrate_v5_to_v6_drops_flat_export_selection`,
  `load_v5_bundle_with_flat_export_selection_loads_at_v6`. Updated
  `load_v4_bundle_loads_with_none_last_export_selection` for the v6
  current.

### Verification status

✅ `npx tsc --noEmit` — clean
✅ `npx vitest run` — 491 passed / 7 skipped (pre-existing skips)
✅ `cd src-tauri && cargo check` — clean
⚠️ `cd src-tauri && cargo test` — **not yet run; the previous attempt was
canceled by the user. Run this first thing in the new session.**

### Phase / commit task tracking

Tasks created (from prior session — recreate via TaskCreate if needed,
or just track informally):
- Phase 1a/1b/1c (explore, architect, approve) — completed
- Phase 2 / Commit 1 — completed (this handoff captures it)
- Phase 2 / Commit 2 — pending
- Phase 2 / Commit 3 — pending
- Phase 2 / Commit 4 — pending
- Phase 2 / Commit 5 — pending
- Phase 2 / Commit 6 — pending
- Phase 3 — pending (spawn `feature-dev:code-reviewer` against the branch
  diff once Phase 2 lands)

## What to do in the new session

1. Read this handoff file in full.
2. Quickly skim the mockup `export-modal-concept.html` to refresh on the
   visual + interaction model.
3. Run `cd src-tauri && cargo test` to verify Commit 1's Rust tests pass.
   If failures show up, fix before proceeding.
4. Stage and commit the Commit 1 changes (one commit) before continuing.
   Commit message suggestion:
   ```
   export modal: data model + types for grid redesign (commit 1/6)

   Replaces the flat ExportSelection ({aspects, channels, output_dir})
   with ExportGrid — a sparse map keyed by `${aspect}-${channel}` cells,
   each holding zero or more ExportConfig chips ({id, quality, fps}).
   Renames Project.last_export_selection's element type; v5→v6 migration
   drops the old value cleanly (no structural transform).

   Filename schema bumps to mockup form: __ separators, quality token
   between aspect and channel. New helpers gridJobCount, configsInCell.
   ExportRequestContext.frameRate field removed — per-job quality + fps
   land in commit 2 via the ExportJob payload.

   ExportModal.tsx is a stub here (renders a placeholder where the grid
   will go); the real UI lands in commit 4. Old controls
   (AspectCheckboxes, ChannelToggles, JobSummary, ChannelSchematic) and
   their tests are deleted.
   ```
5. Continue with Commit 2 (the easiest — `buildJobRequest` thread + tests).
6. Then Commit 3 → 4 → 5 → 6 in order. After Commit 4, exercise the modal
   in `npm run tauri dev` (this is the first commit where the UI is real).
7. After all 6 commits land, spawn `feature-dev:code-reviewer` on the
   branch diff (Phase 3).

## Files the new session must NOT touch
- Anything under `src-tauri/src/export/` (the pipeline) — Phases 1–4 of
  export-controls already merged this. The redesign only adds UI plumbing.
- `src-tauri/src/export/encoder.rs` — hardcoded CRF is GAP-003, deliberately
  out of scope.
- Anything unrelated to the export modal (home screen, timeline, map view).

## User collaboration style
- Senior developer; LWC/Python background. Wants technical depth and
  reasoning, not just code dumps.
- Prefers terse responses with no trailing summaries unless asked.
- Will redirect; doesn't need to be asked for permission for normal moves.
- For split layouts / multi-axis UIs, prefers per-pane / per-cell thinking
  over per-divider thinking.
- Already approved the blueprint above. The new session should NOT re-ask
  for approval of decisions captured here.

---

End of handoff. The new session has everything needed to proceed.
