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
import { SHAPE_CANONICAL_RADIUS } from './shapes';
import type { StyleSpecResult } from './types';

// `SHAPE_CANONICAL_RADIUS` lives in `shapes.ts` as a property of the SDF
// canvas geometry (every primary rasterizer draws into an envelope sized off
// it). Re-exported here because `paints.ts` and a fair number of tests already
// import it from this module — keeps callers stable while the definition
// stays next to the rasterizers that own it. `icon-size = (target_radius /
// SHAPE_CANONICAL_RADIUS)` is the bridge between the user-facing
// `waypoints.size.circle_radius × PAINT_REFERENCE_WIDTH` value (CSS px) and
// MapLibre's `icon-size` multiplier.
export { SHAPE_CANONICAL_RADIUS };

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
 *  added on top (today: the label text-field on `waypoints-secondary`) can
 *  resolve a font stack. */
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
 *  waypoint's shape — the "you are here" indicator that generalizes across
 *  every shape variant. All paint values are data-driven per-feature by
 *  `buildPerFramePaints`: opacity ~0.5 on active and 0 elsewhere; radius =
 *  `active_radius × PAINT_REFERENCE_WIDTH` on active, 0 elsewhere; color
 *  tracks `mapSettings.waypoints.active_color` when set, otherwise mirrors
 *  the primary slot's resolved color. Added BELOW the two symbol layers in
 *  the stack so the shape paints over it. Source: `waypoints`. */
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

/** Waypoint PRIMARY symbol layer. Paints each waypoint's filled silhouette
 *  using the `waypoint-<shape>-primary` SDF icon registered by
 *  `buildAllShapeIcons` in `shapes.ts`. Tinted per-feature via the
 *  `icon-color` expression emitted by `buildPerFramePaints` (primary base
 *  color, optionally overridden by `override_color` on the feature and
 *  swapped to `active_color` while active).
 *
 *  Every literal in `layout` / `paint` is a PLACEHOLDER — `resolveStaticPaints`
 *  seeds the real `icon-image` expression, `icon-size`, and per-frame
 *  `buildPerFramePaints` writes the real `icon-color`. Both must run after
 *  style.load before the first frame paints. Source: `waypoints`. */
export const WAYPOINTS_PRIMARY_LAYER: LayerSpecification = {
  id: 'waypoints-primary',
  type: 'symbol',
  source: 'waypoints',
  layout: {
    'icon-image': 'waypoint-circle-primary',
    'icon-size': 1,
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
    'icon-anchor': 'center',
    // `symbol-z-order: 'source'` makes MapLibre honor `symbol-sort-key`
    // for draw order rather than the viewport-y default. Combined with
    // `icon-allow-overlap: true`, higher sort-key features paint later
    // (on top). `buildPerFramePaints` writes the per-feature sort-key
    // expression every frame so the active waypoint and its near
    // neighbors stack toward the playhead. Seeded at 0 so the first paint
    // before the per-frame builder runs is deterministic.
    'symbol-z-order': 'source',
    'symbol-sort-key': 0,
  },
  paint: {
    'icon-color': colors.accent,
  },
};

/** Waypoint SECONDARY symbol layer. Stacked above `waypoints-primary` so its
 *  outline / accent element paints on top of the filled silhouette. Also
 *  carries the per-waypoint label `text-field` — keeping the outline icon
 *  and the label in the SAME symbol layer is what lets MapLibre treat them
 *  as a single placement unit, so they don't collide with each other and the
 *  label can't cull the outline of its own waypoint. The prior split had
 *  the label in a dedicated `waypoints-label` layer; that broke in `labeled`
 *  mode because the wider text bounding box would block the (separate)
 *  outline feature at the same coordinates, leaving the outline invisible.
 *
 *  Uses the `waypoint-<shape>-secondary` SDF icon — for shapes with a
 *  declared secondary rasterizer this is the outline; for one-color shapes
 *  (today: `ring`) it's a transparent placeholder so the layer stays valid
 *  and paint expressions stay uniform. Tinted by `mapSettings.waypoints.secondary_color`
 *  via `buildPerFramePaints` (per-feature `override_secondary_color` wins,
 *  active state may swap to `active_secondary_color`).
 *
 *  SDF icons are registered identically on both sides — see `shapes.ts` →
 *  `buildAllShapeIcons` for the canonical iteration. Source: `waypoints`. */
