// DecorationPanel routing tests. Step 6 acceptance:
//   • Per-clip POV overrides round-trip through `MapOverrides.pov`
//   • Per-Waypoint color overrides round-trip through `Waypoint.color`
//   • Route Color in clip scope renders read-only with switch-to-project CTA
//
// We render the panel directly (bypassing MapToolbar) and assert on the
// onChange / onWaypointsChange callback payloads. Route-Color read-only and
// POV color writes both pass through `onChange(MapSettings)`; the parent
// (ProjectView) is what converts that to MapOverrides via `computeClipOverrides`.

import { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
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
    const coralSwatches = document.body.querySelectorAll('[data-testid="swatch-coral"]');
    // POV's swatch row is the only ColorSection in the POV panel.
    expect(coralSwatches.length).toBe(1);
    click(coralSwatches[0]);
    expect(onChange).toHaveBeenCalledTimes(1);
    const nextSettings = onChange.mock.calls[0][0] as MapSettings;
    expect(nextSettings.pov.color).toBe('#ff715b');
  });
});

describe('DecorationPanel — Route in clip scope', () => {
  it('renders read-only color block with a switch-to-project button', () => {
    const onScopeChange = vi.fn();
    render(
      <DecorationPanel
        {...baseProps({
          decoration: 'route',
          scope: 'clip',
          currentClip: makeClip('c1'),
          currentClipOrdinal: 1,
          onScopeChange,
        })}
      />,
    );
    const switchBtn = q('[data-testid="route-switch-to-project"]');
    expect(switchBtn).toBeTruthy();
    click(switchBtn!);
    expect(onScopeChange).toHaveBeenCalledWith('project');
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
    // Find the COLOR section's coral swatch — first matching coral swatch.
    const swatches = document.body.querySelectorAll('[data-testid="swatch-coral"]');
    expect(swatches.length).toBeGreaterThanOrEqual(1);
    click(swatches[0]);
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

  it('does NOT route waypoint color writes through MapSettings/onChange in clip scope', () => {
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
    const swatches = document.body.querySelectorAll('[data-testid="swatch-coral"]');
    click(swatches[0]);
    expect(onWaypointsChange).toHaveBeenCalledTimes(1);
    // The waypoint color path is per-entity, never per-clip.
    // onChange may still fire for other interactions (mode pickers); we only
    // assert that the color click did not produce a MapSettings write.
    const colorRelatedCalls = onChange.mock.calls.filter((call) => {
      const next = call[0] as MapSettings;
      return next.waypoints.color !== DEFAULT_MAP_SETTINGS.waypoints.color;
    });
    expect(colorRelatedCalls.length).toBe(0);
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
