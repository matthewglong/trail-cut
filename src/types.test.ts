// resolveMapSettings invariant tests.
//
// `resolveMapSettings` is the renderer's contract — a malformed gradient on
// disk (hand-edited project.json, partial migration, bug in a sibling
// branch) must degrade gracefully rather than crash the rendering pipeline.
// The validator in `validateGradient` falls back to solid; these tests pin
// the exact failure modes.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAP_SETTINGS,
  resolveMapSettings,
  type GradientStop,
  type MapSettings,
} from './types';

function withRouteColor(color: MapSettings['route']['color']): MapSettings {
  return {
    ...DEFAULT_MAP_SETTINGS,
    route: { ...DEFAULT_MAP_SETTINGS.route, color },
  };
}

describe('resolveMapSettings — gradient invariants', () => {
  it('passes a valid 2-stop gradient through unchanged', () => {
    const stops: GradientStop[] = [
      { fraction: 0, color: '#ff715b' },
      { fraction: 1, color: '#2f52e0' },
    ];
    const defaults = withRouteColor({ mode: 'gradient', stops });
    const resolved = resolveMapSettings(defaults, null);
    expect(resolved.route.color.mode).toBe('gradient');
    if (resolved.route.color.mode === 'gradient') {
      expect(resolved.route.color.stops).toEqual(stops);
    }
  });

  it('passes a valid 3-stop gradient through (with defensive sort)', () => {
    // Out-of-order input — validator sorts before checking separation.
    const defaults = withRouteColor({
      mode: 'gradient',
      stops: [
        { fraction: 0, color: '#000000' },
        { fraction: 1, color: '#ffffff' },
        { fraction: 0.5, color: '#888888' },
      ],
    });
    const resolved = resolveMapSettings(defaults, null);
    expect(resolved.route.color.mode).toBe('gradient');
    if (resolved.route.color.mode === 'gradient') {
      expect(resolved.route.color.stops.map((s) => s.fraction)).toEqual([0, 0.5, 1]);
    }
  });

  it('falls back to solid when fewer than 2 stops', () => {
    const defaults = withRouteColor({
      mode: 'gradient',
      stops: [{ fraction: 0, color: '#ff715b' }],
    });
    const resolved = resolveMapSettings(defaults, null);
    expect(resolved.route.color.mode).toBe('solid');
    if (resolved.route.color.mode === 'solid') {
      expect(resolved.route.color.solid).toBe('#ff715b');
    }
  });

  it('falls back to solid when no fraction === 0 endpoint', () => {
    const defaults = withRouteColor({
      mode: 'gradient',
      stops: [
        { fraction: 0.1, color: '#ff715b' },
        { fraction: 1, color: '#2f52e0' },
      ],
    });
    const resolved = resolveMapSettings(defaults, null);
    expect(resolved.route.color.mode).toBe('solid');
  });

  it('falls back to solid when no fraction === 1 endpoint', () => {
    const defaults = withRouteColor({
      mode: 'gradient',
      stops: [
        { fraction: 0, color: '#ff715b' },
        { fraction: 0.9, color: '#2f52e0' },
      ],
    });
    const resolved = resolveMapSettings(defaults, null);
    expect(resolved.route.color.mode).toBe('solid');
  });

  it('falls back to solid when adjacent stops are within 0.005', () => {
    const defaults = withRouteColor({
      mode: 'gradient',
      stops: [
        { fraction: 0, color: '#000000' },
        { fraction: 0.5, color: '#888888' },
        { fraction: 0.503, color: '#999999' }, // sub-0.005 gap
        { fraction: 1, color: '#ffffff' },
      ],
    });
    const resolved = resolveMapSettings(defaults, null);
    expect(resolved.route.color.mode).toBe('solid');
  });

  it('falls back to solid when a fraction is out of [0, 1]', () => {
    const defaults = withRouteColor({
      mode: 'gradient',
      stops: [
        { fraction: 0, color: '#000000' },
        { fraction: 1.2, color: '#ffffff' },
      ],
    });
    const resolved = resolveMapSettings(defaults, null);
    expect(resolved.route.color.mode).toBe('solid');
  });

  it('falls back to solid when a color is malformed', () => {
    const defaults = withRouteColor({
      mode: 'gradient',
      stops: [
        { fraction: 0, color: 'not-a-color' },
        { fraction: 1, color: '#ffffff' },
      ],
    });
    const resolved = resolveMapSettings(defaults, null);
    expect(resolved.route.color.mode).toBe('solid');
    if (resolved.route.color.mode === 'solid') {
      // The fallback's `solid` should be the project default since the
      // first stop's color was unparseable.
      expect(resolved.route.color.solid).toBe('#bced09');
    }
  });

  it('does not throw on a completely degenerate gradient', () => {
    // `stops` typed as array but empty — defensive fallback should still
    // produce a renderable settings.
    const defaults = withRouteColor({
      mode: 'gradient',
      stops: [],
    });
    expect(() => resolveMapSettings(defaults, null)).not.toThrow();
    const resolved = resolveMapSettings(defaults, null);
    expect(resolved.route.color.mode).toBe('solid');
  });

  it('preserves solid mode untouched', () => {
    const defaults = withRouteColor({ mode: 'solid', solid: '#ff715b' });
    const resolved = resolveMapSettings(defaults, null);
    expect(resolved.route.color.mode).toBe('solid');
    if (resolved.route.color.mode === 'solid') {
      expect(resolved.route.color.solid).toBe('#ff715b');
    }
  });

  it('applies the same validation to waypoints.color', () => {
    const defaults: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      waypoints: {
        ...DEFAULT_MAP_SETTINGS.waypoints,
        color: {
          mode: 'gradient',
          stops: [{ fraction: 0.1, color: '#ff715b' }],
        },
      },
    };
    const resolved = resolveMapSettings(defaults, null);
    expect(resolved.waypoints.color.mode).toBe('solid');
  });

  it('merges per-clip overrides while still validating colors', () => {
    const defaults = withRouteColor({
      mode: 'gradient',
      stops: [
        { fraction: 0, color: '#ff715b' },
        { fraction: 1, color: '#2f52e0' },
      ],
    });
    const resolved = resolveMapSettings(defaults, {
      route: { mode: 'visited' },
    });
    expect(resolved.route.mode).toBe('visited');
    expect(resolved.route.color.mode).toBe('gradient');
  });
});

describe('resolveMapSettings — color_stops_cache passthrough', () => {
  it('preserves color_stops_cache on RouteSettings', () => {
    const cache: GradientStop[] = [
      { fraction: 0, color: '#000000' },
      { fraction: 1, color: '#ffffff' },
    ];
    const defaults: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      route: {
        ...DEFAULT_MAP_SETTINGS.route,
        color: { mode: 'solid', solid: '#bced09' },
        color_stops_cache: cache,
      },
    };
    const resolved = resolveMapSettings(defaults, null);
    expect(resolved.route.color_stops_cache).toEqual(cache);
  });

  it('preserves color_stops_cache on WaypointsSettings', () => {
    const cache: GradientStop[] = [
      { fraction: 0, color: '#000000' },
      { fraction: 1, color: '#ffffff' },
    ];
    const defaults: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      waypoints: {
        ...DEFAULT_MAP_SETTINGS.waypoints,
        color: { mode: 'solid', solid: '#bced09' },
        color_stops_cache: cache,
      },
    };
    const resolved = resolveMapSettings(defaults, null);
    expect(resolved.waypoints.color_stops_cache).toEqual(cache);
  });
});
