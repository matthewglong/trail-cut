import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Clip, Route, Project, MapSettings, TransitionFeel } from '../types';

interface AutoSaveParams {
  projectDir: string | null;
  clips: Clip[];
  route: Route | null;
  projectName: string;
  projectThumbnail: string | null;
  mapSettings: MapSettings;
  transitionFeel: TransitionFeel | undefined;
  defaultEaseDurationMs: number | undefined;
}

export function useAutoSave({ projectDir, clips, route, projectName, projectThumbnail, mapSettings, transitionFeel, defaultEaseDurationMs }: AutoSaveParams) {
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
        exports: [],
        map_settings: mapSettings,
        transition_feel: transitionFeel,
        default_ease_duration_ms: defaultEaseDurationMs,
      };
      invoke('save_project', { project, projectDir }).catch(() => {});
      invoke('register_recent_project', { projectDir }).catch(() => {});
    }, 1000);

    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    };
  }, [clips, route, projectDir, projectName, projectThumbnail, mapSettings, transitionFeel, defaultEaseDurationMs]);
}
