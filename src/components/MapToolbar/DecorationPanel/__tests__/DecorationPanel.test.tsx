// DecorationPanel routing tests.
//   • Per-clip overrides round-trip through `MapOverrides` — every
//     MapSettings-derived control is editable in clip scope with full
//     capability parity (route color/gradient + all three halos included;
//     the old read-only / project-scope-only rules are retired)
//   • Per-Waypoint color/marker overrides round-trip through the `Waypoint`
//     entity and render as a SECOND stacked control in clip scope
//
// We render the panel directly (bypassing MapToolbar) and assert on the
// onChange / onWaypointsChange callback payloads. Settings-level writes pass
// through `onChange(MapSettings)`; the parent (ProjectView) is what converts
// that to MapOverrides via `computeClipOverrides`.

import { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

// jsdom has no Tauri runtime: `convertFileSrc` (marker-image thumbnails)
// and `invoke`/`open` (the import pipeline — never exercised here) need
// harmless stand-ins.
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
  invoke: vi.fn(async () => ({})),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
}));

import { DecorationPanel } from '../DecorationPanel';
import {
  DEFAULT_MAP_SETTINGS,
  type Clip,
  type MapSettings,
  type Waypoint,
} from '../../../../types';

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
  return document.body.querySelector(selector);
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function makeClip(id: string): Clip {
  return {
    id,
    path: `/tmp/${id}.mov`,
    filename: `${id}.mov`,
    created_at: '2025-01-01T00:00:00Z',
    duration_ms: 10000,
    gps: null,
    resolution: '1920x1080',
    frame_rate: 30,
    trim: null,
    focal_point: { x: 0.5, y: 0.5, zoom: 1 },
    effects: { stabilize: { enabled: false, shakiness: 5 }, speed: 1 },
    visible: true,
    map_overrides: null,
    // WS0 color metadata defaults.
    pix_fmt: null,
    color_primaries: null,
    color_trc: null,
    color_space: null,
    color_range: null,
    has_dolby_vision: false,
    camera_make: null,
    camera_model: null,
    source_color_class: 'unknown',
  };
}

function makeWaypoint(id: string, clipId: string | undefined): Waypoint {
  return {
    id,
    position: { kind: 'fixed', lat: 0, lng: 0 },
    label: id,
    source: 'clip',
    clip_id: clipId,
  };
}

function baseProps(over: Partial<React.ComponentProps<typeof DecorationPanel>> = {}) {
  return {
    decoration: 'pov' as const,
    settings: DEFAULT_MAP_SETTINGS,
    onChange: vi.fn() as (next: MapSettings) => void,
    scope: 'project' as const,
    overriddenKeys: null,
    onScopeChange: vi.fn(),
    onClose: vi.fn(),
    routeLoaded: true,
    currentClip: null,
    waypoints: [],
    onWaypointsChange: vi.fn() as (next: Waypoint[]) => void,
    onOpenWaypointsPanel: vi.fn(),
    triggerRef: { current: null } as React.RefObject<HTMLButtonElement | null>,
    currentClipOrdinal: null,
    indexedRoute: null,
    ...over,
  };
}

describe('DecorationPanel — POV', () => {
  it('renders a COLOR, PULSE, and SIZE section (no VISIBILITY)', () => {
    render(<DecorationPanel {...baseProps()} />);
    const text = document.body.textContent ?? '';
    expect(/COLOR/.test(text)).toBe(true);
    expect(/PULSE/.test(text)).toBe(true);
    expect(/SIZE/.test(text)).toBe(true);
    expect(/VISIBILITY/.test(text)).toBe(false);
  });

  it('routes a POV swatch click through onChange as a MapSettings update', () => {
    const onChange = vi.fn();
    render(<DecorationPanel {...baseProps({ onChange })} />);
    // POV panel now has two ColorSections: primary (`color`) and
    // secondary (`secondary_color`, the dot fill). Clicking the first
    // coral swatch is a primary edit; clicking the second is a secondary
    // edit. Verify both paths.
    const coralSwatches = document.body.querySelectorAll('[data-testid="swatch-coral"]');
    expect(coralSwatches.length).toBe(2);
    click(coralSwatches[0]);
    expect(onChange).toHaveBeenCalledTimes(1);
    const afterPrimary = onChange.mock.calls[0][0] as MapSettings;
    expect(afterPrimary.pov.color).toBe('#ff715b');
    click(coralSwatches[1]);
    expect(onChange).toHaveBeenCalledTimes(2);
    const afterSecondary = onChange.mock.calls[1][0] as MapSettings;
    expect(afterSecondary.pov.secondary_color).toBe('#ff715b');
  });
});

describe('DecorationPanel — Route in clip scope', () => {
  it('renders a single route line width control', () => {
    render(<DecorationPanel {...baseProps({ decoration: 'route' })} />);
    const text = document.body.textContent ?? '';
    expect(/Line/.test(text)).toBe(true);
    expect(/Full line/.test(text)).toBe(false);
    expect(/Trail line/.test(text)).toBe(false);
  });

  it('renders an EDITABLE color section in clip scope (route color is per-clip)', () => {
    const onChange = vi.fn();
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'route',
          scope: 'clip',
          currentClip: makeClip('c1'),
          currentClipOrdinal: 1,
          onChange,
        })}
      />,
    );
    // The old read-only block + switch-to-project CTA are retired.
    expect(q('[data-testid="route-switch-to-project"]')).toBeNull();
    const swatch = q('[data-testid="swatch-coral"]');
    expect(swatch).toBeTruthy();
    click(swatch!);
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as MapSettings;
    expect(next.route.color).toEqual({ mode: 'solid', solid: '#ff715b' });
  });

  it('shows the override pill for route.color and reset writes the project color back', () => {
    const onChange = vi.fn();
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      route: {
        ...DEFAULT_MAP_SETTINGS.route,
        color: { mode: 'solid', solid: '#ff715b' },
      },
    };
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'route',
          scope: 'clip',
          currentClip: makeClip('c1'),
          currentClipOrdinal: 1,
          settings,
          projectSettings: DEFAULT_MAP_SETTINGS,
          overriddenKeys: new Set(['route.color']),
          onChange,
        })}
      />,
    );
    expect(document.body.textContent).toMatch(/Clip · override/);
    const buttons = Array.from(document.body.querySelectorAll('button'));
    const reset = buttons.find((b) => b.textContent === '× Reset to project');
    expect(reset).toBeTruthy();
    click(reset!);
    const next = onChange.mock.calls[0][0] as MapSettings;
    expect(next.route.color).toEqual(DEFAULT_MAP_SETTINGS.route.color);
  });
});

