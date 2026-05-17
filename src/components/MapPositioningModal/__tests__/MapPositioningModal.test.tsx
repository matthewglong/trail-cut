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

  it('calls onClose when Escape is pressed while open', () => {
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
    // Closing the modal is not itself a layout edit.
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

  it('mounts a configurator in every tile (each pane is independently editable)', () => {
    render(<MapPositioningModal {...noopProps(true)} />);
    const configurators = document.body.querySelectorAll(
      '[data-testid="layout-configurator"]',
    );
    expect(configurators.length).toBe(3);
    for (const aspect of aspects) {
      const pane = findByTestId(`map-positioning-pane-${aspect}`);
      expect(pane?.querySelector('[data-testid="layout-configurator"]')).not.toBeNull();
    }
  });

  it('falls back to defaultLayout when an aspect entry is null (tile still renders)', () => {
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
    expect(pane?.querySelector('[data-testid="layout-preview-svg"]')).not.toBeNull();
  });
});

describe('MapPositioningModal — live edits', () => {
  it('tile mode pill propagates that tile\'s change immediately, without touching others', () => {
    const onLayoutChange = vi.fn();
    render(
      <MapPositioningModal
        open={true}
        onClose={() => {}}
        layouts={makeLayouts()}
        onLayoutChange={onLayoutChange}
      />,
    );
    click(findByTestId('tile-4_5-mode-split')!);
    const calls = onLayoutChange.mock.calls as [AspectRatio, LayoutConfig][];
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe('4_5');
    expect(calls[0][1].mode).toBe('split');
    expect(calls[0][1]).toEqual(defaultSplitLayout('4_5'));
  });

  it('tile reset immediately propagates the default for that ratio', () => {
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
    click(findByTestId('map-positioning-reset-16_9')!);
    const calls = onLayoutChange.mock.calls as [AspectRatio, LayoutConfig][];
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe('16_9');
    expect(calls[0][1]).toEqual(defaultLayout('16_9'));
  });

  it('parks each tile\'s chrome at the corner picked by assignChromeCorners', () => {
    // Two contrasting layouts: top-left inset (pushes ratio off tl) and the
    // default 9:16 bottom-right inset (pushes reset off br). The mocked
    // getBoundingClientRect in beforeEach returns 320×320 for every node, so
    // the corner-placement math runs with that container size for every tile.
    const layouts: ProjectLayouts = {
      '16_9': { ...defaultPipLayout('16_9'), inset: { x: 0.04, y: 0.04, w: 0.35, h: 0.30 } },
      '4_5': defaultPipLayout('4_5'),
      '9_16': defaultPipLayout('9_16'),
    };
    render(
      <MapPositioningModal
        open={true}
        onClose={() => {}}
        layouts={layouts}
        onLayoutChange={() => {}}
      />,
    );

    // 16:9 has a top-left inset → ratio's default tl is dangerous; it falls
    // to bl. modePill stays at tr, reset stays at br.
    expect(findByTestId('tile-16_9-ratio')?.getAttribute('data-corner')).toBe('bl');
    expect(findByTestId('tile-16_9-modepill')?.getAttribute('data-corner')).toBe('tr');
    expect(findByTestId('tile-16_9-reset')?.getAttribute('data-corner')).toBe('br');

    // 9:16 has the default bottom-right inset → reset's default br is
    // dangerous; it falls to bl. ratio at tl, modePill at tr.
    expect(findByTestId('tile-9_16-ratio')?.getAttribute('data-corner')).toBe('tl');
    expect(findByTestId('tile-9_16-modepill')?.getAttribute('data-corner')).toBe('tr');
    expect(findByTestId('tile-9_16-reset')?.getAttribute('data-corner')).toBe('bl');
  });

  it('clicking a tile control does not call onClose', () => {
    const onClose = vi.fn();
    render(
      <MapPositioningModal
        open={true}
        onClose={onClose}
        layouts={makeLayouts()}
        onLayoutChange={() => {}}
      />,
    );
    click(findByTestId('tile-16_9-mode-split')!);
    expect(onClose).not.toHaveBeenCalled();
  });
});
