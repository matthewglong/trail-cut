import { act, useState } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/react';
import { ExportModal } from '../ExportModal';
import type {
  AspectRatio,
  Clip,
  ExportChannel,
  ExportSelection,
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

interface HarnessProps {
  initialOpen: boolean;
  initialSelection?: ExportSelection;
  projectName?: string;
  onCloseExtra?: () => void;
  clips?: Clip[];
  route?: Route | null;
  mapSettings?: MapSettings;
  transitionFeel?: TransitionFeel;
  projectLayouts?: ProjectLayouts;
}

function defaultProjectLayouts(): ProjectLayouts {
  return {
    '9_16': defaultLayout('9_16'),
    '4_5': defaultLayout('4_5'),
    '16_9': defaultLayout('16_9'),
  };
}

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: overrides.id ?? 'c1',
    path: overrides.path ?? '/tmp/c1.mov',
    filename: overrides.filename ?? 'c1.mov',
    created_at: overrides.created_at ?? '2026-01-01T00:00:00Z',
    duration_ms: overrides.duration_ms ?? 60_000,
    gps: overrides.gps ?? null,
    resolution: overrides.resolution ?? '1920x1080',
    frame_rate: overrides.frame_rate ?? 30,
    trim: overrides.trim ?? { in_ms: 0, out_ms: 60_000 },
    focal_point: overrides.focal_point ?? { x: 0.5, y: 0.5, zoom: 1 },
    effects:
      overrides.effects ??
      ({ stabilize: { enabled: false, shakiness: 5 }, speed: 1 } satisfies Clip['effects']),
    visible: overrides.visible ?? true,
    map_overrides: overrides.map_overrides ?? null,
  };
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
}: HarnessProps) {
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
    expect(findByTestId('export-output-folder-choose')).not.toBeNull();
  });

  it('renders Render disabled with the spec tooltip when nothing selected', () => {
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

describe('ExportModal — Render-button enable transitions', () => {
  function renderBtn(): HTMLButtonElement {
    return findByTestId('export-modal-render') as HTMLButtonElement;
  }

  it('disabled when only aspects are set', () => {
    render(
      <Harness
        initialOpen={true}
        initialSelection={{ aspects: ['9_16'], channels: [] }}
      />,
    );
    expect(renderBtn().disabled).toBe(true);
  });

  it('disabled when only channels are set', () => {
    render(
      <Harness
        initialOpen={true}
        initialSelection={{ aspects: [], channels: ['composite'] }}
      />,
    );
    expect(renderBtn().disabled).toBe(true);
  });

  it('disabled when aspects + channels are set but folder is not', () => {
    render(
      <Harness
        initialOpen={true}
        initialSelection={{ aspects: ['9_16'], channels: ['composite'] }}
      />,
    );
    expect(renderBtn().disabled).toBe(true);
  });

  it('disabled when folder is set but aspects/channels are empty', async () => {
    dialogOpenMock.mockResolvedValue('/out');
    render(
      <Harness
        initialOpen={true}
        initialSelection={{ aspects: [], channels: [] }}
      />,
    );
    act(() => {
      fireEvent.click(findByTestId('export-output-folder-choose') as HTMLButtonElement);
    });
    await flush();
    expect(renderBtn().disabled).toBe(true);
  });

  it('enabled once aspects + channels + folder are all set; tooltip clears', async () => {
    dialogOpenMock.mockResolvedValue('/out');
    render(
      <Harness
        initialOpen={true}
        initialSelection={{ aspects: ['9_16'], channels: ['composite'] }}
      />,
    );
    expect(renderBtn().disabled).toBe(true);
    act(() => {
      fireEvent.click(findByTestId('export-output-folder-choose') as HTMLButtonElement);
    });
    await flush();
    const btn = renderBtn();
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('title')).toBeNull();
  });
});

describe('ExportModal — time estimate pipeline', () => {
  it('feeds visible clips into JobSummary so the estimate appears', () => {
    const clips: Clip[] = [
      makeClip({ id: 'a', trim: { in_ms: 0, out_ms: 30_000 } }),
      makeClip({ id: 'b', trim: { in_ms: 0, out_ms: 30_000 } }),
    ];
    render(
      <Harness
        initialOpen={true}
        initialSelection={{ aspects: ['9_16'], channels: ['composite'] }}
        clips={clips}
      />,
    );
    const estimate = container.querySelector(
      '[data-testid="export-job-summary-estimate"]',
    );
    expect(estimate).not.toBeNull();
    expect(estimate?.textContent ?? '').toContain('Estimated time:');
  });

  it('skips invisible clips when computing the timeline duration', () => {
    const clips: Clip[] = [
      makeClip({ id: 'a', visible: false, trim: { in_ms: 0, out_ms: 60_000 } }),
    ];
    render(
      <Harness
        initialOpen={true}
        initialSelection={{ aspects: ['9_16'], channels: ['composite'] }}
        clips={clips}
      />,
    );
    expect(
      container.querySelector('[data-testid="export-job-summary-estimate"]'),
    ).toBeNull();
  });

  it('hides the estimate when no clips are visible', () => {
    render(
      <Harness
        initialOpen={true}
        initialSelection={{ aspects: ['9_16'], channels: ['composite'] }}
        clips={[]}
      />,
    );
    expect(
      container.querySelector('[data-testid="export-job-summary-estimate"]'),
    ).toBeNull();
  });
});

describe('ExportModal — render flow', () => {
  async function setup(): Promise<void> {
    dialogOpenMock.mockResolvedValue('/out');
    const clips: Clip[] = [
      makeClip({ id: 'c1', trim: { in_ms: 0, out_ms: 60_000 } }),
    ];
    render(
      <Harness
        initialOpen={true}
        initialSelection={{ aspects: ['9_16'], channels: ['composite'] }}
        clips={clips}
      />,
    );
    act(() => {
      fireEvent.click(findByTestId('export-output-folder-choose') as HTMLButtonElement);
    });
    await flush();
  }

  async function clickRender(): Promise<void> {
    act(() => {
      fireEvent.click(findByTestId('export-modal-render') as HTMLButtonElement);
    });
    await flush();
    await flush();
    await flush();
  }

  it('starts the queue immediately when no collisions exist', async () => {
    await setup();
    existsMock.mockResolvedValue(false);
    await clickRender();
    expect(askMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalled();
    // Queue may have already finished given the resolved invoke mock — either
    // queue-view (running) or queue-summary (done) is acceptable here.
    expect(
      findByTestId('export-queue-view') ?? findByTestId('export-queue-summary'),
    ).not.toBeNull();
  });

  it('asks for confirmation on collision and proceeds when user confirms', async () => {
    await setup();
    existsMock.mockResolvedValue(true);
    askMock.mockResolvedValue(true);
    await clickRender();
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalled();
    expect(
      findByTestId('export-queue-view') ?? findByTestId('export-queue-summary'),
    ).not.toBeNull();
  });

  it('aborts the queue when user declines the overwrite confirmation', async () => {
    await setup();
    existsMock.mockResolvedValue(true);
    askMock.mockResolvedValue(false);
    await clickRender();
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(findByTestId('export-queue-view')).toBeNull();
    expect(findByTestId('export-modal-render')).not.toBeNull();
  });

  it('transitions select -> running -> done', async () => {
    await setup();
    await clickRender();
    await flush();
    await flush();
    await flush();
    expect(findByTestId('export-queue-summary')).not.toBeNull();
  });

  it('blocks Escape from closing while running', async () => {
    await setup();
    let resolveInvoke: (v: unknown) => void = () => {};
    invokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInvoke = resolve;
        }),
    );
    act(() => {
      fireEvent.click(findByTestId('export-modal-render') as HTMLButtonElement);
    });
    await flush();
    await flush();
    expect(findByTestId('export-queue-view')).not.toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(findByTestId('export-modal')).not.toBeNull();

    await act(async () => {
      resolveInvoke({ frames_written: 1, output_path: '/x', wall_clock_ms: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('blocks backdrop clicks from closing while running', async () => {
    await setup();
    let resolveInvoke: (v: unknown) => void = () => {};
    invokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInvoke = resolve;
        }),
    );
    act(() => {
      fireEvent.click(findByTestId('export-modal-render') as HTMLButtonElement);
    });
    await flush();
    await flush();
    expect(findByTestId('export-queue-view')).not.toBeNull();
    act(() => {
      fireEvent.click(findByTestId('export-modal-backdrop') as HTMLElement);
    });
    expect(findByTestId('export-modal')).not.toBeNull();

    await act(async () => {
      resolveInvoke({ frames_written: 1, output_path: '/x', wall_clock_ms: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});
