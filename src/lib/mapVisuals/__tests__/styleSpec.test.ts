// Snapshot-style tests for `buildStyleSpec`, the layer specs that the
// mapVisuals module exports, and the dimensionless-fraction paint sizing.
// These guard the contract the preview MapView and the export worker both
// consume — anything observable about the style (URL vs. inline spec,
// defaultPitch, layer ids, source bindings) is verified here so a refactor
// that drifts the export off-parity fails fast.

import { describe, it, expect } from 'vitest';
import {
  buildStyleSpec,
  resolveStaticPaints,
  PAINT_REFERENCE_WIDTH,
  BUILDINGS_LAYER_SPEC,
  LIVE_MARKER_PULSE_LAYER,
  LIVE_MARKER_DOT_LAYER,
} from '../styleSpec';
import {
  DEFAULT_MAP_SETTINGS,
  resolveMapSettings,
  type MapSettings,
} from '../../../types';

const minimal: MapSettings = DEFAULT_MAP_SETTINGS;

describe('buildStyleSpec', () => {
  it('default style: returns DEFAULT_STYLE_URL string and pitch 0', () => {
    const result = buildStyleSpec({
      ...minimal,
      camera: { ...minimal.camera, map_style: 'default' },
    });
    expect(typeof result.style).toBe('string');
    if (typeof result.style === 'string') {
      expect(result.style.startsWith('https://')).toBe(true);
    }
    expect(result.defaultPitch).toBe(0);
  });

  it('satellite style: returns inline StyleSpecification with v8 + raster source, pitch 0', () => {
    const result = buildStyleSpec({
      ...minimal,
      camera: { ...minimal.camera, map_style: 'satellite' },
    });
    expect(typeof result.style).toBe('object');
    if (typeof result.style === 'object') {
      expect(result.style.version).toBe(8);
      expect(result.style.sources).toBeDefined();
      expect(result.style.sources.satellite).toBeDefined();
      const satSource = result.style.sources.satellite as { type: string };
      expect(satSource.type).toBe('raster');
    }
    expect(result.defaultPitch).toBe(0);
  });

  it('3d style: same string URL as default, but defaultPitch 60', () => {
    const def = buildStyleSpec({
      ...minimal,
      camera: { ...minimal.camera, map_style: 'default' },
    });
    const threeD = buildStyleSpec({
      ...minimal,
      camera: { ...minimal.camera, map_style: '3d' },
    });
    expect(typeof threeD.style).toBe('string');
    expect(threeD.style).toBe(def.style);
    expect(threeD.defaultPitch).toBe(60);
  });
});

describe('BUILDINGS_LAYER_SPEC', () => {
  it('id is "3d-buildings" and type is "fill-extrusion"', () => {
    expect(BUILDINGS_LAYER_SPEC.id).toBe('3d-buildings');
    expect(BUILDINGS_LAYER_SPEC.type).toBe('fill-extrusion');
  });
});

describe('DEFAULT_MAP_SETTINGS overlay seeds', () => {
  it('matches the lowered defaults from the refactor spec', () => {
    // Pin the seeded fractions verbatim so a deliberate change is reviewable.
    // Numbers are unitless ratios of `PAINT_REFERENCE_WIDTH` (1080 CSS px).
    expect(DEFAULT_MAP_SETTINGS.route.size.full_width).toBe(0.004);
    expect(DEFAULT_MAP_SETTINGS.route.size.trail_width).toBe(0.0055);
    expect(DEFAULT_MAP_SETTINGS.waypoints.size.circle_radius).toBe(0.015);
    expect(DEFAULT_MAP_SETTINGS.waypoints.size.active_radius).toBe(0.019);
    expect(DEFAULT_MAP_SETTINGS.waypoints.size.stroke_width).toBe(0.003);
    expect(DEFAULT_MAP_SETTINGS.waypoints.size.label_size).toBe(0.014);
    expect(DEFAULT_MAP_SETTINGS.pov.size.pulse_radius).toBe(0.012);
    expect(DEFAULT_MAP_SETTINGS.pov.size.dot_radius).toBe(0.013);
    expect(DEFAULT_MAP_SETTINGS.pov.size.dot_stroke_width).toBe(0.004);
    expect(DEFAULT_MAP_SETTINGS.pov.size.pulse_start_radius).toBe(0.012);
    expect(DEFAULT_MAP_SETTINGS.pov.size.pulse_end_radius).toBe(0.033);
  });
});

