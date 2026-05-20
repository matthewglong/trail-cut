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
  ExpressionSpecification,
} from 'maplibre-gl';
import type { DecorationColor, GradientStop, MapSettings } from '../../types';
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
 *  `mapSettings.route.size.width × PAINT_REFERENCE_WIDTH`. Both
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

/** Active-waypoint halo. Semi-transparent ring painting behind the active
 *  waypoint's dot/symbol — the "you are here" indicator that generalizes
 *  across circle and (Step 8) symbol shapes. All paint values are data-
 *  driven per-feature by `buildPerFramePaints`: opacity ~0.5 on active and
 *  0 elsewhere; radius = `active_radius × PAINT_REFERENCE_WIDTH` on active,
 *  0 elsewhere; color tracks `mapSettings.waypoints.active_color` when set,
 *  otherwise mirrors the dot's resolved color ([DECIDED] Q1). Added BELOW
 *  `waypoints-circle` in the layer stack so the inner shape paints over
 *  it. Source: `waypoints`. */
export const WAYPOINTS_ACTIVE_HALO_LAYER: LayerSpecification = {
  id: 'waypoints-active-halo',
  type: 'circle',
  source: 'waypoints',
  paint: {
    'circle-radius': 1,
    'circle-color': colors.accent,
    'circle-opacity': 0,
    'circle-stroke-width': 0,
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

/** Waypoint symbol layer. Renders the non-circle shape variants (pin,
 *  square, diamond) as SDF icons; transparent for circle-family shapes
 *  (circle, ring, numbered-circle) where `waypoints-circle` does the work.
 *
 *  Both `waypoints-circle` and `waypoints-symbol` stay layout-visible at
 *  all times. Per-feature opacity expressions emitted by
 *  `resolveStaticPaints` route each waypoint to exactly one of the two
 *  layers based on its effective shape (`wp.shape ?? mapSettings.waypoints.shape`),
 *  so the mixed-shape case — one diamond among four circles — renders
 *  correctly without per-layer juggling.
 *
 *  SDF icons are registered via `map.addImage('waypoint-<shape>', { width,
 *  height, data }, { sdf: true })` after style.load on both sides:
 *   - preview: `MapView.tsx` `onStyleLoad` loops over `WAYPOINT_SHAPE_NAMES`
 *     and calls `buildWaypointSdfIcon` (re-registers on every style.load,
 *     surviving `setStyle()` swaps).
 *   - export: `renderer/index.ts` builds the same set in `applySetup` and
 *     ships them on the `staticImages` field; `renderer/page/init.ts` __init
 *     loops over them after the static layers are added.
 *
 *  SDF is required for `icon-color` to act as a per-feature data-driven
 *  tint — non-SDF icons would lock every symbol to a single uniform color.
 *
 *  `icon-image` is a PLACEHOLDER (`'waypoint-circle'`) at boot — the real
 *  expression is a `concat` of `'waypoint-' + (override_shape ?? projectShape)`
 *  emitted by `resolveStaticPaints` so it tracks `mapSettings.waypoints.shape`.
 *  Both `icon-color` and `icon-opacity` are PLACEHOLDERS overridden on the
 *  first frame: `icon-color` by `buildPerFramePaints` (per-feature override
 *  > base color, identical logic to `waypoints-circle.circle-color`),
 *  `icon-opacity` by `resolveStaticPaints` (per-feature routing between the
 *  circle and symbol layers). Source: `waypoints` (same source as the
 *  circle layer). */
export const WAYPOINTS_SYMBOL_LAYER: LayerSpecification = {
  id: 'waypoints-symbol',
  type: 'symbol',
  source: 'waypoints',
  layout: {
    'icon-image': 'waypoint-circle',
    'icon-size': 1,
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
    'icon-anchor': 'center',
  },
  paint: {
    'icon-color': colors.accent,
    'icon-opacity': 0,
  },
};

/** Label centered on each waypoint circle. `text-field` and `text-size` are
 *  both PLACEHOLDERS — `resolveStaticPaints` overrides them. `text-field`
 *  deliberately ships as an empty string so a missed seed fails loudly
 *  (blank labels) rather than silently rendering one of the real modes; the
 *  prior numbered-by-default expression masked the export's missing
 *  `label_mode` plumbing as "labeled mode falls back to numbered." Source:
 *  `waypoints` (same source as the circle layer). */
export const WAYPOINTS_LABEL_LAYER: LayerSpecification = {
  id: 'waypoints-label',
  type: 'symbol',
  source: 'waypoints',
  layout: {
    'text-field': '',
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

/** Live-marker outer pulse ring (secondary, ring B). Always seeded in the
 *  layer stack so a mid-session swap into `pulse_style === 'heartbeat'`
 *  doesn't have to add a layer. Visibility-via-opacity (held at 0 by
 *  `buildPerFramePaints` in every non-heartbeat style) keeps the layer
 *  invisible the rest of the time. Per-frame `circle-radius` and
 *  `circle-opacity` are driven by `pulsePairAt(projectTimeMs).b`. Color
 *  mirrors the primary ring via `resolveStaticPaints`. Source:
 *  `live-marker`. */
export const LIVE_MARKER_PULSE_B_LAYER: LayerSpecification = {
  id: 'live-marker-pulse-b',
  type: 'circle',
  source: 'live-marker',
  paint: {
    'circle-color': colors.accent,
    'circle-radius': 1,
    'circle-opacity': 0,
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
  const id = mapSettings.camera.map_style;
  if (id === 'satellite') {
    return { style: SATELLITE_STYLE, defaultPitch: 0 };
  }
  return {
    style: DEFAULT_STYLE_URL,
    defaultPitch: id === '3d' ? 60 : 0,
  };
}

/** Resolved-static-paints descriptor. Pure function of `MapSettings`. Both
 *  renderer and preview consume this same result and apply it identically;
 *  there is no pane-reshape variant.
 *
 *  This is the "anything derivable from `MapSettings`" surface — every
 *  property MapLibre needs that depends on a user-editable setting. The
 *  consumer's apply loop is the only correct place to set these on the map;
 *  no other code in either pipeline should be touching `setPaintProperty`
 *  / `setLayoutProperty` for properties that derive from `MapSettings`,
 *  because doing so creates a preview-only or export-only branch that the
 *  other side can't see.
 *
 *  Today's tuples:
 *   - `paints`: size-based numeric properties (line-widths, stroke widths,
 *     circle radii, etc.) plus solid color strings (route `line-color`, POV
 *     `circle-color` / `circle-stroke-color`). Per-frame writes from
 *     `buildPerFramePaints` separately override `waypoints-circle.circle-radius`
 *     / `.circle-color` / `.circle-stroke-color` and the pulse radius/opacity.
 *   - `layouts`: every `setLayoutProperty`-able value, including
 *     `visibility` (mode strings), `text-size` (numbers), and `text-field`
 *     (expressions). Values are heterogeneous because MapLibre's layout
 *     surface itself is heterogeneous; the consumer just iterates and
 *     forwards each tuple to `setLayoutProperty`.
 *   - `gradients`: the `line-gradient` paint property is split into its own
 *     bucket because MapLibre treats it as mutually exclusive with
 *     `line-color`. Each tuple is `[layerId, expressionOrNull]` — the value
 *     is either a `line-progress`-anchored `interpolate` expression (gradient
 *     mode) or `null` (solid mode, which clears any stale `line-gradient`
 *     from a previous resolve). `line-color` is emitted unconditionally in
 *     `paints` because MapLibre lets `line-gradient` win when both are set;
 *     keeping `line-color` always-applied means the renderer doesn't have to
 *     special-case the mode swap. */
export interface ResolvedStaticPaints {
  /** [layerId, propertyName, value] — for `setPaintProperty`. Values are
   *  heterogeneous: numeric (size-based properties) and string (color
   *  properties like `line-color`, `circle-color`, `circle-stroke-color`).
   *  Loosened from `number` for v8 — route and POV solid-color plumbing
   *  carries hex strings through this bucket. */
  paints: Array<[string, string, unknown]>;
  /** [layerId, propertyName, value] — for `setLayoutProperty`. Values are
   *  heterogeneous: numeric (text-size), string (visibility), or an
   *  ExpressionSpecification (text-field). The consumer's apply loop forwards
   *  each tuple verbatim; MapLibre validates the value against the property. */
  layouts: Array<[string, string, number | string | ExpressionSpecification]>;
  /** [layerId, expressionOrNull] — for `setPaintProperty(layerId, 'line-gradient', value)`.
   *  Gradient mode emits an `interpolate` expression on `line-progress`;
   *  solid mode emits `null` so MapLibre clears any stale gradient from a
   *  previous resolve. The `line-gradient` property is split out from
   *  `paints` because it requires `lineMetrics: true` on the source
   *  (set at `addSource` time on both `route-full` and `route-trail` — see
   *  the addSource sites in `MapView.tsx` and `renderer/index.ts`) and is
   *  semantically tied to a different render path than the homogeneous
   *  size/color writes that live in `paints`. */
  gradients: Array<[string, ExpressionSpecification | null]>;
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
  // Waypoint label expression. 'numbered' renders the 1-based index;
  // 'labeled' renders the feature's `label` string verbatim (empty labels
  // render nothing — the "sparse map" semantic). Both sides resolve through
  // this single tuple so a future mode lands automatically in preview AND
  // export.
  const labelExpr: ExpressionSpecification =
    mapSettings.waypoints.label_mode === 'labeled'
      ? ['to-string', ['get', 'label']]
      : ['to-string', ['+', ['get', 'index'], 1]];
  // Route + POV solid colors flow through `paints` as plain hex strings.
  // In gradient mode the `line-color` value below is harmless because the
  // `gradients` bucket also emits a `line-gradient` expression for the same
  // layer, and MapLibre prefers `line-gradient` when both are set on a line
  // layer. Solid mode emits `[layer, null]` in the gradients bucket so any
  // stale `line-gradient` from a previous resolve is cleared. Waypoint
  // color flows per-feature via `buildPerFramePaints` (it needs the
  // `override_color` arm); not emitted here.
  const routeSolid = solidColorOf(mapSettings.route.color);
  const routeGradientExpr =
    mapSettings.route.color.mode === 'gradient'
      ? buildLineGradientExpression(mapSettings.route.color.stops)
      : null;
  // Waypoint per-feature opacity routing (Step 8 backend). The circle layer
  // and the symbol layer are both layout-visible at all times; per-feature
  // opacity decides which one paints for each waypoint based on its effective
  // shape — `override_shape` baked into the feature by `buildWaypointsCollection`,
  // falling back to the project-level `mapSettings.waypoints.shape`.
  //
  // Circle-family shapes (`circle`, `ring`, `numbered-circle`) → circle layer
  // paints (opacity 1), symbol layer transparent (opacity 0). Symbol-family
  // shapes (`pin`, `square`, `diamond`) → inverted.
  //
  // The expression is MapSettings-derived (the `coalesce` fallback reads
  // `mapSettings.waypoints.shape`), so it MUST come from this resolver —
  // putting it on the static layer spec would freeze the fallback at module-
  // load. Emitting it here means a project-default-shape edit re-resolves
  // and re-applies via the same channel that already carries paint sizes,
  // identically in preview and export.
  const projectShape = mapSettings.waypoints.shape;
  const isCircleFamilyExpr: ExpressionSpecification = [
    'in',
    ['coalesce', ['get', 'override_shape'], projectShape],
    ['literal', ['circle', 'ring', 'numbered-circle']],
  ];
  const circleOpacityExpr: ExpressionSpecification = [
    'case',
    isCircleFamilyExpr,
    1,
    0,
  ];
  const iconOpacityExpr: ExpressionSpecification = [
    'case',
    isCircleFamilyExpr,
    0,
    1,
  ];
  // Symbol-layer `icon-image`. Per-feature `'waypoint-' + effective_shape`,
  // where the effective shape is `override_shape ?? mapSettings.waypoints.shape`.
  // The fallback MUST be the project-level shape (MapSettings-derived), not a
  // hardcoded literal — otherwise a project default of e.g. 'diamond' silently
  // renders every un-overridden waypoint as a circle icon. Emitted through
  // `layouts` because `icon-image` is a layout property (set via
  // `setLayoutProperty`), and routed alongside `icon-opacity` so a single
  // re-resolve flips both the visible layer AND the rendered symbol shape.
  const iconImageExpr: ExpressionSpecification = [
    'concat',
    'waypoint-',
    ['coalesce', ['get', 'override_shape'], projectShape],
  ];
  return {
    paints: [
      ['route-full-line', 'line-color', routeSolid],
      ['route-trail-line', 'line-color', routeSolid],
      ['live-marker-pulse', 'circle-color', mapSettings.pov.color],
      ['live-marker-pulse-b', 'circle-color', mapSettings.pov.color],
      ['live-marker-dot', 'circle-stroke-color', mapSettings.pov.color],
      ['route-full-line', 'line-width', mapSettings.route.size.width * w],
      ['route-trail-line', 'line-width', mapSettings.route.size.width * w],
      // waypoints-circle: circle-radius and circle-stroke-width. The radius
      // is also overridden per-frame by `buildPerFramePaints` (data-driven
      // case expression) — that per-frame write is the one that wins, but
      // we still seed the static default here so pre-first-frame state is
      // correct. circle-stroke-width is only ever set here.
      ['waypoints-circle', 'circle-radius', mapSettings.waypoints.size.circle_radius * w],
      [
        'waypoints-circle',
        'circle-stroke-width',
        mapSettings.waypoints.size.stroke_width * w,
      ],
      [
        'live-marker-dot',
        'circle-radius',
        mapSettings.pov.size.dot_radius * w,
      ],
      [
        'live-marker-dot',
        'circle-stroke-width',
        mapSettings.pov.size.dot_stroke_width * w,
      ],
      // live-marker-pulse: initial radius. Per-frame builder overrides this
      // every frame via `pulseAt`, but seeding it gives a sensible value
      // before the first frame is applied.
      [
        'live-marker-pulse',
        'circle-radius',
        mapSettings.pov.size.pulse_radius * w,
      ],
      [
        'live-marker-pulse-b',
        'circle-radius',
        mapSettings.pov.size.pulse_radius * w,
      ],
      // Per-feature opacity routing for waypoint shape variants. Both the
      // circle layer and the symbol layer paint every feature; this pair of
      // case expressions makes exactly one of them visible for each waypoint.
      // Re-resolved on every `mapSettings.waypoints.shape` change so a
      // project-default-shape edit immediately flips the visible layer for
      // features without per-Waypoint `shape` overrides.
      ['waypoints-circle', 'circle-opacity', circleOpacityExpr],
      ['waypoints-symbol', 'icon-opacity', iconOpacityExpr],
    ],
    layouts: [
      ['waypoints-label', 'text-size', mapSettings.waypoints.size.label_size * w],
      ['waypoints-label', 'text-field', labelExpr],
      // Route visibility flows through layouts so per-clip `map_overrides`
      // of `route.mode` switch automatically at the cut (the renderer
      // re-resolves per-frame). Maplibre no-ops same-value writes, so the
      // steady-state cost is one map lookup per frame per tuple.
      ['route-full-line', 'visibility', mapSettings.route.mode === 'full' ? 'visible' : 'none'],
      ['route-trail-line', 'visibility', mapSettings.route.mode === 'visited' ? 'visible' : 'none'],
      // Symbol-layer icon-image. MapSettings-derived (fallback reads
      // `mapSettings.waypoints.shape`) so a project-default shape edit
      // re-resolves and immediately changes the rendered symbol for every
      // waypoint without a per-Waypoint `shape` override.
      ['waypoints-symbol', 'icon-image', iconImageExpr],
    ],
    // Route line-gradient. Gradient mode emits an `interpolate` expression
    // on `line-progress`; solid mode emits `null` so the consumer clears
    // any stale gradient via `setPaintProperty(layer, 'line-gradient', null)`.
    // Both the full route and the slime trail get the same expression — for
    // the trail this colors the entire trail with a normalized 0→1
    // gradient over its current extent (`rendering.md` §2 calls this out as
    // visually approximate at the head; a "clamped to current progress"
    // refinement is deferred).
    gradients: [
      ['route-full-line', routeGradientExpr],
      ['route-trail-line', routeGradientExpr],
    ],
  };
}

/** Resolve a `DecorationColor` to a single solid hex. Solid mode returns its
 *  literal; gradient mode returns the first stop's color as a sensible
 *  fallback for any consumer that ignores the `gradients` bucket (e.g. the
 *  `line-color` paint emitted alongside the `line-gradient` expression —
 *  MapLibre prefers the gradient when both are set, but the layer needs a
 *  syntactically valid `line-color` either way). Empty stops collapse to
 *  chartreuse so the layer keeps painting validly rather than going
 *  transparent. */
function solidColorOf(color: DecorationColor): string {
  if (color.mode === 'solid') return color.solid;
  return color.stops[0]?.color ?? colors.accent;
}

/** Build a `line-gradient` interpolate expression from a `GradientStop[]`.
 *  Output shape:
 *  `['interpolate', ['linear'], ['line-progress'], s0.fraction, s0.color, ..., sN.fraction, sN.color]`.
 *
 *  Defensive on degenerate input: empty stops collapse to a single-color
 *  constant (chartreuse — matches `solidColorOf`); a single stop also
 *  collapses to a single-color constant so the expression has at least the
 *  one stop MapLibre's `interpolate` requires.
 *
 *  Callers must ensure the underlying source has `lineMetrics: true` at
 *  `addSource` time — the property can't be added after the fact. See the
 *  addSource sites in `MapView.tsx` (preview) and
 *  `src-tauri/sidecars/renderer/index.ts` (export). */
export function buildLineGradientExpression(
  stops: GradientStop[],
): ExpressionSpecification {
  // Defensive: with zero stops there's nothing to interpolate against;
  // emit a `to-color` over the fallback hex so the return type is a valid
  // ExpressionSpecification, not a bare string.
  if (stops.length === 0) {
    return ['to-color', colors.accent];
  }
  // A single stop is similarly degenerate — `interpolate` requires at least
  // one stop but with one stop the result is constant anyway, so we skip
  // the interpolation overhead and emit a bare color expression.
  if (stops.length === 1) {
    return ['to-color', stops[0].color];
  }
  const args: Array<number | string> = [];
  for (const stop of stops) {
    args.push(stop.fraction, stop.color);
  }
  return [
    'interpolate',
    ['linear'],
    ['line-progress'],
    ...args,
  ] as ExpressionSpecification;
}
