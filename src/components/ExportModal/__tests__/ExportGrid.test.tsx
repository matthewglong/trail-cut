import { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/react';
import { ExportGrid } from '../ExportGrid';
import type { ExportGrid as ExportGridModel } from '../../../types';

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

const empty: ExportGridModel = { cells: {}, output_dir: null };

describe('ExportGrid', () => {
  it('renders 3 rows × 3 channels = 9 cells', () => {
    render(
      <ExportGrid
        grid={empty}
        onAdd={vi.fn()}
        onEditChip={vi.fn()}
        onRemoveChip={vi.fn()}
      />,
    );
    // Match only the cell shell, not its descendant `*-add` button. Both share
    // the `export-cell-` prefix, so a bare prefix selector double-counts.
    const cells = container.querySelectorAll('[role="grid"] > [role="row"] > div[aria-label]');
    expect(cells.length).toBe(9);
  });

  it('renders rows in display order 16_9, 4_5, 9_16 (top-to-bottom)', () => {
    // Matches both the mockup and ASPECT_ORDER in lib/exportFilenames.
    // The queue order reads left-to-right, top-to-bottom from this grid,
    // so changing the row order here would silently re-order the queue.
    render(
      <ExportGrid
        grid={empty}
        onAdd={vi.fn()}
        onEditChip={vi.fn()}
        onRemoveChip={vi.fn()}
      />,
    );
    const rows = container.querySelectorAll('[data-testid^="export-grid-row-"]');
    const orderedAspects = Array.from(rows).map((row) =>
      row.getAttribute('data-testid')!.replace('export-grid-row-', ''),
    );
    expect(orderedAspects).toEqual(['16_9', '4_5', '9_16']);
  });

  it('renders channel headers in display order: Composite, Map only, Video only', () => {
    render(
      <ExportGrid
        grid={empty}
        onAdd={vi.fn()}
        onEditChip={vi.fn()}
        onRemoveChip={vi.fn()}
      />,
    );
    const headers = container.querySelectorAll('[role="columnheader"]');
    const texts = Array.from(headers).map((h) => h.textContent);
    expect(texts).toEqual(['Aspect', 'Composite', 'Map only', 'Video only']);
  });

  it('renders configured chips in the right cell', () => {
    const grid: ExportGridModel = {
      cells: {
        '16_9-composite': [
          { id: 'a', quality: '1080p', fps: 30 },
          { id: 'b', quality: '2160p', fps: 30 },
        ],
        '4_5-map_only': [{ id: 'c', quality: '1080p', fps: 30 }],
      },
      output_dir: null,
    };
    render(
      <ExportGrid
        grid={grid}
        onAdd={vi.fn()}
        onEditChip={vi.fn()}
        onRemoveChip={vi.fn()}
      />,
    );
    const compositeCell = container.querySelector(
      '[data-testid="export-cell-16_9-composite"]',
    )!;
    const chips = compositeCell.querySelectorAll('[data-testid^="export-chip-"][data-testid$="-label"]');
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toBe('1080·30');
    expect(chips[1].textContent).toBe('4K·30');

    const mapCell = container.querySelector(
      '[data-testid="export-cell-4_5-map_only"]',
    )!;
    expect(
      mapCell.querySelectorAll('[data-testid^="export-chip-"][data-testid$="-label"]')
        .length,
    ).toBe(1);
  });

  it('routes onAdd with (aspect, channel) for the clicked cell', () => {
    const onAdd = vi.fn();
    render(
      <ExportGrid
        grid={empty}
        onAdd={onAdd}
        onEditChip={vi.fn()}
        onRemoveChip={vi.fn()}
      />,
    );
    const add = container.querySelector(
      '[data-testid="export-cell-9_16-video_only-add"]',
    )!;
    act(() => fireEvent.click(add));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith('9_16', 'video_only');
  });

  it('routes onEditChip and onRemoveChip with (aspect, channel, ...)', () => {
    const onEditChip = vi.fn();
    const onRemoveChip = vi.fn();
    const grid: ExportGridModel = {
      cells: {
        '9_16-composite': [{ id: 'cfg-x', quality: '2160p', fps: 60 }],
      },
      output_dir: null,
    };
    render(
      <ExportGrid
        grid={grid}
        onAdd={vi.fn()}
        onEditChip={onEditChip}
        onRemoveChip={onRemoveChip}
      />,
    );
    const chip = container.querySelector('[data-testid="export-chip-cfg-x"]')!;
    act(() => fireEvent.click(chip));
    expect(onEditChip).toHaveBeenCalledTimes(1);
    expect(onEditChip).toHaveBeenCalledWith('9_16', 'composite', {
      id: 'cfg-x',
      quality: '2160p',
      fps: 60,
    });

    const remove = container.querySelector(
      '[data-testid="export-chip-cfg-x-remove"]',
    )!;
    act(() => fireEvent.click(remove));
    expect(onRemoveChip).toHaveBeenCalledTimes(1);
    expect(onRemoveChip).toHaveBeenCalledWith('9_16', 'composite', 'cfg-x');
  });
});