describe('DecorationPanel — Waypoints in clip scope', () => {
  it('writes Waypoint.color via onWaypointsChange when a swatch is clicked', () => {
    const onWaypointsChange = vi.fn();
    const wp = makeWaypoint('wp-1', 'c1');
    const clip = makeClip('c1');
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          scope: 'clip',
          currentClip: clip,
          currentClipOrdinal: 1,
          waypoints: [wp],
          onWaypointsChange,
        })}
      />,
    );
    // Clip scope stacks two ColorSections in the COLOR section: [0] is the
    // clip-level all-waypoints control (routes through onChange), [1] is the
    // per-waypoint entity control (routes through onWaypointsChange).
    const sections = document.body.querySelectorAll('[data-testid="color-section"]');
    expect(sections.length).toBeGreaterThanOrEqual(2);
    const swatch = sections[1].querySelector('[data-testid="swatch-coral"]');
    expect(swatch).toBeTruthy();
    click(swatch!);
    expect(onWaypointsChange).toHaveBeenCalledTimes(1);
    const next = onWaypointsChange.mock.calls[0][0] as Waypoint[];
    expect(next.length).toBe(1);
    expect(next[0].id).toBe('wp-1');
    expect(next[0].color).toBe('#ff715b');
  });

  it('renders the no-waypoint note when no associated waypoint exists', () => {
    const onOpenWaypointsPanel = vi.fn();
    const clip = makeClip('c1');
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          scope: 'clip',
          currentClip: clip,
          currentClipOrdinal: 1,
          waypoints: [], // no associated waypoint
          onOpenWaypointsPanel,
        })}
      />,
    );
    const openBtn = q('[data-testid="open-waypoints-panel"]');
    expect(openBtn).toBeTruthy();
    click(openBtn!);
    expect(onOpenWaypointsPanel).toHaveBeenCalledTimes(1);
  });

  it('routes the two stacked clip-scope color controls to their own channels', () => {
    const onChange = vi.fn();
    const onWaypointsChange = vi.fn();
    const wp = makeWaypoint('wp-1', 'c1');
    const clip = makeClip('c1');
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          scope: 'clip',
          currentClip: clip,
          currentClipOrdinal: 1,
          waypoints: [wp],
          onChange,
          onWaypointsChange,
        })}
      />,
    );
    const sections = document.body.querySelectorAll('[data-testid="color-section"]');
    // [1] = per-waypoint entity control: writes the Waypoint, NOT MapSettings.
    click(sections[1].querySelector('[data-testid="swatch-coral"]')!);
    expect(onWaypointsChange).toHaveBeenCalledTimes(1);
    const colorRelatedCalls = onChange.mock.calls.filter((call) => {
      const next = call[0] as MapSettings;
      return next.waypoints.color !== DEFAULT_MAP_SETTINGS.waypoints.color;
    });
    expect(colorRelatedCalls.length).toBe(0);
    // [0] = clip-level all-waypoints control: writes MapSettings (the parent
    // diffs it into map_overrides.waypoints.color), NOT the Waypoint.
    click(sections[0].querySelector('[data-testid="swatch-coral"]')!);
    expect(onWaypointsChange).toHaveBeenCalledTimes(1); // unchanged
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as MapSettings;
    expect(next.waypoints.color).toEqual({ mode: 'solid', solid: '#ff715b' });
  });

  it('shows an override pill for the associated waypoint when it has a color', () => {
    const onWaypointsChange = vi.fn();
    const wp: Waypoint = { ...makeWaypoint('wp-1', 'c1'), color: '#ff715b' };
    const clip = makeClip('c1');
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          scope: 'clip',
          currentClip: clip,
          currentClipOrdinal: 1,
          waypoints: [wp],
          onWaypointsChange,
        })}
      />,
    );
    const text = document.body.textContent ?? '';
    expect(/Wp 1 · override/.test(text)).toBe(true);
  });
});

describe('DecorationPanel — POV in clip scope', () => {
  it('emits a MapSettings update on POV color swatch click (parent computes overrides)', () => {
    const onChange = vi.fn();
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'pov',
          scope: 'clip',
          currentClip: makeClip('c1'),
          currentClipOrdinal: 1,
          onChange,
        })}
      />,
    );
    const swatch = q('[data-testid="swatch-coral"]');
    click(swatch!);
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as MapSettings;
    expect(next.pov.color).toBe('#ff715b');
  });
});

describe('DecorationPanel — gradient routing (Route panel, project scope)', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it('toggling Solid → Gradient seeds two-endpoint stops from the current solid', () => {
    const onChange = vi.fn();
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'route',
          onChange,
          // routeLoaded=true + indexedRoute with positive totalMercatorMeters
          // means gradient is available.
          routeLoaded: true,
          indexedRoute: {
            points: [],
            minTimeMs: 0,
            maxTimeMs: 1000,
            cumulativeDistMeters: [0, 1000],
            totalDistMeters: 1000,
            cumulativeMercatorMeters: [0, 1000],
            totalMercatorMeters: 1000,
          },
        })}
      />,
    );
    const gradientBtn = document.body.querySelector('[data-testid="color-mode-gradient"]');
    expect(gradientBtn).toBeTruthy();
    click(gradientBtn!);
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0][0] as MapSettings;
    expect(next.route.color.mode).toBe('gradient');
    if (next.route.color.mode === 'gradient') {
      expect(next.route.color.stops.length).toBe(2);
      expect(next.route.color.stops[0].fraction).toBe(0);
      expect(next.route.color.stops[1].fraction).toBe(1);
      // Both seeded with the project default solid color.
      expect(next.route.color.stops[0].color).toBe('#bced09');
      expect(next.route.color.stops[1].color).toBe('#bced09');
    }
  });

  it('toggling Gradient → Solid stashes stops into color_stops_cache', () => {
    const onChange = vi.fn();
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      route: {
        ...DEFAULT_MAP_SETTINGS.route,
        color: {
          mode: 'gradient',
          stops: [
            { fraction: 0, color: '#ff715b' },
            { fraction: 1, color: '#2f52e0' },
          ],
        },
      },
    };
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'route',
          settings,
          onChange,
          routeLoaded: true,
        })}
      />,
    );
    const solidBtn = document.body.querySelector('[data-testid="color-mode-solid"]');
    click(solidBtn!);
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0][0] as MapSettings;
    expect(next.route.color.mode).toBe('solid');
    if (next.route.color.mode === 'solid') {
      // First stop's color wins.
      expect(next.route.color.solid).toBe('#ff715b');
    }
    // Cache preserved.
    expect(next.route.color_stops_cache).toBeDefined();
    expect(next.route.color_stops_cache?.length).toBe(2);
  });

  it('toggling Solid → Gradient with a cache restores the cached stops', () => {
    const onChange = vi.fn();
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      route: {
        ...DEFAULT_MAP_SETTINGS.route,
        color: { mode: 'solid', solid: '#bced09' },
        color_stops_cache: [
          { fraction: 0, color: '#ff715b' },
          { fraction: 0.5, color: '#f9cb40' },
          { fraction: 1, color: '#2f52e0' },
        ],
      },
    };
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'route',
          settings,
          onChange,
          routeLoaded: true,
          indexedRoute: {
            points: [],
            minTimeMs: 0,
            maxTimeMs: 1000,
            cumulativeDistMeters: [0, 1000],
            totalDistMeters: 1000,
            cumulativeMercatorMeters: [0, 1000],
            totalMercatorMeters: 1000,
          },
        })}
      />,
    );
    click(document.body.querySelector('[data-testid="color-mode-gradient"]')!);
    const next = onChange.mock.calls[0][0] as MapSettings;
    expect(next.route.color.mode).toBe('gradient');
    if (next.route.color.mode === 'gradient') {
      expect(next.route.color.stops.length).toBe(3);
      expect(next.route.color.stops[1].color).toBe('#f9cb40');
    }
  });

  it('Copy → Waypoints button copies Route stops into Waypoints', () => {
    const onChange = vi.fn();
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      route: {
        ...DEFAULT_MAP_SETTINGS.route,
        color: {
          mode: 'gradient',
          stops: [
            { fraction: 0, color: '#ff715b' },
            { fraction: 1, color: '#2f52e0' },
          ],
        },
      },
    };
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'route',
          settings,
          onChange,
          routeLoaded: true,
        })}
      />,
    );
    click(document.body.querySelector('[data-testid="gradient-copy-to-waypoints"]')!);
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0][0] as MapSettings;
    expect(next.waypoints.color.mode).toBe('gradient');
    if (next.waypoints.color.mode === 'gradient') {
      expect(next.waypoints.color.stops).toEqual([
        { fraction: 0, color: '#ff715b' },
        { fraction: 1, color: '#2f52e0' },
      ]);
    }
  });
});

