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
  computeClipOverrides,
  leafPaths,
  transitionSettingsEquals,
  travelSettingsEquals,
  type GradientStop,
  type HaloSettings,
  type MapSettings,
  type TransitionSettings,
  type TravelSettings,
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

// ---------------------------------------------------------------------------
// Per-clip override expansion: everything the decoration panels edit is
// overridable at the clip level — route color/halo, waypoint colors/marker/
// halo, POV halo. These tests pin the merge (resolveMapSettings) and the
// sparse diff (computeClipOverrides) for the new object-valued leaves.

describe('resolveMapSettings — per-clip color/halo/marker overrides', () => {
  const HALO: HaloSettings = {
    enabled: true,
    color: { mode: 'solid', solid: '#112233' },
    size: 0.01,
    fade: 0.25,
    opacity: 0.5,
    falloff: 0.4,
    offset_x: 0.002,
    offset_y: -0.002,
  };

  it('applies route.color override (validated) over the project color', () => {
    const resolved = resolveMapSettings(DEFAULT_MAP_SETTINGS, {
      route: { color: { mode: 'solid', solid: '#ff715b' } },
    });
    expect(resolved.route.color).toEqual({ mode: 'solid', solid: '#ff715b' });
  });

  it('validates an overridden route gradient (malformed falls back to solid)', () => {
    const resolved = resolveMapSettings(DEFAULT_MAP_SETTINGS, {
      route: {
        color: { mode: 'gradient', stops: [{ fraction: 0, color: '#ff715b' }] },
      },
    });
    // Single stop is invalid — degrades to the first stop's solid.
    expect(resolved.route.color).toEqual({ mode: 'solid', solid: '#ff715b' });
  });

  it('applies halo overrides on all three decorations', () => {
    const resolved = resolveMapSettings(DEFAULT_MAP_SETTINGS, {
      route: { halo: HALO },
      waypoints: { halo: HALO },
      pov: { halo: HALO },
    });
    expect(resolved.route.halo).toEqual(HALO);
    expect(resolved.waypoints.halo).toEqual(HALO);
    expect(resolved.pov.halo).toEqual(HALO);
  });

  it('keeps the project halo when the override carries none', () => {
    const defaults: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      route: { ...DEFAULT_MAP_SETTINGS.route, halo: HALO },
    };
    const resolved = resolveMapSettings(defaults, { route: { mode: 'none' } });
    expect(resolved.route.halo).toEqual(HALO);
  });

  it('applies waypoints.color / secondary_color overrides', () => {
    const resolved = resolveMapSettings(DEFAULT_MAP_SETTINGS, {
      waypoints: {
        color: {
          mode: 'gradient',
          stops: [
            { fraction: 0, color: '#ff715b' },
            { fraction: 1, color: '#2f52e0' },
          ],
        },
        secondary_color: { mode: 'solid', solid: '#123456' },
      },
    });
    expect(resolved.waypoints.color.mode).toBe('gradient');
    expect(resolved.waypoints.secondary_color).toEqual({
      mode: 'solid',
      solid: '#123456',
    });
  });

  it('applies the atomic waypoint marker override — image cleared by a shape override', () => {
    const defaults: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      waypoints: {
        ...DEFAULT_MAP_SETTINGS.waypoints,
        shape: 'circle',
        marker_image_id: 'abc123',
      },
    };
    const resolved = resolveMapSettings(defaults, {
      waypoints: { marker: { shape: 'diamond' } },
    });
    // The pair is replaced wholesale: the project image must NOT leak
    // through the merge.
    expect(resolved.waypoints.shape).toBe('diamond');
    expect(resolved.waypoints.marker_image_id).toBeUndefined();
    // The transient `marker` leaf must not splat onto the resolved settings.
    expect('marker' in resolved.waypoints).toBe(false);
  });

  it('applies an image marker override over a shape project default', () => {
    const resolved = resolveMapSettings(DEFAULT_MAP_SETTINGS, {
      waypoints: { marker: { shape: 'circle', marker_image_id: 'abc123' } },
    });
    expect(resolved.waypoints.marker_image_id).toBe('abc123');
  });
});

