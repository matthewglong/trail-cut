import { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/react';
import { QueueView } from '../QueueView';
import type { QueueJob, QueueState } from '../../../hooks/useExportQueue';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: React.ReactNode) {
  act(() => {
    root.render(node);
  });
}

function findByTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

function makeJob(overrides: Partial<QueueJob> & Pick<QueueJob, 'id' | 'state'>): QueueJob {
  return {
    aspect: '9_16',
    channel: 'composite',
    quality: '1080p',
    fps: 30,
    deliveryTarget: 'sdr_h265',
    outputPath: `/out/${overrides.id}.mp4`,
    ...overrides,
  };
}

describe('QueueView', () => {
  it('renders one row per job with the correct badge label', () => {
    const jobs: QueueJob[] = [
      makeJob({ id: 'a', state: 'done' }),
      makeJob({ id: 'b', state: 'running' }),
      makeJob({ id: 'c', state: 'pending' }),
      makeJob({ id: 'd', state: 'failed' }),
    ];
    render(
      <QueueView jobs={jobs} queueState="running" onCancel={() => {}} />,
    );
    expect(findByTestId('export-queue-row-a')).not.toBeNull();
    expect(findByTestId('export-queue-row-b')).not.toBeNull();
    expect(findByTestId('export-queue-row-c')).not.toBeNull();
    expect(findByTestId('export-queue-row-d')).not.toBeNull();
    expect(findByTestId('export-queue-badge-a')?.textContent).toContain('done');
    expect(findByTestId('export-queue-badge-c')?.textContent).toContain('pending');
    expect(findByTestId('export-queue-badge-d')?.textContent).toContain('failed');
  });

  it('shows "M of N done" using the done count only', () => {
    const jobs: QueueJob[] = [
      makeJob({ id: 'a', state: 'done' }),
      makeJob({ id: 'b', state: 'failed' }),
      makeJob({ id: 'c', state: 'running' }),
      makeJob({ id: 'd', state: 'pending' }),
    ];
    render(
      <QueueView jobs={jobs} queueState="running" onCancel={() => {}} />,
    );
    expect(findByTestId('export-queue-progress')?.textContent).toBe(
      '1 of 4 done',
    );
  });

  it('shows the spinner only on the running job', () => {
    const jobs: QueueJob[] = [
      makeJob({ id: 'a', state: 'done' }),
      makeJob({ id: 'b', state: 'running' }),
      makeJob({ id: 'c', state: 'pending' }),
    ];
    render(
      <QueueView jobs={jobs} queueState="running" onCancel={() => {}} />,
    );
    const spinners = container.querySelectorAll(
      '[data-testid="export-queue-spinner"]',
    );
    expect(spinners.length).toBe(1);
    expect(findByTestId('export-queue-row-b')?.contains(spinners[0])).toBe(true);
  });

  it('hides the cancel button when idle or done', () => {
    const jobs: QueueJob[] = [makeJob({ id: 'a', state: 'pending' })];
    const states: QueueState[] = ['idle', 'done'];
    for (const state of states) {
      render(<QueueView jobs={jobs} queueState={state} onCancel={() => {}} />);
      expect(findByTestId('export-queue-cancel')).toBeNull();
    }
  });

  it('shows cancel disabled with "Cancelling…" while in cancelling state', () => {
    const jobs: QueueJob[] = [makeJob({ id: 'a', state: 'running' })];
    render(
      <QueueView jobs={jobs} queueState="cancelling" onCancel={() => {}} />,
    );
    const btn = findByTestId('export-queue-cancel') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain('Cancelling');
  });

  it('cancel button fires the callback when running', () => {
    const jobs: QueueJob[] = [makeJob({ id: 'a', state: 'running' })];
    const onCancel = vi.fn();
    render(
      <QueueView jobs={jobs} queueState="running" onCancel={onCancel} />,
    );
    const btn = findByTestId('export-queue-cancel') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    act(() => {
      fireEvent.click(btn);
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
