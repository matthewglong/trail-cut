import { useState, useEffect } from 'react';
import HomeScreen from './screens/HomeScreen';
import ProjectView from './screens/ProjectView';
import { useProject } from './hooks/useProject';
import { useMediaImport } from './hooks/useMediaImport';
import { useAutoSave } from './hooks/useAutoSave';
import { useRecentProjects } from './hooks/useRecentProjects';
import type { Clip, Route } from './types';

export default function App() {
  // Shared state lifted here to break the circular dependency
  // between useProject and useMediaImport
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [route, setRoute] = useState<Route | null>(null);

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
      proxies={media.proxies}
      thumbnails={media.thumbnails}
      loading={project.loading || media.loading}
      error={error}
      onDismissError={dismissError}
      onCloseProject={project.handleCloseProject}
      onRemoveClip={project.handleRemoveClip}
      onUpdateTrim={project.handleUpdateTrim}
      onUpdateFocalPoint={project.handleUpdateFocalPoint}
      onUpdateEffects={project.handleUpdateEffects}
      onImportFiles={media.handleImportFiles}
      onImportFolder={media.handleImportFolder}
      onImportGpx={media.handleImportGpx}
    />
  );
}
