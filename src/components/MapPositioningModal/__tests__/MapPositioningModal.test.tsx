import { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { MapPositioningModal } from '../MapPositioningModal';
import {
  defaultLayout,
  defaultPipLayout,
  defaultSplitLayout,
  type AspectRatio,
  type LayoutConfig,
  type ProjectLayouts,
} from '../../../lib/layout';

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let originalRO: typeof globalThis.ResizeObserver | undefined;
let originalGetBCR: typeof Element.prototype.getBoundingClientRect;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  originalRO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  originalGetBCR = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 320,
      bottom: 320,
      width: 320,
      height: 320,
      toJSON: () => ({}),
    } as DOMRect;
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  if (originalRO) {
    globalThis.ResizeObserver = originalRO;
  } else {
    delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  }
  Element.prototype.getBoundingClientRect = originalGetBCR;
});

function render(node: React.ReactNode) {
  act(() => {
    root.render(node);
  });
}

function findByTestId(id: string): Element | null {
  return document.body.querySelector(`[data-testid="${id}"]`);
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function pressKey(key: string) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key }));
  });
}

function makeLayouts(): ProjectLayouts {
  return {
    '9_16': defaultPipLayout('9_16'),
    '4_5': defaultPipLayout('4_5'),
    '16_9': defaultPipLayout('16_9'),
  };
}

function noopProps(open: boolean) {
  return {
    open,
    onClose: () => {},
    layouts: makeLayouts(),
    onLayoutChange: () => {},
  };
}

