import { act, useState } from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/react';
import { ExportModal } from '../ExportModal';
import type {
  AspectRatio,
  ExportChannel,
  ExportSelection,
} from '../../../types';

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

function findByTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

interface HarnessProps {
  initialOpen: boolean;
  initialSelection?: ExportSelection;
  onCloseExtra?: () => void;
}

function Harness({ initialOpen, initialSelection, onCloseExtra }: HarnessProps) {
  const [open, setOpen] = useState(initialOpen);
  const [selection, setSelection] = useState<ExportSelection>(
    initialSelection ?? { aspects: [], channels: [] },
  );
  return (
    <ExportModal
      open={open}
      onClose={() => {
        setOpen(false);
        onCloseExtra?.();
      }}
      selection={selection}
      onSelectionChange={setSelection}
    />
  );
}

describe('ExportModal', () => {
  it('renders nothing when open=false', () => {
    render(<Harness initialOpen={false} />);
    expect(findByTestId('export-modal')).toBeNull();
  });

  it('renders dialog and core sections when open', () => {
    render(<Harness initialOpen={true} />);
    expect(findByTestId('export-modal')).not.toBeNull();
    expect(findByTestId('export-aspect-9_16')).not.toBeNull();
    expect(findByTestId('export-aspect-4_5')).not.toBeNull();
    expect(findByTestId('export-aspect-16_9')).not.toBeNull();
    expect(findByTestId('export-channel-composite')).not.toBeNull();
    expect(findByTestId('export-channel-map_only')).not.toBeNull();
    expect(findByTestId('export-channel-video_only')).not.toBeNull();
    expect(findByTestId('export-job-summary')).not.toBeNull();
    expect(findByTestId('export-output-folder')).not.toBeNull();
  });

  it('renders Render button disabled with the spec tooltip', () => {
    render(<Harness initialOpen={true} />);
    const btn = findByTestId('export-modal-render') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('title')).toBe(
      'Select aspects, channels, and folder to enable Render',
    );
  });

  it('toggling an aspect checkbox updates selection and summary', () => {
    render(<Harness initialOpen={true} />);
    const cb = findByTestId('export-aspect-9_16') as HTMLInputElement;
    expect(cb.checked).toBe(false);
    act(() => {
      fireEvent.click(cb);
    });
    expect((findByTestId('export-aspect-9_16') as HTMLInputElement).checked).toBe(true);
    const summary = findByTestId('export-job-summary');
    expect(summary?.textContent ?? '').toContain('0 files');

    act(() => {
      fireEvent.click(findByTestId('export-channel-composite') as HTMLInputElement);
    });
    expect(findByTestId('export-job-summary')?.textContent ?? '').toContain(
      '1 file:',
    );
    expect(findByTestId('export-job-summary')?.textContent ?? '').toContain(
      '9:16 composite',
    );
  });

  it('selecting all aspects × all channels yields 9 files in summary', () => {
    const aspects: AspectRatio[] = ['9_16', '4_5', '16_9'];
    const channels: ExportChannel[] = ['composite', 'map_only', 'video_only'];
    render(
      <Harness
        initialOpen={true}
        initialSelection={{ aspects, channels }}
      />,
    );
    expect(findByTestId('export-job-summary')?.textContent ?? '').toContain(
      '9 files',
    );
  });

  it('renders one schematic per selected channel', () => {
    render(
      <Harness
        initialOpen={true}
        initialSelection={{
          aspects: ['9_16'],
          channels: ['composite', 'map_only'],
        }}
      />,
    );
    expect(findByTestId('channel-schematic-composite')).not.toBeNull();
    expect(findByTestId('channel-schematic-map_only')).not.toBeNull();
    expect(findByTestId('channel-schematic-video_only')).toBeNull();
  });

  it('Cancel button closes the modal', () => {
    render(<Harness initialOpen={true} />);
    expect(findByTestId('export-modal')).not.toBeNull();
    act(() => {
      fireEvent.click(findByTestId('export-modal-cancel') as HTMLButtonElement);
    });
    expect(findByTestId('export-modal')).toBeNull();
  });

  it('backdrop click closes the modal', () => {
    render(<Harness initialOpen={true} />);
    act(() => {
      fireEvent.click(findByTestId('export-modal-backdrop') as HTMLElement);
    });
    expect(findByTestId('export-modal')).toBeNull();
  });

  it('clicking inside the modal does not close it', () => {
    render(<Harness initialOpen={true} />);
    const dialog = findByTestId('export-modal') as HTMLElement;
    act(() => {
      fireEvent.click(dialog);
    });
    expect(findByTestId('export-modal')).not.toBeNull();
  });

  it('Escape key closes the modal', () => {
    render(<Harness initialOpen={true} />);
    expect(findByTestId('export-modal')).not.toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(findByTestId('export-modal')).toBeNull();
  });

  it('selection round-trip: unchecking removes from selection', () => {
    render(
      <Harness
        initialOpen={true}
        initialSelection={{ aspects: ['9_16', '4_5'], channels: ['composite'] }}
      />,
    );
    expect(findByTestId('export-job-summary')?.textContent ?? '').toContain(
      '2 files',
    );
    act(() => {
      fireEvent.click(findByTestId('export-aspect-9_16') as HTMLInputElement);
    });
    expect(findByTestId('export-job-summary')?.textContent ?? '').toContain(
      '1 file:',
    );
    expect(
      (findByTestId('export-aspect-9_16') as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (findByTestId('export-aspect-4_5') as HTMLInputElement).checked,
    ).toBe(true);
  });
});
