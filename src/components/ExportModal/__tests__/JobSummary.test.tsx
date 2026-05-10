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

function estimateText(): string | null {
  const el = container.querySelector(
    '[data-testid="export-job-summary-estimate"]',
  );
  return el ? el.textContent ?? '' : null;
}

describe('JobSummary — cartesian product math (no folder)', () => {
  it('renders 0 files with prompting copy when nothing selected', () => {
    const selection: ExportSelection = { aspects: [], channels: [], output_dir: null };
    render(
      <JobSummary
        selection={selection}
        projectName="Hike"
        outputFolder={null}
        nClips={0}
        timelineDurationSec={0}
      />,
    );
    expect(summaryText()).toContain('0 files');
  });

  it('renders 0 files when only aspects are selected', () => {
    const selection: ExportSelection = { aspects: ['9_16'], channels: [], output_dir: null };
    render(
      <JobSummary
        selection={selection}
        projectName="Hike"
        outputFolder={null}
        nClips={0}
        timelineDurationSec={0}
      />,
    );
    expect(summaryText()).toContain('0 files');
  });

  it('renders 0 files when only channels are selected', () => {
    const selection: ExportSelection = {
      aspects: [],
      channels: ['composite'],
      output_dir: null,
    };
    render(
      <JobSummary
        selection={selection}
        projectName="Hike"
        outputFolder={null}
        nClips={0}
        timelineDurationSec={0}
      />,
    );
    expect(summaryText()).toContain('0 files');
  });

  it('uses "1 file" (singular) for 1×1', () => {
    const selection: ExportSelection = {
      aspects: ['9_16'],
      channels: ['composite'],
      output_dir: null,
    };
    render(
      <JobSummary
        selection={selection}
        projectName="Hike"
        outputFolder={null}
        nClips={0}
        timelineDurationSec={0}
      />,
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
      output_dir: null,
    };
    render(
      <JobSummary
        selection={selection}
        projectName="Hike"
        outputFolder={null}
        nClips={0}
        timelineDurationSec={0}
      />,
    );
    expect(summaryText()).toContain('3 files');
  });

  it('multiplies aspects × channels for 3×3 (full multi-select)', () => {
    const selection: ExportSelection = {
      aspects: ['9_16', '4_5', '16_9'],
      channels: ['composite', 'map_only', 'video_only'],
      output_dir: null,
    };
    render(
      <JobSummary
        selection={selection}
        projectName="Hike"
        outputFolder={null}
        nClips={0}
        timelineDurationSec={0}
      />,
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
      output_dir: null,
    };
    render(
      <JobSummary
        selection={selection}
        projectName="Hike2026"
        outputFolder="/Users/u/out"
        nClips={0}
        timelineDurationSec={0}
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
      output_dir: null,
    };
    render(
      <JobSummary
        selection={selection}
        projectName="Hike2026"
        outputFolder="/out"
        nClips={0}
        timelineDurationSec={0}
      />,
    );
    expect(fileLines()).toHaveLength(4);
    expect(fileLines().some((line) => line.startsWith('and '))).toBe(false);
  });

  it('collapses to first 3 + "and N more" when n_jobs > 4', () => {
    const selection: ExportSelection = {
      aspects: ['9_16', '4_5', '16_9'],
      channels: ['composite', 'map_only', 'video_only'],
      output_dir: null,
    };
    render(
      <JobSummary
        selection={selection}
        projectName="Hike2026"
        outputFolder="/out"
        nClips={0}
        timelineDurationSec={0}
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
      output_dir: null,
    };
    render(
      <JobSummary
        selection={selection}
        projectName="!!!"
        outputFolder="/out"
        nClips={0}
        timelineDurationSec={0}
      />,
    );
    expect(fileLines()).toEqual(['trailcut-export-9_16-composite.mp4']);
  });

  it('renders no file list when n_jobs is 0 even with folder set', () => {
    const selection: ExportSelection = { aspects: [], channels: [], output_dir: null };
    render(
      <JobSummary
        selection={selection}
        projectName="Hike"
        outputFolder="/out"
        nClips={0}
        timelineDurationSec={0}
      />,
    );
    expect(summaryText()).toContain('0 files');
    expect(fileLines()).toEqual([]);
  });
});

