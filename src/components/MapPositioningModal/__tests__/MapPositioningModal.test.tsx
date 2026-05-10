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
    const closeBtn = findByTestId('map-positioning-modal-close') as HTMLButtonElement;
    act(() => {
      closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
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
    const backdrop = findByTestId('map-positioning-modal-backdrop') as HTMLDivElement;
    act(() => {
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
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
    const dialog = findByTestId('map-positioning-modal') as HTMLDivElement;
    act(() => {
      dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when Escape is pressed while open', () => {
    const onClose = vi.fn();
    render(
      <MapPositioningModal
        open={true}
        onClose={onClose}
        layouts={makeLayouts()}
        onLayoutChange={() => {}}
      />,
    );
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
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
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
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
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
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
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).not.toHaveBeenCalled();

    root = createRoot(container);
  });
});

describe('MapPositioningModal — contents', () => {
  const aspects: AspectRatio[] = ['16_9', '4_5', '9_16'];

  it('renders one pane per aspect', () => {
    render(<MapPositioningModal {...noopProps(true)} />);
    for (const aspect of aspects) {
      const pane = findByTestId(`map-positioning-pane-${aspect}`);
      expect(pane).not.toBeNull();
    }
  });

  it('mounts a configurator inside each pane once measured', () => {
    render(<MapPositioningModal {...noopProps(true)} />);
    const configurators = document.body.querySelectorAll(
      '[data-testid="layout-configurator"]',
    );
    expect(configurators.length).toBe(3);
  });

  it('reset button restores the seeded default for that aspect', () => {
    const layouts = makeLayouts();
    const mutated: LayoutConfig = {
      ...defaultPipLayout('16_9'),
      inset: { x: 0.05, y: 0.05, w: 0.5, h: 0.5 },
    };
    layouts['16_9'] = mutated;
    const onLayoutChange = vi.fn();
    render(
      <MapPositioningModal
        open={true}
        onClose={() => {}}
        layouts={layouts}
        onLayoutChange={onLayoutChange}
      />,
    );
    const resetBtn = findByTestId('map-positioning-reset-16_9') as HTMLButtonElement;
    act(() => {
      resetBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onLayoutChange).toHaveBeenCalledTimes(1);
    expect(onLayoutChange).toHaveBeenCalledWith('16_9', defaultLayout('16_9'));
  });

  it('mode toggle inside a pane emits onLayoutChange for that aspect only', () => {
    const layouts = makeLayouts();
    const onLayoutChange = vi.fn();
    render(
      <MapPositioningModal
        open={true}
        onClose={() => {}}
        layouts={layouts}
        onLayoutChange={onLayoutChange}
      />,
    );
    const pane = findByTestId('map-positioning-pane-4_5') as HTMLElement;
    const splitBtn = pane.querySelector(
      '[data-testid="layout-configurator-mode-split"]',
    ) as HTMLButtonElement;
    expect(splitBtn).not.toBeNull();
    act(() => {
      splitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onLayoutChange).toHaveBeenCalledTimes(1);
    const [aspect, next] = onLayoutChange.mock.calls[0];
    expect(aspect).toBe('4_5');
    expect(next.mode).toBe('split');
    expect(next).toEqual(defaultSplitLayout('4_5'));
  });

  it('falls back to defaultLayout when an aspect entry is null', () => {
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
    const configurator = pane?.querySelector('[data-testid="layout-configurator"]');
    expect(configurator).not.toBeNull();
  });
});
