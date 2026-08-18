// Public types for the shared mapVisuals module. The module is the single
// source of visual truth for both the preview map (`MapView.tsx`) and the
// Node-based export renderer worker. These interfaces describe the values
// flowing between the pure builders and their consumers — nothing here
// depends on a runtime maplibre instance, React, or the DOM.

import type {
  StyleSpecification,
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
} from 'maplibre-gl';
import type { ResolvedCamera } from '../cameraIntent';

/** Pulse animation sample at a given project-time. Drives one of the live-
 *  marker outer ring layers: `radius` → `circle-radius`,
 *  `opacity` → `circle-opacity`. Also carries `dotOpacity`, the
 *  `live-marker-dot.circle-opacity` value for the same frame — the `throb`
 *  style oscillates the dot's opacity in a sine wave per
 *  `shapes-pov.md` Part 2 §2, while the other styles hold it at 1.0 so the
 *  dot is the constant. Pure function of project-time so pause freezes the
 *  pulse mid-cycle and the export reproduces it identically. */
export interface PulseState {
  radius: number;
  opacity: number;
  dotOpacity: number;
}

/** Pair of pulse samples. `a` drives `live-marker-pulse`; `b` drives
 *  `live-marker-pulse-b` (the second ring, only animated in the `heartbeat`
 *  style — for `steady` / `throb` / `sonar` the B ring's opacity is held
 *  at 0 so the always-seeded layer renders invisible). */
export interface PulseStatePair {
  a: PulseState;
  b: PulseState;
}

/** Per-frame paint + layout deltas the consumer applies via
 *  `setPaintProperty` / `setLayoutProperty`. Active-state highlights are
 *  expressed as MapLibre `case` expressions so the highlight is data-driven
 *  on the waypoint symbol layers (no layer churn). The pulse values are
 *  scalars meant for the `live-marker-pulse` / `live-marker-pulse-b` circle
 *  layers — `pulseRadiusB` / `pulseOpacityB` carry the second ring that only
 *  the heartbeat style animates; in all other styles the B-ring's opacity
 *  is 0 (visibility-by-opacity, not by
 *  `setLayoutProperty('visibility', ...)`, so the layer is always seeded). */
export interface PaintUpdates {
  /** Waypoint PRIMARY-slot `icon-color`. Three-arm `case` expression:
   *  active-color (when set on `mapSettings.waypoints.active_color` and the
   *  feature is the active one) > per-feature `override_color` > resolved
   *  base (solid hex or gradient interpolate). Applied to
   *  `waypoints-primary.icon-color` per frame via `setPaintProperty`. */
  waypointPrimaryColor: DataDrivenPropertyValueSpecification<string> | string;
  /** Waypoint SECONDARY-slot `icon-color`. Same three-arm shape as
   *  `waypointPrimaryColor` but resolved against `secondary_color` /
   *  `active_secondary_color` / per-feature `override_secondary_color`.
   *  Applied to `waypoints-secondary.icon-color` per frame. */
  waypointSecondaryColor: DataDrivenPropertyValueSpecification<string> | string;
  /** Waypoint `icon-size` (layout, not paint). Scalar when no waypoint is
   *  active; a `case` expression branching on feature `id` when one is —
   *  active feature renders at `active_radius / SHAPE_CANONICAL_RADIUS`,
   *  every other feature at `circle_radius / SHAPE_CANONICAL_RADIUS`.
   *  Applied to BOTH waypoint symbol layers (`waypoints-primary` and
   *  `waypoints-secondary`) per frame via `setLayoutProperty` — they share
   *  the same size so the outline stays aligned with the fill. */
  waypointIconSize: DataDrivenPropertyValueSpecification<number> | number;
  /** `icon-size` for the `waypoints-image` layer (library-image markers).
   *  Same active-bump structure as `waypointIconSize` but bridged through
   *  `MARKER_IMAGE_CANONICAL_SIZE / 2` instead of
   *  `SHAPE_CANONICAL_RADIUS` — the image's longest side displays at the
   *  shape DIAMETER (`2 × circle_radius`), so the one size slider drives
   *  both marker kinds. Note the active-state size bump applies to image
   *  markers too, but the SDF halo does not (it's an icon-halo effect on
   *  the shape slots); the halo circle layer still lights up behind the
   *  image. */
  waypointImageIconSize: DataDrivenPropertyValueSpecification<number> | number;
  /** Active-waypoint halo color. Per [DECIDED] Q1: when
   *  `mapSettings.waypoints.active_color` is set the halo paints that flat
   *  hex; when unset, the halo mirrors the active waypoint's own resolved
   *  primary color (override_color > gradient sample > solid base) via the
   *  same case expression the primary slot uses. Applied to the
   *  `waypoints-active-halo` circle layer's `circle-color`. */
  waypointHaloColor: DataDrivenPropertyValueSpecification<string> | string;
  /** Active-waypoint halo radius. Scalar 0 when there is no active waypoint;
   *  otherwise a `case` expression matching the active feature `id` so only
   *  the active waypoint paints the halo. Applied to
   *  `waypoints-active-halo`'s `circle-radius`. */
  waypointHaloRadius: DataDrivenPropertyValueSpecification<number> | number;
  /** Active-waypoint halo opacity. Scalar 0 when no active waypoint;
   *  otherwise a `case` expression that paints the active feature at
   *  `ACTIVE_HALO_OPACITY` and every other feature at 0. Applied to
   *  `waypoints-active-halo`'s `circle-opacity`. */
  waypointHaloOpacity: DataDrivenPropertyValueSpecification<number> | number;
  /** Per-feature `symbol-sort-key` for the waypoint PRIMARY layer (the
   *  filled silhouette). That layer keeps `icon-allow-overlap: true` so
   *  every fill renders — sort-key only governs draw order. With
   *  `symbol-z-order: 'source'`, higher sort-key paints later (on top), so
   *  the value is the NEGATED distance from the active waypoint:
   *  `-|index - activeIndex|` when a waypoint has been passed (active wins
   *  with sort-key 0; neighbors trail at -1, -2, …); `-index` when no
   *  waypoint has been passed yet (index 0 is the earliest upcoming, so it
   *  paints on top of later ones). */
  waypointSortKey: DataDrivenPropertyValueSpecification<number> | number;
  /** Per-feature `symbol-sort-key` for the SECONDARY (outline) and LABEL
   *  layers. Both layers flip `allow-overlap` off so MapLibre's collision
   *  detection culls back features when their bounding boxes overlap the
   *  front — this is what hides the back waypoint's white outline poking
   *  through the front's fill and the back label appearing on top of the
   *  front's body. With `allow-overlap: false`, LOWER sort-key wins
   *  placement (the closer-to-playhead feature gets placed first; back
   *  features colliding with it are dropped), so the value is the POSITIVE
   *  distance: `|index - activeIndex|` (active = 0 = wins) or `index` (no
   *  active — closest-upcoming wins). Inverse of `waypointSortKey`. */
  waypointPlacementKey: DataDrivenPropertyValueSpecification<number> | number;
  pulseRadius: number;
  pulseOpacity: number;
  pulseRadiusB: number;
  pulseOpacityB: number;
  /** Live-marker dot's `circle-opacity`. Constant 1.0 except in the `throb`
   *  pulse style, which oscillates the dot between 0.35 and 1.0 via a sine
   *  wave per `shapes-pov.md` Part 2 §2. Applied to `live-marker-dot` in
   *  both the preview apply block and the renderer's per-frame paints
   *  array. */
  dotOpacity: number;
}

