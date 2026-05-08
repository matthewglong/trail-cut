import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Clip, Route, Project, ProjectLayouts, MapSettings, TransitionFeel } from '../types';
import { defaultLayout } from '../lib/layout';

interface AutoSaveParams {
  projectDir: string | null;
  clips: Clip[];
  route: Route | null;
  projectName: string;
  projectThumbnail: string | null;
  mapSettings: MapSettings;
  transitionFeel: TransitionFeel | undefined;
  /** Per-aspect layouts (task 080). Always populated post-080 — App-level
   *  state initializes to the seeded shape and the load path backfills any
   *  missing field from disk. */
  projectLayouts: ProjectLayouts;
}

/** Defensive backfill mirroring `useProject`'s + Rust's `seeded_layouts()`.
 *  In normal operation this branch is cold — App-level state always supplies
 *  a populated `ProjectLayouts`. Kept as a safety net so a future regression
 *  (someone passes `undefined` through prop-drilling) doesn't write a
 *  `layouts: undefined` row to disk. */
function ensureLayouts(layouts: ProjectLayouts | undefined): ProjectLayouts {
  if (layouts) return layouts;
  return {
    '9_16': defaultLayout('9_16'),
    '4_5': null,
    '16_9': null,
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
        map_settings: mapSettings,
        transition_feel: transitionFeel,
      };
      invoke('save_project', { project, projectDir }).catch(() => {});
      invoke('register_recent_project', { projectDir }).catch(() => {});
    }, 1000);

    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    };
  }, [clips, route, projectDir, projectName, projectThumbnail, mapSettings, transitionFeel, projectLayouts]);
}
