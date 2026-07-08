// Tests for the marker-image library pipeline (markerImage.ts) and its
// resolveStaticPaints integration: registration density (pixelRatio k),
// reference-space icon-size denomination incl. surfaceScale, the three-way
// POV marker visibility swap (dot / shape presets / library image), the
// waypoint marker expressions (SDF/raster layer split), and the
// resampler's alpha correctness (premultiplied averaging — no dark-fringe
// bleed at transparent edges).

import { describe, it, expect } from 'vitest';
import {
  buildMarkerImageIcon,
  markerImageIconId,
  markerImagePixelRatio,
  resampleRgba,
  transparentRasterEntry,
  MARKER_IMAGE_CANONICAL_SIZE,
  MARKER_IMAGE_MAX_PIXEL_RATIO,
  TRANSPARENT_RASTER_ICON_ID,
  type RgbaBitmap,
} from '../markerImage';
import { TRANSPARENT_SDF_ICON_ID, buildShapeIconsFor } from '../shapes';
import {
  resolveStaticPaints,
  PAINT_REFERENCE_WIDTH,
  SHAPE_CANONICAL_RADIUS,
  LIVE_MARKER_IMAGE_LAYER,
  LIVE_MARKER_SHAPE_PRIMARY_LAYER,
  LIVE_MARKER_SHAPE_SECONDARY_LAYER,
  WAYPOINTS_IMAGE_LAYER,
} from '../styleSpec';
import {
  DEFAULT_MAP_SETTINGS,
  type MapSettings,
  type MarkerImageRef,
  type PovMarker,
} from '../../../types';

function solidBitmap(
  w: number,
  h: number,
  rgba: [number, number, number, number],
): RgbaBitmap {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  return { width: w, height: h, data };
}

const IMAGE_REF: MarkerImageRef = {
  id: 'abc1230000000000',
  icon_file: 'assets/pov-icon-abc1230000000000.png',
  source_file: 'assets/pov-source-abc1230000000000.png',
  source_name: 'will.png',
  width: 300,
  height: 376,
};

function withLibrary(
  settings: MapSettings,
  povMarker?: PovMarker,
): MapSettings {
  return {
    ...settings,
    marker_images: [IMAGE_REF],
    pov: { ...settings.pov, marker: povMarker },
  };
}

const layoutOf = (
  resolved: ReturnType<typeof resolveStaticPaints>,
  layer: string,
  prop: string,
) => resolved.layouts.find(([l, p]) => l === layer && p === prop)?.[2];
const paintOf = (
  resolved: ReturnType<typeof resolveStaticPaints>,
  layer: string,
  prop: string,
) => resolved.paints.find(([l, p]) => l === layer && p === prop)?.[2];

describe('markerImagePixelRatio', () => {
  it('picks the smallest k covering the framebuffer footprint', () => {
    // 86.4 css × dpr 2 = 172.8 fb px → k = ceil(172.8 / 128) = 2.
    expect(markerImagePixelRatio(86.4, 2, 4096)).toBe(2);
    // Export at pixelRatio 4 (2× resolution × 2× SSAA): 345.6 → k = 3.
    expect(markerImagePixelRatio(86.4, 4, 4096)).toBe(3);
  });

  it('never exceeds the native 1024-texel cap (k ≤ 8)', () => {
    expect(markerImagePixelRatio(1000, 4, 100000)).toBe(
      MARKER_IMAGE_MAX_PIXEL_RATIO,
    );
  });

  it('caps at the master density — upsampling buys no detail', () => {
    // Master longest side 300 texels → cap k = ceil(300/128) = 3 even
    // though the display wants more.
    expect(markerImagePixelRatio(500, 4, 300)).toBe(3);
  });

  it('floors at k = 1 for tiny display sizes and tiny masters', () => {
    expect(markerImagePixelRatio(10, 1, 64)).toBe(1);
  });
});

