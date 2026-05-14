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
  resolveStaticPaintsForPreview,
  PAINT_REFERENCE_WIDTH,
  PAINT_SIZE_FRACTIONS,
  BUILDINGS_LAYER_SPEC,
  LIVE_MARKER_PULSE_LAYER,
  LIVE_MARKER_DOT_LAYER,
} from '../styleSpec';
import { canonicalMapCssWidth, type AspectRatio } from '../../layout';
import { DEFAULT_MAP_SETTINGS, type MapSettings } from '../../../types';

const minimal: MapSettings = DEFAULT_MAP_SETTINGS;

describe('buildStyleSpec', () => {
  it('default style: returns DEFAULT_STYLE_URL string and pitch 0', () => {
    const result = buildStyleSpec({ ...minimal, map_style: 'default' });
    expect(typeof result.style).toBe('string');
    if (typeof result.style === 'string') {
      expect(result.style.startsWith('https://')).toBe(true);
    }
    expect(result.defaultPitch).toBe(0);
  });

  it('satellite style: returns inline StyleSpecification with v8 + raster source, pitch 0', () => {
    const result = buildStyleSpec({ ...minimal, map_style: 'satellite' });
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
    const def = buildStyleSpec({ ...minimal, map_style: 'default' });
    const threeD = buildStyleSpec({ ...minimal, map_style: '3d' });
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

describe('PAINT_SIZE_FRACTIONS table', () => {
  it('matches the canonical fraction values from the refactor spec', () => {
    // Asserting the table verbatim so the public contract stays pinned —
    // any deliberate change here is intentional and reviewable. Numbers
    // are unitless ratios of map-region CSS width.
    expect(PAINT_SIZE_FRACTIONS.routeFullLineWidth).toBe(0.0075);
    expect(PAINT_SIZE_FRACTIONS.routeTrailLineWidth).toBe(0.01);
    expect(PAINT_SIZE_FRACTIONS.waypointsCircleRadius).toBe(0.0275);
    expect(PAINT_SIZE_FRACTIONS.waypointsActiveRadius).toBe(0.035);
    expect(PAINT_SIZE_FRACTIONS.waypointsCircleStrokeWidth).toBe(0.005);
    expect(PAINT_SIZE_FRACTIONS.waypointsLabelTextSize).toBe(0.0275);
    expect(PAINT_SIZE_FRACTIONS.liveMarkerPulseCircleRadius).toBe(0.02);
    expect(PAINT_SIZE_FRACTIONS.liveMarkerDotCircleRadius).toBe(0.0225);
    expect(PAINT_SIZE_FRACTIONS.liveMarkerDotCircleStrokeWidth).toBe(0.0075);
    expect(PAINT_SIZE_FRACTIONS.pulseStartRadius).toBe(0.02);
    expect(PAINT_SIZE_FRACTIONS.pulseEndRadius).toBe(0.055);
  });
});

describe('resolveStaticPaints', () => {
  function buildMap(
    resolved: ReturnType<typeof resolveStaticPaints>,
  ): { paintBy: Map<string, number>; layoutBy: Map<string, number> } {
    const paintBy = new Map<string, number>();
    for (const [layerId, prop, value] of resolved.paints) {
      paintBy.set(`${layerId}/${prop}`, value);
    }
    const layoutBy = new Map<string, number>();
    for (const [layerId, prop, value] of resolved.layouts) {
      layoutBy.set(`${layerId}/${prop}`, value);
    }
    return { paintBy, layoutBy };
  }

  it('returns canonical values anchored to PAINT_REFERENCE_WIDTH=1080', () => {
    // Under the lever model the renderer-side resolver is width-input-
    // independent: every value equals `fraction × PAINT_REFERENCE_WIDTH`.
    // Trail @ fraction 0.01 → 10.8 CSS px everywhere.
    const resolved = resolveStaticPaints();
    const { paintBy, layoutBy } = buildMap(resolved);
    expect(PAINT_REFERENCE_WIDTH).toBe(1080);
    expect(paintBy.get('route-full-line/line-width')).toBeCloseTo(
      PAINT_SIZE_FRACTIONS.routeFullLineWidth * PAINT_REFERENCE_WIDTH,
      9,
    );
    expect(paintBy.get('route-trail-line/line-width')).toBeCloseTo(
      PAINT_SIZE_FRACTIONS.routeTrailLineWidth * PAINT_REFERENCE_WIDTH,
      9,
    );
    expect(paintBy.get('route-trail-line/line-width')).toBeCloseTo(10.8, 9);
    expect(paintBy.get('waypoints-circle/circle-radius')).toBeCloseTo(
      PAINT_SIZE_FRACTIONS.waypointsCircleRadius * PAINT_REFERENCE_WIDTH,
      9,
    );
    expect(paintBy.get('waypoints-circle/circle-stroke-width')).toBeCloseTo(
      PAINT_SIZE_FRACTIONS.waypointsCircleStrokeWidth * PAINT_REFERENCE_WIDTH,
      9,
    );
    expect(paintBy.get('live-marker-dot/circle-radius')).toBeCloseTo(
      PAINT_SIZE_FRACTIONS.liveMarkerDotCircleRadius * PAINT_REFERENCE_WIDTH,
      9,
    );
    expect(paintBy.get('live-marker-dot/circle-stroke-width')).toBeCloseTo(
      PAINT_SIZE_FRACTIONS.liveMarkerDotCircleStrokeWidth * PAINT_REFERENCE_WIDTH,
      9,
    );
    expect(paintBy.get('live-marker-pulse/circle-radius')).toBeCloseTo(
      PAINT_SIZE_FRACTIONS.liveMarkerPulseCircleRadius * PAINT_REFERENCE_WIDTH,
      9,
    );
    expect(layoutBy.get('waypoints-label/text-size')).toBeCloseTo(
      PAINT_SIZE_FRACTIONS.waypointsLabelTextSize * PAINT_REFERENCE_WIDTH,
      9,
    );
  });

  it('takes no argument and returns the descriptor shape', () => {
    const resolved = resolveStaticPaints();
    expect(Array.isArray(resolved.paints)).toBe(true);
    expect(Array.isArray(resolved.layouts)).toBe(true);
    expect(resolved.paints.length).toBeGreaterThan(0);
    expect(resolved.layouts.length).toBeGreaterThan(0);
    for (const entry of resolved.paints) {
      expect(entry).toHaveLength(3);
      expect(typeof entry[0]).toBe('string');
      expect(typeof entry[1]).toBe('string');
      expect(typeof entry[2]).toBe('number');
    }
    for (const entry of resolved.layouts) {
      expect(entry).toHaveLength(3);
      expect(typeof entry[2]).toBe('number');
    }
  });

  it('emits no color / opacity / stroke-color entries — only size properties', () => {
    const resolved = resolveStaticPaints();
    const props = [
      ...resolved.paints.map(([, p]) => p),
      ...resolved.layouts.map(([, p]) => p),
    ];
    for (const p of props) {
      expect(p).not.toMatch(/color/);
      expect(p).not.toMatch(/opacity/);
    }
  });
});

describe('resolveStaticPaintsForPreview', () => {
  function buildMap(
    resolved: ReturnType<typeof resolveStaticPaintsForPreview>,
  ): { paintBy: Map<string, number>; layoutBy: Map<string, number> } {
    const paintBy = new Map<string, number>();
    for (const [layerId, prop, value] of resolved.paints) {
      paintBy.set(`${layerId}/${prop}`, value);
    }
    const layoutBy = new Map<string, number>();
    for (const [layerId, prop, value] of resolved.layouts) {
      layoutBy.set(`${layerId}/${prop}`, value);
    }
    return { paintBy, layoutBy };
  }

  const aspects: AspectRatio[] = ['9_16', '4_5', '16_9'];

  for (const aspect of aspects) {
    it(`${aspect}: at pane=canonicalMapCssWidth(aspect) values equal resolveStaticPaints()`, () => {
      const canonical = resolveStaticPaints();
      const preview = resolveStaticPaintsForPreview(
        canonicalMapCssWidth(aspect),
        aspect,
      );
      const canonicalMap = buildMap(canonical);
      const previewMap = buildMap(preview);
      for (const [k, v] of canonicalMap.paintBy) {
        expect(previewMap.paintBy.get(k)).toBeCloseTo(v, 9);
      }
      for (const [k, v] of canonicalMap.layoutBy) {
        expect(previewMap.layoutBy.get(k)).toBeCloseTo(v, 9);
      }
    });
  }

  for (const aspect of aspects) {
    it(`${aspect}: halving the pane halves the values`, () => {
      const w = canonicalMapCssWidth(aspect);
      const full = resolveStaticPaintsForPreview(w, aspect);
      const half = resolveStaticPaintsForPreview(w / 2, aspect);
      const fullMap = buildMap(full);
      const halfMap = buildMap(half);
      for (const [k, v] of fullMap.paintBy) {
        expect(halfMap.paintBy.get(k)).toBeCloseTo(v * 0.5, 9);
      }
      for (const [k, v] of fullMap.layoutBy) {
        expect(halfMap.layoutBy.get(k)).toBeCloseTo(v * 0.5, 9);
      }
    });
  }

  it('aspect switch at canonical pane width produces identical trail width — no 10.8 → 19.2 doubling', () => {
    // The product-owner spec invariant: switching from 9:16 to 16:9 at the
    // pane's canonical width must NOT change overlay thickness. Pre-refactor
    // this doubled the trail width (10.8 → 19.2 CSS px) because paints
    // tracked the per-aspect canonical CSS width.
    const at916 = resolveStaticPaintsForPreview(
      canonicalMapCssWidth('9_16'),
      '9_16',
    );
    const at169 = resolveStaticPaintsForPreview(
      canonicalMapCssWidth('16_9'),
      '16_9',
    );
    const m916 = buildMap(at916);
    const m169 = buildMap(at169);
    expect(m916.paintBy.get('route-trail-line/line-width')).toBeCloseTo(
      m169.paintBy.get('route-trail-line/line-width') as number,
      9,
    );
    expect(m916.paintBy.get('waypoints-circle/circle-radius')).toBeCloseTo(
      m169.paintBy.get('waypoints-circle/circle-radius') as number,
      9,
    );
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
