import { useState, useEffect } from 'react';
import HomeScreen from './screens/HomeScreen';
import ProjectView from './screens/ProjectView';
import { useProject } from './hooks/useProject';
import { useMediaImport } from './hooks/useMediaImport';
import { useAutoSave } from './hooks/useAutoSave';
import { useRecentProjects } from './hooks/useRecentProjects';
import type { AspectRatio, Clip, ExportGrid, Route, MapMagnifications, MapSettings, Project, ProjectLayouts, TransitionFeel, Waypoint } from './types';
import { DEFAULT_MAP_SETTINGS } from './types';
import { defaultMagnifications, defaultSplitLayout } from './lib/layout';

/** First-contact `ProjectLayouts` shape: all three aspects seeded with the
 *  Split default. Used as the initial state and as the defensive fallback
 *  for projects whose Rust backfill didn't populate the field (hand-edited
 *  bundles, races). Mirrors the Rust `seeded_layouts()` in
 *  `src-tauri/src/models.rs`. */
function makeSeededLayouts(): ProjectLayouts {
  return {
    '9_16': defaultSplitLayout('9_16'),
    '4_5': defaultSplitLayout('4_5'),
    '16_9': defaultSplitLayout('16_9'),
  };
}

export default function App() {
  // Shared state lifted here to break the circular dependency
  // between useProject and useMediaImport
  const [projectDir, setProjectDir] = useState<string | null>(null);
  // Full deserialized Project as load_project returned it — the canonical
  // auto-save payload base (and the auto-save arming switch: null = don't
  // save). Owned here next to projectDir; useProject sets it on open/new and
  // clears it on close. See src/lib/projectPersistence.ts.
  const [baseProject, setBaseProject] = useState<Project | null>(null);
  // Last auto-save failure, surfaced in the shared error banner. Cleared by
  // the next successful save (self-healing) or by user dismissal.
  const [saveError, setSaveError] = useState<string | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [mapSettings, setMapSettings] = useState<MapSettings>(DEFAULT_MAP_SETTINGS);
  const [transitionFeel, setTransitionFeel] = useState<TransitionFeel | undefined>(undefined);
  const [projectLayouts, setProjectLayouts] = useState<ProjectLayouts>(makeSeededLayouts);
  const [mapMagnifications, setMapMagnifications] =
    useState<MapMagnifications>(defaultMagnifications);
  const [selectedExportAspect, setSelectedExportAspect] = useState<AspectRatio>('9_16');
  const [lastExportSelection, setLastExportSelection] = useState<ExportGrid | null>(null);
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);

  const recent = useRecentProjects();

  const media = useMediaImport({
    projectDir,
    setClips,
    setSelectedClipId,
    setRoute,
    setWaypoints,
  });

  const project = useProject({
    projectDir,
    setProjectDir,
    setBaseProject,
    clips,
    setClips,
    selectedClipId,
    setSelectedClipId,
    route,
    setRoute,
    setMapSettings,
    setTransitionFeel,
    setProjectLayouts,
    setMapMagnifications,
    setSelectedExportAspect,
    setLastExportSelection,
    setWaypoints,
    generateProxiesAndThumbnails: media.generateProxiesAndThumbnails,
    setProxies: media.setProxies,
    setThumbnails: media.setThumbnails,
    setImportError: media.setError,
    loadRecentProjects: recent.loadRecentProjects,
  });

  useAutoSave({
    projectDir,
    baseProject,
    clips,
    route,
    projectName: project.projectName,
    projectThumbnail: project.projectThumbnail,
    mapSettings,
    transitionFeel,
    projectLayouts,
    mapMagnifications,
    selectedExportAspect,
    lastExportSelection,
    waypoints,
    onSaveError: setSaveError,
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
  const error = project.error || media.error || recent.error || saveError;
  const dismissError = () => {
    project.setError(null);
    media.setError(null);
    recent.setError(null);
    setSaveError(null);
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
      mapMagnifications={mapMagnifications}
      setMapMagnifications={setMapMagnifications}
      lastExportSelection={lastExportSelection}
      setLastExportSelection={setLastExportSelection}
      waypoints={waypoints}
      setWaypoints={setWaypoints}
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
      onUpdateSourceFormat={project.handleUpdateSourceFormat}
      pendingImportClips={media.pendingImportClips}
      onConfirmSourceFormats={media.confirmPendingImport}
      onSkipSourceFormats={media.skipPendingImport}
      onImportFiles={media.handleImportFiles}
      onImportFolder={media.handleImportFolder}
      onImportGpx={media.handleImportGpx}
    />
  );
}