describe('computeClipOverrides — object-valued leaves (deep-equal diff)', () => {
  const HALO: HaloSettings = {
    enabled: true,
    color: { mode: 'solid', solid: '#112233' },
    size: 0.01,
    fade: 0.25,
    opacity: 0.5,
  };

  it('records route.color when different; drops it when deep-equal', () => {
    const next: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      route: {
        ...DEFAULT_MAP_SETTINGS.route,
        color: { mode: 'solid', solid: '#ff715b' },
      },
    };
    expect(computeClipOverrides(next, DEFAULT_MAP_SETTINGS).route?.color).toEqual({
      mode: 'solid',
      solid: '#ff715b',
    });
    // Fresh (different-reference, same-value) object: no override.
    const same: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      route: {
        ...DEFAULT_MAP_SETTINGS.route,
        color: { ...DEFAULT_MAP_SETTINGS.route.color },
      },
    };
    expect(computeClipOverrides(same, DEFAULT_MAP_SETTINGS).route).toBeUndefined();
  });

  it('records halo overrides on all three decorations; deep-equal drops them', () => {
    const next: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      route: { ...DEFAULT_MAP_SETTINGS.route, halo: HALO },
      waypoints: { ...DEFAULT_MAP_SETTINGS.waypoints, halo: HALO },
      pov: { ...DEFAULT_MAP_SETTINGS.pov, halo: HALO },
    };
    const overrides = computeClipOverrides(next, DEFAULT_MAP_SETTINGS);
    expect(overrides.route?.halo).toEqual(HALO);
    expect(overrides.waypoints?.halo).toEqual(HALO);
    expect(overrides.pov?.halo).toEqual(HALO);

    const project: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      route: { ...DEFAULT_MAP_SETTINGS.route, halo: HALO },
    };
    const sameHalo: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      // Same values, fresh objects — and an absent falloff must compare
      // equal to the explicit 0 the seed writes.
      route: {
        ...DEFAULT_MAP_SETTINGS.route,
        halo: { ...HALO, color: { ...HALO.color }, falloff: 0 },
      },
    };
    expect(computeClipOverrides(sameHalo, project).route).toBeUndefined();
  });

  it('halo diff ignores color_stops_cache (UI stash, not a visual diff)', () => {
    const project: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      route: { ...DEFAULT_MAP_SETTINGS.route, halo: HALO },
    };
    const next: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      route: {
        ...DEFAULT_MAP_SETTINGS.route,
        halo: {
          ...HALO,
          color_stops_cache: [
            { fraction: 0, color: '#000000' },
            { fraction: 1, color: '#ffffff' },
          ],
        },
      },
    };
    expect(computeClipOverrides(next, project).route).toBeUndefined();
  });

  it('records a DISABLED clip halo distinct from an absent project halo (config survives off-toggle)', () => {
    const next: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      route: {
        ...DEFAULT_MAP_SETTINGS.route,
        halo: { ...HALO, enabled: false },
      },
    };
    const overrides = computeClipOverrides(next, DEFAULT_MAP_SETTINGS);
    expect(overrides.route?.halo).toEqual({ ...HALO, enabled: false });
  });

  it('records the waypoint marker atomically (shape edit under a project image clears the image)', () => {
    const project: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      waypoints: {
        ...DEFAULT_MAP_SETTINGS.waypoints,
        marker_image_id: 'abc123',
      },
    };
    const next: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      waypoints: {
        ...DEFAULT_MAP_SETTINGS.waypoints,
        shape: 'diamond',
        marker_image_id: undefined,
      },
    };
    const overrides = computeClipOverrides(next, project);
    expect(overrides.waypoints?.marker).toEqual({ shape: 'diamond' });
    // Round-trip: resolving the override reproduces `next`'s marker fields.
    const resolved = resolveMapSettings(project, overrides);
    expect(resolved.waypoints.shape).toBe('diamond');
    expect(resolved.waypoints.marker_image_id).toBeUndefined();
  });

  it('records waypoints.color / secondary_color and enumerates the new leaf paths', () => {
    const next: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      route: {
        ...DEFAULT_MAP_SETTINGS.route,
        color: { mode: 'solid', solid: '#ff715b' },
        halo: HALO,
      },
      waypoints: {
        ...DEFAULT_MAP_SETTINGS.waypoints,
        color: { mode: 'solid', solid: '#ff715b' },
        secondary_color: { mode: 'solid', solid: '#123456' },
        shape: 'pin',
        halo: HALO,
      },
      pov: { ...DEFAULT_MAP_SETTINGS.pov, halo: HALO },
    };
    const overrides = computeClipOverrides(next, DEFAULT_MAP_SETTINGS);
    expect(leafPaths(overrides)).toEqual(
      new Set([
        'route.color',
        'route.halo',
        'waypoints.color',
        'waypoints.secondary_color',
        'waypoints.marker',
        'waypoints.halo',
        'pov.halo',
      ]),
    );
  });
});

