# Task 240 — Export modal scaffold (UI only)

**Step**: Layout & Export UI (export track)
**Estimated effort**: ~1 day
**Status**: pending
**Depends on**: —
**Companion plan**: `docs/export/plans/layout-ui.md` §4

## Goal

Build the Export modal UI without wiring it to any render dispatch. After this task:

- A new "Export" button in the top toolbar (alongside the three temp export buttons — temps remain until 290).
- Click opens an `ExportModal` with the spec'd sections: aspect checkboxes, channel toggles, schematic icons, job summary line, output destination row, Render + Cancel buttons.
- Render button is disabled (no dispatch wired yet).
- Closes on Esc / backdrop click / Cancel.

## Files to touch

- **New** `src/components/ExportModal/ExportModal.tsx` — controlled (`open`, `onClose`, `selection`, `onSelectionChange`).
- **New** `src/components/ExportModal/AspectCheckboxes.tsx` — multi-select for `9_16`, `4_5`, `16_9`.
- **New** `src/components/ExportModal/ChannelToggles.tsx` — multi-select for `composite`, `map_only`, `video_only`.
- **New** `src/components/ExportModal/ChannelSchematic.tsx` — small static icon per channel (composite shows map+video composited per first selected aspect; map-only shows map block; video-only shows video block).
- **New** `src/components/ExportModal/JobSummary.tsx` — derives `n_jobs = aspects.length × channels.length`; renders a sentence like *"3 files: 9:16 composite, 9:16 map, 9:16 video."* Time estimate placeholder lands in 260.
- **New** `src/components/ExportModal/index.ts` + tests.
- **Modified** `src/screens/ProjectView.tsx`:
  - `[exportModalOpen, setExportModalOpen]` state.
  - Local `[exportSelection, setExportSelection]` (default `{ aspects: [], channels: [] }`).
  - New "Export" button in top toolbar opens the modal.

## Selection types

```ts
// src/types.ts
export type ExportChannel = 'composite' | 'map_only' | 'video_only';

export interface ExportSelection {
  aspects: AspectRatio[];
  channels: ExportChannel[];
}
```

## Acceptance

- [ ] Export button visible in toolbar; opens modal.
- [ ] All three sections render; checkboxes / toggles update local selection state.
- [ ] Job summary line updates live as selection changes (e.g. "0 files" when nothing selected, "9 files" when everything checked).
- [ ] Render button disabled (with tooltip "wiring lands in 270").
- [ ] Modal dismisses via Esc / backdrop / Cancel.
- [ ] No render dispatch happens yet.

## Tests

- `ExportModal.test.tsx`: opens/closes; selection state updates; summary count is correct for each combination.
- `JobSummary.test.tsx`: cartesian product math.
- Manual: open modal, click around, confirm summary text matches selection.
