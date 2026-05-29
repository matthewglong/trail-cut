import {
  DELIVERY_TARGETS,
  resolveDeliveryTarget,
  type AspectRatio,
  type DeliveryTarget,
  type DeliveryTargetInfo,
  type ExportChannel,
  type ExportConfig,
  type ExportFps,
  type ExportGrid,
  type CellKey,
  type OutputResolution,
} from '../types';

export interface ExportJob {
  id: string;
  aspect: AspectRatio;
  channel: ExportChannel;
  quality: OutputResolution;
  fps: ExportFps;
  /** WS5 — resolved delivery target for this job. Drives both the filename
   *  (target token + container extension) and the wire-level
   *  `delivery_target`. Resolution happens at `deriveJobs` time via
   *  `resolveDeliveryTarget(config, channel)`, so consumers never see an
   *  unresolved value here. */
  deliveryTarget: DeliveryTarget;
  outputPath: string;
}

const FALLBACK_SLUG = 'trailcut-export';

/** Lookup table keyed by `DeliveryTarget` id so filename derivation can read
 *  the target's container extension and short label without re-scanning
 *  `DELIVERY_TARGETS` per call. */
const TARGET_INFO: Record<DeliveryTarget, DeliveryTargetInfo> =
  DELIVERY_TARGETS.reduce(
    (acc, info) => {
      acc[info.id] = info;
      return acc;
    },
    {} as Record<DeliveryTarget, DeliveryTargetInfo>,
  );

/** Filename-safe slug for each delivery target. Stable short tokens that
 *  identify the file's color regime + codec at a glance. */
const TARGET_TOKEN: Record<DeliveryTarget, string> = {
  sdr_h265: 'sdr-h265',
  sdr_h264: 'sdr-h264',
  hdr_hlg: 'hdr-hlg',
  prores: 'prores',
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
 *  channel, quality, delivery target) tuple. Schema:
 *  `{slug}__{aspect}__{quality}__{channel}__{target}.{ext}` —
 *  double-underscore separators. fps is intentionally absent (the chip UI's
 *  duplicate-disable rule prevents same-cell fps collisions; the trailing
 *  `delivery_target` is the WS5 axis that distinguishes a TikTok export from
 *  a YouTube HDR export of the same (aspect, quality, channel) cell).
 *
 *  Container extension comes from the **target**, not the channel — TikTok
 *  / IG / YouTube targets emit `.mp4`, ProRes master emits `.mov`. This
 *  diverges from the pre-WS5 channel-keyed extension (composite was always
 *  `.mp4`; B/C were always `.mov`); WS4's `DeliveryTarget::container_extension`
 *  is the authoritative source. */
export function deriveFilename(
  projectName: string,
  aspect: AspectRatio,
  channel: ExportChannel,
  quality: OutputResolution,
  deliveryTarget: DeliveryTarget,
): string {
  const ext = TARGET_INFO[deliveryTarget].containerExtension;
  return `${slugifyProjectName(projectName)}__${aspectToken(aspect)}__${qualityToken(quality)}__${channelToken(channel)}__${TARGET_TOKEN[deliveryTarget]}.${ext}`;
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
        const deliveryTarget = resolveDeliveryTarget(config, channel);
        const filename = deriveFilename(
          projectName,
          aspect,
          channel,
          config.quality,
          deliveryTarget,
        );
        jobs.push({
          id: `${aspect}-${channel}-${config.quality}-${config.fps}-${deliveryTarget}-${config.id}`,
          aspect,
          channel,
          quality: config.quality,
          fps: config.fps,
          deliveryTarget,
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
