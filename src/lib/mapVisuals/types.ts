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

/** Pulse animation sample at a given project-time. Drives the outer ring of
 *  the live-marker layer pair: `radius` → `circle-radius`,
 *  `opacity` → `circle-opacity`. Pure function of project-time so pause
 *  freezes the pulse mid-cycle and the export reproduces it identically. */
export interface PulseState {
  radius: number;
  opacity: number;
}

/** Per-frame paint deltas the consumer applies via `setPaintProperty`. The
 *  active-clip highlight is expressed as MapLibre `case` expressions so the
 *  highlight is data-driven on the waypoints layer (no layer churn). The
 *  pulse values are scalars meant for the `live-marker-pulse` circle layer. */
export interface PaintUpdates {
  waypointCircleRadius: DataDrivenPropertyValueSpecification<number> | number;
  waypointCircleColor: DataDrivenPropertyValueSpecification<string> | string;
  waypointCircleStrokeColor:
    | DataDrivenPropertyValueSpecification<string> | string;
  pulseRadius: number;
  pulseOpacity: number;
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