describe('travel — comparator, diff, resolve', () => {
  const TRAVEL_ON: TravelSettings = { enabled: true };
  const TRAVEL_CUSTOM: TravelSettings = {
    enabled: true,
    sync: false,
    playhead: {
      ...DEFAULT_MAP_SETTINGS.pov,
      color: '#ff715b',
      pulse_style: 'heartbeat',
      marker: { kind: 'shape', shape: 'ring' },
    },
  };

  it('travelSettingsEquals: block absence compares strictly; toggles normalize', () => {
    expect(travelSettingsEquals(undefined, undefined)).toBe(true);
    expect(travelSettingsEquals(undefined, TRAVEL_ON)).toBe(false);
    // Absent optional toggles read as their defaults (all true), so the
    // minimal blob equals its explicit spelled-out twin — no phantom
    // override between a hand-written `{enabled:true}` and a UI write.
    expect(
      travelSettingsEquals(TRAVEL_ON, {
        enabled: true,
        show_playhead: true,
        sync: true,
        draw_route: true,
      }),
    ).toBe(true);
    expect(
      travelSettingsEquals(TRAVEL_ON, { enabled: true, draw_route: false }),
    ).toBe(false);
    expect(
      travelSettingsEquals(TRAVEL_ON, { enabled: true, show_playhead: false }),
    ).toBe(false);
  });

  it('travelSettingsEquals: enabled flip, sync flip, and playhead style identity', () => {
    expect(travelSettingsEquals(TRAVEL_ON, { enabled: false })).toBe(false);
    expect(travelSettingsEquals(TRAVEL_ON, { enabled: true, sync: false })).toBe(
      false,
    );
    // A stored playhead style compares strictly against none — the config
    // survives a re-sync round trip, so its presence is meaningful.
    expect(
      travelSettingsEquals(TRAVEL_CUSTOM, { ...TRAVEL_CUSTOM, playhead: undefined }),
    ).toBe(false);
    // Deep-equal style blocks compare equal across references.
    expect(
      travelSettingsEquals(TRAVEL_CUSTOM, {
        ...TRAVEL_CUSTOM,
        playhead: { ...TRAVEL_CUSTOM.playhead!, size: { ...TRAVEL_CUSTOM.playhead!.size } },
      }),
    ).toBe(true);
    expect(
      travelSettingsEquals(TRAVEL_CUSTOM, {
        ...TRAVEL_CUSTOM,
        playhead: { ...TRAVEL_CUSTOM.playhead!, color: '#000000' },
      }),
    ).toBe(false);
    // Inside a style block the marker uses normal PovSettings semantics:
    // absent equals the explicit default dot.
    expect(
      travelSettingsEquals(
        { enabled: true, sync: false, playhead: { ...DEFAULT_MAP_SETTINGS.pov } },
        {
          enabled: true,
          sync: false,
          playhead: {
            ...DEFAULT_MAP_SETTINGS.pov,
            marker: { kind: 'shape', shape: 'dot' },
          },
        },
      ),
    ).toBe(true);
  });

  it('transitionSettingsEquals: block absence strict; sub-blocks compare through their comparators', () => {
    const t: TransitionSettings = {
      travel: TRAVEL_ON,
      ease_in: { style: 'pop', speed: 'fast' },
    };
    expect(transitionSettingsEquals(undefined, undefined)).toBe(true);
    expect(transitionSettingsEquals(undefined, t)).toBe(false);
    // Travel toggles normalize through travelSettingsEquals.
    expect(
      transitionSettingsEquals(t, {
        travel: { enabled: true, sync: true, show_playhead: true, draw_route: true },
        ease_in: { style: 'pop', speed: 'fast' },
      }),
    ).toBe(true);
    expect(
      transitionSettingsEquals(t, { ...t, ease_in: { style: 'pop', speed: 'slow' } }),
    ).toBe(false);
    expect(
      transitionSettingsEquals(t, { ...t, ease_out: { style: 'fade', speed: 'medium' } }),
    ).toBe(false);
  });

  it('computeClipOverrides records transition atomically at the TOP level; deep-equal drops it', () => {
    const block: TransitionSettings = {
      travel: TRAVEL_CUSTOM,
      ease_out: { style: 'fade', speed: 'slow' },
    };
    const next: MapSettings = { ...DEFAULT_MAP_SETTINGS, transition: block };
    const overrides = computeClipOverrides(next, DEFAULT_MAP_SETTINGS);
    expect(overrides.transition).toEqual(block);
    expect(overrides.pov).toBeUndefined();
    expect(leafPaths(overrides)).toEqual(new Set(['transition']));

    // Same value, different reference: no override.
    const project: MapSettings = { ...DEFAULT_MAP_SETTINGS, transition: block };
    const same: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      transition: {
        ...block,
        travel: { ...TRAVEL_CUSTOM, playhead: { ...TRAVEL_CUSTOM.playhead! } },
        ease_out: { style: 'fade', speed: 'slow' },
      },
    };
    expect(computeClipOverrides(same, project).transition).toBeUndefined();
  });

  it('records a DISABLED clip travel distinct from an absent project transition (config survives off-toggle)', () => {
    const next: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      transition: { travel: { ...TRAVEL_CUSTOM, enabled: false } },
    };
    const overrides = computeClipOverrides(next, DEFAULT_MAP_SETTINGS);
    expect(overrides.transition).toEqual({
      travel: { ...TRAVEL_CUSTOM, enabled: false },
    });
  });

  it('resolveMapSettings applies the transition override atomically and inherits when absent', () => {
    const project: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      transition: { travel: TRAVEL_ON },
    };
    // Override replaces the whole blob (eases included — atomic).
    const overridden = resolveMapSettings(project, {
      transition: { ease_in: { style: 'grow', speed: 'medium' } },
    });
    expect(overridden.transition).toEqual({
      ease_in: { style: 'grow', speed: 'medium' },
    });
    // No override → the project blob rides through.
    const inherited = resolveMapSettings(project, { pov: { color: '#123456' } });
    expect(inherited.transition).toEqual({ travel: TRAVEL_ON });
    // Absent everywhere stays absent.
    expect(resolveMapSettings(DEFAULT_MAP_SETTINGS, {}).transition).toBeUndefined();
  });
});
