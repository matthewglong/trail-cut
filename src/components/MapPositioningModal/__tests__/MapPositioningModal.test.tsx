import { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { MapPositioningModal } from '../MapPositioningModal';

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
  document.body.innerHTML = '';
});

function render(node: React.ReactNode) {
  act(() => {
    root.render(node);
  });
}

function findByTestId(id: string): Element | null {
  return document.body.querySelector(`[data-testid="${id}"]`);
}

describe('MapPositioningModal', () => {
  it('renders nothing when closed', () => {
    render(<MapPositioningModal open={false} onClose={() => {}} />);
    expect(findByTestId('map-positioning-modal')).toBeNull();
  });

  it('renders header, close button, and placeholder body when open', () => {
    render(<MapPositioningModal open={true} onClose={() => {}} />);
    const dialog = findByTestId('map-positioning-modal');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.querySelector('#map-positioning-modal-title')?.textContent).toContain(
      'Map Positioning',
    );
    expect(findByTestId('map-positioning-modal-close')).not.toBeNull();
    expect(findByTestId('map-positioning-modal-body')?.textContent).toContain('210');
  });

  it('toggles in and out via the open prop', () => {
    render(<MapPositioningModal open={false} onClose={() => {}} />);
    expect(findByTestId('map-positioning-modal')).toBeNull();
    render(<MapPositioningModal open={true} onClose={() => {}} />);
    expect(findByTestId('map-positioning-modal')).not.toBeNull();
    render(<MapPositioningModal open={false} onClose={() => {}} />);
    expect(findByTestId('map-positioning-modal')).toBeNull();
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<MapPositioningModal open={true} onClose={onClose} />);
    const closeBtn = findByTestId('map-positioning-modal-close') as HTMLButtonElement;
    act(() => {
      closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<MapPositioningModal open={true} onClose={onClose} />);
    const backdrop = findByTestId('map-positioning-modal-backdrop') as HTMLDivElement;
    act(() => {
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose when clicks originate inside the dialog', () => {
    const onClose = vi.fn();
    render(<MapPositioningModal open={true} onClose={onClose} />);
    const dialog = findByTestId('map-positioning-modal') as HTMLDivElement;
    act(() => {
      dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when Escape is pressed while open', () => {
    const onClose = vi.fn();
    render(<MapPositioningModal open={true} onClose={onClose} />);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not handle Escape when closed', () => {
    const onClose = vi.fn();
    render(<MapPositioningModal open={false} onClose={onClose} />);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('removes the keydown listener when closed or unmounted', () => {
    const onClose = vi.fn();
    render(<MapPositioningModal open={true} onClose={onClose} />);
    render(<MapPositioningModal open={false} onClose={onClose} />);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).not.toHaveBeenCalled();

    render(<MapPositioningModal open={true} onClose={onClose} />);
    act(() => root.unmount());
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).not.toHaveBeenCalled();

    // Re-create root for the afterEach unmount.
    root = createRoot(container);
  });
});
