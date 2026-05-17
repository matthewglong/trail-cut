# Layout & Export UI — Design

**Status**: Design — not yet implemented.
**Branch**: `export-test`
**Date**: 2026-05-09
**Companion to**: `docs/export/LAYOUT.md` (locked layout decisions), `docs/export/PLAN.md` (renderer architecture).
**Supersedes**: `docs/export/LAYOUT.md` §9 open UI questions.

---

## 1. Scope

This plan covers two user-facing surfaces:

1. **Map Positioning modal** — opened from a button inside the existing `MapToolbar`, configures layout per aspect ratio (replaces the developer-grade `LayoutConfigurator` overlay).
2. **Export modal** — a single Export entry point that replaces the three temp buttons (Composite / Map-only / Video-only) and supports multi-select export across aspect × channel.

It does NOT cover: per-clip layout overrides (deferred to v2 with animated transitions per LAYOUT.md §4); music / audio editing; project-level export presets beyond last-used recall.

## 2. Locked decisions

Carried forward from LAYOUT.md, plus decisions settled in design conversation:

- **Layout modes**: PiP and Side-by-Side (a.k.a. "Split" in code/data).
- **Aspects**: 9:16, 4:5, 16:9 — all three retained.
- **PiP**: free position + size; corner radius supported in v1; swap (map vs. video as inset) supported.
- **Side-by-Side**: free divider position; orientation locked by aspect (16:9 → vertical, 9:16 / 4:5 → horizontal); swap (which side is video) supported.
- **Configuration scope**: project-level, per-aspect. Per-clip layout-geometry deferred to v2.
- **Reset-to-default per aspect**: included.
- **Map Positioning entry point**: button inside the existing `MapToolbar`; opens a modal.
- **Export entry point**: single Export button replaces the three temp buttons (`Composite`, `Map-only`, `Video-only`).
- **Render queue**: sequential, with progress UI + upfront time estimate.
- **Last-used export selection**: persisted per project in `project.json`.

## 3. Map Positioning modal

### Surface

A modal opened from a button inside the existing `MapToolbar` (label/icon TBD — "Layout" or a layout-shape icon). The modal is focused on positioning only; other map settings (style, route appearance, bearing) stay in `MapToolbar` itself and are unaffected.

### Modal contents

**Three preview panes** arranged in a responsive grid, one per aspect:

```
┌───────────────────────┐ ┌──────────────┐ ┌──────────┐
│       16:9            │ │     4:5      │ │   9:16   │
│ ┌───────────────────┐ │ │ ┌──────────┐ │ │ ┌──────┐ │
│ │                   │ │ │ │          │ │ │ │      │ │
│ │   [interactive]   │ │ │ │  [intr]  │ │ │ │      │ │
│ │                   │ │ │ │          │ │ │ │ [in] │ │
│ └───────────────────┘ │ │ └──────────┘ │ │ │      │ │
│                       │ │              │ │ │      │ │
│  Mode: [PiP] [SbS]    │ │  Mode: [..]  │ │ │      │ │
│  Reset                │ │  Reset       │ │ └──────┘ │
└───────────────────────┘ └──────────────┘ └──────────┘
```

Each pane shows a live preview of that aspect's stored layout. Above or within each pane:

- **Mode toggle**: `Picture in Picture` ⇄ `Side by Side` (two-state segmented control).
- **Reset**: clears that aspect's layout to the seeded default.
- (PiP only) **Corner radius slider**: 0–32 px, persisted in `LayoutConfig`.

### PiP interaction

- Inset rect drawn over preview; draggable, resizable via 4 corner + 4 edge handles.
- Snap targets (existing logic in `src/components/LayoutConfigurator/snap.ts`):
  - **Position**: edges (0, 1−w), centers (0.5−w/2), thirds (1/3, 2/3), golden ratio (0.382, 0.618), and inset-relative (target − w).
  - **Size**: 1/3, 1/2, 2/3, 0.382, 0.618.
- **Swap icon**: small button overlaid on the inset rect, persistent low-contrast styling, animates on hover. Click flips inset between map and video.
- **Hold `Shift`** to bypass snap.
- **Min/max size**: 15% / 85% of frame's shorter dim, applied to both width and height of the inset.

### Side-by-Side interaction

