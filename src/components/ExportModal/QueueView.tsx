import type { QueueJob, QueueState } from '../../hooks/useExportQueue';

export interface QueueViewProps {
  jobs: QueueJob[];
  queueState: QueueState;
  onCancel: () => void;
}

export function QueueView({ jobs, queueState, onCancel }: QueueViewProps) {
  const doneCount = jobs.filter((j) => j.state === 'done').length;
  const showCancel = queueState === 'running' || queueState === 'cancelling';
  const cancelDisabled = queueState !== 'running';

  return (
    <div data-testid="export-queue-view">
      <div style={styles.progress} data-testid="export-queue-progress">
        {doneCount} of {jobs.length} done
      </div>
      <ul style={styles.list}>
        {jobs.map((job) => (
          <li
            key={job.id}
            style={styles.row}
            data-testid={`export-queue-row-${job.id}`}
          >
            <span style={styles.filename}>{filenameOf(job.outputPath)}</span>
            <span
              style={badgeStyle(job.state)}
              data-testid={`export-queue-badge-${job.id}`}
            >
              {job.state === 'running' ? (
                <Spinner />
              ) : (
                <span>{badgeLabel(job.state)}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {showCancel && (
        <div style={styles.actions}>
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelDisabled}
            style={cancelDisabled ? styles.secondaryDisabled : styles.secondary}
            data-testid="export-queue-cancel"
          >
            {queueState === 'cancelling' ? 'Cancelling…' : 'Cancel'}
          </button>
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <span style={styles.spinner} data-testid="export-queue-spinner" aria-label="running">
      ⟳
    </span>
  );
}

function badgeLabel(state: QueueJob['state']): string {
  switch (state) {
    case 'pending':
      return 'pending';
    case 'running':
      return 'running';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
  }
}

function badgeStyle(state: QueueJob['state']): React.CSSProperties {
  const base: React.CSSProperties = { ...styles.badgeBase };
  switch (state) {
    case 'pending':
      return { ...base, backgroundColor: '#2a2a2a', color: '#888' };
    case 'running':
      return { ...base, backgroundColor: '#2a3a4a', color: '#9bd' };
    case 'done':
      return { ...base, backgroundColor: '#1f3a25', color: '#8bc49a' };
    case 'failed':
      return { ...base, backgroundColor: '#3a1a1a', color: '#ff8888' };
  }
}

function filenameOf(outputPath: string): string {
  const idx = outputPath.lastIndexOf('/');
  return idx >= 0 ? outputPath.slice(idx + 1) : outputPath;
}

const styles: Record<string, React.CSSProperties> = {
  progress: {
    fontSize: '13px',
    color: '#bbb',
    marginBottom: '8px',
  },
  list: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '6px 8px',
    backgroundColor: '#1f1f1f',
    border: '1px solid #2a2a2a',
    borderRadius: '4px',
    fontSize: '12px',
  },
  filename: {
    fontFamily: '"SF Mono", Menlo, monospace',
    color: '#ccc',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
    marginRight: '8px',
  },
  badgeBase: {
    padding: '2px 8px',
    borderRadius: '10px',
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.6px',
    minWidth: '60px',
    textAlign: 'center',
  },
  spinner: {
    display: 'inline-block',
    fontSize: '12px',
    animation: 'tcSpin 1s linear infinite',
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    marginTop: '12px',
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
