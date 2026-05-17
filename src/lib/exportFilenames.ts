import type {
  AspectRatio,
  ExportChannel,
  ExportConfig,
  ExportFps,
  ExportGrid,
  CellKey,
  OutputResolution,
} from '../types';

export interface ExportJob {
  id: string;
  aspect: AspectRatio;
  channel: ExportChannel;
  quality: OutputResolution;
  fps: ExportFps;
  outputPath: string;
}

const FALLBACK_SLUG = 'trailcut-export';

const EXTENSIONS: Record<ExportChannel, 'mp4' | 'mov'> = {
  composite: 'mp4',
  map_only: 'mov',
  video_only: 'mov',
};

/** Stable iteration order: cells are walked top-to-bottom in the grid header
 *  shown to the user (16:9, 4:5, 9:16) and left-to-right by channel
 *  (composite, map_only, video_only). The queue ordering layer below sorts
 *  by quality tier after this walk, so within a tier the visual reading
 *  order is preserved. */
export const ASPECT_ORDER: readonly AspectRatio[] = ['16_9', '4_5', '9_16'];
export const CHANNEL_ORDER: readonly ExportChannel[] = [
  'composite',
  'map_only',
  'video_only',
];

/** Quality tier rank for the two-pass queue order: fastest jobs first so the
 *  user sees feedback early. Within a tier, cell-walk order is preserved
 *  (Array.prototype.sort is stable). */
const QUALITY_RANK: Record<OutputResolution, number> = {
  '720p': 0,
  '1080p': 1,
  '1440p': 2,
  '2160p': 3,
};

/** Filename quality token. Matches the mockup: `1080`, `4k`. The intermediate
 *  tiers use their bare-number form. */
function qualityToken(quality: OutputResolution): string {
  switch (quality) {
    case '720p':
      return '720';
    case '1080p':
      return '1080';
    case '1440p':
      return '1440';
    case '2160p':
      return '4k';
  }
}

/** Filename aspect token. The on-disk `AspectRatio` is `9_16`/`4_5`/`16_9`;
 *  filenames render it as `9x16`/`4x5`/`16x9` to match the mockup and avoid
 *  underscore aliasing in tools that special-case `_` in tokens. */
function aspectToken(aspect: AspectRatio): string {
  return aspect.replace('_', 'x');
}

/** Filename channel token. `map_only` → `map-only`, `video_only` →
 *  `video-only`, `composite` → `composite`. Matches the mockup. */
function channelToken(channel: ExportChannel): string {
  switch (channel) {
    case 'composite':
      return 'composite';
    case 'map_only':
      return 'map-only';
    case 'video_only':
      return 'video-only';
  }
}

/** Slugify a project name for use in an output filename. Lowercases, drops
 *  any character outside `[a-z0-9]` (including emoji and punctuation), and
 *  collapses runs of dashes. Empty results fall back to `trailcut-export`. */
export function slugifyProjectName(projectName: string): string {
  const lowered = projectName.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9]+/g, '-');
  const trimmed = replaced.replace(/^-+|-+$/g, '');
  return trimmed.length > 0 ? trimmed : FALLBACK_SLUG;
}

/** Derive the deterministic output filename for one (project, aspect,
 *  channel, quality, fps) tuple. Schema:
 *  `{slug}__{aspect}__{quality}__{channel}.{ext}` — double-underscore
 *  separators, no fps in the filename (fps differences within a cell are
 *  rare and the chip UI prevents collisions via the duplicate-disable rule;
 *  if a future axis re-enables collisions, the schema can append `__{fps}`
 *  without disturbing the existing tokens). */
export function deriveFilename(
  projectName: string,
  aspect: AspectRatio,
  channel: ExportChannel,
  quality: OutputResolution,
): string {
  return `${slugifyProjectName(projectName)}__${aspectToken(aspect)}__${qualityToken(quality)}__${channelToken(channel)}.${EXTENSIONS[channel]}`;
}

/** Walk the grid in (aspect-row, channel-column) order, emit one job per
 *  configured chip, then sort by quality tier so faster jobs run first.
 *  Stable sort preserves the cell-walk order within a tier. */
export function deriveJobs(
  projectName: string,
  outputDir: string,
  grid: ExportGrid,
): ExportJob[] {
  const jobs: ExportJob[] = [];
  const sep = outputDir.endsWith('/') ? '' : '/';
  for (const aspect of ASPECT_ORDER) {
    for (const channel of CHANNEL_ORDER) {
      const key: CellKey = `${aspect}-${channel}`;
      const configs = grid.cells[key];
      if (!configs) continue;
      for (const config of configs) {
        const filename = deriveFilename(projectName, aspect, channel, config.quality);
        jobs.push({
          id: `${aspect}-${channel}-${config.quality}-${config.fps}-${config.id}`,
          aspect,
          channel,
          quality: config.quality,
          fps: config.fps,
          outputPath: `${outputDir}${sep}${filename}`,
        });
      }
    }
  }
  jobs.sort((a, b) => QUALITY_RANK[a.quality] - QUALITY_RANK[b.quality]);
  return jobs;
}

/** Total number of configured exports across all cells. Used by the
 *  modal footer summary and the render-button enablement check. */
export function gridJobCount(grid: ExportGrid): number {
  let n = 0;
  for (const configs of Object.values(grid.cells)) {
    if (configs) n += configs.length;
  }
  return n;
}

/** Helper for the chip-add UX: the `(quality, fps)` combos already present
 *  in the given cell. The secondary modal uses this to disable already-used
 *  buttons in add mode. */
export function configsInCell(
  grid: ExportGrid,
  aspect: AspectRatio,
  channel: ExportChannel,
): ExportConfig[] {
  const key: CellKey = `${aspect}-${channel}`;
  return grid.cells[key] ?? [];
}