describe('DecorationPanel — gradient routing (Waypoints panel, project scope)', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it('shows the gradient mode toggle in project scope', () => {
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          routeLoaded: true,
        })}
      />,
    );
    expect(document.body.querySelector('[data-testid="color-mode-toggle"]')).not.toBeNull();
  });

  it('hides ← Copy from Route when Route is solid', () => {
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          routeLoaded: true,
          // Waypoints in gradient mode so the action row is present, but
          // Route is in solid → no source to copy from.
          settings: {
            ...DEFAULT_MAP_SETTINGS,
            waypoints: {
              ...DEFAULT_MAP_SETTINGS.waypoints,
              color: {
                mode: 'gradient',
                stops: [
                  { fraction: 0, color: '#000000' },
                  { fraction: 1, color: '#ffffff' },
                ],
              },
            },
          },
        })}
      />,
    );
    expect(document.body.querySelector('[data-testid="gradient-copy-from-route"]')).toBeNull();
  });

  it('shows ← Copy from Route when Waypoints is in solid mode and Route is gradient with ≥ 2 stops', () => {
    // Reachability check: per `color-gradient.md` §9, the button must be
    // present even when Waypoints is solid — pressing it is the affordance
    // that flips Waypoints to gradient.
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          routeLoaded: true,
          settings: {
            ...DEFAULT_MAP_SETTINGS,
            route: {
              ...DEFAULT_MAP_SETTINGS.route,
              color: {
                mode: 'gradient',
                stops: [
                  { fraction: 0, color: '#ff715b' },
                  { fraction: 1, color: '#2f52e0' },
                ],
              },
            },
            // Waypoints stays solid.
            waypoints: {
              ...DEFAULT_MAP_SETTINGS.waypoints,
              color: { mode: 'solid', solid: '#f9cb40' },
            },
          },
        })}
      />,
    );
    expect(document.body.querySelector('[data-testid="gradient-copy-from-route"]')).not.toBeNull();
  });

  it('pressing ← Copy from Route in solid mode flips Waypoints to gradient and stashes the prior solid in color_stops_cache', () => {
    const onChange = vi.fn();
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          routeLoaded: true,
          onChange,
          settings: {
            ...DEFAULT_MAP_SETTINGS,
            route: {
              ...DEFAULT_MAP_SETTINGS.route,
              color: {
                mode: 'gradient',
                stops: [
                  { fraction: 0, color: '#ff715b' },
                  { fraction: 1, color: '#2f52e0' },
                ],
              },
            },
            waypoints: {
              ...DEFAULT_MAP_SETTINGS.waypoints,
              color: { mode: 'solid', solid: '#f9cb40' },
            },
          },
        })}
      />,
    );
    const btn = document.body.querySelector('[data-testid="gradient-copy-from-route"]');
    expect(btn).not.toBeNull();
    click(btn!);
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0][0] as MapSettings;
    expect(next.waypoints.color.mode).toBe('gradient');
    if (next.waypoints.color.mode === 'gradient') {
      // Route's stops are deep-copied into Waypoints.
      expect(next.waypoints.color.stops).toEqual([
        { fraction: 0, color: '#ff715b' },
        { fraction: 1, color: '#2f52e0' },
      ]);
    }
    // Prior solid preserved in cache so a future Gradient→Solid toggle
    // restores it (color-gradient.md §9 + §13).
    expect(next.waypoints.color_stops_cache).toBeDefined();
    expect(next.waypoints.color_stops_cache?.length).toBe(2);
    // The cached stops both carry the prior solid color.
    expect(next.waypoints.color_stops_cache?.[0].color).toBe('#f9cb40');
    expect(next.waypoints.color_stops_cache?.[1].color).toBe('#f9cb40');
  });

  it('shows ← Copy from Route when Route is gradient with ≥ 2 stops (Waypoints already gradient)', () => {
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          routeLoaded: true,
          settings: {
            ...DEFAULT_MAP_SETTINGS,
            route: {
              ...DEFAULT_MAP_SETTINGS.route,
              color: {
                mode: 'gradient',
                stops: [
                  { fraction: 0, color: '#ff715b' },
                  { fraction: 1, color: '#2f52e0' },
                ],
              },
            },
            waypoints: {
              ...DEFAULT_MAP_SETTINGS.waypoints,
              color: {
                mode: 'gradient',
                stops: [
                  { fraction: 0, color: '#000000' },
                  { fraction: 1, color: '#ffffff' },
                ],
              },
            },
          },
        })}
      />,
    );
    expect(document.body.querySelector('[data-testid="gradient-copy-from-route"]')).not.toBeNull();
  });
});

describe('DecorationPanel — gradient capability in clip scope', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it('Route panel clip scope renders the mode toggle (gradient per-clip parity)', () => {
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'route',
          scope: 'clip',
          currentClip: makeClip('c1'),
          currentClipOrdinal: 1,
          routeLoaded: true,
        })}
      />,
    );
    expect(document.body.querySelector('[data-testid="color-mode-toggle"]')).not.toBeNull();
  });

  it('Waypoints panel clip scope renders the mode toggle on the clip-level control only', () => {
    const wp = makeWaypoint('wp-1', 'c1');
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          scope: 'clip',
          currentClip: makeClip('c1'),
          currentClipOrdinal: 1,
          waypoints: [wp],
          routeLoaded: true,
        })}
      />,
    );
    const sections = document.body.querySelectorAll('[data-testid="color-section"]');
    // [0] clip-level all-waypoints control: full capability, toggle present.
    expect(sections[0].querySelector('[data-testid="color-mode-toggle"]')).not.toBeNull();
    // [1] per-waypoint entity control: solid-only, no toggle.
    expect(sections[1].querySelector('[data-testid="color-mode-toggle"]')).toBeNull();
  });

  it('POV panel never renders the mode toggle', () => {
    render(<DecorationPanel {...baseProps({ decoration: 'pov' })} />);
    expect(document.body.querySelector('[data-testid="color-mode-toggle"]')).toBeNull();
  });
});

describe('DecorationPanel — gradient availability without GPX', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it('disables the gradient segment when routeLoaded=false', () => {
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'route',
          routeLoaded: false,
          indexedRoute: null,
        })}
      />,
    );
    const btn = document.body.querySelector('[data-testid="color-mode-gradient"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(true);
  });
});

describe('DecorationPanel — scope banner', () => {
  it('renders the scope banner in clip scope', () => {
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'pov',
          scope: 'clip',
          currentClip: makeClip('c1'),
          currentClipOrdinal: 3,
        })}
      />,
    );
    const text = document.body.textContent ?? '';
    expect(/Clip 3 overrides/.test(text)).toBe(true);
  });

  it('omits the scope banner in project scope', () => {
    render(<DecorationPanel {...baseProps()} />);
    const text = document.body.textContent ?? '';
    expect(/overrides/.test(text)).toBe(false);
  });
});

// ============================================================================
// Step 8-UI — Waypoints marker gallery routing
// ============================================================================

