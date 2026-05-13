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
const videoDirMock = vi.fn();
const joinMock = vi.fn();

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

vi.mock('@tauri-apps/api/path', () => ({
  videoDir: (...args: unknown[]) => videoDirMock(...args),
  join: (...args: unknown[]) => joinMock(...args),
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
  videoDirMock.mockReset();
  joinMock.mockReset();
  existsMock.mockResolvedValue(false);
  // Default invoke handler — dispatches by command name. Render-export keeps
  // the prior fake result; resolve_output_dir returns a deterministic path
  // so the auto-default effect lands somewhere predictable in tests that
  // exercise it (and is harmless for the rest).
  invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'resolve_output_dir') {
      return `${(args as { base: string }).base}/${(args as { name: string }).name}`;
    }
    return { frames_written: 1, output_path: '/out/x', wall_clock_ms: 1 };
  });
  revealMock.mockResolvedValue(undefined);
  videoDirMock.mockResolvedValue('/Users/u/Movies');
  joinMock.mockImplementation(async (...parts: string[]) => parts.join('/'));
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

  it('leaves prior folder intact when picker resolves with null (user cancels)', async () => {
    // The auto-default resolves the folder on modal open, so a null/undefined
    // pick from the dialog must not roll back to "no folder" — it should
    // leave the prior value (auto-default, prefill, or user-chosen) intact.
    dialogOpenMock.mockResolvedValue(null);
    render(<Harness initialOpen={true} />);
    await flush(); // let auto-default resolve
    const before = findByTestId('export-output-folder-path')?.textContent;
    expect(before).toBeDefined();
    act(() => {
      fireEvent.click(findByTestId('export-output-folder-choose') as HTMLButtonElement);
    });
    await flush();
    expect(findByTestId('export-output-folder-path')?.textContent).toBe(before);
  });

  it('leaves prior folder intact when picker rejects', async () => {
    dialogOpenMock.mockRejectedValue(new Error('cancelled'));
    render(<Harness initialOpen={true} />);
    await flush();
    const before = findByTestId('export-output-folder-path')?.textContent;
    expect(before).toBeDefined();
    act(() => {
      fireEvent.click(findByTestId('export-output-folder-choose') as HTMLButtonElement);
    });
    await flush();
    expect(findByTestId('export-output-folder-path')?.textContent).toBe(before);
  });
});

describe('ExportModal — auto-default output folder', () => {
  it('resolves output_dir via resolve_output_dir on first open', async () => {
    render(<Harness initialOpen={true} />);
    await flush();
    // ~/Movies (videoDir) + /TrailCut/Hike2026 → joined → resolve_output_dir.
    expect(videoDirMock).toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith(
      'resolve_output_dir',
      expect.objectContaining({
        base: '/Users/u/Movies/TrailCut',
        name: 'Hike2026',
      }),
    );
    expect(findByTestId('export-output-folder-path')?.textContent).toBe(
      '/Users/u/Movies/TrailCut/Hike2026',
    );
  });

  it('honors a prefilled output_dir on the initial selection (no auto-default)', async () => {
    const seeded: ExportGrid = {
      cells: {},
      output_dir: '/Users/u/Prior',
    };
    render(<Harness initialOpen={true} initialSelection={seeded} />);
    await flush();
    expect(invokeMock).not.toHaveBeenCalledWith(
      'resolve_output_dir',
      expect.anything(),
    );
    expect(findByTestId('export-output-folder-path')?.textContent).toBe(
      '/Users/u/Prior',
    );
  });

  it('falls back to no-folder when resolve_output_dir rejects', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'resolve_output_dir') throw new Error('fs err');
      return { frames_written: 0, output_path: '', wall_clock_ms: 0 };
    });
    render(<Harness initialOpen={true} />);
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

