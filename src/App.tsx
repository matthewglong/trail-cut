import { useState, useEffect } from 'react';
import HomeScreen from './screens/HomeScreen';
import ProjectView from './screens/ProjectView';
import CameraSpikeHarness from './dev/CameraSpikeHarness';
import { useProject } from './hooks/useProject';
import { useMediaImport } from './hooks/useMediaImport';
import { useAutoSave } from './hooks/useAutoSave';
import { useRecentProjects } from './hooks/useRecentProjects';
import type { Clip, Route, MapSettings } from './types';
import { DEFAULT_MAP_SETTINGS } from './types';

/** Dev-only: when the URL has `?camera-spike=1`, mount the spike harness
 *  instead of ProjectView. Used to A/B-test the new cameraIntent pipeline
 *  against the existing imperative MapView. See task 140 / §6.1. */
const CAMERA_SPIKE_ENABLED =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('camera-spike') === '1';

export default function App() {
  // Shared state lifted here to break the circular dependency
  // between useProject and useMediaImport
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [mapSettings, setMapSettings] = useState<MapSettings>(DEFAULT_MAP_SETTINGS);
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);

  const recent = useRecentProjects();

  const media = useMediaImport({
    projectDir,
    setClips,
    setSelectedClipId,
    setRoute,
  });

  const project = useProject({
    projectDir,
    setProjectDir,
    clips,
    setClips,
    selectedClipId,
    setSelectedClipId,
    route,
    setRoute,
    setMapSettings,
    generateProxiesAndThumbnails: media.generateProxiesAndThumbnails,
    setProxies: media.setProxies,
    setThumbnails: media.setThumbnails,
    setImportError: media.setError,
    loadRecentProjects: recent.loadRecentProjects,
  });

  useAutoSave({
    projectDir,
    clips,
    route,
    projectName: project.projectName,
    projectThumbnail: project.projectThumbnail,
    mapSettings,
  });

  // Auto-default project thumbnail to first clip's thumbnail
  useEffect(() => {
    if (project.projectThumbnail) return;
    const firstClip = clips[0];
    if (firstClip && media.thumbnails[firstClip.id]) {
      project.setProjectThumbnail(media.thumbnails[firstClip.id]);
    }
  }, [clips, media.thumbnails, project.projectThumbnail]);

  const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null;
  const hasProject = projectDir !== null;

  // Combine errors
  const error = project.error || media.error || recent.error;
  const dismissError = () => {
    project.setError(null);
    media.setError(null);
    recent.setError(null);
  };

  // Dev spike harness — bypasses ProjectView entirely. Only kicks in when a
  // project is already open so the harness has clips/route to feed. The home
  // screen still shows when no project is open even if the query param is set.
  if (CAMERA_SPIKE_ENABLED && hasProject) {
    return (
      <CameraSpikeHarness
        clips={clips}
        route={route}
        mapSettings={mapSettings}
        onClose={project.handleCloseProject}
      />
    );
  }

  if (!hasProject) {
    return (
      <HomeScreen
        recentProjects={recent.recentProjects}
        error={error}
        cardMenuOpen={recent.cardMenuOpen}
        setCardMenuOpen={recent.setCardMenuOpen}
        renamingCard={recent.renamingCard}
        setRenamingCard={recent.setRenamingCard}
        renameDraft={recent.renameDraft}
        setRenameDraft={recent.setRenameDraft}
        deleteConfirm={recent.deleteConfirm}
        setDeleteConfirm={recent.setDeleteConfirm}
        onNewProject={project.handleNewProject}
        onOpenProject={project.handleOpenProject}
        onOpenProjectDir={project.openProjectDir}
        onRenameProject={recent.handleRenameProject}
        onDeleteProject={recent.handleDeleteProject}
        onDismissError={dismissError}
      />
    );
  }

  return (
    <ProjectView
      projectName={project.projectName}
      setProjectName={project.setProjectName}
      editingName={project.editingName}
      setEditingName={project.setEditingName}
      clips={clips}
      setClips={setClips}
      selectedClip={selectedClip}
      selectedClipId={selectedClipId}
      setSelectedClipId={setSelectedClipId}
      route={route}
      setRoute={setRoute}
      mapSettings={mapSettings}
      setMapSettings={setMapSettings}
      playheadMs={playheadMs}
      setPlayheadMs={setPlayheadMs}
      proxies={media.proxies}
      thumbnails={media.thumbnails}
      loading={project.loading || media.loading}
      error={error}
      onDismissError={dismissError}
      onCloseProject={project.handleCloseProject}
      onRemoveClip={project.handleRemoveClip}
      onSplitClip={project.handleSplitClip}
      onUpdateTrim={project.handleUpdateTrim}
      onUpdateFocalPoint={project.handleUpdateFocalPoint}
      onUpdateEffects={project.handleUpdateEffects}
      onImportFiles={media.handleImportFiles}
      onImportFolder={media.handleImportFolder}
      onImportGpx={media.handleImportGpx}
    />
  );
}
