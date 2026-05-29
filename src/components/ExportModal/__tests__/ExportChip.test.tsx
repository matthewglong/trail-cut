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
  it('renders the {quality_label}·{fps}·{target} text using the channel default', () => {
    render(
      <ExportChip
        config={baseConfig}
        channel="composite"
        ariaLabel="Edit 16:9 composite export — 1080p at 30 fps"
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    const label = container.querySelector('[data-testid="export-chip-cfg-1-label"]');
    // Composite's default delivery target is `sdr_h265` →
    // `H265`. The chip stores `delivery_target: undefined` for the
    // default but the label still surfaces the token so two chips in the
    // same cell with different targets stay distinguishable.
    expect(label?.textContent).toBe('1080·30·H265');
  });

  it('renders the 4K label for 2160p', () => {
    render(
      <ExportChip
        config={{ ...baseConfig, id: 'c2', quality: '2160p' }}
        channel="composite"
        ariaLabel="Edit"
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-testid="export-chip-c2-label"]')?.textContent).toBe(
      '4K·30·H265',
    );
  });

  it('fires onEdit when the chip body is clicked', () => {
    const onEdit = vi.fn();
    render(
      <ExportChip
        config={baseConfig}
        channel="composite"
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
        channel="composite"
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
        channel="composite"
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
        channel="composite"
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
    ['720p', 24, '720·24·H265'],
    ['1080p', 30, '1080·30·H265'],
    ['1440p', 60, '1440·60·H265'],
    ['2160p', 30, '4K·30·H265'],
  ] as const)('%s @ %s on composite (default target) → %s', (quality, fps, expected) => {
    expect(chipLabel({ id: 'x', quality, fps }, 'composite')).toBe(expected);
  });

  it('default `sdr_h265` chip on composite shows the H265 token', () => {
    // The default-target chip stores `delivery_target: undefined` (per the
    // "keep project.json quiet" rule in `ExportModal.handleConfigSave`)
    // but the rendered label still resolves and shows the channel default's
    // token so the chip is distinguishable from a sibling with a non-
    // default target. WS5 acceptance: "Multi-select works: picking
    // TikTok + YouTube HDR produces two output files" → both chips must be
    // visually identifiable in the grid.
    expect(chipLabel({ id: 'x', quality: '1080p', fps: 30 }, 'composite')).toBe(
      '1080·30·H265',
    );
  });

  it('explicit non-default chip on composite still shows its token', () => {
    expect(
      chipLabel(
        {
          id: 'x',
          quality: '2160p',
          fps: 30,
          delivery_target: 'hdr_hlg',
        },
        'composite',
      ),
    ).toBe('4K·30·HDR');
  });

  it('ProRes chip on map_only / video_only shows the PRORES token', () => {
    // map_only and video_only channels default to (and are locked to)
    // `prores` — the channel-default chip there stores no explicit
    // target, but the label still resolves to PRORES.
    expect(chipLabel({ id: 'x', quality: '1080p', fps: 30 }, 'map_only')).toBe(
      '1080·30·PRORES',
    );
    expect(chipLabel({ id: 'x', quality: '1080p', fps: 30 }, 'video_only')).toBe(
      '1080·30·PRORES',
    );
  });
});
