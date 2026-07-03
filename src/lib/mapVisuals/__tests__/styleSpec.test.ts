// Snapshot-style tests for `buildStyleSpec`, the layer specs that the
// mapVisuals module exports, and the dimensionless-fraction paint sizing.
// These guard the contract the preview MapView and the export worker both
// consume — anything observable about the style (URL vs. inline spec,
// defaultPitch, layer ids, source bindings) is verified here so a refactor
// that drifts the export off-parity fails fast.

import { describe, it, expect } from 'vitest';
import {
  buildStyleSpec,
  buildLineGradientExpression,
  resolveStaticPaints,
  PAINT_REFERENCE_WIDTH,
  SHAPE_CANONICAL_RADIUS,
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
  it('matches the seeded defaults (bumped ~30% larger across the board)', () => {
    // Pin the seeded fractions verbatim so a deliberate change is reviewable.
    // Numbers are unitless ratios of `PAINT_REFERENCE_WIDTH` (1080 CSS px).
    // Kept in lockstep with the Rust `default_overlay_*` fns in models.rs.
    expect(DEFAULT_MAP_SETTINGS.route.size.width).toBe(0.006);
    expect(DEFAULT_MAP_SETTINGS.waypoints.size.circle_radius).toBe(0.02);
    expect(DEFAULT_MAP_SETTINGS.waypoints.size.active_radius).toBe(0.025);
    expect(DEFAULT_MAP_SETTINGS.waypoints.size.stroke_width).toBe(0.004);
    expect(DEFAULT_MAP_SETTINGS.waypoints.size.label_size).toBe(0.018);
    expect(DEFAULT_MAP_SETTINGS.pov.size.pulse_radius).toBe(0.016);
    expect(DEFAULT_MAP_SETTINGS.pov.size.dot_radius).toBe(0.017);
    expect(DEFAULT_MAP_SETTINGS.pov.size.dot_stroke_width).toBe(0.005);
    expect(DEFAULT_MAP_SETTINGS.pov.size.pulse_start_radius).toBe(0.016);
    expect(DEFAULT_MAP_SETTINGS.pov.size.pulse_end_radius).toBe(0.044);
  });
});