describe('DecorationPanel — Waypoints marker gallery (project scope)', () => {
  it('renders the MARKER section between COLOR and SIZE in the Waypoints panel', () => {
    render(<DecorationPanel {...baseProps({ decoration: 'waypoints' })} />);
    const shapeSection = q('[data-testid="marker-section"]');
    expect(shapeSection).toBeTruthy();
    // All five shape cells render. `numbered-circle` was dropped in the
    // shape-descriptor refactor — numbering now rides on the label layer
    // regardless of shape, so the dedicated entry is gone.
    expect(q('[data-testid="waypoint-marker-cell-circle"]')).toBeTruthy();
    expect(q('[data-testid="waypoint-marker-cell-ring"]')).toBeTruthy();
    expect(q('[data-testid="waypoint-marker-cell-pin"]')).toBeTruthy();
    expect(q('[data-testid="waypoint-marker-cell-square"]')).toBeTruthy();
    expect(q('[data-testid="waypoint-marker-cell-diamond"]')).toBeTruthy();
  });

  it('writes mapSettings.waypoints.shape via onChange when a shape is clicked (project scope)', () => {
    const onChange = vi.fn();
    render(
      <DecorationPanel
        {...baseProps({ decoration: 'waypoints', onChange })}
      />,
    );
    click(q('[data-testid="waypoint-marker-cell-diamond"]')!);
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as MapSettings;
    expect(next.waypoints.shape).toBe('diamond');
  });

  it('selects the project default shape on the gallery', () => {
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      waypoints: { ...DEFAULT_MAP_SETTINGS.waypoints, shape: 'square' },
    };
    render(
      <DecorationPanel
        {...baseProps({ decoration: 'waypoints', settings })}
      />,
    );
    const square = q('[data-testid="waypoint-marker-cell-square"]') as HTMLElement;
    expect(square.getAttribute('aria-checked')).toBe('true');
  });
});

describe('DecorationPanel — Waypoints marker gallery (clip scope)', () => {
  it('routes the two stacked clip-scope marker galleries to their own channels', () => {
    const onChange = vi.fn();
    const onWaypointsChange = vi.fn();
    const wp = makeWaypoint('wp-1', 'c1');
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          scope: 'clip',
          currentClip: makeClip('c1'),
          currentClipOrdinal: 1,
          waypoints: [wp],
          onChange,
          onWaypointsChange,
        })}
      />,
    );
    // The per-waypoint gallery (associated- prefix) writes the Waypoint
    // entity, NOT MapSettings.
    click(q('[data-testid="associated-waypoint-marker-cell-diamond"]')!);
    expect(onWaypointsChange).toHaveBeenCalledTimes(1);
    const next = onWaypointsChange.mock.calls[0][0] as Waypoint[];
    expect(next.length).toBe(1);
    expect(next[0].id).toBe('wp-1');
    expect(next[0].shape).toBe('diamond');
    const shapeRelated = onChange.mock.calls.filter((call) => {
      const settings = call[0] as MapSettings;
      return settings.waypoints.shape !== DEFAULT_MAP_SETTINGS.waypoints.shape;
    });
    expect(shapeRelated.length).toBe(0);
    // The clip-level gallery (waypoint- prefix) writes MapSettings (the
    // parent diffs it into map_overrides.waypoints.marker), NOT the Waypoint.
    click(q('[data-testid="waypoint-marker-cell-square"]')!);
    expect(onWaypointsChange).toHaveBeenCalledTimes(1); // unchanged
    const clipLevel = onChange.mock.calls.at(-1)![0] as MapSettings;
    expect(clipLevel.waypoints.shape).toBe('square');
  });

  it('selects the project default when the associated waypoint has no shape override', () => {
    const wp = makeWaypoint('wp-1', 'c1');
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      waypoints: { ...DEFAULT_MAP_SETTINGS.waypoints, shape: 'pin' },
    };
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          scope: 'clip',
          currentClip: makeClip('c1'),
          currentClipOrdinal: 1,
          waypoints: [wp],
          settings,
        })}
      />,
    );
    const pin = q('[data-testid="waypoint-marker-cell-pin"]') as HTMLElement;
    expect(pin.getAttribute('aria-checked')).toBe('true');
  });

  it('selects the override (diamond) when the associated waypoint has shape=diamond', () => {
    const wp: Waypoint = { ...makeWaypoint('wp-1', 'c1'), shape: 'diamond' };
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      // Project default is circle, but the override wins.
      waypoints: { ...DEFAULT_MAP_SETTINGS.waypoints, shape: 'circle' },
    };
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          scope: 'clip',
          currentClip: makeClip('c1'),
          currentClipOrdinal: 1,
          waypoints: [wp],
          settings,
        })}
      />,
    );
    // Per-waypoint gallery: the entity override (diamond) wins.
    const diamond = q('[data-testid="associated-waypoint-marker-cell-diamond"]') as HTMLElement;
    expect(diamond.getAttribute('aria-checked')).toBe('true');
    const circle = q('[data-testid="associated-waypoint-marker-cell-circle"]') as HTMLElement;
    expect(circle.getAttribute('aria-checked')).toBe('false');
    // Clip-level gallery: shows the settings-level value (circle).
    const clipCircle = q('[data-testid="waypoint-marker-cell-circle"]') as HTMLElement;
    expect(clipCircle.getAttribute('aria-checked')).toBe('true');
  });

  it('shows an override pill when the associated waypoint has a shape override', () => {
    const wp: Waypoint = { ...makeWaypoint('wp-1', 'c1'), shape: 'pin' };
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          scope: 'clip',
          currentClip: makeClip('c1'),
          currentClipOrdinal: 1,
          waypoints: [wp],
        })}
      />,
    );
    // The override pill labels its scope as "Wp N · override". The COLOR
    // section also renders one when color is set, but in this fixture only
    // shape is set — so any pill that appears is the shape one.
    const text = document.body.textContent ?? '';
    expect(/Wp 1 · override/.test(text)).toBe(true);
    const clearBtn = q('[data-testid="marker-section-clear-override"]');
    expect(clearBtn).toBeTruthy();
  });

  it('"Reset to project" clears Waypoint.shape via onWaypointsChange', () => {
    const onWaypointsChange = vi.fn();
    const wp: Waypoint = { ...makeWaypoint('wp-1', 'c1'), shape: 'pin' };
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          scope: 'clip',
          currentClip: makeClip('c1'),
          currentClipOrdinal: 1,
          waypoints: [wp],
          onWaypointsChange,
        })}
      />,
    );
    click(q('[data-testid="marker-section-clear-override"]')!);
    expect(onWaypointsChange).toHaveBeenCalledTimes(1);
    const next = onWaypointsChange.mock.calls[0][0] as Waypoint[];
    expect(next.length).toBe(1);
    expect(next[0].id).toBe('wp-1');
    expect(next[0].shape).toBeUndefined();
  });

  it('renders the no-associated-waypoint note in the MARKER section when none exists', () => {
    const onOpenWaypointsPanel = vi.fn();
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          scope: 'clip',
          currentClip: makeClip('c1'),
          currentClipOrdinal: 1,
          waypoints: [], // no associated waypoint
          onOpenWaypointsPanel,
        })}
      />,
    );
    // The per-waypoint sub-block collapses to the CTA in every stacked
    // section; the clip-level controls stay (they don't need a waypoint).
    const ctas = document.body.querySelectorAll('[data-testid="open-waypoints-panel"]');
    expect(ctas.length).toBeGreaterThanOrEqual(1);
    // Clip-level gallery renders; the per-waypoint (associated-) gallery
    // does not.
    expect(q('[data-testid="waypoint-marker-cell-circle"]')).not.toBeNull();
    expect(q('[data-testid="associated-waypoint-marker-cell-circle"]')).toBeNull();
  });
});

