import { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/react';
import { QueueSummary } from '../QueueSummary';
import type { QueueJob } from '../../../hooks/useExportQueue';

const revealMock = vi.fn();

vi.mock('@tauri-apps/plugin-opener', () => ({
  revealItemInDir: (...args: unknown[]) => revealMock(...args),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  revealMock.mockReset();
  revealMock.mockResolvedValue(undefined);
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
    outputPath: `/out/${overrides.id}.mp4`,
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('QueueSummary', () => {
  it('shows N files exported matching the done count', () => {
    const jobs: QueueJob[] = [
      makeJob({ id: 'a', state: 'done' }),
      makeJob({ id: 'b', state: 'done' }),
      makeJob({ id: 'c', state: 'failed', error: 'oh no' }),
    ];
    render(<QueueSummary jobs={jobs} outputDir="/out" onClose={() => {}} />);
    const heading = findByTestId('export-queue-summary-heading');
    expect(heading?.textContent).toContain('2 files exported');
    expect(heading?.textContent).toContain('1 failed');
  });

  it('uses singular "file" when exactly one done job', () => {
    const jobs: QueueJob[] = [makeJob({ id: 'a', state: 'done' })];
    render(<QueueSummary jobs={jobs} outputDir="/out" onClose={() => {}} />);
    expect(findByTestId('export-queue-summary-heading')?.textContent).toContain(
      '1 file exported',
    );
  });

  it('renders an error row per failed job with its error message', () => {
    const jobs: QueueJob[] = [
      makeJob({ id: 'a', state: 'failed', error: 'boom' }),
      makeJob({ id: 'b', state: 'failed', error: 'kaboom' }),
    ];
    render(<QueueSummary jobs={jobs} outputDir="/out" onClose={() => {}} />);
    const failedList = findByTestId('export-queue-summary-failed');
    expect(failedList).not.toBeNull();
    const lis = failedList!.querySelectorAll('li');
    expect(lis.length).toBe(2);
    expect(lis[0].textContent).toContain('boom');
    expect(lis[1].textContent).toContain('kaboom');
  });

  it('clicking Reveal in Finder calls revealItemInDir on the first done file', async () => {
    const jobs: QueueJob[] = [
      makeJob({ id: 'a', state: 'done', outputPath: '/out/a.mp4' }),
    ];
    render(<QueueSummary jobs={jobs} outputDir="/out" onClose={() => {}} />);
    act(() => {
      fireEvent.click(findByTestId('export-queue-reveal') as HTMLButtonElement);
    });
    await flush();
    expect(revealMock).toHaveBeenCalledWith('/out/a.mp4');
  });

  it('falls back to outputDir when no job succeeded', async () => {
    const jobs: QueueJob[] = [
      makeJob({ id: 'a', state: 'failed', error: 'x' }),
    ];
    render(<QueueSummary jobs={jobs} outputDir="/somewhere" onClose={() => {}} />);
    act(() => {
      fireEvent.click(findByTestId('export-queue-reveal') as HTMLButtonElement);
    });
    await flush();
    expect(revealMock).toHaveBeenCalledWith('/somewhere');
  });

  it('disables Reveal when no done file and no outputDir', () => {
    const jobs: QueueJob[] = [makeJob({ id: 'a', state: 'failed', error: 'x' })];
    render(<QueueSummary jobs={jobs} outputDir={null} onClose={() => {}} />);
    const btn = findByTestId('export-queue-reveal') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('Done button calls onClose', () => {
    const onClose = vi.fn();
    render(
      <QueueSummary
        jobs={[makeJob({ id: 'a', state: 'done' })]}
        outputDir="/out"
        onClose={onClose}
      />,
    );
    act(() => {
      fireEvent.click(findByTestId('export-queue-done') as HTMLButtonElement);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
