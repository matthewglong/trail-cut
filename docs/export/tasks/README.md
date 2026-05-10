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
| 010 | ✅     | [Shared `mapVisuals` module + MapView refactor](./010-shared-mapvisuals-module.md) | —          |
| 020 | ✅     | [Renderer worker (Node + maplibre-native + stdio protocol)](./020-renderer-worker.md) | 010        |
| 030 | ✅     | [Rust orchestrator skeleton (spawn + frame distribution + ordering)](./030-orchestrator-skeleton.md) | 020        |
| 035 | ✅     | [Shared on-disk tile cache](./035-shared-tile-cache.md)                         | 020        |
| 040 | ✅     | [Encoder probing + selection](./040-encoder-probing.md)                         | —          |
| 050 | ✅     | [Layout descriptor types in TS + Rust; project-schema migration](./050-layout-descriptor-types.md) | —          |
| 060 | ✅     | [Channel B (map-only) end-to-end](./060-channel-b-map-only.md)                  | 030, 040, 050 |
| 070 | ✅     | [Channel C (video-only) end-to-end](./070-channel-c-video-only.md)              | 030, 040, 050 |
| 080 | ✅     | [First concrete layout (9:16 PiP-bottom-right baseline)](./080-first-concrete-layout.md) | 050        |
| 090 | ✅     | [Channel A (composite) end-to-end](./090-channel-a-composite.md)                | 060, 070, 080 |
| 100 | ✅     | [Additional layouts + aspects (Split mode; 4:5 and 16:9)](./100-additional-layouts-and-aspects.md) | 050, 060, 070, 080, 090 |
| 110 | ✅     | [Layout configurator (interactive editing of `LayoutConfig`)](./110-layout-configurator.md) | 050, 080, 100 |
| 115 | ✅     | [Chromium renderer sidecar (build alongside native, do not route)](./115-chromium-renderer-sidecar.md) | 010, 020, 030, 035 |
| 116 | ✅     | [Orchestrator renderer toggle (`TRAILCUT_RENDERER` env flag)](./116-orchestrator-renderer-toggle.md) | 115 |
| 117 | ✅     | [Golden-frame parity test (wobble-fix regression guard)](./117-golden-frame-parity.md) | 115, 116 |
| 118 | ✅     | [Cut over default renderer to chromium; bundle headless-shell](./118-renderer-cutover.md) | 115, 116, 117 |
| 119 | ✅     | [Remove maplibre-native renderer; rename chromium → renderer](./119-remove-native-renderer.md) | 118 |
| 120 | ⬜     | Render parity verification (preview vs. export at sampled `t`)                  | 090, 119   |
| 130 | ⬜     | Sidecar bundling + Windows distribution                                         | 020, 030, 040, 119 |
| 200 | ⬜     | [Map Positioning modal shell](./200-map-positioning-modal-shell.md)             | —          |
| 210 | ⬜     | [Map Positioning modal contents (3-pane preview + controls)](./210-map-positioning-modal-contents.md) | 200 |
| 220 | ⬜     | [Snap tuning + visual feedback](./220-snap-tuning-visual-feedback.md)           | 210        |
| 230 | ⬜     | [Replace LayoutConfigurator overlay; remove temp aspect select](./230-replace-overlay-remove-temp-aspect-select.md) | 210, 220 |
| 240 | ⬜     | [Export modal scaffold (UI only)](./240-export-modal-scaffold.md)               | —          |
| 250 | ⬜     | [Output filename derivation + folder picker](./250-output-filenames-folder-picker.md) | 240    |
| 260 | ⬜     | [Time-estimate computation](./260-time-estimate.md)                             | 250        |
| 270 | ⬜     | [Frontend render queue (sequential dispatch + progress UI)](./270-render-queue.md) | 240, 250 |
| 280 | ⬜     | [Persist `last_export_selection` in `project.json`](./280-persist-last-export-selection.md) | 270 |
| 290 | ⬜     | [Remove temp export buttons; final cutover](./290-remove-temp-export-buttons.md) | 270, 280  |

Tasks 115–119 implement the renderer migration plan in [`../plans/chromium-renderer.md`](../plans/chromium-renderer.md): replace the wobble-prone `@maplibre/maplibre-gl-native` worker with a headless-Chromium + `maplibre-gl-js` worker. Each task is one PR-sized step and leaves the app working.

Tasks 200–290 implement the layout & export UI plan in [`../plans/layout-ui.md`](../plans/layout-ui.md): a Map Positioning modal triggered from `MapToolbar` (200–230), and a single-button Export flow with a sequential render queue (240–290). Two tracks; 230 closes the positioning track; 290 is the final cutover that removes the dev-grade export buttons.

Tasks 120–130 are not yet authored; they will be written as the preceding tasks land. 130 in particular slots in after 119 to handle Windows distribution against the now-Chromium-based renderer.

## Why a foundational 010 before the renderer worker

The original "Next tasks" sequence in PLAN.md started with the renderer worker. While scoping that task, a gap surfaced: PLAN.md's IPC contract treated the worker as a thin pixel-renderer that received a `style_url` and a static `route_geojson`, but `MapView.tsx` actually composes a much richer visual surface (3 style modes, two route layers, waypoints, active-clip highlighting, an animated live marker, conditional 3D buildings). Implementing the worker per the original IPC would silently produce export frames that diverged from the preview.

The fix is structural: every visual decision becomes single-sourced in a TypeScript module both runtimes consume. Task 010 lands that module and refactors `MapView.tsx` to use it; task 020 (renderer worker) then becomes a thin shell that imports from the same module. The "Single source of visual truth" principle now in PLAN.md §"Constraints and principles" makes this the load-bearing invariant for the whole export pipeline.
