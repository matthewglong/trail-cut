import type { QueueJob, QueueState, JobState } from '../../hooks/useExportQueue';
import { DELIVERY_TARGETS, type DeliveryTarget, type ExportChannel } from '../../types';
import styles from './ExportModal.module.css';

/** Short label for a delivery target — uses the WS5 catalog's `shortLabel`
 *  so the queue UI stays in lockstep with the picker without a private
 *  string table. Pre-WS5 jobs lack the field; we fall back to "—" rather
 *  than fabricate a label. */
function targetShortLabel(target: DeliveryTarget | undefined): string {
  if (!target) return '—';
  return DELIVERY_TARGETS.find((t) => t.id === target)?.shortLabel ?? target;
}

export interface QueueViewProps {
  jobs: QueueJob[];
  queueState: QueueState;
  onCancel: () => void;
}

const CHANNEL_TAG: Record<ExportChannel, { letter: string; cls: string }> = {
  composite: { letter: 'C', cls: styles.chTagC },
  map_only: { letter: 'M', cls: styles.chTagM },
  video_only: { letter: 'V', cls: styles.chTagV },
};
const ASPECT_LABEL: Record<QueueJob['aspect'], string> = {
  '9_16': '9:16',
  '4_5': '4:5',
  '16_9': '16:9',
};
const CHANNEL_LABEL: Record<ExportChannel, string> = {
  composite: 'composite',
  map_only: 'map only',
  video_only: 'video only',
};
const QUALITY_LABEL: Record<QueueJob['quality'], string> = {
  '720p': '720',
  '1080p': '1080',
  '1440p': '1440',
  '2160p': '4K',
};

export function QueueView({ jobs, queueState, onCancel }: QueueViewProps) {
  const doneCount = jobs.filter((j) => j.state === 'done').length;
  const runningJob = jobs.find((j) => j.state === 'running');
  const runningIdx = runningJob ? jobs.indexOf(runningJob) : -1;
  const showCancel = queueState === 'running' || queueState === 'cancelling';
  const cancelDisabled = queueState !== 'running';

  return (
    <div
      className={styles.scope}
      data-testid="export-queue-view"
      style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}
    >
      <div
        className={styles.renderSummary}
        data-testid="export-queue-banner"
      >
        <span className={styles.pulse} aria-hidden />
        <div>
          <div className={styles.renderSummaryLabel}>
            {queueState === 'cancelling' ? 'Cancelling' : 'Rendering'}
          </div>
          <div className={styles.renderSummaryMain}>
            {runningJob ? (
              <>
                Job <strong>{runningIdx + 1} of {jobs.length}</strong>
                {' · '}
                {ASPECT_LABEL[runningJob.aspect]} {CHANNEL_LABEL[runningJob.channel]}
                {' · '}
                <span style={{ color: 'var(--accent)' }}>
                  {QUALITY_LABEL[runningJob.quality]}
                </span>
                {runningJob.deliveryTarget && (
                  <>
                    {' · '}
                    <span data-testid="export-queue-banner-target">
                      {targetShortLabel(runningJob.deliveryTarget)}
                    </span>
                  </>
                )}
              </>
            ) : (
              <>Queued — preparing…</>
            )}
          </div>
        </div>
        <div className={styles.renderSummaryMeta}>
          <span data-testid="export-queue-progress">
            {doneCount} of {jobs.length} done
          </span>
        </div>
      </div>

      <ul className={styles.jobList}>
        {jobs.map((job) => (
          <JobRow key={job.id} job={job} />
        ))}
      </ul>

      {showCancel && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnDanger}`}
            onClick={onCancel}
            disabled={cancelDisabled}
            data-testid="export-queue-cancel"
          >
            {queueState === 'cancelling' ? 'Cancelling…' : 'Cancel render'}
          </button>
        </div>
      )}
    </div>
  );
}

function JobRow({ job }: { job: QueueJob }) {
  const tag = CHANNEL_TAG[job.channel];
  const filename = filenameOf(job.outputPath);
  const { base, ext } = splitExt(filename);
  const rowClass = `${styles.job} ${stateClass(job.state)}`;
  return (
    <li
      className={rowClass}
      data-testid={`export-queue-row-${job.id}`}
    >
      <span className={styles.jobStatus}>
        <StatusIcon state={job.state} />
      </span>
      <span className={styles.jobName}>
        <span className={`${styles.chTag} ${tag.cls}`}>{tag.letter}</span>
        {base}
        <span className={styles.ext}>{ext}</span>
      </span>
      <div className={styles.barCell}>
        <div className={styles.bar}>
          <div
            className={styles.barFill}
            style={{ width: `${barPercent(job)}%` }}
          />
        </div>
        <span
          className={styles.pct}
          data-testid={`export-queue-badge-${job.id}`}
        >
          {badgeLabel(job)}
        </span>
      </div>
      <span className={styles.jobMeta}>{metaLabel(job)}</span>
    </li>
  );
}

function barPercent(job: QueueJob): number {
  if (job.state === 'done') return 100;
  if (job.state !== 'running') return 0;
  const { framesDone, totalFrames } = job;
  if (
    typeof framesDone !== 'number' ||
    typeof totalFrames !== 'number' ||
    totalFrames <= 0
  ) {
    return 0;
  }
  const pct = (framesDone / totalFrames) * 100;
  return Math.max(0, Math.min(100, pct));
}

function StatusIcon({ state }: { state: JobState }) {
  if (state === 'running') {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        className={styles.spin}
        data-testid="export-queue-spinner"
        aria-label="running"
      >
        <circle cx="8" cy="8" r="5.5" strokeOpacity="0.25" />
        <path d="M13.5 8a5.5 5.5 0 0 0-5.5-5.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (state === 'done') {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.6" aria-hidden>
        <path d="M3 8l3.5 3.5L13 5" />
      </svg>
    );
  }
  if (state === 'failed') {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    );
  }
  // pending
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <circle cx="8" cy="8" r="5" />
    </svg>
  );
}

function stateClass(state: JobState): string {
  switch (state) {
    case 'running':
      return styles.jobRunning;
    case 'done':
      return styles.jobDone;
    case 'failed':
      return styles.jobFailed;
    case 'pending':
      return styles.jobPending;
  }
}

function badgeLabel(job: QueueJob): string {
  switch (job.state) {
    case 'pending':
      return 'pending';
    case 'running': {
      const pct = barPercent(job);
      return pct > 0 ? `${Math.round(pct)}%` : 'running';
    }
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
  }
}

function metaLabel(job: QueueJob): string {
  if (job.state === 'done' && job.summary) {
    return formatSeconds(job.summary.wall_clock_ms / 1000);
  }
  if (job.state === 'failed') return 'failed';
  if (job.state === 'running') return '—';
  return 'queued';
}

function formatSeconds(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return '—';
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

function splitExt(filename: string): { base: string; ext: string } {
  const idx = filename.lastIndexOf('.');
  if (idx <= 0) return { base: filename, ext: '' };
  return { base: filename.slice(0, idx), ext: filename.slice(idx) };
}

function filenameOf(outputPath: string): string {
  const idx = outputPath.lastIndexOf('/');
  return idx >= 0 ? outputPath.slice(idx + 1) : outputPath;
}
