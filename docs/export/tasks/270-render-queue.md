# Task 270 — Frontend render queue (sequential dispatch + progress UI)

**Step**: Layout & Export UI (export track)
**Estimated effort**: ~1.5 days
**Status**: pending
**Depends on**: 240, 250
**Companion plan**: `docs/export/plans/layout-ui.md` §6

## Goal

Wire the Export modal's Render button to a sequential render queue with progress UI and cancel-after-current. After this task:

- Click Render → modal switches to "queue running" view; jobs dispatched one at a time via the existing `render_export` Tauri command.
- Each job shows state: `pending` / `running` / `done` / `failed`.
- Cancel button stops the queue *after* the current job completes.
- On completion, modal shows summary (files written, errors if any) and a "Reveal in Finder" action for the output folder.

## Files to touch

- **New** `src/hooks/useExportQueue.ts`:
  ```ts
  type JobState = 'pending' | 'running' | 'done' | 'failed';
  type Job = {
    id: string;
    aspect: AspectRatio;
    channel: ExportChannel;
    outputPath: string;
    state: JobState;
    error?: RenderExportError;
    summary?: RenderExportSummary;
  };
  type QueueState = 'idle' | 'running' | 'cancelling' | 'done';

  export function useExportQueue(): {
    jobs: Job[];
    queueState: QueueState;
    start(jobs: Omit<Job, 'state' | 'id'>[]): void;
    cancel(): void;
    reset(): void;
  };
  ```
- **New** `src/hooks/__tests__/useExportQueue.test.ts`.
- **New** `src/components/ExportModal/QueueView.tsx`:
  - List of jobs with state badges.
  - Overall progress: "2 of 6 done".
  - Active-job spinner.
  - Cancel button (visible only when `queueState === 'running'`).
- **New** `src/components/ExportModal/QueueSummary.tsx` (post-run view):
  - Files written, errors per failed job, "Reveal in Finder" button.
- **Modified** `src/components/ExportModal/ExportModal.tsx`:
  - Three view states: `'select' | 'running' | 'done'`.
  - On Render click: build job list via `deriveJobs()`, call `queue.start(jobs)`, switch to `'running'` view.
  - On `queueState === 'done'`, switch to `'done'` view.

## Implementation notes

- Sequential dispatch: each job awaits `invoke<RenderExportSummary>('render_export', { req })` before dispatching the next.
- Per-job request built via existing `buildExportRequest()` (in `src/lib/exportRequest.ts`); `outputPath` is the derived path from 250.
- Cancel: set a flag; the after-await check skips remaining jobs. The current FFmpeg invocation runs to completion (hard-cancel deferred — see `layout-ui.md` §7).
- Errors: a failed job marks itself `failed` and stores the error; queue continues to next job.
- "Reveal in Finder": Tauri shell plugin `open()` on the output directory.

## Pre-queue overwrite check

Before starting, scan target paths for collisions. If any exist, show a confirmation prompt: *"N files already exist and will be overwritten. Continue?"* (per `layout-ui.md` §7). Single confirmation; no per-file prompts.

## Acceptance

- [ ] Render button enabled only when selection + folder are valid.
- [ ] Click Render → queue runs sequentially; UI shows progress.
- [ ] Cancel stops after current job; remaining jobs marked `pending` (or visually de-emphasised).
- [ ] Failed job logs error in the row; queue continues.
- [ ] Done view shows files written and Reveal button.
- [ ] Overwrite confirmation appears when collisions exist; proceed = overwrite, cancel = abort.

## Tests

- `useExportQueue.test.ts`: mock `invoke`, verify sequential dispatch, cancel-after-current, error handling.
- Manual: small (1 job), medium (3 jobs), large (9 jobs); cancel mid-run; trigger an error (e.g., bad output path).
