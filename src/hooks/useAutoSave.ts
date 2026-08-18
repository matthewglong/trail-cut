import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type {
  AspectRatio,
  Clip,
  ExportGrid,
  MapMagnifications,
  Route,
  ProjectLayouts,
  MapSettings,
  Project,
  TransitionFeel,
  Waypoint,
} from '../types';
import { buildSavePayload, seededLayouts } from '../lib/projectPersistence';
import { defaultMagnifications } from '../lib/layout';

interface AutoSaveParams {
  projectDir: string | null;
  /** Full deserialized `Project` exactly as `load_project` returned it,
   *  held by App from open until close. Dual purpose:
   *  - the spread base of the canonical save payload, so persisted fields
   *    the editor doesn't manage (`working_color_space`, `start_camera`,
   *    `default_entry_transition`, future schema additions) round-trip
   *    untouched (ship review §1.4a);
   *  - the auto-save arming switch — `null` until an opened project has
   *    fully hydrated, so a half-initialized session can never overwrite a
   *    real `project.json` with empty state. */
  baseProject: Project | null;
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
  /** Per-aspect map magnification. Always populated — App-level state
   *  initializes to the identity record and the load path default-fills a
   *  bundle that omits the field (the common case). */
  mapMagnifications: MapMagnifications;
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
  /** First-class waypoints (schema v7). Always populated — App-level state
   *  initializes to `[]` and the load path seeds from clips when the bundle
   *  lacks the field. */
  waypoints: Waypoint[];
  /** Save-failure channel. Called with a message when `save_project`
   *  rejects (surfaced in the UI error banner — loud failures are a binding
   *  project principle) and with `null` after the next successful save so
   *  the banner self-clears on recovery. Read through a ref internally, so
   *  callers don't need to memoize. */
  onSaveError: (error: string | null) => void;
}

export function useAutoSave({
  projectDir,
  baseProject,
  clips,
  route,
  projectName,
  projectThumbnail,
  mapSettings,
  transitionFeel,
  projectLayouts,
  mapMagnifications,
  selectedExportAspect,
  lastExportSelection,
  waypoints,
  onSaveError,
}: AutoSaveParams) {
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ref-read so an unstable callback identity can't churn the debounce
  // effect below (its deps deliberately track only persisted state).
  const onSaveErrorRef = useRef(onSaveError);
  onSaveErrorRef.current = onSaveError;

  useEffect(() => {
    // Arm only once the opened project's full wire shape has hydrated into
    // `baseProject`. Deliberately NOT gated on `clips.length > 0`: removing
    // the last clip (or editing the route / map settings of a clipless
    // project) is an edit and must persist — the old guard made those edits
    // vanish on reopen (ship review §1.4b).
    if (!projectDir || !baseProject) return;

    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      const project = buildSavePayload(baseProject, {
        projectName,
        projectThumbnail,
        clips,
        route,
        mapSettings,
        transitionFeel,
        projectLayouts: projectLayouts ?? seededLayouts(),
        mapMagnifications: mapMagnifications ?? defaultMagnifications(),
        selectedExportAspect: selectedExportAspect ?? '9_16',
        lastExportSelection,
        waypoints,
      });
      invoke('save_project', { project, projectDir })
        .then(() => onSaveErrorRef.current(null))
        .catch((err) => {
          // Loud failure: the user must know their edits are not on disk.
          console.error('save_project failed:', err);
          onSaveErrorRef.current(
            `Auto-save failed — recent edits are NOT saved to disk: ${String(err)}`,
          );
        });
      invoke('register_recent_project', { projectDir }).catch((err) => {
        // Recents registry is cosmetic (home-screen gallery only) — log
        // loudly but don't block the editor on it.
        console.error('register_recent_project failed:', err);
      });
    }, 1000);

    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    };
  }, [
    baseProject,
    clips,
    route,
    projectDir,
    projectName,
    projectThumbnail,
    mapSettings,
    transitionFeel,
    projectLayouts,
    mapMagnifications,
    selectedExportAspect,
    lastExportSelection,
    waypoints,
  ]);
}
