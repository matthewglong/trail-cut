import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import Timeline from '../components/Timeline';
import MapView from '../components/MapView';
import MapToolbar from '../components/MapToolbar/MapToolbar';
import type { MapToolbarScope } from '../components/MapToolbar/MapToolbar';
import EditToolbar from '../components/EditToolbar';
import VideoPreview from '../components/VideoPreview';
import { LayoutPreview, LayoutPreviewToggle } from '../components/LayoutPreview';
import { LayoutConfigurator } from '../components/LayoutConfigurator';
import { MapPositioningModal } from '../components/MapPositioningModal';
import type { LayoutConfig } from '../lib/layout';
import { useEditorShortcuts } from '../shortcuts/useEditorShortcuts';
import { useDropdownClose } from '../hooks/useDropdownClose';
import { indexRoute } from '../lib/routeLocation';
import { compileTimeline, activeClipIdAt } from '../lib/cameraIntent';
import { livePlayheadMs } from '../lib/livePlayhead';
import { buildExportRequest, type ExportChannel } from '../lib/exportRequest';
import type { AspectRatio, Clip, Route, TrimRange, FocalPoint, Effects, MapSettings, MapOverrides, ProjectLayouts, TransitionFeel } from '../types';
import { resolveMapSettings } from '../types';
import type { ProxyMap, ThumbnailMap } from '../hooks/useMediaImport';

interface RenderExportSummary {
  frames_written: number;
  output_path: string;
  wall_clock_ms: number;
}

interface RenderExportError {
  stage: string;
  message: string;
  stderr_tail?: string;
}

// Resizer constraints — easy to tune
const V_SPLIT_DEFAULT = 0.65; // video takes 65% of width
const V_SPLIT_MIN = 0.30;
const V_SPLIT_MAX = 0.80;
const H_CLIPS_MIN_PX = 80;
const H_CLIPS_MAX_RATIO = 0.50; // clips can't exceed 50% of height
const H_CLIPS_DEFAULT_PX = 140;

const LAYOUT_PREVIEW_PREF_PREFIX = 'trailcut.layoutPreviewVisible:';

/** Read the layout-preview toggle preference for a given project dir. Stored
 *  in localStorage rather than the project bundle to keep editor UI state
 *  out of the shareable on-disk JSON (task 080's "lower-friction" path).
 *  Returns false on missing/unparseable values — overlay defaults to off. */
function readLayoutPreviewPref(projectDir: string | null): boolean {
  if (!projectDir) return false;
  try {
    return localStorage.getItem(LAYOUT_PREVIEW_PREF_PREFIX + projectDir) === '1';
  } catch {
    return false;
  }
}

function writeLayoutPreviewPref(projectDir: string | null, value: boolean): void {
  if (!projectDir) return;
  try {
    localStorage.setItem(LAYOUT_PREVIEW_PREF_PREFIX + projectDir, value ? '1' : '0');
  } catch {
    // Quota exceeded / private mode — silently drop. The toggle still works
    // for the current session; only cross-session persistence is lost.
  }
}

interface ProjectViewProps {
  projectDir: string | null;
  projectName: string;
  setProjectName: (name: string) => void;
  editingName: boolean;
  setEditingName: (editing: boolean) => void;
  clips: Clip[];
  setClips: React.Dispatch<React.SetStateAction<Clip[]>>;
  selectedClip: Clip | null;
  selectedClipId: string | null;
  setSelectedClipId: (id: string) => void;
  route: Route | null;
  setRoute: React.Dispatch<React.SetStateAction<Route | null>>;
  mapSettings: MapSettings;
  setMapSettings: React.Dispatch<React.SetStateAction<MapSettings>>;
  transitionFeel: TransitionFeel | undefined;
  projectLayouts: ProjectLayouts;
  setProjectLayouts: React.Dispatch<React.SetStateAction<ProjectLayouts>>;
  /** Aspect that the export pipeline targets (task 100). Drives both the
   *  LayoutPreview overlay's `aspect` prop and the `aspect` field on every
   *  `buildExportRequest` call. */
  selectedExportAspect: AspectRatio;
  setSelectedExportAspect: React.Dispatch<React.SetStateAction<AspectRatio>>;
  playheadMs: number | null;
  setPlayheadMs: React.Dispatch<React.SetStateAction<number | null>>;
  proxies: ProxyMap;
  thumbnails: ThumbnailMap;
  loading: boolean;
  error: string | null;
  onDismissError: () => void;
  onCloseProject: () => void;
  onRemoveClip: (clipId: string) => void;
  onSplitClip: (playheadSec: number) => void;
  onUpdateTrim: (trim: TrimRange) => void;
  onUpdateFocalPoint: (fp: FocalPoint) => void;
  onUpdateEffects: (effects: Effects) => void;
  onImportFiles: () => void;
  onImportFolder: () => void;
  onImportGpx: () => void;
}

