# WS5 — Export UI: Delivery Target Selection

**Phase:** 1
**Blocks:** none
**Blocked by:** WS4 (UI calls the delivery formulas)
**Estimated scope:** medium — React component changes, state plumbing

## Goal

Replace (or augment) the current export UI with a two-dimensional choice: **channel** (composite / map-only / video-only) × **delivery target** (TikTok, IG Reels, IG square, YouTube SDR, YouTube HDR, ProRes master). Support multi-select for batch export.

## Context

Read first:
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — delivery target list.
- [`../background/design-decisions.md`](../background/design-decisions.md) — Decision 2 (per-export delivery target).
- [`WS4-delivery-transforms.md`](WS4-delivery-transforms.md) — the formulas this UI will dispatch.

Current state: existing export UI has a channel selection (composite / map-only / video-only). There is no delivery target concept in the UI today.

## Files to modify

| File | Change |
|---|---|
| `src/components/<wherever the export modal lives>` | Add delivery target picker (single or multi-select). |
| `src/types.ts` | Already has `DeliveryTarget` from WS4. |
| App-level export call site | Pass selected target(s) to `render_export` Tauri command. |
| `src-tauri/src/export/mod.rs` | `render_export` already accepts the target from WS4; ensure batch export iterates targets if multi-select. |

Find the existing export modal first. Likely `src/components/ExportModal.tsx` or similar. Read the current shape before redesigning.

## Implementation

### UI shape

The export modal should present:

1. **Channel** (existing): composite / map-only / video-only. Use existing component if it exists.
2. **Delivery target(s)** (new): a list of checkbox/toggle cards or a multi-select chip group:
   - TikTok / IG Reels (1080×1920, SDR)
   - Instagram feed (1080×1080, SDR)
   - YouTube 4K SDR (3840×2160, BT.709)
   - YouTube 4K HDR (3840×2160, HLG)
   - ProRes master (project-aspect, archival)
3. **Output directory** (existing).
4. **Export button**: triggers one render per selected target. Filename pattern: `<project>-<target>.<ext>` (e.g., `Trail-Run-2026-05-20-tiktok.mp4`).

Disable invalid combinations per the compatibility matrix in [WS4](WS4-delivery-transforms.md#4-channel--target-compatibility-matrix):
- Map-only and Video-only channels: only ProRes master is selectable.
- Composite channel: all targets selectable.

### Defaults

- Composite + first-time-export → `social_sdr_vertical` pre-selected.
- Map-only / Video-only → `prores_master` pre-selected and locked.
- Persist last-used target selection per project (in the project's JSON, not global).

### Progress UI

Multi-target export should show per-target progress (e.g., "TikTok: rendering frame 200/1800", "YouTube HDR: queued"). Render targets sequentially (not in parallel — too I/O heavy).

### Educational copy

For HDR target, add a brief tooltip or info icon:
> "HDR exports are tagged for HLG playback on YouTube. The preview in TrailCut shows the SDR equivalent — your HDR file will look brighter and more vivid on compatible displays."

For SDR HDR-source content, no special message needed.

## Acceptance criteria

- [ ] All five targets are selectable from the export UI.
- [ ] Multi-select works: picking TikTok + YouTube HDR produces two output files.
- [ ] Compatibility constraints are enforced (can't pick TikTok when Channel = Map-only).
- [ ] Last-used target selection persists across app restarts (project-scoped).
- [ ] Per-target progress is visible during batch export.
- [ ] HDR target shows the educational tooltip.
- [ ] Existing single-target export workflow still works (no regression for users who only export to one target).
- [ ] Tauri command signature is backward-compatible (or old call sites updated).

## Out of scope

- Custom delivery targets (user-defined resolution/codec). Defer indefinitely.
- Parallel multi-target render (sequential is fine for now).
- Delivery target presets per social platform beyond the five listed.

## References

- [`WS4-delivery-transforms.md`](WS4-delivery-transforms.md) — formulas this UI dispatches.
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — delivery target table.
