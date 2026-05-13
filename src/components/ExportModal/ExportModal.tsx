import { useEffect, useMemo, useRef, useState } from 'react';
import { open as openDialog, ask } from '@tauri-apps/plugin-dialog';
import { exists } from '@tauri-apps/plugin-fs';
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
import type {
  Clip,
  ExportGrid,
  MapSettings,
  ProjectLayouts,
  Route,
  TransitionFeel,
} from '../../types';

const DISABLED_RENDER_TOOLTIP =
  'Add at least one export and choose an output folder to enable Render';

type View = 'select' | 'running' | 'done';

export interface ExportModalProps {
  open: boolean;
  onClose: () => void;
  selection: ExportGrid;
  onSelectionChange: (next: ExportGrid) => void;
  /** Last-confirmed selection from a prior successful export. When the modal
   *  transitions `false → true`, the parent-managed `selection` is
   *  rehydrated from this value via `onSelectionChange`. `null` means "no
   *  prior export — start clean (empty grid, no folder)". */
  lastExportSelection?: ExportGrid | null;
  /** Called once per queue completion when at least one job finished
   *  successfully. The parent persists the value to project state, where
   *  `useAutoSave` writes it to disk on the next debounce tick. Cancelled
   *  queues with zero done jobs do NOT trigger this — the previous
   *  `lastExportSelection` survives. */
  onSelectionPersist?: (selection: ExportGrid) => void;
  projectName: string;
  clips: Clip[];
  route: Route | null;
  mapSettings: MapSettings;
  transitionFeel?: TransitionFeel;
  projectLayouts: ProjectLayouts;
}

const EMPTY_GRID: ExportGrid = { cells: {}, output_dir: null };

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
  transitionFeel,
  projectLayouts,
}: ExportModalProps) {
  const [view, setView] = useState<View>('select');
  const queue = useExportQueue();
  const outputFolder = selection.output_dir;
  // Latch so `onSelectionPersist` fires exactly once per queue completion.
  const persistedThisRunRef = useRef(false);
  const selectionRef = useRef(selection);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  const { nClips, timelineDurationSec } = useMemo(() => {
    let total = 0;
    let count = 0;
    for (const clip of clips) {
      if (clip.visible === false) continue;
      const trim = clip.trim;
      if (!trim) continue;
      const speed = clip.effects?.speed ?? 1;
      if (speed <= 0) continue;
      total += (trim.out_ms - trim.in_ms) / 1000 / speed;
      count += 1;
    }
    return { nClips: count, timelineDurationSec: total };
  }, [clips]);

  // Modal-close lifecycle: backdrop / Esc are gated by view.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (view === 'running') return;
      e.stopPropagation();
      handleClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view]);

  // Watch the queue for completion to advance the view.
  useEffect(() => {
    if (view === 'running' && queue.queueState === 'done') {
      setView('done');
    }
  }, [view, queue.queueState]);

  // Persist the user's selection on a successful queue completion.
  useEffect(() => {
    if (queue.queueState !== 'done') return;
    if (persistedThisRunRef.current) return;
    if (!queue.jobs.some((j) => j.state === 'done')) return;
    persistedThisRunRef.current = true;
    onSelectionPersist?.(selectionRef.current);
  }, [queue.queueState, queue.jobs, onSelectionPersist]);

  // Prefill on open transition. Runs only on `false → true`.
  const prevOpenRef = useRef(open);
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (!open || wasOpen) return;
    onSelectionChange(lastExportSelection ?? EMPTY_GRID);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset modal state on close so the next open starts clean.
  useEffect(() => {
    if (open) return;
    setView('select');
    queue.reset();
    persistedThisRunRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const setOutputFolder = (folder: string | null) =>
    onSelectionChange({ ...selection, output_dir: folder });

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
    if (typeof result === 'string') {
      setOutputFolder(result);
    } else if (Array.isArray(result) && result.length > 0) {
      setOutputFolder(result[0]);
    }
  };

  const handleClose = () => {
    if (view === 'running') return;
    queue.reset();
    setView('select');
    onClose();
  };

  const handleBackdropClick = () => {
    if (view === 'running') return;
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
      transitionFeel,
      layouts: projectLayouts,
    };
    const buildRequest = (job: ExportJob): RenderExportRequest =>
      buildJobRequest(context, job);

    setView('running');
    queue.start(jobs, buildRequest);
  };

  const renderEnabled = jobCount > 0 && outputFolder !== null;
  const renderDisabled = !renderEnabled;

  // Suppress unused-warnings for fields the grid UI (commit 4) consumes.
  void nClips;
  void timelineDurationSec;

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
                <div style={styles.label}>Exports</div>
                <div style={styles.placeholder} data-testid="export-grid-placeholder">
                  The configure grid lands in a follow-up commit.
                </div>
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
  placeholder: {
    padding: '20px',
    border: '1px dashed #4c5b5c',
    borderRadius: '3px',
    color: '#8a9697',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: '11.5px',
    textAlign: 'center',
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
