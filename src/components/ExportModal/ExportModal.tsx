import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, ask } from '@tauri-apps/plugin-dialog';
import { exists } from '@tauri-apps/plugin-fs';
import { videoDir, join } from '@tauri-apps/api/path';
import { ExportGrid } from './ExportGrid';
import { ConfigExportModal, configToInitial } from './ConfigExportModal';
import type {
  CellConflict,
  FpsDisabled,
  QualityDisabled,
} from './ConfigExportModal';
import { QueueView } from './QueueView';
import { QueueSummary } from './QueueSummary';
import {
  deriveJobs,
  gridJobCount,
  type ExportJob,
} from '../../lib/exportFilenames';
import {
  buildJobRequest,
  type ExportRequestContext,
  type RenderExportRequest,
} from '../../lib/exportRequest';
import { useExportQueue } from '../../hooks/useExportQueue';
import {
  defaultDeliveryTargetForChannel,
  resolveDeliveryTarget,
  type AspectRatio,
  type CellKey,
  type Clip,
  type DeliveryTarget,
  type ExportChannel,
  type ExportConfig,
  type ExportFps,
  type ExportGrid as ExportGridModel,
  type MapMagnifications,
  type MapSettings,
  type OutputResolution,
  type ProjectLayouts,
  type Route,
  type TransitionFeel,
  type Waypoint,
} from '../../types';

const DISABLED_RENDER_TOOLTIP =
  'Add at least one export and choose an output folder to enable Render';

type View = 'select' | 'running' | 'done';
type ConfigState =
  | { aspect: AspectRatio; channel: ExportChannel; mode: 'add' }
  | {
      aspect: AspectRatio;
      channel: ExportChannel;
      mode: 'edit';
      editingId: string;
      initial: ExportConfig;
    };

export interface ExportModalProps {
  open: boolean;
  onClose: () => void;
  selection: ExportGridModel;
  onSelectionChange: (next: ExportGridModel) => void;
  /** Last-confirmed selection from a prior successful export. When the modal
   *  transitions `false → true`, the parent-managed `selection` is
   *  rehydrated from this value via `onSelectionChange`. `null` means "no
   *  prior export — start clean (empty grid, no folder)". */
  lastExportSelection?: ExportGridModel | null;
  /** Called once per queue completion when at least one job finished
   *  successfully. The parent persists the value to project state, where
   *  `useAutoSave` writes it to disk on the next debounce tick. Cancelled
   *  queues with zero done jobs do NOT trigger this — the previous
   *  `lastExportSelection` survives. */
  onSelectionPersist?: (selection: ExportGridModel) => void;
  projectName: string;
  clips: Clip[];
  route: Route | null;
  mapSettings: MapSettings;
  /** First-class waypoints (schema v7). Forwarded into every job request via
   *  `buildJobRequest` → `RenderExportRequest.waypoints`. */
  waypoints: Waypoint[];
  transitionFeel?: TransitionFeel;
  projectLayouts: ProjectLayouts;
  /** Per-aspect map magnification. Each queued job picks its own aspect's
   *  factor via `buildJobRequest` → `LayoutDescriptor.magnification`. */
  mapMagnifications?: MapMagnifications;
  /** Project bundle directory — `buildExportRequest` resolves the custom
   *  POV image's bundle-relative asset path against it for the renderer
   *  (schema v10). */
  projectDir?: string | null;
}

const EMPTY_GRID: ExportGridModel = { cells: {}, output_dir: null };

/** Default chip when the user opens the secondary modal in add mode. The
 *  delivery target intentionally omits here — `ConfigExportModal` resolves
 *  the per-channel default (`composite` → social vertical, others →
 *  ProRes) so the same `DEFAULT_INITIAL` constant works for every cell. */
const DEFAULT_INITIAL: {
  quality: OutputResolution;
  fps: ExportFps;
  delivery_target?: DeliveryTarget;
} = { quality: '1080p', fps: 30 };

