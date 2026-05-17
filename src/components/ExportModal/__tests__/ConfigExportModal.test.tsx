import { act, useState } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/react';
import { ConfigExportModal, configToInitial } from '../ConfigExportModal';
import type { ExportConfig, ExportFps, OutputResolution } from '../../../types';

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

const baseProps = () => ({
  open: true,
  mode: 'add' as const,
  aspect: '16_9' as const,
  channel: 'composite' as const,
  initial: { quality: '1080p' as OutputResolution, fps: 30 as ExportFps },
  onSave: vi.fn(),
  onCancel: vi.fn(),
});

describe('ConfigExportModal — rendering', () => {
  it('returns null when open=false', () => {
    render(<ConfigExportModal {...baseProps()} open={false} />);
    expect(container.querySelector('[data-testid="config-export-modal"]')).toBeNull();
  });

  it('renders all 4 quality tiers and all 3 fps tiers', () => {
    render(<ConfigExportModal {...baseProps()} />);
    for (const q of ['720p', '1080p', '1440p', '2160p']) {
      expect(
        container.querySelector(`[data-testid="config-quality-${q}"]`),
      ).not.toBeNull();
    }
    for (const fps of [24, 30, 60]) {
      expect(
        container.querySelector(`[data-testid="config-fps-${fps}"]`),
      ).not.toBeNull();
    }
  });

  it('highlights the initial selection', () => {
    render(
      <ConfigExportModal
        {...baseProps()}
        initial={{ quality: '2160p', fps: 60 }}
      />,
    );
    const q = container.querySelector('[data-testid="config-quality-2160p"]')!;
    const fps = container.querySelector('[data-testid="config-fps-60"]')!;
    expect(q.getAttribute('aria-checked')).toBe('true');
    expect(fps.getAttribute('aria-checked')).toBe('true');
  });

  it('shows the crumb as "{aspect} · {channel}"', () => {
    render(
      <ConfigExportModal
        {...baseProps()}
        aspect="9_16"
        channel="video_only"
      />,
    );
    const crumb = container.querySelector('[data-testid="config-export-modal-crumb"]')!;
    expect(crumb.textContent).toContain('9:16');
    expect(crumb.textContent).toContain('Video only');
  });

  it('shows "Add export" CTA in add mode', () => {
    render(<ConfigExportModal {...baseProps()} mode="add" />);
    const save = container.querySelector('[data-testid="config-export-modal-save"]')!;
    expect(save.textContent).toBe('Add export');
  });

  it('shows "Save changes" CTA in edit mode', () => {
    render(<ConfigExportModal {...baseProps()} mode="edit" />);
    const save = container.querySelector('[data-testid="config-export-modal-save"]')!;
    expect(save.textContent).toBe('Save changes');
  });

  it('renders source-resolution and source-fps meta when provided', () => {
    render(
      <ConfigExportModal
        {...baseProps()}
        sourceResolution="3840×2160"
        sourceFps="30 fps"
      />,
    );
    expect(
      container.querySelector('[data-testid="config-quality-meta"]')?.textContent,
    ).toContain('3840×2160');
    expect(
      container.querySelector('[data-testid="config-fps-meta"]')?.textContent,
    ).toContain('30 fps');
  });

  it('omits source meta lines when not provided', () => {
    render(<ConfigExportModal {...baseProps()} />);
    expect(container.querySelector('[data-testid="config-quality-meta"]')).toBeNull();
    expect(container.querySelector('[data-testid="config-fps-meta"]')).toBeNull();
  });
});

describe('ConfigExportModal — selection', () => {
  it('updates the summary line when a quality button is clicked', () => {
    render(<ConfigExportModal {...baseProps()} />);
    const fourK = container.querySelector('[data-testid="config-quality-2160p"]')!;
    act(() => fireEvent.click(fourK));
    const summary = container.querySelector(
      '[data-testid="config-export-modal-summary"]',
    )!;
    expect(summary.textContent).toBe('4K · 30 fps');
  });

  it('updates the summary line when an fps button is clicked', () => {
    render(<ConfigExportModal {...baseProps()} />);
    const sixty = container.querySelector('[data-testid="config-fps-60"]')!;
    act(() => fireEvent.click(sixty));
    const summary = container.querySelector(
      '[data-testid="config-export-modal-summary"]',
    )!;
    expect(summary.textContent).toBe('1080 · 60 fps');
  });

  it('saves the current (quality, fps) when the primary button is clicked', () => {
    const onSave = vi.fn();
    render(<ConfigExportModal {...baseProps()} onSave={onSave} />);
    act(() =>
      fireEvent.click(container.querySelector('[data-testid="config-quality-2160p"]')!),
    );
    act(() =>
      fireEvent.click(container.querySelector('[data-testid="config-fps-60"]')!),
    );
    act(() =>
      fireEvent.click(
        container.querySelector('[data-testid="config-export-modal-save"]')!,
      ),
    );
    expect(onSave).toHaveBeenCalledWith({ quality: '2160p', fps: 60 });
  });

  it('resets local state to `initial` when re-opened', () => {
    // The modal is mounted with open=false → open=true → close → open again
    // with a different initial. The user's mid-stream edits in the first
    // session must NOT bleed into the second.
    function Harness() {
      const [open, setOpen] = useState(false);
      const [initial, setInitial] = useState({
        quality: '1080p' as OutputResolution,
        fps: 30 as ExportFps,
      });
      return (
        <>
          <button
            data-testid="open-a"
            onClick={() => {
              setInitial({ quality: '1080p', fps: 30 });
              setOpen(true);
            }}
          />
          <button
            data-testid="open-b"
            onClick={() => {
              setInitial({ quality: '2160p', fps: 60 });
              setOpen(true);
            }}
          />
          <ConfigExportModal
            {...baseProps()}
            open={open}
            initial={initial}
            onCancel={() => setOpen(false)}
          />
        </>
      );
    }
    render(<Harness />);
    act(() => fireEvent.click(container.querySelector('[data-testid="open-a"]')!));
    // User scrolls to 4K + 60 in this session
    act(() =>
      fireEvent.click(container.querySelector('[data-testid="config-quality-2160p"]')!),
    );
    act(() =>
      fireEvent.click(container.querySelector('[data-testid="config-fps-60"]')!),
    );
    // Cancel the modal and reopen with different initial
    act(() =>
      fireEvent.click(
        container.querySelector('[data-testid="config-export-modal-cancel"]')!,
      ),
    );
    act(() => fireEvent.click(container.querySelector('[data-testid="open-b"]')!));
    // Both axes should reflect the new initial, not the prior session's edits.
    expect(
      container
        .querySelector('[data-testid="config-quality-2160p"]')!
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      container
        .querySelector('[data-testid="config-fps-60"]')!
        .getAttribute('aria-checked'),
    ).toBe('true');
  });
});

