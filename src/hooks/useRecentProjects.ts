import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { RecentProject } from '../types';
import { useDropdownClose } from './useDropdownClose';

export function useRecentProjects() {
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [cardMenuOpen, setCardMenuOpen] = useState<string | null>(null);
  const [renamingCard, setRenamingCard] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load recent projects on mount
  useEffect(() => {
    invoke<RecentProject[]>('get_recent_projects')
      .then(setRecentProjects)
      .catch(() => {});
  }, []);

  // Close card menu on outside click
  useDropdownClose(!!cardMenuOpen, useCallback(() => setCardMenuOpen(null), []));

  async function loadRecentProjects() {
    try {
      const updated = await invoke<RecentProject[]>('get_recent_projects');
      setRecentProjects(updated);
    } catch {
      // ignore
    }
  }

  async function handleRenameProject(projectPath: string, newName: string) {
    if (!newName.trim()) return;
    try {
      await invoke('rename_project', { projectDir: projectPath, newName: newName.trim() });
      const updated = await invoke<RecentProject[]>('get_recent_projects');
      setRecentProjects(updated);
    } catch (err) {
      setError(String(err));
    }
    setRenamingCard(null);
  }

  async function handleDeleteProject(projectPath: string) {
    try {
      await invoke('delete_project', { projectDir: projectPath });
      const updated = await invoke<RecentProject[]>('get_recent_projects');
      setRecentProjects(updated);
    } catch (err) {
      setError(String(err));
    }
    setDeleteConfirm(null);
  }

  return {
    recentProjects,
    cardMenuOpen,
    setCardMenuOpen,
    renamingCard,
    setRenamingCard,
    renameDraft,
    setRenameDraft,
    deleteConfirm,
    setDeleteConfirm,
    error,
    setError,
    loadRecentProjects,
    handleRenameProject,
    handleDeleteProject,
  };
}
