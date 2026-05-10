import { act } from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { JobSummary } from '../JobSummary';
import type { ExportSelection } from '../../../types';

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

function summaryText(): string {
  const el = container.querySelector('[data-testid="export-job-summary"]');
  if (!el) throw new Error('summary not found');
  return el.textContent ?? '';
}

function fileLines(): string[] {
  const items = container.querySelectorAll(
    '[data-testid="export-job-summary-files"] li',
  );
  return Array.from(items).map((el) => el.textContent ?? '');
}

describe('JobSummary — cartesian product math (no folder)', () => {
  it('renders 0 files with prompting copy when nothing selected', () => {
    const selection: ExportSelection = { aspects: [], channels: [] };
    render(
      <JobSummary selection={selection} projectName="Hike" outputFolder={null} />,
    );
    expect(summaryText()).toContain('0 files');
  });

  it('renders 0 files when only aspects are selected', () => {
    const selection: ExportSelection = { aspects: ['9_16'], channels: [] };
    render(
      <JobSummary selection={selection} projectName="Hike" outputFolder={null} />,
    );
    expect(summaryText()).toContain('0 files');
  });

  it('renders 0 files when only channels are selected', () => {
    const selection: ExportSelection = {
      aspects: [],
      channels: ['composite'],
    };
    render(
      <JobSummary selection={selection} projectName="Hike" outputFolder={null} />,
    );
    expect(summaryText()).toContain('0 files');
  });

  it('uses "1 file" (singular) for 1×1', () => {
    const selection: ExportSelection = {
      aspects: ['9_16'],
      channels: ['composite'],
    };
    render(
      <JobSummary selection={selection} projectName="Hike" outputFolder={null} />,
    );
    const text = summaryText();
    expect(text).toContain('1 file:');
    expect(text).not.toContain('1 files');
    expect(text).toContain('9:16 composite');
  });

  it('multiplies aspects × channels for 3×1', () => {
    const selection: ExportSelection = {
      aspects: ['9_16', '4_5', '16_9'],
      channels: ['composite'],
    };
    render(
      <JobSummary selection={selection} projectName="Hike" outputFolder={null} />,
    );
    expect(summaryText()).toContain('3 files');
  });

  it('multiplies aspects × channels for 3×3 (full multi-select)', () => {
    const selection: ExportSelection = {
      aspects: ['9_16', '4_5', '16_9'],
      channels: ['composite', 'map_only', 'video_only'],
    };
    render(
      <JobSummary selection={selection} projectName="Hike" outputFolder={null} />,
    );
    const text = summaryText();
    expect(text).toContain('9 files');
    expect(text).toContain('9:16 composite');
    expect(text).toContain('4:5 map');
    expect(text).toContain('16:9 video');
  });
});

describe('JobSummary — filename preview (folder set)', () => {
  it('lists derived filenames inline when n_jobs ≤ 4', () => {
    const selection: ExportSelection = {
      aspects: ['9_16'],
      channels: ['composite', 'map_only'],
    };
    render(
      <JobSummary
        selection={selection}
        projectName="Hike2026"
        outputFolder="/Users/u/out"
      />,
    );
    expect(summaryText()).toContain('2 files');
    expect(fileLines()).toEqual([
      'hike2026-9_16-composite.mp4',
      'hike2026-9_16-map_only.mov',
    ]);
  });

  it('lists exactly 4 filenames inline at the n_jobs=4 boundary', () => {
    const selection: ExportSelection = {
      aspects: ['9_16', '4_5'],
      channels: ['composite', 'map_only'],
    };
    render(
      <JobSummary
        selection={selection}
        projectName="Hike2026"
        outputFolder="/out"
      />,
    );
    expect(fileLines()).toHaveLength(4);
    expect(fileLines().some((line) => line.startsWith('and '))).toBe(false);
  });

  it('collapses to first 3 + "and N more" when n_jobs > 4', () => {
    const selection: ExportSelection = {
      aspects: ['9_16', '4_5', '16_9'],
      channels: ['composite', 'map_only', 'video_only'],
    };
    render(
      <JobSummary
        selection={selection}
        projectName="Hike2026"
        outputFolder="/out"
      />,
    );
    expect(summaryText()).toContain('9 files');
    const lines = fileLines();
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('hike2026-9_16-composite.mp4');
    expect(lines[1]).toBe('hike2026-9_16-map_only.mov');
    expect(lines[2]).toBe('hike2026-9_16-video_only.mov');
    expect(lines[3]).toBe('and 6 more');
  });

  it('falls back to "trailcut-export" prefix for symbol-only project names', () => {
    const selection: ExportSelection = {
      aspects: ['9_16'],
      channels: ['composite'],
    };
    render(
      <JobSummary
        selection={selection}
        projectName="!!!"
        outputFolder="/out"
      />,
    );
    expect(fileLines()).toEqual(['trailcut-export-9_16-composite.mp4']);
  });

  it('renders no file list when n_jobs is 0 even with folder set', () => {
    const selection: ExportSelection = { aspects: [], channels: [] };
    render(
      <JobSummary
        selection={selection}
        projectName="Hike"
        outputFolder="/out"
      />,
    );
    expect(summaryText()).toContain('0 files');
    expect(fileLines()).toEqual([]);
  });
});
