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
  haloGroupPolicy,
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
    // `'waypoint-' + safeMarker(override_marker, projectMarker) + '-<slot>'`;
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
      '"coalesce",["get","override_marker"],"diamond"',
    );
    expect(JSON.stringify(primaryTuple?.[2])).toContain('-primary');
    expect(JSON.stringify(secondaryTuple?.[2])).toContain(
      '"coalesce",["get","override_marker"],"diamond"',
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
      '"coalesce",["get","override_marker"],"pin"',
    );
    expect(JSON.stringify(pinPrimaryTuple?.[2])).not.toContain(
      '"coalesce",["get","override_marker"],"diamond"',
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
    'line-blur',
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

describe('haloGroupPolicy', () => {
  it('falloff-0 degeneracy: core 0 → outerIn 1, coreIn 0, g === outer', () => {
    for (const outer of [0.1, 0.3, 0.6, 0.6129032258064516, 1]) {
      const policy = haloGroupPolicy(outer, 0);
      expect(policy.g).toBeCloseTo(outer, 12);
      // Floating-point: g = 1-(1-outer) is algebraically `outer` but not
      // always bit-identical, so outerIn = outer/g lands within epsilon of
      // 1 rather than exactly 1.
      expect(policy.outerIn).toBeCloseTo(1, 12);
      expect(policy.coreIn).toBe(0);
    }
  });

  it('zero-opacity guard: outer 0, core 0 → all zeros, no NaN', () => {
    const policy = haloGroupPolicy(0, 0);
    expect(policy.g).toBe(0);
    expect(policy.outerIn).toBe(0);
    expect(policy.coreIn).toBe(0);
    expect(Number.isNaN(policy.g)).toBe(false);
    expect(Number.isNaN(policy.outerIn)).toBe(false);
    expect(Number.isNaN(policy.coreIn)).toBe(false);
  });

  it('peak preservation: g === 1 − (1−outer)(1−core) for representative opacity/falloff combos', () => {
    // opacity 0.6, falloff 1 → outer 0.21, core 0.51 (HALO_FALLOFF_OUTER_DIM
    // 0.65 / HALO_FALLOFF_CORE_GAIN 0.85) → g ≈ 0.6129.
    const cases: Array<[number, number]> = [
      [0.21, 0.51],
      [0.6, 0.3],
      [0.05, 0.95],
      [1, 1],
      [0.3375, 0.2125], // opacity 0.5, falloff 0.5
    ];
    for (const [outer, core] of cases) {
      const policy = haloGroupPolicy(outer, core);
      expect(policy.g).toBeCloseTo(1 - (1 - outer) * (1 - core), 12);
    }
    const policy = haloGroupPolicy(0.21, 0.51);
    expect(policy.g).toBeCloseTo(0.6129, 4);
  });

  it('coreIn saturates to 1 whenever core > 0, even vanishingly small', () => {
    expect(haloGroupPolicy(0.5, 1e-9).coreIn).toBe(1);
    expect(haloGroupPolicy(0, 0.4).coreIn).toBe(1);
  });

  it('exactness property: the group composite reproduces the direct two-layer blend at every non-overlapping point', () => {
    // For a grid of (outer, core, f ∈ [0,1]) — f is the core band's local
    // feather fraction (1 on-line, 0 at the core's outer edge) — assert
    // g·[1 − (1−outerIn)(1−f·coreIn)] ≈ outer + f·core·(1−outer) to 1e-12.
    // This is the FBO-flatten-then-composite-once result vs. today's
    // direct alpha-over of the outer band then the core band.
    const outers = [0, 0.1, 0.21, 0.5, 0.6, 1];
    const cores = [0, 0.1, 0.3, 0.51, 0.85, 1];
    const fractions = [0, 0.25, 0.5, 0.75, 1];
    for (const outer of outers) {
      for (const core of cores) {
        const { g, outerIn, coreIn } = haloGroupPolicy(outer, core);
        for (const f of fractions) {
          const composited = g * (1 - (1 - outerIn) * (1 - f * coreIn));
          const directBlend = outer + f * core * (1 - outer);
          expect(composited).toBeCloseTo(directBlend, 12);
        }
      }
    }
  });
});

describe('resolveStaticPaints — route halo', () => {
  const HALO: NonNullable<MapSettings['route']['halo']> = {
    enabled: true,
    color: { mode: 'solid', solid: '#ff00ff' },
    size: 0.004,
    fade: 0.5,
    opacity: 0.6,
  };

  function withHalo(
    halo: MapSettings['route']['halo'],
    mode: MapSettings['route']['mode'] = 'full',
  ): MapSettings {
    return {
      ...DEFAULT_MAP_SETTINGS,
      route: { ...DEFAULT_MAP_SETTINGS.route, mode, halo },
    };
  }

  function byKey(resolved: ReturnType<typeof resolveStaticPaints>) {
    const paintBy = new Map<string, unknown>();
    for (const [layerId, prop, value] of resolved.paints) {
      paintBy.set(`${layerId}/${prop}`, value);
    }
    const layoutBy = new Map<string, unknown>();
    for (const [layerId, prop, value] of resolved.layouts) {
      layoutBy.set(`${layerId}/${prop}`, value);
    }
    return {
      paintBy,
      layoutBy,
      gradBy: new Map(resolved.gradients),
      haloComposites: resolved.haloComposites,
    };
  }

  it('absent halo (legacy project): both halo layers hidden, null gradients', () => {
    const { layoutBy, gradBy } = byKey(resolveStaticPaints(DEFAULT_MAP_SETTINGS));
    expect(layoutBy.get('route-full-halo/visibility')).toBe('none');
    expect(layoutBy.get('route-trail-halo/visibility')).toBe('none');
    expect(gradBy.get('route-full-halo')).toBeNull();
    expect(gradBy.get('route-trail-halo')).toBeNull();
  });

  it('disabled halo (enabled: false) stays hidden, config preserved elsewhere', () => {
    const { layoutBy } = byKey(
      resolveStaticPaints(withHalo({ ...HALO, enabled: false })),
    );
    expect(layoutBy.get('route-full-halo/visibility')).toBe('none');
    expect(layoutBy.get('route-trail-halo/visibility')).toBe('none');
  });

  it('visibility couples halo.enabled with route.mode (per-layer)', () => {
    const full = byKey(resolveStaticPaints(withHalo(HALO, 'full'))).layoutBy;
    expect(full.get('route-full-halo/visibility')).toBe('visible');
    expect(full.get('route-trail-halo/visibility')).toBe('none');

    const visited = byKey(resolveStaticPaints(withHalo(HALO, 'visited'))).layoutBy;
    expect(visited.get('route-full-halo/visibility')).toBe('none');
    expect(visited.get('route-trail-halo/visibility')).toBe('visible');

    const none = byKey(resolveStaticPaints(withHalo(HALO, 'none'))).layoutBy;
    expect(none.get('route-full-halo/visibility')).toBe('none');
    expect(none.get('route-trail-halo/visibility')).toBe('none');
  });

  it('solid halo: color/width/blur/opacity math on both layers', () => {
    // Route width 0.006, spread 0.004 → total (0.006 + 2×0.004) × 1080 =
    // 15.12 px; blur = fade 0.5 × 15.12 / 2 = 3.78 px.
    const { paintBy, gradBy, haloComposites } = byKey(
      resolveStaticPaints(withHalo(HALO)),
    );
    const expectedWidth =
      (DEFAULT_MAP_SETTINGS.route.size.width + 2 * HALO.size) *
      PAINT_REFERENCE_WIDTH;
    for (const layer of ['route-full-halo', 'route-trail-halo']) {
      expect(paintBy.get(`${layer}/line-color`)).toBe('#ff00ff');
      expect(paintBy.get(`${layer}/line-width`)).toBeCloseTo(expectedWidth, 9);
      expect(paintBy.get(`${layer}/line-blur`)).toBeCloseTo(
        (HALO.fade * expectedWidth) / 2,
        9,
      );
      // Falloff absent (0): the group-composite remap collapses the outer
      // band to in-FBO opacity 1 (single opaque coat) and the configured
      // opacity moves entirely to the composite `g` — see `haloComposites`
      // below and `haloGroupPolicy`'s falloff-0 degeneracy.
      expect(paintBy.get(`${layer}/line-opacity`)).toBe(1);
      expect(gradBy.get(layer)).toBeNull();
    }
    // The composite carries the configured opacity at falloff 0 — the
    // group-composite result is byte-identical to the pre-composite single
    // layer at HALO.opacity.
    expect(haloComposites).toContainEqual({
      layers: ['route-full-halo', 'route-full-halo-core'],
      opacity: HALO.opacity,
    });
    expect(haloComposites).toContainEqual({
      layers: ['route-trail-halo', 'route-trail-halo-core'],
      opacity: HALO.opacity,
    });
  });

  it('fade 0 → crisp edge (line-blur 0); fade 1 → half-width feather', () => {
    const crisp = byKey(resolveStaticPaints(withHalo({ ...HALO, fade: 0 })));
    expect(crisp.paintBy.get('route-full-halo/line-blur')).toBe(0);

    const soft = byKey(resolveStaticPaints(withHalo({ ...HALO, fade: 1 })));
    const width = soft.paintBy.get('route-full-halo/line-width') as number;
    expect(soft.paintBy.get('route-full-halo/line-blur')).toBeCloseTo(
      width / 2,
      9,
    );
  });

  it('gradient halo: interpolate expression on line-progress, independent of the route line color', () => {
    const settings = withHalo({
      ...HALO,
      color: {
        mode: 'gradient',
        stops: [
          { fraction: 0, color: '#ffffff' },
          { fraction: 1, color: '#88ccff' },
        ],
      },
    });
    // Route line stays solid — the halo gradient must not leak onto it.
    const { gradBy } = byKey(resolveStaticPaints(settings));
    const expected = [
      'interpolate',
      ['linear'],
      ['line-progress'],
      0,
      '#ffffff',
      1,
      '#88ccff',
    ];
    expect(gradBy.get('route-full-halo')).toEqual(expected);
    expect(gradBy.get('route-trail-halo')).toEqual(expected);
    expect(gradBy.get('route-full-line')).toBeNull();
    expect(gradBy.get('route-trail-line')).toBeNull();
  });

  it('halo width and blur scale with surfaceScale; opacity does not', () => {
    const ref = byKey(resolveStaticPaints(withHalo(HALO), 1));
    const half = byKey(resolveStaticPaints(withHalo(HALO), 0.5));
    expect(half.paintBy.get('route-full-halo/line-width')).toBeCloseTo(
      (ref.paintBy.get('route-full-halo/line-width') as number) * 0.5,
      12,
    );
    expect(half.paintBy.get('route-full-halo/line-blur')).toBeCloseTo(
      (ref.paintBy.get('route-full-halo/line-blur') as number) * 0.5,
      12,
    );
    expect(half.paintBy.get('route-full-halo/line-opacity')).toBe(
      ref.paintBy.get('route-full-halo/line-opacity'),
    );
  });

  // ---- falloff (radial drop-off) ----

  it('falloff absent/0: core layers hidden at opacity 0, outer band at full configured opacity (pre-falloff identity)', () => {
    // Pre-falloff halo block (no falloff field at all — the persisted shape
    // of every halo written before the parameter existed).
    const { paintBy, layoutBy, haloComposites } = byKey(
      resolveStaticPaints(withHalo(HALO)),
    );
    expect(layoutBy.get('route-full-halo-core/visibility')).toBe('none');
    expect(layoutBy.get('route-trail-halo-core/visibility')).toBe('none');
    expect(paintBy.get('route-full-halo-core/line-opacity')).toBe(0);
    // Falloff 0 is the group-composite's degenerate case: the outer band
    // is the only live layer, so it renders at in-FBO opacity 1 (a single
    // opaque coat) and the composite alone carries the configured opacity —
    // see `haloGroupPolicy`. The pre-composite identity ("outer band at the
    // full configured opacity") now lives one level up, in `g`.
    expect(paintBy.get('route-full-halo/line-opacity')).toBe(1);
    expect(haloComposites).toContainEqual({
      layers: ['route-full-halo', 'route-full-halo-core'],
      opacity: HALO.opacity,
    });

    const explicitZero = byKey(
      resolveStaticPaints(withHalo({ ...HALO, falloff: 0 })),
    );
    expect(explicitZero.layoutBy.get('route-full-halo-core/visibility')).toBe(
      'none',
    );
    expect(explicitZero.paintBy.get('route-full-halo/line-opacity')).toBe(1);
    expect(explicitZero.haloComposites).toContainEqual({
      layers: ['route-full-halo', 'route-full-halo-core'],
      opacity: HALO.opacity,
    });
  });

  it('falloff redistributes opacity: outer band dims, core rises; core is narrower and fully feathered', () => {
    const falloff = 1;
    const { paintBy, layoutBy, haloComposites } = byKey(
      resolveStaticPaints(withHalo({ ...HALO, falloff })),
    );
    // Constants from styleSpec.ts: HALO_FALLOFF_OUTER_DIM 0.65,
    // HALO_FALLOFF_CORE_GAIN 0.85, HALO_CORE_SPREAD_FRACTION 0.35. The
    // CONCEPTUAL outer/core opacities feed `haloGroupPolicy`; the emitted
    // `line-opacity` values are the remapped in-FBO ones, and the
    // composite `g` (in `haloComposites`) carries the on-line peak.
    const conceptualOuter = HALO.opacity * (1 - 0.65 * falloff);
    const conceptualCore = HALO.opacity * 0.85 * falloff;
    const policy = haloGroupPolicy(conceptualOuter, conceptualCore);
    expect(paintBy.get('route-full-halo/line-opacity')).toBeCloseTo(
      policy.outerIn,
      12,
    );
    // Core opacity conceptual > 0 whenever falloff > 0, so its in-FBO value
    // saturates to 1 (see `haloGroupPolicy`'s coreIn derivation).
    expect(paintBy.get('route-full-halo-core/line-opacity')).toBe(1);
    expect(haloComposites).toContainEqual({
      layers: ['route-full-halo', 'route-full-halo-core'],
      opacity: policy.g,
    });
    const expectedCoreWidth =
      (DEFAULT_MAP_SETTINGS.route.size.width + 2 * HALO.size * 0.35) *
      PAINT_REFERENCE_WIDTH;
    expect(paintBy.get('route-full-halo-core/line-width')).toBeCloseTo(
      expectedCoreWidth,
      9,
    );
    // Core is always fully feathered — triangular profile peaking at the
    // line — regardless of the outer band's fade.
    expect(paintBy.get('route-full-halo-core/line-blur')).toBeCloseTo(
      expectedCoreWidth / 2,
      9,
    );
    expect(paintBy.get('route-full-halo-core/line-color')).toBe('#ff00ff');
    // Core visibility couples enabled + mode + falloff > 0.
    expect(layoutBy.get('route-full-halo-core/visibility')).toBe('visible');
    expect(layoutBy.get('route-trail-halo-core/visibility')).toBe('none');
  });

  it('core layers share the outer band gradient', () => {
    const settings = withHalo({
      ...HALO,
      falloff: 0.5,
      color: {
        mode: 'gradient',
        stops: [
          { fraction: 0, color: '#ffffff' },
          { fraction: 1, color: '#88ccff' },
        ],
      },
    });
    const { gradBy } = byKey(resolveStaticPaints(settings));
    expect(gradBy.get('route-full-halo-core')).toEqual(
      gradBy.get('route-full-halo'),
    );
    expect(gradBy.get('route-trail-halo-core')).toEqual(
      gradBy.get('route-trail-halo'),
    );
  });

  // ---- offset (drop shadow) ----

  it('offset absent → line-translate [0, 0]; offsets emit reference-px translate on all four halo layers', () => {
    const none = byKey(resolveStaticPaints(withHalo(HALO)));
    expect(none.paintBy.get('route-full-halo/line-translate')).toEqual([0, 0]);

    const offset = byKey(
      resolveStaticPaints(
        withHalo({ ...HALO, offset_x: 0.005, offset_y: -0.01 }),
      ),
    );
    const expected = [
      0.005 * PAINT_REFERENCE_WIDTH,
      -0.01 * PAINT_REFERENCE_WIDTH,
    ];
    for (const layer of [
      'route-full-halo',
      'route-trail-halo',
      'route-full-halo-core',
      'route-trail-halo-core',
    ]) {
      expect(offset.paintBy.get(`${layer}/line-translate`)).toEqual(expected);
    }
  });

  it('offset scales with surfaceScale (reference-space fraction, like every size)', () => {
    const settings = withHalo({ ...HALO, offset_x: 0.01, offset_y: 0.02 });
    const ref = byKey(resolveStaticPaints(settings, 1));
    const half = byKey(resolveStaticPaints(settings, 0.5));
    const refT = ref.paintBy.get('route-full-halo/line-translate') as number[];
    const halfT = half.paintBy.get(
      'route-full-halo/line-translate',
    ) as number[];
    expect(halfT[0]).toBeCloseTo(refT[0] * 0.5, 12);
    expect(halfT[1]).toBeCloseTo(refT[1] * 0.5, 12);
  });
});

describe('resolveStaticPaints — waypoint + POV halos', () => {
  const HALO: NonNullable<MapSettings['waypoints']['halo']> = {
    enabled: true,
    color: { mode: 'solid', solid: '#00ffcc' },
    size: 0.006,
    fade: 0.4,
    opacity: 0.5,
    falloff: 0,
    offset_x: 0,
    offset_y: 0,
  };

  function byKey(resolved: ReturnType<typeof resolveStaticPaints>) {
    const paintBy = new Map<string, unknown>();
    for (const [layerId, prop, value] of resolved.paints) {
      paintBy.set(`${layerId}/${prop}`, value);
    }
    const layoutBy = new Map<string, unknown>();
    for (const [layerId, prop, value] of resolved.layouts) {
      layoutBy.set(`${layerId}/${prop}`, value);
    }
    return { paintBy, layoutBy, haloComposites: resolved.haloComposites };
  }

  it('absent halos (legacy projects): all four marker halo layers hidden', () => {
    const { layoutBy, haloComposites } = byKey(
      resolveStaticPaints(DEFAULT_MAP_SETTINGS),
    );
    for (const layer of [
      'waypoints-halo',
      'waypoints-halo-core',
      'live-marker-halo',
      'live-marker-halo-core',
    ]) {
      expect(layoutBy.get(`${layer}/visibility`)).toBe('none');
    }
    // Defensive-read path: absent halos resolve to opacity 0 everywhere, so
    // the composite bucket still carries exactly four groups and no NaN —
    // the layers are hidden either way, so the composite is harmless.
    expect(haloComposites).toHaveLength(4);
    for (const group of haloComposites) {
      expect(Number.isNaN(group.opacity)).toBe(false);
    }
  });

  it('waypoints halo: radius = (circle_radius + spread) × w, circle-blur carries fade unscaled', () => {
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      waypoints: { ...DEFAULT_MAP_SETTINGS.waypoints, halo: HALO },
    };
    const { paintBy, layoutBy, haloComposites } = byKey(
      resolveStaticPaints(settings),
    );
    expect(layoutBy.get('waypoints-halo/visibility')).toBe('visible');
    expect(layoutBy.get('waypoints-halo-core/visibility')).toBe('none');
    const expectedRadius =
      (DEFAULT_MAP_SETTINGS.waypoints.size.circle_radius + HALO.size) *
      PAINT_REFERENCE_WIDTH;
    expect(paintBy.get('waypoints-halo/circle-radius')).toBeCloseTo(
      expectedRadius,
      9,
    );
    expect(paintBy.get('waypoints-halo/circle-color')).toBe('#00ffcc');
    // Falloff 0 (HALO.falloff here is explicitly 0) → group-composite
    // degenerate case: in-FBO opacity 1, configured opacity moves to `g`.
    expect(paintBy.get('waypoints-halo/circle-opacity')).toBe(1);
    expect(haloComposites).toContainEqual({
      layers: ['waypoints-halo', 'waypoints-halo-core'],
      opacity: HALO.opacity,
    });
    // circle-blur is dimensionless — fade maps directly and must NOT ride
    // the surface factor.
    expect(paintBy.get('waypoints-halo/circle-blur')).toBe(HALO.fade);
    const half = byKey(resolveStaticPaints(settings, 0.5));
    expect(half.paintBy.get('waypoints-halo/circle-blur')).toBe(HALO.fade);
    expect(half.paintBy.get('waypoints-halo/circle-radius')).toBeCloseTo(
      expectedRadius * 0.5,
      9,
    );
  });

  it('waypoints halo gradient: interpolate on the per-feature progress property', () => {
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      waypoints: {
        ...DEFAULT_MAP_SETTINGS.waypoints,
        halo: {
          ...HALO,
          color: {
            mode: 'gradient',
            stops: [
              { fraction: 0, color: '#ff0000' },
              { fraction: 1, color: '#0000ff' },
            ],
          },
        },
      },
    };
    const { paintBy } = byKey(resolveStaticPaints(settings));
    expect(paintBy.get('waypoints-halo/circle-color')).toEqual([
      'interpolate',
      ['linear'],
      ['get', 'progress'],
      0,
      '#ff0000',
      1,
      '#0000ff',
    ]);
    // Core twin shares the color expression.
    expect(paintBy.get('waypoints-halo-core/circle-color')).toEqual(
      paintBy.get('waypoints-halo/circle-color'),
    );
  });

  it('POV halo: radius from the dot body for dot/shape markers, image_size/2 for registered image markers', () => {
    const withPovHalo = (pov: Partial<MapSettings['pov']>): MapSettings => ({
      ...DEFAULT_MAP_SETTINGS,
      pov: { ...DEFAULT_MAP_SETTINGS.pov, halo: HALO, ...pov },
    });

    const dot = byKey(resolveStaticPaints(withPovHalo({})));
    expect(dot.layoutBy.get('live-marker-halo/visibility')).toBe('visible');
    expect(dot.paintBy.get('live-marker-halo/circle-radius')).toBeCloseTo(
      (DEFAULT_MAP_SETTINGS.pov.size.dot_radius + HALO.size) *
        PAINT_REFERENCE_WIDTH,
      9,
    );

    // Image marker registered in the library → body radius image_size / 2.
    const image = byKey(
      resolveStaticPaints({
        ...withPovHalo({ marker: { kind: 'image', image_id: 'abc123' } }),
        marker_images: [
          {
            id: 'abc123',
            icon_file: 'assets/marker-icon-abc123.png',
            source_file: 'assets/marker-source-abc123.png',
            source_name: 'x.png',
            width: 512,
            height: 512,
          },
        ],
      }),
    );
    expect(image.paintBy.get('live-marker-halo/circle-radius')).toBeCloseTo(
      (DEFAULT_MAP_SETTINGS.pov.size.image_size / 2 + HALO.size) *
        PAINT_REFERENCE_WIDTH,
      9,
    );

    // Unregistered image id collapses to the dot (mirrors the marker's own
    // fallback), so the halo sizes for the dot that actually renders.
    const missing = byKey(
      resolveStaticPaints(
        withPovHalo({ marker: { kind: 'image', image_id: 'nope' } }),
      ),
    );
    expect(missing.paintBy.get('live-marker-halo/circle-radius')).toBeCloseTo(
      (DEFAULT_MAP_SETTINGS.pov.size.dot_radius + HALO.size) *
        PAINT_REFERENCE_WIDTH,
      9,
    );
  });

  it('marker halo falloff: outer dims, core rises and becomes visible; offsets emit circle-translate', () => {
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      pov: {
        ...DEFAULT_MAP_SETTINGS.pov,
        halo: { ...HALO, falloff: 0.5, offset_x: 0.002, offset_y: 0.004 },
      },
    };
    const { paintBy, layoutBy, haloComposites } = byKey(
      resolveStaticPaints(settings),
    );
    expect(layoutBy.get('live-marker-halo-core/visibility')).toBe('visible');
    // Emitted opacities are the group-composite in-FBO remap: outerIn from
    // `haloGroupPolicy`, core saturates to 1 (conceptual core > 0 whenever
    // falloff > 0), and the composite `g` carries the on-line peak.
    const conceptualOuter = HALO.opacity * (1 - 0.65 * 0.5);
    const conceptualCore = HALO.opacity * 0.85 * 0.5;
    const policy = haloGroupPolicy(conceptualOuter, conceptualCore);
    expect(paintBy.get('live-marker-halo/circle-opacity')).toBeCloseTo(
      policy.outerIn,
      12,
    );
    expect(paintBy.get('live-marker-halo-core/circle-opacity')).toBe(1);
    expect(haloComposites).toContainEqual({
      layers: ['live-marker-halo', 'live-marker-halo-core'],
      opacity: policy.g,
    });
    // Core hugs the marker: spread × HALO_CORE_SPREAD_FRACTION, fully soft.
    expect(paintBy.get('live-marker-halo-core/circle-radius')).toBeCloseTo(
      (DEFAULT_MAP_SETTINGS.pov.size.dot_radius + HALO.size * 0.35) *
        PAINT_REFERENCE_WIDTH,
      9,
    );
    expect(paintBy.get('live-marker-halo-core/circle-blur')).toBe(1);
    const expectedTranslate = [
      0.002 * PAINT_REFERENCE_WIDTH,
      0.004 * PAINT_REFERENCE_WIDTH,
    ];
    expect(paintBy.get('live-marker-halo/circle-translate')).toEqual(
      expectedTranslate,
    );
    expect(paintBy.get('live-marker-halo-core/circle-translate')).toEqual(
      expectedTranslate,
    );
  });
});