- Single divider, oriented per aspect (vertical for 16:9, horizontal for 9:16 / 4:5).
- Drag along divider's free axis; freely positionable along that axis.
- Snap targets: 0.5, 1/3, 2/3, 0.382, 0.618 (existing `splitSnapTargets`).
- **Swap icon**: rendered on the divider midpoint, persistent low-contrast, hover-animated. Click flips video and map sides.
- **Hold `Shift`** to bypass snap.

### Snap visual feedback

- Highlight target (subtle outline glow or thin guide line) only when within snap threshold.
- Dragged element settles into snap on a 120 ms ease-out.
- No pulse-on-approach (reads twitchy at the threshold edge).

### Snap threshold

- Existing `SNAP_THRESHOLD = 0.015` (1.5%) was tuned for the dev overlay.
- Bump to **0.05–0.06** (5–6% of relevant frame dim) for user-facing UX. Open to tuning during implementation; consider exposing as a constant in `snap.ts` so all surfaces share one value.

## 4. Export modal

### Surface

Modal triggered by a single Export button in the top toolbar (replaces the three temp buttons). Modal sections from top to bottom:

1. **Aspect ratio selection** — multi-select checkboxes: 9:16, 4:5, 16:9.
2. **Channel selection** — multi-select toggles: `Composite (A)`, `Map only (B)`, `Video only (C)`.
3. **Output preview** — small schematic/icon for each enabled channel (composite shows map+video layout for the first selected aspect; map-only shows map shape; video-only shows video shape). Static, not animated.
4. **Job summary** — line of text computed from selections: e.g., *"Exports 6 files (3 channels × 2 aspects). Estimated time: ~7 min."*
5. **Output destination** — folder picker; files written with deterministic names (see §5).
6. **Render** + **Cancel** buttons.

### Job count math

```
n_jobs = (# selected aspects) × (# selected channels)
```

For 3 aspects × 3 channels at full multi-select: 9 jobs. Sequential execution. Job count displayed before user confirms.

### Time estimate

- Per-job estimate from probed source duration × scaling factor (channel-specific: A is heavier than B or C; B is lighter than C).
- `large-clip-count-composite.md` shows startup cost dominates wall-clock at high N — the estimate should account for **N_clips × startup_cost_per_clip** plus **encode_duration**.
- Acceptable to be rough (±30%) in v1; surface as "~X min" not a precise countdown.

### Defaults

- First open: clean state (no selections).
- Subsequent: read last-used selection from `project.last_export_selection` (new field).
- "Remember selection" is implicit — no checkbox needed; clearing is one click per checkbox.

## 5. Data model additions

### Project schema

```rust
pub struct Project {
  // ... existing ...
  pub layouts: ProjectLayouts,                          // already exists
  pub selected_export_aspect: AspectRatio,              // already exists
  pub last_export_selection: Option<ExportSelection>,   // NEW
}

pub struct ExportSelection {
  pub aspects: Vec<AspectRatio>,                        // checked aspects
  pub channels: Vec<ExportChannel>,                     // checked channels
}
```

### LayoutConfig (per aspect, already exists)

No structural change. `corner_radius` already supported on PiP variant. Reset-to-default per aspect implemented as: replace stored value with the seeded default for that aspect (see `src/lib/layout.ts` `defaultLayoutFor(aspect)`).

### Output filenames

Deterministic, based on project name + aspect + channel:

```
{project_name}-{aspect}-{channel}.{ext}
e.g. Hike2026-9_16-composite.mp4
     Hike2026-9_16-map.mov
     Hike2026-16_9-video.mov
```

