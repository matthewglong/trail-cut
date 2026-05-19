// Public types for the shared mapVisuals module. The module is the single
// source of visual truth for both the preview map (`MapView.tsx`) and the
// Node-based export renderer worker. These interfaces describe the values
// flowing between the pure builders and their consumers — nothing here
// depends on a runtime maplibre instance, React, or the DOM.

import type {
  StyleSpecification,
  DataDrivenPropertyValueSpecification,
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

/** Per-frame paint deltas the consumer applies via `setPaintProperty`. The
 *  active-clip highlight is expressed as MapLibre `case` expressions so the
 *  highlight is data-driven on the waypoints layer (no layer churn). The
 *  pulse values are scalars meant for the `live-marker-pulse` /
 *  `live-marker-pulse-b` circle layers — `pulseRadiusB` / `pulseOpacityB`
 *  carry the second ring that only the heartbeat style animates; in all
 *  other styles the B-ring's opacity is 0 (visibility-by-opacity, not by
 *  `setLayoutProperty('visibility', ...)`, so the layer is always seeded). */
export interface PaintUpdates {
  waypointCircleRadius: DataDrivenPropertyValueSpecification<number> | number;
  waypointCircleColor: DataDrivenPropertyValueSpecification<string> | string;
  waypointCircleStrokeColor:
    | DataDrivenPropertyValueSpecification<string> | string;
  /** Waypoint symbol-layer `icon-color`. SDF icons are tinted by this
   *  paint property; the value is the SAME `case` expression used for
   *  `waypointCircleColor` (override_color > base) so symbol-family shapes
   *  (pin, square, diamond) and circle-family shapes (circle, ring,
   *  numbered-circle) paint with bit-identical color logic — gradient
   *  stops, per-`Waypoint.color` overrides, and the active-waypoint
   *  highlight all apply uniformly. Applied to `waypoints-symbol`'s
   *  `icon-color` per frame. */
  waypointIconColor: DataDrivenPropertyValueSpecification<string> | string;
  /** Active-waypoint halo color. Per [DECIDED] Q1: when
   *  `mapSettings.waypoints.active_color` is set the halo paints that flat
   *  hex; when unset, the halo mirrors the active waypoint's own resolved
   *  color (override_color > gradient sample > solid base) via the same
   *  case expression the dot uses. Applied to the
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
}