/** Pixel-height threshold per quality tier — short edge of the output
 *  canvas. Mirrors the comment on `OutputResolution` in `lib/layout.ts`. */
const QUALITY_SHORT_EDGE: Record<OutputResolution, number> = {
  '720p': 720,
  '1080p': 1080,
  '1440p': 1440,
  '2160p': 2160,
};
const QUALITY_TIERS: ReadonlyArray<OutputResolution> = [
  '720p',
  '1080p',
  '1440p',
  '2160p',
];
const FPS_TIERS: ReadonlyArray<ExportFps> = [24, 30, 60];

function parseSourceShortEdge(resolution: string | null | undefined): number | null {
  if (!resolution) return null;
  const m = resolution.match(/^(\d+)x(\d+)$/);
  if (!m) return null;
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  return Math.min(w, h);
}

/** Max short-edge resolution and max fps across visible clips. Used to gate
 *  composite + video_only quality/fps in the secondary modal. Source < target
 *  triggers a tooltip-explained hard-disable per the design notes. */
function summarizeSource(clips: Clip[]): {
  maxShortEdge: number | null;
  maxFps: number | null;
  resolutionLabel: string | null;
  fpsLabel: string | null;
} {
  let maxShortEdge: number | null = null;
  let maxFps: number | null = null;
  let resolutionLabel: string | null = null;
  for (const clip of clips) {
    if (clip.visible === false) continue;
    const edge = parseSourceShortEdge(clip.resolution);
    if (edge != null && (maxShortEdge == null || edge > maxShortEdge)) {
      maxShortEdge = edge;
      resolutionLabel = clip.resolution;
    }
    if (typeof clip.frame_rate === 'number') {
      if (maxFps == null || clip.frame_rate > maxFps) maxFps = clip.frame_rate;
    }
  }
  return {
    maxShortEdge,
    maxFps,
    resolutionLabel,
    fpsLabel: maxFps != null ? `${maxFps} fps` : null,
  };
}

