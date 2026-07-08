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
import type {
  DecorationColor,
  GradientStop,
  HaloSettings,
  MapSettings,
  PovMarkerShape,
} from '../../types';
import { povMarkerOf } from '../../types';
import { colors } from '../../theme/tokens';
import { SHAPE_CANONICAL_RADIUS, TRANSPARENT_SDF_ICON_ID } from './shapes';
import {
  MARKER_IMAGE_CANONICAL_SIZE,
  TRANSPARENT_RASTER_ICON_ID,
  markerImageIconId,
} from './markerImage';
import type { HaloCompositeGroup, StyleSpecResult } from './types';

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

// ---- Halo falloff profile -------------------------------------------------
// `HaloSettings.falloff` shapes the glow's radial intensity profile by
// splitting the halo across two stacked layers: the user-sized OUTER band
// (edge character driven by `fade`) and a narrower, always-fully-feathered
// CORE band hugging the decoration. At falloff 0 the core is dark (opacity
// 0) and the outer band carries the full configured opacity — byte-identical
// to the single-layer halo that shipped first. As falloff → 1 the outer band
// dims toward `1 − HALO_FALLOFF_OUTER_DIM` of the configured opacity (the
// faint wide skirt) and the core rises toward `HALO_FALLOFF_CORE_GAIN` of it
// (the bright center). `resolveHaloParams` computes this pair
// (`outerOpacity` / `coreOpacity`) as the CONCEPTUAL on-line values — what
// the two bands would need to alpha-over blend directly onto the map to
// reach the configured peak `g = 1 − (1−outer)(1−core)` (e.g. at opacity 0.6
// / falloff 1: 1 − (1−0.21)(1−0.51) ≈ 0.61).
//
// Since 2026-07-07 these two bands are never blended directly — both render
// engines composite them as a GROUP (`.spike/halo-composite/VERDICT.md`):
// each band paints into a shared offscreen target at a REMAPPED "in-FBO"
// opacity (`haloGroupPolicy` below), and the flattened group composites over
// the map ONCE at `g`. The two-layer direct-blend arrangement described
// above remains the mathematical REFERENCE — the group composite is
// point-identical to it at every pixel where the halo doesn't self-overlap
// (see `haloGroupPolicy`'s doc comment for the proof) — but because the
// group only composites once, a self-crossing halo (an out-and-back route
// retrace, a GPS-jitter sunburst) can never exceed one coat of the
// configured opacity, where the old direct blend would visibly double-dark
// the overlap. `resolveStaticPaints` emits the REMAPPED `outerIn`/`coreIn`
// as the two layers' own `line-opacity`/`circle-opacity`, and returns the
// composite `g` per decoration in the `haloComposites` bucket.

/** Core band spread as a fraction of the configured halo spread. 0.35 keeps
 *  the core clearly inside the outer band so the two-layer composite reads
 *  as one continuous decaying glow rather than two rings. */
const HALO_CORE_SPREAD_FRACTION = 0.35;
/** How much of the outer band's opacity falloff=1 takes away. */
const HALO_FALLOFF_OUTER_DIM = 0.65;
/** How much of the configured opacity the core band gains at falloff=1. */
const HALO_FALLOFF_CORE_GAIN = 0.85;

/** Opacity-remap policy for the engine-level group-opacity composite (both
 *  the patched native renderer and the patched preview GL JS expose
 *  `map.setGroupComposite([{layers, opacity}])` — mechanics and measured
 *  results in `.spike/halo-composite/VERDICT.md`). Takes the CONCEPTUAL
 *  outer/core opacities `resolveHaloParams` computes (what the two bands
 *  would need to be to alpha-over blend directly onto the map) and returns
 *  the values the group composite actually needs: the two bands' own
 *  IN-FBO opacities, plus the composite opacity applied once over the map.
 *
 *  Derivation (spike-measured exact to 1e-12 against the formula below;
 *  see the module comment above for the human framing):
 *   - `g = 1 − (1−outer)(1−core)` — the direct-blend on-line peak, i.e. the
 *     opacity the flattened group must composite at to match today's look.
 *   - `outerIn = outer / g` (0 when `g` is 0, i.e. both opacities are 0 —
 *     avoids a 0/0 NaN).
 *   - `coreIn = core > 0 ? 1 : 0`. The general peak-match solve is
 *     `core · (1−outer) / (g−outer)`; expanding `g` gives
 *     `g − outer = core·(1−outer)` EXACTLY, so the quotient is identically 1
 *     whenever `core > 0` — the core band always saturates its own in-FBO
 *     alpha at its feathered coverage, and `g` alone carries the configured
 *     peak. (At `core = 0` the quotient is 0/0 — that's the falloff-0
 *     degenerate case handled below.)
 *
 *  Why this is point-identical to the old direct blend wherever the halo
 *  doesn't self-overlap: at a point where the core's feather gives
 *  fractional alpha `f · coreIn` (0 at the core band's outer edge, 1 on the
 *  line) and the outer band contributes `outerIn` uniformly, the FBO's
 *  flattened alpha is `1 − (1−outerIn)(1−f·coreIn)`, and the one-shot
 *  composite scales it by `g`:
 *    g · [1 − (1−outerIn)(1−f·coreIn)]
 *  Substituting `outerIn = outer/g`, `coreIn = 1`, and `g = outer +
 *  core·(1−outer)` and simplifying gives exactly `outer + f·core·(1−outer)`
 *  — identical to alpha-over compositing the outer band then the core band
 *  directly at that point. At falloff 0 (`core = 0`, `coreIn = 0`,
 *  `outerIn = 1`), the whole band renders as ONE fully-opaque coat inside
 *  the FBO and `g` alone controls the visible result: the FBO saturates, so
 *  ANY number of self-crossings still reads as a single coat — the general
 *  case for every non-self-overlapping point degenerates safely at the
 *  overlapping ones too. */