describe('MapPositioningModal — chrome', () => {
  it('renders nothing when closed', () => {
    render(<MapPositioningModal {...noopProps(false)} />);
    expect(findByTestId('map-positioning-modal')).toBeNull();
  });

  it('renders header, close button, and body when open', () => {
    render(<MapPositioningModal {...noopProps(true)} />);
    const dialog = findByTestId('map-positioning-modal');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.querySelector('#map-positioning-modal-title')?.textContent).toContain(
      'Map Positioning',
    );
    expect(findByTestId('map-positioning-modal-close')).not.toBeNull();
    expect(findByTestId('map-positioning-modal-body')).not.toBeNull();
  });

  it('toggles in and out via the open prop', () => {
    render(<MapPositioningModal {...noopProps(false)} />);
    expect(findByTestId('map-positioning-modal')).toBeNull();
    render(<MapPositioningModal {...noopProps(true)} />);
    expect(findByTestId('map-positioning-modal')).not.toBeNull();
    render(<MapPositioningModal {...noopProps(false)} />);
    expect(findByTestId('map-positioning-modal')).toBeNull();
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <MapPositioningModal
        open={true}
        onClose={onClose}
        layouts={makeLayouts()}
        onLayoutChange={() => {}}
      />,
    );
    click(findByTestId('map-positioning-modal-close')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the backdrop is clicked', () => {
    const onClose = vi.fn();
    render(
      <MapPositioningModal
        open={true}
        onClose={onClose}
        layouts={makeLayouts()}
        onLayoutChange={() => {}}
      />,
    );
    click(findByTestId('map-positioning-modal-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose when clicks originate inside the dialog', () => {
    const onClose = vi.fn();
    render(
      <MapPositioningModal
        open={true}
        onClose={onClose}
        layouts={makeLayouts()}
        onLayoutChange={() => {}}
      />,
    );
    click(findByTestId('map-positioning-modal')!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when Escape is pressed while open (cancel)', () => {
    const onClose = vi.fn();
    const onLayoutChange = vi.fn();
    render(
      <MapPositioningModal
        open={true}
        onClose={onClose}
        layouts={makeLayouts()}
        onLayoutChange={onLayoutChange}
      />,
    );
    pressKey('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    // Cancel does NOT flush the draft to the parent.
    expect(onLayoutChange).not.toHaveBeenCalled();
  });

  it('does not handle Escape when closed', () => {
    const onClose = vi.fn();
    render(
      <MapPositioningModal
        open={false}
        onClose={onClose}
        layouts={makeLayouts()}
        onLayoutChange={() => {}}
      />,
    );
    pressKey('Escape');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('removes the keydown listener when closed or unmounted', () => {
    const onClose = vi.fn();
    render(
      <MapPositioningModal
        open={true}
        onClose={onClose}
        layouts={makeLayouts()}
        onLayoutChange={() => {}}
      />,
    );
    render(
      <MapPositioningModal
        open={false}
        onClose={onClose}
        layouts={makeLayouts()}
        onLayoutChange={() => {}}
      />,
    );
    pressKey('Escape');
    expect(onClose).not.toHaveBeenCalled();

    render(
      <MapPositioningModal
        open={true}
        onClose={onClose}
        layouts={makeLayouts()}
        onLayoutChange={() => {}}
      />,
    );
    act(() => root.unmount());
    pressKey('Escape');
    expect(onClose).not.toHaveBeenCalled();

    root = createRoot(container);
  });
});

describe('MapPositioningModal — triptych contents', () => {
  const aspects: AspectRatio[] = ['16_9', '4_5', '9_16'];

  it('renders one tile per aspect', () => {
    render(<MapPositioningModal {...noopProps(true)} />);
    for (const aspect of aspects) {
      expect(findByTestId(`map-positioning-pane-${aspect}`)).not.toBeNull();
    }
  });

  it('mounts a configurator only in the active tile (16:9 by default)', () => {
    // In the triptych design, the interactive configurator overlay lives in
    // the active tile only. Inactive tiles show the read-only LayoutPreview.
    // 16:9 is the default active ratio on open.
    render(<MapPositioningModal {...noopProps(true)} />);
    const configurators = document.body.querySelectorAll(
      '[data-testid="layout-configurator"]',
    );
    expect(configurators.length).toBe(1);
    const activeTile = findByTestId('map-positioning-pane-16_9');
    expect(activeTile?.contains(configurators[0])).toBe(true);
  });

  it('activates a different tile when clicked', () => {
    render(<MapPositioningModal {...noopProps(true)} />);
    const otherTile = findByTestId('map-positioning-pane-4_5') as HTMLElement;
    click(otherTile);
    expect(otherTile.getAttribute('data-active')).toBe('true');
    expect(
      findByTestId('map-positioning-pane-16_9')?.getAttribute('data-active'),
    ).toBe('false');
    // Configurator follows the active tile.
    const configurator = otherTile.querySelector('[data-testid="layout-configurator"]');
    expect(configurator).not.toBeNull();
  });

  it('falls back to defaultLayout when an aspect entry is null (tile still renders)', () => {
    // The pane mounts whether or not its layout is null. The fallback (default
    // layout) drives the LayoutPreview shown in that tile.
    const layouts: ProjectLayouts = {
      '9_16': null,
      '4_5': defaultPipLayout('4_5'),
      '16_9': defaultPipLayout('16_9'),
    };
    render(
      <MapPositioningModal
        open={true}
        onClose={() => {}}
        layouts={layouts}
        onLayoutChange={() => {}}
      />,
    );
    const pane = findByTestId('map-positioning-pane-9_16');
    expect(pane).not.toBeNull();
    // LayoutPreview is what inactive tiles render; presence of its svg root
    // proves the fallback path resolved a default layout.
    expect(pane?.querySelector('[data-testid="layout-preview-svg"]')).not.toBeNull();
  });
});

describe('MapPositioningModal — apply / cancel', () => {
  it('Apply button flushes draft and calls onClose', () => {
    const onClose = vi.fn();
    const onLayoutChange = vi.fn();
    const layouts = makeLayouts();
    render(
      <MapPositioningModal
        open={true}
        onClose={onClose}
        layouts={layouts}
        onLayoutChange={onLayoutChange}
      />,
    );
    click(findByTestId('map-positioning-apply')!);
    // Three non-null aspects flush one call each.
    expect(onLayoutChange).toHaveBeenCalledTimes(3);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Cancel button discards the draft (no onLayoutChange)', () => {
    const onClose = vi.fn();
    const onLayoutChange = vi.fn();
    render(
      <MapPositioningModal
        open={true}
        onClose={onClose}
        layouts={makeLayouts()}
        onLayoutChange={onLayoutChange}
      />,
    );
    // Make an edit via the rail's split mode card, then cancel.
    click(findByTestId('rail-mode-split')!);
    click(findByTestId('map-positioning-cancel')!);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onLayoutChange).not.toHaveBeenCalled();
  });

  it('Enter applies; Escape cancels', () => {
    const onClose = vi.fn();
    const onLayoutChange = vi.fn();
    render(
      <MapPositioningModal
        open={true}
        onClose={onClose}
        layouts={makeLayouts()}
        onLayoutChange={onLayoutChange}
      />,
    );
    pressKey('Enter');
    expect(onLayoutChange).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);

    // Reset for second phase.
    onLayoutChange.mockClear();
    onClose.mockClear();
    render(
      <MapPositioningModal
        open={true}
        onClose={onClose}
        layouts={makeLayouts()}
        onLayoutChange={onLayoutChange}
      />,
    );
    pressKey('Escape');
    expect(onLayoutChange).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('MapPositioningModal — keyboard & rail', () => {
  it('1, 2, 3 keys switch the active ratio', () => {
    render(<MapPositioningModal {...noopProps(true)} />);
    pressKey('2');
    expect(
      findByTestId('map-positioning-pane-4_5')?.getAttribute('data-active'),
    ).toBe('true');
    pressKey('3');
    expect(
      findByTestId('map-positioning-pane-9_16')?.getAttribute('data-active'),
    ).toBe('true');
    pressKey('1');
    expect(
      findByTestId('map-positioning-pane-16_9')?.getAttribute('data-active'),
    ).toBe('true');
  });

  it('rail mode card changes the active ratio on Apply', () => {
    const onLayoutChange = vi.fn();
    render(
      <MapPositioningModal
        open={true}
        onClose={() => {}}
        layouts={makeLayouts()}
        onLayoutChange={onLayoutChange}
      />,
    );
    // Activate 4:5 and switch to Split.
    pressKey('2');
    click(findByTestId('rail-mode-split')!);
    click(findByTestId('map-positioning-apply')!);
    // Apply flushes all three aspects. The 4:5 entry should now be split.
    const calls = onLayoutChange.mock.calls as [AspectRatio, LayoutConfig][];
    const splitCall = calls.find(([, next]) => next.mode === 'split');
    expect(splitCall).toBeDefined();
    expect(splitCall![0]).toBe('4_5');
    expect(splitCall![1]).toEqual(defaultSplitLayout('4_5'));
  });

  it('rail reset for the active ratio restores the seeded default on Apply', () => {
    const onLayoutChange = vi.fn();
    const layouts = makeLayouts();
    const mutated: LayoutConfig = {
      ...defaultPipLayout('16_9'),
      inset: { x: 0.05, y: 0.05, w: 0.5, h: 0.5 },
    };
    layouts['16_9'] = mutated;
    render(
      <MapPositioningModal
        open={true}
        onClose={() => {}}
        layouts={layouts}
        onLayoutChange={onLayoutChange}
      />,
    );
    // 16:9 is the default active ratio, so the rail's Reset is bound to it.
    click(findByTestId('map-positioning-reset-16_9')!);
    click(findByTestId('map-positioning-apply')!);
    const calls = onLayoutChange.mock.calls as [AspectRatio, LayoutConfig][];
    const reset16 = calls.find(([aspect]) => aspect === '16_9');
    expect(reset16).toBeDefined();
    expect(reset16![1]).toEqual(defaultLayout('16_9'));
  });

  it('Reset all replaces draft for every ratio on Apply', () => {
    const onLayoutChange = vi.fn();
    const layouts = makeLayouts();
    layouts['16_9'] = {
      ...defaultPipLayout('16_9'),
      inset: { x: 0.05, y: 0.05, w: 0.5, h: 0.5 },
    };
    render(
      <MapPositioningModal
        open={true}
        onClose={() => {}}
        layouts={layouts}
        onLayoutChange={onLayoutChange}
      />,
    );
    click(findByTestId('map-positioning-reset-all')!);
    click(findByTestId('map-positioning-apply')!);
    const calls = onLayoutChange.mock.calls as [AspectRatio, LayoutConfig][];
    for (const aspect of ['16_9', '4_5', '9_16'] as const) {
      const call = calls.find(([a]) => a === aspect);
      expect(call).toBeDefined();
      expect(call![1]).toEqual(defaultLayout(aspect));
    }
  });

  it('Copy-from action seeds the active ratio with another ratio\'s layout', () => {
    const onLayoutChange = vi.fn();
    const layouts = makeLayouts();
    // Distinct layouts on 4:5 so we can verify the copy.
    layouts['4_5'] = defaultSplitLayout('4_5');
    render(
      <MapPositioningModal
        open={true}
        onClose={() => {}}
        layouts={layouts}
        onLayoutChange={onLayoutChange}
      />,
    );
    // 16:9 is active by default. Copy from 4:5 → 16:9 should swap 16:9 into
    // split mode.
    click(findByTestId('rail-copy-from-4_5')!);
    click(findByTestId('map-positioning-apply')!);
    const calls = onLayoutChange.mock.calls as [AspectRatio, LayoutConfig][];
    const c16 = calls.find(([a]) => a === '16_9');
    expect(c16).toBeDefined();
    expect(c16![1].mode).toBe('split');
  });
});

describe('MapPositioningModal — sync toggles', () => {
  it('sync mode propagates a mode change to all ratios on Apply', () => {
    const onLayoutChange = vi.fn();
    render(
      <MapPositioningModal
        open={true}
        onClose={() => {}}
        layouts={makeLayouts()}
        onLayoutChange={onLayoutChange}
      />,
    );
    // Turn Sync mode on, then switch the active (16:9) to Split.
    click(findByTestId('map-positioning-sync-mode')!);
    click(findByTestId('rail-mode-split')!);
    click(findByTestId('map-positioning-apply')!);
    const calls = onLayoutChange.mock.calls as [AspectRatio, LayoutConfig][];
    // All three aspects flush with mode='split'.
    for (const aspect of ['16_9', '4_5', '9_16'] as const) {
      const call = calls.find(([a]) => a === aspect);
      expect(call?.[1].mode).toBe('split');
    }
  });

  it('without sync, mode change only affects the active ratio', () => {
    const onLayoutChange = vi.fn();
    render(
      <MapPositioningModal
        open={true}
        onClose={() => {}}
        layouts={makeLayouts()}
        onLayoutChange={onLayoutChange}
      />,
    );
    click(findByTestId('rail-mode-split')!);
    click(findByTestId('map-positioning-apply')!);
    const calls = onLayoutChange.mock.calls as [AspectRatio, LayoutConfig][];
    const c16 = calls.find(([a]) => a === '16_9');
    const c45 = calls.find(([a]) => a === '4_5');
    expect(c16?.[1].mode).toBe('split');
    expect(c45?.[1].mode).toBe('pip'); // untouched
  });
});