describe('DecorationPanel — Waypoints SIZE rows', () => {
  it('always renders the Label size row regardless of shape', () => {
    // Post-refactor: labels live on a dedicated symbol layer and paint
    // independently of the shape silhouette, so the Label size control
    // is always meaningful. The pre-refactor `effectiveShape ===
    // 'numbered-circle'` gate is gone.
    for (const shape of ['circle', 'diamond', 'ring', 'pin', 'square'] as const) {
      const settings: MapSettings = {
        ...DEFAULT_MAP_SETTINGS,
        waypoints: { ...DEFAULT_MAP_SETTINGS.waypoints, shape },
      };
      render(
        <DecorationPanel {...baseProps({ decoration: 'waypoints', settings })} />,
      );
      const text = document.body.textContent ?? '';
      expect(text.includes('Label size'), `shape=${shape}`).toBe(true);
      act(() => root.unmount());
      root = createRoot(container);
    }
  });

  it('renders the Stroke size row (outline thickness for the secondary SDF slot)', () => {
    // Outline thickness is baked into the secondary SDF icon at rasterize
    // time; MapView re-registers the atlas when `stroke_width` changes.
    // The Stroke slider drives that field directly.
    render(<DecorationPanel {...baseProps({ decoration: 'waypoints' })} />);
    const text = document.body.textContent ?? '';
    expect(text.includes('Stroke')).toBe(true);
  });
});

describe('DecorationPanel — Waypoints SECONDARY COLOR section', () => {
  it('renders the SECONDARY COLOR section for shapes with a secondary slot', () => {
    // Every default shape except `ring` declares a secondary rasterizer.
    for (const shape of ['circle', 'pin', 'square', 'diamond'] as const) {
      const settings: MapSettings = {
        ...DEFAULT_MAP_SETTINGS,
        waypoints: { ...DEFAULT_MAP_SETTINGS.waypoints, shape },
      };
      render(
        <DecorationPanel {...baseProps({ decoration: 'waypoints', settings })} />,
      );
      const text = document.body.textContent ?? '';
      expect(text.includes('SECONDARY COLOR'), `shape=${shape}`).toBe(true);
      act(() => root.unmount());
      root = createRoot(container);
    }
  });

  it('hides the SECONDARY COLOR section for one-color shapes (ring)', () => {
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      waypoints: { ...DEFAULT_MAP_SETTINGS.waypoints, shape: 'ring' },
    };
    render(
      <DecorationPanel {...baseProps({ decoration: 'waypoints', settings })} />,
    );
    const text = document.body.textContent ?? '';
    expect(text.includes('SECONDARY COLOR')).toBe(false);
  });

  it('writes mapSettings.waypoints.secondary_color via onChange when a swatch is clicked', () => {
    const onChange = vi.fn();
    render(
      <DecorationPanel
        {...baseProps({ decoration: 'waypoints', onChange })}
      />,
    );
    // The Waypoints panel has two ColorSections in project scope: primary
    // (the COLOR section) and secondary (the SECONDARY COLOR section).
    // Clicking the second coral swatch is a secondary edit.
    const coralSwatches = document.body.querySelectorAll('[data-testid="swatch-coral"]');
    expect(coralSwatches.length).toBe(2);
    click(coralSwatches[1]);
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as MapSettings;
    expect(next.waypoints.secondary_color).toEqual({
      mode: 'solid',
      solid: '#ff715b',
    });
    // Primary slot untouched.
    expect(next.waypoints.color).toEqual(
      DEFAULT_MAP_SETTINGS.waypoints.color,
    );
  });
});

