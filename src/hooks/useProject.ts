import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { AspectRatio, Clip, ExportGrid, MapMagnifications, Project, ProjectLayouts, Route, SourceColorClass, TrimRange, FocalPoint, Effects, MapSettings, TransitionFeel, Waypoint } from '../types';
import { effectiveSourceClass } from '../lib/sourceFormat';
import { DEFAULT_MAP_SETTINGS } from '../types';
import { hydrateProjectState, seededLayouts } from '../lib/projectPersistence';
import { defaultMagnifications } from '../lib/layout';
import {
  appendClipWaypoints,
  removeClipWaypoints,
  syncClipWaypointTrim,
} from '../lib/waypoints';

/** Minimum gap (ms) required between the playhead and either trim edge for a
 *  split to be accepted. Below this the split is a no-op, so we never create
 *  zero-length segments from a fat-fingered ⌘B. */
const SPLIT_MIN_GAP_MS = 100;

interface UseProjectParams {
  projectDir: string | null;
  setProjectDir: React.Dispatch<React.SetStateAction<string | null>>;
  /** Full deserialized `Project` as `load_project` returned it (`null` when
   *  no project is open / not yet hydrated). Auto-save spreads this as the
   *  canonical payload base so persisted fields the UI doesn't manage
   *  round-trip; it also gates auto-save until hydration completes. See
   *  `src/lib/projectPersistence.ts`. */
  setBaseProject: React.Dispatch<React.SetStateAction<Project | null>>;
  clips: Clip[];
  setClips: React.Dispatch<React.SetStateAction<Clip[]>>;
  selectedClipId: string | null;
  setSelectedClipId: React.Dispatch<React.SetStateAction<string | null>>;
  route: Route | null;
  setRoute: React.Dispatch<React.SetStateAction<Route | null>>;
  setMapSettings: React.Dispatch<React.SetStateAction<MapSettings>>;
  setTransitionFeel: React.Dispatch<React.SetStateAction<TransitionFeel | undefined>>;
  setProjectLayouts: React.Dispatch<React.SetStateAction<ProjectLayouts>>;
  setMapMagnifications: React.Dispatch<React.SetStateAction<MapMagnifications>>;
  setSelectedExportAspect: React.Dispatch<React.SetStateAction<AspectRatio>>;
  setLastExportSelection: React.Dispatch<React.SetStateAction<ExportGrid | null>>;
  setWaypoints: React.Dispatch<React.SetStateAction<Waypoint[]>>;
  generateProxiesAndThumbnails: (clipList: Clip[], dir: string) => Promise<void>;
  setProxies: React.Dispatch<React.SetStateAction<Record<string, string | 'generating' | null>>>;
  setThumbnails: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setImportError: (err: string | null) => void;
  loadRecentProjects: () => Promise<void>;
}

