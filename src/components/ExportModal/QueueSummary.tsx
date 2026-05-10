import { revealItemInDir } from '@tauri-apps/plugin-opener';
import type { QueueJob } from '../../hooks/useExportQueue';

export interface QueueSummaryProps {
  jobs: QueueJob[];
  outputDir: string | null;
  onClose: () => void;
}

export function QueueSummary({ jobs, outputDir, onClose }: QueueSummaryProps) {
  const done = jobs.filter((j) => j.state === 'done');
  const failed = jobs.filter((j) => j.state === 'failed');
  const cancelled = jobs.filter((j) => j.state === 'pending');

  const handleReveal = async () => {
    const target = done[0]?.outputPath ?? outputDir;
    if (!target) return;
    try {
      await revealItemInDir(target);
    } catch {
      // best-effort — Finder reveal failure isn't worth surfacing.
    }
  };

  return (
    <div data-testid="export-queue-summary">
      <div style={styles.heading} data-testid="export-queue-summary-heading">
        {done.length} {done.length === 1 ? 'file' : 'files'} written
        {failed.length > 0 && (
          <span style={styles.headingFail}>
            {' '}
            • {failed.length} failed
          </span>
        )}
        {cancelled.length > 0 && (
          <span style={styles.headingCancelled}>
            {' '}
            • {cancelled.length} skipped
          </span>
        )}
      </div>

      {done.length > 0 && (
        <ul style={styles.list} data-testid="export-queue-summary-done">
          {done.map((j) => (
            <li key={j.id} style={styles.fileRow}>
              {filenameOf(j.outputPath)}
            </li>
          ))}
        </ul>
      )}

      {failed.length > 0 && (
        <ul style={styles.errorList} data-testid="export-queue-summary-failed">
          {failed.map((j) => (
            <li key={j.id} style={styles.errorRow}>
              <span style={styles.errorFilename}>{filenameOf(j.outputPath)}</span>
              <span style={styles.errorMessage}>{j.error ?? 'unknown error'}</span>
            </li>
          ))}
        </ul>
      )}

      <div style={styles.actions}>
        <button
          type="button"
          onClick={handleReveal}
          disabled={done.length === 0 && !outputDir}
          style={
            done.length === 0 && !outputDir
              ? styles.secondaryDisabled
              : styles.secondary
          }
          data-testid="export-queue-reveal"
        >
          Reveal in Finder
        </button>
        <button
          type="button"
          onClick={onClose}
          style={styles.primary}
          data-testid="export-queue-done"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function filenameOf(outputPath: string): string {
  const idx = outputPath.lastIndexOf('/');
  return idx >= 0 ? outputPath.slice(idx + 1) : outputPath;
}

const styles: Record<string, React.CSSProperties> = {
  heading: {
    fontSize: '14px',
    color: '#ddd',
    marginBottom: '10px',
  },
  headingFail: {
    color: '#ff8888',
  },
  headingCancelled: {
    color: '#999',
  },
  list: {
    margin: '0 0 10px 0',
    padding: '0 0 0 18px',
    fontFamily: '"SF Mono", Menlo, monospace',
    fontSize: '12px',
    color: '#aaa',
  },
  fileRow: {
    marginBottom: '2px',
  },
  errorList: {
    margin: '0 0 10px 0',
    padding: 0,
    listStyle: 'none',
  },
  errorRow: {
    display: 'flex',
    flexDirection: 'column',
    padding: '6px 8px',
    backgroundColor: '#2a1a1a',
    border: '1px solid #4a2222',
    borderRadius: '4px',
    fontSize: '12px',
    marginBottom: '4px',
  },
  errorFilename: {
    color: '#ff8888',
    fontFamily: '"SF Mono", Menlo, monospace',
  },
  errorMessage: {
    color: '#ffb0b0',
    fontSize: '11px',
    marginTop: '2px',
  },
  actions: {
    display: 'flex',
    gap: '8px',
    justifyContent: 'flex-end',
    marginTop: '10px',
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
  secondary: {
    padding: '6px 14px',
    backgroundColor: '#2a2a2a',
    color: '#ccc',
    border: '1px solid #444',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '13px',
  },
  secondaryDisabled: {
    padding: '6px 14px',
    backgroundColor: '#222',
    color: '#666',
    border: '1px solid #2a2a2a',
    borderRadius: '4px',
    cursor: 'not-allowed',
    fontSize: '13px',
  },
};
