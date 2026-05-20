import { act, renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useExportQueue } from '../useExportQueue';
import type { ExportJob } from '../../lib/exportFilenames';
import type { RenderExportRequest } from '../../lib/exportRequest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class<T> {
    onmessage: ((ev: T) => void) | null = null;
  },
}));

function makeJob(id: string): ExportJob {
  return {
    id,
    aspect: '9_16',
    channel: 'composite',
    quality: '1080p',
    fps: 30,
    outputPath: `/out/${id}.mp4`,
  };
}

const stubRequest = (job: ExportJob): RenderExportRequest =>
  ({ output_path: job.outputPath } as unknown as RenderExportRequest);

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe('useExportQueue', () => {
  it('starts in idle with empty jobs', () => {
    const { result } = renderHook(() => useExportQueue());
    expect(result.current.queueState).toBe('idle');
    expect(result.current.jobs).toEqual([]);
  });

  it('dispatches jobs sequentially and marks them done in order', async () => {
    const d1 = deferred<{ frames_written: number; output_path: string; wall_clock_ms: number }>();
    const d2 = deferred<{ frames_written: number; output_path: string; wall_clock_ms: number }>();
    const d3 = deferred<{ frames_written: number; output_path: string; wall_clock_ms: number }>();
    invokeMock
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(() => d2.promise)
      .mockImplementationOnce(() => d3.promise);

    const { result } = renderHook(() => useExportQueue());
    const jobs = [makeJob('a'), makeJob('b'), makeJob('c')];
    act(() => {
      result.current.start(jobs, stubRequest);
    });
    expect(result.current.queueState).toBe('running');
    expect(result.current.jobs.map((j) => j.state)).toEqual([
      'running',
      'pending',
      'pending',
    ]);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      d1.resolve({ frames_written: 1, output_path: '/out/a.mp4', wall_clock_ms: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.jobs.map((j) => j.state)).toEqual([
      'done',
      'running',
      'pending',
    ]);
    expect(invokeMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      d2.resolve({ frames_written: 1, output_path: '/out/b.mp4', wall_clock_ms: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.jobs.map((j) => j.state)).toEqual([
      'done',
      'done',
      'running',
    ]);

    await act(async () => {
      d3.resolve({ frames_written: 1, output_path: '/out/c.mp4', wall_clock_ms: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.queueState).toBe('done');
    expect(result.current.jobs.map((j) => j.state)).toEqual(['done', 'done', 'done']);
  });

  it('cancel-after-current leaves remaining jobs pending and ends in cancelled', async () => {
    const d1 = deferred<{ frames_written: number; output_path: string; wall_clock_ms: number }>();
    invokeMock
      .mockImplementationOnce(() => d1.promise)
      .mockImplementation(() =>
        Promise.resolve({ frames_written: 1, output_path: '/out/x.mp4', wall_clock_ms: 1 }),
      );

    const { result } = renderHook(() => useExportQueue());
    const jobs = [makeJob('a'), makeJob('b'), makeJob('c')];
    act(() => {
      result.current.start(jobs, stubRequest);
    });

    act(() => {
      result.current.cancel();
    });
    expect(result.current.queueState).toBe('cancelling');

    await act(async () => {
      d1.resolve({ frames_written: 1, output_path: '/out/a.mp4', wall_clock_ms: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });

    // The terminal state for a user-cancelled run is `'cancelled'` — distinct
    // from `'done'`, which is reserved for "queue ran to completion". The
    // ExportModal's view-advance effect routes both to the summary view,
    // but the summary differentiates copy based on which jobs ran.
    expect(result.current.queueState).toBe('cancelled');
    expect(result.current.jobs.map((j) => j.state)).toEqual([
      'done',
      'pending',
      'pending',
    ]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('marks failed jobs and continues to subsequent jobs', async () => {
    invokeMock
      .mockResolvedValueOnce({ frames_written: 1, output_path: '/out/a.mp4', wall_clock_ms: 1 })
      .mockRejectedValueOnce({ stage: 'encode', message: 'ffmpeg exploded' })
      .mockResolvedValueOnce({ frames_written: 1, output_path: '/out/c.mp4', wall_clock_ms: 1 });

    const { result } = renderHook(() => useExportQueue());
    const jobs = [makeJob('a'), makeJob('b'), makeJob('c')];
    await act(async () => {
      result.current.start(jobs, stubRequest);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.queueState).toBe('done');
    expect(result.current.jobs.map((j) => j.state)).toEqual([
      'done',
      'failed',
      'done',
    ]);
    expect(result.current.jobs[1].error).toContain('ffmpeg exploded');
  });

  it('reset returns to idle with empty jobs after a run', async () => {
    invokeMock.mockResolvedValue({ frames_written: 1, output_path: '/x', wall_clock_ms: 1 });
    const { result } = renderHook(() => useExportQueue());
    await act(async () => {
      result.current.start([makeJob('a')], stubRequest);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.queueState).toBe('done');

    act(() => {
      result.current.reset();
    });
    expect(result.current.queueState).toBe('idle');
    expect(result.current.jobs).toEqual([]);
  });

  it('start is a no-op while another run is in progress', async () => {
    const d1 = deferred<{ frames_written: number; output_path: string; wall_clock_ms: number }>();
    invokeMock.mockImplementation(() => d1.promise);
    const { result } = renderHook(() => useExportQueue());
    act(() => {
      result.current.start([makeJob('a')], stubRequest);
    });
    expect(result.current.queueState).toBe('running');
    act(() => {
      result.current.start([makeJob('b'), makeJob('c')], stubRequest);
    });
    expect(result.current.jobs.map((j) => j.id)).toEqual(['a']);

    await act(async () => {
      d1.resolve({ frames_written: 1, output_path: '/x', wall_clock_ms: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.queueState).toBe('done');
  });
});
