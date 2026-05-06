# Export pipeline — task index

Concrete task files for the export pipeline architected in [`../PLAN.md`](../PLAN.md) and [`../LAYOUT.md`](../LAYOUT.md).

These tasks replace the superseded 600-series under `docs/migration/tasks/_superseded/`. The migration's 500-series locked in `cameraAt(timeline, t)` as the single source of camera truth; the export pipeline tasks below extend the same principle to all visual decisions and to the FFmpeg / encoder / layout pipeline.

## Status legend

- ⬜ pending
- 🟡 in-progress
- ✅ done
- ⛔ blocked

## Sequence

| ID  | Status | Title                                                                           | Depends on |
|-----|--------|---------------------------------------------------------------------------------|------------|
| 010 | ⬜     | [Shared `mapVisuals` module + MapView refactor](./010-shared-mapvisuals-module.md) | —          |
| 020 | ⬜     | Renderer worker (Node + maplibre-native + stdio protocol)                       | 010        |
| 030 | ⬜     | Rust orchestrator skeleton (spawn + frame distribution + ordering)              | 020        |
| 040 | ⬜     | Encoder probing + selection                                                     | —          |
| 050 | ⬜     | Layout descriptor types in TS + Rust; project-schema migration                  | —          |
| 060 | ⬜     | Channel B (map-only) end-to-end                                                 | 030, 040, 050 |
| 070 | ⬜     | Channel C (video-only) end-to-end                                               | 030, 040, 050 |
| 080 | ⬜     | First concrete layout (9:16 PiP-bottom-right baseline)                          | 050        |
| 090 | ⬜     | Channel A (composite) end-to-end                                                | 060, 070, 080 |
| 100 | ⬜     | Additional layouts + aspects (Split mode; 16:9 and 4:5)                         | 080        |
| 110 | ⬜     | Layout configurator UI                                                          | 050        |
| 120 | ⬜     | Render parity verification (preview vs. export at sampled `t`)                  | 090        |
| 130 | ⬜     | Sidecar bundling + Windows distribution                                         | 020, 030, 040 |

Tasks beyond 010 are not yet authored; they will be written as the preceding tasks land and the implementation surface stabilizes.

## Why a foundational 010 before the renderer worker

The original "Next tasks" sequence in PLAN.md started with the renderer worker. While scoping that task, a gap surfaced: PLAN.md's IPC contract treated the worker as a thin pixel-renderer that received a `style_url` and a static `route_geojson`, but `MapView.tsx` actually composes a much richer visual surface (3 style modes, two route layers, waypoints, active-clip highlighting, an animated live marker, conditional 3D buildings). Implementing the worker per the original IPC would silently produce export frames that diverged from the preview.

The fix is structural: every visual decision becomes single-sourced in a TypeScript module both runtimes consume. Task 010 lands that module and refactors `MapView.tsx` to use it; task 020 (renderer worker) then becomes a thin shell that imports from the same module. The "Single source of visual truth" principle now in PLAN.md §"Constraints and principles" makes this the load-bearing invariant for the whole export pipeline.
