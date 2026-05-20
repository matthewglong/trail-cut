// ShapeSection smoke + behavior tests.
//
// Mirrors the pattern in `ColorSection.test.tsx`: render via `react-dom/client`
// directly, query by `data-testid`, and assert on rendered HTML + callback
// payloads. Acceptance details:
//   • All five shape buttons render (circle, ring, pin, square, diamond)
//     with the documented labels — `numbered-circle` was dropped in the
//     shape-descriptor refactor; numbering rides on the label layer now.
//   • Clicking a cell fires `onChange` with the matching enum string
//   • Selected cell gets the accent (chartreuse) ring via `cellSelected`
//   • `disabled` blocks pointer events and `onChange`
//   • `overrideIndicator` renders the pill + clear button

import { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { ShapeSection } from '../ShapeSection';
import type { WaypointShape } from '../../../../types';

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

const ALL_SHAPES: WaypointShape[] = [
  'circle',
  'ring',
  'pin',
  'square',
  'diamond',
];

describe('ShapeSection', () => {
  it('renders all five shape cells with the documented enum values', () => {
    render(<ShapeSection value="circle" onChange={() => undefined} />);
    for (const shape of ALL_SHAPES) {
      const cell = q(`[data-testid="shape-cell-${shape}"]`);
      expect(cell, `expected cell for ${shape}`).toBeTruthy();
    }
    const cells = qAll('[data-testid^="shape-cell-"]');
    expect(cells.length).toBe(5);
  });

  it('renders human-readable labels for each shape', () => {
    render(<ShapeSection value="circle" onChange={() => undefined} />);
    const text = container.textContent ?? '';
    expect(text).toContain('Circle');
    expect(text).toContain('Ring');
    expect(text).toContain('Pin');
    expect(text).toContain('Square');
    expect(text).toContain('Diamond');
  });

  it('fires onChange with the matching enum value when a cell is clicked', () => {
    const onChange = vi.fn();
    render(<ShapeSection value="circle" onChange={onChange} />);
    const diamond = q('[data-testid="shape-cell-diamond"]');
    expect(diamond).toBeTruthy();
    click(diamond!);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toBe('diamond');
  });

  it('marks the selected cell with the accent (chartreuse) styling', () => {
    render(<ShapeSection value="ring" onChange={() => undefined} />);
    const ring = q('[data-testid="shape-cell-ring"]') as HTMLElement;
    // `cellSelected` swaps the background color to `semantic.accentTint`
    // (`rgba(188, 237, 9, 0.10)`). Browsers normalize that to rgba form.
    expect(ring.style.backgroundColor).toBe('rgba(188, 237, 9, 0.1)');
    expect(ring.getAttribute('aria-pressed')).toBe('true');
  });

  it('marks unselected cells with the default surface styling', () => {
    render(<ShapeSection value="ring" onChange={() => undefined} />);
    const circle = q('[data-testid="shape-cell-circle"]') as HTMLElement;
    // `semantic.surfaceDeep` = `#232c2d`. jsdom serializes hex to rgb().
    expect(circle.style.backgroundColor).toBe('rgb(35, 44, 45)');
    expect(circle.getAttribute('aria-pressed')).toBe('false');
  });

  it('blocks onChange and dims the grid when disabled', () => {
    const onChange = vi.fn();
    render(<ShapeSection value="circle" onChange={onChange} disabled />);
    const diamond = q('[data-testid="shape-cell-diamond"]') as HTMLButtonElement;
    expect(diamond.disabled).toBe(true);
    click(diamond);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('omits the override pill row when overrideIndicator is undefined', () => {
    render(<ShapeSection value="circle" onChange={() => undefined} />);
    expect(q('[data-testid="shape-section-clear-override"]')).toBeNull();
  });

  it('renders the override pill + clear button when overrideIndicator is set', () => {
    const onClear = vi.fn();
    render(
      <ShapeSection
        value="diamond"
        onChange={() => undefined}
        overrideIndicator={{ label: 'Wp 3 · override', onClear }}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Wp 3 · override');
    const clearBtn = q('[data-testid="shape-section-clear-override"]');
    expect(clearBtn).toBeTruthy();
    click(clearBtn!);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('fires onChange for every shape in the gallery', () => {
    const onChange = vi.fn();
    render(<ShapeSection value="circle" onChange={onChange} />);
    for (const shape of ALL_SHAPES) {
      const cell = q(`[data-testid="shape-cell-${shape}"]`);
      click(cell!);
    }
    expect(onChange).toHaveBeenCalledTimes(ALL_SHAPES.length);
    const seen = onChange.mock.calls.map((c) => c[0]);
    expect(seen).toEqual(ALL_SHAPES);
  });
});
