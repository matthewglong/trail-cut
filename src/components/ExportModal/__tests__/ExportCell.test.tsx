import { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/react';
import { ExportCell } from '../ExportCell';
import type { ExportConfig } from '../../../types';

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

const cfg = (id: string, fps: 24 | 30 | 60 = 30): ExportConfig => ({
  id,
  quality: '1080p',
  fps,
});

describe('ExportCell', () => {
  it('renders zero chips and exposes the add button for empty cells', () => {
    render(
      <ExportCell
        aspect="16_9"
        channel="composite"
        configs={[]}
        onAdd={vi.fn()}
        onEditChip={vi.fn()}
        onRemoveChip={vi.fn()}
      />,
    );
    expect(container.querySelectorAll('[data-testid^="export-chip-"]').length).toBe(0);
    const add = container.querySelector(
      '[data-testid="export-cell-16_9-composite-add"]',
    );
    expect(add).not.toBeNull();
    expect(add?.getAttribute('aria-label')).toBe('Add 16:9 composite export');
  });

  it('renders one chip per config in the given order', () => {
    render(
      <ExportCell
        aspect="9_16"
        channel="map_only"
        configs={[cfg('a', 30), cfg('b', 60)]}
        onAdd={vi.fn()}
        onEditChip={vi.fn()}
        onRemoveChip={vi.fn()}
      />,
    );
    const chips = container.querySelectorAll(
      '[data-testid^="export-chip-"][data-testid$="-label"]',
    );
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toBe('1080·30');
    expect(chips[1].textContent).toBe('1080·60');
  });

  it('fires onAdd when the + button is clicked', () => {
    const onAdd = vi.fn();
    render(
      <ExportCell
        aspect="4_5"
        channel="video_only"
        configs={[]}
        onAdd={onAdd}
        onEditChip={vi.fn()}
        onRemoveChip={vi.fn()}
      />,
    );
    const add = container.querySelector(
      '[data-testid="export-cell-4_5-video_only-add"]',
    )!;
    act(() => fireEvent.click(add));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('fires onEditChip with the config when a chip is clicked', () => {
    const onEditChip = vi.fn();
    const configs = [cfg('a', 30), cfg('b', 60)];
    render(
      <ExportCell
        aspect="16_9"
        channel="composite"
        configs={configs}
        onAdd={vi.fn()}
        onEditChip={onEditChip}
        onRemoveChip={vi.fn()}
      />,
    );
    const chip = container.querySelector('[data-testid="export-chip-b"]')!;
    act(() => fireEvent.click(chip));
    expect(onEditChip).toHaveBeenCalledTimes(1);
    expect(onEditChip).toHaveBeenCalledWith(configs[1]);
  });

  it('fires onRemoveChip with the config id when the × is clicked', () => {
    const onRemoveChip = vi.fn();
    const configs = [cfg('a', 30), cfg('b', 60)];
    render(
      <ExportCell
        aspect="16_9"
        channel="composite"
        configs={configs}
        onAdd={vi.fn()}
        onEditChip={vi.fn()}
        onRemoveChip={onRemoveChip}
      />,
    );
    const remove = container.querySelector(
      '[data-testid="export-chip-a-remove"]',
    )!;
    act(() => fireEvent.click(remove));
    expect(onRemoveChip).toHaveBeenCalledTimes(1);
    expect(onRemoveChip).toHaveBeenCalledWith('a');
  });
});
