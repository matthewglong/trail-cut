// Style + layer specs for the map. The single source of truth for what the
// map looks like at setup time. The 3D-buildings layer, the route lines, the
// waypoints, and the live-marker circle pair all live here as exported
// LayerSpecifications — the consumer (preview MapView and the export worker)
// adds them via `map.addLayer` at style.load. Embedding them in the returned
// StyleSpecification doesn't work for URL-based styles (default/3d use the
// remote OpenFreeMap liberty style), so the consistent pattern is "consumer
// owns addLayer; this module owns the spec."
//
// Paint sizing is expressed as DIMENSIONLESS FRACTIONS stored directly on
// `MapSettings` (one `overlay_*` field per paint property). The renderer
// multiplies each fraction by `PAINT_REFERENCE_WIDTH` (1080 CSS px) — every
// aspect, every resolution, every slot shape gets the same CSS-px size for
// a given resolved `MapSettings`. Aspect / resolution / slot shape are
// absorbed by the renderer's lever model: cssViewport matches the slot
// shape and `pixelRatio` carries the output-resolution delta. The preview
// uses the same `resolveStaticPaints(mapSettings)` call. Per-clip overrides
// fall out of `Clip.map_overrides` (a `Partial<MapSettings>`) via the
// existing `resolveMapSettings` merge. See `MAP_RENDERING_PLAN.md` for the
// derivation.

import type {
  StyleSpecification,
  LayerSpecification,
} from 'maplibre-gl';
import type { MapSettings } from '../../types';
import { colors } from '../../theme/tokens';
import type { StyleSpecResult } from './types';

const TRAIL_COLOR = colors.accent;
const FULL_ROUTE_COLOR = colors.accent;

/** Anchor for paint sizing. Trail @ fraction 0.0055 → ~5.94 CSS px at the
 *  seeded default, scaled identically across every aspect, every resolution,
 *  every slot shape, every preview pane width. Both renderer and preview
 *  pass `MapSettings` through `resolveStaticPaints()`. See
 *  `MAP_RENDERING_PLAN.md` §"Paint sizes as fixed CSS-px constants". */
export const PAINT_REFERENCE_WIDTH = 1080;

/** OpenFreeMap "liberty" vector style. Used for both `default` and `3d`
 *  modes — the only difference between them is `defaultPitch` and the
 *  conditional 3D-buildings layer the consumer adds at style.load. */
export const DEFAULT_STYLE_URL =
  'https://tiles.openfreemap.org/styles/liberty';

/** Inline raster style for `satellite` mode. Esri World Imagery tiles, with
 *  a single raster layer and the demotiles glyphs URL so any text labels
 *  added on top (today: `waypoints-label`) can resolve a font stack. */
export const SATELLITE_STYLE: StyleSpecification = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    satellite: {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      attribution:
        'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    },
  },
  layers: [{ id: 'satellite', type: 'raster', source: 'satellite' }],
};

/** 3D buildings extrusion. Sourced from the OpenFreeMap liberty style's
 *  `openmaptiles` vector source, source-layer `building`. Only added when
 *  `mapSettings.map_style === '3d'` AND the source exists at style.load.
 *
 *  Heights coalesce render-height → height → 3 (literal default for
 *  buildings without authored height). */
export const BUILDINGS_LAYER_SPEC: LayerSpecification = {
  id: '3d-buildings',
  source: 'openmaptiles',
  'source-layer': 'building',
  type: 'fill-extrusion',
  minzoom: 14,
  paint: {
    'fill-extrusion-color': '#cfd3d8',
    'fill-extrusion-height': [
      'coalesce',
      ['get', 'render_height'],
      ['get', 'height'],
      3,
    ],
    'fill-extrusion-base': [
      'coalesce',
      ['get', 'render_min_height'],
      ['get', 'min_height'],
      0,
    ],
    'fill-extrusion-opacity': 0.85,
  },
};

/** Full-route line. Visibility toggled by the consumer based on
 *  `mapSettings.route_mode === 'full'`. Source: `route-full`.
 *
 *  `line-width` is a PLACEHOLDER (1) — the real value is
 *  `mapSettings.overlay_route_full_width × PAINT_REFERENCE_WIDTH`. Both
 *  renderer and preview call `resolveStaticPaints(mapSettings)` after
 *  style.load (and again when any overlay-size or active-clip override
 *  changes) to seed the value. */