describe('JobSummary — time estimate', () => {
  it('hides estimate when n_jobs is 0', () => {
    const selection: ExportSelection = { aspects: [], channels: [], output_dir: null };
    render(
      <JobSummary
        selection={selection}
        projectName="Hike"
        outputFolder={null}
        nClips={10}
        timelineDurationSec={60}
      />,
    );
    expect(estimateText()).toBeNull();
  });

  it('hides estimate when both nClips and timelineDurationSec are 0', () => {
    const selection: ExportSelection = {
      aspects: ['9_16'],
      channels: ['composite'],
      output_dir: null,
    };
    render(
      <JobSummary
        selection={selection}
        projectName="Hike"
        outputFolder={null}
        nClips={0}
        timelineDurationSec={0}
      />,
    );
    expect(estimateText()).toBeNull();
  });

  it('shows estimate alongside cartesian breakdown (no folder)', () => {
    const selection: ExportSelection = {
      aspects: ['9_16'],
      channels: ['composite'],
      output_dir: null,
    };
    render(
      <JobSummary
        selection={selection}
        projectName="Hike"
        outputFolder={null}
        nClips={10}
        timelineDurationSec={60}
      />,
    );
    expect(estimateText()).toContain('Estimated time:');
  });

  it('shows estimate alongside filename preview (folder set)', () => {
    const selection: ExportSelection = {
      aspects: ['9_16'],
      channels: ['composite'],
      output_dir: null,
    };
    render(
      <JobSummary
        selection={selection}
        projectName="Hike"
        outputFolder="/out"
        nClips={10}
        timelineDurationSec={60}
      />,
    );
    expect(estimateText()).toContain('Estimated time:');
    expect(fileLines().length).toBeGreaterThan(0);
  });

  it('formats below 60s as "<1 min"', () => {
    // 1 clip × 0.5 + 60 × 0.4 = 24.5s (composite, single job).
    const selection: ExportSelection = {
      aspects: ['9_16'],
      channels: ['composite'],
      output_dir: null,
    };
    render(
      <JobSummary
        selection={selection}
        projectName="Hike"
        outputFolder={null}
        nClips={1}
        timelineDurationSec={60}
      />,
    );
    expect(estimateText()).toContain('<1 min');
  });

  it('formats minute range as "~N min"', () => {
    // 50 clips × 0.5 + 300 × 0.4 = 25 + 120 = 145s ≈ 2 min (rounded).
    const selection: ExportSelection = {
      aspects: ['9_16'],
      channels: ['composite'],
      output_dir: null,
    };
    render(
      <JobSummary
        selection={selection}
        projectName="Hike"
        outputFolder={null}
        nClips={50}
        timelineDurationSec={300}
      />,
    );
    expect(estimateText()).toContain('~2 min');
  });

  it('formats above 60min as "~Hh Mm"', () => {
    // Force ≥3600s: 3 jobs × (200 × 0.5 + 1800 × 0.6) = 3 × 1180 = 3540s
    // — bump up to push over 60m. 200×0.5 + 1800×0.6 = 100 + 1080 = 1180.
    // 4 jobs of that = 4720s = 78m → "~1h 18m".
    const selection: ExportSelection = {
      aspects: ['9_16', '4_5'],
      channels: ['video_only', 'composite'],
      output_dir: null,
    };
    render(
      <JobSummary
        selection={selection}
        projectName="Hike"
        outputFolder={null}
        nClips={200}
        timelineDurationSec={1800}
      />,
    );
    const text = estimateText() ?? '';
    expect(text).toMatch(/~\d+h \d+m/);
  });
});