User picks an output **directory** in the modal; filenames are derived. Avoids per-job save dialogs (the current flow's `save({ title, filters })` per job becomes user-hostile for 9 jobs).

## 6. Render queue architecture

### Frontend

- `useExportQueue` hook: holds an in-progress queue (array of jobs) + per-job state (`pending`, `running`, `done`, `failed`).
- Each job is dispatched via the existing `render_export` Tauri command, one at a time, in sequence.
- Cancel button stops after the current job completes (or hard-cancels mid-job — TBD, see §7).
- Progress UI: list of jobs with state badges; running job shows a spinner + percent if backend can stream stage events.

### Backend

- No new orchestrator behavior required for v1: existing `render_export` is invoked once per job; the frontend is responsible for queuing.
- Long-term, a backend-side queue (job persistence, resume after restart) is a v2 consideration.

### Interaction with `large-clip-count-composite.md`

- That plan addresses startup cost per render. The queue UI surfaces the cost; the plan reduces it. The two are independent and complementary.
- Sequential execution is the safe choice today: parallel jobs would multiply file-descriptor pressure and `ffprobe` traffic per the same plan's diagnostics.

## 7. Open implementation questions

### Snap tolerance

Tunable. Start at 0.05 (5%) for both divider and PiP edges; revisit after dogfooding.

### Cancel semantics

Cancel-after-current vs. hard-cancel. Hard-cancel requires killing the FFmpeg child process and cleaning up partial output files. Cancel-after-current is one boolean flag. Recommend cancel-after-current for v1.

### Output overwrite policy

When a target filename already exists: overwrite without prompt? Append `-2`? Prompt? Recommend overwrite-without-prompt with a single confirmation modal *before* the queue starts if any target paths exist.

### MapToolbar button label / icon

A short text label ("Layout") vs. an icon (layout-shape glyph). Recommend icon + tooltip for compactness, since `MapToolbar` already carries other controls.

## 8. Implementation sequence

Proposed task breakdown — each task is one PR-sized step that leaves the app working.

| ID  | Title | Depends on |
|-----|-------|------------|
| 200 | Map Positioning modal shell (button in `MapToolbar`, open/close, empty state) | — |
| 210 | Modal contents: 3-pane preview, mode toggle, reset, corner radius slider | 200 |
| 220 | Snap-utility tuning + shared threshold; visual feedback (target highlight, ease-out settle) | 210 |
| 230 | Replace `LayoutConfigurator` overlay usage in `ProjectView` with modal-driven config; remove temp aspect `<select>` | 210, 220 |
| 240 | Export modal scaffold (UI only, no queue): aspect checkboxes, channel toggles, schematics, summary line | 230 |
| 250 | Output filename derivation + folder picker; remove per-job save dialogs | 240 |
| 260 | Time-estimate computation (per-channel scaling factor; surfaced before render) | 250 |
| 270 | Frontend render queue (`useExportQueue`); sequential dispatch; progress UI; cancel-after-current | 240, 250 |
| 280 | Persist `last_export_selection` in `project.json`; restore on modal open | 270 |
| 290 | Remove the three temp export buttons; wire single Export button to the modal | 270 |

Tasks 200–230 ship the positioning UX. Tasks 240–290 ship the export flow. They can be developed in parallel after 200; 290 is the final cutover that removes the dev-grade buttons.

## 9. Risks & callouts

- **9-job queue × N=70 clips is the worst case** addressed in `large-clip-count-composite.md`. The estimate UI must not lie about this; if the per-clip startup cost is not yet reduced, a 9-job export of a long timeline could be 30+ minutes. Surface this clearly.
- **Removing temp export buttons (290) is the point of no return**. Land it after 270 + 280 are stable.
- **Modal scope creep**: positioning only. Resist absorbing other `MapToolbar` controls into the modal.

## 10. Decisions index

Quick reference for everything settled in this document:

- **Map Positioning**: modal opened from a button inside the existing `MapToolbar`. Positioning only — other `MapToolbar` controls unchanged.
- **3 aspects** (9:16, 4:5, 16:9): all retained; one preview pane per aspect in positioning section.
- **PiP swap + corner radius**: kept.
- **Side-by-Side swap**: kept; persistent low-contrast icon on divider.
- **Snap**: 0.05 threshold (tunable), `Shift` to bypass, target-highlight + 120 ms ease-out, no pulse.
- **PiP min/max**: 15% / 85% of shorter frame dim.
- **Reset-to-default per aspect**: per-pane button; reverts to seeded default.
- **Export entry**: single button, replaces 3 temp buttons.
- **Multi-select**: aspect (multi) × channel (multi), Cartesian product → jobs.
- **Queue**: sequential, progress UI, upfront estimate, cancel-after-current.
- **Filenames**: derived from project + aspect + channel; user picks folder only.
- **Last-used selection**: persisted per project.
- **Overwrite**: prompt once before queue starts if any target paths exist; then overwrite without per-file prompts.
