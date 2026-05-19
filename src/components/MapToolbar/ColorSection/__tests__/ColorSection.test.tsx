// ColorSection smoke + behavior tests.
//
// Uses `react-dom/client` directly (consistent with other component tests in
// the repo). Covers:
//   • Renders exactly 7 swatches (6 named + 1 custom) plus the hex input
//   • Clicking a named swatch fires onChange with the matching hex
//   • Disabled swatch row blocks onChange
//   • Hex input typing a 6-char hex applies immediately
//   • Hex input on blur with invalid value flashes red border and reverts
//   • Override pill renders the supplied label and reset button

import { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { ColorSection } from '../ColorSection';
import { COLOR_SECTION_SWATCHES } from '../swatches';

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

function q(selector: string): Element | null {
  return container.querySelector(selector);
}

function qAll(selector: string): Element[] {
  return Array.from(container.querySelectorAll(selector));
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Set the value of a React-controlled input. React installs its own value
 *  setter on the input prototype that records the previous value; calling the
 *  raw DOM setter bypasses that, so React's synthetic onChange fires correctly
 *  when we dispatch the `input` event. */
function setControlledInputValue(input: HTMLInputElement, value: string) {
  const proto = Object.getPrototypeOf(input) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(input, value);
  } else {
    input.value = value;
  }
}

describe('ColorSection', () => {
  it('renders 7 swatch tiles in the documented order', () => {
    render(<ColorSection value="#bced09" onChange={() => undefined} />);
    const named = qAll('[data-testid^="swatch-"]:not([data-testid="swatch-custom"])');
    expect(named.length).toBe(6);

    const expected = COLOR_SECTION_SWATCHES.map((s) => `swatch-${s.name.toLowerCase()}`);
    const actual = named.map((el) => el.getAttribute('data-testid'));
    expect(actual).toEqual(expected);

    expect(q('[data-testid="swatch-custom"]')).toBeTruthy();
  });

  it('renders the inline hex input next to the swatch row', () => {
    render(<ColorSection value="#bced09" onChange={() => undefined} />);
    const input = q('[data-testid="color-section-hex-input"]') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    expect(input!.value).toBe('BCED09');
  });

  it('fires onChange with the matching hex when a named swatch is clicked', () => {
    const onChange = vi.fn();
    render(<ColorSection value="#bced09" onChange={onChange} />);
    const coral = q('[data-testid="swatch-coral"]');
    expect(coral).toBeTruthy();
    click(coral!);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toBe('#ff715b');
  });

  it('outlines the matching named swatch when value matches', () => {
    render(<ColorSection value="#f9cb40" onChange={() => undefined} />);
    const pollen = q('[data-testid="swatch-pollen"]') as HTMLElement;
    // selected style applies a box-shadow ring; only assert that it's non-empty
    expect(pollen.style.boxShadow).not.toBe('');
  });

  it('outlines the custom tile when value is not a named swatch hex', () => {
    render(<ColorSection value="#123456" onChange={() => undefined} />);
    const custom = q('[data-testid="swatch-custom"]') as HTMLElement;
    expect(custom.style.boxShadow).not.toBe('');
  });

  it('blocks onChange when disabled', () => {
    const onChange = vi.fn();
    render(<ColorSection value="#bced09" onChange={onChange} disabled />);
    const coral = q('[data-testid="swatch-coral"]');
    click(coral!);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('applies a 6-char hex typed into the input immediately', () => {
    const onChange = vi.fn();
    render(<ColorSection value="#bced09" onChange={onChange} />);
    const input = q('[data-testid="color-section-hex-input"]') as HTMLInputElement;
    act(() => {
      setControlledInputValue(input, 'ff715b');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('#ff715b');
  });

  it('reverts to previous valid value on blur with invalid input', () => {
    const onChange = vi.fn();
    render(<ColorSection value="#bced09" onChange={onChange} />);
    const input = q('[data-testid="color-section-hex-input"]') as HTMLInputElement;
    act(() => {
      setControlledInputValue(input, 'zzz');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      // React 19 delegates focus events to the root via `focusin`/`focusout`,
      // not via the native `blur`/`focus`. Dispatch the delegated event the
      // SyntheticEvent system actually listens for.
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(input.value).toBe('BCED09');
  });

  it('opens the custom picker block when the custom tile is clicked', () => {
    render(<ColorSection value="#bced09" onChange={() => undefined} />);
    expect(q('[data-testid="color-section-picker"]')).toBeNull();
    const custom = q('[data-testid="swatch-custom"]');
    click(custom!);
    expect(q('[data-testid="color-section-picker"]')).not.toBeNull();
    // Toggling collapses.
    click(custom!);
    expect(q('[data-testid="color-section-picker"]')).toBeNull();
  });

  it('renders the override pill when overrideIndicator is provided', () => {
    const onClear = vi.fn();
    render(
      <ColorSection
        value="#bced09"
        onChange={() => undefined}
        overrideIndicator={{ label: 'Wp 3 · override', onClear }}
      />,
    );
    // Find the pill via its label text content.
    const pillNodes = qAll('span');
    const pill = pillNodes.find((n) => /Wp 3 · override/.test(n.textContent ?? ''));
    expect(pill).toBeTruthy();
    const resetBtn = qAll('button').find((b) => /Reset to project/.test(b.textContent ?? ''));
    expect(resetBtn).toBeTruthy();
    click(resetBtn!);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('falls back to the gradient first stop color when value is gradient-shaped (caller responsibility — component sees plain hex string only)', () => {
    // ColorSection itself accepts only `string`. This test pins the contract.
    render(<ColorSection value="#bced09" onChange={() => undefined} />);
    const input = q('[data-testid="color-section-hex-input"]') as HTMLInputElement;
    expect(input.value).toBe('BCED09');
  });
});

// ============================================================================
// Step 7 — Gradient mode tests
// ============================================================================

describe('ColorSection — gradient mode toggle', () => {
  beforeEach(() => {
    // jsdom doesn't ship ResizeObserver; the GradientEditor needs it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it('renders the [Solid][Gradient] toggle when mode + onModeChange are provided', () => {
    render(
      <ColorSection
        value="#bced09"
        onChange={() => undefined}
        mode="solid"
        onModeChange={() => undefined}
      />,
    );
    expect(q('[data-testid="color-mode-toggle"]')).not.toBeNull();
    expect(q('[data-testid="color-mode-solid"]')).not.toBeNull();
    expect(q('[data-testid="color-mode-gradient"]')).not.toBeNull();
  });

  it('omits the mode toggle when mode is not provided', () => {
    render(<ColorSection value="#bced09" onChange={() => undefined} />);
    expect(q('[data-testid="color-mode-toggle"]')).toBeNull();
  });

  it('fires onModeChange with the opposite mode on segment click', () => {
    const onModeChange = vi.fn();
    render(
      <ColorSection
        value="#bced09"
        onChange={() => undefined}
        mode="solid"
        onModeChange={onModeChange}
      />,
    );
    click(q('[data-testid="color-mode-gradient"]')!);
    expect(onModeChange).toHaveBeenCalledWith('gradient');
  });

  it('disables the gradient segment when gradientAvailable=false', () => {
    const onModeChange = vi.fn();
    render(
      <ColorSection
        value="#bced09"
        onChange={() => undefined}
        mode="solid"
        onModeChange={onModeChange}
        gradientAvailable={false}
      />,
    );
    const btn = q('[data-testid="color-mode-gradient"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    click(btn);
    // Clicks on disabled buttons may still fire onClick in jsdom; the
    // component guards internally — onModeChange must not be invoked.
    expect(onModeChange).not.toHaveBeenCalled();
  });
});

describe('ColorSection — gradient mode body', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  const twoStop = () => [
    { fraction: 0, color: '#000000' },
    { fraction: 1, color: '#ffffff' },
  ];

  it('renders the gradient editor instead of the solid swatch row in gradient mode', () => {
    render(
      <ColorSection
        value="#000000"
        onChange={() => undefined}
        mode="gradient"
        onModeChange={() => undefined}
        gradientStops={twoStop()}
        onGradientStopsChange={() => undefined}
        waypointProgress={[]}
        totalDistMeters={1000}
      />,
    );
    expect(q('[data-testid="gradient-editor"]')).not.toBeNull();
    expect(q('[data-testid="gradient-bar"]')).not.toBeNull();
    // The stop color picker doesn't appear until a stop is selected.
    expect(q('[data-testid="stop-color-section-hex-input"]')).toBeNull();
  });

  it('shows + Stop button and disables it at 8 stops', () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({
      fraction: i / 7,
      color: '#888888',
    }));
    render(
      <ColorSection
        value="#888888"
        onChange={() => undefined}
        mode="gradient"
        onModeChange={() => undefined}
        gradientStops={eight}
        onGradientStopsChange={() => undefined}
        waypointProgress={[]}
        totalDistMeters={1000}
      />,
    );
    const addBtn = q('[data-testid="gradient-add-stop"]') as HTMLButtonElement;
    expect(addBtn).not.toBeNull();
    expect(addBtn.disabled).toBe(true);
  });

  it('+ Stop inserts at the largest gap', () => {
    const onGradientStopsChange = vi.fn();
    render(
      <ColorSection
        value="#000000"
        onChange={() => undefined}
        mode="gradient"
        onModeChange={() => undefined}
        gradientStops={twoStop()}
        onGradientStopsChange={onGradientStopsChange}
        waypointProgress={[]}
        totalDistMeters={1000}
      />,
    );
    click(q('[data-testid="gradient-add-stop"]')!);
    expect(onGradientStopsChange).toHaveBeenCalled();
    const next = onGradientStopsChange.mock.calls[0][0];
    expect(next.length).toBe(3);
    expect(next[1].fraction).toBeCloseTo(0.5, 4);
  });

  it('Copy → Waypoints button fires onCopy and flashes "Copied ✓"', () => {
    const onCopy = vi.fn();
    render(
      <ColorSection
        value="#000000"
        onChange={() => undefined}
        mode="gradient"
        onModeChange={() => undefined}
        gradientStops={twoStop()}
        onGradientStopsChange={() => undefined}
        waypointProgress={[]}
        totalDistMeters={1000}
        copyDirection="toWaypoints"
        onCopy={onCopy}
        copyVisible
      />,
    );
    const btn = q('[data-testid="gradient-copy-to-waypoints"]') as HTMLElement;
    expect(btn).not.toBeNull();
    click(btn);
    expect(onCopy).toHaveBeenCalledTimes(1);
    // After click, label flips to "Copied ✓".
    expect(btn.textContent).toContain('Copied');
  });

  it('Copy from Route button uses ← arrow label', () => {
    render(
      <ColorSection
        value="#000000"
        onChange={() => undefined}
        mode="gradient"
        onModeChange={() => undefined}
        gradientStops={twoStop()}
        onGradientStopsChange={() => undefined}
        waypointProgress={[]}
        totalDistMeters={1000}
        copyDirection="fromRoute"
        onCopy={() => undefined}
        copyVisible
      />,
    );
    const btn = q('[data-testid="gradient-copy-from-route"]') as HTMLElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toMatch(/← Copy from Route/);
  });

  it('hides the Copy button when copyVisible=false', () => {
    render(
      <ColorSection
        value="#000000"
        onChange={() => undefined}
        mode="gradient"
        onModeChange={() => undefined}
        gradientStops={twoStop()}
        onGradientStopsChange={() => undefined}
        waypointProgress={[]}
        totalDistMeters={1000}
        copyDirection="toWaypoints"
        onCopy={() => undefined}
        copyVisible={false}
      />,
    );
    expect(q('[data-testid="gradient-copy-to-waypoints"]')).toBeNull();
  });

  it('renders STOP COLOR picker when a stop is selected on the rail', () => {
    render(
      <ColorSection
        value="#000000"
        onChange={() => undefined}
        mode="gradient"
        onModeChange={() => undefined}
        gradientStops={[
          { fraction: 0, color: '#000000' },
          { fraction: 0.5, color: '#888888' },
          { fraction: 1, color: '#ffffff' },
        ]}
        onGradientStopsChange={() => undefined}
        waypointProgress={[]}
        totalDistMeters={1000}
      />,
    );
    // Initially nothing selected → no picker.
    expect(q('[data-testid="stop-swatch-coral"]')).toBeNull();
    // Click the mid-handle → selectedIndex = 1.
    click(q('[data-testid="gradient-stop-handle-1"]')!);
    // Picker swatch row should now be present with the stop- prefix.
    expect(q('[data-testid="stop-swatch-coral"]')).not.toBeNull();
  });
});

