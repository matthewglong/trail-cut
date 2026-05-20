import { act } from 'react';
import type { ComponentProps } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import MapToolbar from './MapToolbar';
import { DEFAULT_MAP_SETTINGS, type MapSettings, type Waypoint } from '../../types';

let container: HTMLDivElement;
let root: Root;
let originalResizeObserver: typeof ResizeObserver | undefined;
let originalRequestAnimationFrame: typeof requestAnimationFrame | undefined;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  originalResizeObserver = globalThis.ResizeObserver;
  originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  }) as typeof requestAnimationFrame;

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  globalThis.ResizeObserver = originalResizeObserver as typeof ResizeObserver;
  globalThis.requestAnimationFrame = originalRequestAnimationFrame as typeof requestAnimationFrame;
});

function renderToolbar(over: Partial<ComponentProps<typeof MapToolbar>> = {}) {
  const onChange = vi.fn() as (next: MapSettings) => void;
  const onWaypointsChange = vi.fn() as (next: Waypoint[]) => void;
  act(() => {
    root.render(
      <MapToolbar
        settings={DEFAULT_MAP_SETTINGS}
        onChange={onChange}
        routeLoaded
        scope="project"
        onScopeChange={vi.fn()}
        overriddenKeys={null}
        onOpenPositioning={vi.fn()}
        onOpenWaypointsPanel={vi.fn()}
        currentClip={null}
        currentClipOrdinal={null}
        waypoints={[]}
        onWaypointsChange={onWaypointsChange}
        indexedRoute={null}
        {...over}
      />,
    );
  });
}

function q(selector: string): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(selector);
  expect(el).toBeTruthy();
  return el!;
}

function mouseDown(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('MapToolbar decoration triggers', () => {
  it('removes the open background and blurs the trigger when the same button closes', () => {
    renderToolbar();
    const route = q('[data-testid="decoration-trigger-route"]');

    click(route);
    route.focus();
    expect(route.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(route);

    mouseDown(route);
    click(route);

    expect(route.getAttribute('aria-expanded')).toBe('false');
    expect(route.style.backgroundColor).toBe('transparent');
    expect(document.activeElement).not.toBe(route);
  });

  it('keeps Escape focus restoration while still clearing the open background', () => {
    renderToolbar();
    const waypoints = q('[data-testid="decoration-trigger-waypoints"]');

    click(waypoints);
    expect(waypoints.getAttribute('aria-expanded')).toBe('true');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(waypoints.getAttribute('aria-expanded')).toBe('false');
    expect(waypoints.style.backgroundColor).toBe('transparent');
    expect(document.activeElement).toBe(waypoints);
  });
});
