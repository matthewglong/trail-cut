import { revealItemInDir } from '@tauri-apps/plugin-opener';
import type { QueueJob } from '../../hooks/useExportQueue';
import type { ExportChannel } from '../../types';
import styles from './ExportModal.module.css';

export interface QueueSummaryProps {
  jobs: QueueJob[];
  outputDir: string | null;
  onClose: () => void;
}

const CHANNEL_TAG: Record<ExportChannel, { letter: string; cls: string }> = {
  composite: { letter: 'C', cls: styles.chTagC },
  map_only: { letter: 'M', cls: styles.chTagM },
  video_only: { letter: 'V', cls: styles.chTagV },
};

export function QueueSummary({ jobs, outputDir, onClose }: QueueSummaryProps) {
  const done = jobs.filter((j) => j.state === 'done');
  const failed = jobs.filter((j) => j.state === 'failed');
  const cancelled = jobs.filter((j) => j.state === 'pending');
  const totalMs = done.reduce(
    (acc, j) => acc + (j.summary?.wall_clock_ms ?? 0),
    0,
  );

  const handleReveal = async () => {
    const target = done[0]?.outputPath ?? outputDir;
    if (!target) return;
    try {
      await revealItemInDir(target);
    } catch {
      // best-effort — Finder reveal failure isn't worth surfacing.
    }
  };

  const revealDisabled = done.length === 0 && !outputDir;

  return (
    <div
      className={styles.scope}
      data-testid="export-queue-summary"
      style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}
    >
      <div className={styles.doneSummary}>
        <span className={styles.doneCheck} aria-hidden>
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
          >
            <path d="M3 8l3.5 3.5L13 5" />
          </svg>
        </span>
        <div>
          <div className={styles.doneTitle} data-testid="export-queue-summary-heading">
            {cancelled.length > 0 && done.length === 0
              ? 'Export cancelled'
              : `${done.length} ${done.length === 1 ? 'file' : 'files'} exported`}
            {failed.length > 0 && ` · ${failed.length} failed`}
            {cancelled.length > 0 && done.length > 0 && ` · ${cancelled.length} skipped`}
          </div>
          {outputDir && (
            <div className={styles.doneSub}>
              to <strong>{outputDir}</strong>
              {totalMs > 0 && (
                <>
                  {' · '}
                  {formatTotalSeconds(totalMs / 1000)} total
                </>
              )}
            </div>
          )}
        </div>
        <div className={styles.doneSummaryRight}>
          <button
            type="button"
            className={styles.btn}
            onClick={handleReveal}
            disabled={revealDisabled}
            data-testid="export-queue-reveal"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              width="13"
              height="13"
              aria-hidden
            >
              <path d="M3 6h4l1.5-2H13v8H3z" />
            </svg>
            Reveal folder
          </button>
        </div>
      </div>

      {(done.length > 0 || failed.length > 0) && (
        <ul className={styles.jobList} data-testid="export-queue-summary-done">
          {done.map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
          {failed.length > 0 && (
            <div data-testid="export-queue-summary-failed">
              {failed.map((j) => (
                <JobRow key={j.id} job={j} />
              ))}
            </div>
          )}
        </ul>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={onClose}
          data-testid="export-queue-done"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function JobRow({ job }: { job: QueueJob }) {
  const tag = CHANNEL_TAG[job.channel];
  const filename = filenameOf(job.outputPath);
  const { base, ext } = splitExt(filename);
  const isDone = job.state === 'done';
  const isFailed = job.state === 'failed';
  return (
    <li
      className={`${styles.job} ${isDone ? styles.jobDone : isFailed ? styles.jobFailed : ''}`}
      data-testid={`export-queue-row-${job.id}`}
    >
      <span className={styles.jobStatus}>
        {isDone ? (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.6" aria-hidden>
            <path d="M3 8l3.5 3.5L13 5" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        )}
      </span>
      <span className={styles.jobName}>
        <span className={`${styles.chTag} ${tag.cls}`}>{tag.letter}</span>
        {base}
        <span className={styles.ext}>{ext}</span>
        {isFailed && job.error && (
          <div className={styles.errorMessage}>{job.error}</div>
        )}
      </span>
      <div className={styles.barCell}>
        <div className={styles.bar}>
          <div className={styles.barFill} style={{ width: isDone ? '100%' : '0%' }} />
        </div>
        <span className={styles.pct}>
          {isDone && job.summary ? formatSeconds(job.summary.wall_clock_ms / 1000) : isFailed ? 'failed' : '—'}
        </span>
      </div>
      <span className={styles.jobMeta}>{isFailed ? 'failed' : 'done'}</span>
    </li>
  );
}

function formatSeconds(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return '—';
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

function formatTotalSeconds(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return '0s';
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
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