/** One engine-level group-opacity composite (`map.setGroupComposite` on
 *  both the patched native renderer and the patched preview GL JS — see
 *  `.spike/halo-composite/VERDICT.md`). Each member layer renders into a
 *  shared offscreen target at its own (remapped) paint opacity, then the
 *  flattened result composites over the map ONCE at `opacity` — this is
 *  what stops a self-overlapping halo (route retraces, GPS-jitter
 *  sunbursts) from visibly double-darkening where two translucent coats
 *  would otherwise alpha-blend on top of each other. See
 *  `haloGroupPolicy` in `styleSpec.ts` for the opacity-remap derivation. */
export interface HaloCompositeGroup {
  /** Member style-layer ids, bottom → top (outer band, then core twin). */
  layers: string[];
  /** Composite opacity applied once to the flattened group. */
  opacity: number;
}

/** What `buildStyleSpec` returns to its caller. `style` is either an inline
 *  StyleSpecification (for satellite) or a URL (for default/3d). `defaultPitch`
 *  is the pitch the consumer should apply (`easeTo({pitch})` in preview,
 *  `map.render({pitch})` in export) since pitch isn't a style-spec property. */
export interface StyleSpecResult {
  style: StyleSpecification | string;
  defaultPitch: number;
}

/** Setup-time / static source data, keyed by source id. Values are GeoJSON
 *  ready to hand to `(map.getSource(id) as GeoJSONSource).setData(...)`. */
export interface StaticSourceData {
  'route-full': GeoJSON.Feature<GeoJSON.LineString>;
  waypoints: GeoJSON.FeatureCollection<GeoJSON.Point>;
}

/** A single per-frame snapshot composed by `buildPerFrameState`. The consumer
 *  is responsible for applying it: camera via easeTo/render, source data via
 *  `setData`, paint via `setPaintProperty`. */
export interface PerFrameState {
  camera: ResolvedCamera;
  /** Source ids → GeoJSON. Always includes 'route-trail' and 'live-marker';
   *  additionally includes 'waypoints' when `mapSettings.waypoints_mode ===
   *  'visited'` so the visited-filter is rebuilt per-frame against the
   *  current project-time. */
  sources: Record<string, GeoJSON.GeoJsonObject>;
  paints: PaintUpdates;
  /** Per-frame layout tuples `[layerId, property, value]` — the POV style
   *  layouts (marker-layer visibility swap + icon wiring + halo
   *  visibilities, see `povStyleTuples`) plus the route-trail visibility
   *  trio (see `routeTrailVisibilityTuples`). ALWAYS emitted; equal to
   *  `resolveStaticPaints`' tuples except inside an enabled travel window
   *  (travel-effective POV style; `draw_route`-forced trail). Consumers
   *  apply these AFTER the static layouts (last-write-wins) and should
   *  diff before writing — `setLayoutProperty` on symbol layers can
   *  trigger re-layout, so redundant writes are not free in preview. */
  layouts: Array<[string, string, number | string | ExpressionSpecification]>;
  /** Per-frame POV style PAINT tuples (colors, halo pair, dot sizes —
   *  `povStyleTuples().paints`). Same contract as `layouts`: always
   *  emitted, equals the static resolution outside a travel window, apply
   *  AFTER the static paints (last-write-wins). This is what lets the
   *  traveling playhead wear a different full style during a travel window
   *  (sync = the destination clip's resolved POV look; custom =
   *  `travel.playhead`) and restore automatically at window exit. */
  povPaints: Array<[string, string, unknown]>;
  /** Per-frame halo group-composite config — the same fixed four groups as
   *  `ResolvedStaticPaints.haloComposites`, with the live-marker entry
   *  computed from the travel-effective POV style during a travel window.
   *  Consumers re-assert via `map.setGroupComposite` when it changes
   *  (cheap — one uniform per group). */
  haloComposites: HaloCompositeGroup[];
}