export function ExportModal({
  open,
  onClose,
  selection,
  onSelectionChange,
  lastExportSelection,
  onSelectionPersist,
  projectName,
  clips,
  route,
  mapSettings,
  waypoints,
  transitionFeel,
  projectLayouts,
  mapMagnifications,
  projectDir,
}: ExportModalProps) {
  const [view, setView] = useState<View>('select');
  const [configState, setConfigState] = useState<ConfigState | null>(null);
  const queue = useExportQueue();
  const outputFolder = selection.output_dir;
  // Latch so `onSelectionPersist` fires exactly once per queue completion.
  const persistedThisRunRef = useRef(false);
  const selectionRef = useRef(selection);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  // Source-capability summary for the secondary modal's disable rules.
  const sourceSummary = useMemo(() => summarizeSource(clips), [clips]);

  // Modal-close lifecycle: backdrop / Esc are gated by view AND by whether
  // the secondary modal is open (Esc should close the secondary first).
  useEffect(() => {
    if (!open) return;
    if (configState !== null) return; // secondary modal owns Esc
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (view === 'running') return;
      e.stopPropagation();
      handleClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view, configState]);

  // Watch the queue for completion to advance the view. Both terminal
  // states ('done' = ran to completion, 'cancelled' = user broke out mid-
  // run) route to the same done summary; QueueSummary differentiates the
  // copy based on which jobs are in which state.
  useEffect(() => {
    if (view !== 'running') return;
    if (queue.queueState === 'done' || queue.queueState === 'cancelled') {
      setView('done');
    }
  }, [view, queue.queueState]);

  // Persist the user's selection on any terminal state where at least one
  // job finished — including cancelled runs that completed some jobs. The
  // user got value from those choices; remembering them matches their
  // expectation on reopen.
  useEffect(() => {
    if (queue.queueState !== 'done' && queue.queueState !== 'cancelled') return;
    if (persistedThisRunRef.current) return;
    if (!queue.jobs.some((j) => j.state === 'done')) return;
    persistedThisRunRef.current = true;
    onSelectionPersist?.(selectionRef.current);
  }, [queue.queueState, queue.jobs, onSelectionPersist]);

  // Prefill + auto-default in one effect on open. On a close → open
  // transition we replace the parent's selection with `lastExportSelection`
  // (verbatim — "the user reopened after a prior export"); on initial mount
  // we honor whatever `selection` the parent passed in. Then, if the
  // resulting selection has no `output_dir`, we resolve
  // `~/Movies/TrailCut/{projectName}` via the Rust auto-numbering helper.
  //
  // Merged into one effect (rather than two) so the auto-default sees the
  // post-prefill folder synchronously — running them as separate effects
  // races the parent's setState propagation and can silently skip the
  // resolver in the narrow case where the parent's pre-close selection
  // had a folder but `lastExportSelection` doesn't.
  const prevOpenRef = useRef(open);
  const autoDefaultedRef = useRef(false);
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (!open) return;
    if (autoDefaultedRef.current) return;

    const effective: ExportGridModel = !wasOpen
      ? (lastExportSelection ?? EMPTY_GRID)
      : selectionRef.current;
    if (!wasOpen) {
      onSelectionChange(effective);
    }
    autoDefaultedRef.current = true;
    if (effective.output_dir != null) return;

    let cancelled = false;
    (async () => {
      try {
        const movies = await videoDir();
        const base = await join(movies, 'TrailCut');
        const resolved = await invoke<string>('resolve_output_dir', {
          base,
          name: projectName,
        });
        if (cancelled) return;
        // The async closure can race a synchronous folder pick (user
        // clicked Choose… and the picker resolved before us). Re-read the
        // live selection from the ref and bail out if it already has a
        // folder, so we don't clobber the user's choice.
        const current = selectionRef.current;
        if (current.output_dir != null) return;
        onSelectionChange({ ...current, output_dir: resolved });
      } catch {
        // Resolver failed (no Movies dir, FS error, …). Leave the folder
        // unset — the user can still pick manually.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset modal state on close so the next open starts clean.
  useEffect(() => {
    if (open) return;
    setView('select');
    setConfigState(null);
    queue.reset();
    persistedThisRunRef.current = false;
    autoDefaultedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ---- Cell-level mutations -------------------------------------------------
  const updateCell = useCallback(
    (
      aspect: AspectRatio,
      channel: ExportChannel,
      updater: (prev: ExportConfig[]) => ExportConfig[],
    ) => {
      const key: CellKey = `${aspect}-${channel}`;
      const prevConfigs = selectionRef.current.cells[key] ?? [];
      const next = updater(prevConfigs);
      const nextCells: ExportGridModel['cells'] = { ...selectionRef.current.cells };
      if (next.length === 0) {
        delete nextCells[key];
      } else {
        nextCells[key] = next;
      }
      onSelectionChange({ ...selectionRef.current, cells: nextCells });
    },
    [onSelectionChange],
  );

  const handleAdd = useCallback((aspect: AspectRatio, channel: ExportChannel) => {
    setConfigState({ aspect, channel, mode: 'add' });
  }, []);

  const handleEditChip = useCallback(
    (aspect: AspectRatio, channel: ExportChannel, config: ExportConfig) => {
      setConfigState({
        aspect,
        channel,
        mode: 'edit',
        editingId: config.id,
        initial: config,
      });
    },
    [],
  );

  const handleRemoveChip = useCallback(
    (aspect: AspectRatio, channel: ExportChannel, configId: string) => {
      updateCell(aspect, channel, (prev) => prev.filter((c) => c.id !== configId));
    },
    [updateCell],
  );

  const handleConfigSave = useCallback(
    (next: {
      quality: OutputResolution;
      fps: ExportFps;
      delivery_target: DeliveryTarget;
    }) => {
      if (configState === null) return;
      const { aspect, channel } = configState;
      // Only persist `delivery_target` on the chip when it diverges from the
      // channel default. Composite + `sdr_h265` is the most-common
      // case; storing it implicitly keeps `project.json` quiet and lets a
      // future default change propagate without a migration. Non-default
      // selections (HDR, ProRes on composite, etc.) round-trip explicitly.
      const channelDefault = defaultDeliveryTargetForChannel(channel);
      const explicitTarget =
        next.delivery_target === channelDefault ? undefined : next.delivery_target;
      if (configState.mode === 'edit') {
        const editingId = configState.editingId;
        updateCell(aspect, channel, (prev) =>
          prev.map((c) =>
            c.id === editingId
              ? {
                  ...c,
                  quality: next.quality,
                  fps: next.fps,
                  delivery_target: explicitTarget,
                }
              : c,
          ),
        );
      } else {
        const id = newConfigId();
        updateCell(aspect, channel, (prev) => [
          ...prev,
          {
            id,
            quality: next.quality,
            fps: next.fps,
            delivery_target: explicitTarget,
          },
        ]);
      }
      setConfigState(null);
    },
    [configState, updateCell],
  );

  const handleConfigCancel = useCallback(() => setConfigState(null), []);

  // ---- Secondary-modal disable rules ----------------------------------------
  // Composite + video_only branches consume the source media; map_only is
  // procedural and always allows everything. The disable lists here surface
  // the source-ceiling tooltips per the design notes.
  const { disabledQualities, disabledFps } = useMemo(() => {
    if (configState == null) {
      return { disabledQualities: [], disabledFps: [] };
    }
    if (configState.channel === 'map_only') {
      return { disabledQualities: [], disabledFps: [] };
    }
    const dq: QualityDisabled[] = [];
    const df: FpsDisabled[] = [];
    const { maxShortEdge, maxFps, resolutionLabel, fpsLabel } = sourceSummary;
    if (maxShortEdge != null) {
      for (const tier of QUALITY_TIERS) {
        if (QUALITY_SHORT_EDGE[tier] > maxShortEdge) {
          dq.push({
            quality: tier,
            reason: resolutionLabel
              ? `Source ${resolutionLabel} — would require upsample`
              : `Source too small for ${tier}`,
          });
        }
      }
    }
    if (maxFps != null) {
      for (const fps of FPS_TIERS) {
        if (fps > maxFps) {
          df.push({
            fps,
            reason: fpsLabel
              ? `Source ${fpsLabel} — would require frame duplication`
              : `Source fps too low for ${fps}`,
          });
        }
      }
    }
    return { disabledQualities: dq, disabledFps: df };
  }, [configState, sourceSummary]);

  // Conflict combos = (quality, fps, delivery_target) tuples currently
  // present in the target cell, excluding the chip the user is editing. In
  // add mode every present tuple conflicts. In edit mode the chip's own
  // tuple is excluded so the user can re-save without modifications. WS5
  // added `delivery_target` to the tuple — two chips that share
  // (quality, fps) but differ on target are legal (e.g. same cell rendered
  // for TikTok and as a ProRes master).
  const conflictingCombos: CellConflict[] = useMemo(() => {
    if (configState == null) return [];
    const key: CellKey = `${configState.aspect}-${configState.channel}`;
    const configs = selection.cells[key] ?? [];
    return configs
      .filter((c) => configState.mode === 'add' || c.id !== configState.editingId)
      .map((c) => ({
        quality: c.quality,
        fps: c.fps,
        delivery_target: resolveDeliveryTarget(c, configState.channel),
      }));
  }, [configState, selection.cells]);

  if (!open) return null;

  const handleChooseFolder = async () => {
    let result: string | string[] | null;
    try {
      result = (await openDialog({ directory: true, multiple: false })) as
        | string
        | string[]
        | null;
    } catch {
      return;
    }
    let chosen: string | null = null;
    if (typeof result === 'string') chosen = result;
    else if (Array.isArray(result) && result.length > 0) chosen = result[0];
    if (chosen != null) {
      onSelectionChange({ ...selection, output_dir: chosen });
    }
  };

  const handleClose = () => {
    if (view === 'running') return;
    queue.reset();
    setView('select');
    setConfigState(null);
    onClose();
  };

  const handleBackdropClick = () => {
    if (view === 'running') return;
    if (configState !== null) return; // secondary modal owns clicks
    handleClose();
  };

  const jobCount = gridJobCount(selection);

  const handleRender = async () => {
    if (!outputFolder || jobCount === 0) return;
    const jobs = deriveJobs(projectName, outputFolder, selection);

    const collisions: string[] = [];
    for (const job of jobs) {
      try {
        if (await exists(job.outputPath)) collisions.push(job.outputPath);
      } catch {
        // Treat probe failure as "doesn't exist".
      }
    }

    if (collisions.length > 0) {
      let proceed = false;
      try {
        proceed = await ask(
          `${collisions.length} file${collisions.length === 1 ? '' : 's'} already exist and will be overwritten. Continue?`,
          { title: 'Overwrite existing files?', kind: 'warning' },
        );
      } catch {
        return;
      }
      if (!proceed) return;
    }

    const context: ExportRequestContext = {
      clips,
      route,
      mapSettings,
      waypoints,
      transitionFeel,
      layouts: projectLayouts,
      magnifications: mapMagnifications,
      projectDir,
    };
    const buildRequest = (job: ExportJob): RenderExportRequest =>
      buildJobRequest(context, job);

    setView('running');
    queue.start(jobs, buildRequest);
  };

  const renderEnabled = jobCount > 0 && outputFolder !== null;
  const renderDisabled = !renderEnabled;
  const configInitial =
    configState?.mode === 'edit'
      ? configToInitial(configState.initial)
      : DEFAULT_INITIAL;

  return (
    <div
      style={styles.backdrop}
      onClick={handleBackdropClick}
      data-testid="export-modal-backdrop"
    >
      <div
        style={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Export"
        data-testid="export-modal"
      >
        <div style={styles.header}>
          <h2 style={styles.title}>{viewTitle(view)}</h2>
        </div>

        <div style={styles.body}>
          {view === 'select' && (
            <>
              <section style={styles.section}>
                <div style={styles.label}>Configured exports</div>
                <ExportGrid
                  grid={selection}
                  onAdd={handleAdd}
                  onEditChip={handleEditChip}
                  onRemoveChip={handleRemoveChip}
                />
              </section>

              <section style={styles.section}>
                <div style={styles.label}>Output folder</div>
                <div style={styles.folderRow} data-testid="export-output-folder">
                  <button
                    type="button"
                    onClick={handleChooseFolder}
                    style={styles.secondaryButton}
                    data-testid="export-output-folder-choose"
                  >
                    Choose…
                  </button>
                  {outputFolder ? (
                    <span
                      style={styles.folderPath}
                      data-testid="export-output-folder-path"
                      title={outputFolder}
                    >
                      {outputFolder}
                    </span>
                  ) : (
                    <span style={styles.folderPlaceholder}>No folder selected</span>
                  )}
                </div>
              </section>
            </>
          )}

          {view === 'running' && (
            <QueueView
              jobs={queue.jobs}
              queueState={queue.queueState}
              onCancel={queue.cancel}
            />
          )}

          {view === 'done' && (
            <QueueSummary
              jobs={queue.jobs}
              outputDir={outputFolder}
              onClose={handleClose}
            />
          )}
        </div>

        {view === 'select' && (
          <div style={styles.footer}>
            <button
              type="button"
              onClick={handleClose}
              style={styles.secondaryButton}
              data-testid="export-modal-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleRender}
              disabled={renderDisabled}
              title={renderDisabled ? DISABLED_RENDER_TOOLTIP : undefined}
              style={renderDisabled ? styles.primaryDisabled : styles.primary}
              data-testid="export-modal-render"
            >
              {jobCount > 0 ? `Render ${jobCount} file${jobCount === 1 ? '' : 's'}` : 'Render'}
            </button>
          </div>
        )}
      </div>

      {configState !== null && (
        <ConfigExportModal
          open={true}
          mode={configState.mode}
          aspect={configState.aspect}
          channel={configState.channel}
          initial={configInitial}
          disabledQualities={disabledQualities}
          disabledFps={disabledFps}
          conflictingCombos={conflictingCombos}
          sourceResolution={
            configState.channel !== 'map_only'
              ? (sourceSummary.resolutionLabel ?? undefined)
              : undefined
          }
          sourceFps={
            configState.channel !== 'map_only'
              ? (sourceSummary.fpsLabel ?? undefined)
              : undefined
          }
          onSave={handleConfigSave}
          onCancel={handleConfigCancel}
        />
      )}
    </div>
  );
}

function viewTitle(view: View): string {
  switch (view) {
    case 'select':
      return 'Export';
    case 'running':
      return 'Rendering…';
    case 'done':
      return 'Export complete';
  }
}

/** Stable id for a freshly-added chip. `crypto.randomUUID` is available in
 *  every Tauri webview (and JSDOM as of Node 20+). The id is used as a React
 *  key and as the trailing token in the queue's per-job id so two chips
 *  added with the same (quality, fps) before the conflict-detect ran still
 *  stay distinguishable. */
function newConfigId(): string {
  return crypto.randomUUID();
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    width: 'min(720px, 92vw)',
    maxHeight: '90vh',
    backgroundColor: '#141b1d',
    border: '1px solid #2c3738',
    borderRadius: '6px',
    color: '#e6ecec',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    boxShadow: '0 24px 80px rgba(0, 0, 0, 0.55)',
  },
  header: {
    padding: '14px 20px',
    borderBottom: '1px solid #2c3738',
    backgroundColor: '#1a2122',
  },
  title: {
    margin: 0,
    fontSize: '15px',
    fontWeight: 700,
    color: '#e6ecec',
  },
  body: {
    padding: '20px',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '22px',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  label: {
    fontSize: '10.5px',
    color: '#8a9697',
    textTransform: 'uppercase',
    letterSpacing: '1.9px',
    fontWeight: 700,
  },
  folderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '6px 6px 6px 12px',
    backgroundColor: '#141b1d',
    border: '1px solid #2c3738',
    borderRadius: '3px',
  },
  folderPlaceholder: {
    fontSize: '11.5px',
    color: '#5a6868',
    fontStyle: 'italic',
    fontFamily: 'JetBrains Mono, monospace',
  },
  folderPath: {
    fontSize: '11.5px',
    color: '#e6ecec',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    direction: 'rtl',
    textAlign: 'left',
    fontFamily: 'JetBrains Mono, monospace',
  },
  footer: {
    padding: '14px 20px',
    borderTop: '1px solid #2c3738',
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '12px',
    backgroundColor: '#1a2122',
  },
  primary: {
    padding: '9px 18px',
    backgroundColor: '#bced09',
    color: '#0e1416',
    border: '1px solid #bced09',
    borderRadius: '3px',
    cursor: 'pointer',
    fontSize: '12.5px',
    fontWeight: 700,
    letterSpacing: '0.2px',
  },
  primaryDisabled: {
    padding: '9px 18px',
    backgroundColor: '#2c3738',
    color: '#5a6868',
    border: '1px solid #2c3738',
    borderRadius: '3px',
    cursor: 'not-allowed',
    fontSize: '12.5px',
    fontWeight: 700,
    letterSpacing: '0.2px',
  },
  secondaryButton: {
    padding: '7px 12px',
    backgroundColor: '#1a2122',
    color: '#e6ecec',
    border: '1px solid #4c5b5c',
    borderRadius: '3px',
    cursor: 'pointer',
    fontSize: '12.5px',
    fontWeight: 600,
  },
};