export function haloGroupPolicy(
  outerOpacity: number,
  coreOpacity: number,
): { g: number; outerIn: number; coreIn: number } {
  const g = 1 - (1 - outerOpacity) * (1 - coreOpacity);
  return {
    g,
    outerIn: g > 0 ? outerOpacity / g : 0,
    coreIn: coreOpacity > 0 ? 1 : 0,
  };
}

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

/** Full-route halo. A wider, blurred twin of `route-full-line` painting
 *  directly BENEATH it — the optional user-facing glow configured via
 *  `mapSettings.route.halo`. All paints are PLACEHOLDERS seeded by
 *  `resolveStaticPaints`; visibility couples `route.mode === 'full'` with
 *  `halo.enabled` (hidden whenever the halo is absent/disabled, so pinned
 *  goldens and legacy projects render byte-identically).
 *
 *  `line-translate-anchor: 'viewport'` is static on every halo layer: the
 *  user-facing offset is a drop-shadow direction, which must stay fixed on
 *  screen as the map bearing animates (a 'map' anchor would spin the shadow
 *  with the camera). */
export const ROUTE_FULL_HALO_LAYER: LayerSpecification = {
  id: 'route-full-halo',
  type: 'line',
  source: 'route-full',
  layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' },
  paint: {
    'line-color': '#ffffff',
    'line-width': 1,
    'line-blur': 0,
    'line-opacity': 0.6,
    'line-translate': [0, 0],
    'line-translate-anchor': 'viewport',
  },
};

/** Full-route halo CORE — the narrower, fully-feathered twin stacked between
 *  `route-full-halo` and the route line. It carries the `falloff` parameter:
 *  `resolveStaticPaints` raises this layer's opacity (and dims the outer
 *  band) as falloff grows, approximating a glow profile that hugs the line
 *  and decays outward. Held at opacity 0 AND hidden while `falloff` is 0 so
 *  pre-falloff projects render byte-identically through the single outer
 *  layer. */
export const ROUTE_FULL_HALO_CORE_LAYER: LayerSpecification = {
  id: 'route-full-halo-core',
  type: 'line',
  source: 'route-full',
  layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' },
  paint: {
    'line-color': '#ffffff',
    'line-width': 1,
    'line-blur': 0,
    'line-opacity': 0,
    'line-translate': [0, 0],
    'line-translate-anchor': 'viewport',
  },
};

/** Slime-trail halo. Same contract as `ROUTE_FULL_HALO_LAYER` but under
 *  `route-trail-line` (visibility couples `route.mode === 'visited'` with
 *  `halo.enabled`). Source: `route-trail`. */
export const ROUTE_TRAIL_HALO_LAYER: LayerSpecification = {
  id: 'route-trail-halo',
  type: 'line',
  source: 'route-trail',
  layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' },
  paint: {
    'line-color': '#ffffff',
    'line-width': 1,
    'line-blur': 0,
    'line-opacity': 0.6,
    'line-translate': [0, 0],
    'line-translate-anchor': 'viewport',
  },
};

/** Slime-trail halo CORE — same contract as `ROUTE_FULL_HALO_CORE_LAYER`,
 *  under `route-trail-line`. Source: `route-trail`. */
