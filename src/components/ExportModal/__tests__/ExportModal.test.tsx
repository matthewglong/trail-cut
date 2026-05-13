import { act, useState } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/react';
import { ExportModal } from '../ExportModal';
import type {
  Clip,
  ExportGrid,
  MapSettings,
  ProjectLayouts,
  Route,
  TransitionFeel,
} from '../../../types';
import { DEFAULT_MAP_SETTINGS } from '../../../types';
import { defaultLayout } from '../../../lib/layout';

const dialogOpenMock = vi.fn();
const askMock = vi.fn();
const existsMock = vi.fn();
const invokeMock = vi.fn();
const revealMock = vi.fn();

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => dialogOpenMock(...args),
  ask: (...args: unknown[]) => askMock(...args),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: (...args: unknown[]) => existsMock(...args),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  revealItemInDir: (...args: unknown[]) => revealMock(...args),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  dialogOpenMock.mockReset();
  askMock.mockReset();
  existsMock.mockReset();
  invokeMock.mockReset();
  revealMock.mockReset();
  existsMock.mockResolvedValue(false);
  invokeMock.mockResolvedValue({
    frames_written: 1,
    output_path: '/out/x',
    wall_clock_ms: 1,
  });
  revealMock.mockResolvedValue(undefined);
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

function defaultProjectLayouts(): ProjectLayouts {
  return {
    '9_16': defaultLayout('9_16'),
    '4_5': defaultLayout('4_5'),
    '16_9': defaultLayout('16_9'),
  };
}

const EMPTY_GRID: ExportGrid = { cells: {}, output_dir: null };

interface HarnessProps {
  initialOpen: boolean;
  initialSelection?: ExportGrid;
  projectName?: string;
  onCloseExtra?: () => void;
  clips?: Clip[];
  route?: Route | null;
  mapSettings?: MapSettings;
  transitionFeel?: TransitionFeel;
  projectLayouts?: ProjectLayouts;
  lastExportSelection?: ExportGrid | null;
  onSelectionPersist?: (selection: ExportGrid) => void;
}