describe('DecorationPanel — POV marker gallery (schema v11)', () => {
  const IMAGE = {
    id: '0123456789abcdef',
    icon_file: 'assets/pov-icon-0123456789abcdef.png',
    source_file: 'assets/pov-source-0123456789abcdef.png',
    source_name: 'will.png',
    width: 300,
    height: 376,
  };
  const settingsWithImage = (): MapSettings => ({
    ...DEFAULT_MAP_SETTINGS,
    marker_images: [IMAGE],
    pov: {
      ...DEFAULT_MAP_SETTINGS.pov,
      marker: { kind: 'image', image_id: IMAGE.id },
    },
  });

  it('project scope, default: MARKER gallery with dot selected, presets + upload tile, dot sizes', () => {
    render(<DecorationPanel {...baseProps({ projectDir: '/tmp/p.trailcut' })} />);
    const text = document.body.textContent ?? '';
    expect(/MARKER/.test(text)).toBe(true);
    // POV presets: dot + the pov-domain shapes (no circle — the dot IS the
    // circle — and no pin, which is waypoint-only).
    const dot = q('[data-testid="pov-marker-cell-dot"]') as HTMLElement;
    expect(dot).toBeTruthy();
    expect(dot.getAttribute('aria-checked')).toBe('true');
    expect(q('[data-testid="pov-marker-cell-ring"]')).toBeTruthy();
    expect(q('[data-testid="pov-marker-cell-square"]')).toBeTruthy();
    expect(q('[data-testid="pov-marker-cell-diamond"]')).toBeTruthy();
    expect(q('[data-testid="pov-marker-cell-circle"]')).toBeNull();
    expect(q('[data-testid="pov-marker-cell-pin"]')).toBeNull();
    // The dotted "+" upload tile occupies the next slot.
    expect(q('[data-testid="marker-upload-tile"]')).toBeTruthy();
    // Dot-specific controls present, image size absent.
    expect(/Dot radius/.test(text)).toBe(true);
    expect(/Image size/.test(text)).toBe(false);
    expect(/SECONDARY COLOR/.test(text)).toBe(true);
  });

  it('clicking a shape preset writes pov.marker through onChange', () => {
    const onChange = vi.fn();
    render(
      <DecorationPanel
        {...baseProps({ onChange, projectDir: '/tmp/p.trailcut' })}
      />,
    );
    click(q('[data-testid="pov-marker-cell-ring"]')!);
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as MapSettings;
    expect(next.pov.marker).toEqual({ kind: 'shape', shape: 'ring' });
  });

  it('library images render as selectable tiles; clicking one writes an image marker', () => {
    const onChange = vi.fn();
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      marker_images: [IMAGE],
    };
    render(
      <DecorationPanel
        {...baseProps({ settings, onChange, projectDir: '/tmp/p.trailcut' })}
      />,
    );
    const tile = q(`[data-testid="pov-marker-cell-image:${IMAGE.id}"]`);
    expect(tile).toBeTruthy();
    click(tile!);
    const next = (onChange as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MapSettings;
    expect(next.pov.marker).toEqual({ kind: 'image', image_id: IMAGE.id });
  });

  it('image marker selected: image size row shown; dot rows and SECONDARY COLOR hidden', () => {
    render(
      <DecorationPanel
        {...baseProps({ settings: settingsWithImage(), projectDir: '/tmp/p.trailcut' })}
      />,
    );
    const text = document.body.textContent ?? '';
    const tile = q(
      `[data-testid="pov-marker-cell-image:${IMAGE.id}"]`,
    ) as HTMLElement;
    expect(tile.getAttribute('aria-checked')).toBe('true');
    expect(/Image size/.test(text)).toBe(true);
    // The dot is replaced: its radius/stroke and the dot-fill secondary
    // color hide to avoid dead controls.
    expect(/Dot radius/.test(text)).toBe(false);
    expect(/Dot stroke/.test(text)).toBe(false);
    expect(/SECONDARY COLOR/.test(text)).toBe(false);
    // Pulse controls stay — the rings are independent of the marker body.
    expect(/PULSE STYLE/.test(text)).toBe(true);
  });

  it('SDF shape preset selected: marker radius/outline rows; ring hides SECONDARY COLOR', () => {
    const ringSettings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      pov: {
        ...DEFAULT_MAP_SETTINGS.pov,
        marker: { kind: 'shape', shape: 'ring' },
      },
    };
    render(
      <DecorationPanel
        {...baseProps({ settings: ringSettings, projectDir: '/tmp/p.trailcut' })}
      />,
    );
    let text = document.body.textContent ?? '';
    expect(/Marker radius/.test(text)).toBe(true);
    expect(/Outline/.test(text)).toBe(true);
    expect(/SECONDARY COLOR/.test(text)).toBe(false);

    act(() => root.unmount());
    root = createRoot(container);
    const squareSettings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      pov: {
        ...DEFAULT_MAP_SETTINGS.pov,
        marker: { kind: 'shape', shape: 'square' },
      },
    };
    render(
      <DecorationPanel
        {...baseProps({ settings: squareSettings, projectDir: '/tmp/p.trailcut' })}
      />,
    );
    text = document.body.textContent ?? '';
    // Two-slot shapes keep the secondary (outline) color picker.
    expect(/SECONDARY COLOR/.test(text)).toBe(true);
  });

  it('clip scope: the gallery is offered (per-clip marker override) and writes through onChange', () => {
    const onChange = vi.fn();
    render(
      <DecorationPanel
        {...baseProps({
          settings: settingsWithImage(),
          scope: 'clip',
          currentClip: makeClip('clip-a'),
          currentClipOrdinal: 1,
          overriddenKeys: new Set(),
          onChange,
          projectDir: '/tmp/p.trailcut',
        })}
      />,
    );
    const cell = q('[data-testid="pov-marker-cell-diamond"]');
    expect(cell).toBeTruthy();
    click(cell!);
    const next = (onChange as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MapSettings;
    expect(next.pov.marker).toEqual({ kind: 'shape', shape: 'diamond' });
  });

  it('clip scope: override pill shows for pov.marker and reset writes the project marker back', () => {
    const onChange = vi.fn();
    render(
      <DecorationPanel
        {...baseProps({
          settings: settingsWithImage(),
          scope: 'clip',
          currentClip: makeClip('clip-a'),
          currentClipOrdinal: 1,
          overriddenKeys: new Set(['pov.marker']),
          projectSettings: DEFAULT_MAP_SETTINGS,
          onChange,
          projectDir: '/tmp/p.trailcut',
        })}
      />,
    );
    expect(document.body.textContent).toMatch(/Clip · override/);
    click(q('[data-testid="marker-section-clear-override"]')!);
    const next = (onChange as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MapSettings;
    expect(next.pov.marker).toEqual({ kind: 'shape', shape: 'dot' });
  });

  it('right-clicking an image tile opens the confirm dialog; confirming fires onMarkerImageDelete', () => {
    const onMarkerImageDelete = vi.fn();
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      marker_images: [IMAGE],
    };
    render(
      <DecorationPanel
        {...baseProps({
          settings,
          onMarkerImageDelete,
          projectDir: '/tmp/p.trailcut',
        })}
      />,
    );
    const tile = q(`[data-testid="pov-marker-cell-image:${IMAGE.id}"]`)!;
    act(() => {
      tile.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    });
    const text = document.body.textContent ?? '';
    expect(/Delete marker image\?/.test(text)).toBe(true);
    expect(/reverts to the default marker/.test(text)).toBe(true);
    // Confirm.
    const buttons = Array.from(document.body.querySelectorAll('button'));
    const confirm = buttons.find((b) => b.textContent === 'Delete')!;
    click(confirm);
    expect(onMarkerImageDelete).toHaveBeenCalledWith(IMAGE.id);
  });

  it('right-clicking a PRESET does nothing (presets are not deletable)', () => {
    const onMarkerImageDelete = vi.fn();
    render(
      <DecorationPanel
        {...baseProps({ onMarkerImageDelete, projectDir: '/tmp/p.trailcut' })}
      />,
    );
    const dot = q('[data-testid="pov-marker-cell-dot"]')!;
    act(() => {
      dot.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    });
    expect(/Delete marker image\?/.test(document.body.textContent ?? '')).toBe(false);
    expect(onMarkerImageDelete).not.toHaveBeenCalled();
  });
});

describe('DecorationPanel — Waypoints marker images (schema v11)', () => {
  const IMAGE = {
    id: 'fedcba9876543210',
    icon_file: 'assets/marker-icon-fedcba9876543210.png',
    source_file: 'assets/marker-source-fedcba9876543210.png',
    source_name: 'flag.png',
    width: 128,
    height: 128,
  };

  it('the shared library renders in the waypoint gallery too; selecting writes marker_image_id', () => {
    const onChange = vi.fn();
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      marker_images: [IMAGE],
    };
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          settings,
          onChange,
          projectDir: '/tmp/p.trailcut',
        })}
      />,
    );
    const tile = q(`[data-testid="waypoint-marker-cell-image:${IMAGE.id}"]`);
    expect(tile).toBeTruthy();
    click(tile!);
    const next = (onChange as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MapSettings;
    expect(next.waypoints.marker_image_id).toBe(IMAGE.id);
    // Shape stays as the fallback a later delete reverts to.
    expect(next.waypoints.shape).toBe(DEFAULT_MAP_SETTINGS.waypoints.shape);
  });

  it('picking a shape clears the project marker_image_id (mutually exclusive)', () => {
    const onChange = vi.fn();
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      marker_images: [IMAGE],
      waypoints: {
        ...DEFAULT_MAP_SETTINGS.waypoints,
        marker_image_id: IMAGE.id,
      },
    };
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          settings,
          onChange,
          projectDir: '/tmp/p.trailcut',
        })}
      />,
    );
    // The image is the effective selection…
    const tile = q(
      `[data-testid="waypoint-marker-cell-image:${IMAGE.id}"]`,
    ) as HTMLElement;
    expect(tile.getAttribute('aria-checked')).toBe('true');
    // …and choosing a shape clears it.
    click(q('[data-testid="waypoint-marker-cell-diamond"]')!);
    const next = (onChange as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MapSettings;
    expect(next.waypoints.shape).toBe('diamond');
    expect(next.waypoints.marker_image_id).toBeUndefined();
  });

  it('clip scope: image tile writes Waypoint.marker_image_id and clears Waypoint.shape', () => {
    const onWaypointsChange = vi.fn();
    const wp: Waypoint = { ...makeWaypoint('wp-1', 'c1'), shape: 'pin' };
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      marker_images: [IMAGE],
    };
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          scope: 'clip',
          currentClip: makeClip('c1'),
          currentClipOrdinal: 1,
          waypoints: [wp],
          settings,
          onWaypointsChange,
          projectDir: '/tmp/p.trailcut',
        })}
      />,
    );
    click(q(`[data-testid="associated-waypoint-marker-cell-image:${IMAGE.id}"]`)!);
    const next = (onWaypointsChange as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Waypoint[];
    expect(next[0].marker_image_id).toBe(IMAGE.id);
    expect(next[0].shape).toBeUndefined();
  });

  it('clip scope: "Reset to project" clears BOTH Waypoint.shape and Waypoint.marker_image_id', () => {
    const onWaypointsChange = vi.fn();
    const wp: Waypoint = {
      ...makeWaypoint('wp-1', 'c1'),
      marker_image_id: IMAGE.id,
    };
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      marker_images: [IMAGE],
    };
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          scope: 'clip',
          currentClip: makeClip('c1'),
          currentClipOrdinal: 1,
          waypoints: [wp],
          settings,
          onWaypointsChange,
          projectDir: '/tmp/p.trailcut',
        })}
      />,
    );
    expect(document.body.textContent).toMatch(/Wp 1 · override/);
    click(q('[data-testid="marker-section-clear-override"]')!);
    const next = (onWaypointsChange as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Waypoint[];
    expect(next[0].shape).toBeUndefined();
    expect(next[0].marker_image_id).toBeUndefined();
  });

  it('image marker hides SECONDARY COLOR and captions COLOR', () => {
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      marker_images: [IMAGE],
      waypoints: {
        ...DEFAULT_MAP_SETTINGS.waypoints,
        marker_image_id: IMAGE.id,
      },
    };
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          settings,
          projectDir: '/tmp/p.trailcut',
        })}
      />,
    );
    const text = document.body.textContent ?? '';
    expect(/SECONDARY COLOR/.test(text)).toBe(false);
    expect(/image draws in its own colors/.test(text)).toBe(true);
  });
});