describe('resolveStaticPaints', () => {
  function buildMap(
    resolved: ReturnType<typeof resolveStaticPaints>,
  ): {
    paintBy: Map<string, unknown>;
    layoutBy: Map<string, number | string | unknown>;
  } {
    const paintBy = new Map<string, unknown>();
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
      DEFAULT_MAP_SETTINGS.route.size.width * PAINT_REFERENCE_WIDTH,
      9,
    );
    expect(paintBy.get('route-trail-line/line-width')).toBeCloseTo(
      DEFAULT_MAP_SETTINGS.route.size.width * PAINT_REFERENCE_WIDTH,
      9,
    );
    // Waypoint size flows as `icon-size` on the SDF symbol layers — the
    // user-facing radius is normalized by SHAPE_CANONICAL_RADIUS so the
    // rendered radius matches the pre-canvas-bump appearance (32.4-px
    // diameter at default `circle_radius = 0.015`).
    const expectedIconSize =
      (DEFAULT_MAP_SETTINGS.waypoints.size.circle_radius *
        PAINT_REFERENCE_WIDTH) /
      SHAPE_CANONICAL_RADIUS;
    expect(layoutBy.get('waypoints-primary/icon-size')).toBeCloseTo(
      expectedIconSize,
      9,
    );
    expect(layoutBy.get('waypoints-secondary/icon-size')).toBeCloseTo(
      expectedIconSize,
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
    expect(layoutBy.get('waypoints-secondary/text-size')).toBeCloseTo(
      DEFAULT_MAP_SETTINGS.waypoints.size.label_size * PAINT_REFERENCE_WIDTH,
      9,
    );
  });

  it('uses route.size.width for both route line layers', () => {
    // Pinned arithmetic — confirms the fraction × PAINT_REFERENCE_WIDTH
    // contract end-to-end. 0.02 × 1080 = 21.6.
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      route: {
        ...DEFAULT_MAP_SETTINGS.route,
        size: {
          ...DEFAULT_MAP_SETTINGS.route.size,
          width: 0.02,
        },
      },
    };
    const { paintBy } = buildMap(resolveStaticPaints(settings));
    expect(paintBy.get('route-full-line/line-width')).toBeCloseTo(21.6, 9);
    expect(paintBy.get('route-trail-line/line-width')).toBeCloseTo(21.6, 9);
  });

  it('project-level edit: a non-default waypoints.size.circle_radius flows through', () => {
    // The renderer must surface a project's overlay-size edits (not just
    // the seeded constants). 0.04 is far from the default so the test
    // fails noisily if the resolver ever ignores the input.
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      waypoints: {
        ...DEFAULT_MAP_SETTINGS.waypoints,
        size: { ...DEFAULT_MAP_SETTINGS.waypoints.size, circle_radius: 0.04 },
      },
    };
    const { layoutBy } = buildMap(resolveStaticPaints(settings));
    const expected = (0.04 * PAINT_REFERENCE_WIDTH) / SHAPE_CANONICAL_RADIUS;
    expect(layoutBy.get('waypoints-primary/icon-size')).toBeCloseTo(
      expected,
      9,
    );
    expect(layoutBy.get('waypoints-secondary/icon-size')).toBeCloseTo(
      expected,
      9,
    );
    // Sanity: the override-derived icon-size is far from the seeded
    // default — proves we picked up the override, not the seed.
    expect(layoutBy.get('waypoints-primary/icon-size')).not.toBeCloseTo(
      (DEFAULT_MAP_SETTINGS.waypoints.size.circle_radius *
        PAINT_REFERENCE_WIDTH) /
        SHAPE_CANONICAL_RADIUS,
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
    expect(resolved.route.size.width).toBe(
      projectDefaults.route.size.width,
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
    // waypoint primary/secondary icon-size should now reflect 0.02, not
    // the seed.
    const { layoutBy } = (function buildMap2(
      r: ReturnType<typeof resolveStaticPaints>,
    ) {
      const layoutBy = new Map<string, number>();
      for (const [layerId, prop, value] of r.layouts) {
        if (typeof value === 'number') {
          layoutBy.set(`${layerId}/${prop}`, value);
        }
      }
      return { layoutBy };
    })(resolveStaticPaints(resolved));
    const expected = (0.02 * PAINT_REFERENCE_WIDTH) / SHAPE_CANONICAL_RADIUS;
    expect(layoutBy.get('waypoints-primary/icon-size')).toBeCloseTo(
      expected,
      9,
    );
    expect(layoutBy.get('waypoints-secondary/icon-size')).toBeCloseTo(
      expected,
      9,
    );
  });

  it('takes a MapSettings argument and returns the descriptor shape', () => {
    const resolved = resolveStaticPaints(DEFAULT_MAP_SETTINGS);
    expect(Array.isArray(resolved.paints)).toBe(true);
    expect(Array.isArray(resolved.layouts)).toBe(true);
    expect(resolved.paints.length).toBeGreaterThan(0);
    expect(resolved.layouts.length).toBeGreaterThan(0);
    // Paints carry sizes (numbers) AND color hex strings — loosened in v8
    // for route, waypoint, and POV solid-color plumbing. Only the 3-tuple
    // shape is enforced here; value type varies by property.
    for (const entry of resolved.paints) {
      expect(entry).toHaveLength(3);
      expect(typeof entry[0]).toBe('string');
      expect(typeof entry[1]).toBe('string');
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

  it('paints carry color properties for route (solid) and POV', () => {
    // Step 2 contract: solid-color route emits `line-color` for both route
    // layers; POV emits `circle-color` (pulse) + `circle-stroke-color`
    // (dot) every time. Waypoint colors flow per-feature via
    // `buildPerFramePaints` and are intentionally NOT here.
    const resolved = resolveStaticPaints(DEFAULT_MAP_SETTINGS);
    const props = new Set(resolved.paints.map(([l, p]) => `${l}/${p}`));
    expect(props.has('route-full-line/line-color')).toBe(true);
    expect(props.has('route-trail-line/line-color')).toBe(true);
    expect(props.has('live-marker-pulse/circle-color')).toBe(true);
    expect(props.has('live-marker-dot/circle-stroke-color')).toBe(true);
  });

  it('route line-color reflects mapSettings.route.color.solid', () => {
    // Project edit to a non-default route color must flow through the
    // paints bucket as-is — verifies the Step 2 single-source-of-truth
    // path from `mapSettings.route.color` to `setPaintProperty`.
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      route: {
        ...DEFAULT_MAP_SETTINGS.route,
        color: { mode: 'solid', solid: '#ff715b' },
      },
    };
    const { paintBy } = buildMap(resolveStaticPaints(settings));
    expect(paintBy.get('route-full-line/line-color')).toBe('#ff715b');
    expect(paintBy.get('route-trail-line/line-color')).toBe('#ff715b');
  });

  it('POV color flows to live-marker-pulse and live-marker-dot stroke', () => {
    // Project edit to mapSettings.pov.color flows through both POV layer
    // color properties — the ring and the dot stroke share the same
    // single source of truth.
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      pov: { ...DEFAULT_MAP_SETTINGS.pov, color: '#ff715b' },
    };
    const { paintBy } = buildMap(resolveStaticPaints(settings));
    expect(paintBy.get('live-marker-pulse/circle-color')).toBe('#ff715b');
    expect(paintBy.get('live-marker-dot/circle-stroke-color')).toBe('#ff715b');
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

  it('layouts include icon-image expressions for both waypoint slots derived from mapSettings.waypoints.shape', () => {
    // Each symbol layer's `icon-image` fallback must read the project
    // default shape — otherwise a project default of 'diamond' silently
    // renders every un-overridden waypoint as a circle icon. The
    // expression body is a `concat` of
    // `'waypoint-' + safeShape(override_shape, projectShape) + '-<slot>'`;
    // we serialize and look for the project shape literal and slot suffix
    // in the tree.
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      waypoints: { ...DEFAULT_MAP_SETTINGS.waypoints, shape: 'diamond' },
    };
    const resolved = resolveStaticPaints(settings);
    const primaryTuple = resolved.layouts.find(
      ([l, p]) => l === 'waypoints-primary' && p === 'icon-image',
    );
    const secondaryTuple = resolved.layouts.find(
      ([l, p]) => l === 'waypoints-secondary' && p === 'icon-image',
    );
    expect(primaryTuple).toBeDefined();
    expect(secondaryTuple).toBeDefined();
    // Inner coalesce's default arm carries the project shape literal —
    // this is the substring that flips when the project default changes.
    // The outer `match` table mentions every known shape name, so we look
    // specifically for the coalesce default placement.
    expect(JSON.stringify(primaryTuple?.[2])).toContain(
      '"coalesce",["get","override_shape"],"diamond"',
    );
    expect(JSON.stringify(primaryTuple?.[2])).toContain('-primary');
    expect(JSON.stringify(secondaryTuple?.[2])).toContain(
      '"coalesce",["get","override_shape"],"diamond"',
    );
    expect(JSON.stringify(secondaryTuple?.[2])).toContain('-secondary');
    // Sanity: a different project shape produces a different coalesce default.
    const pinResolved = resolveStaticPaints({
      ...settings,
      waypoints: { ...settings.waypoints, shape: 'pin' },
    });
    const pinPrimaryTuple = pinResolved.layouts.find(
      ([l, p]) => l === 'waypoints-primary' && p === 'icon-image',
    );
    expect(JSON.stringify(pinPrimaryTuple?.[2])).toContain(
      '"coalesce",["get","override_shape"],"pin"',
    );
    expect(JSON.stringify(pinPrimaryTuple?.[2])).not.toContain(
      '"coalesce",["get","override_shape"],"diamond"',
    );
  });

  it('layouts include icon-anchor expressions that resolve pin → bottom and others → center', () => {
    // The pin's SDF puts its tip at the bottom-center of the canvas so the
    // GPS coordinate lands on the tip with `icon-anchor: 'bottom'`; every
    // other shape stays `icon-anchor: 'center'`. Driving this per-shape via
    // a `match` expression is what lets the pin's head fill the canvas (and
    // therefore match the user's `stroke_width` calibration) instead of
    // being squeezed into the top half.
    const resolved = resolveStaticPaints(DEFAULT_MAP_SETTINGS);
    const primaryAnchor = resolved.layouts.find(
      ([l, p]) => l === 'waypoints-primary' && p === 'icon-anchor',
    );
    const secondaryAnchor = resolved.layouts.find(
      ([l, p]) => l === 'waypoints-secondary' && p === 'icon-anchor',
    );
    expect(primaryAnchor).toBeDefined();
    expect(secondaryAnchor).toBeDefined();
    // Same expression on both layers — fill and outline must share an
    // anchor or they'd render at different positions.
    expect(primaryAnchor?.[2]).toEqual(secondaryAnchor?.[2]);
    const json = JSON.stringify(primaryAnchor?.[2]);
    // The match expression carries the pin → 'bottom' arm and a 'center'
    // default fallback for every other shape.
    expect(json).toContain('"match"');
    expect(json).toContain('"pin","bottom"');
    expect(json).toContain('"center"');
  });

  it('live-marker-dot fill is driven by pov.secondary_color', () => {
    // Replaces the pre-refactor hard-coded white. The secondary slot
    // tints the dot fill; the primary slot tints the stroke and the pulse
    // rings. Both flow through the static `paints` channel.
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      pov: {
        ...DEFAULT_MAP_SETTINGS.pov,
        color: '#bced09',
        secondary_color: '#ff715b',
      },
    };
    const { paintBy } = buildMap(resolveStaticPaints(settings));
    expect(paintBy.get('live-marker-dot/circle-color')).toBe('#ff715b');
    expect(paintBy.get('live-marker-dot/circle-stroke-color')).toBe('#bced09');
  });

  it('layouts include the waypoint label expression derived from waypoints.label_mode', () => {
    const withLabelMode = (label_mode: 'numbered' | 'labeled'): MapSettings => ({
      ...DEFAULT_MAP_SETTINGS,
      waypoints: { ...DEFAULT_MAP_SETTINGS.waypoints, label_mode },
    });
    // 'numbered' → 1-based index expression.
    const numbered = resolveStaticPaints(withLabelMode('numbered'));
    const numberedExpr = numbered.layouts.find(
      ([l, p]) => l === 'waypoints-secondary' && p === 'text-field',
    )?.[2];
    expect(numberedExpr).toEqual(['to-string', ['+', ['get', 'index'], 1]]);

    // 'labeled' → feature.label string verbatim.
    const labeled = resolveStaticPaints(withLabelMode('labeled'));
    const labeledExpr = labeled.layouts.find(
      ([l, p]) => l === 'waypoints-secondary' && p === 'text-field',
    )?.[2];
    expect(labeledExpr).toEqual(['to-string', ['get', 'label']]);
  });

  it('returns a gradients bucket alongside paints and layouts (Step 3)', () => {
    // The bucket is a third top-level field on the ResolvedStaticPaints
    // shape. `line-gradient` is split out from `paints` because MapLibre
    // treats it as mutually exclusive with `line-color`: the consumer
    // calls `setPaintProperty(layerId, 'line-gradient', value)` once per
    // tuple, with `value` either an ExpressionSpecification (gradient
    // mode) or `null` (solid mode, clears any stale gradient).
    const resolved = resolveStaticPaints(DEFAULT_MAP_SETTINGS);
    expect(Array.isArray(resolved.gradients)).toBe(true);
    // Two tuples: one for `route-full-line`, one for `route-trail-line`.
    const layerIds = resolved.gradients.map(([id]) => id);
    expect(layerIds).toContain('route-full-line');
    expect(layerIds).toContain('route-trail-line');
    // Each tuple is [string, ExpressionSpecification | null].
    for (const entry of resolved.gradients) {
      expect(entry).toHaveLength(2);
      expect(typeof entry[0]).toBe('string');
    }
  });

  it('solid mode emits null in gradients to clear stale state', () => {
    // Solid color mode must NOT emit a `line-gradient` expression — but
    // the bucket still emits a tuple per route layer with `null` as the
    // value, so the consumer's `setPaintProperty(layer, 'line-gradient',
    // null)` clears any stale gradient that survived from a prior
    // resolve (e.g. user toggled gradient → solid in the picker).
    const resolved = resolveStaticPaints(DEFAULT_MAP_SETTINGS);
    const gradBy = new Map(resolved.gradients);
    expect(gradBy.get('route-full-line')).toBeNull();
    expect(gradBy.get('route-trail-line')).toBeNull();
  });

  it('gradient mode emits an interpolate expression on line-progress', () => {
    // Two-stop gradient (chartreuse → coral) at the canonical fractions.
    // The expression shape mirrors the rendering.md §2 spec exactly:
    // `['interpolate', ['linear'], ['line-progress'], 0, c0, 1, c1]`.
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      route: {
        ...DEFAULT_MAP_SETTINGS.route,
        color: {
          mode: 'gradient',
          stops: [
            { fraction: 0, color: '#bced09' },
            { fraction: 1, color: '#ff715b' },
          ],
        },
      },
    };
    const resolved = resolveStaticPaints(settings);
    const gradBy = new Map(resolved.gradients);
    const expected = [
      'interpolate',
      ['linear'],
      ['line-progress'],
      0,
      '#bced09',
      1,
      '#ff715b',
    ];
    expect(gradBy.get('route-full-line')).toEqual(expected);
    // The trail layer gets the same expression — visually approximate at
    // the trail head (see rendering.md §2 "Slime-Trail Gradient"), but
    // the wiring is symmetric with the full route.
    expect(gradBy.get('route-trail-line')).toEqual(expected);
  });

  it('cross-style swap preserves gradient (resolveStaticPaints is deterministic)', () => {
    // Style swap behavior contract: MapView re-runs the apply effect on
    // every `styleVersion` change (default ↔ satellite ↔ 3D). The effect
    // calls `resolveStaticPaints(mapSettings)` and replays the paint /
    // layout / gradient tuples. For gradient persistence across style
    // swaps to work, the same input MUST produce the same output every
    // time — that's what this test pins. (The actual map source re-add
    // with `lineMetrics: true` is wired at the addSource sites in
    // `MapView.tsx` and `renderer/index.ts`; this test guarantees the
    // expression that gets pushed back on the freshly-added source is
    // unchanged.)
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      route: {
        ...DEFAULT_MAP_SETTINGS.route,
        color: {
          mode: 'gradient',
          stops: [
            { fraction: 0, color: '#bced09' },
            { fraction: 0.5, color: '#f9cb40' },
            { fraction: 1, color: '#ff715b' },
          ],
        },
      },
    };
    // Resolve three times — once per "style swap" (default → satellite →
    // 3D). The expressions must be deep-equal across all three.
    const a = resolveStaticPaints(settings).gradients;
    const b = resolveStaticPaints(settings).gradients;
    const c = resolveStaticPaints(settings).gradients;
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    // And the actual expression must be a valid interpolate on line-progress.
    const fullA = a.find(([l]) => l === 'route-full-line')?.[1];
    expect(Array.isArray(fullA)).toBe(true);
    expect((fullA as unknown[])[0]).toBe('interpolate');
    expect((fullA as unknown[])[2]).toEqual(['line-progress']);
  });

  it('gradient mode still emits line-color in the paints bucket', () => {
    // Design decision: `line-color` is emitted unconditionally even in
    // gradient mode. MapLibre prefers `line-gradient` over `line-color`
    // when both are set on a line layer, so the always-emitted
    // `line-color` is harmless under the gradient and avoids special-
    // casing the mode swap. The renderer's consumer applies the gradient
    // tuple AFTER the paint tuple, so any race during the swap (e.g. an
    // intermediate frame where the gradient was applied first) still
    // ends with the gradient winning.
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      route: {
        ...DEFAULT_MAP_SETTINGS.route,
        color: {
          mode: 'gradient',
          stops: [
            { fraction: 0, color: '#bced09' },
            { fraction: 1, color: '#ff715b' },
          ],
        },
      },
    };
    const resolved = resolveStaticPaints(settings);
    const props = new Set(resolved.paints.map(([l, p]) => `${l}/${p}`));
    expect(props.has('route-full-line/line-color')).toBe(true);
    expect(props.has('route-trail-line/line-color')).toBe(true);
  });
});