describe('ExportModal — grid wiring (add / edit / remove)', () => {
  it('opens the secondary modal in add mode when an empty cell + button is clicked', async () => {
    render(<Harness initialOpen={true} />);
    await flush();
    act(() => {
      fireEvent.click(
        findByTestId('export-cell-16_9-composite-add') as HTMLButtonElement,
      );
    });
    expect(findByTestId('config-export-modal')).not.toBeNull();
    expect(findByTestId('config-export-modal-crumb')?.textContent).toContain('16:9');
    expect(findByTestId('config-export-modal-crumb')?.textContent).toContain(
      'Composite',
    );
    expect(findByTestId('config-export-modal-save')?.textContent).toBe('Add export');
  });

  it('Save in add mode appends a chip with the chosen quality + fps', async () => {
    render(<Harness initialOpen={true} />);
    await flush();
    act(() =>
      fireEvent.click(findByTestId('export-cell-9_16-composite-add') as HTMLButtonElement),
    );
    // User flips to 4K · 60
    act(() => fireEvent.click(findByTestId('config-quality-2160p') as HTMLButtonElement));
    act(() => fireEvent.click(findByTestId('config-fps-60') as HTMLButtonElement));
    act(() => fireEvent.click(findByTestId('config-export-modal-save') as HTMLButtonElement));
    // Secondary modal closed; chip appears in target cell.
    expect(findByTestId('config-export-modal')).toBeNull();
    const cell = container.querySelector('[data-testid="export-cell-9_16-composite"]');
    const chipLabel = cell?.querySelector('[data-testid$="-label"]');
    expect(chipLabel?.textContent).toBe('4K·60');
  });

  it('opens the secondary modal in edit mode when an existing chip is clicked', async () => {
    const seeded: ExportGrid = {
      cells: { '4_5-map_only': [{ id: 'chip-x', quality: '1080p', fps: 30 }] },
      output_dir: '/seed',
    };
    render(<Harness initialOpen={true} initialSelection={seeded} />);
    await flush();
    act(() => fireEvent.click(findByTestId('export-chip-chip-x') as HTMLElement));
    expect(findByTestId('config-export-modal-save')?.textContent).toBe('Save changes');
    expect(findByTestId('config-export-modal-crumb')?.textContent).toContain('4:5');
    expect(findByTestId('config-export-modal-crumb')?.textContent).toContain('Map only');
  });

  it('Save in edit mode replaces the chip without changing its id', async () => {
    const seeded: ExportGrid = {
      cells: { '16_9-composite': [{ id: 'chip-x', quality: '1080p', fps: 30 }] },
      output_dir: '/seed',
    };
    render(<Harness initialOpen={true} initialSelection={seeded} />);
    await flush();
    act(() => fireEvent.click(findByTestId('export-chip-chip-x') as HTMLElement));
    act(() => fireEvent.click(findByTestId('config-fps-60') as HTMLButtonElement));
    act(() => fireEvent.click(findByTestId('config-export-modal-save') as HTMLButtonElement));
    // Id preserved → same testid still resolves; label updated.
    const label = container.querySelector('[data-testid="export-chip-chip-x-label"]');
    expect(label?.textContent).toBe('1080·60');
    // Cell has exactly 1 chip (not 2).
    const cell = container.querySelector('[data-testid="export-cell-16_9-composite"]');
    expect(
      cell?.querySelectorAll('[data-testid^="export-chip-"][data-testid$="-label"]').length,
    ).toBe(1);
  });

  it('removing a chip drops it from the grid', async () => {
    const seeded: ExportGrid = {
      cells: { '16_9-composite': [{ id: 'chip-x', quality: '1080p', fps: 30 }] },
      output_dir: '/seed',
    };
    render(<Harness initialOpen={true} initialSelection={seeded} />);
    await flush();
    act(() =>
      fireEvent.click(findByTestId('export-chip-chip-x-remove') as HTMLButtonElement),
    );
    expect(container.querySelector('[data-testid="export-chip-chip-x"]')).toBeNull();
  });

  it('Cancel from secondary modal does not add a chip', async () => {
    render(<Harness initialOpen={true} />);
    await flush();
    act(() =>
      fireEvent.click(findByTestId('export-cell-16_9-composite-add') as HTMLButtonElement),
    );
    act(() => fireEvent.click(findByTestId('config-quality-2160p') as HTMLButtonElement));
    act(() => fireEvent.click(findByTestId('config-export-modal-cancel') as HTMLButtonElement));
    expect(findByTestId('config-export-modal')).toBeNull();
    const cell = container.querySelector('[data-testid="export-cell-16_9-composite"]');
    expect(
      cell?.querySelectorAll('[data-testid^="export-chip-"][data-testid$="-label"]').length,
    ).toBe(0);
  });
});