describe('ConfigExportModal — disabled rules', () => {
  it('disables the quality buttons listed in disabledQualities and shows tooltip', () => {
    render(
      <ConfigExportModal
        {...baseProps()}
        disabledQualities={[
          { quality: '2160p', reason: 'Source 1920×1080 — would require upsample' },
          { quality: '1440p', reason: 'Source 1920×1080 — would require upsample' },
        ]}
      />,
    );
    const fourK = container.querySelector(
      '[data-testid="config-quality-2160p"]',
    ) as HTMLButtonElement;
    expect(fourK.disabled).toBe(true);
    expect(fourK.title).toBe('Source 1920×1080 — would require upsample');
  });

  it('disables the fps buttons listed in disabledFps', () => {
    render(
      <ConfigExportModal
        {...baseProps()}
        disabledFps={[{ fps: 60, reason: 'Source 30 fps' }]}
      />,
    );
    const sixty = container.querySelector(
      '[data-testid="config-fps-60"]',
    ) as HTMLButtonElement;
    expect(sixty.disabled).toBe(true);
    expect(sixty.title).toBe('Source 30 fps');
  });

  it('disables save when current selection conflicts with an existing chip (add mode)', () => {
    render(
      <ConfigExportModal
        {...baseProps()}
        conflictingCombos={[{ quality: '1080p', fps: 30 }]}
      />,
    );
    const save = container.querySelector(
      '[data-testid="config-export-modal-save"]',
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.title?.toLowerCase() ?? '').toContain('already in this cell');
  });

  it('enables save once the user changes one axis off the conflict', () => {
    render(
      <ConfigExportModal
        {...baseProps()}
        conflictingCombos={[{ quality: '1080p', fps: 30 }]}
      />,
    );
    // Conflict initially
    const save = container.querySelector(
      '[data-testid="config-export-modal-save"]',
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // User flips fps to 60 — no conflict on (1080p, 60)
    act(() =>
      fireEvent.click(container.querySelector('[data-testid="config-fps-60"]')!),
    );
    expect(save.disabled).toBe(false);
  });

  it('still allows save in edit mode when the chip currently re-equals its starting combo', () => {
    // Caller scopes conflictingCombos to add-mode → in edit mode this is `[]`.
    // The chip's own combo stays selectable. Pin that explicitly.
    render(
      <ConfigExportModal
        {...baseProps()}
        mode="edit"
        initial={{ quality: '1080p', fps: 30 }}
        conflictingCombos={[]}
      />,
    );
    const save = container.querySelector(
      '[data-testid="config-export-modal-save"]',
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });
});

describe('ConfigExportModal — cancel paths', () => {
  it('fires onCancel when the close (×) button is clicked', () => {
    const onCancel = vi.fn();
    render(<ConfigExportModal {...baseProps()} onCancel={onCancel} />);
    act(() =>
      fireEvent.click(
        container.querySelector('[data-testid="config-export-modal-close"]')!,
      ),
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('fires onCancel when the Cancel ghost button is clicked', () => {
    const onCancel = vi.fn();
    render(<ConfigExportModal {...baseProps()} onCancel={onCancel} />);
    act(() =>
      fireEvent.click(
        container.querySelector('[data-testid="config-export-modal-cancel"]')!,
      ),
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('fires onCancel when the backdrop is clicked', () => {
    const onCancel = vi.fn();
    render(<ConfigExportModal {...baseProps()} onCancel={onCancel} />);
    act(() =>
      fireEvent.click(
        container.querySelector('[data-testid="config-export-modal-backdrop"]')!,
      ),
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onCancel when clicking inside the modal body', () => {
    const onCancel = vi.fn();
    render(<ConfigExportModal {...baseProps()} onCancel={onCancel} />);
    act(() =>
      fireEvent.click(container.querySelector('[data-testid="config-export-modal"]')!),
    );
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('fires onCancel on Esc keydown when open', () => {
    const onCancel = vi.fn();
    render(<ConfigExportModal {...baseProps()} onCancel={onCancel} />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('configToInitial', () => {
  it('strips the id and returns just (quality, fps)', () => {
    const chip: ExportConfig = { id: 'abc', quality: '2160p', fps: 60 };
    expect(configToInitial(chip)).toEqual({ quality: '2160p', fps: 60 });
  });
});
