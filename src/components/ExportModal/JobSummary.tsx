import { deriveJobs, type ExportJob } from '../../lib/exportFilenames';
import type { AspectRatio, ExportChannel, ExportSelection } from '../../types';

const FILENAME_PREVIEW_LIMIT = 3;

export interface JobSummaryProps {
  selection: ExportSelection;
  projectName: string;
  outputFolder: string | null;
}

export function JobSummary({
  selection,
  projectName,
  outputFolder,
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

  if (outputFolder) {
    const jobs = deriveJobs(projectName, outputFolder, selection);
    return (
      <div style={styles.summary} data-testid="export-job-summary">
        <div>
          {nJobs} {noun}:
        </div>
        <ul style={styles.list} data-testid="export-job-summary-files">
          {previewFilenames(jobs).map((line) => (
            <li key={line} style={styles.listItem}>
              {line}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const breakdown = describeJobs(aspects, channels);
  return (
    <div style={styles.summary} data-testid="export-job-summary">
      {nJobs} {noun}: {breakdown}.
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
};
