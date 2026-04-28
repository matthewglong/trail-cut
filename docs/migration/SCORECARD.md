# Camera Architecture Migration — Scorecard

Branch: `migration/cameraAt`
Source plan: [docs/MAP_ARCHITECTURE_MIGRATION.md](../MAP_ARCHITECTURE_MIGRATION.md)

## Status legend

- ⬜ pending
- 🟡 in-progress
- ✅ done
- ⛔ blocked
- 🛑 hard-stop (awaiting user)

## Tasks

| ID  | Status | Step              | Title                                                              | Depends on        | Commit |
|-----|--------|-------------------|--------------------------------------------------------------------|-------------------|--------|
| 001 | ⬜     | Setup             | Install and configure Vitest                                       | —                 | —      |
| 010 | ⬜     | Setup             | Scaffold src/lib/cameraIntent.ts with type definitions             | —                 | —      |
| 100 | ⬜     | 1 (Spike)         | Implement pure cameraForBounds helper                              | 010               | —      |
| 110 | ⬜     | 1 (Spike)         | Implement Van Wijk arc primitives                                  | 010               | —      |
| 120 | ⬜     | 1 (Spike)         | Implement buildMapTrack, cameraAt, liveIntent                      | 010               | —      |
| 130 | ⬜     | 1 (Spike)         | Implement resolveIntent and interpolateAnchors                     | 100, 110, 120     | —      |
| 140 | 🛑     | 1 (Spike)         | Build CameraSpikeHarness with two-pane preview (HARD STOP)         | 100, 110, 120, 130| —      |
| 200 | ⬜     | 2 (route tests)   | Scaffold routeLocation test file structure                         | 001               | —      |
| 210 | ⬜     | 2 (route tests)   | Tests for parseTimestamp, indexRoute, locationAt                   | 200               | —      |
| 220 | ⬜     | 2 (route tests)   | Tests for trailUpTo, clipWaypointLocation, forwardAzimuth          | 200               | —      |
| 230 | ⬜     | 2 (route tests)   | Tests for bearing math (90% coverage gate)                         | 200               | —      |
| 300 | ⬜     | 3 (MapView)       | Build MapTrack in ProjectView and pass to MapView                  | 120, 230          | —      |
| 310 | ⬜     | 3 (MapView)       | Replace Writers 1, 4, 5, 6 with the live ease loop                 | 300               | —      |
| 320 | ⬜     | 3 (MapView)       | Convert Writer 3 (full-route fitBounds) to a region intent         | 300, 310          | —      |
| 330 | ⬜     | 3 (MapView)       | Delete the six cross-effect refs and all recordEvent calls         | 310, 320          | —      |
| 340 | ⬜     | 3 (MapView)       | Delete useMapRecorder hook, recorder prop, and Debug popover       | 330               | —      |
| 350 | ⬜     | 3 (Persistence)   | Add transition_feel field to Project (frontend + Rust)             | 010               | —      |
| 360 | ⬜     | 3 (Persistence)   | Add schema_version and v1→v2 migration logic                       | 350               | —      |
| 370 | ⬜     | 3 (Persistence)   | Drop persisted route from project.json; re-parse on load           | 360               | —      |
| 400 | ⬜     | 4 (Export)        | Add render_map_frames Tauri command shell                          | 360               | —      |
| 410 | ⬜     | 4 (Export)        | Build hidden /export-renderer Tauri window route                   | 400               | —      |
| 420 | ⬜     | 4 (Export)        | Wire IPC: parent → renderer sends (track, layout_per_frame, fps)   | 410               | —      |
| 430 | ⬜     | 4 (Export)        | Per-frame render loop with tile-load determinism check             | 420               | —      |
| 440 | ⬜     | 4 (Export)        | Pass criterion test: render 30-frame sequence for a real project   | 430               | —      |

## Hard stops

- After task 140: human visual-parity review of the spike (per §6.1 pass criteria A and B). Do NOT proceed to Step 2/3/4 until the user signs off.

## Notes

- Pre-existing TS errors (fixed in commit 2a98cdf) — see [PREEXISTING_ERRORS.md](PREEXISTING_ERRORS.md)
- After Step 4: stop. Step 5 (layout/compositing) is out of scope.
- §8 open questions are mapped to tasks: §8.1 → 430, §8.2 → 140, §8.3 → 340.
- Persistence work (§3.9) is split into 350/360/370 — independent of the camera surface, can land in parallel with Step 3 MapView refactor.
