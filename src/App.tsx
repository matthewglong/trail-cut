import { useEffect } from 'react';
import HomeScreen from './screens/HomeScreen';
import ProjectView from './screens/ProjectView';
import { useProject } from './hooks/useProject';
import { useMediaImport } from './hooks/useMediaImport';
import { useAutoSave } from './hooks/useAutoSave';
import { useRecentProjects } from './hooks/useRecentProjects';

export default function App() {
  const recent = useRecentProjects();

  const media = useMediaImport({
    projectDir: null, // will be set after project hook initializes
    setClips: () => {},
    setSelectedClipId: () => {},
    setRoute: () => {},
  });

  const project = useProject({
    generateProxiesAndThumbnails: media.generateProxiesAndThumbnails,
    setProxies: media.setProxies,
    setThumbnails: media.setThumbnails,
    setImportError: media.setError,
    loadRecentProjects: recent.loadRecentProjects,
  });

  // Re-initialize media import with actual project state setters
  const mediaImport = useMediaImport({
    projectDir: project.projectDir,
    setClips: project.setClips,
    setSelectedClipId: project.setSelectedClipId,
    setRoute: project.setRoute,
  });

  useAutoSave({
    projectDir: project.projectDir,
    clips: project.clips,
    route: project.route,
    projectName: project.projectName,
    projectThumbnail: project.projectThumbnail,
  });

  // Auto-default project thumbnail to first clip's thumbnail
  useEffect(() => {
    if (project.projectThumbnail) return;
    const firstClip = project.clips[0];
    if (firstClip && mediaImport.thumbnails[firstClip.id]) {
      project.setProjectThumbnail(mediaImport.thumbnails[firstClip.id]);
    }
  }, [project.clips, mediaImport.thumbnails, project.projectThumbnail]);

  // Combine errors from project and media import
  const error = project.error || mediaImport.error || recent.error;
  const dismissError = () => {
    project.setError(null);
    mediaImport.setError(null);
    recent.setError(null);
  };

  if (!project.hasProject) {
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
      clips={project.clips}
      setClips={project.setClips}
      selectedClip={project.selectedClip}
      selectedClipId={project.selectedClipId}
      setSelectedClipId={project.setSelectedClipId}
      route={project.route}
      setRoute={project.setRoute}
      proxies={mediaImport.proxies}
      thumbnails={mediaImport.thumbnails}
      loading={project.loading || mediaImport.loading}
      error={error}
      onDismissError={dismissError}
      onCloseProject={project.handleCloseProject}
      onRemoveClip={project.handleRemoveClip}
      onUpdateTrim={project.handleUpdateTrim}
      onUpdateFocalPoint={project.handleUpdateFocalPoint}
      onUpdateEffects={project.handleUpdateEffects}
      onImportFiles={mediaImport.handleImportFiles}
      onImportFolder={mediaImport.handleImportFolder}
      onImportGpx={mediaImport.handleImportGpx}
    />
  );
}
