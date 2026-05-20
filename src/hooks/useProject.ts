import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { AspectRatio, Clip, ExportGrid, Project, ProjectLayouts, Route, TrimRange, FocalPoint, Effects, MapSettings, TransitionFeel, Waypoint } from '../types';
import { DEFAULT_MAP_SETTINGS } from '../types';
import { defaultPipLayout } from '../lib/layout';
import {
  appendClipWaypoints,
  removeClipWaypoints,
  seedWaypointsFromClips,
  syncClipWaypointTrim,
} from '../lib/waypoints';

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
  setTransitionFeel: React.Dispatch<React.SetStateAction<TransitionFeel | undefined>>;
  setProjectLayouts: React.Dispatch<React.SetStateAction<ProjectLayouts>>;
  setSelectedExportAspect: React.Dispatch<React.SetStateAction<AspectRatio>>;
  setLastExportSelection: React.Dispatch<React.SetStateAction<ExportGrid | null>>;
  setWaypoints: React.Dispatch<React.SetStateAction<Waypoint[]>>;
  generateProxiesAndThumbnails: (clipList: Clip[], dir: string) => Promise<void>;
  setProxies: React.Dispatch<React.SetStateAction<Record<string, string | 'generating' | null>>>;
  setThumbnails: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setImportError: (err: string | null) => void;
  loadRecentProjects: () => Promise<void>;
}

/** Block-aware merge of project map settings from disk with the canonical
 *  defaults. Mirrors `resolveMapSettings` (which is for clip overrides) but
 *  drops in for the v8 nested shape — `project.map_settings` may be `null`
 *  or a partially-populated nested record from a hand-edited bundle. */
function mergeMapSettings(
  defaults: MapSettings,
  incoming: MapSettings | undefined | null,
): MapSettings {
  if (!incoming) return defaults;
  const incomingRouteSize = incoming.route?.size as
    | Partial<MapSettings['route']['size']> & { full_width?: number }
    | undefined;
  const routeSize =
    incomingRouteSize && incomingRouteSize.width === undefined && incomingRouteSize.full_width !== undefined
      ? { ...incomingRouteSize, width: incomingRouteSize.full_width }
      : incomingRouteSize;
  return {
    camera: { ...defaults.camera, ...incoming.camera },
    route: {
      ...defaults.route,
      ...incoming.route,
      size: { ...defaults.route.size, ...routeSize },
    },
    waypoints: {
      ...defaults.waypoints,
      ...incoming.waypoints,
      size: { ...defaults.waypoints.size, ...incoming.waypoints?.size },
    },
    pov: {
      ...defaults.pov,
      ...incoming.pov,
      size: { ...defaults.pov.size, ...incoming.pov?.size },
    },
  };
}

/** Defensive backfill mirroring the Rust `seeded_layouts()` (task 080 / 100).
 *  The Rust load path already populates `layouts` for every project; this
 *  TS-side guard handles the (theoretical) case where Rust hands us a missing
 *  field — hand-edited bundles, IPC bugs, future Rust regressions — so the
 *  editor always has a real value to render and persist. 100 expanded the
 *  seeded shape to all three aspects. */
function seededLayouts(): ProjectLayouts {
  return {
    '9_16': defaultPipLayout('9_16'),
    '4_5': defaultPipLayout('4_5'),
    '16_9': defaultPipLayout('16_9'),
  };
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
  setTransitionFeel,
  setProjectLayouts,
  setSelectedExportAspect,
  setLastExportSelection,
  setWaypoints,
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
      setMapSettings(mergeMapSettings(DEFAULT_MAP_SETTINGS, project.map_settings));
      setTransitionFeel(project.transition_feel);
      // Rust's load_project backfills `layouts` when the bundle has it
      // unset; this guard covers the edge case where the IPC payload still
      // arrives without it (older Rust binaries, hand-edited bundles).
      setProjectLayouts(project.layouts ?? seededLayouts());
      // selected_export_aspect is supplied by serde's default annotation on
      // pre-100 bundles; the `?? '9_16'` covers the same edge cases as the
      // layouts fallback above.
      setSelectedExportAspect(project.selected_export_aspect ?? '9_16');
      // Pre-280 bundles lack `last_export_selection`; the Rust serde default
      // surfaces `null`. Either way, hydrating App-level state here is the
      // sole load-time entry point — the modal reads from this on open.
      setLastExportSelection(project.last_export_selection ?? null);
      // v7 waypoints. Legacy bundles arrive with `waypoints: []` from Rust
      // (serde default on a missing field); seed from clips so the user
      // doesn't open a project and find every map waypoint missing. The
      // first auto-save persists the seeded list.
      setWaypoints(
        project.waypoints && project.waypoints.length > 0
          ? project.waypoints
          : seedWaypointsFromClips(project.clips),
      );

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
      setTransitionFeel(undefined);
      // Mirror the Rust-side `Project::default()` seed — task 080 / 100.
      setProjectLayouts(seededLayouts());
      setSelectedExportAspect('9_16');
      setLastExportSelection(null);
      setWaypoints([]);
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
    setTransitionFeel(undefined);
    setProjectLayouts(seededLayouts());
    setSelectedExportAspect('9_16');
    setLastExportSelection(null);
    setWaypoints([]);
    setProxies({});
    setThumbnails({});
    setSelectedClipId(null);
    setError(null);
    setImportError(null);
    loadRecentProjects();
  }

  function handleRemoveClip(clipId: string) {
    setClips((prev) => prev.filter((c) => c.id !== clipId));
    setWaypoints((prev) => removeClipWaypoints(prev, clipId));
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
    // Re-anchor any clip-sourced waypoint whose wall-clock derives from the
    // clip's trim.in_ms. Sticky-deletion: if the user removed the waypoint,
    // it stays gone — `syncClipWaypointTrim` only mutates existing entries.
    if (selectedClipId) {
      const target = clips.find((c) => c.id === selectedClipId);
      if (target) {
        setWaypoints((prev) =>
          syncClipWaypointTrim(prev, { ...target, trim }),
        );
      }
    }
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

    // Round to whole ms — Rust's TrimRange is u64 on both fields, and a
    // fractional value (playheadSec comes from video.currentTime, which has
    // sub-frame precision) fails serde's u64 deserialize. That break is
    // silent on save (useAutoSave swallows the IPC error) and loud on
    // render_export (extract_clips bubbles "invalid type: floating point …"
    // back to the queue). It also drifts compileTimeline's totalDurationMs
    // off the integer-ms grid, which propagates to a sub-frame fps error.
    const splitMs = Math.round(playheadSec * 1000);
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
      map_overrides: clip.map_overrides ? { ...clip.map_overrides } : null,
    };

    setClips((prev) => {
      const idx = prev.findIndex((c) => c.id === clip.id);
      if (idx === -1) return prev;
      const next = prev.slice();
      next.splice(idx, 1, leftHalf, rightHalf);
      return next;
    });
    // The right half is a brand-new clip from the waypoint model's
    // perspective: append a waypoint for it. The left half keeps its
    // existing waypoint (its trim.in_ms is unchanged so the anchor is
    // already correct). If the user manually deleted the left half's
    // waypoint earlier, splitting still only adds the right-half waypoint
    // — the left stays absent. Sticky-deletion preserved.
    setWaypoints((prev) => appendClipWaypoints(prev, [rightHalf]));
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
        atMs: splitMs,
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
