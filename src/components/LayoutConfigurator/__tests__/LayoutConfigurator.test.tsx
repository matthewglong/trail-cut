import { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/react';
import { LayoutConfigurator } from '../LayoutConfigurator';
import {
  OUTPUT_DIMS,
  clampLayout,
  defaultPipLayout,
  defaultSplitLayout,
  legalSplitSides,
  type AspectRatio,
  type LayoutConfig,
  type PipLayout,
  type SplitLayout,
} from '../../../lib/layout';

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

function findByTestId(id: string): Element | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

function pointerEvent(
  type: string,
  init: { clientX: number; clientY: number; shiftKey?: boolean },
): PointerEvent {
  const evt = Object.assign(new Event(type, { bubbles: true }), {
    clientX: init.clientX,
    clientY: init.clientY,
    shiftKey: init.shiftKey ?? false,
    button: 0,
  });
  return evt as unknown as PointerEvent;
}

describe('LayoutConfigurator — render matrix', () => {
  const aspects: AspectRatio[] = ['9_16', '16_9', '4_5'];

  for (const aspect of aspects) {
    it(`PiP × ${aspect}: renders SVG viewBox + 4 corners + corner-radius slider`, () => {
      const layout = defaultPipLayout(aspect);
      render(
        <LayoutConfigurator
          layout={layout}
          aspect={aspect}
          containerWidth={540}
          containerHeight={960}
          onChange={() => {}}
        />,
      );
      const svg = findByTestId('layout-configurator-svg');
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute('viewBox')).toBe(
        `0 0 ${OUTPUT_DIMS[aspect].w} ${OUTPUT_DIMS[aspect].h}`,
      );
      for (const c of ['tl', 'tr', 'bl', 'br'] as const) {
        expect(findByTestId(`layout-configurator-pip-corner-${c}`)).not.toBeNull();
      }
      expect(findByTestId('layout-configurator-corner-radius')).not.toBeNull();
    });

    it(`Split × ${aspect}: renders divider handle + no corner-radius slider`, () => {
      const layout = defaultSplitLayout(aspect);
      render(
        <LayoutConfigurator
          layout={layout}
          aspect={aspect}
          containerWidth={540}
          containerHeight={960}
          onChange={() => {}}
        />,
      );
      expect(findByTestId('layout-configurator-split-handle')).not.toBeNull();
      expect(findByTestId('layout-configurator-corner-radius')).toBeNull();
    });
  }
});

