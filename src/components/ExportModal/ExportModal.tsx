import { useEffect, useMemo, useState } from 'react';
import { open as openDialog, ask } from '@tauri-apps/plugin-dialog';
import { exists } from '@tauri-apps/plugin-fs';
import { AspectCheckboxes } from './AspectCheckboxes';
import { ChannelToggles } from './ChannelToggles';
import { ChannelSchematic } from './ChannelSchematic';
import { JobSummary } from './JobSummary';
import { QueueView } from './QueueView';
import { QueueSummary } from './QueueSummary';
import { deriveJobs, type ExportJob } from '../../lib/exportFilenames';
import {
  buildJobRequest,
  type ExportRequestContext,
  type RenderExportRequest,
} from '../../lib/exportRequest';
import { useExportQueue } from '../../hooks/useExportQueue';
import type {
  AspectRatio,
  Clip,
  ExportChannel,
  ExportSelection,
  MapSettings,
  ProjectLayouts,
  Route,
  TransitionFeel,
} from '../../types';

const DISABLED_RENDER_TOOLTIP =
  'Select aspects, channels, and folder to enable Render';

type View = 'select' | 'running' | 'done';

export interface ExportModalProps {
  open: boolean;
  onClose: () => void;
  selection: ExportSelection;
  onSelectionChange: (next: ExportSelection) => void;
  projectName: string;
  clips: Clip[];
  route: Route | null;
  mapSettings: MapSettings;
  transitionFeel?: TransitionFeel;
  projectLayouts: ProjectLayouts;
}

export function ExportModal({
  open,
  onClose,
  selection,
  onSelectionChange,
  projectName,
  clips,
  route,
  mapSettings,
  transitionFeel,
  projectLayouts,
}: ExportModalProps) {
  const [outputFolder, setOutputFolder] = useState<string | null>(null);
  const [view, setView] = useState<View>('select');
  const queue = useExportQueue();

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

  // Reset modal state on close so the next open starts clean.
  useEffect(() => {
    if (open) return;
    setView('select');
    queue.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const setAspects = (aspects: AspectRatio[]) =>
    onSelectionChange({ ...selection, aspects });
  const setChannels = (channels: ExportChannel[]) =>
    onSelectionChange({ ...selection, channels });

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

  const handleRender = async () => {
    if (!outputFolder || selection.aspects.length === 0 || selection.channels.length === 0) {
      return;
    }
    const jobs = deriveJobs(projectName, outputFolder, selection);

    const collisions: string[] = [];
    for (const job of jobs) {
      try {
        if (await exists(job.outputPath)) collisions.push(job.outputPath);
      } catch {
        // Treat probe failure as "doesn't exist" — the renderer will surface
        // a real write error if the path is genuinely unwritable.
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
      fps: 30,
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

  const previewAspect: AspectRatio = selection.aspects[0] ?? '9_16';
  const renderEnabled =
    selection.aspects.length > 0 &&
    selection.channels.length > 0 &&
    outputFolder !== null;
  const renderDisabled = !renderEnabled;

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
                <div style={styles.label}>Aspect ratios</div>
                <AspectCheckboxes value={selection.aspects} onChange={setAspects} />
              </section>

              <section style={styles.section}>
                <div style={styles.label}>Channels</div>
                <ChannelToggles value={selection.channels} onChange={setChannels} />
              </section>

              {selection.channels.length > 0 && (
                <section style={styles.section}>
                  <div style={styles.label}>Preview</div>
                  <div style={styles.schematics}>
                    {selection.channels.map((c) => (
                      <div key={c} style={styles.schematicCell}>
                        <ChannelSchematic channel={c} aspect={previewAspect} />
                        <div style={styles.schematicLabel}>
                          {formatChannelLabel(c)}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section style={styles.section}>
                <JobSummary
                  selection={selection}
                  projectName={projectName}
                  outputFolder={outputFolder}
                  nClips={nClips}
                  timelineDurationSec={timelineDurationSec}
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
              Render
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

function formatChannelLabel(c: ExportChannel): string {
  switch (c) {
    case 'composite':
      return 'Composite';
    case 'map_only':
      return 'Map only';
    case 'video_only':
      return 'Video only';
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
    width: 'min(560px, 92vw)',
    maxHeight: '90vh',
    backgroundColor: '#1a1a1a',
    border: '1px solid #333',
    borderRadius: '8px',
    color: '#ddd',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.6)',
  },
  header: {
    padding: '12px 18px',
    borderBottom: '1px solid #333',
  },
  title: {
    margin: 0,
    fontSize: '15px',
    fontWeight: 600,
    color: '#eee',
  },
  body: {
    padding: '14px 18px',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  label: {
    fontSize: '11px',
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: '0.6px',
  },
  schematics: {
    display: 'flex',
    gap: '14px',
    flexWrap: 'wrap',
  },
  schematicCell: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '4px',
  },
  schematicLabel: {
    fontSize: '11px',
    color: '#888',
  },
  folderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '8px 10px',
    backgroundColor: '#222',
    border: '1px solid #333',
    borderRadius: '4px',
  },
  folderPlaceholder: {
    fontSize: '12px',
    color: '#777',
    fontStyle: 'italic',
  },
  folderPath: {
    fontSize: '12px',
    color: '#bbb',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    direction: 'rtl',
    textAlign: 'left',
  },
  footer: {
    padding: '12px 18px',
    borderTop: '1px solid #333',
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    backgroundColor: '#161616',
  },
  primary: {
    padding: '6px 14px',
    backgroundColor: '#ff6b35',
    color: '#1a1a1a',
    border: '1px solid #ff6b35',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 600,
  },
  primaryDisabled: {
    padding: '6px 14px',
    backgroundColor: '#3a3a3a',
    color: '#777',
    border: '1px solid #3a3a3a',
    borderRadius: '4px',
    cursor: 'not-allowed',
    fontSize: '13px',
    fontWeight: 600,
  },
  secondaryButton: {
    padding: '6px 14px',
    backgroundColor: '#2a2a2a',
    color: '#ccc',
    border: '1px solid #444',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '13px',
  },
};