export default function ProjectView({
  projectDir,
  projectName,
  setProjectName,
  editingName,
  setEditingName,
  clips,
  setClips,
  selectedClip,
  selectedClipId,
  setSelectedClipId,
  route,
  setRoute,
  mapSettings,
  setMapSettings,
  transitionFeel,
  projectLayouts,
  setProjectLayouts,
  selectedExportAspect,
  setSelectedExportAspect,
  playheadMs,
  setPlayheadMs,
  proxies,
  thumbnails,
  loading,
  error,
  onDismissError,
  onCloseProject,
  onRemoveClip,
  onSplitClip,
  onUpdateTrim,
  onUpdateFocalPoint,
  onUpdateEffects,
  onImportFiles,
  onImportFolder,
  onImportGpx,
}: ProjectViewProps) {
  const [showImportMenu, setShowImportMenu] = useState(false);
  const [showGpxMenu, setShowGpxMenu] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<RenderExportError | null>(null);
  const [exportDetailsOpen, setExportDetailsOpen] = useState(false);
  const [previewAspect, setPreviewAspect] = useState('16:9');
  const [cropPreview, setCropPreview] = useState(false);
  const [playbackMode, setPlaybackMode] = useState<'loop' | 'continuous'>('loop');
  const [autoPlayToken, setAutoPlayToken] = useState(0);
  const [resetPillHover, setResetPillHover] = useState(false);
  const isPlayingRef = useRef(false);
  const needsRewindRef = useRef(false);

  // Layout-preview overlay toggle (task 080). Persisted in localStorage
  // keyed by projectDir so the preference travels with the project but
  // doesn't bloat the project bundle's JSON. Defaults to off — the editor's
  // resting state is "edit clips," not "configure layout."
  const [layoutPreviewVisible, setLayoutPreviewVisible] = useState(() =>
    readLayoutPreviewPref(projectDir),
  );
  // Configurator open/closed (task 110 wiring — scaffolding; the real placement
  // is a downstream UI design decision per spec line 58).
  const [configuratorOpen, setConfiguratorOpen] = useState(false);
  const [positioningModalOpen, setPositioningModalOpen] = useState(false);
  useEffect(() => {
    setLayoutPreviewVisible(readLayoutPreviewPref(projectDir));
  }, [projectDir]);
  const handleToggleLayoutPreview = useCallback(() => {
    setLayoutPreviewVisible((v) => {
      const next = !v;
      writeLayoutPreviewPref(projectDir, next);
      return next;
    });
  }, [projectDir]);

  // Measured size of the video pane content area — fed to LayoutPreview so
  // its aspect-fit math produces letterbox / pillarbox correctly when the
  // editor's pane shape doesn't match the layout's output shape.
  const videoPaneContentRef = useRef<HTMLDivElement>(null);
  const [videoPaneSize, setVideoPaneSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    const el = videoPaneContentRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setVideoPaneSize({ w: rect.width, h: rect.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Map toolbar scope — auto-reverts to 'clip' when the selected clip changes
  const [mapScope, setMapScope] = useState<MapToolbarScope>('project');
  const prevSelectedClipIdRef = useRef(selectedClipId);
  useEffect(() => {
    if (selectedClipId !== prevSelectedClipIdRef.current) {
      prevSelectedClipIdRef.current = selectedClipId;
      if (mapScope === 'clip') {
        // Stay in clip scope — user is browsing clips with clip-level edits
      } else {
        // Stay in project scope — don't switch automatically
      }
    }
  }, [selectedClipId, mapScope]);

  // Resolve the effective map settings for the selected clip
  const resolvedMapSettings = useMemo(() => {
    if (!selectedClip) return mapSettings;
    return resolveMapSettings(mapSettings, selectedClip.map_overrides);
  }, [mapSettings, selectedClip]);

  // The settings shown in the toolbar depend on scope
  const toolbarSettings = mapScope === 'project' ? mapSettings : resolvedMapSettings;

  // Which keys the current clip overrides
  const overriddenKeys = useMemo((): Set<keyof MapSettings> | null => {
    if (mapScope === 'project' || !selectedClip?.map_overrides) return null;
    return new Set(
      (Object.keys(selectedClip.map_overrides) as (keyof MapSettings)[])
        .filter((k) => selectedClip.map_overrides![k] !== undefined)
    );
  }, [mapScope, selectedClip]);

  // Handle toolbar changes based on scope
  const handleMapToolbarChange = useCallback((next: MapSettings) => {
    if (mapScope === 'project') {
      setMapSettings(next);
    } else if (selectedClipId) {
      // Compute overrides: only store fields that differ from project defaults
      const entries = (Object.keys(next) as (keyof MapSettings)[])
        .filter((key) => next[key] !== mapSettings[key])
        .map((key) => [key, next[key]] as const);
      const overrides = Object.fromEntries(entries) as MapOverrides;
      const hasOverrides = entries.length > 0;
      setClips((prev) => prev.map((c) =>
        c.id === selectedClipId
          ? { ...c, map_overrides: hasOverrides ? overrides : null }
          : c
      ));
    }
  }, [mapScope, selectedClipId, mapSettings, setMapSettings, setClips]);

  // True when the selected clip has any stored map overrides. Used to surface
  // the reset pill in project scope — handleMapToolbarChange already nulls out
  // empty override bags, but we re-check defensively for load-time state.
  const clipHasMapOverrides = useMemo((): boolean => {
    if (!selectedClip?.map_overrides) return false;
    return Object.values(selectedClip.map_overrides).some((v) => v !== undefined);
  }, [selectedClip]);

  // Indexed route — consumed by `compileTimeline` for per-clip bearing
  // keyframes and follow-intent construction.
  const indexedRoute = useMemo(() => indexRoute(route), [route]);

  // The project-level transition-feel knob. Read from the persisted project
  // field with a 'natural' default for v1 projects that pre-date it.
  const projectTransitionFeel: TransitionFeel = transitionFeel ?? 'natural';

  // The compiled project-time timeline. Single source of truth for camera
  // scheduling; consumed by MapView's ease loop and (eventually) by the
  // export frame loop. Pure: same inputs → identical timeline. See
  // `docs/migration/COMPILED_TIMELINE_PLAN.md` §"Data Model → Compiled Data".
  const timeline = useMemo(
    () =>
      compileTimeline(clips, indexedRoute, mapSettings, {
        transition_feel: projectTransitionFeel,
      }),
    [clips, indexedRoute, mapSettings, projectTransitionFeel],
  );

  // The active clip's compiled span. `null` when the selected clip isn't
  // compilable (invisible, missing/unparseable created_at, degenerate
  // trim) — in that case `playheadMs` stays null and the map holds the
  // last good frame via the ease loop's fallback.
  const selectedClipSpan = useMemo(
    () => timeline.clipSpans.find((s) => s.clipId === selectedClipId) ?? null,
    [timeline, selectedClipId],
  );

  // The clip "active" for UI highlighting and edit-toolbar controls, derived
  // from the project-time playhead per `COMPILED_TIMELINE_PLAN.md`
  // §"Implementation Plan → 7". During an auto-advance transition this
  // returns the destination clip; outside transitions it equals
  // `selectedClipId`. Falls back to `selectedClipId` when no playhead has
  // been emitted yet (project just loaded, no clip ever played) so the
  // active-clip UI matches the user's intent on cold start.
  const activeClipId = useMemo<string | null>(() => {
    if (playheadMs == null) return selectedClipId;
    return activeClipIdAt(timeline, playheadMs) ?? selectedClipId;
  }, [timeline, playheadMs, selectedClipId]);

  const activeClip = useMemo<Clip | null>(
    () => clips.find((c) => c.id === activeClipId) ?? null,
    [clips, activeClipId],
  );

  // Clear the selected clip's map overrides, letting it follow project defaults.
  const handleResetClipMapOverrides = useCallback(() => {
    if (!selectedClipId) return;
    setClips((prev) => prev.map((c) =>
      c.id === selectedClipId ? { ...c, map_overrides: null } : c
    ));
  }, [selectedClipId, setClips]);

  // Auto-advance on clip end. Snap to the next clip and autoplay; the
  // camera keeps animating naturally because `cameraAt` resolves the
  // transition span on both sides of the cut. The pre-cut half is
  // covered while the source video plays its last `effectivePreCut` ms
  // of media; the post-cut half is covered while the destination video
  // plays its first `effectivePostCut` ms — one continuous arc, no
  // freeze in between.
  const handleClipEnded = useCallback(() => {
    const currentSpanIdx = timeline.clipSpans.findIndex(
      (s) => s.clipId === selectedClipId,
    );
    if (currentSpanIdx < 0) {
      // Selected clip isn't compilable (invisible/unparseable) — nothing
      // sensible to advance to. Fall through to the rewind sentinel so the
      // next play press jumps back to the first visible clip.
      needsRewindRef.current = true;
      return;
    }
    const nextSpan = timeline.clipSpans[currentSpanIdx + 1];
    if (!nextSpan) {
      needsRewindRef.current = true;
      return;
    }
    setSelectedClipId(nextSpan.clipId);
    setAutoPlayToken((t) => t + 1);
  }, [timeline, selectedClipId, setSelectedClipId]);

  // Intercept play-press: if we're parked at the end of the timeline, jump
  // back to the first visible clip and auto-play it instead. Also seeks
  // project-time so the map lands on clip 1's canonical position before
  // playback resumes.
  const handlePlayIntent = useCallback(() => {
    if (!needsRewindRef.current) return false;
    const first = clips.find((c) => c.visible !== false);
    if (!first) return false;
    needsRewindRef.current = false;
    setSelectedClipId(first.id);
    const span = timeline.clipSpans.find((s) => s.clipId === first.id);
    if (span) setPlayheadMs(span.canonicalSeekMs);
    setAutoPlayToken((t) => t + 1);
    return true;
  }, [clips, setSelectedClipId, setPlayheadMs, timeline]);

  // Wrap clip selection: seek project-time to the clip's `canonicalSeekMs`
  // (per plan §"Preview Semantics" — selection should show what export would
  // show at that t) and, if a clip was playing, autoplay the new one. Also
  // clears the end-of-timeline rewind flag.
  const handleSelectClip = useCallback((id: string) => {
    needsRewindRef.current = false;
    const wasSame = id === selectedClipId;
    setSelectedClipId(id);
    const span = timeline.clipSpans.find((s) => s.clipId === id);
    if (span) setPlayheadMs(span.canonicalSeekMs);
    if (!wasSame && isPlayingRef.current) setAutoPlayToken((t) => t + 1);
  }, [selectedClipId, setSelectedClipId, setPlayheadMs, timeline]);

  const handlePlayingChange = useCallback((p: boolean) => {
    isPlayingRef.current = p;
  }, []);

  // Resizer state
  const [vSplit, setVSplit] = useState(V_SPLIT_DEFAULT); // fraction of width for video pane
  const [clipsHeight, setClipsHeight] = useState(H_CLIPS_DEFAULT_PX);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<'vertical' | 'horizontal' | null>(null);

  useDropdownClose(showImportMenu, useCallback(() => setShowImportMenu(false), []));
  useDropdownClose(showGpxMenu, useCallback(() => setShowGpxMenu(false), []));

  // VideoPreview publishes its togglePlay function here so Space can drive playback
  const togglePlayRef = useRef<(() => void) | null>(null);

  // Current playhead in media-seconds from the source start (what onSplitClip
  // expects). Mirrors VideoPreview.onPlayheadChange without triggering
  // re-renders on every time update.
  const playheadSecRef = useRef(0);

  const splitAtPlayhead = useCallback(() => {
    onSplitClip(playheadSecRef.current);
  }, [onSplitClip]);

  // Shared dispatch for the developer-grade export buttons (Channel B
  // task 060, Channel C task 070, Channel A task 090). Hard-coded to 9:16
  // until the configurator UI (110) lands an aspect picker. All buttons
  // share `exporting` so they can't fire in parallel. The `format` arg
  // parameterizes the file-extension filter and forced suffix so the
  // composite (.mp4) channel coexists with the .mov intermediates without
  // a second copy of the dispatch logic.
  const runExport = useCallback(
    async (
      channel: ExportChannel,
      dialogTitle: string,
      format: { extension: 'mov' | 'mp4'; filterName: string },
    ) => {
      if (exporting) return;
      setExportError(null);
      setExportDetailsOpen(false);
      let outputPath: string | null = null;
      try {
        outputPath = await save({
          title: dialogTitle,
          filters: [{ name: format.filterName, extensions: [format.extension] }],
        });
      } catch {
        return;
      }
      if (!outputPath) return;
      const suffix = `.${format.extension}`;
      if (!outputPath.toLowerCase().endsWith(suffix)) {
        outputPath = `${outputPath}${suffix}`;
      }
      const req = buildExportRequest({
        channel,
        fps: 30,
        outputPath,
        // Task 100: read the project's selected aspect rather than
        // hard-coding `'9_16'`. A user-facing aspect picker lands in a
        // follow-up; today the temp `<select>` near the layout toggle
        // mutates this value for the current session.
        aspect: selectedExportAspect,
        clips,
        route,
        mapSettings,
        transitionFeel,
        // Per-aspect seeded layouts (task 080 / 100). The export reads
        // the stored value for `selectedExportAspect`; if the user has
        // explicitly cleared that aspect (post-100, via 110), pickLayout's
        // fallback synthesizes a default.
        layouts: projectLayouts,
      });
      setExporting(true);
      try {
        await invoke<RenderExportSummary>('render_export', { req });
      } catch (err) {
        const e = err as RenderExportError | string;
        if (typeof e === 'string') {
          setExportError({ stage: 'unknown', message: e });
        } else {
          setExportError(e);
        }
      } finally {
        setExporting(false);
      }
    },
    [exporting, clips, route, mapSettings, transitionFeel, projectLayouts, selectedExportAspect],
  );

  const handleExportMapOnly = useCallback(
    () => runExport('map_only', 'Export map-only (.mov)', { extension: 'mov', filterName: 'QuickTime' }),
    [runExport],
  );

  // Channel C: per-clip filter chain → concat → ProRes 4444 + PCM s16le
  // audio at the layout's video slot on a transparent canvas. Stack with
  // B in any NLE to reconstruct A.
  const handleExportVideoOnly = useCallback(
    () => runExport('video_only', 'Export video-only (.mov)', { extension: 'mov', filterName: 'QuickTime' }),
    [runExport],
  );

  // Channel A (task 090): the deliverable. Map render stream + per-clip
  // video chain composited into a single H.265 .mp4 per the configured
  // layout. AAC audio. Unlike B/C this is opaque (no alpha channel) and
  // ships in MP4 rather than MOV.
  const handleExportComposite = useCallback(
    () => runExport('composite', 'Export composite (.mp4)', { extension: 'mp4', filterName: 'MP4' }),
    [runExport],
  );

  // Refs for the synchronous live-playhead callback below. The callback runs
  // inside the video preview's rAF tick (one frame ahead of any React commit),
  // so it must read the latest span without depending on render-time props.
  // Identity is kept stable so VideoPreview's effect chain doesn't churn.
  const selectedClipSpanRef = useRef(selectedClipSpan);
  useEffect(() => { selectedClipSpanRef.current = selectedClipSpan; }, [selectedClipSpan]);

  // Invalidate the live-playhead ref when the selected clip changes. The rAF
  // callback only writes while playing, so without this the map's render loop
  // would keep reading the previous clip's last project-time when the user
  // clicks a different clip without pressing play. Clearing forces MapView's
  // fallback chain (currentProjectMsRef → canonicalSeekMs) to take over.
  useEffect(() => {
    livePlayheadMs.current = null;
  }, [selectedClipId]);

  // Synchronous per-frame bridge: clip-local media-seconds → project-time-ms
  // → livePlayheadMs. Mirrors the translation in onPlayheadChange below, but
  // bypasses React state so MapView's render loop reads the freshest value
  // within the same frame instead of two commits later. The slower
  // setPlayheadMs path is kept for the timeline scrubber UI.
  const handleLivePlayheadSeconds = useCallback((s: number) => {
    const span = selectedClipSpanRef.current;
    if (!span) {
      livePlayheadMs.current = null;
      return;
    }
    const raw = s * 1000;
    const clipLocalMs =
      raw < span.mediaInMs
        ? span.mediaInMs
        : raw > span.mediaOutMs
          ? span.mediaOutMs
          : raw;
    livePlayheadMs.current =
      span.startMs + (clipLocalMs - span.mediaInMs) / span.speed;
  }, []);

  useEditorShortcuts({
    selectedClip,
    clips,
    selectedClipId,
    setSelectedClipId: handleSelectClip,
    onUpdateFocalPoint,
    onUpdateEffects,
    previewAspect,
    setPreviewAspect,
    setCropPreview,
    togglePlayRef,
    splitAtPlayhead,
  });

  // Drag handlers for resizers
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      e.preventDefault();
      const rect = containerRef.current.getBoundingClientRect();

      if (draggingRef.current === 'vertical') {
        const ratio = (e.clientX - rect.left) / rect.width;
        setVSplit(Math.min(V_SPLIT_MAX, Math.max(V_SPLIT_MIN, ratio)));
      } else {
        const fromBottom = rect.bottom - e.clientY;
        const maxClips = rect.height * H_CLIPS_MAX_RATIO;
        setClipsHeight(Math.min(maxClips, Math.max(H_CLIPS_MIN_PX, fromBottom)));
      }
    };

    const handleMouseUp = () => {
      if (draggingRef.current) {
        draggingRef.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };

    const handleSelectStart = (e: Event) => {
      if (draggingRef.current) e.preventDefault();
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('selectstart', handleSelectStart);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('selectstart', handleSelectStart);
    };
  }, []);

  const startDrag = useCallback((axis: 'vertical' | 'horizontal') => {
    draggingRef.current = axis;
    document.body.style.cursor = axis === 'vertical' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const selectedProxyPath = selectedClip
    ? (proxies[selectedClip.id] !== 'generating' ? proxies[selectedClip.id] ?? null : null)
    : null;

  return (
    <div style={styles.app}>
      {/* Global Bar */}
      <div style={styles.toolbar}>
        <div style={styles.toolbarLeft}>
          <button onClick={onCloseProject} style={styles.backBtn} title="Back to home">
            &#8592;
          </button>
          <span style={styles.logo}>TrailCut</span>
          {editingName ? (
            <input
              autoFocus
              onFocus={(e) => e.target.select()}
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              onBlur={() => setEditingName(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') setEditingName(false);
              }}
              style={styles.projectNameInput}
            />
          ) : (
            <span
              style={styles.projectName}
              onClick={() => setEditingName(true)}
              title="Click to rename"
            >
              {projectName || 'Untitled'}
            </span>
          )}
        </div>
        <div style={styles.toolbarActions}>
          <div style={styles.importWrapper}>
            <button
              onClick={() => setShowImportMenu(!showImportMenu)}
              disabled={loading}
              style={styles.button}
            >
              Import Media &#9662;
            </button>
            {showImportMenu && (
              <div style={styles.dropdown}>
                <button onClick={() => { setShowImportMenu(false); onImportFiles(); }} style={styles.dropdownItem}>
                  Select Files
                </button>
                <button onClick={() => { setShowImportMenu(false); onImportFolder(); }} style={styles.dropdownItem}>
                  Select Folder
                </button>
              </div>
            )}
          </div>
          <button
            onClick={handleExportMapOnly}
            disabled={exporting || clips.length === 0}
            style={styles.button}
            title="Exports at 9:16. Configure layout per aspect via the layout configurator (coming in a later release)."
          >
            {exporting ? 'Exporting…' : 'Export map-only (.mov)'}
          </button>
          <button
            onClick={handleExportVideoOnly}
            disabled={exporting || clips.length === 0}
            style={styles.button}
            title="Exports at 9:16. Configure layout per aspect via the layout configurator (coming in a later release)."
          >
            {exporting ? 'Exporting…' : 'Export video-only (.mov)'}
          </button>
          <button
            onClick={handleExportComposite}
            disabled={exporting || clips.length === 0}
            style={styles.button}
            title="Exports at 9:16. Configure layout per aspect via the layout configurator (coming in a later release)."
          >
            {exporting ? 'Exporting…' : 'Export composite (.mp4)'}
          </button>
          <div style={styles.gpxChipWrapper}>
            <div
              style={route ? styles.gpxChipLoaded : styles.gpxChipEmpty}
              onClick={() => {
                if (route) {
                  setShowGpxMenu(!showGpxMenu);
                } else {
                  onImportGpx();
                }
              }}
              title={route ? route.source_path : 'Import a GPX route file'}
            >
              <span style={route ? styles.gpxDot : styles.gpxDotEmpty} />
              <span style={styles.gpxLabel}>GPX</span>
            </div>
            {showGpxMenu && route && (
              <div style={styles.dropdown}>
                <button
                  onClick={() => { setShowGpxMenu(false); onImportGpx(); }}
                  style={styles.dropdownItem}
                >
                  Replace route…
                </button>
                <button
                  onClick={() => { setShowGpxMenu(false); setRoute(null); }}
                  style={styles.dropdownItem}
                >
                  Remove route
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div style={styles.error}>
          {error}
          <button onClick={onDismissError} style={styles.dismissBtn}>
            Dismiss
          </button>
        </div>
      )}

      {exportError && (
        <div style={styles.error}>
          <div style={{ flex: 1 }}>
            <span>Export failed ({exportError.stage}): {exportError.message}</span>
            {exportError.stderr_tail && (
              <>
                {' '}
                <button
                  onClick={() => setExportDetailsOpen((o) => !o)}
                  style={styles.dismissBtn}
                >
                  {exportDetailsOpen ? 'Hide details' : 'Show details'}
                </button>
                {exportDetailsOpen && (
                  <pre style={styles.errorPre}>{exportError.stderr_tail}</pre>
                )}
              </>
            )}
          </div>
          <button onClick={() => setExportError(null)} style={styles.dismissBtn}>
            Dismiss
          </button>
        </div>
      )}

      {loading && <div style={styles.loading}>Loading...</div>}

      {/* Display + Clips area (fills remaining space) */}
      <div ref={containerRef} style={styles.contentArea}>
        {/* Display: Video + Map side by side */}
        <div style={{ ...styles.displayArea, height: `calc(100% - ${clipsHeight}px - 6px)` }}>
          {/* Video pane */}
          <div style={{ ...styles.videoPane, width: `calc(${vSplit * 100}% - 3px)` }}>
            <EditToolbar
              clip={activeClip}
              onUpdateFocalPoint={onUpdateFocalPoint}
              onUpdateEffects={onUpdateEffects}
              previewAspect={previewAspect}
              onChangeAspect={setPreviewAspect}
              cropPreview={cropPreview}
              onToggleCropPreview={() => setCropPreview(p => !p)}
            />
            <div ref={videoPaneContentRef} style={styles.videoPaneContent}>
              <VideoPreview
                clip={selectedClip}
                proxyPath={selectedProxyPath}
                onUpdateTrim={onUpdateTrim}
                onUpdateFocalPoint={onUpdateFocalPoint}
                previewAspect={previewAspect}
                cropPreview={cropPreview}
                togglePlayRef={togglePlayRef}
                onSplitAtPlayhead={splitAtPlayhead}
                playbackMode={playbackMode}
                onChangePlaybackMode={setPlaybackMode}
                onClipEnded={handleClipEnded}
                autoPlayToken={autoPlayToken}
                onPlayingChange={handlePlayingChange}
                onPlayIntent={handlePlayIntent}
                onLivePlayheadSeconds={handleLivePlayheadSeconds}
                onPlayheadChange={(s) => {
                  playheadSecRef.current = s;
                  if (!selectedClipSpan) {
                    setPlayheadMs(null);
                    return;
                  }
                  // Translate clip-local media time (seconds, from source
                  // start) into project-time. `effects.speed` cancels: the
                  // clip span was elongated by 1/speed, the clip-local axis
                  // compresses at the same rate. Per
                  // `COMPILED_TIMELINE_PLAN.md` §"Time-Axis Translation".
                  //
                  // Clamp the input to the clip's authored media range. The
                  // video element briefly sits at currentTime = 0 after a
                  // proxy swap (before play seeks to trim.in_ms) and may
                  // emit one stale value from the previous clip during the
                  // commit-then-effect handoff; without clamping either
                  // case lands `playheadMs` outside the active clip span
                  // and the map chases a t that doesn't belong to this
                  // clip.
                  const raw = s * 1000;
                  const clipLocalMs =
                    raw < selectedClipSpan.mediaInMs
                      ? selectedClipSpan.mediaInMs
                      : raw > selectedClipSpan.mediaOutMs
                        ? selectedClipSpan.mediaOutMs
                        : raw;
                  const projectMs =
                    selectedClipSpan.startMs +
                    (clipLocalMs - selectedClipSpan.mediaInMs) /
                      selectedClipSpan.speed;
                  setPlayheadMs(projectMs);
                }}
              />
              {/* Layout overlay (tasks 080 / 100 / 110). Read-only preview
                  by default; when the user clicks "Edit" on the toggle, the
                  configurator (110) takes over the same surface. Both share
                  the videoPane sizing and the selectedExportAspect picker.
                  Treat the configurator wiring as scaffolding — the
                  permanent placement is a downstream UI design call. */}
              {layoutPreviewVisible &&
                projectLayouts[selectedExportAspect] &&
                videoPaneSize.w > 0 && (
                  configuratorOpen ? (
                    <LayoutConfigurator
                      layout={projectLayouts[selectedExportAspect]!}
                      aspect={selectedExportAspect}
                      containerWidth={videoPaneSize.w}
                      containerHeight={videoPaneSize.h}
                      onChange={(next: LayoutConfig) =>
                        setProjectLayouts((prev) => ({
                          ...prev,
                          [selectedExportAspect]: next,
                        }))
                      }
                      onDone={() => setConfiguratorOpen(false)}
                    />
                  ) : (
                    <LayoutPreview
                      layout={projectLayouts[selectedExportAspect]!}
                      aspect={selectedExportAspect}
                      containerWidth={videoPaneSize.w}
                      containerHeight={videoPaneSize.h}
                    />
                  )
                )}
              <div style={styles.layoutToggleAnchor}>
                {/* TEMP scaffold (task 100). Surfaces `selected_export_aspect`
                    as an inline picker so 100's plumbing is testable end-to-end
                    without an aspect-picker UI. The picker lives wherever the
                    broader export-settings UI lands (110 or its successor);
                    until then this `<select>` is the developer-facing surface.
                    Treat as scaffolding, not a deliverable. */}
                <select
                  value={selectedExportAspect}
                  onChange={(e) => setSelectedExportAspect(e.target.value as AspectRatio)}
                  title="Export aspect (temp control — task 100)"
                  style={{
                    fontSize: 11,
                    padding: '2px 4px',
                    background: 'rgba(0,0,0,0.4)',
                    color: 'white',
                    border: '1px solid rgba(255,255,255,0.2)',
                    borderRadius: 3,
                  }}
                >
                  <option value="9_16">9:16</option>
                  <option value="4_5">4:5</option>
                  <option value="16_9">16:9</option>
                </select>
                <LayoutPreviewToggle
                  visible={layoutPreviewVisible}
                  onToggle={handleToggleLayoutPreview}
                  onEdit={
                    layoutPreviewVisible
                      ? () => setConfiguratorOpen((o) => !o)
                      : undefined
                  }
                />
              </div>
            </div>
          </div>

          {/* Vertical divider */}
          <div
            style={styles.vDivider}
            onMouseDown={() => startDrag('vertical')}
          />

          {/* Map pane */}
          <div style={{ ...styles.mapPane, width: `calc(${(1 - vSplit) * 100}% - 3px)` }}>
            <MapToolbar
              settings={toolbarSettings}
              onChange={handleMapToolbarChange}
              routeLoaded={route !== null && route.trackpoints.length > 0}
              scope={mapScope}
              onScopeChange={setMapScope}
              overriddenKeys={overriddenKeys}
              onOpenPositioning={() => setPositioningModalOpen(true)}
            />
            <div style={{ ...styles.mapPaneContent, position: 'relative' as const }}>
              <MapView
                timeline={timeline}
                clips={clips}
                selectedClipId={selectedClipId}
                activeClipId={activeClipId}
                route={route}
                playheadMs={playheadMs}
                mapSettings={toolbarSettings}
                onSelectClip={handleSelectClip}
              />
              <div
                style={mapScope === 'project' ? styles.scopeBadgeProject : styles.scopeBadgeClip}
                onClick={() => setMapScope(mapScope === 'project' ? 'clip' : 'project')}
                title={mapScope === 'project'
                  ? 'Viewing project defaults — click to switch to clip'
                  : 'Viewing clip overrides — click to switch to project'
                }
              >
                {mapScope === 'project' ? 'PROJECT' : 'CLIP'}
              </div>
              {mapScope === 'project' && clipHasMapOverrides && (
                <button
                  style={{ ...styles.resetPill, ...(resetPillHover ? styles.resetPillHoverDelta : null) }}
                  onClick={handleResetClipMapOverrides}
                  onMouseEnter={() => setResetPillHover(true)}
                  onMouseLeave={() => setResetPillHover(false)}
                >
                  This clip has custom map settings • Reset
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Horizontal divider */}
        <div
          style={styles.hDivider}
          onMouseDown={() => startDrag('horizontal')}
        />

        {/* Clips timeline */}
        <div style={{ ...styles.clipsArea, height: clipsHeight }}>
          <Timeline
            clips={clips}
            activeClipId={activeClipId}
            onSelectClip={handleSelectClip}
            thumbnails={thumbnails}
            proxies={proxies}
            onRemoveClip={onRemoveClip}
            onToggleVisibility={(clipId) => {
              setClips(prev => prev.map(c =>
                c.id === clipId ? { ...c, visible: !c.visible } : c
              ));
            }}
          />
        </div>
      </div>
      <MapPositioningModal
        open={positioningModalOpen}
        onClose={() => setPositioningModalOpen(false)}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    backgroundColor: '#121212',
    color: '#fff',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  toolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 16px',
    backgroundColor: '#1a1a1a',
    borderBottom: '1px solid #333',
  },
  toolbarLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  backBtn: {
    background: 'none',
    border: 'none',
    color: '#888',
    fontSize: '18px',
    cursor: 'pointer',
    padding: '4px 8px',
  },
  logo: {
    fontSize: '16px',
    fontWeight: 'bold',
    color: '#ff6b35',
  },
  projectName: {
    fontSize: '15px',
    color: '#ddd',
    fontWeight: 500,
    cursor: 'text',
    padding: '2px 6px',
    borderRadius: '4px',
    borderBottom: '1px solid transparent',
    transition: 'border-color 0.15s ease',
  },
  projectNameInput: {
    fontSize: '15px',
    color: '#ddd',
    fontWeight: 500,
    backgroundColor: '#1a1a1a',
    border: '1px solid #3a3a3a',
    borderRadius: '4px',
    outline: 'none',
    padding: '2px 6px',
    fontFamily: 'inherit',
  },
  toolbarActions: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
  },
  button: {
    padding: '6px 14px',
    backgroundColor: '#2a2a2a',
    color: '#ccc',
    border: '1px solid #444',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '13px',
  },
  importWrapper: {
    position: 'relative' as const,
  },
  gpxChipWrapper: {
    position: 'relative' as const,
  },
  gpxChipEmpty: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '5px 12px',
    border: '1px dashed #555',
    borderRadius: '20px',
    cursor: 'pointer',
    fontSize: '12px',
    color: '#777',
    userSelect: 'none' as const,
    transition: 'all 0.15s ease',
  },
  gpxChipLoaded: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '5px 12px',
    border: '1px solid #4a7c59',
    borderRadius: '20px',
    backgroundColor: 'rgba(74, 124, 89, 0.15)',
    cursor: 'pointer',
    fontSize: '12px',
    color: '#8bc49a',
    userSelect: 'none' as const,
    transition: 'all 0.15s ease',
  },
  gpxDotEmpty: {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    border: '1px solid #555',
    flexShrink: 0,
  },
  gpxDot: {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    backgroundColor: '#6abf7b',
    flexShrink: 0,
  },
  gpxLabel: {
    maxWidth: '120px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  dropdown: {
    position: 'absolute' as const,
    top: '100%',
    right: 0,
    marginTop: '4px',
    backgroundColor: '#2a2a2a',
    border: '1px solid #444',
    borderRadius: '6px',
    overflow: 'hidden',
    zIndex: 100,
    minWidth: '140px',
  },
  dropdownItem: {
    display: 'block',
    width: '100%',
    padding: '8px 14px',
    backgroundColor: 'transparent',
    color: '#ccc',
    border: 'none',
    cursor: 'pointer',
    fontSize: '13px',
    textAlign: 'left' as const,
  },
  error: {
    padding: '8px 16px',
    backgroundColor: '#5c1a1a',
    color: '#ff8888',
    fontSize: '13px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dismissBtn: {
    background: 'none',
    border: 'none',
    color: '#ff8888',
    cursor: 'pointer',
    textDecoration: 'underline',
    fontSize: '12px',
  },
  errorPre: {
    marginTop: '6px',
    padding: '6px 8px',
    backgroundColor: '#2a0a0a',
    color: '#ffb0b0',
    fontSize: '11px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    maxHeight: '160px',
    overflow: 'auto',
    borderRadius: '4px',
  },
  loading: {
    padding: '8px 16px',
    backgroundColor: '#1a3a1a',
    color: '#88ff88',
    fontSize: '13px',
    textAlign: 'center',
  },
  contentArea: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    overflow: 'hidden',
  },
  displayArea: {
    display: 'flex',
    flexDirection: 'row',
    overflow: 'hidden',
  },
  videoPane: {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  videoPaneContent: {
    flex: 1,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
  },
  layoutToggleAnchor: {
    position: 'absolute' as const,
    top: 8,
    right: 8,
    zIndex: 12,
  },
  mapPane: {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  mapPaneContent: {
    flex: 1,
    overflow: 'hidden',
  },
  scopeBadgeProject: {
    position: 'absolute' as const,
    bottom: '8px',
    left: '12px',
    width: '84px',
    height: '28px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid rgba(90, 154, 110, 0.6)',
    backgroundColor: 'rgba(58, 107, 74, 0.88)',
    borderRadius: '999px',
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    color: '#e0f0e6',
    cursor: 'pointer',
    userSelect: 'none' as const,
    fontFamily: 'inherit',
    boxSizing: 'border-box' as const,
    boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
    zIndex: 10,
  },
  scopeBadgeClip: {
    position: 'absolute' as const,
    bottom: '8px',
    left: '12px',
    width: '84px',
    height: '28px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid rgba(255, 133, 85, 0.6)',
    backgroundColor: 'rgba(224, 90, 40, 0.88)',
    borderRadius: '999px',
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    color: '#fff',
    cursor: 'pointer',
    userSelect: 'none' as const,
    fontFamily: 'inherit',
    boxSizing: 'border-box' as const,
    boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
    zIndex: 10,
  },
  resetPill: {
    position: 'absolute' as const,
    top: '8px',
    left: '50%',
    transform: 'translateX(-50%)',
    height: '28px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 16px',
    border: '1px solid rgba(170, 170, 170, 0.6)',
    backgroundColor: 'rgba(130, 130, 130, 0.88)',
    borderRadius: '999px',
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    color: '#f5f5f5',
    cursor: 'pointer',
    userSelect: 'none' as const,
    fontFamily: 'inherit',
    whiteSpace: 'nowrap' as const,
    boxSizing: 'border-box' as const,
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.15)',
    transition: 'background-color 0.15s ease, border-color 0.15s ease',
    zIndex: 11,
  },
  resetPillHoverDelta: {
    backgroundColor: 'rgba(95, 95, 95, 0.92)',
    border: '1px solid rgba(140, 140, 140, 0.7)',
  },
  mapPlaceholderBtn: {
    padding: '4px 10px',
    backgroundColor: '#222',
    color: '#555',
    border: '1px solid #3a3a3a',
    borderRadius: '5px',
    fontSize: '11px',
    cursor: 'default',
    opacity: 0.5,
  },
  vDivider: {
    width: '4px',
    cursor: 'col-resize',
    backgroundColor: '#222',
    flexShrink: 0,
  },
  hDivider: {
    height: '4px',
    cursor: 'row-resize',
    backgroundColor: '#222',
    flexShrink: 0,
  },
  clipsArea: {
    overflow: 'hidden',
  },
};