describe('buildMarkerImageIcon', () => {
  it('normalizes the longest side to 128·k texels, preserving aspect', () => {
    const master = solidBitmap(300, 376, [10, 200, 30, 255]);
    // display 86.4 css × dpr 2 → k=2 (master cap ceil(376/128)=3 not binding)
    const entry = buildMarkerImageIcon(IMAGE_REF.id, master, 86.4, 2);
    expect(entry.id).toBe(markerImageIconId(IMAGE_REF.id));
    expect(entry.id).toBe(`marker-image-${IMAGE_REF.id}`);
    expect(entry.options.sdf).toBe(false);
    expect(entry.options.pixelRatio).toBe(2);
    expect(entry.icon.height).toBe(MARKER_IMAGE_CANONICAL_SIZE * 2); // longest side
    expect(entry.icon.width).toBe(Math.round(300 * (256 / 376)));
    // Natural CSS longest side is 128 regardless of k — the icon-size
    // bridge in resolveStaticPaints depends on this invariant.
    expect(entry.icon.height / entry.options.pixelRatio).toBe(
      MARKER_IMAGE_CANONICAL_SIZE,
    );
  });

  it('returns the master untouched when dims already match the target', () => {
    const master = solidBitmap(256, 256, [1, 2, 3, 255]);
    const entry = buildMarkerImageIcon(IMAGE_REF.id, master, 86.4, 2); // k=2 → 256
    expect(entry.icon).toBe(master);
  });

  it('throws on dim/byte-length mismatches (loud, no silent garbage)', () => {
    const bad: RgbaBitmap = { width: 4, height: 4, data: new Uint8Array(7) };
    expect(() => buildMarkerImageIcon('x', bad, 86.4, 2)).toThrow(/byte length/);
    expect(() =>
      buildMarkerImageIcon(
        'x',
        { width: 0, height: 4, data: new Uint8Array(0) },
        86.4,
        2,
      ),
    ).toThrow(/degenerate/);
  });
});

describe('transparent placeholders', () => {
  it('raster placeholder is a 1×1 non-SDF fully transparent icon', () => {
    const entry = transparentRasterEntry();
    expect(entry.id).toBe(TRANSPARENT_RASTER_ICON_ID);
    expect(entry.options.sdf).toBe(false);
    expect(entry.icon.width).toBe(1);
    expect(entry.icon.height).toBe(1);
    expect(Array.from(entry.icon.data)).toEqual([0, 0, 0, 0]);
  });
});

describe('resampleRgba', () => {
  it('area-averages exactly on integer downscale', () => {
    // 2×2 → 1×1 of four opaque grays: exact mean.
    const src: RgbaBitmap = {
      width: 2,
      height: 2,
      data: new Uint8Array([
        100, 100, 100, 255, 200, 200, 200, 255,
        100, 100, 100, 255, 200, 200, 200, 255,
      ]),
    };
    const out = resampleRgba(src, 1, 1);
    expect(Array.from(out.data)).toEqual([150, 150, 150, 255]);
  });

  it('does not bleed hidden RGB of transparent pixels into edges', () => {
    // Opaque red next to TRANSPARENT GREEN (alpha 0, hidden G=255). A naive
    // straight-alpha average would produce a greenish rim; premultiplied
    // averaging must keep the color pure red with halved alpha.
    const src: RgbaBitmap = {
      width: 2,
      height: 1,
      data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 0]),
    };
    const out = resampleRgba(src, 1, 1);
    expect(out.data[0]).toBe(255); // red survives unpremultiply
    expect(out.data[1]).toBe(0); // hidden green contributes nothing
    expect(out.data[3]).toBe(128); // alpha is the honest average
  });

  it('keeps a solid color exactly solid through bilinear upscale', () => {
    const src = solidBitmap(3, 3, [40, 80, 120, 255]);
    const out = resampleRgba(src, 9, 9);
    for (let i = 0; i < 9 * 9; i++) {
      expect(out.data[i * 4]).toBe(40);
      expect(out.data[i * 4 + 1]).toBe(80);
      expect(out.data[i * 4 + 2]).toBe(120);
      expect(out.data[i * 4 + 3]).toBe(255);
    }
  });
});