describe('DecorationPanel — Route HALO section', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  /** Locate a SizeRow/PercentRow container by its label span. */
  function rowByLabel(label: string): Element {
    const spans = Array.from(document.body.querySelectorAll('span'));
    const target = spans.find((s) => s.textContent === label);
    expect(target, `row labeled "${label}" must exist`).toBeTruthy();
    return target!.parentElement!;
  }

  function haloOnSettings(): MapSettings {
    return {
      ...DEFAULT_MAP_SETTINGS,
      route: {
        ...DEFAULT_MAP_SETTINGS.route,
        halo: {
          enabled: true,
          color: { mode: 'solid', solid: '#ffffff' },
          size: 0.004,
          fade: 0.5,
          opacity: 0.6,
        },
      },
    };
  }

  it('renders the HALO section with the toggle Off by default (no sub-controls)', () => {
    render(<DecorationPanel {...baseProps({ decoration: 'route' })} />);
    const text = document.body.textContent ?? '';
    expect(/HALO/.test(text)).toBe(true);
    // Off state: no spread/fade/opacity rows, single ColorSection (route's).
    expect(/Spread/.test(text)).toBe(false);
    expect(/Fade/.test(text)).toBe(false);
    expect(/Opacity/.test(text)).toBe(false);
    expect(q('[data-testid="route-halo-color"]')).toBeNull();
  });

  it('renders in clip scope (per-clip overridable) and shows the override pill + reset', () => {
    const onChange = vi.fn();
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'route',
          scope: 'clip',
          currentClip: makeClip('c1'),
          currentClipOrdinal: 1,
          settings: haloOnSettings(),
          projectSettings: DEFAULT_MAP_SETTINGS,
          overriddenKeys: new Set(['route.halo']),
          onChange,
        })}
      />,
    );
    const text = document.body.textContent ?? '';
    expect(/HALO/.test(text)).toBe(true);
    expect(/Clip · override/.test(text)).toBe(true);
    // Reset writes the project halo (absent) back through onChange, so the
    // parent's diff collapses the override to nothing.
    const buttons = Array.from(document.body.querySelectorAll('button'));
    const reset = buttons.find((b) => b.textContent === '× Reset to project');
    expect(reset).toBeTruthy();
    click(reset!);
    const next = onChange.mock.calls[0][0] as MapSettings;
    expect(next.route.halo).toBeUndefined();
  });

  it('toggling On with no stored halo seeds DEFAULT_ROUTE_HALO', () => {
    const onChange = vi.fn();
    render(<DecorationPanel {...baseProps({ decoration: 'route', onChange })} />);
    const radios = Array.from(
      document.body.querySelectorAll('[role="radio"]'),
    );
    const onBtn = radios.find((r) => r.textContent === 'On');
    expect(onBtn).toBeTruthy();
    click(onBtn!);
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as MapSettings;
    expect(next.route.halo).toEqual({
      enabled: true,
      color: { mode: 'solid', solid: '#ffffff' },
      size: 0.004,
      fade: 0.5,
      opacity: 0.6,
      falloff: 0,
      offset_x: 0,
      offset_y: 0,
    });
  });

  it('toggling Off preserves the stored config (enabled flips false in place)', () => {
    const onChange = vi.fn();
    const settings = haloOnSettings();
    render(
      <DecorationPanel {...baseProps({ decoration: 'route', settings, onChange })} />,
    );
    const radios = Array.from(
      document.body.querySelectorAll('[role="radio"]'),
    );
    const offBtn = radios.find((r) => r.textContent === 'Off');
    click(offBtn!);
    const next = onChange.mock.calls[0][0] as MapSettings;
    expect(next.route.halo).toEqual({
      ...settings.route.halo,
      enabled: false,
    });
  });

  it('enabled halo renders its own scoped ColorSection; a swatch click writes halo.color only', () => {
    const onChange = vi.fn();
    render(
      <DecorationPanel
        {...baseProps({ decoration: 'route', settings: haloOnSettings(), onChange })}
      />,
    );
    const haloColor = q('[data-testid="route-halo-color"]');
    expect(haloColor).toBeTruthy();
    // Scope the query to the halo wrapper — the route COLOR section above
    // mounts its own ColorSection with identical internal testids.
    const coral = haloColor!.querySelector('[data-testid="swatch-coral"]');
    expect(coral).toBeTruthy();
    click(coral!);
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as MapSettings;
    expect(next.route.halo?.color).toEqual({ mode: 'solid', solid: '#ff715b' });
    // The route line's own color is untouched.
    expect(next.route.color).toEqual(DEFAULT_MAP_SETTINGS.route.color);
  });

  it('Spread stepper writes route.halo.size (stored fraction of 1080)', () => {
    const onChange = vi.fn();
    render(
      <DecorationPanel
        {...baseProps({ decoration: 'route', settings: haloOnSettings(), onChange })}
      />,
    );
    // 0.004 × 1080 = 4.32 px displayed; up arrow adds the 0.5-px step.
    const upBtn = rowByLabel('Spread').querySelectorAll('button')[0];
    click(upBtn);
    const next = onChange.mock.calls[0][0] as MapSettings;
    expect(next.route.halo?.size).toBeCloseTo((4.3 + 0.5) / 1080, 9);
  });

  it('Fade and Opacity steppers write 0–1 fractions from the 0–100% display', () => {
    const onChange = vi.fn();
    render(
      <DecorationPanel
        {...baseProps({ decoration: 'route', settings: haloOnSettings(), onChange })}
      />,
    );
    // Fade shows 50%; up arrow steps +5 → 0.55 stored.
    click(rowByLabel('Fade').querySelectorAll('button')[0]);
    const afterFade = onChange.mock.calls[0][0] as MapSettings;
    expect(afterFade.route.halo?.fade).toBeCloseTo(0.55, 9);
    // Opacity shows 60%; down arrow steps -5 → 0.55 stored.
    click(rowByLabel('Opacity').querySelectorAll('button')[1]);
    const afterOpacity = onChange.mock.calls[1][0] as MapSettings;
    expect(afterOpacity.route.halo?.opacity).toBeCloseTo(0.55, 9);
  });

  it('Falloff stepper writes route.halo.falloff as a 0–1 fraction (absent reads as 0%)', () => {
    const onChange = vi.fn();
    render(
      <DecorationPanel
        {...baseProps({ decoration: 'route', settings: haloOnSettings(), onChange })}
      />,
    );
    // The stored halo block predates the falloff field — displays 0%; up
    // arrow steps +5 → 0.05 stored (written explicitly on first edit).
    click(rowByLabel('Falloff').querySelectorAll('button')[0]);
    const next = onChange.mock.calls[0][0] as MapSettings;
    expect(next.route.halo?.falloff).toBeCloseTo(0.05, 9);
  });

  it('Offset X / Offset Y steppers write signed reference fractions', () => {
    const onChange = vi.fn();
    render(
      <DecorationPanel
        {...baseProps({ decoration: 'route', settings: haloOnSettings(), onChange })}
      />,
    );
    // Absent offsets display 0 px; up arrow adds the 0.5-px step.
    click(rowByLabel('Offset X').querySelectorAll('button')[0]);
    const afterX = onChange.mock.calls[0][0] as MapSettings;
    expect(afterX.route.halo?.offset_x).toBeCloseTo(0.5 / 1080, 9);
    // Down arrow goes NEGATIVE — the offset range is symmetric around 0.
    click(rowByLabel('Offset Y').querySelectorAll('button')[1]);
    const afterY = onChange.mock.calls[1][0] as MapSettings;
    expect(afterY.route.halo?.offset_y).toBeCloseTo(-0.5 / 1080, 9);
  });

  it('halo Solid → Gradient toggle seeds stops and stays off the route color', () => {
    const onChange = vi.fn();
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'route',
          settings: haloOnSettings(),
          onChange,
          routeLoaded: true,
          indexedRoute: {
            points: [],
            minTimeMs: 0,
            maxTimeMs: 1000,
            cumulativeDistMeters: [0, 1000],
            totalDistMeters: 1000,
            cumulativeMercatorMeters: [0, 1000],
            totalMercatorMeters: 1000,
          },
        })}
      />,
    );
    const haloColor = q('[data-testid="route-halo-color"]');
    const gradientBtn = haloColor!.querySelector('[data-testid="color-mode-gradient"]');
    expect(gradientBtn).toBeTruthy();
    click(gradientBtn!);
    const next = onChange.mock.calls[0][0] as MapSettings;
    expect(next.route.halo?.color.mode).toBe('gradient');
    if (next.route.halo?.color.mode === 'gradient') {
      expect(next.route.halo.color.stops.length).toBe(2);
      // Seeded from the halo's current solid (white), not the route's.
      expect(next.route.halo.color.stops[0].color).toBe('#ffffff');
    }
    expect(next.route.color).toEqual(DEFAULT_MAP_SETTINGS.route.color);
  });
});

