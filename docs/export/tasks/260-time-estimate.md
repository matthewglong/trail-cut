# Task 260 — Time-estimate computation

**Step**: Layout & Export UI (export track)
**Estimated effort**: ~0.5 day
**Status**: pending
**Depends on**: 250
**Companion plan**: `docs/export/plans/layout-ui.md` §4 (estimate), `docs/export/plans/large-clip-count-composite.md` (startup-cost diagnostics)

## Goal

Show a rough wall-clock estimate before the user commits to a render queue. After this task:

- Job summary in `ExportModal` shows estimated total time: *"~7 min"* or *"~25 min"*.
- Estimate breaks down: per-job startup cost × N_clips + encode duration.
- Estimate is acceptably rough (±30% target).

## Estimate model

```
job_time = N_clips × startup_cost_per_clip + timeline_duration × encode_factor[channel]
```

- `startup_cost_per_clip`: ~0.5s (probe + decoder init per `large-clip-count-composite.md` §1). Tunable.
- `encode_factor`:
  - `composite` (Channel A, H.265 1080p): ~0.4× realtime on M-series Mac with hw accel.
  - `video_only` (Channel C, ProRes 4444): ~0.6× realtime (sw encode).
  - `map_only` (Channel B, ProRes 4444): ~0.3× realtime (no source decode load).
- `total_estimate = sum(job_time for job in jobs)` — sequential queue.

## Files to touch

- **New** `src/lib/exportEstimate.ts`:
  ```ts
  export function estimateJob(
    nClips: number,
    timelineDurationSec: number,
    channel: ExportChannel,
  ): number; // seconds

  export function estimateQueue(
    jobs: ExportJob[],
    nClips: number,
    timelineDurationSec: number,
  ): number; // seconds
  ```
- **New** `src/lib/__tests__/exportEstimate.test.ts`.
- **Modified** `src/components/ExportModal/JobSummary.tsx`:
  - Compute `totalSec = estimateQueue(jobs, clips.length, timelineDurationSec)`.
  - Format: `< 60s` → "<1 min"; `< 60min` → "~N min" (round to nearest min); `>= 60min` → "~Hh Mm".
- **Modified** `src/components/ExportModal/ExportModal.tsx`:
  - Receive `clips: Clip[]` and compute `timelineDurationSec` from visible clips' adjusted-by-speed durations.

## Calibration

- Constants are first-pass guesses. Add a TODO to validate against 3 real exports (small / medium / large clip count) post-launch and refine.
- Acceptable error: ±30%. The goal is "is this 5 minutes or 50 minutes" — not a precise countdown.

## Acceptance

- [ ] Estimate shown in job summary line (e.g., *"3 files (9:16 composite, …) — ~7 min"*).
- [ ] Estimate scales with N_clips and timeline duration.
- [ ] Estimate hides when no jobs selected.

## Tests

- `exportEstimate.test.ts`: per-channel factors; sum across jobs; formatting transitions at 60s and 60min boundaries.
- Manual: change selection, watch estimate update; sanity-check against a 70-clip project (should show tens of minutes for full multi-select).
