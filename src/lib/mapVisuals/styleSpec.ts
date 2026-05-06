// Style + layer specs for the map. The single source of truth for what the
// map looks like at setup time. The 3D-buildings layer, the route lines, the
// waypoints, and the live-marker circle pair all live here as exported
// LayerSpecifications — the consumer (preview MapView and the export worker)
// adds them via `map.addLayer` at style.load. Embedding them in the returned
// StyleSpecification doesn't work for URL-based styles (default/3d use the
// remote OpenFreeMap liberty style), so the consistent pattern is "consumer
// owns addLayer; this module owns the spec."
//
// Visual parity with pre-refactor MapView is the gate — paint/layout values
// are copied verbatim from MapView.tsx.

import type {
  StyleSpecification,
  LayerSpecification,
} from 'maplibre-gl';
import type { MapSettings } from '../../types';
import { colors } from '../../theme/tokens';
import type { StyleSpecResult } from './types';

const TRAIL_COLOR = colors.accent;
const FULL_ROUTE_COLOR = colors.accent;

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
 *  `mapSettings.route_mode === 'full'`. Source: `route-full`. */
export const ROUTE_FULL_LAYER: LayerSpecification = {
  id: 'route-full-line',
  type: 'line',
  source: 'route-full',
  layout: { 'line-join': 'round', 'line-cap': 'round' },
  paint: {
    'line-color': FULL_ROUTE_COLOR,
    'line-width': 3,
    'line-opacity': 0.8,
  },
};

/** Slime-trail line. Visibility toggled by the consumer based on
 *  `mapSettings.route_mode === 'visited'`. Source: `route-trail`. */
export const ROUTE_TRAIL_LAYER: LayerSpecification = {
  id: 'route-trail-line',
  type: 'line',
  source: 'route-trail',
  layout: { 'line-join': 'round', 'line-cap': 'round' },
  paint: {
    'line-color': TRAIL_COLOR,
    'line-width': 4,
    'line-opacity': 0.95,
  },
};

/** Waypoint circle layer. Paint is overridden per-frame via
 *  `setPaintProperty` from `buildPerFramePaints` to express the active-clip
 *  highlight as a data-driven `case` expression. The literal defaults below
 *  are the inactive-everywhere baseline that's applied before any active id
 *  exists. Source: `waypoints`. */
export const WAYPOINTS_CIRCLE_LAYER: LayerSpecification = {
  id: 'waypoints-circle',
  type: 'circle',
  source: 'waypoints',
  paint: {
    'circle-radius': 11,
    'circle-color': colors.accent,
    'circle-stroke-width': 2,
    'circle-stroke-color': 'rgba(255,255,255,0.85)',
  },
};

/** Numeric label centered on each waypoint circle. `index + 1` so the user
 *  sees 1-based clip ordinals. Source: `waypoints` (same source as the
 *  circle layer). */
export const WAYPOINTS_LABEL_LAYER: LayerSpecification = {
  id: 'waypoints-label',
  type: 'symbol',
  source: 'waypoints',
  layout: {
    'text-field': ['to-string', ['+', ['get', 'index'], 1]],
    'text-font': ['Noto Sans Bold'],
    'text-size': 11,
    'text-allow-overlap': true,
    'text-ignore-placement': true,
  },
  paint: {
    'text-color': '#fff',
  },
};

/** Live-marker outer pulse ring. Per-frame `circle-radius` and
 *  `circle-opacity` are driven by `pulseAt(projectTimeMs)` via
 *  `buildPerFramePaints`. Initial values match the start of the cycle.
 *  Source: `live-marker`. */
export const LIVE_MARKER_PULSE_LAYER: LayerSpecification = {
  id: 'live-marker-pulse',
  type: 'circle',
  source: 'live-marker',
  paint: {
    'circle-color': colors.accent,
    'circle-radius': 8,
    'circle-opacity': 0.55,
    'circle-stroke-width': 0,
  },
};

/** Live-marker inner solid dot. Static paint — replaces the pre-refactor
 *  DOM marker (white fill, accent stroke at 3px). Source: `live-marker`. */
export const LIVE_MARKER_DOT_LAYER: LayerSpecification = {
  id: 'live-marker-dot',
  type: 'circle',
  source: 'live-marker',
  paint: {
    'circle-radius': 9,
    'circle-color': '#ffffff',
    'circle-stroke-width': 3,
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
