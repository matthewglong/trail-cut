import { useCallback, useRef, useState } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import type { ExportJob } from '../lib/exportFilenames';
import type { RenderExportRequest } from '../lib/exportRequest';

export type JobState = 'pending' | 'running' | 'done' | 'failed';

export interface RenderExportSummary {
  frames_written: number;
  output_path: string;
  wall_clock_ms: number;
}

/** Mirrors the Rust `ProgressEvent` struct emitted over the per-job
 *  Tauri channel. `frames_done` is the running output-frame count;
 *  `total_frames` is the constant denominator the bar divides by. */
export interface ProgressEvent {
  frames_done: number;
  total_frames: number;
}

/** Surface area of a Rust `RenderExportError` as it crosses IPC. The Rust
 *  side serializes a `{ stage, message, stderr_tail }` struct, but the queue
 *  only needs a single user-facing string per failure. */
interface RenderExportErrorShape {
  stage?: string;
  message?: string;
  stderr_tail?: string;
}

export interface QueueJob extends ExportJob {
  state: JobState;
  error?: string;
  summary?: RenderExportSummary;
  /** Output frames rendered so far; populated while `state === 'running'`
   *  via the per-job Tauri progress channel. Undefined until the first
   *  event arrives. */
  framesDone?: number;
  /** Total frames the job will produce (timeline duration × output fps).
   *  Sent in the same progress event as `framesDone` so the bar has both
   *  endpoints without recomputing on the frontend. */
  totalFrames?: number;
}

/** Terminal states are `'done'` (queue ran to completion — some jobs may
 *  still be `'failed'`) and `'cancelled'` (user called `cancel()` mid-run,
 *  the loop broke before all jobs ran). They are differentiated so the
 *  modal can route to a "complete" view vs a "cancelled" view; both unlock
 *  the user to close the modal. `'cancelling'` is the transient state
 *  between `cancel()` being called and the in-flight job resolving. */
export type QueueState = 'idle' | 'running' | 'cancelling' | 'cancelled' | 'done';

export interface UseExportQueue {
  jobs: QueueJob[];
  queueState: QueueState;
  start(
    jobs: ExportJob[],
    buildRequest: (job: ExportJob) => RenderExportRequest,
  ): void;
  cancel(): void;
  reset(): void;
}

function errorMessageOf(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as RenderExportErrorShape;
    if (e.message) return e.stage ? `${e.stage}: ${e.message}` : e.message;
  }
  return 'unknown error';
}

export function useExportQueue(): UseExportQueue {
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [queueState, setQueueState] = useState<QueueState>('idle');
  const cancelRef = useRef(false);
  const runningRef = useRef(false);

  const setJobAt = useCallback((idx: number, patch: Partial<QueueJob>) => {
    setJobs((prev) => {
      if (idx < 0 || idx >= prev.length) return prev;
      const next = prev.slice();
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }, []);

  const start = useCallback(
    (
      pending: ExportJob[],
      buildRequest: (job: ExportJob) => RenderExportRequest,
    ) => {
      if (runningRef.current) return;
      runningRef.current = true;
      cancelRef.current = false;

      const initial: QueueJob[] = pending.map((j) => ({ ...j, state: 'pending' }));
      setJobs(initial);
      setQueueState('running');

      void (async () => {
        try {
          for (let i = 0; i < initial.length; i += 1) {
            if (cancelRef.current) {
              setQueueState('cancelling');
              break;
            }
            setJobAt(i, { state: 'running' });
            try {
              const req = buildRequest(initial[i]);
              const progress = new Channel<ProgressEvent>();
              const jobIndex = i;
              progress.onmessage = (ev) => {
                setJobAt(jobIndex, {
                  framesDone: ev.frames_done,
                  totalFrames: ev.total_frames,
                });
              };
              const summary = await invoke<RenderExportSummary>('render_export', {
                req,
                progress,
              });
              setJobAt(i, { state: 'done', summary });
            } catch (err) {
              setJobAt(i, { state: 'failed', error: errorMessageOf(err) });
            }
          }
        } finally {
          runningRef.current = false;
          // Distinguish "ran to completion" (some jobs may still be 'failed')
          // from "user cancelled mid-run" so the modal can route to the
          // right terminal view. The cancelRef latch survives the in-flight
          // job resolution so this branch fires on the cancel path even when
          // the for-loop broke between iterations.
          setQueueState(cancelRef.current ? 'cancelled' : 'done');
        }
      })();
    },
    [setJobAt],
  );

  const cancel = useCallback(() => {
    if (!runningRef.current) return;
    cancelRef.current = true;
    setQueueState((s) => (s === 'running' ? 'cancelling' : s));
  }, []);

  const reset = useCallback(() => {
    if (runningRef.current) return;
    cancelRef.current = false;
    setJobs([]);
    setQueueState('idle');
  }, []);

  return { jobs, queueState, start, cancel, reset };
}