export const ROUTE_FULL_LAYER: LayerSpecification = {
  id: 'route-full-line',
  type: 'line',
  source: 'route-full',
  layout: { 'line-join': 'round', 'line-cap': 'round' },
  paint: {
    'line-color': FULL_ROUTE_COLOR,
    'line-width': 1,
    'line-opacity': 0.8,
  },
};

/** Slime-trail line. Visibility toggled by the consumer based on
 *  `mapSettings.route_mode === 'visited'`. Source: `route-trail`.
 *
 *  `line-width` is a PLACEHOLDER — see resolveStaticPaints. */
export const ROUTE_TRAIL_LAYER: LayerSpecification = {
  id: 'route-trail-line',
  type: 'line',
  source: 'route-trail',
  layout: { 'line-join': 'round', 'line-cap': 'round' },
  paint: {
    'line-color': TRAIL_COLOR,
    'line-width': 1,
    'line-opacity': 0.95,
  },
};

/** Waypoint circle layer. Paint is overridden per-frame via
 *  `setPaintProperty` from `buildPerFramePaints` to express the active-clip
 *  highlight as a data-driven `case` expression. The literal defaults below
 *  are PLACEHOLDERS (1) — the consumer must apply `resolveStaticPaints()`
 *  (or `resolveStaticPaintsForPreview` in the preview) after style.load to
 *  seed real values; the per-frame builder overrides circle-radius
 *  thereafter. Source: `waypoints`. */
export const WAYPOINTS_CIRCLE_LAYER: LayerSpecification = {
  id: 'waypoints-circle',
  type: 'circle',
  source: 'waypoints',
  paint: {
    'circle-radius': 1,
    'circle-color': colors.accent,
    'circle-stroke-width': 1,
    'circle-stroke-color': 'rgba(255,255,255,0.85)',
  },
};

/** Numeric label centered on each waypoint circle. `index + 1` so the user
 *  sees 1-based clip ordinals. Source: `waypoints` (same source as the
 *  circle layer).
 *
 *  `text-size` is a PLACEHOLDER — see resolveStaticPaints. */
export const WAYPOINTS_LABEL_LAYER: LayerSpecification = {
  id: 'waypoints-label',
  type: 'symbol',
  source: 'waypoints',
  layout: {
    'text-field': ['to-string', ['+', ['get', 'index'], 1]],
    'text-font': ['Noto Sans Bold'],
    'text-size': 1,
    'text-allow-overlap': true,
    'text-ignore-placement': true,
  },
  paint: {
    'text-color': '#fff',
  },
};

/** Live-marker outer pulse ring. Per-frame `circle-radius` and
 *  `circle-opacity` are driven by `pulseAt(projectTimeMs)` via
 *  `buildPerFramePaints`. Initial radius is a PLACEHOLDER (1) — the
 *  consumer applies `resolveStaticPaints` to seed it, and the per-frame
 *  builder overrides thereafter. Source: `live-marker`. */
export const LIVE_MARKER_PULSE_LAYER: LayerSpecification = {
  id: 'live-marker-pulse',
  type: 'circle',
  source: 'live-marker',
  paint: {
    'circle-color': colors.accent,
    'circle-radius': 1,
    'circle-opacity': 0.55,
    'circle-stroke-width': 0,
  },
};

/** Live-marker inner solid dot. Static paint — replaces the pre-refactor
 *  DOM marker (white fill, accent stroke). Source: `live-marker`.
 *
 *  `circle-radius` and `circle-stroke-width` are PLACEHOLDERS — see
 *  resolveStaticPaints. */
export const LIVE_MARKER_DOT_LAYER: LayerSpecification = {
  id: 'live-marker-dot',
  type: 'circle',
  source: 'live-marker',
  paint: {
    'circle-radius': 1,
    'circle-color': '#ffffff',
    'circle-stroke-width': 1,
    'circle-stroke-color': colors.accent,
  },
};

