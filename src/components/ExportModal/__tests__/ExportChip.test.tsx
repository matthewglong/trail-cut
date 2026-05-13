import { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/react';
import { ExportChip, chipLabel } from '../ExportChip';
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

const baseConfig: ExportConfig = { id: 'cfg-1', quality: '1080p', fps: 30 };

describe('ExportChip', () => {
  it('renders the {quality_label}·{fps} text', () => {
    render(
      <ExportChip
        config={baseConfig}
        ariaLabel="Edit 16:9 composite export — 1080p at 30 fps"
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    const label = container.querySelector('[data-testid="export-chip-cfg-1-label"]');
    expect(label?.textContent).toBe('1080·30');
  });

  it('renders the 4K label for 2160p', () => {
    render(
      <ExportChip
        config={{ ...baseConfig, id: 'c2', quality: '2160p' }}
        ariaLabel="Edit"
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-testid="export-chip-c2-label"]')?.textContent).toBe(
      '4K·30',
    );
  });

  it('fires onEdit when the chip body is clicked', () => {
    const onEdit = vi.fn();
    render(
      <ExportChip
        config={baseConfig}
        ariaLabel="Edit"
        onEdit={onEdit}
        onRemove={vi.fn()}
      />,
    );
    const chip = container.querySelector('[data-testid="export-chip-cfg-1"]')!;
    act(() => fireEvent.click(chip));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('fires onEdit on Enter and Space key', () => {
    const onEdit = vi.fn();
    render(
      <ExportChip
        config={baseConfig}
        ariaLabel="Edit"
        onEdit={onEdit}
        onRemove={vi.fn()}
      />,
    );
    const chip = container.querySelector('[data-testid="export-chip-cfg-1"]')! as HTMLElement;
    chip.focus();
    act(() => fireEvent.keyDown(chip, { key: 'Enter' }));
    act(() => fireEvent.keyDown(chip, { key: ' ' }));
    expect(onEdit).toHaveBeenCalledTimes(2);
  });

  it('fires onRemove (and not onEdit) when the × is clicked', () => {
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    render(
      <ExportChip
        config={baseConfig}
        ariaLabel="Edit"
        onEdit={onEdit}
        onRemove={onRemove}
      />,
    );
    const removeBtn = container.querySelector(
      '[data-testid="export-chip-cfg-1-remove"]',
    )!;
    act(() => fireEvent.click(removeBtn));
    expect(onRemove).toHaveBeenCalledTimes(1);
    // The click handler must stopPropagation so onEdit doesn't fire too —
    // otherwise removing a chip would re-open the secondary modal.
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('exposes the ariaLabel on the chip element', () => {
    render(
      <ExportChip
        config={baseConfig}
        ariaLabel="Edit 16:9 composite export — 1080p at 30 fps"
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    const chip = container.querySelector('[data-testid="export-chip-cfg-1"]')!;
    expect(chip.getAttribute('aria-label')).toBe(
      'Edit 16:9 composite export — 1080p at 30 fps',
    );
    expect(chip.getAttribute('role')).toBe('button');
    expect(chip.getAttribute('tabindex')).toBe('0');
  });
});

describe('chipLabel', () => {
  it.each([
    ['720p', 24, '720·24'],
    ['1080p', 30, '1080·30'],
    ['1440p', 60, '1440·60'],
    ['2160p', 30, '4K·30'],
  ] as const)('%s @ %s → %s', (quality, fps, expected) => {
    expect(chipLabel({ id: 'x', quality, fps })).toBe(expected);
  });
});
