// Tests for the LayoutPreview overlay (task 080).
//
// Uses `react-dom/client` directly rather than `@testing-library/react` so we
// don't pull in a new dev dependency for a single component test. The vitest
// + jsdom setup the rest of the suite uses is enough for SVG attribute and
// data-testid queries.

import { act } from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { LayoutPreview } from '../LayoutPreview';
import { defaultLayout, resolveSlots, type LayoutConfig } from '../../../lib/layout';

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

function getByTestId(id: string): Element {
  const el = container.querySelector(`[data-testid="${id}"]`);
  if (!el) throw new Error(`No element with data-testid="${id}"`);
  return el;
}

describe('LayoutPreview', () => {
  it('renders both slot rects for a 9:16 PiP-with-map-inset layout', () => {
    const layout = defaultLayout('9_16');
    const resolved = resolveSlots(layout, '9_16');

    render(
      <LayoutPreview
        layout={layout}
        aspect="9_16"
        containerWidth={540}
        containerHeight={960}
      />,
    );

    const mapSlot = getByTestId('layout-preview-map-slot');
    const videoSlot = getByTestId('layout-preview-video-slot');

    // Slot rect numbers must come from `resolveSlots` — no reimplementation.
    expect(mapSlot.getAttribute('x')).toBe(String(resolved.map_slot.x));
    expect(mapSlot.getAttribute('y')).toBe(String(resolved.map_slot.y));
    expect(mapSlot.getAttribute('width')).toBe(String(resolved.map_slot.w));
    expect(mapSlot.getAttribute('height')).toBe(String(resolved.map_slot.h));
    expect(videoSlot.getAttribute('x')).toBe(String(resolved.video_slot.x));
    expect(videoSlot.getAttribute('width')).toBe(String(resolved.video_slot.w));

    // The map is the inset (default 9:16 layout), so it gets the corner
    // radius. The video is the full-bleed background → no rx.
    expect(mapSlot.getAttribute('rx')).toBe(String(resolved.corner_radius_px));
    expect(videoSlot.getAttribute('rx')).toBeNull();
    expect(resolved.corner_radius_px).toBeGreaterThan(0);
  });

  it('uses the output-pixel viewBox so slot rects render in their resolved coordinates', () => {
    // The component contract says the SVG `viewBox` matches OUTPUT_DIMS so
    // `resolveSlots`'s pixel rects map 1:1 onto SVG coordinates. Asserting
    // this directly guards against accidental scale-into-CSS-pixels math.
    const layout = defaultLayout('9_16');
    render(
      <LayoutPreview
        layout={layout}
        aspect="9_16"
        containerWidth={540}
        containerHeight={960}
      />,
    );
    const svg = getByTestId('layout-preview-svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 1080 1920');
  });

  it('aspect-fits a 16:9 layout into a portrait container (letterboxes via flex centering)', () => {
    // 16:9 output (1920×1080) into a 540×960 container → width-constrained:
    // drawnWidth = 540, drawnHeight = 540 * (1080/1920) = 303.75. The
    // component should not stretch to fill — letterboxing emerges from the
    // aspect-fit math.
    const layout = defaultLayout('16_9');
    render(
      <LayoutPreview
        layout={layout}
        aspect="16_9"
        containerWidth={540}
        containerHeight={960}
      />,
    );
    const svg = getByTestId('layout-preview-svg');
    const drawnWidth = Number(svg.getAttribute('width'));
    const drawnHeight = Number(svg.getAttribute('height'));

    expect(drawnWidth).toBeCloseTo(540, 5);
    expect(drawnHeight).toBeCloseTo(540 * (1080 / 1920), 5);
    // Confirm the SVG is NOT stretched to the container's height.
    expect(drawnHeight).toBeLessThan(960);
  });

  it('renders a Split layout as two adjacent rects with no corner radius', () => {
    // Split mode isn't seeded for any aspect in 080 (`defaultLayout` always
    // returns PiP), but `LayoutPreview` is the visual primitive 110 / 100
    // will reuse for split layouts too — so the read-only render path must
    // already work. Synthesizing the layout in the test doubles as a forward-
    // compat guard.
    const split: LayoutConfig = {
      mode: 'split',
      video_side: 'top',
      divider: 0.5,
    };
    render(
      <LayoutPreview
        layout={split}
        aspect="9_16"
        containerWidth={540}
        containerHeight={960}
      />,
    );

    const mapSlot = getByTestId('layout-preview-map-slot');
    const videoSlot = getByTestId('layout-preview-video-slot');
    expect(mapSlot.getAttribute('rx')).toBeNull();
    expect(videoSlot.getAttribute('rx')).toBeNull();
    // Top split with divider=0.5 → video on top half, map on bottom half.
    // The slots share the divider edge; their y-extents should meet.
    const videoBottom = Number(videoSlot.getAttribute('y')) + Number(videoSlot.getAttribute('height'));
    const mapTop = Number(mapSlot.getAttribute('y'));
    expect(videoBottom).toBe(mapTop);
  });

  it('disables pointer events on the overlay so it does not steal clicks', () => {
    // JSDOM doesn't honor `pointer-events: none` for click dispatch, but the
    // CSS property's presence is the contract this component owes to the
    // surrounding video pane. Verify the inline style is set on both the
    // wrapper and the SVG so the chosen render path can't drift.
    const layout = defaultLayout('9_16');
    render(
      <LayoutPreview
        layout={layout}
        aspect="9_16"
        containerWidth={540}
        containerHeight={960}
      />,
    );
    const wrapper = getByTestId('layout-preview-container') as HTMLDivElement;
    const svg = getByTestId('layout-preview-svg') as SVGElement;
    expect(wrapper.style.pointerEvents).toBe('none');
    // SVGElement.style is also accessible — the `style` prop gets serialized
    // into the same `pointer-events: none` declaration.
    expect((svg as unknown as HTMLElement).style.pointerEvents).toBe('none');
  });

  it('renders Map and Video labels centered in their respective slots', () => {
    const layout = defaultLayout('9_16');
    const resolved = resolveSlots(layout, '9_16');
    render(
      <LayoutPreview
        layout={layout}
        aspect="9_16"
        containerWidth={540}
        containerHeight={960}
      />,
    );
    const mapLabelGroup = getByTestId('layout-preview-map-label');
    const videoLabelGroup = getByTestId('layout-preview-video-label');

    // The label `<text>` lives inside the group; its x/y must equal the slot
    // center. We compute the same midpoint and compare.
    const mapText = mapLabelGroup.querySelector('text');
    const videoText = videoLabelGroup.querySelector('text');
    expect(mapText).not.toBeNull();
    expect(videoText).not.toBeNull();

    const mapCx = resolved.map_slot.x + resolved.map_slot.w / 2;
    const mapCy = resolved.map_slot.y + resolved.map_slot.h / 2;
    expect(Number(mapText!.getAttribute('x'))).toBeCloseTo(mapCx, 5);
    expect(Number(mapText!.getAttribute('y'))).toBeCloseTo(mapCy, 5);
    expect(mapText!.textContent).toBe('Map');
    expect(videoText!.textContent).toBe('Video');
  });
});
