import { deriveJobs, type ExportJob } from '../../lib/exportFilenames';
import { estimateQueue } from '../../lib/exportEstimate';
import type { AspectRatio, ExportChannel, ExportSelection } from '../../types';

const FILENAME_PREVIEW_LIMIT = 3;

export interface JobSummaryProps {
  selection: ExportSelection;
  projectName: string;
  outputFolder: string | null;
  nClips: number;
  timelineDurationSec: number;
}

export function JobSummary({
  selection,
  projectName,
  outputFolder,
  nClips,
  timelineDurationSec,
}: JobSummaryProps) {
  const { aspects, channels } = selection;
  const nJobs = aspects.length * channels.length;

  if (nJobs === 0) {
    return (
      <div style={styles.summary} data-testid="export-job-summary">
        0 files — select at least one aspect and one channel.
      </div>
    );
  }

  const noun = nJobs === 1 ? 'file' : 'files';
  const previewJobs = outputFolder
    ? deriveJobs(projectName, outputFolder, selection)
    : null;
  const showEstimate = nClips > 0 || timelineDurationSec > 0;
  const estimateLine = showEstimate ? (
    <div style={styles.estimate} data-testid="export-job-summary-estimate">
      Estimated time:{' '}
      {formatEstimate(
        estimateQueue(
          previewJobs ?? buildPlaceholderJobs(aspects, channels),
          nClips,
          timelineDurationSec,
        ),
      )}
    </div>
  ) : null;

  if (previewJobs) {
    return (
      <div style={styles.summary} data-testid="export-job-summary">
        <div>
          {nJobs} {noun}:
        </div>
        <ul style={styles.list} data-testid="export-job-summary-files">
          {previewFilenames(previewJobs).map((line) => (
            <li key={line} style={styles.listItem}>
              {line}
            </li>
          ))}
        </ul>
        {estimateLine}
      </div>
    );
  }

  const breakdown = describeJobs(aspects, channels);
  return (
    <div style={styles.summary} data-testid="export-job-summary">
      <div>
        {nJobs} {noun}: {breakdown}.
      </div>
      {estimateLine}
    </div>
  );
}

function previewFilenames(jobs: ExportJob[]): string[] {
  if (jobs.length <= FILENAME_PREVIEW_LIMIT + 1) {
    return jobs.map((j) => filenameOf(j.outputPath));
  }
  const head = jobs.slice(0, FILENAME_PREVIEW_LIMIT).map((j) => filenameOf(j.outputPath));
  const remaining = jobs.length - FILENAME_PREVIEW_LIMIT;
  return [...head, `and ${remaining} more`];
}

function filenameOf(outputPath: string): string {
  const idx = outputPath.lastIndexOf('/');
  return idx >= 0 ? outputPath.slice(idx + 1) : outputPath;
}

function describeJobs(
  aspects: AspectRatio[],
  channels: ExportChannel[],
): string {
  const parts: string[] = [];
  for (const aspect of aspects) {
    for (const channel of channels) {
      parts.push(`${formatAspect(aspect)} ${formatChannel(channel)}`);
    }
  }
  return parts.join(', ');
}

function formatAspect(a: AspectRatio): string {
  return a.replace('_', ':');
}

function formatChannel(c: ExportChannel): string {
  switch (c) {
    case 'composite':
      return 'composite';
    case 'map_only':
      return 'map';
    case 'video_only':
      return 'video';
  }
}

/** Estimate consumes only the `channel` of each job, so when no folder is set
 *  the cartesian product is enough — paths can be empty placeholders. */
function buildPlaceholderJobs(
  aspects: AspectRatio[],
  channels: ExportChannel[],
): ExportJob[] {
  const jobs: ExportJob[] = [];
  for (const aspect of aspects) {
    for (const channel of channels) {
      jobs.push({ id: `${aspect}-${channel}`, aspect, channel, outputPath: '' });
    }
  }
  return jobs;
}

function formatEstimate(totalSec: number): string {
  if (totalSec < 60) return '<1 min';
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return `~${totalMin} min`;
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin - hours * 60;
  return `~${hours}h ${minutes}m`;
}

const styles: Record<string, React.CSSProperties> = {
  summary: {
    fontSize: '13px',
    color: '#bbb',
    lineHeight: 1.5,
  },
  list: {
    margin: '6px 0 0 0',
    paddingLeft: '18px',
    color: '#aaa',
  },
  listItem: {
    fontFamily: '"SF Mono", Menlo, monospace',
    fontSize: '12px',
  },
  estimate: {
    marginTop: '6px',
    fontSize: '12px',
    color: '#999',
  },
};