describe('ExportModal — source-ceiling gating', () => {
  function makeClip(resolution: string, frame_rate: number): Clip {
    return {
      id: 'c1',
      path: '/tmp/c1.mov',
      filename: 'c1.mov',
      created_at: '2026-01-01T00:00:00Z',
      duration_ms: 60_000,
      gps: null,
      resolution,
      frame_rate,
      trim: { in_ms: 0, out_ms: 60_000 },
      focal_point: { x: 0.5, y: 0.5, zoom: 1 },
      effects: { stabilize: { enabled: false, shakiness: 5 }, speed: 1 },
      visible: true,
      map_overrides: null,
    };
  }

  it('hard-disables qualities above source short-edge for composite', async () => {
    // 1080p source → 1440p / 2160p disabled with a "Source 1920×1080" tooltip.
    render(
      <Harness
        initialOpen={true}
        clips={[makeClip('1920x1080', 30)]}
      />,
    );
    await flush();
    act(() =>
      fireEvent.click(findByTestId('export-cell-16_9-composite-add') as HTMLButtonElement),
    );
    const fourK = findByTestId('config-quality-2160p') as HTMLButtonElement;
    expect(fourK.disabled).toBe(true);
    expect(fourK.title).toContain('1920x1080');
    const onePointFourFour = findByTestId('config-quality-1440p') as HTMLButtonElement;
    expect(onePointFourFour.disabled).toBe(true);
    // 1080p and 720p remain enabled.
    expect((findByTestId('config-quality-1080p') as HTMLButtonElement).disabled).toBe(false);
    expect((findByTestId('config-quality-720p') as HTMLButtonElement).disabled).toBe(false);
  });

  it('hard-disables fps above source fps for composite', async () => {
    render(<Harness initialOpen={true} clips={[makeClip('1920x1080', 30)]} />);
    await flush();
    act(() =>
      fireEvent.click(findByTestId('export-cell-16_9-composite-add') as HTMLButtonElement),
    );
    const sixty = findByTestId('config-fps-60') as HTMLButtonElement;
    expect(sixty.disabled).toBe(true);
  });

  it('allows everything for map_only regardless of source caps', async () => {
    // Map is procedural — source resolution / fps don't gate quality.
    render(<Harness initialOpen={true} clips={[makeClip('1280x720', 24)]} />);
    await flush();
    act(() =>
      fireEvent.click(findByTestId('export-cell-16_9-map_only-add') as HTMLButtonElement),
    );
    expect((findByTestId('config-quality-2160p') as HTMLButtonElement).disabled).toBe(false);
    expect((findByTestId('config-fps-60') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('ExportModal — duplicate-combo gating', () => {
  it('disables Save in add mode when current selection duplicates an existing chip', async () => {
    const seeded: ExportGrid = {
      cells: { '16_9-composite': [{ id: 'existing', quality: '1080p', fps: 30 }] },
      output_dir: '/seed',
    };
    render(<Harness initialOpen={true} initialSelection={seeded} />);
    await flush();
    act(() =>
      fireEvent.click(findByTestId('export-cell-16_9-composite-add') as HTMLButtonElement),
    );
    // Default initial = 1080p · 30 = existing combo → save disabled.
    const save = findByTestId('config-export-modal-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect((save.title ?? '').toLowerCase()).toContain('already in this cell');
    // Flip fps to 60 → conflict clears.
    act(() => fireEvent.click(findByTestId('config-fps-60') as HTMLButtonElement));
    expect(save.disabled).toBe(false);
  });

  it('allows edit-mode save when the chip keeps its own combo', async () => {
    // In edit mode the chip's own (quality, fps) is excluded from conflicts —
    // otherwise the user couldn't re-save without modifying anything.
    const seeded: ExportGrid = {
      cells: { '16_9-composite': [{ id: 'me', quality: '1080p', fps: 30 }] },
      output_dir: '/seed',
    };
    render(<Harness initialOpen={true} initialSelection={seeded} />);
    await flush();
    act(() => fireEvent.click(findByTestId('export-chip-me') as HTMLElement));
    const save = findByTestId('config-export-modal-save') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });
});
