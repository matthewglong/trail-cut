import { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { CameraPreset, ClipMetadata, Clip, Route, SourceColorClass, Waypoint } from '../types';
import { mergeClips, newClipFromMetadata } from '../utils/clips';
import { appendClipWaypoints } from '../lib/waypoints';
import { effectiveSourceClass } from '../lib/sourceFormat';

export type ProxyMap = Record<string, string | 'generating' | null>;
export type ThumbnailMap = Record<string, string>;

/** WS9 — staged metadata waiting on the user's source-format confirmation.
 *  Populated by `importPaths` after `import_media` returns; consumed by the
 *  `SourceFormatConfirmDialog` modal which decides what overrides to apply
 *  before the clips land in project state. `null` means "no pending dialog;
 *  nothing to confirm". */
export interface PendingImport {
  /** Freshly-imported metadata, including WS8 `suggested_log_class` and the
   *  WS0 auto-classified `source_color_class`. The dialog reads these to
   *  group + suggest defaults. */
  clips: ClipMetadata[];
  /** Snapshot of the camera-preset store at the moment import completed.
   *  Used to pre-populate dropdown defaults for matching cameras (per the
   *  brief: "if a clip's (make, model) matches a preset, pre-set the
   *  dropdown default to the preset value"). */
  presets: CameraPreset[];
}

/** WS9 — build an override map from camera presets for a freshly-imported
 *  batch. Used by the "no-suggestion shortcut" path in `importPaths` to
 *  apply presets silently when the dialog is skipped (presets are a prior
 *  user opt-in, so applying them without re-prompting matches the contract
 *  the user agreed to when they ticked "Remember").
 *
 *  Returns an override per clip whose `(camera_make, camera_model)` matches
 *  a preset entry. Clips with no matching preset are omitted from the map
 *  (the caller's downstream code treats absent keys as "no override"). */
export function buildPresetOverrides(
  clips: ClipMetadata[],
  presets: CameraPreset[],
): Map<string, SourceColorClass | null> {
  const overrides = new Map<string, SourceColorClass | null>();
  if (presets.length === 0) return overrides;
  for (const clip of clips) {
    const make = clip.camera_make?.trim();
    const model = clip.camera_model?.trim();
    if (!make || !model) continue;
    const preset = presets.find((p) => p.make === make && p.model === model);
    if (preset) {
      overrides.set(clip.id, preset.color_class);
    }
  }
  return overrides;
}

interface UseMediaImportParams {
  projectDir: string | null;
  setClips: React.Dispatch<React.SetStateAction<Clip[]>>;
  setSelectedClipId: React.Dispatch<React.SetStateAction<string | null>>;
  setRoute: React.Dispatch<React.SetStateAction<Route | null>>;
  setWaypoints: React.Dispatch<React.SetStateAction<Waypoint[]>>;
}

export function useMediaImport({ projectDir, setClips, setSelectedClipId, setRoute, setWaypoints }: UseMediaImportParams) {
  const [proxies, setProxies] = useState<ProxyMap>({});
  const [thumbnails, setThumbnails] = useState<ThumbnailMap>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** WS9 — staged import waiting on user confirmation. `null` when no dialog
   *  should be shown. Populated by `importPaths`; cleared by
   *  `confirmPendingImport` / `skipPendingImport`. */
  const [pendingImportClips, setPendingImportClips] = useState<PendingImport | null>(null);
  /** Proxy seed for the staged clips. Holds the cleared overrides applied at
   *  confirm time so we can reuse a single `_finalizeImport` path for both
   *  "Skip" (no overrides) and "Apply" (some overrides). */
  const proxiesRef = useRef(proxies);
  useEffect(() => { proxiesRef.current = proxies; }, [proxies]);

  // Use a ref so async functions always see the latest projectDir
  const projectDirRef = useRef(projectDir);
  useEffect(() => {
    projectDirRef.current = projectDir;
  }, [projectDir]);

  const generateProxiesAndThumbnails = useCallback(async (clipList: Clip[], dir: string) => {
    console.log('[import] generateProxiesAndThumbnails start', { count: clipList.length, dir });
    for (const clip of clipList) {
      console.log('[import] kicking thumbnail+proxy for', clip.id, clip.path);
      invoke<string>('generate_thumbnail', { sourcePath: clip.path, projectDir: dir })
        .then((thumbPath) => {
          console.log('[import] thumbnail done', clip.id, thumbPath);
          setThumbnails((prev) => ({ ...prev, [clip.id]: thumbPath }));
        })
        .catch((err) => {
          console.error('[import] thumbnail failed', clip.id, err);
        });

      setProxies((prev) => ({ ...prev, [clip.id]: 'generating' }));
      // WS9 — when the user has declared a `user_color_class_override`,
      // route the initial proxy through the class-aware `regenerate_proxy_for_class`
      // entry point so the right ingest formula (e.g. D-Log LUT) drives
      // the first frame the user sees. `generate_proxy` re-probes the
      // source and would land on the auto-detected (SDR) branch — the
      // override is invisible to it because the IPC boundary only carries
      // a path, not the Clip model. For clips with no override (the
      // common case: SDR/HDR auto-detected), keep the cache-friendly
      // `generate_proxy` path so project re-opens don't re-render every
      // proxy from scratch.
      const hasOverride = clip.user_color_class_override !== undefined;
      const proxyInvoke = hasOverride
        ? invoke<string>('regenerate_proxy_for_class', {
            sourcePath: clip.path,
            projectDir: dir,
            colorClass: effectiveSourceClass(clip),
          })
        : invoke<string>('generate_proxy', { sourcePath: clip.path, projectDir: dir });
      proxyInvoke
        .then((proxyPath) => {
          console.log('[import] proxy done', clip.id, proxyPath);
          setProxies((prev) => ({ ...prev, [clip.id]: proxyPath }));
        })
        .catch((err) => {
          console.error('[import] proxy failed', clip.id, err);
          setProxies((prev) => ({ ...prev, [clip.id]: null }));
        });
    }
  }, []);

  async function importPaths(paths: string[]) {
    const dir = projectDirRef.current;
    if (!dir || paths.length === 0) return;
    try {
      setLoading(true);
      setError(null);

      const result = await invoke<ClipMetadata[]>('import_media', { paths });

      // Figure out which are net-new BEFORE staging the dialog. Re-imports
      // (same path → same id) bypass the source-format dialog entirely:
      // they're metadata refreshes, not new clips, so we don't pop a UI
      // asking the user to re-confirm a class they already declared.
      // Re-imports still flush through to `mergeClips` immediately so any
      // refreshed timestamps / GPS land in state.
      const newResults = result.filter((c) => !(c.id in proxiesRef.current));
      const reimports = result.filter((c) => c.id in proxiesRef.current);

      if (reimports.length > 0) {
        setClips((prev) => mergeClips(prev, reimports));
      }

      if (newResults.length === 0) {
        // Pure re-import — nothing to confirm. Bail out of the staging path.
        return;
      }

      // Load camera presets once per import so the dialog can pre-populate
      // dropdown defaults for matching cameras (brief §3: "if a clip's
      // (make, model) matches a preset, pre-set the dropdown default to the
      // preset value"). A failure here degrades gracefully — the user just
      // sees no preset matches; they can still confirm manually.
      let presets: CameraPreset[] = [];
      try {
        presets = await invoke<CameraPreset[]>('get_camera_presets');
      } catch (err) {
        console.warn('source-format: failed to load camera presets', err);
      }

      // WS9 (QA important #10) — only stage the dialog when there's
      // actually something for the user to confirm. The dialog exists to
      // surface log-format declarations (Decision 5 in ARCHITECTURE: "log
      // formats… are offered to the user as a *suggestion*, not auto-
      // applied"). When no clip carries a `suggested_log_class`, the
      // auto-detected HDR/SDR classes are authoritative and there's
      // nothing to ask about — popping a dialog just for "Detected: SDR"
      // rows is friction. Preset matches, if any, are applied silently
      // because the user already opted in via "Remember" on a prior
      // import.
      const hasAnySuggestion = newResults.some((c) => c.suggested_log_class !== undefined);
      if (!hasAnySuggestion) {
        const presetOverrides = buildPresetOverrides(newResults, presets);
        _finalizeImport({ clips: newResults, presets }, presetOverrides);
        return;
      }

      // Stage the dialog. The user's choice routes through
      // `confirmPendingImport` or `skipPendingImport` below, which is what
      // actually merges the clips into state + kicks proxy generation off.
      setPendingImportClips({ clips: newResults, presets });
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  /** WS9 — finish staging a pending import. Shared body for "Apply" and
   *  "Skip"; the only difference is the `overrides` map (empty on Skip).
   *  Always merges clips, seeds waypoints, and kicks off proxy +
   *  thumbnail generation. */
  function _finalizeImport(
    pending: PendingImport,
    overrides: Map<string, SourceColorClass | null>,
  ) {
    const dir = projectDirRef.current;
    if (!dir) return;

    // Apply the override map to the staged metadata before promoting to
    // Clips. Doing it here (rather than after `mergeClips`) means the
    // initial proxy run already targets the user-selected class — no
    // wasted SDR-branch generation followed by a regenerate.
    const finalisedClips: Clip[] = pending.clips.map((meta) => {
      const baseClip = newClipFromMetadata(meta);
      const override = overrides.get(meta.id);
      if (override !== undefined && override !== null) {
        baseClip.user_color_class_override = override;
      }
      return baseClip;
    });

    setClips((prev) => mergeClips(prev, finalisedClips as unknown as ClipMetadata[]));
    setSelectedClipId((prev) => prev ?? finalisedClips[0]?.id ?? null);
    setWaypoints((prev) => appendClipWaypoints(prev, finalisedClips));
    generateProxiesAndThumbnails(finalisedClips, dir);
  }

  /** WS9 — user confirmed source-format selections from the import dialog.
   *  `overrides` maps clip id to the class the user picked (null = leave
   *  on auto-detected). `presetsToPersist` is the set of `(make, model)` →
   *  class pairs the user opted to remember via the per-group checkbox;
   *  these are written to `~/.trailcut/camera_presets.json` so future
   *  imports of the same camera pre-populate the dropdown.
   *
   *  `_finalizeImport` is intentionally not in the dependency array — it's
   *  a hook-local closure that doesn't change between renders (it reads
   *  refs / direct setters that are stable). Adding it to the deps would
   *  invalidate the callback every render and break referential
   *  stability for the dialog's onApply prop. */
  const confirmPendingImport = useCallback(
    async (
      overrides: Map<string, SourceColorClass | null>,
      presetsToPersist: CameraPreset[],
    ) => {
      const pending = pendingImportClips;
      if (!pending) return;
      setPendingImportClips(null);

      // Persist remembered presets. Best-effort: a write failure here is
      // user-facing-quiet (the import still completes) but logged so dev
      // builds can spot it.
      for (const preset of presetsToPersist) {
        try {
          await invoke('set_camera_preset', {
            make: preset.make,
            model: preset.model,
            colorClass: preset.color_class,
          });
        } catch (err) {
          console.warn('source-format: failed to persist preset', preset, err);
        }
      }

      _finalizeImport(pending, overrides);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pendingImportClips],
  );

  /** WS9 — user skipped the source-format dialog. Equivalent to "Apply"
   *  with no overrides and no preset writes; clips land with their
   *  auto-detected class. */
  const skipPendingImport = useCallback(() => {
    const pending = pendingImportClips;
    if (!pending) return;
    setPendingImportClips(null);
    _finalizeImport(pending, new Map());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingImportClips]);

  async function handleImportFiles() {
    if (!projectDirRef.current) return;
    try {
      const selected = await open({
        multiple: true,
        directory: false,
        filters: [{ name: 'Video Files', extensions: ['mov', 'mp4', 'm4v'] }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      await importPaths(paths as string[]);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleImportFolder() {
    if (!projectDirRef.current) return;
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected) return;
      await importPaths([selected as string]);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleImportGpx() {
    const dir = projectDirRef.current;
    if (!dir) return;
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'GPS Route', extensions: ['gpx'] }],
      });
      if (!selected) return;

      setLoading(true);
      setError(null);

      const result = await invoke<Route>('parse_gpx', { filePath: selected, projectDir: dir });
      setRoute(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return {
    proxies,
    setProxies,
    thumbnails,
    setThumbnails,
    loading,
    error,
    setError,
    generateProxiesAndThumbnails,
    handleImportFiles,
    handleImportFolder,
    handleImportGpx,
    // WS9 — source-format confirmation UI
    pendingImportClips,
    confirmPendingImport,
    skipPendingImport,
  };
}