describe('DecorationPanel — Waypoints + POV HALO sections', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  /** Find the halo toggle's On/Off radio inside the group with the given
   *  aria-label (the POV/Waypoints panels mount several radio groups —
   *  pulse style, marker gallery — so the query must scope by label). */
  function haloToggleButton(ariaLabel: string, text: 'On' | 'Off'): Element {
    const group = q(`[aria-label="${ariaLabel}"]`);
    expect(group, `radio group "${ariaLabel}" must exist`).toBeTruthy();
    const btn = Array.from(group!.querySelectorAll('[role="radio"]')).find(
      (r) => r.textContent === text,
    );
    expect(btn, `"${text}" radio in "${ariaLabel}"`).toBeTruthy();
    return btn!;
  }

  it('waypoints panel (project scope): toggling On seeds DEFAULT_MARKER_HALO on waypoints.halo', () => {
    const onChange = vi.fn();
    render(
      <DecorationPanel {...baseProps({ decoration: 'waypoints', onChange })} />,
    );
    click(haloToggleButton('Waypoints halo', 'On'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as MapSettings;
    expect(next.waypoints.halo).toEqual({
      enabled: true,
      color: { mode: 'solid', solid: '#ffffff' },
      size: 0.006,
      fade: 0.5,
      opacity: 0.6,
      falloff: 0,
      offset_x: 0,
      offset_y: 0,
    });
    // Route and POV halos are untouched — the three blocks are independent.
    expect(next.route.halo).toBeUndefined();
    expect(next.pov.halo).toBeUndefined();
  });

  it('waypoints halo renders in clip scope (per-clip overridable)', () => {
    const onChange = vi.fn();
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          scope: 'clip',
          currentClip: makeClip('c1'),
          currentClipOrdinal: 1,
          onChange,
        })}
      />,
    );
    expect(q('[aria-label="Waypoints halo"]')).not.toBeNull();
    // Toggling On in clip scope seeds the same default block — the parent
    // diffs it into map_overrides.waypoints.halo.
    click(haloToggleButton('Waypoints halo', 'On'));
    const next = onChange.mock.calls[0][0] as MapSettings;
    expect(next.waypoints.halo?.enabled).toBe(true);
  });

  it('pov halo renders in clip scope (per-clip overridable)', () => {
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'pov',
          scope: 'clip',
          currentClip: makeClip('c1'),
          currentClipOrdinal: 1,
        })}
      />,
    );
    expect(q('[aria-label="POV halo"]')).not.toBeNull();
  });

  it('enabled waypoints halo mounts a gradient-capable scoped ColorSection', () => {
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      waypoints: {
        ...DEFAULT_MAP_SETTINGS.waypoints,
        halo: {
          enabled: true,
          color: { mode: 'solid', solid: '#ffffff' },
          size: 0.006,
          fade: 0.5,
          opacity: 0.6,
        },
      },
    };
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'waypoints',
          settings,
          routeLoaded: true,
          indexedRoute: {
            points: [],
            minTimeMs: 0,
            maxTimeMs: 1000,
            cumulativeDistMeters: [0, 1000],
            totalDistMeters: 1000,
            cumulativeMercatorMeters: [0, 1000],
            totalMercatorMeters: 1000,
          },
        })}
      />,
    );
    const haloColor = q('[data-testid="waypoints-halo-color"]');
    expect(haloColor).toBeTruthy();
    // Gradient-capable: the solid/gradient mode toggle is present.
    expect(
      haloColor!.querySelector('[data-testid="color-mode-gradient"]'),
    ).toBeTruthy();
  });

  it('pov panel (project scope): toggling On seeds DEFAULT_MARKER_HALO on pov.halo', () => {
    const onChange = vi.fn();
    render(<DecorationPanel {...baseProps({ decoration: 'pov', onChange })} />);
    click(haloToggleButton('POV halo', 'On'));
    const next = onChange.mock.calls[0][0] as MapSettings;
    expect(next.pov.halo?.enabled).toBe(true);
    expect(next.pov.halo?.size).toBeCloseTo(0.006, 12);
    expect(next.waypoints.halo).toBeUndefined();
  });

  it('enabled POV halo ColorSection is solid-only (no gradient mode toggle)', () => {
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      pov: {
        ...DEFAULT_MAP_SETTINGS.pov,
        halo: {
          enabled: true,
          color: { mode: 'solid', solid: '#ffffff' },
          size: 0.006,
          fade: 0.5,
          opacity: 0.6,
        },
      },
    };
    render(<DecorationPanel {...baseProps({ decoration: 'pov', settings })} />);
    const haloColor = q('[data-testid="pov-halo-color"]');
    expect(haloColor).toBeTruthy();
    expect(
      haloColor!.querySelector('[data-testid="color-mode-gradient"]'),
    ).toBeNull();
  });
});
