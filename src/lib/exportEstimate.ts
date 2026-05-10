import type { ExportChannel } from '../types';
import type { ExportJob } from './exportFilenames';

// validate against 3 real exports post-launch
const STARTUP_COST_PER_CLIP_SEC = 0.5;

const ENCODE_FACTOR: Record<ExportChannel, number> = {
  composite: 0.4,
  map_only: 0.3,
  video_only: 0.6,
};

/** Estimated wall-clock seconds for a single render job. Combines a fixed
 *  per-clip startup cost (probe + decoder init, dominated by N at high clip
 *  counts per `large-clip-count-composite.md` §1) with a per-channel encode
 *  factor applied to the timeline duration. ±30% target. */
export function estimateJob(
  nClips: number,
  timelineDurationSec: number,
  channel: ExportChannel,
): number {
  const startup = nClips * STARTUP_COST_PER_CLIP_SEC;
  const encode = timelineDurationSec * ENCODE_FACTOR[channel];
  return startup + encode;
}

/** Sequential queue → simple sum across job estimates. */
export function estimateQueue(
  jobs: ExportJob[],
  nClips: number,
  timelineDurationSec: number,
): number {
  return jobs.reduce(
    (acc, job) => acc + estimateJob(nClips, timelineDurationSec, job.channel),
    0,
  );
}
