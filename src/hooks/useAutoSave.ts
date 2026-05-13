import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type {
  AspectRatio,
  Clip,
  ExportGrid,
  Route,
  Project,
  ProjectLayouts,
  MapSettings,
  TransitionFeel,
} from '../types';
import { defaultPipLayout } from '../lib/layout';

interface AutoSaveParams {
  projectDir: string | null;
  clips: Clip[];
  route: Route | null;
  projectName: string;
  projectThumbnail: string | null;
  mapSettings: MapSettings;
  transitionFeel: TransitionFeel | undefined;
  /** Per-aspect layouts (task 080 / 100). Always populated — App-level
   *  state initializes to the seeded shape (all three aspects via 100) and
   *  the load path backfills missing entries on read. */
  projectLayouts: ProjectLayouts;
  /** Selected export aspect (task 100). App-level state always supplies a
   *  value; `undefined` here only triggers on a prop-drilling regression and
   *  the defensive backfill below maps it to `'9_16'`. */
  selectedExportAspect: AspectRatio | undefined;
  /** Last user-confirmed Export modal selection. `null` until the user
   *  completes a successful export; the Export modal writes a new value via
   *  its `onSelectionPersist` callback, which flows up to App state and
   *  lands here on the next auto-save cycle. Schema v6 uses the grid shape
   *  (3×3 cells × N configs each) — see `ExportGrid` in `types.ts`. */
  lastExportSelection: ExportGrid | null;
}

/** Defensive backfill mirroring `useProject`'s + Rust's `seeded_layouts()`.
 *  In normal operation this branch is cold — App-level state always supplies
 *  a populated `ProjectLayouts`. Kept as a safety net so a future regression
 *  (someone passes `undefined` through prop-drilling) doesn't write a
 *  `layouts: undefined` row to disk. 100 expanded the seeded shape from
 *  "9:16 only" to "all three aspects", matching `seeded_layouts()` in
 *  `src-tauri/src/models.rs`. */
function ensureLayouts(layouts: ProjectLayouts | undefined): ProjectLayouts {
  if (layouts) return layouts;
  return {
    '9_16': defaultPipLayout('9_16'),
    '4_5': defaultPipLayout('4_5'),
    '16_9': defaultPipLayout('16_9'),
  };
}

export function useAutoSave({
  projectDir,
  clips,
  route,
  projectName,
  projectThumbnail,
  mapSettings,
  transitionFeel,
  projectLayouts,
  selectedExportAspect,
  lastExportSelection,
}: AutoSaveParams) {
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!projectDir || clips.length === 0) return;

    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      const project: Project = {
        version: 1,
        name: projectName,
        thumbnail: projectThumbnail,
        clips,
        route,
        layouts: ensureLayouts(projectLayouts),
        selected_export_aspect: selectedExportAspect ?? '9_16',
        map_settings: mapSettings,
        transition_feel: transitionFeel,
        last_export_selection: lastExportSelection,
      };
      invoke('save_project', { project, projectDir }).catch(() => {});
      invoke('register_recent_project', { projectDir }).catch(() => {});
    }, 1000);

    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    };
  }, [
    clips,
    route,
    projectDir,
    projectName,
    projectThumbnail,
    mapSettings,
    transitionFeel,
    projectLayouts,
    selectedExportAspect,
    lastExportSelection,
  ]);
}