describe('LayoutConfigurator — mode toggle', () => {
  it('PiP → Split synthesizes defaultSplitLayout(aspect)', () => {
    const onChange = vi.fn();
    render(
      <LayoutConfigurator
        layout={defaultPipLayout('9_16')}
        aspect="9_16"
        containerWidth={540}
        containerHeight={960}
        onChange={onChange}
      />,
    );
    const splitButton = findByTestId('layout-configurator-mode-split') as HTMLButtonElement;
    act(() => splitButton.click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual(clampLayout(defaultSplitLayout('9_16'), '9_16'));
  });

  it('Split → PiP synthesizes defaultPipLayout(aspect)', () => {
    const onChange = vi.fn();
    render(
      <LayoutConfigurator
        layout={defaultSplitLayout('9_16')}
        aspect="9_16"
        containerWidth={540}
        containerHeight={960}
        onChange={onChange}
      />,
    );
    const pipButton = findByTestId('layout-configurator-mode-pip') as HTMLButtonElement;
    act(() => pipButton.click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual(clampLayout(defaultPipLayout('9_16'), '9_16'));
  });
});

describe('LayoutConfigurator — swap toggle', () => {
  it('PiP swap flips inset_source and preserves corner_radius', () => {
    const onChange = vi.fn();
    const layout: PipLayout = {
      mode: 'pip',
      inset_source: 'map',
      inset: { x: 0.65, y: 0.78, w: 0.32, h: 0.18 },
      corner_radius: 0.04,
    };
    render(
      <LayoutConfigurator
        layout={layout}
        aspect="9_16"
        containerWidth={540}
        containerHeight={960}
        onChange={onChange}
      />,
    );
    const swap = findByTestId('layout-configurator-swap') as HTMLButtonElement;
    act(() => swap.click());
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as LayoutConfig;
    if (next.mode !== 'pip') throw new Error('expected pip');
    expect(next.inset_source).toBe('video');
    expect(next.corner_radius).toBeCloseTo(0.04, 6);
    expect(next.inset).toEqual(layout.inset);
  });

  it('Split swap rotates video_side per legalSplitSides and preserves divider', () => {
    const onChange = vi.fn();
    const layout: SplitLayout = { mode: 'split', video_side: 'top', divider: 0.42 };
    render(
      <LayoutConfigurator
        layout={layout}
        aspect="9_16"
        containerWidth={540}
        containerHeight={960}
        onChange={onChange}
      />,
    );
    const swap = findByTestId('layout-configurator-swap') as HTMLButtonElement;
    act(() => swap.click());
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as LayoutConfig;
    if (next.mode !== 'split') throw new Error('expected split');
    const sides = legalSplitSides('9_16');
    expect(next.video_side).toBe(sides[(sides.indexOf('top') + 1) % sides.length]);
    expect(next.divider).toBeCloseTo(0.42, 6);
  });
});

describe('LayoutConfigurator — in-overlay swap badge', () => {
  it('PiP overlay renders a swap badge that flips inset_source', () => {
    const onChange = vi.fn();
    const layout: PipLayout = {
      mode: 'pip',
      inset_source: 'map',
      inset: { x: 0.6, y: 0.7, w: 0.3, h: 0.2 },
      corner_radius: 0.02,
    };
    render(
      <LayoutConfigurator
        layout={layout}
        aspect="9_16"
        containerWidth={540}
        containerHeight={960}
        onChange={onChange}
        chromeless
      />,
    );
    const badge = findByTestId('layout-configurator-swap-badge');
    expect(badge).not.toBeNull();
    act(() => {
      badge!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as LayoutConfig;
    if (next.mode !== 'pip') throw new Error('expected pip');
    expect(next.inset_source).toBe('video');
  });

  it('Split overlay renders a swap badge that rotates video_side', () => {
    const onChange = vi.fn();
    const layout: SplitLayout = { mode: 'split', video_side: 'left', divider: 0.4 };
    render(
      <LayoutConfigurator
        layout={layout}
        aspect="16_9"
        containerWidth={960}
        containerHeight={540}
        onChange={onChange}
        chromeless
      />,
    );
    const badge = findByTestId('layout-configurator-swap-badge');
    expect(badge).not.toBeNull();
    act(() => {
      badge!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as LayoutConfig;
    if (next.mode !== 'split') throw new Error('expected split');
    const sides = legalSplitSides('16_9');
    expect(next.video_side).toBe(sides[(sides.indexOf('left') + 1) % sides.length]);
    expect(next.divider).toBeCloseTo(0.4, 6);
  });
});

describe('LayoutConfigurator — corner-radius slider', () => {
  it('emits a new corner_radius when changed (PiP)', () => {
    const onChange = vi.fn();
    const layout = defaultPipLayout('9_16');
    render(
      <LayoutConfigurator
        layout={layout}
        aspect="9_16"
        containerWidth={540}
        containerHeight={960}
        onChange={onChange}
      />,
    );
    const input = findByTestId('layout-configurator-corner-radius-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0.03' } });
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)![0] as LayoutConfig;
    if (next.mode !== 'pip') throw new Error('expected pip');
    expect(next.corner_radius).toBeCloseTo(0.03, 6);
  });

  it('is hidden for Split layouts', () => {
    render(
      <LayoutConfigurator
        layout={defaultSplitLayout('9_16')}
        aspect="9_16"
        containerWidth={540}
        containerHeight={960}
        onChange={() => {}}
      />,
    );
    expect(findByTestId('layout-configurator-corner-radius')).toBeNull();
  });
});

describe('LayoutConfigurator — disabled', () => {
  it('does not emit onChange from synthesized pointer events', () => {
    const onChange = vi.fn();
    render(
      <LayoutConfigurator
        layout={defaultPipLayout('9_16')}
        aspect="9_16"
        containerWidth={540}
        containerHeight={960}
        onChange={onChange}
        disabled
      />,
    );
    const body = findByTestId('layout-configurator-pip-body') as Element;
    act(() => {
      body.dispatchEvent(pointerEvent('pointerdown', { clientX: 200, clientY: 200 }));
    });
    act(() => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 250, clientY: 250 }));
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('LayoutConfigurator — PiP drag readout', () => {
  // A roomy-margin inset: 0.30 inset on all sides leaves ~324px (1080×0.3)
  // horizontal and ~576px (1920×0.3) vertical gap — plenty of room for cues
  // to render even at the 540×960 container's 0.5 scaleFactor.
  const ROOMY_PIP: PipLayout = {
    mode: 'pip',
    inset_source: 'map',
    inset: { x: 0.3, y: 0.3, w: 0.4, h: 0.4 },
    corner_radius: 0.012,
  };

  it('removes the readout after pointerup', () => {
    render(
      <LayoutConfigurator
        layout={ROOMY_PIP}
        aspect="9_16"
        containerWidth={540}
        containerHeight={960}
        snapEnabledByDefault={false}
        onChange={() => {}}
      />,
    );
    const body = findByTestId('layout-configurator-pip-body') as Element;
    act(() => {
      body.dispatchEvent(pointerEvent('pointerdown', { clientX: 200, clientY: 200 }));
    });
    act(() => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 210, clientY: 210 }));
    });
    expect(findByTestId('layout-configurator-pip-readout')).not.toBeNull();
    act(() => {
      window.dispatchEvent(pointerEvent('pointerup', { clientX: 210, clientY: 210 }));
    });
    expect(findByTestId('layout-configurator-pip-readout')).toBeNull();
  });

  it('renders no chips and no equality ticks during a free drag with no snap engaged', () => {
    // Snap disabled → no axis, aspect, or margin engagement possible. The
    // readout group should still mount during drag, but it must contain no
    // equality ticks and no body/edge chips.
    render(
      <LayoutConfigurator
        layout={ROOMY_PIP}
        aspect="9_16"
        containerWidth={540}
        containerHeight={960}
        snapEnabledByDefault={false}
        onChange={() => {}}
      />,
    );
    const body = findByTestId('layout-configurator-pip-body') as Element;
    act(() => {
      body.dispatchEvent(pointerEvent('pointerdown', { clientX: 200, clientY: 200 }));
    });
    act(() => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 213, clientY: 217 }));
    });
    const readout = findByTestId('layout-configurator-pip-readout');
    expect(readout).not.toBeNull();
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      expect(findByTestId(`layout-configurator-pip-equal-tick-${side}`)).toBeNull();
      expect(findByTestId(`layout-configurator-pip-margin-${side}`)).toBeNull();
    }
    expect(findByTestId('layout-configurator-pip-body-chip')).toBeNull();
    expect(findByTestId('layout-configurator-pip-aspect-chip')).toBeNull();
  });

  it('renders equal-margin ticks on the two involved sides when a pair engages', () => {
    // On 9:16 (1080×1920), with inset {x:0.4, y:0.3, w:0.415, h:0.596}:
    //   left_px=432, right_px=200, top_px=576, bottom_px=200.
    // Only right=bottom matches within the 24px threshold; all other
    // adjacent pairs and the centered-axis checks fall well outside it.
    const pairEqual: PipLayout = {
      mode: 'pip',
      inset_source: 'map',
      inset: { x: 0.4, y: 0.3, w: 0.415, h: 0.596 },
      corner_radius: 0.012,
    };
    render(
      <LayoutConfigurator
        layout={pairEqual}
        aspect="9_16"
        containerWidth={540}
        containerHeight={960}
        snapEnabledByDefault
        onChange={() => {}}
      />,
    );
    const body = findByTestId('layout-configurator-pip-body') as Element;
    act(() => {
      body.dispatchEvent(pointerEvent('pointerdown', { clientX: 200, clientY: 600 }));
    });
    act(() => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 201, clientY: 601 }));
    });
    expect(findByTestId('layout-configurator-pip-equal-tick-right')).not.toBeNull();
    expect(findByTestId('layout-configurator-pip-equal-tick-bottom')).not.toBeNull();
    expect(findByTestId('layout-configurator-pip-equal-tick-left')).toBeNull();
    expect(findByTestId('layout-configurator-pip-equal-tick-top')).toBeNull();
  });

  it('renders an aspect label chip when an aspect-fit is engaged', () => {
    // Square inset → 1:1 aspect snap engages on any drag. The aspect label
    // chip renders inside the inset.
    const squareInset: PipLayout = {
      mode: 'pip',
      inset_source: 'map',
      inset: { x: 0.2, y: 0.35, w: 0.3, h: (0.3 * 1080) / 1920 },
      corner_radius: 0.012,
    };
    render(
      <LayoutConfigurator
        layout={squareInset}
        aspect="9_16"
        containerWidth={540}
        containerHeight={960}
        snapEnabledByDefault
        onChange={() => {}}
      />,
    );
    const corner = findByTestId('layout-configurator-pip-corner-br-hit') as Element;
    act(() => {
      corner.dispatchEvent(pointerEvent('pointerdown', { clientX: 270, clientY: 540 }));
    });
    act(() => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 271, clientY: 541 }));
    });
    const chip = findByTestId('layout-configurator-pip-aspect-chip');
    expect(chip).not.toBeNull();
    const text = chip!.querySelector('text');
    expect(text?.textContent).toBe('1:1');
  });
});

describe('LayoutConfigurator — pointer listeners do not leak', () => {
  it('subsequent pointermove after pointerup does not emit onChange', () => {
    const onChange = vi.fn();
    render(
      <LayoutConfigurator
        layout={defaultPipLayout('9_16')}
        aspect="9_16"
        containerWidth={540}
        containerHeight={960}
        snapEnabledByDefault={false}
        onChange={onChange}
      />,
    );
    const body = findByTestId('layout-configurator-pip-body') as Element;
    act(() => {
      body.dispatchEvent(pointerEvent('pointerdown', { clientX: 200, clientY: 200 }));
    });
    act(() => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 220, clientY: 210 }));
    });
    expect(onChange).toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(pointerEvent('pointerup', { clientX: 220, clientY: 210 }));
    });
    onChange.mockClear();
    act(() => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 240, clientY: 220 }));
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});
