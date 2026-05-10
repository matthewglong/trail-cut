import type { AspectRatio, ExportChannel, ExportSelection } from '../types';

export interface ExportJob {
  id: string;
  aspect: AspectRatio;
  channel: ExportChannel;
  outputPath: string;
}

const FALLBACK_SLUG = 'trailcut-export';

const EXTENSIONS: Record<ExportChannel, 'mp4' | 'mov'> = {
  composite: 'mp4',
  map_only: 'mov',
  video_only: 'mov',
};

/** Slugify a project name for use in an output filename. Lowercases, drops
 *  any character outside `[a-z0-9]` (including emoji and punctuation), and
 *  collapses runs of dashes. Empty results fall back to `trailcut-export`. */
export function slugifyProjectName(projectName: string): string {
  const lowered = projectName.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9]+/g, '-');
  const trimmed = replaced.replace(/^-+|-+$/g, '');
  return trimmed.length > 0 ? trimmed : FALLBACK_SLUG;
}

/** Derive the deterministic output filename for one (project, aspect, channel)
 *  triple. See `docs/export/plans/layout-ui.md` §5. The aspect token uses the
 *  underscore form (`9_16`) to keep filenames filesystem-friendly. */
export function deriveFilename(
  projectName: string,
  aspect: AspectRatio,
  channel: ExportChannel,
): string {
  return `${slugifyProjectName(projectName)}-${aspect}-${channel}.${EXTENSIONS[channel]}`;
}

/** Cartesian product of selected aspects × channels, materialized as
 *  `ExportJob` records with absolute output paths. Outer loop walks aspects
 *  in selection order; inner loop walks channels in selection order. The
 *  resulting list is the queue 270 dispatches one entry at a time. */
export function deriveJobs(
  projectName: string,
  outputDir: string,
  selection: ExportSelection,
): ExportJob[] {
  const jobs: ExportJob[] = [];
  const sep = outputDir.endsWith('/') ? '' : '/';
  for (const aspect of selection.aspects) {
    for (const channel of selection.channels) {
      const filename = deriveFilename(projectName, aspect, channel);
      jobs.push({
        id: `${aspect}-${channel}`,
        aspect,
        channel,
        outputPath: `${outputDir}${sep}${filename}`,
      });
    }
  }
  return jobs;
}
