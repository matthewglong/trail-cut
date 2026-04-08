import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { Clip, Project, Route, TrimRange, FocalPoint, Effects, MapSettings } from '../types';
import { DEFAULT_MAP_SETTINGS } from '../types';

/** Minimum gap (ms) required between the playhead and either trim edge for a
 *  split to be accepted. Below this the split is a no-op, so we never create
 *  zero-length segments from a fat-fingered ⌘B. */
const SPLIT_MIN_GAP_MS = 100;

interface UseProjectParams {
  projectDir: string | null;
  setProjectDir: React.Dispatch<React.SetStateAction<string | null>>;
  clips: Clip[];
  setClips: React.Dispatch<React.SetStateAction<Clip[]>>;
  selectedClipId: string | null;
  setSelectedClipId: React.Dispatch<React.SetStateAction<string | null>>;
  route: Route | null;
  setRoute: React.Dispatch<React.SetStateAction<Route | null>>;
  setMapSettings: React.Dispatch<React.SetStateAction<MapSettings>>;
  generateProxiesAndThumbnails: (clipList: Clip[], dir: string) => Promise<void>;
  setProxies: React.Dispatch<React.SetStateAction<Record<string, string | 'generating' | null>>>;
  setThumbnails: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setImportError: (err: string | null) => void;
  loadRecentProjects: () => Promise<void>;
}

export function useProject({
  projectDir,
  setProjectDir,
  clips,
  setClips,
  selectedClipId,
  setSelectedClipId,
  route: _route,
  setRoute,
  setMapSettings,
  generateProxiesAndThumbnails,
  setProxies,
  setThumbnails,
  setImportError,
  loadRecentProjects,
}: UseProjectParams) {
  const [projectName, setProjectName] = useState('');
  const [projectThumbnail, setProjectThumbnail] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openProjectDir(dir: string) {
    setLoading(true);
    setError(null);
    try {
      const project = await invoke<Project>('load_project', { projectDir: dir });
      setProjectDir(dir);

      const fallbackName = dir.split('/').pop()?.replace('.trailcut', '') ?? 'Untitled';
      setProjectName(project.name || fallbackName);
      setProjectThumbnail(project.thumbnail ?? null);
      setClips(project.clips);
      setRoute(project.route);
      setMapSettings(project.map_settings ?? DEFAULT_MAP_SETTINGS);

      await invoke('register_recent_project', { projectDir: dir });

      if (project.clips.length > 0) {
        setSelectedClipId(project.clips[0].id);
        generateProxiesAndThumbnails(project.clips, dir);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleNewProject() {
    try {
      const selected = await save({
        filters: [{ name: 'TrailCut Project', extensions: ['trailcut'] }],
        defaultPath: 'MyHike.trailcut',
      });
      if (!selected) return;

      await invoke('create_project', { projectDir: selected });
      await invoke('register_recent_project', { projectDir: selected });
      setProjectDir(selected);
      setProjectName(selected.split('/').pop()?.replace('.trailcut', '') ?? 'Untitled');
      setProjectThumbnail(null);
      setClips([]);
      setRoute(null);
      setMapSettings(DEFAULT_MAP_SETTINGS);
      setProxies({});
      setThumbnails({});
      setSelectedClipId(null);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleOpenProject() {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected) return;

      const dir = selected as string;
      if (!dir.endsWith('.trailcut')) {
        setError('Not a TrailCut project. Select a folder ending in .trailcut');
        return;
      }

      await openProjectDir(dir);
    } catch (err) {
      setError(String(err));
    }
  }

  function handleCloseProject() {
    setProjectDir(null);
    setProjectName('');
    setProjectThumbnail(null);
    setClips([]);
    setRoute(null);
    setMapSettings(DEFAULT_MAP_SETTINGS);
    setProxies({});
    setThumbnails({});
    setSelectedClipId(null);
    setError(null);
    setImportError(null);
    loadRecentProjects();
  }

  function handleRemoveClip(clipId: string) {
    setClips((prev) => prev.filter((c) => c.id !== clipId));
    setSelectedClipId((prev) => {
      if (prev !== clipId) return prev;
      const remaining = clips.filter((c) => c.id !== clipId);
      return remaining.length > 0 ? remaining[0].id : null;
    });
  }

  function updateSelectedClip(patch: Partial<Clip>) {
    if (!selectedClipId) return;
    setClips((prev) => prev.map((c) =>
      c.id === selectedClipId ? { ...c, ...patch } : c
    ));
  }

  function handleUpdateTrim(trim: TrimRange) {
    updateSelectedClip({ trim });
  }

  function handleUpdateFocalPoint(focal_point: FocalPoint) {
    updateSelectedClip({ focal_point });
  }

  function handleUpdateEffects(effects: Effects) {
    updateSelectedClip({ effects });
  }

  /** Split the selected clip at the given media-seconds playhead position
   *  (measured from the start of the underlying source, not from trim.in_ms).
   *  The left half keeps the existing id; the right half gets a new random
   *  id and inherits all other fields. No-op if the playhead is outside
   *  the current trim window or within SPLIT_MIN_GAP_MS of either edge. */
  function handleSplitClip(playheadSec: number) {
    const clip = clips.find((c) => c.id === selectedClipId);
    if (!clip || !clip.trim) return;

    const splitMs = playheadSec * 1000;
    if (splitMs <= clip.trim.in_ms + SPLIT_MIN_GAP_MS) return;
    if (splitMs >= clip.trim.out_ms - SPLIT_MIN_GAP_MS) return;

    const newId =
      (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${clip.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const leftHalf: Clip = {
      ...clip,
      trim: { in_ms: clip.trim.in_ms, out_ms: splitMs },
    };
    const rightHalf: Clip = {
      ...clip,
      id: newId,
      trim: { in_ms: splitMs, out_ms: clip.trim.out_ms },
      // Clone nested edit state so later tweaks to one half don't bleed
      // into the other via shared references.
      focal_point: { ...clip.focal_point },
      effects: {
        ...clip.effects,
        stabilize: { ...clip.effects.stabilize },
      },
    };

    setClips((prev) => {
      const idx = prev.findIndex((c) => c.id === clip.id);
      if (idx === -1) return prev;
      const next = prev.slice();
      next.splice(idx, 1, leftHalf, rightHalf);
      return next;
    });
    setSelectedClipId(newId);

    // The new segment shares the same source video, so it can reuse the
    // existing proxy file directly — just mirror the proxy map entry onto
    // the new id.
    setProxies((prev) => {
      const existing = prev[clip.id];
      if (existing == null) return prev;
      return { ...prev, [newId]: existing };
    });

    // Generate a thumbnail at the right half's start frame. Left half keeps
    // its existing thumbnail since its trim.in_ms is unchanged.
    if (projectDir) {
      invoke<string>('generate_thumbnail_at', {
        sourcePath: clip.path,
        atMs: Math.round(splitMs),
        projectDir,
      })
        .then((thumbPath) => {
          setThumbnails((prev) => ({ ...prev, [newId]: thumbPath }));
        })
        .catch(() => {});
    }
  }

  return {
    projectName,
    setProjectName,
    projectThumbnail,
    setProjectThumbnail,
    editingName,
    setEditingName,
    loading,
    error,
    setError,
    openProjectDir,
    handleNewProject,
    handleOpenProject,
    handleCloseProject,
    handleRemoveClip,
    handleUpdateTrim,
    handleUpdateFocalPoint,
    handleUpdateEffects,
    handleSplitClip,
  };
}
