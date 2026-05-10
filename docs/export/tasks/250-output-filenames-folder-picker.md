# Task 250 — Output filename derivation + folder picker

**Step**: Layout & Export UI (export track)
**Estimated effort**: ~0.5 day
**Status**: pending
**Depends on**: 240
**Companion plan**: `docs/export/plans/layout-ui.md` §5

## Goal

Replace per-job save dialogs with a single folder picker. After this task:

- Export modal has an "Output folder" row with the selected path + a "Choose…" button that opens Tauri's directory dialog.
- Filenames are derived deterministically from project name + aspect + channel — no per-file naming UI.
- The derivation logic is a pure helper (testable; no IO).

## Files to touch

- **New** `src/lib/exportFilenames.ts` — pure helpers:
  ```ts
  export function deriveFilename(
    projectName: string,
    aspect: AspectRatio,
    channel: ExportChannel,
  ): string;

  export function deriveJobs(
    projectName: string,
    outputDir: string,
    selection: ExportSelection,
  ): ExportJob[];
  ```
  Filenames: `{slug(projectName)}-{aspect}-{channel}.{ext}`. Extensions: composite → `.mp4`; map_only / video_only → `.mov`. Slug: lowercase, replace whitespace + non-alphanumeric with `-`, collapse dashes.
- **New** `src/lib/__tests__/exportFilenames.test.ts`.
- **Modified** `src/components/ExportModal/ExportModal.tsx`:
  - Add output-folder row using `@tauri-apps/plugin-dialog`'s `open({ directory: true })`.
  - Display chosen path; persist locally in component state (persistence to disk lands in 280).
  - Render-button enable rule: `selection.aspects.length > 0 && selection.channels.length > 0 && outputFolder != null`.
- **Modified** `src/components/ExportModal/JobSummary.tsx`:
  - Show derived filenames preview: collapse to first 3 + "and N more" when n_jobs > 4.

## Edge cases

- **Project name with weird characters**: `"My Hike: 2026/04 🌲"` → `my-hike-2026-04`. Drop emoji and punctuation entirely.
- **Empty derived slug** (project name was all symbols): fall back to `trailcut-export`.
- **Folder path with spaces**: dialog returns absolute path; passed verbatim to render dispatch later. No escaping needed in the frontend.

## Acceptance

- [ ] Output folder row in modal; "Choose…" opens directory picker.
- [ ] Selected path shown in modal.
- [ ] Render button enable state respects all three conditions (aspects, channels, folder).
- [ ] Job summary previews derived filenames.

## Tests

- `exportFilenames.test.ts`: slug edge cases; extension by channel; deterministic ordering of jobs.
- Manual: pick a folder; confirm path renders; toggle selections to verify enable/disable transitions.