export function useProject({
  projectDir,
  setProjectDir,
  setBaseProject,
  clips,
  setClips,
  selectedClipId,
  setSelectedClipId,
  route: _route,
  setRoute,
  setMapSettings,
  setTransitionFeel,
  setProjectLayouts,
  setMapMagnifications,
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

      // All load-time normalization (route `?? null` IPC guard, map-settings
      // merge, layout/aspect backfills, legacy waypoint seeding) lives in
      // `hydrateProjectState` — the single inverse of the auto-save payload.
      const fallbackName = dir.split('/').pop()?.replace('.trailcut', '') ?? 'Untitled';
      const hydrated = hydrateProjectState(project, fallbackName);
      setProjectName(hydrated.projectName);
      setProjectThumbnail(hydrated.projectThumbnail);
      setClips(hydrated.clips);
      setRoute(hydrated.route);
      setMapSettings(hydrated.mapSettings);
      setTransitionFeel(hydrated.transitionFeel);
      setProjectLayouts(hydrated.projectLayouts);
      setMapMagnifications(hydrated.mapMagnifications);
      setSelectedExportAspect(hydrated.selectedExportAspect);
      // Hydrating App-level state here is the sole load-time entry point —
      // the Export modal reads from this on open.
      setLastExportSelection(hydrated.lastExportSelection);
      setWaypoints(hydrated.waypoints);
      // Keep the full deserialized Project as the auto-save base: persisted
      // fields the editor doesn't manage (working_color_space, start_camera,
      // default_entry_transition, future schema additions) round-trip to
      // disk through it. Setting it is also the auto-save arming switch —
      // until it lands, useAutoSave refuses to write, so a half-hydrated
      // session can never clobber a real project.json.
      setBaseProject(project);

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
      // Read back the canonical `Project::default()` that create_project
      // just wrote — it becomes the auto-save payload base (and arms
      // auto-save). Loading from disk instead of hand-building a TS default
      // keeps Rust the single source of truth for the fresh-project shape.
      const project = await invoke<Project>('load_project', { projectDir: selected });
      setProjectDir(selected);
      setProjectName(selected.split('/').pop()?.replace('.trailcut', '') ?? 'Untitled');
      setProjectThumbnail(null);
      setClips([]);
      setRoute(null);
      setMapSettings(DEFAULT_MAP_SETTINGS);
      setTransitionFeel(undefined);
      // Mirror the Rust-side `Project::default()` seed — task 080 / 100.
      setProjectLayouts(seededLayouts());
      setMapMagnifications(defaultMagnifications());
      setSelectedExportAspect('9_16');
      setLastExportSelection(null);
      setWaypoints([]);
      setProxies({});
      setThumbnails({});
      setSelectedClipId(null);
      setBaseProject(project);
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
    // Disarm auto-save first thing: with the base cleared, no debounced
    // write can fire against the next project's (or no project's) state.
    setBaseProject(null);
    setProjectName('');
    setProjectThumbnail(null);
    setClips([]);
    setRoute(null);
    setMapSettings(DEFAULT_MAP_SETTINGS);
    setTransitionFeel(undefined);
    setProjectLayouts(seededLayouts());
    setMapMagnifications(defaultMagnifications());
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

  /** WS9 — set or clear the per-clip source-format override and trigger a
   *  proxy regeneration. `override === null` clears
   *  `user_color_class_override`; any class value writes the override.
   *
   *  Proxy regeneration: the cached proxy on disk was rendered against the
   *  *old* effective class, so it's stale the moment the override changes.
   *  We delete + re-render via `regenerate_proxy_for_class` so the new
   *  ingest formula (e.g. LUT-developed D-Log → SDR) applies. The proxy
   *  map is set to `'generating'` while ffmpeg runs so VideoPreview knows
   *  to show the spinner instead of a stale frame.
   *
   *  No-op when:
   *    - no clip selected
   *    - the override didn't actually change (e.g. user re-picked the same
   *      option from the dropdown — common when reopening a project) */
  function handleUpdateSourceFormat(override: SourceColorClass | null) {
    if (!selectedClipId) return;
    const clip = clips.find((c) => c.id === selectedClipId);
    if (!clip) return;

    const currentOverride = clip.user_color_class_override ?? null;
    if (currentOverride === override) return;

    const nextClip: Clip = {
      ...clip,
      user_color_class_override: override ?? undefined,
    };
    setClips((prev) => prev.map((c) => (c.id === clip.id ? nextClip : c)));

    if (projectDir) {
      regenerateClipProxy(nextClip, projectDir);
    }
  }

  /** Fire a `regenerate_proxy_for_class` for a single clip, marking the
   *  proxy slot as `'generating'` so the video preview swaps to a spinner.
   *  Used by `handleUpdateSourceFormat` (single-clip override) after the
   *  user toggles the per-clip Inspector dropdown. The import-time path
   *  has its own class-aware initial-proxy run inside `useMediaImport`'s
   *  `generateProxiesAndThumbnails`, so this is only needed for in-edit
   *  changes — not for first proxy generation. */
  function regenerateClipProxy(clip: Clip, dir: string) {
    const effective = effectiveSourceClass(clip);
    setProxies((prev) => ({ ...prev, [clip.id]: 'generating' }));
    invoke<string>('regenerate_proxy_for_class', {
      sourcePath: clip.path,
      projectDir: dir,
      colorClass: effective,
    })
      .then((proxyPath) => {
        setProxies((prev) => ({ ...prev, [clip.id]: proxyPath }));
      })
      .catch(() => {
        setProxies((prev) => ({ ...prev, [clip.id]: null }));
      });
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
    handleUpdateSourceFormat,
    handleSplitClip,
  };
}