describe('buildLineGradientExpression', () => {
  it('emits an interpolate expression on line-progress with all stops in order', () => {
    // Three-stop gradient. Output shape mirrors the rendering.md §2 spec.
    const expr = buildLineGradientExpression([
      { fraction: 0, color: '#bced09' },
      { fraction: 0.5, color: '#ffeb3b' },
      { fraction: 1, color: '#ff715b' },
    ]);
    expect(expr).toEqual([
      'interpolate',
      ['linear'],
      ['line-progress'],
      0,
      '#bced09',
      0.5,
      '#ffeb3b',
      1,
      '#ff715b',
    ]);
  });

  it('empty stops collapse to a constant chartreuse expression', () => {
    // Defensive — the resolver shouldn't crash on an empty stop list.
    // Falling back to the accent color keeps the route visible rather
    // than transparent if the data model ever produces an invalid
    // GradientStop[] (e.g. mid-edit in the picker).
    const expr = buildLineGradientExpression([]);
    expect(expr).toEqual(['to-color', '#bced09']);
  });

  it('single stop collapses to a constant color expression', () => {
    // MapLibre's `interpolate` requires at least one stop, but with one
    // stop the result is constant — we skip the interpolate and emit a
    // direct color expression.
    const expr = buildLineGradientExpression([
      { fraction: 0.5, color: '#ff715b' },
    ]);
    expect(expr).toEqual(['to-color', '#ff715b']);
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

// -- surfaceScale (preview display factor) ------------------------------------
//
// The preview renders the reference space at a fixed display scale; it passes
// that factor here so decoration sizes minify with the world. The export
// renderer omits the argument — scale 1 MUST be byte-identical to the
// pre-scale behavior (golden-frame gate depends on it).

describe('resolveStaticPaints — surfaceScale', () => {
  const SIZE_PAINT_PROPS = new Set([
    'line-width',
    'circle-radius',
    'circle-stroke-width',
  ]);

  it('omitting the argument is exactly scale 1 (renderer identity)', () => {
    expect(resolveStaticPaints(minimal)).toEqual(resolveStaticPaints(minimal, 1));
  });

  it('scale 0.5 halves every size paint and leaves colors untouched', () => {
    const ref = resolveStaticPaints(minimal, 1);
    const scaled = resolveStaticPaints(minimal, 0.5);
    expect(scaled.paints.length).toBe(ref.paints.length);
    for (let i = 0; i < ref.paints.length; i++) {
      const [layer, prop, value] = ref.paints[i];
      const [sLayer, sProp, sValue] = scaled.paints[i];
      expect(sLayer).toBe(layer);
      expect(sProp).toBe(prop);
      if (SIZE_PAINT_PROPS.has(prop)) {
        expect(typeof value).toBe('number');
        expect(sValue).toBeCloseTo((value as number) * 0.5, 12);
      } else {
        // Color strings ride through unscaled.
        expect(sValue).toEqual(value);
      }
    }
  });

  it('scale 0.5 halves text-size and icon-size layouts; visibility and expressions are unchanged', () => {
    const ref = resolveStaticPaints(minimal, 1);
    const scaled = resolveStaticPaints(minimal, 0.5);
    expect(scaled.layouts.length).toBe(ref.layouts.length);
    for (let i = 0; i < ref.layouts.length; i++) {
      const [layer, prop, value] = ref.layouts[i];
      const [sLayer, sProp, sValue] = scaled.layouts[i];
      expect(sLayer).toBe(layer);
      expect(sProp).toBe(prop);
      if (prop === 'text-size' || prop === 'icon-size') {
        expect(typeof value).toBe('number');
        expect(sValue).toBeCloseTo((value as number) * 0.5, 12);
      } else {
        expect(sValue).toEqual(value);
      }
    }
  });

  it('gradients are scale-free (identical expressions at any scale)', () => {
    const gradientSettings: MapSettings = {
      ...minimal,
      route: {
        ...minimal.route,
        color: {
          mode: 'gradient',
          stops: [
            { fraction: 0, color: '#ff0000' },
            { fraction: 1, color: '#00ff00' },
          ],
        },
      },
    };
    const ref = resolveStaticPaints(gradientSettings, 1);
    const scaled = resolveStaticPaints(gradientSettings, 0.5);
    expect(scaled.gradients).toEqual(ref.gradients);
  });

  it('scaling is linear in the factor (2× of 0.5× returns to reference)', () => {
    const half = resolveStaticPaints(minimal, 0.5);
    const ref = resolveStaticPaints(minimal, 1);
    for (let i = 0; i < ref.paints.length; i++) {
      const [, prop, value] = ref.paints[i];
      const [, , halfValue] = half.paints[i];
      if (SIZE_PAINT_PROPS.has(prop)) {
        expect((halfValue as number) * 2).toBeCloseTo(value as number, 12);
      }
    }
  });
});
