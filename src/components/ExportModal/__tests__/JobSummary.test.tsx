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

describe('JobSummary — cartesian product math', () => {
  it('renders 0 files with prompting copy when nothing selected', () => {
    const selection: ExportSelection = { aspects: [], channels: [] };
    render(<JobSummary selection={selection} />);
    expect(summaryText()).toContain('0 files');
  });

  it('renders 0 files when only aspects are selected', () => {
    const selection: ExportSelection = { aspects: ['9_16'], channels: [] };
    render(<JobSummary selection={selection} />);
    expect(summaryText()).toContain('0 files');
  });

  it('renders 0 files when only channels are selected', () => {
    const selection: ExportSelection = {
      aspects: [],
      channels: ['composite'],
    };
    render(<JobSummary selection={selection} />);
    expect(summaryText()).toContain('0 files');
  });

  it('uses "1 file" (singular) for 1×1', () => {
    const selection: ExportSelection = {
      aspects: ['9_16'],
      channels: ['composite'],
    };
    render(<JobSummary selection={selection} />);
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
    render(<JobSummary selection={selection} />);
    expect(summaryText()).toContain('3 files');
  });

  it('multiplies aspects × channels for 1×3', () => {
    const selection: ExportSelection = {
      aspects: ['9_16'],
      channels: ['composite', 'map_only', 'video_only'],
    };
    render(<JobSummary selection={selection} />);
    const text = summaryText();
    expect(text).toContain('3 files');
    expect(text).toContain('9:16 composite');
    expect(text).toContain('9:16 map');
    expect(text).toContain('9:16 video');
  });

  it('multiplies aspects × channels for 3×3 (full multi-select)', () => {
    const selection: ExportSelection = {
      aspects: ['9_16', '4_5', '16_9'],
      channels: ['composite', 'map_only', 'video_only'],
    };
    render(<JobSummary selection={selection} />);
    const text = summaryText();
    expect(text).toContain('9 files');
    expect(text).toContain('9:16 composite');
    expect(text).toContain('4:5 map');
    expect(text).toContain('16:9 video');
  });

  it('counts 2×2 → 4 files', () => {
    const selection: ExportSelection = {
      aspects: ['9_16', '4_5'],
      channels: ['composite', 'map_only'],
    };
    render(<JobSummary selection={selection} />);
    expect(summaryText()).toContain('4 files');
  });
});
