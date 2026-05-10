import { useState, useEffect } from 'react';
import HomeScreen from './screens/HomeScreen';
import ProjectView from './screens/ProjectView';
import { useProject } from './hooks/useProject';
import { useMediaImport } from './hooks/useMediaImport';
import { useAutoSave } from './hooks/useAutoSave';
import { useRecentProjects } from './hooks/useRecentProjects';
import type { AspectRatio, Clip, ExportSelection, Route, MapSettings, ProjectLayouts, TransitionFeel } from './types';
import { DEFAULT_MAP_SETTINGS } from './types';
import { defaultPipLayout } from './lib/layout';

/** First-contact `ProjectLayouts` shape (task 100): all three aspects seeded
 *  with the baseline PiP-bottom-right layout. Used as the initial state and
 *  as the defensive fallback for projects whose Rust backfill didn't
 *  populate the field (hand-edited bundles, races). Mirrors the Rust
 *  `seeded_layouts()` in `src-tauri/src/models.rs`. */
function makeSeededLayouts(): ProjectLayouts {
  return {
    '9_16': defaultPipLayout('9_16'),
    '4_5': defaultPipLayout('4_5'),
    '16_9': defaultPipLayout('16_9'),
  };
}

export default function App() {
  // Shared state lifted here to break the circular dependency
  // between useProject and useMediaImport
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [mapSettings, setMapSettings] = useState<MapSettings>(DEFAULT_MAP_SETTINGS);
  const [transitionFeel, setTransitionFeel] = useState<TransitionFeel | undefined>(undefined);
  const [projectLayouts, setProjectLayouts] = useState<ProjectLayouts>(makeSeededLayouts);
  const [selectedExportAspect, setSelectedExportAspect] = useState<AspectRatio>('9_16');
  const [lastExportSelection, setLastExportSelection] = useState<ExportSelection | null>(null);
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
    setTransitionFeel,
    setProjectLayouts,
    setSelectedExportAspect,
    setLastExportSelection,
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
    transitionFeel,
    projectLayouts,
    selectedExportAspect,
    lastExportSelection,
  });

  // Auto-default project thumbnail to first clip's thumbnail
  const { projectThumbnail, setProjectThumbnail } = project;
  const { thumbnails } = media;
  useEffect(() => {
    if (projectThumbnail) return;
    const firstClip = clips[0];
    if (firstClip && thumbnails[firstClip.id]) {
      setProjectThumbnail(thumbnails[firstClip.id]);
    }
  }, [clips, thumbnails, projectThumbnail, setProjectThumbnail]);

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
      projectDir={projectDir}
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
      transitionFeel={transitionFeel}
      projectLayouts={projectLayouts}
      setProjectLayouts={setProjectLayouts}
      selectedExportAspect={selectedExportAspect}
      setSelectedExportAspect={setSelectedExportAspect}
      lastExportSelection={lastExportSelection}
      setLastExportSelection={setLastExportSelection}
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