describe('resolveStaticPaints POV marker tuples (three-way swap)', () => {
  it('defaults to the dot: shape + image layers hidden, dot visible', () => {
    const resolved = resolveStaticPaints(DEFAULT_MAP_SETTINGS);
    expect(layoutOf(resolved, 'live-marker-dot', 'visibility')).toBe('visible');
    expect(layoutOf(resolved, 'live-marker-image', 'visibility')).toBe('none');
    expect(layoutOf(resolved, 'live-marker-shape-primary', 'visibility')).toBe('none');
    expect(layoutOf(resolved, 'live-marker-shape-secondary', 'visibility')).toBe('none');
    // No icon-image tuple → engines never resolve an id unregistered.
    expect(layoutOf(resolved, 'live-marker-image', 'icon-image')).toBeUndefined();
    expect(layoutOf(resolved, 'live-marker-shape-primary', 'icon-image')).toBeUndefined();
  });

  it('image marker: swaps to the image layer with icon-image + icon-size', () => {
    const settings = withLibrary(DEFAULT_MAP_SETTINGS, {
      kind: 'image',
      image_id: IMAGE_REF.id,
    });
    const resolved = resolveStaticPaints(settings);
    expect(layoutOf(resolved, 'live-marker-image', 'visibility')).toBe('visible');
    expect(layoutOf(resolved, 'live-marker-dot', 'visibility')).toBe('none');
    expect(layoutOf(resolved, 'live-marker-shape-primary', 'visibility')).toBe('none');
    expect(layoutOf(resolved, 'live-marker-image', 'icon-image')).toBe(
      markerImageIconId(IMAGE_REF.id),
    );
    expect(layoutOf(resolved, 'live-marker-image', 'icon-size')).toBeCloseTo(
      (DEFAULT_MAP_SETTINGS.pov.size.image_size * PAINT_REFERENCE_WIDTH) /
        MARKER_IMAGE_CANONICAL_SIZE,
    );
  });

  it('shape marker: swaps to the SDF pair with pov-prefixed icons sized by dot_radius', () => {
    const settings = withLibrary(DEFAULT_MAP_SETTINGS, {
      kind: 'shape',
      shape: 'ring',
    });
    const resolved = resolveStaticPaints(settings);
    expect(layoutOf(resolved, 'live-marker-shape-primary', 'visibility')).toBe('visible');
    expect(layoutOf(resolved, 'live-marker-shape-secondary', 'visibility')).toBe('visible');
    expect(layoutOf(resolved, 'live-marker-dot', 'visibility')).toBe('none');
    expect(layoutOf(resolved, 'live-marker-image', 'visibility')).toBe('none');
    expect(layoutOf(resolved, 'live-marker-shape-primary', 'icon-image')).toBe(
      'pov-ring-primary',
    );
    expect(layoutOf(resolved, 'live-marker-shape-secondary', 'icon-image')).toBe(
      'pov-ring-secondary',
    );
    const expected =
      (DEFAULT_MAP_SETTINGS.pov.size.dot_radius * PAINT_REFERENCE_WIDTH) /
      SHAPE_CANONICAL_RADIUS;
    expect(layoutOf(resolved, 'live-marker-shape-primary', 'icon-size')).toBeCloseTo(expected);
    expect(layoutOf(resolved, 'live-marker-shape-secondary', 'icon-size')).toBeCloseTo(expected);
  });

  it('tints the shape slots with the POV colors (primary body, secondary outline)', () => {
    const settings: MapSettings = {
      ...withLibrary(DEFAULT_MAP_SETTINGS, { kind: 'shape', shape: 'square' }),
    };
    settings.pov = { ...settings.pov, color: '#123456', secondary_color: '#654321' };
    const resolved = resolveStaticPaints(settings);
    expect(paintOf(resolved, 'live-marker-shape-primary', 'icon-color')).toBe('#123456');
    expect(paintOf(resolved, 'live-marker-shape-secondary', 'icon-color')).toBe('#654321');
  });

  it('explicit dot marker renders through the original dot circle layer', () => {
    const settings = withLibrary(DEFAULT_MAP_SETTINGS, {
      kind: 'shape',
      shape: 'dot',
    });
    const resolved = resolveStaticPaints(settings);
    expect(layoutOf(resolved, 'live-marker-dot', 'visibility')).toBe('visible');
    expect(layoutOf(resolved, 'live-marker-image', 'visibility')).toBe('none');
    expect(layoutOf(resolved, 'live-marker-shape-primary', 'visibility')).toBe('none');
  });

  it('falls back to the dot when an image marker references a missing library id', () => {
    const settings = withLibrary(DEFAULT_MAP_SETTINGS, {
      kind: 'image',
      image_id: 'not-in-the-library',
    });
    const resolved = resolveStaticPaints(settings);
    expect(layoutOf(resolved, 'live-marker-dot', 'visibility')).toBe('visible');
    expect(layoutOf(resolved, 'live-marker-image', 'visibility')).toBe('none');
    expect(layoutOf(resolved, 'live-marker-image', 'icon-image')).toBeUndefined();
  });

  it('scales image icon-size by surfaceScale (reference-space denomination)', () => {
    const scale = 0.4863;
    const settings = withLibrary(DEFAULT_MAP_SETTINGS, {
      kind: 'image',
      image_id: IMAGE_REF.id,
    });
    const resolved = resolveStaticPaints(settings, scale);
    expect(layoutOf(resolved, 'live-marker-image', 'icon-size')).toBeCloseTo(
      (DEFAULT_MAP_SETTINGS.pov.size.image_size *
        PAINT_REFERENCE_WIDTH *
        scale) /
        MARKER_IMAGE_CANONICAL_SIZE,
    );
  });

  it('keeps the pulse rings independent of the marker swap', () => {
    const settings = withLibrary(DEFAULT_MAP_SETTINGS, {
      kind: 'image',
      image_id: IMAGE_REF.id,
    });
    const resolved = resolveStaticPaints(settings);
    const pulseTuples = resolved.paints.filter(([l]) =>
      l.startsWith('live-marker-pulse'),
    );
    expect(pulseTuples.length).toBeGreaterThan(0);
    expect(
      resolved.layouts.find(
        ([l, p]) => l.startsWith('live-marker-pulse') && p === 'visibility',
      ),
    ).toBeUndefined();
  });
});