export const WAYPOINTS_SECONDARY_LAYER: LayerSpecification = {
  id: 'waypoints-secondary',
  type: 'symbol',
  source: 'waypoints',
  layout: {
    'icon-image': 'waypoint-circle-secondary',
    'icon-size': 1,
    // Outline icons opt OUT of collision: `icon-allow-overlap: true` +
    // `icon-ignore-placement: true` means every waypoint's outline is
    // drawn, even where it overlaps another waypoint. Combined with this
    // layer rendering on top of `waypoints-primary`, the back waypoint's
    // outline paints over the front waypoint's fill in the overlap region
    // — so neighbors in a cluster read as distinct shapes instead of
    // melting into a single blob of fill color.
    //
    // Labels keep collision via `text-allow-overlap: false` /
    // `text-ignore-placement: false`: within a cluster a single label
    // wins (selected by the per-frame `waypointPlacementKey` sort-key)
    // and the others are culled. The icon and text are still in the same
    // symbol layer so they remain co-placed; an icon-only / label-only
    // split would risk the label colliding with its OWN outline at the
    // same coordinate.
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
    'icon-anchor': 'center',
    'text-field': '',
    'text-font': ['Noto Sans Bold'],
    'text-size': 1,
    'text-allow-overlap': false,
    'text-ignore-placement': false,
    'text-anchor': 'center',
    'symbol-z-order': 'source',
    'symbol-sort-key': 0,
  },
  paint: {
    'icon-color': '#ffffff',
    'text-color': '#ffffff',
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
 *     `circle-color` / `circle-stroke-color`, the live-marker dot's
 *     `circle-color` driven by `pov.secondary_color`). Per-frame writes from
 *     `buildPerFramePaints` separately override the waypoint primary +
 *     secondary `icon-color` expressions and the pulse radius/opacity.
 *   - `layouts`: every `setLayoutProperty`-able value, including
 *     `visibility` (mode strings), `text-size` / `icon-size` (numbers),
 *     and `text-field` / `icon-image` (expressions). Values are
 *     heterogeneous because MapLibre's layout surface itself is
 *     heterogeneous; the consumer just iterates and forwards each tuple
 *     to `setLayoutProperty`. Per-frame writes from `buildPerFramePaints`
 *     additionally override the waypoint `icon-size` on both slots with
 *     the active-state case expression.
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
 *  so this seeding step is mandatory for visible output.
 *
 *  `surfaceScale` is the consuming surface's CSS-px-per-reference-unit
 *  factor. The export renderer's cssViewport IS the reference space, so it
 *  omits the argument (scale 1 — every emitted size is then exactly
 *  `fraction × PAINT_REFERENCE_WIDTH`, byte-identical to the pre-scale
 *  behavior). The preview pane displays the reference space at
 *  `previewDisplayScale` (see `lib/layout.ts`) and passes that factor here
 *  so decoration sizes minify with the world; pairing it with the
 *  `withDisplayScale` zoom offset keeps every decoration's GROUND footprint
 *  identical between pane and export. Scaling through this resolver — never
 *  ad-hoc in MapView — is what keeps the single-source-of-truth contract:
 *  both surfaces still apply exactly what this function returns. */
export function resolveStaticPaints(
  mapSettings: MapSettings,
  surfaceScale: number = 1,
): ResolvedStaticPaints {
  // Every size-like value below is linear in `w`, so the surface factor
  // rides the anchor: one lever, no per-tuple special cases. Colors,
  // visibility, and expressions are scale-free by construction.
  const w = PAINT_REFERENCE_WIDTH * surfaceScale;
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
  // Effective-shape expression. Reads the per-feature `override_shape` baked
  // in by `buildWaypointsCollection`, falling back to the project default
  // (`mapSettings.waypoints.shape`). Wrapped in a defensive `match` that
  // collapses any value outside the known catalog (e.g. a legacy
  // `'numbered-circle'` persisted before the shape-descriptor refactor) to
  // `'circle'` — without this, the `concat` below would build the string
  // `waypoint-numbered-circle-primary`, which `buildAllShapeIcons` does not
  // register, and MapLibre would render a missing-image placeholder.
  //
  // The fallback MUST come from this resolver (MapSettings-derived), not the
  // static layer spec — putting it on the layer would freeze the project
  // default at module-load. Emitting it here means a project-default-shape
  // edit re-resolves and applies through the same channel that already
  // carries paint sizes, in both preview and export.
  const projectShape = mapSettings.waypoints.shape;
  const safeShape: ExpressionSpecification = [
    'match',
    ['coalesce', ['get', 'override_shape'], projectShape],
    'circle', 'circle',
    'ring', 'ring',
    'pin', 'pin',
    'square', 'square',
    'diamond', 'diamond',
    /* default for legacy / unknown names */ 'circle',
  ];
  // Per-feature `icon-image` expression for each slot. Resolves to
  // `waypoint-<effective_shape>-primary` (or `-secondary`) — the same id
  // `buildAllShapeIcons` registers on both sides, so the resolved string
  // always names an existing icon in the atlas.
  const primaryIconImageExpr: ExpressionSpecification = [
    'concat',
    'waypoint-',
    safeShape,
    '-primary',
  ];
  const secondaryIconImageExpr: ExpressionSpecification = [
    'concat',
    'waypoint-',
    safeShape,
    '-secondary',
  ];
  // Per-shape `icon-anchor`. Most shapes paint centered on the GPS
  // coordinate (`icon-anchor: 'center'`), but the pin's tip — not its
  // centroid — is the semantically-meaningful anchor point. The pin's
  // SDF places the tip at the bottom-center of the canvas (see
  // `shapes.ts` → `PIN_TIP_Y_RATIO`), so `icon-anchor: 'bottom'` lands
  // the tip on the geographic point. Driving this per-shape is what
  // lets the pin's head fill the canvas (sized to match the other
  // shapes' SHAPE_CANONICAL_RADIUS) instead of being squeezed into the
  // top half — and it's that head-size parity that keeps the user's
  // `stroke_width` setting from producing a comically thick outline on
  // the pin.
  const iconAnchorExpr: ExpressionSpecification = [
    'match',
    safeShape,
    'pin', 'bottom',
    /* default */ 'center',
  ];
  // Static seed for `icon-size` on both waypoint symbol layers. The renderer
  // anchors paint sizing to `PAINT_REFERENCE_WIDTH` × the relevant
  // `waypoints.size.*` fraction; for SDF symbols the equivalent is
  // `targetRadius / SHAPE_CANONICAL_RADIUS` — the canonical primary shapes
  // are drawn at that radius on the SDF canvas (see `shapes.ts`). At default
  // `circle_radius = 0.015` and the current canonical radius (48), this
  // lands at icon-size 0.3375, rendering the circle at a 32.4-px on-screen
  // diameter — visual parity with the pre-canvas-bump sizing.
  // `buildPerFramePaints` overrides this every frame with an expression
  // that bumps the active waypoint to `active_radius`. */
  const defaultIconSize =
    (mapSettings.waypoints.size.circle_radius * w) / SHAPE_CANONICAL_RADIUS;
  return {
    paints: [
      ['route-full-line', 'line-color', routeSolid],
      ['route-trail-line', 'line-color', routeSolid],
      ['live-marker-pulse', 'circle-color', mapSettings.pov.color],
      ['live-marker-pulse-b', 'circle-color', mapSettings.pov.color],
      // Dot's stroke color tracks the POV primary (used to be hard-coded
      // accent); its fill takes the POV secondary, which is the field that
      // replaces the pre-refactor white-literal default. Both flow through
      // the static channel — no per-feature variation on the POV marker.
      ['live-marker-dot', 'circle-stroke-color', mapSettings.pov.color],
      ['live-marker-dot', 'circle-color', mapSettings.pov.secondary_color],
      ['route-full-line', 'line-width', mapSettings.route.size.width * w],
      ['route-trail-line', 'line-width', mapSettings.route.size.width * w],
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
    ],
    layouts: [
      // Label text-size / text-field live on the SECONDARY layer because
      // the outline icon and the label text are co-placed there as a
      // single MapLibre placement unit. See `WAYPOINTS_SECONDARY_LAYER`
      // for the rationale.
      ['waypoints-secondary', 'text-size', mapSettings.waypoints.size.label_size * w],
      ['waypoints-secondary', 'text-field', labelExpr],
      // Route visibility flows through layouts so per-clip `map_overrides`
      // of `route.mode` switch automatically at the cut (the renderer
      // re-resolves per-frame). Maplibre no-ops same-value writes, so the
      // steady-state cost is one map lookup per frame per tuple.
      ['route-full-line', 'visibility', mapSettings.route.mode === 'full' ? 'visible' : 'none'],
      ['route-trail-line', 'visibility', mapSettings.route.mode === 'visited' ? 'visible' : 'none'],
      // Waypoint icon-image (per slot). MapSettings-derived so a project-
      // default shape edit re-resolves and re-applies to every waypoint
      // without a per-`Waypoint.shape` override.
      ['waypoints-primary', 'icon-image', primaryIconImageExpr],
      ['waypoints-secondary', 'icon-image', secondaryIconImageExpr],
      // Waypoint icon-anchor (per slot). Same expression on both layers
      // — primary fill and secondary outline must share an anchor or
      // they'd render at different positions.
      ['waypoints-primary', 'icon-anchor', iconAnchorExpr],
      ['waypoints-secondary', 'icon-anchor', iconAnchorExpr],
      // Waypoint icon-size (per slot). Per-frame builder overrides this
      // with a case expression that bumps the active waypoint to
      // `active_radius`; the seed here is the steady-state default size.
      ['waypoints-primary', 'icon-size', defaultIconSize],
      ['waypoints-secondary', 'icon-size', defaultIconSize],
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
