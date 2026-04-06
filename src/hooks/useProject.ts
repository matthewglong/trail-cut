import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { Clip, Project, Route, TrimRange, FocalPoint, Effects } from '../types';

interface UseProjectParams {
  projectDir: string | null;
  setProjectDir: React.Dispatch<React.SetStateAction<string | null>>;
  clips: Clip[];
  setClips: React.Dispatch<React.SetStateAction<Clip[]>>;
  selectedClipId: string | null;
  setSelectedClipId: React.Dispatch<React.SetStateAction<string | null>>;
  route: Route | null;
  setRoute: React.Dispatch<React.SetStateAction<Route | null>>;
  generateProxiesAndThumbnails: (clipList: Clip[], dir: string) => Promise<void>;
  setProxies: React.Dispatch<React.SetStateAction<Record<string, string | 'generating' | null>>>;
  setThumbnails: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setImportError: (err: string | null) => void;
  loadRecentProjects: () => Promise<void>;
}

export function useProject({
  projectDir: _projectDir,
  setProjectDir,
  clips,
  setClips,
  selectedClipId,
  setSelectedClipId,
  route: _route,
  setRoute,
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
  };
}