describe('resolveStaticPaints waypoint marker expressions', () => {
  it('routes image-marked features to the raster layer and transparent-SDF on the shape layers', () => {
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      marker_images: [IMAGE_REF],
    };
    const resolved = resolveStaticPaints(settings);
    const primary = layoutOf(resolved, 'waypoints-primary', 'icon-image');
    const image = layoutOf(resolved, 'waypoints-image', 'icon-image');
    // With library entries the SDF slots gain a match wrapper whose image
    // arms resolve the transparent SDF placeholder…
    expect(JSON.stringify(primary)).toContain(TRANSPARENT_SDF_ICON_ID);
    expect(JSON.stringify(primary)).toContain(`image:${IMAGE_REF.id}`);
    // …and the raster layer's expression maps image arms to their texture
    // ids with the transparent raster placeholder as the shape fallback.
    expect(JSON.stringify(image)).toContain(markerImageIconId(IMAGE_REF.id));
    expect(JSON.stringify(image)).toContain(TRANSPARENT_RASTER_ICON_ID);
  });

  it('collapses to a constant transparent raster icon-image with an empty library', () => {
    const resolved = resolveStaticPaints(DEFAULT_MAP_SETTINGS);
    expect(layoutOf(resolved, 'waypoints-image', 'icon-image')).toBe(
      TRANSPARENT_RASTER_ICON_ID,
    );
  });

  it('seeds the image layer icon-size at the shape DIAMETER bridge (divisor 64)', () => {
    const resolved = resolveStaticPaints(DEFAULT_MAP_SETTINGS);
    expect(layoutOf(resolved, 'waypoints-image', 'icon-size')).toBeCloseTo(
      (DEFAULT_MAP_SETTINGS.waypoints.size.circle_radius *
        PAINT_REFERENCE_WIDTH) /
        (MARKER_IMAGE_CANONICAL_SIZE / 2),
    );
  });

  it('uses the project marker_image_id as the coalesce fallback when set', () => {
    const settings: MapSettings = {
      ...DEFAULT_MAP_SETTINGS,
      marker_images: [IMAGE_REF],
      waypoints: {
        ...DEFAULT_MAP_SETTINGS.waypoints,
        marker_image_id: IMAGE_REF.id,
      },
    };
    const resolved = resolveStaticPaints(settings);
    const image = layoutOf(resolved, 'waypoints-image', 'icon-image');
    // The coalesce fallback (project marker) is the image: arm.
    expect(JSON.stringify(image)).toContain(
      `["coalesce",["get","override_marker"],"image:${IMAGE_REF.id}"]`,
    );
  });
});

