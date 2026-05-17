# Task 280 — Persist `last_export_selection` in `project.json`

**Step**: Layout & Export UI (export track)
**Estimated effort**: ~0.5 day
**Status**: pending
**Depends on**: 270
**Companion plan**: `docs/export/plans/layout-ui.md` §4 (defaults), §5 (data model)

## Goal

Remember the user's last successful export selection per project. After this task:

- On Export modal open: prefill aspects + channels + output folder from `project.last_export_selection` if present.
- On successful queue completion (or partial — at least one done job), write the current selection back to the project.
- Schema bump: `Project` gains `last_export_selection: Option<ExportSelection>`.

## Files to touch

### Rust

- **Modified** `src-tauri/src/models.rs`:
  ```rust
  #[derive(Serialize, Deserialize, Debug, Clone)]
  pub struct ExportSelection {
      pub aspects: Vec<AspectRatio>,
      pub channels: Vec<ExportChannel>,
      pub output_dir: Option<PathBuf>,
  }

  pub struct Project {
      // ... existing ...
      #[serde(default)]
      pub last_export_selection: Option<ExportSelection>,
  }
  ```
  `#[serde(default)]` so existing project files load cleanly.
- **Modified** `src-tauri/src/commands.rs`:
  - `save_project` / `load_project` already serialize the full project; no command change required, just verify round-trip.
- Schema version bump in `Project::SCHEMA_VERSION` (or wherever it lives) — minor bump, no migration required given the `Option`.

### TypeScript

- **Modified** `src/types.ts`:
  ```ts
  export interface ExportSelection {
    aspects: AspectRatio[];
    channels: ExportChannel[];
    output_dir: string | null;
  }
  export interface Project {
    // ...
    last_export_selection: ExportSelection | null;
  }
  ```
- **Modified** `src/components/ExportModal/ExportModal.tsx`:
  - On `open` transition `false → true`: initialize local selection from `project.last_export_selection ?? { aspects: [], channels: [], output_dir: null }`.
  - On queue `done` (any successful job): bubble up a `onSelectionPersist(selection)` callback.
- **Modified** `src/screens/ProjectView.tsx`:
  - Pass `lastExportSelection={project.last_export_selection}` to `<ExportModal>`.
  - Implement `onSelectionPersist` to update project state; auto-save handles disk write.

## Acceptance

- [ ] Existing project files (without `last_export_selection`) load without errors.
- [ ] After a successful export, reopen modal — selection (aspects, channels, folder) is prefilled.
- [ ] Editing selection mid-flow does not write to disk; persistence happens only on queue completion.
- [ ] Round-trip through save/load preserves selection exactly.

## Tests

- Rust: serde round-trip for `ExportSelection`; backward-compat load of a project file without the field.
- TS: `ExportModal.test.tsx` initializes from `lastExportSelection` prop; persist callback fires on done.
- Manual: export, reopen project, reopen modal, confirm prefill; export with empty selection should not be possible (Render disabled).