function Harness({
  initialOpen,
  initialSelection,
  projectName,
  onCloseExtra,
  clips,
  route,
  mapSettings,
  transitionFeel,
  projectLayouts,
  lastExportSelection,
  onSelectionPersist,
}: HarnessProps) {
  const [open, setOpen] = useState(initialOpen);
  const [selection, setSelection] = useState<ExportGrid>(
    initialSelection ?? EMPTY_GRID,
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
      lastExportSelection={lastExportSelection}
      onSelectionPersist={onSelectionPersist}
      projectName={projectName ?? 'Hike2026'}
      clips={clips ?? []}
      route={route ?? null}
      mapSettings={mapSettings ?? DEFAULT_MAP_SETTINGS}
      transitionFeel={transitionFeel}
      projectLayouts={projectLayouts ?? defaultProjectLayouts()}
    />
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('ExportModal — lifecycle', () => {
  it('renders nothing when open=false', () => {
    render(<Harness initialOpen={false} />);
    expect(findByTestId('export-modal')).toBeNull();
  });

  it('renders dialog and folder-picker when open', () => {
    render(<Harness initialOpen={true} />);
    expect(findByTestId('export-modal')).not.toBeNull();
    expect(findByTestId('export-output-folder')).not.toBeNull();
    expect(findByTestId('export-output-folder-choose')).not.toBeNull();
  });

  it('Render disabled with no chips configured', () => {
    render(<Harness initialOpen={true} />);
    const btn = findByTestId('export-modal-render') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
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
});

describe('ExportModal — folder picker', () => {
  it('shows "No folder selected" placeholder until a folder is picked', () => {
    render(<Harness initialOpen={true} />);
    expect(findByTestId('export-output-folder-path')).toBeNull();
    expect(findByTestId('export-output-folder')?.textContent ?? '').toContain(
      'No folder selected',
    );
  });

  it('chosen folder path appears after picker resolves with a string', async () => {
    dialogOpenMock.mockResolvedValue('/Users/u/Movies');
    render(<Harness initialOpen={true} />);
    act(() => {
      fireEvent.click(findByTestId('export-output-folder-choose') as HTMLButtonElement);
    });
    await flush();
    expect(dialogOpenMock).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
    });
    expect(findByTestId('export-output-folder-path')?.textContent).toBe(
      '/Users/u/Movies',
    );
  });

  it('uses first entry when picker resolves with an array', async () => {
    dialogOpenMock.mockResolvedValue(['/A', '/B']);
    render(<Harness initialOpen={true} />);
    act(() => {
      fireEvent.click(findByTestId('export-output-folder-choose') as HTMLButtonElement);
    });
    await flush();
    expect(findByTestId('export-output-folder-path')?.textContent).toBe('/A');
  });

  it('leaves folder unset when picker resolves with null (user cancels)', async () => {
    dialogOpenMock.mockResolvedValue(null);
    render(<Harness initialOpen={true} />);
    act(() => {
      fireEvent.click(findByTestId('export-output-folder-choose') as HTMLButtonElement);
    });
    await flush();
    expect(findByTestId('export-output-folder-path')).toBeNull();
  });

  it('leaves folder unset when picker rejects', async () => {
    dialogOpenMock.mockRejectedValue(new Error('cancelled'));
    render(<Harness initialOpen={true} />);
    act(() => {
      fireEvent.click(findByTestId('export-output-folder-choose') as HTMLButtonElement);
    });
    await flush();
    expect(findByTestId('export-output-folder-path')).toBeNull();
  });
});

describe('ExportModal — prefill on open transition', () => {
  function ToggleHarness({
    initialOpen,
    lastExportSelection,
  }: {
    initialOpen: boolean;
    lastExportSelection?: ExportGrid | null;
  }) {
    const [open, setOpen] = useState(initialOpen);
    const [selection, setSelection] = useState<ExportGrid>(EMPTY_GRID);
    return (
      <>
        <button data-testid="toggle-open" onClick={() => setOpen((v) => !v)}>
          toggle
        </button>
        <ExportModal
          open={open}
          onClose={() => setOpen(false)}
          selection={selection}
          onSelectionChange={setSelection}
          lastExportSelection={lastExportSelection}
          projectName="Hike2026"
          clips={[]}
          route={null}
          mapSettings={DEFAULT_MAP_SETTINGS}
          projectLayouts={defaultProjectLayouts()}
        />
      </>
    );
  }

  it('rehydrates output_dir from lastExportSelection on false → true', () => {
    const last: ExportGrid = {
      cells: { '9_16-composite': [{ id: 'a', quality: '1080p', fps: 30 }] },
      output_dir: '/Users/u/PriorExports',
    };
    render(<ToggleHarness initialOpen={false} lastExportSelection={last} />);
    expect(findByTestId('export-modal')).toBeNull();
    act(() => {
      fireEvent.click(findByTestId('toggle-open') as HTMLButtonElement);
    });
    expect(findByTestId('export-output-folder-path')?.textContent).toBe(
      '/Users/u/PriorExports',
    );
  });

  it('rehydrates empty grid when lastExportSelection is null', () => {
    render(<ToggleHarness initialOpen={false} lastExportSelection={null} />);
    act(() => {
      fireEvent.click(findByTestId('toggle-open') as HTMLButtonElement);
    });
    expect(findByTestId('export-output-folder-path')).toBeNull();
  });
});

describe('ExportModal — render flow', () => {
  function makeClip(): Clip {
    return {
      id: 'c1',
      path: '/tmp/c1.mov',
      filename: 'c1.mov',
      created_at: '2026-01-01T00:00:00Z',
      duration_ms: 60_000,
      gps: null,
      resolution: '1920x1080',
      frame_rate: 30,
      trim: { in_ms: 0, out_ms: 60_000 },
      focal_point: { x: 0.5, y: 0.5, zoom: 1 },
      effects: { stabilize: { enabled: false, shakiness: 5 }, speed: 1 },
      visible: true,
      map_overrides: null,
    };
  }

  function configuredGrid(outputDir: string): ExportGrid {
    return {
      cells: { '9_16-composite': [{ id: 'cfg1', quality: '1080p', fps: 30 }] },
      output_dir: outputDir,
    };
  }

  it('Render-button enables when a chip and folder are present', () => {
    render(
      <Harness
        initialOpen={true}
        initialSelection={configuredGrid('/out')}
        clips={[makeClip()]}
      />,
    );
    const btn = findByTestId('export-modal-render') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent ?? '').toContain('Render 1 file');
  });

  it('starts the queue when render is clicked with no collisions', async () => {
    render(
      <Harness
        initialOpen={true}
        initialSelection={configuredGrid('/out')}
        clips={[makeClip()]}
      />,
    );
    existsMock.mockResolvedValue(false);
    act(() => {
      fireEvent.click(findByTestId('export-modal-render') as HTMLButtonElement);
    });
    await flush();
    await flush();
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('asks for overwrite confirmation when output file exists', async () => {
    render(
      <Harness
        initialOpen={true}
        initialSelection={configuredGrid('/out')}
        clips={[makeClip()]}
      />,
    );
    existsMock.mockResolvedValue(true);
    askMock.mockResolvedValue(true);
    act(() => {
      fireEvent.click(findByTestId('export-modal-render') as HTMLButtonElement);
    });
    await flush();
    await flush();
    await flush();
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalled();
  });

  it('aborts the queue when user declines overwrite confirmation', async () => {
    render(
      <Harness
        initialOpen={true}
        initialSelection={configuredGrid('/out')}
        clips={[makeClip()]}
      />,
    );
    existsMock.mockResolvedValue(true);
    askMock.mockResolvedValue(false);
    act(() => {
      fireEvent.click(findByTestId('export-modal-render') as HTMLButtonElement);
    });
    await flush();
    await flush();
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('fires onSelectionPersist once when queue completes with at least one done job', async () => {
    const persist = vi.fn();
    const grid = configuredGrid('/out');
    render(
      <Harness
        initialOpen={true}
        initialSelection={grid}
        clips={[makeClip()]}
        onSelectionPersist={persist}
      />,
    );
    act(() => {
      fireEvent.click(findByTestId('export-modal-render') as HTMLButtonElement);
    });
    await flush();
    await flush();
    await flush();
    await flush();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(grid);
  });

  it('does NOT fire onSelectionPersist when queue ends with zero done jobs', async () => {
    const persist = vi.fn();
    invokeMock.mockReset();
    invokeMock.mockRejectedValue('forced failure');
    render(
      <Harness
        initialOpen={true}
        initialSelection={configuredGrid('/out')}
        clips={[makeClip()]}
        onSelectionPersist={persist}
      />,
    );
    act(() => {
      fireEvent.click(findByTestId('export-modal-render') as HTMLButtonElement);
    });
    await flush();
    await flush();
    await flush();
    await flush();
    expect(persist).not.toHaveBeenCalled();
  });
});
