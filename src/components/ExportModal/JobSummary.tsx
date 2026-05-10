import type { AspectRatio, ExportChannel, ExportSelection } from '../../types';

export interface JobSummaryProps {
  selection: ExportSelection;
}

export function JobSummary({ selection }: JobSummaryProps) {
  const { aspects, channels } = selection;
  const nJobs = aspects.length * channels.length;

  if (nJobs === 0) {
    return (
      <div style={styles.summary} data-testid="export-job-summary">
        0 files — select at least one aspect and one channel.
      </div>
    );
  }

  const breakdown = describeJobs(aspects, channels);
  const noun = nJobs === 1 ? 'file' : 'files';
  return (
    <div style={styles.summary} data-testid="export-job-summary">
      {nJobs} {noun}: {breakdown}.
    </div>
  );
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
};