describe('resolveStaticPaints', () => {
  function buildMap(
    resolved: ReturnType<typeof resolveStaticPaints>,
  ): {
    paintBy: Map<string, number>;
    layoutBy: Map<string, number | string | unknown>;
  } {
    const paintBy = new Map<string, number>();
    for (const [layerId, prop, value] of resolved.paints) {
      paintBy.set(`${layerId}/${prop}`, value);
    }
    const layoutBy = new Map<string, number | string | unknown>();
    for (const [layerId, prop, value] of resolved.layouts) {
      layoutBy.set(`${layerId}/${prop}`, value);
    }
    return { paintBy, layoutBy };
  }

  it('returns canonical values anchored to PAINT_REFERENCE_WIDTH=1080', () => {
    // Under the lever model the renderer-side resolver is width-input-
    // independent: every value equals `mapSettings.overlay_<name> ×
    // PAINT_REFERENCE_WIDTH`.
    const resolved = resolveStaticPaints(DEFAULT_MAP_SETTINGS);
    const { paintBy, layoutBy } = buildMap(resolved);
    expect(PAINT_REFERENCE_WIDTH).toBe(1080);
    expect(paintBy.get('route-full-line/line-width')).toBeCloseTo(
      DEFAULT_MAP_SETTINGS.route.size.full_width * PAINT_REFERENCE_WIDTH,
      9,
    );
    expect(paintBy.get('route-trail-line/line-width')).toBeCloseTo(
      DEFAULT_MAP_SETTINGS.route.size.trail_width * PAINT_REFERENCE_WIDTH,
      9,
    );
    expect(paintBy.get('waypoints-circle/circle-radius')).toBeCloseTo(
      DEFAULT_MAP_SETTINGS.waypoints.size.circle_radius * PAINT_REFERENCE_WIDTH,
      9,
    );
    expect(paintBy.get('waypoints-circle/circle-stroke-width')).toBeCloseTo(
      DEFAULT_MAP_SETTINGS.waypoints.size.stroke_width * PAINT_REFERENCE_WIDTH,
      9,
    );
    expect(paintBy.get('live-marker-dot/circle-radius')).toBeCloseTo(
      DEFAULT_MAP_SETTINGS.pov.size.dot_radius * PAINT_REFERENCE_WIDTH,
      9,
    );
    expect(paintBy.get('live-marker-dot/circle-stroke-width')).toBeCloseTo(
      DEFAULT_MAP_SETTINGS.pov.size.dot_stroke_width * PAINT_REFERENCE_WIDTH,
      9,
    );
    expect(paintBy.get('live-marker-pulse/circle-radius')).toBeCloseTo(
      DEFAULT_MAP_SETTINGS.pov.size.pulse_radius * PAINT_REFERENCE_WIDTH,
      9,
    );
    expect(layoutBy.get('waypoints-label/text-size')).toBeCloseTo(
      DEFAULT_MAP_SETTINGS.waypoints.size.label_size * PAINT_REFERENCE_WIDTH,
      9,
    );
  });

  it('passing route.size.trail_width: 0.02 yields route-trail-line line-width of 21.6', () => {
    // Pinned arithmetic — confirms the fraction × PAINT_REFERENCE_WIDTH
    // contract end-to-end. 0.02 × 1080 = 21.6.
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      route: {
        ...DEFAULT_MAP_SETTINGS.route,
        size: { ...DEFAULT_MAP_SETTINGS.route.size, trail_width: 0.02 },
      },
    };
    const { paintBy } = buildMap(resolveStaticPaints(settings));
    expect(paintBy.get('route-trail-line/line-width')).toBeCloseTo(21.6, 9);
  });

  it('project-level edit: a non-default waypoints.size.circle_radius flows through', () => {
    // The renderer must surface a project's overlay-size edits (not just
    // the seeded constants). 0.04 × 1080 = 43.2 — a value far from any seed
    // so the test fails noisily if the resolver ever ignores the input.
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      waypoints: {
        ...DEFAULT_MAP_SETTINGS.waypoints,
        size: { ...DEFAULT_MAP_SETTINGS.waypoints.size, circle_radius: 0.04 },
      },
    };
    const { paintBy } = buildMap(resolveStaticPaints(settings));
    expect(paintBy.get('waypoints-circle/circle-radius')).toBeCloseTo(
      0.04 * PAINT_REFERENCE_WIDTH,
      9,
    );
    // Sanity: the seeded default would have been 0.015 × 1080 = 16.2, far
    // from 43.2 — proves we picked up the override, not the seed.
    expect(paintBy.get('waypoints-circle/circle-radius')).not.toBeCloseTo(
      DEFAULT_MAP_SETTINGS.waypoints.size.circle_radius * PAINT_REFERENCE_WIDTH,
      3,
    );
  });

  it('clip-level override: resolveMapSettings merge applies size fields', () => {
    // Sparse nested overrides resolve through resolveMapSettings without
    // disturbing sibling leaves.
    const projectDefaults = DEFAULT_MAP_SETTINGS;
    const resolved = resolveMapSettings(projectDefaults, {
      waypoints: { size: { circle_radius: 0.02 } },
    });
    expect(resolved.waypoints.size.circle_radius).toBe(0.02);
    // Sibling overlay fields untouched.
    expect(resolved.route.size.full_width).toBe(
      projectDefaults.route.size.full_width,
    );
    expect(resolved.waypoints.size.active_radius).toBe(
      projectDefaults.waypoints.size.active_radius,
    );
    expect(resolved.pov.size.pulse_end_radius).toBe(
      projectDefaults.pov.size.pulse_end_radius,
    );
    // Non-overlay fields untouched.
    expect(resolved.camera.zoom).toBe(projectDefaults.camera.zoom);
    expect(resolved.route.mode).toBe(projectDefaults.route.mode);

    // Feed the resolved settings through resolveStaticPaints — the
    // waypoint-circle line should now reflect 0.02, not the seed.
    const { paintBy } = (function buildMap2(
      r: ReturnType<typeof resolveStaticPaints>,
    ) {
      const paintBy = new Map<string, number>();
      for (const [layerId, prop, value] of r.paints) {
        paintBy.set(`${layerId}/${prop}`, value);
      }
      return { paintBy };
    })(resolveStaticPaints(resolved));
    expect(paintBy.get('waypoints-circle/circle-radius')).toBeCloseTo(
      0.02 * PAINT_REFERENCE_WIDTH,
      9,
    );
  });

  it('takes a MapSettings argument and returns the descriptor shape', () => {
    const resolved = resolveStaticPaints(DEFAULT_MAP_SETTINGS);
    expect(Array.isArray(resolved.paints)).toBe(true);
    expect(Array.isArray(resolved.layouts)).toBe(true);
    expect(resolved.paints.length).toBeGreaterThan(0);
    expect(resolved.layouts.length).toBeGreaterThan(0);
    // Paints stay scalar — all numeric size properties.
    for (const entry of resolved.paints) {
      expect(entry).toHaveLength(3);
      expect(typeof entry[0]).toBe('string');
      expect(typeof entry[1]).toBe('string');
      expect(typeof entry[2]).toBe('number');
    }
    // Layouts are heterogeneous (text-size: number, visibility: string,
    // text-field: ExpressionSpecification array). Only enforce the tuple
    // shape; per-property value-shape lives in dedicated tests below.
    for (const entry of resolved.layouts) {
      expect(entry).toHaveLength(3);
      expect(typeof entry[0]).toBe('string');
      expect(typeof entry[1]).toBe('string');
    }
  });

  it('paints never carry color / opacity / stroke-color entries — only size properties', () => {
    // Property-name guard for the paints bucket: catches a future drift
    // where a colour ends up in resolveStaticPaints (it should live in
    // buildPerFramePaints or the static layer-spec instead).
    const resolved = resolveStaticPaints(DEFAULT_MAP_SETTINGS);
    for (const [, p] of resolved.paints) {
      expect(p).not.toMatch(/color/);
      expect(p).not.toMatch(/opacity/);
    }
  });

  it('layouts include route visibility derived from route.mode', () => {
    const withRouteMode = (mode: 'full' | 'visited' | 'none'): MapSettings => ({
      ...DEFAULT_MAP_SETTINGS,
      route: { ...DEFAULT_MAP_SETTINGS.route, mode },
    });
    // mode='full' → route-full visible, route-trail none.
    const full = resolveStaticPaints(withRouteMode('full'));
    const fullBy = new Map(full.layouts.map(([l, p, v]) => [`${l}/${p}`, v]));
    expect(fullBy.get('route-full-line/visibility')).toBe('visible');
    expect(fullBy.get('route-trail-line/visibility')).toBe('none');

    // mode='visited' → swapped.
    const visited = resolveStaticPaints(withRouteMode('visited'));
    const visitedBy = new Map(visited.layouts.map(([l, p, v]) => [`${l}/${p}`, v]));
    expect(visitedBy.get('route-full-line/visibility')).toBe('none');
    expect(visitedBy.get('route-trail-line/visibility')).toBe('visible');

    // mode='none' → both layers hidden.
    const none = resolveStaticPaints(withRouteMode('none'));
    const noneBy = new Map(none.layouts.map(([l, p, v]) => [`${l}/${p}`, v]));
    expect(noneBy.get('route-full-line/visibility')).toBe('none');
    expect(noneBy.get('route-trail-line/visibility')).toBe('none');
  });

  it('layouts include the waypoint label expression derived from waypoints.label_mode', () => {
    const withLabelMode = (label_mode: 'numbered' | 'labeled'): MapSettings => ({
      ...DEFAULT_MAP_SETTINGS,
      waypoints: { ...DEFAULT_MAP_SETTINGS.waypoints, label_mode },
    });
    // 'numbered' → 1-based index expression.
    const numbered = resolveStaticPaints(withLabelMode('numbered'));
    const numberedExpr = numbered.layouts.find(
      ([l, p]) => l === 'waypoints-label' && p === 'text-field',
    )?.[2];
    expect(numberedExpr).toEqual(['to-string', ['+', ['get', 'index'], 1]]);

    // 'labeled' → feature.label string verbatim.
    const labeled = resolveStaticPaints(withLabelMode('labeled'));
    const labeledExpr = labeled.layouts.find(
      ([l, p]) => l === 'waypoints-label' && p === 'text-field',
    )?.[2];
    expect(labeledExpr).toEqual(['to-string', ['get', 'label']]);
  });
});

describe('live marker layers', () => {
  it('pulse layer id and source', () => {
    expect(LIVE_MARKER_PULSE_LAYER.id).toBe('live-marker-pulse');
    // Both circle layers point at the shared `live-marker` GeoJSON source so
    // a single setData per frame drives the pulse + dot.
    expect((LIVE_MARKER_PULSE_LAYER as { source: string }).source).toBe(
      'live-marker',
    );
  });

  it('dot layer id and source', () => {
    expect(LIVE_MARKER_DOT_LAYER.id).toBe('live-marker-dot');
    expect((LIVE_MARKER_DOT_LAYER as { source: string }).source).toBe(
      'live-marker',
    );
  });
});