export const ROUTE_TRAIL_HALO_CORE_LAYER: LayerSpecification = {
  id: 'route-trail-halo-core',
  type: 'line',
  source: 'route-trail',
  layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' },
  paint: {
    'line-color': '#ffffff',
    'line-width': 1,
    'line-blur': 0,
    'line-opacity': 0,
    'line-translate': [0, 0],
    'line-translate-anchor': 'viewport',
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

/** Waypoints halo — the optional user-facing glow behind EVERY waypoint
 *  marker (`mapSettings.waypoints.halo`), all marker kinds (SDF shapes and
 *  library images alike — a blurred circle beneath the whole marker stack).
 *  Distinct from `waypoints-active-halo`, which is the automatic "you are
 *  here" ring on the active waypoint only. All paints are PLACEHOLDERS
 *  seeded by `resolveStaticPaints`: radius = `(circle_radius + halo.size) ×
 *  w`, `circle-blur` carries `fade`, `circle-translate` carries the
 *  drop-shadow offset (viewport-anchored — see the route halo layer note),
 *  and gradient colors ride a per-feature `['get', 'progress']` interpolate
 *  so each waypoint samples the gradient at its own trail distance.
 *  Source: `waypoints`. */
export const WAYPOINTS_HALO_LAYER: LayerSpecification = {
  id: 'waypoints-halo',
  type: 'circle',
  source: 'waypoints',
  layout: { visibility: 'none' },
  paint: {
    'circle-radius': 1,
    'circle-color': '#ffffff',
    'circle-blur': 0,
    'circle-opacity': 0.6,
    'circle-stroke-width': 0,
    'circle-translate': [0, 0],
    'circle-translate-anchor': 'viewport',
  },
};

/** Waypoints halo CORE — the narrower, fully-feathered falloff twin of
 *  `waypoints-halo` (same contract as `ROUTE_FULL_HALO_CORE_LAYER`: hidden
 *  and opacity 0 while `falloff` is 0). Source: `waypoints`. */
export const WAYPOINTS_HALO_CORE_LAYER: LayerSpecification = {
  id: 'waypoints-halo-core',
  type: 'circle',
  source: 'waypoints',
  layout: { visibility: 'none' },
  paint: {
    'circle-radius': 1,
    'circle-color': '#ffffff',
    'circle-blur': 1,
    'circle-opacity': 0,
    'circle-stroke-width': 0,
    'circle-translate': [0, 0],
    'circle-translate-anchor': 'viewport',
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

/** Waypoint IMAGE symbol layer (schema v11). Paints library-image markers
 *  (`marker-image-<id>`, sdf:false full-color bitmaps) for waypoints whose
 *  effective marker is an image; every shape-marked feature resolves this
 *  layer's icon-image to the 1×1 transparent raster placeholder. The split
 *  exists because a symbol layer's icon bucket must stay homogeneous in
 *  SDF-ness — MapLibre refuses to mix SDF and non-SDF icons in one layer —
 *  so the SDF shape layers and this raster layer "hide" each other's
 *  features with transparent placeholders instead of filters (filters
 *  aren't part of the ResolvedStaticPaints tuple contract).
 *
 *  Stacked directly above `waypoints-secondary`, below nothing else — the
 *  label text stays on the secondary layer, so image-marked waypoints keep
 *  their labels. Collision: allow-overlap + ignore-placement (like the
 *  primary fill — every image marker always draws, and the transparent
 *  placeholders can never perturb label collision). `icon-size` is a
 *  PLACEHOLDER — resolveStaticPaints seeds `(circle_radius × w) /
 *  (MARKER_IMAGE_CANONICAL_SIZE / 2)` (image longest side = shape
 *  DIAMETER, so the existing size slider drives both marker kinds), and
 *  `buildPerFramePaints.waypointImageIconSize` overrides it with the
 *  active-bump case expression. NO `icon-color` — full-color bitmaps are
 *  drawn verbatim, never tinted. Source: `waypoints`. */
export const WAYPOINTS_IMAGE_LAYER: LayerSpecification = {
  id: 'waypoints-image',
  type: 'symbol',
  source: 'waypoints',
  layout: {
    'icon-image': TRANSPARENT_RASTER_ICON_ID,
    'icon-size': 1,
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
    'icon-anchor': 'center',
    'symbol-z-order': 'source',
    'symbol-sort-key': 0,
  },
  paint: {
    'icon-opacity': 1,
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

/** POV halo — the optional user-facing glow behind the POV marker
 *  (`mapSettings.pov.halo`), every marker kind (dot / shape preset /
 *  library image). Bottom of the live-marker stack so the pulse rings and
 *  the marker body all paint over it. All paints are PLACEHOLDERS seeded
 *  by `resolveStaticPaints`: radius = `(marker body radius + halo.size) ×
 *  w` (body radius = `dot_radius` for dot/shape markers, `image_size / 2`
 *  for image markers), `circle-blur` carries `fade`, `circle-translate`
 *  carries the viewport-anchored drop-shadow offset. Solid color only
 *  (POV rule). Source: `live-marker`. */
export const LIVE_MARKER_HALO_LAYER: LayerSpecification = {
  id: 'live-marker-halo',
  type: 'circle',
  source: 'live-marker',
  layout: { visibility: 'none' },
  paint: {
    'circle-radius': 1,
    'circle-color': '#ffffff',
    'circle-blur': 0,
    'circle-opacity': 0.6,
    'circle-stroke-width': 0,
    'circle-translate': [0, 0],
    'circle-translate-anchor': 'viewport',
  },
};

/** POV halo CORE — the narrower, fully-feathered falloff twin of
 *  `live-marker-halo` (same contract as `ROUTE_FULL_HALO_CORE_LAYER`:
 *  hidden and opacity 0 while `falloff` is 0). Source: `live-marker`. */
export const LIVE_MARKER_HALO_CORE_LAYER: LayerSpecification = {
  id: 'live-marker-halo-core',
  type: 'circle',
  source: 'live-marker',
  layout: { visibility: 'none' },
  paint: {
    'circle-radius': 1,
    'circle-color': '#ffffff',
    'circle-blur': 1,
    'circle-opacity': 0,
    'circle-stroke-width': 0,
    'circle-translate': [0, 0],
    'circle-translate-anchor': 'viewport',
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
 *  resolveStaticPaints. `visibility` is driven by resolveStaticPaints too:
 *  the dot hides when a custom POV image (`pov.image`) is active — the
 *  image REPLACES the dot; the pulse rings stay independent. */
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

/** Live-marker library image — the POV marker when
 *  `pov.marker = { kind: 'image', image_id }`. Always seeded in the layer
 *  stack (above the dot) so activating an image mid-session doesn't have to
 *  add a layer; `visibility` is held at 'none' by resolveStaticPaints until
 *  an image marker is selected. Full-color non-SDF symbol: the
 *  `marker-image-<id>` icons register with `sdf: false` (see
 *  `markerImage.ts` — POV colors don't tint them). The seed icon-image is
 *  the transparent raster placeholder (always registered); the real
 *  `marker-image-<id>` id is only emitted by resolveStaticPaints while an
 *  image marker is active, so no engine ever resolves an id before its
 *  texture is registered. `icon-size` is a PLACEHOLDER —
 *  resolveStaticPaints emits `(pov.size.image_size ×
 *  PAINT_REFERENCE_WIDTH × surfaceScale) / MARKER_IMAGE_CANONICAL_SIZE`.
 *  Collision opts match the other marker layers: the POV marker must always
 *  draw. Source: `live-marker`. */
export const LIVE_MARKER_IMAGE_LAYER: LayerSpecification = {
  id: 'live-marker-image',
  type: 'symbol',
  source: 'live-marker',
  layout: {
    'icon-image': TRANSPARENT_RASTER_ICON_ID,
    'icon-size': 1,
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
    'icon-anchor': 'center',
    visibility: 'none',
  },
  paint: {
    'icon-opacity': 1,
  },
};

/** Live-marker shape preset, PRIMARY slot (schema v11) — the POV marker's
 *  filled silhouette when `pov.marker` is a non-dot shape (ring / square /
 *  diamond, the catalog's pov domain). SDF symbol tinted by `pov.color`
 *  via `icon-color` (waypoint convention: primary = body). Seeded hidden;
 *  resolveStaticPaints drives the three-way visibility swap between the
 *  dot circle layer, this pair, and the image layer. `icon-image` /
 *  `icon-size` are PLACEHOLDERS — resolveStaticPaints emits
 *  `pov-<shape>-primary` (registered by `buildShapeIconsFor('pov', 'pov-',
 *  …)` with the POV's own outline geometry) and `(pov.size.dot_radius × w)
 *  / SHAPE_CANONICAL_RADIUS`. The dot ('dot' preset) deliberately does NOT
 *  render through this layer — it keeps the original `live-marker-dot`
 *  circle layer so default projects stay pixel-identical.
 *  Source: `live-marker`. */
export const LIVE_MARKER_SHAPE_PRIMARY_LAYER: LayerSpecification = {
  id: 'live-marker-shape-primary',
  type: 'symbol',
  source: 'live-marker',
  layout: {
    'icon-image': TRANSPARENT_SDF_ICON_ID,
    'icon-size': 1,
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
    'icon-anchor': 'center',
    visibility: 'none',
  },
  paint: {
    'icon-color': colors.accent,
    'icon-opacity': 1,
  },
};

/** Live-marker shape preset, SECONDARY slot — the outline / accent element
 *  stacked above `live-marker-shape-primary`, tinted by
 *  `pov.secondary_color`. One-color shapes (ring) resolve a transparent
 *  placeholder here, mirroring the waypoint secondary-slot convention.
 *  Source: `live-marker`. */
export const LIVE_MARKER_SHAPE_SECONDARY_LAYER: LayerSpecification = {
  id: 'live-marker-shape-secondary',
  type: 'symbol',
  source: 'live-marker',
  layout: {
    'icon-image': TRANSPARENT_SDF_ICON_ID,
    'icon-size': 1,
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
    'icon-anchor': 'center',
    visibility: 'none',
  },
  paint: {
    'icon-color': '#ffffff',
    'icon-opacity': 1,
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
 *     special-case the mode swap.
 *   - `haloComposites`: the engine-level group-opacity composite config for
 *     the four halo layer pairs (route-full, route-trail, waypoints,
 *     live-marker), ALWAYS four groups in a fixed order, emitted
 *     unconditionally (same convention as the halo paint values above — a
 *     group whose layers are hidden has no live members and short-circuits
 *     in-engine). The two member layers' own `line-opacity`/`circle-opacity`
 *     in `paints` are the REMAPPED in-FBO values from `haloGroupPolicy`, not
 *     the conceptual outer/core opacities — see the module comment on the
 *     falloff profile and `haloGroupPolicy`'s doc comment for the
 *     derivation. */
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
  /** Engine-level group-opacity composite config, one group per halo layer
   *  pair, ALWAYS four groups in the fixed order [route-full, route-trail,
   *  waypoints, live-marker] — see the interface doc above and
   *  `haloGroupPolicy`. Consumers (renderer worker + preview) call
   *  `map.setGroupComposite(haloComposites)` after applying `paints`. */
  haloComposites: HaloCompositeGroup[];
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
  // Route halo. Defensive read — the field is optional (absent ⇒ disabled)
  // so legacy projects and wire payloads without it resolve to hidden halo
  // layers. Paint values are emitted unconditionally (harmless while the
  // layers are hidden, same convention as the POV shape slots above);
  // only visibility gates on `enabled`. The halo line's total width is the
  // route line plus the configured spread on each side; `line-blur` feathers
  // inward from each edge, so `fade × width / 2` spans crisp → fully soft.
  // `falloff` splits the glow between this outer band and the `-core` twin
  // (see the HALO_FALLOFF_* constants); `offset_x/y` become a viewport-
  // anchored `line-translate` (drop-shadow direction fixed on screen).
  const halo = resolveHaloParams(mapSettings.route.halo);
  // Group-composite remap: the outer/core opacities above are the
  // CONCEPTUAL direct-blend values; `routePolicy.outerIn`/`coreIn` are what
  // the two layers actually paint, and `routePolicy.g` is the composite
  // opacity emitted in `haloComposites` (see `haloGroupPolicy`).
  const routePolicy = haloGroupPolicy(halo.outerOpacity, halo.coreOpacity);
  // Width/blur/translate ride `w` even when the halo is absent (spread/fade/
  // offset collapse to 0) so every size-like tuple stays linear in the
  // surface factor — the surfaceScale contract is uniform across tuples,
  // hidden or not.
  const haloWidth = (mapSettings.route.size.width + 2 * halo.spread) * w;
  const haloBlur = (halo.fade * haloWidth) / 2;
  const haloCoreWidth =
    (mapSettings.route.size.width +
      2 * halo.spread * HALO_CORE_SPREAD_FRACTION) *
    w;
  const haloTranslate = [halo.offsetX * w, halo.offsetY * w];
  const haloGradientExpr = halo.gradientStops
    ? buildLineGradientExpression(halo.gradientStops)
    : null;
  // Waypoints halo — a circle layer pair beneath the whole waypoint marker
  // stack. Same parameter model as the route halo; radius = marker body
  // radius + spread (image markers display at the shape diameter, so
  // `circle_radius` is the body radius for every marker kind). Gradient
  // colors sample each waypoint's own trail distance via the per-feature
  // `progress` property (baked by `buildWaypointsCollection`) — the same
  // parameterization the waypoint primary-color gradient uses, so the halo
  // agrees with the marker it sits under. No active-state involvement: the
  // separate `waypoints-active-halo` layer carries the "you are here" ring.
  const wpHalo = resolveHaloParams(mapSettings.waypoints.halo);
  const wpPolicy = haloGroupPolicy(wpHalo.outerOpacity, wpHalo.coreOpacity);
  const wpHaloColor: string | ExpressionSpecification = wpHalo.gradientStops
    ? buildProgressGradientExpression(wpHalo.gradientStops)
    : wpHalo.solid;
  const wpHaloRadius =
    (mapSettings.waypoints.size.circle_radius + wpHalo.spread) * w;
  const wpHaloCoreRadius =
    (mapSettings.waypoints.size.circle_radius +
      wpHalo.spread * HALO_CORE_SPREAD_FRACTION) *
    w;
  const wpHaloTranslate = [wpHalo.offsetX * w, wpHalo.offsetY * w];
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
  // Project-level effective marker: the marker image wins over the shape
  // (same precedence as the per-waypoint `override_marker` property baked
  // by `buildWaypointsCollection` — see `waypointMarkerProperty` in
  // sources.ts). Image selections are encoded as `image:<library id>`
  // strings so shapes and images route through ONE `match` expression.
  const projectMarker =
    mapSettings.waypoints.marker_image_id !== undefined
      ? `image:${mapSettings.waypoints.marker_image_id}`
      : mapSettings.waypoints.shape;
  // Defensive `?? []`: the Rust model omits `marker_images` when empty
  // (`skip_serializing_if`), so a wire payload (export sidecar setup) may
  // arrive without the field even though the TS type declares it.
  const markerImages = mapSettings.marker_images ?? [];
  const imageArms = markerImages.map((m) => `image:${m.id}`);
  const safeMarker: ExpressionSpecification = [
    'match',
    ['coalesce', ['get', 'override_marker'], projectMarker],
    'circle', 'circle',
    'ring', 'ring',
    'pin', 'pin',
    'square', 'square',
    'diamond', 'diamond',
    ...imageArms.flatMap((arm) => [arm, arm]),
    /* default for legacy / unknown names / deleted library ids */ 'circle',
  ] as ExpressionSpecification;
  // Per-feature `icon-image` expression for each SDF slot. Shape-marked
  // features resolve to `waypoint-<effective_shape>-primary` (or
  // `-secondary`) — the same ids `buildAllShapeIcons` registers on both
  // sides; image-marked features resolve to the transparent SDF
  // placeholder so the SDF layers stay bucket-homogeneous (MapLibre cannot
  // mix SDF and non-SDF icons in one symbol layer) while the
  // `waypoints-image` layer paints the actual bitmap.
  const primaryConcat: ExpressionSpecification = [
    'concat',
    'waypoint-',
    safeMarker,
    '-primary',
  ];
  const secondaryConcat: ExpressionSpecification = [
    'concat',
    'waypoint-',
    safeMarker,
    '-secondary',
  ];
  const primaryIconImageExpr: ExpressionSpecification = imageArms.length
    ? ([
        'match',
        safeMarker,
        ...imageArms.flatMap((arm) => [arm, TRANSPARENT_SDF_ICON_ID]),
        primaryConcat,
      ] as ExpressionSpecification)
    : primaryConcat;
  const secondaryIconImageExpr: ExpressionSpecification = imageArms.length
    ? ([
        'match',
        safeMarker,
        ...imageArms.flatMap((arm) => [arm, TRANSPARENT_SDF_ICON_ID]),
        secondaryConcat,
      ] as ExpressionSpecification)
    : secondaryConcat;
  // The image layer's mirror image: image-marked features resolve to their
  // registered `marker-image-<id>` texture; every shape-marked feature
  // resolves to the 1×1 transparent raster placeholder.
  const imageIconImageExpr: string | ExpressionSpecification =
    imageArms.length
      ? ([
          'match',
          safeMarker,
          ...markerImages.flatMap((m) => [
            `image:${m.id}`,
            markerImageIconId(m.id),
          ]),
          TRANSPARENT_RASTER_ICON_ID,
        ] as ExpressionSpecification)
      : TRANSPARENT_RASTER_ICON_ID;
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
    safeMarker,
    'pin', 'bottom',
    /* default (every other shape + image markers) */ 'center',
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
  // Image-marker size seed for `waypoints-image`. The image's LONGEST side
  // displays at the shape DIAMETER (`2 × circle_radius × w` CSS px) so the
  // one `circle_radius` slider drives both marker kinds:
  // icon-size = (2 × circle_radius × w) / MARKER_IMAGE_CANONICAL_SIZE
  //           = (circle_radius × w) / (MARKER_IMAGE_CANONICAL_SIZE / 2).
  // `buildPerFramePaints.waypointImageIconSize` overrides this per frame
  // with the active-bump case expression.
  const defaultImageIconSize =
    (mapSettings.waypoints.size.circle_radius * w) /
    (MARKER_IMAGE_CANONICAL_SIZE / 2);
  // POV marker (schema v11) — three-way visibility swap between the classic
  // dot circle layer ('dot' preset — pixel-identical to pre-v11 output),
  // the SDF shape-preset symbol pair (ring / square / diamond), and the
  // library-image symbol layer. ALL FOUR visibilities are emitted in EVERY
  // branch so any marker change (project edit or per-clip resolve at a cut)
  // always restores the layers the new marker doesn't use. The pulse rings
  // are independent and unaffected — the pulse applies to every marker
  // kind. `icon-image` ids are only emitted while their marker kind is
  // active so no engine ever resolves an id before its texture registers
  // (the seeds are transparent placeholders). Image `icon-size` bridges the
  // reference-space size to the registered texture's natural CSS size:
  // longest-side CSS target ÷ MARKER_IMAGE_CANONICAL_SIZE (see
  // markerImage.ts); shape `icon-size` uses the waypoint bridge
  // (dot_radius × w) / SHAPE_CANONICAL_RADIUS.
  //
  // Defensive fallbacks collapse to the dot (mirroring safeMarker's circle
  // fallback): an image marker whose id is missing from the library (e.g.
  // hand-edited bundle) or an unknown shape name renders the dot in
  // preview; the export sidecar separately fails LOUD at setup when a
  // referenced library id can't be registered.
  const povMarker = povMarkerOf(mapSettings.pov);
  const povShapeNames: readonly PovMarkerShape[] = ['ring', 'square', 'diamond'];
  const povHidden = (
    ...visible: Array<'dot' | 'shape' | 'image'>
  ): Array<[string, string, string]> => {
    const out: Array<[string, string, string]> = [
      ['live-marker-dot', 'visibility', visible.includes('dot') ? 'visible' : 'none'],
      ['live-marker-shape-primary', 'visibility', visible.includes('shape') ? 'visible' : 'none'],
      ['live-marker-shape-secondary', 'visibility', visible.includes('shape') ? 'visible' : 'none'],
      ['live-marker-image', 'visibility', visible.includes('image') ? 'visible' : 'none'],
    ];
    return out;
  };
  let povMarkerLayouts: Array<
    [string, string, number | string | ExpressionSpecification]
  >;
  if (
    povMarker.kind === 'image' &&
    markerImages.some((m) => m.id === povMarker.image_id)
  ) {
    povMarkerLayouts = [
      ...povHidden('image'),
      ['live-marker-image', 'icon-image', markerImageIconId(povMarker.image_id)],
      [
        'live-marker-image',
        'icon-size',
        (mapSettings.pov.size.image_size * w) / MARKER_IMAGE_CANONICAL_SIZE,
      ],
    ];
  } else if (
    povMarker.kind === 'shape' &&
    (povShapeNames as readonly string[]).includes(povMarker.shape)
  ) {
    const povShapeIconSize =
      (mapSettings.pov.size.dot_radius * w) / SHAPE_CANONICAL_RADIUS;
    povMarkerLayouts = [
      ...povHidden('shape'),
      ['live-marker-shape-primary', 'icon-image', `pov-${povMarker.shape}-primary`],
      ['live-marker-shape-primary', 'icon-size', povShapeIconSize],
      ['live-marker-shape-secondary', 'icon-image', `pov-${povMarker.shape}-secondary`],
      ['live-marker-shape-secondary', 'icon-size', povShapeIconSize],
    ];
  } else {
    // 'dot', unknown shape names, and image ids absent from the library.
    povMarkerLayouts = [...povHidden('dot')];
  }
  // POV halo — a circle layer pair at the bottom of the live-marker stack.
  // Same parameter model as the route halo. The body radius mirrors the
  // three-way marker resolve above: image markers (with a registered
  // library entry) display at `image_size` longest-side, so the body
  // radius is half of it; dot and shape markers render at `dot_radius`
  // (the same fallback chain as the marker itself, so a missing library id
  // sizes the halo for the dot it collapses to). Solid color only (POV
  // rule — `resolveHaloParams` falls back to the first gradient stop
  // defensively).
  const povHalo = resolveHaloParams(mapSettings.pov.halo);
  const povPolicy = haloGroupPolicy(povHalo.outerOpacity, povHalo.coreOpacity);
  const povBodyRadius =
    povMarker.kind === 'image' &&
    markerImages.some((m) => m.id === povMarker.image_id)
      ? mapSettings.pov.size.image_size / 2
      : mapSettings.pov.size.dot_radius;
  const povHaloRadius = (povBodyRadius + povHalo.spread) * w;
  const povHaloCoreRadius =
    (povBodyRadius + povHalo.spread * HALO_CORE_SPREAD_FRACTION) * w;
  const povHaloTranslate = [povHalo.offsetX * w, povHalo.offsetY * w];
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
      // POV shape-preset slots follow the waypoint SDF convention: primary
      // = body tint (POV primary color), secondary = outline tint. Emitted
      // unconditionally — harmless while the layers are hidden, and it
      // keeps color edits live the instant a shape marker activates.
      ['live-marker-shape-primary', 'icon-color', mapSettings.pov.color],
      [
        'live-marker-shape-secondary',
        'icon-color',
        mapSettings.pov.secondary_color,
      ],
      ['route-full-line', 'line-width', mapSettings.route.size.width * w],
      ['route-trail-line', 'line-width', mapSettings.route.size.width * w],
      // Route halo — see the halo derivation above. Outer band: user-sized
      // width, fade-driven blur, falloff-dimmed opacity.
      ['route-full-halo', 'line-color', halo.solid],
      ['route-trail-halo', 'line-color', halo.solid],
      ['route-full-halo', 'line-width', haloWidth],
      ['route-trail-halo', 'line-width', haloWidth],
      ['route-full-halo', 'line-blur', haloBlur],
      ['route-trail-halo', 'line-blur', haloBlur],
      // Emitted opacities are the REMAPPED in-FBO values (`routePolicy`),
      // not the conceptual `halo.outerOpacity`/`coreOpacity` — the group
      // composite (`haloComposites` below) applies the on-line peak once.
      ['route-full-halo', 'line-opacity', routePolicy.outerIn],
      ['route-trail-halo', 'line-opacity', routePolicy.outerIn],
      ['route-full-halo', 'line-translate', haloTranslate],
      ['route-trail-halo', 'line-translate', haloTranslate],
      // Route halo CORE — the falloff twin: narrower, always fully
      // feathered (blur = half-width → triangular profile peaking at the
      // line), opacity rising with falloff. Shares color/gradient/offset
      // with the outer band.
      ['route-full-halo-core', 'line-color', halo.solid],
      ['route-trail-halo-core', 'line-color', halo.solid],
      ['route-full-halo-core', 'line-width', haloCoreWidth],
      ['route-trail-halo-core', 'line-width', haloCoreWidth],
      ['route-full-halo-core', 'line-blur', haloCoreWidth / 2],
      ['route-trail-halo-core', 'line-blur', haloCoreWidth / 2],
      ['route-full-halo-core', 'line-opacity', routePolicy.coreIn],
      ['route-trail-halo-core', 'line-opacity', routePolicy.coreIn],
      ['route-full-halo-core', 'line-translate', haloTranslate],
      ['route-trail-halo-core', 'line-translate', haloTranslate],
      // Waypoints halo — see the derivation above. `circle-blur` is
      // dimensionless (1 = only the center at full opacity), so `fade`
      // maps directly and does NOT ride `w`.
      ['waypoints-halo', 'circle-color', wpHaloColor],
      ['waypoints-halo', 'circle-radius', wpHaloRadius],
      ['waypoints-halo', 'circle-blur', wpHalo.fade],
      // Emitted opacities are the remapped in-FBO values — see the route
      // halo comment above; same policy, this decoration's own params.
      ['waypoints-halo', 'circle-opacity', wpPolicy.outerIn],
      ['waypoints-halo', 'circle-translate', wpHaloTranslate],
      ['waypoints-halo-core', 'circle-color', wpHaloColor],
      ['waypoints-halo-core', 'circle-radius', wpHaloCoreRadius],
      ['waypoints-halo-core', 'circle-blur', 1],
      ['waypoints-halo-core', 'circle-opacity', wpPolicy.coreIn],
      ['waypoints-halo-core', 'circle-translate', wpHaloTranslate],
      // POV halo — see the derivation above.
      ['live-marker-halo', 'circle-color', povHalo.solid],
      ['live-marker-halo', 'circle-radius', povHaloRadius],
      ['live-marker-halo', 'circle-blur', povHalo.fade],
      // Emitted opacities are the remapped in-FBO values — see the route
      // halo comment above; same policy, this decoration's own params.
      ['live-marker-halo', 'circle-opacity', povPolicy.outerIn],
      ['live-marker-halo', 'circle-translate', povHaloTranslate],
      ['live-marker-halo-core', 'circle-color', povHalo.solid],
      ['live-marker-halo-core', 'circle-radius', povHaloCoreRadius],
      ['live-marker-halo-core', 'circle-blur', 1],
      ['live-marker-halo-core', 'circle-opacity', povPolicy.coreIn],
      ['live-marker-halo-core', 'circle-translate', povHaloTranslate],
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
      // Halo visibility couples the route mode with the halo toggle — each
      // halo layer shows only when its route layer shows AND the halo is on.
      // The core twins additionally require falloff > 0 (they paint nothing
      // at falloff 0, so hiding them keeps pre-falloff renders and goldens
      // byte-identical).
      [
        'route-full-halo',
        'visibility',
        halo.enabled && mapSettings.route.mode === 'full' ? 'visible' : 'none',
      ],
      [
        'route-trail-halo',
        'visibility',
        halo.enabled && mapSettings.route.mode === 'visited' ? 'visible' : 'none',
      ],
      [
        'route-full-halo-core',
        'visibility',
        halo.enabled && halo.falloff > 0 && mapSettings.route.mode === 'full'
          ? 'visible'
          : 'none',
      ],
      [
        'route-trail-halo-core',
        'visibility',
        halo.enabled && halo.falloff > 0 && mapSettings.route.mode === 'visited'
          ? 'visible'
          : 'none',
      ],
      // Marker halo visibility. The waypoints/live-marker sources already
      // carry the decoration-level visibility (mode-filtered collections /
      // per-frame data), so the halo layers gate on the halo toggle alone.
      [
        'waypoints-halo',
        'visibility',
        wpHalo.enabled ? 'visible' : 'none',
      ],
      [
        'waypoints-halo-core',
        'visibility',
        wpHalo.enabled && wpHalo.falloff > 0 ? 'visible' : 'none',
      ],
      [
        'live-marker-halo',
        'visibility',
        povHalo.enabled ? 'visible' : 'none',
      ],
      [
        'live-marker-halo-core',
        'visibility',
        povHalo.enabled && povHalo.falloff > 0 ? 'visible' : 'none',
      ],
      // Waypoint icon-image (per slot). MapSettings-derived so a project-
      // default shape edit re-resolves and re-applies to every waypoint
      // without a per-`Waypoint.shape` override.
      ['waypoints-primary', 'icon-image', primaryIconImageExpr],
      ['waypoints-secondary', 'icon-image', secondaryIconImageExpr],
      // Waypoint image layer — image-marked features get their bitmap;
      // shape-marked features get the transparent raster placeholder.
      ['waypoints-image', 'icon-image', imageIconImageExpr],
      // Waypoint icon-anchor (per slot). Same expression on both layers
      // — primary fill and secondary outline must share an anchor or
      // they'd render at different positions. (The image layer is always
      // center-anchored — set statically in its spec — because image
      // markers have no pin-tip semantic.)
      ['waypoints-primary', 'icon-anchor', iconAnchorExpr],
      ['waypoints-secondary', 'icon-anchor', iconAnchorExpr],
      // Waypoint icon-size (per slot). Per-frame builder overrides this
      // with a case expression that bumps the active waypoint to
      // `active_radius`; the seed here is the steady-state default size.
      ['waypoints-primary', 'icon-size', defaultIconSize],
      ['waypoints-secondary', 'icon-size', defaultIconSize],
      ['waypoints-image', 'icon-size', defaultImageIconSize],
      // POV marker — three-way visibility swap + per-kind icon wiring (see
      // the povMarkerLayouts derivation above).
      ...povMarkerLayouts,
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
      // Halo gradient — independent of the route line's (own color config).
      // Solid/absent emits null so a stale halo gradient is cleared. The
      // core twins share the outer band's gradient so the two layers read
      // as one glow.
      ['route-full-halo', haloGradientExpr],
      ['route-trail-halo', haloGradientExpr],
      ['route-full-halo-core', haloGradientExpr],
      ['route-trail-halo-core', haloGradientExpr],
    ],
    // Fixed four groups, always emitted — see the interface doc and
    // `haloGroupPolicy`. A group whose layers are hidden (halo disabled,
    // wrong route mode, etc.) has no live members and short-circuits
    // in-engine, so there's no need to gate this bucket on `enabled`.
    haloComposites: [
      {
        layers: ['route-full-halo', 'route-full-halo-core'],
        opacity: routePolicy.g,
      },
      {
        layers: ['route-trail-halo', 'route-trail-halo-core'],
        opacity: routePolicy.g,
      },
      {
        layers: ['waypoints-halo', 'waypoints-halo-core'],
        opacity: wpPolicy.g,
      },
      {
        layers: ['live-marker-halo', 'live-marker-halo-core'],
        opacity: povPolicy.g,
      },
    ],
  };
}

/** Normalize a possibly-absent `HaloSettings` block into the values the
 *  resolver emits. One shared derivation for all three decorations so the
 *  halo parameter model (defensive defaults, falloff → outer/core opacity
 *  split, offset fractions) can never drift between them. Every returned
 *  size-like value is still a REFERENCE-SPACE fraction — callers multiply
 *  by `w` so the surfaceScale contract stays uniform. */
function resolveHaloParams(halo: HaloSettings | undefined): {
  enabled: boolean;
  /** Solid color (or gradient fallback) for the plain color paint. */
  solid: string;
  /** Spread beyond the decoration's own edge (reference fraction). */
  spread: number;
  /** Edge softness in [0, 1] — outer band only; cores are always soft. */
  fade: number;
  /** Radial falloff in [0, 1], clamped defensively (hand-edited bundles). */
  falloff: number;
  /** Outer band opacity: configured opacity dimmed as falloff grows. */
  outerOpacity: number;
  /** Core band opacity: 0 at falloff 0, rising toward
   *  `opacity × HALO_FALLOFF_CORE_GAIN`. */
  coreOpacity: number;
  /** Drop-shadow offset (reference fractions, signed; +x right, +y down). */
  offsetX: number;
  offsetY: number;
  /** Gradient stops when the halo color is in gradient mode, else null. */
  gradientStops: GradientStop[] | null;
} {
  const falloff = Math.min(1, Math.max(0, halo?.falloff ?? 0));
  const opacity = halo?.opacity ?? 0.6;
  return {
    enabled: halo?.enabled === true,
    solid: halo ? solidColorOf(halo.color) : '#ffffff',
    spread: halo?.size ?? 0,
    fade: halo?.fade ?? 0,
    falloff,
    outerOpacity: opacity * (1 - HALO_FALLOFF_OUTER_DIM * falloff),
    coreOpacity: opacity * HALO_FALLOFF_CORE_GAIN * falloff,
    offsetX: halo?.offset_x ?? 0,
    offsetY: halo?.offset_y ?? 0,
    gradientStops:
      halo && halo.color.mode === 'gradient' ? halo.color.stops : null,
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
  return gradientInterpolateExpression(['line-progress'], stops);
}

/** Circle-layer sibling of `buildLineGradientExpression`: the same gradient
 *  interpolate, keyed off the per-feature `progress` property instead of
 *  MapLibre's `line-progress` evaluator. Used by the waypoints halo so each
 *  waypoint's halo samples the gradient at that waypoint's own trail
 *  distance — the identical parameterization `decorationColorToBase` in
 *  `paints.ts` uses for the waypoint marker colors, so halo and marker
 *  agree at the same fraction. */
export function buildProgressGradientExpression(
  stops: GradientStop[],
): ExpressionSpecification {
  return gradientInterpolateExpression(['get', 'progress'], stops);
}

/** Shared body for the two gradient builders — one defensive-input policy
 *  regardless of the interpolation input expression. */
function gradientInterpolateExpression(
  input: ExpressionSpecification,
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
    input,
    ...args,
  ] as ExpressionSpecification;
}
