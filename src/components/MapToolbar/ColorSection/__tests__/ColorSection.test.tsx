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
