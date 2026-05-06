# Camera Architecture Migration — Scorecard

Branch: `migration/cameraAt`
Source plan: [docs/migration/COMPILED_TIMELINE_PLAN.md](./COMPILED_TIMELINE_PLAN.md)

## Status legend

- ⬜ pending
- 🟡 in-progress
- ✅ done
- ⛔ blocked
- 🛑 hard-stop (awaiting user)

## Tasks (compiled-timeline redesign, 500-series)

Each task maps 1:1 to a step in `COMPILED_TIMELINE_PLAN.md` §"Implementation Plan".

| ID  | Status | Step                       | Title                                                              | Depends on        | Commit |
|-----|--------|----------------------------|--------------------------------------------------------------------|-------------------|--------|
| 500 | ✅     | Compiled Timeline (1)      | Add authored types and bump schema v2→v3                           | —                 | 5f27ebb |
| 510 | ✅     | Compiled Timeline (2)      | Add compiled types (ClipSpan, TransitionSpan, CompiledTimeline)    | —                 | e0b9b3e |
| 520 | ✅     | Compiled Timeline (3)      | Implement compileTimeline (pure compiler)                          | 500, 510          | 2948bbc |
| 530 | ✅     | Compiled Timeline (4)      | Implement new cameraAt(timeline, t) evaluator                      | 520               | 548bce4 |
| 540 | ✅     | Compiled Timeline (5)      | Switch playhead axis from wall-clock to project-time               | 530               | 3f01001 |
| 550 | ✅     | Compiled Timeline (6)      | Update MapView ease loop to consume cameraAt(timeline, t)          | 530, 540          | 3f01001 |
| 560 | ✅     | Compiled Timeline (7)      | Rework auto-advance, selection, active-clip lookup                 | 540               | ae07cc5 |
| 570 | ✅     | Compiled Timeline (8)      | Delete old wall-clock anchor code (MapAnchor, MapTrack, etc.)      | 550, 560          | eb38179 |
| 580 | ✅     | Compiled Timeline (9)      | Author 600-series export tasks against the compiled timeline       | 570               | —      |
| 590 | ✅     | Compiled Timeline (10)     | Validate end-to-end behavior; capture sign-off report              | 570               | —      |

## Tasks (compiled-timeline export, 600-series) — SUPERSEDED

The original 600-series specified a hidden-Tauri-webview renderer with PNG output. Both choices were reconsidered before any code landed: the renderer venue is now a Node sidecar running native MapLibre, and the output is a raw RGBA stream piped into FFmpeg. The new architecture is captured in [`docs/export/PLAN.md`](../export/PLAN.md); concrete tasks will be re-authored once the layout-system design pass completes. Original task files are preserved under [`tasks/_superseded/`](./tasks/_superseded/) with a README explaining what changed and why.

| ID  | Status       | Step                     | Title                                                                | Depends on | Commit |
|-----|--------------|--------------------------|----------------------------------------------------------------------|------------|--------|
| 600 | ⛔ superseded | Export (1)               | Register `render_map_frames` Tauri command shell                     | 570        | —      |
| 610 | ⛔ superseded | Export (2)               | Hidden `/export-renderer` Tauri window route                         | 600        | —      |
| 620 | ⛔ superseded | Export (3)               | IPC wiring: parent → renderer frame stream                           | 610        | —      |
| 630 | ⛔ superseded | Export (4)               | Per-frame render loop with tile-load determinism check               | 620        | —      |
| 640 | ⛔ superseded | Export (5)               | Render parity verification: rendered frames vs. `cameraAt(timeline, t)` truth | 630 | —      |

### Coupling notes

- **530 + 540 + 550 land together in one PR.** The plan: "The playhead axis switch (step 5) lands in the same PR as the new `cameraAt` (step 4) — splitting causes a half-translated regime." 550 is the only consumer of the new evaluator, so we bundle all three to avoid a throwaway dual-wire shim in MapView.
- 580 was a planning task (no code); it produced the original 600-series tasks, which were subsequently superseded — see [`docs/export/PLAN.md`](../export/PLAN.md).
- The original 600-series chain (600 → 610 → 620 → 630 → 640) is no longer the path forward; new tasks will be authored after the layout-system design pass.

## Hard stops

- After task 590: sign-off on the compiled-timeline preview before resuming export work. **Cleared 2026-05-03** — see [`COMPILED_TIMELINE_VALIDATION_REPORT.md`](./COMPILED_TIMELINE_VALIDATION_REPORT.md) (verdict: PASS, user sign-off).

## Notes

- Critical constraints carried into the 500-series:
  - Authoring is clip-local only — no project-time in `project.json`.
  - The compiler is pure; project-time is fully derived.
  - `MapAnchor` / `MapTrack` are fully replaced, not kept parallel (task 570).
  - Van Wijk primitives, `cameraForBounds`, `resolveIntent`, route indexing, and bearing keyframe math are not to be touched.
  - Schema bump v2 → v3; the existing v1 → v2 migration in `commands/project.rs` is the template.
- Export work (layout / compositing) remains out of scope for the camera migration. Tasks 600+ will cover only camera-side export.