describe('POV shape-preset atlas', () => {
  it('registers pov-prefixed icons for the pov domain (no circle — the dot stands in)', () => {
    const entries = buildShapeIconsFor('pov', 'pov-', {
      outlineThickness: 4,
      pixelRatio: 1,
    });
    const ids = entries.map((e) => e.id);
    expect(ids).toContain('pov-ring-primary');
    expect(ids).toContain('pov-square-primary');
    expect(ids).toContain('pov-diamond-secondary');
    expect(ids.some((id) => id.startsWith('pov-circle'))).toBe(false);
    expect(ids.some((id) => id.startsWith('pov-pin'))).toBe(false);
    for (const e of entries) expect(e.options.sdf).toBe(true);
  });
});

describe('marker layer specs', () => {
  it('LIVE_MARKER_IMAGE_LAYER is a non-collision symbol layer on live-marker, seeded hidden', () => {
    expect(LIVE_MARKER_IMAGE_LAYER.type).toBe('symbol');
    expect((LIVE_MARKER_IMAGE_LAYER as { source?: string }).source).toBe('live-marker');
    const layout = LIVE_MARKER_IMAGE_LAYER.layout as Record<string, unknown>;
    expect(layout.visibility).toBe('none');
    expect(layout['icon-allow-overlap']).toBe(true);
    expect(layout['icon-ignore-placement']).toBe(true);
    expect(layout['icon-anchor']).toBe('center');
    // Seed id must be a registered texture (the transparent placeholder),
    // never a marker-image id that might not exist yet.
    expect(layout['icon-image']).toBe(TRANSPARENT_RASTER_ICON_ID);
  });

  it('the POV shape pair mirrors the image layer, seeded hidden with SDF placeholders', () => {
    for (const layer of [
      LIVE_MARKER_SHAPE_PRIMARY_LAYER,
      LIVE_MARKER_SHAPE_SECONDARY_LAYER,
    ]) {
      expect(layer.type).toBe('symbol');
      expect((layer as { source?: string }).source).toBe('live-marker');
      const layout = layer.layout as Record<string, unknown>;
      expect(layout.visibility).toBe('none');
      expect(layout['icon-image']).toBe(TRANSPARENT_SDF_ICON_ID);
    }
  });

  it('WAYPOINTS_IMAGE_LAYER ignores placement so placeholders cannot perturb label collision', () => {
    expect(WAYPOINTS_IMAGE_LAYER.type).toBe('symbol');
    expect((WAYPOINTS_IMAGE_LAYER as { source?: string }).source).toBe('waypoints');
    const layout = WAYPOINTS_IMAGE_LAYER.layout as Record<string, unknown>;
    expect(layout['icon-allow-overlap']).toBe(true);
    expect(layout['icon-ignore-placement']).toBe(true);
    expect(layout['icon-anchor']).toBe('center');
    expect(layout['icon-image']).toBe(TRANSPARENT_RASTER_ICON_ID);
    // No icon-color — full-color bitmaps must never run the SDF tint path.
    expect(
      (WAYPOINTS_IMAGE_LAYER.paint as Record<string, unknown>)['icon-color'],
    ).toBeUndefined();
  });
});