/** Build the StyleSpecification (or URL) for the chosen `map_style`. Returns
 *  the style and the pitch the consumer should apply.
 *
 *  - `'default'` → `DEFAULT_STYLE_URL`, pitch 0.
 *  - `'3d'` → `DEFAULT_STYLE_URL`, pitch 60. Consumer additionally adds the
 *    `BUILDINGS_LAYER_SPEC` layer at style.load.
 *  - `'satellite'` → `SATELLITE_STYLE` inline spec, pitch 0.
 *
 *  Per the architect's decision, `defaultPitch` rides on this return value
 *  rather than getting its own helper — pitch is part of the mode's visual
 *  identity even though it isn't a style-spec property. */
export function buildStyleSpec(mapSettings: MapSettings): StyleSpecResult {
  const id = mapSettings.map_style;
  if (id === 'satellite') {
    return { style: SATELLITE_STYLE, defaultPitch: 0 };
  }
  return {
    style: DEFAULT_STYLE_URL,
    defaultPitch: id === '3d' ? 60 : 0,
  };
}

/** Resolved-static-paints descriptor. Pure: each value is
 *  `mapSettings.overlay_<name> × PAINT_REFERENCE_WIDTH`. Both renderer and
 *  preview consume this same result; there is no pane-reshape variant.
 *
 *  This is the "static defaults" surface — the values the consumer should
 *  push to MapLibre via `setPaintProperty` / `setLayoutProperty` after the
 *  style loads. The per-frame builder (`buildPerFramePaints`) separately
 *  overrides the `waypoints-circle` `circle-radius` per frame, and the
 *  `live-marker-pulse` `circle-radius`; this helper covers the layers
 *  whose size-based paints aren't otherwise touched per-frame
 *  (`route-full-line`, `route-trail-line`, `live-marker-dot`, the
 *  `circle-stroke-width` on `waypoints-circle`, and the `text-size` layout
 *  on `waypoints-label`). */
export interface ResolvedStaticPaints {
  /** [layerId, propertyName, value] — for `setPaintProperty`. */
  paints: Array<[string, string, number]>;
  /** [layerId, propertyName, value] — for `setLayoutProperty`. text-size is
   *  a layout property, not a paint property, so it ships in its own bucket
   *  to keep the consumer's apply loop straight-forward. */
  layouts: Array<[string, string, number]>;
}

/** Build the static-paint descriptor for a given `MapSettings`. Pure
 *  function; both the renderer worker and the preview `MapView` call this
 *  after style.load (and again whenever any overlay field — project default
 *  or per-clip override — changes). The layer specs ship placeholder `1`s,
 *  so this seeding step is mandatory for visible output. */
export function resolveStaticPaints(
  mapSettings: MapSettings,
): ResolvedStaticPaints {
  const w = PAINT_REFERENCE_WIDTH;
  return {
    paints: [
      ['route-full-line', 'line-width', mapSettings.overlay_route_full_width * w],
      ['route-trail-line', 'line-width', mapSettings.overlay_route_trail_width * w],
      // waypoints-circle: circle-radius and circle-stroke-width. The radius
      // is also overridden per-frame by `buildPerFramePaints` (data-driven
      // case expression) — that per-frame write is the one that wins, but
      // we still seed the static default here so pre-first-frame state is
      // correct. circle-stroke-width is only ever set here.
      ['waypoints-circle', 'circle-radius', mapSettings.overlay_waypoint_circle_radius * w],
      [
        'waypoints-circle',
        'circle-stroke-width',
        mapSettings.overlay_waypoint_stroke_width * w,
      ],
      [
        'live-marker-dot',
        'circle-radius',
        mapSettings.overlay_live_marker_dot_radius * w,
      ],
      [
        'live-marker-dot',
        'circle-stroke-width',
        mapSettings.overlay_live_marker_dot_stroke_width * w,
      ],
      // live-marker-pulse: initial radius. Per-frame builder overrides this
      // every frame via `pulseAt`, but seeding it gives a sensible value
      // before the first frame is applied.
      [
        'live-marker-pulse',
        'circle-radius',
        mapSettings.overlay_live_marker_pulse_radius * w,
      ],
    ],
    layouts: [
      ['waypoints-label', 'text-size', mapSettings.overlay_waypoint_label_size * w],
    ],
  };
}
