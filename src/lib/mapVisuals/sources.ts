// Source-data builders. Two flavors:
//
//  - `buildStaticSourceData` is called at setup-time and on `route` /
//    `waypoints` / `mapSettings` changes. Produces the full-route LineString
//    and the full waypoints FeatureCollection. Visited-mode filtering of the
//    waypoints is intentionally *not* done here — that's per-frame because
//    "visited" is a function of project-time.
//
//  - `buildPerFrameSourceData` is called every ease-loop tick (preview) or
//    every export frame. Produces the slime-trail LineString and the
//    live-marker single-point FeatureCollection, plus the visited-filtered
//    waypoints when `mapSettings.waypoints_mode === 'visited'`.
//
// Both builders operate on `project.waypoints: Waypoint[]` (schema v7). The
// pre-v7 clip-derived list lived on `clips` and was rebuilt at render time;
// v7 promotes waypoints to first-class state with their own lifecycle. The
// `index` feature property is the waypoint's position in the
// `project.waypoints` array, regardless of provenance — `'numbered'` label
// mode renders `index + 1` against that.

import type { Clip, MapSettings, Route, Waypoint } from '../../types';
import {
  indexRoute,
  locationAt,
  progressUpTo,
  trailUpTo,
  type IndexedRoute,
  type ResolvedLocation,
} from '../routeLocation';
import type { CompiledTimeline } from '../cameraIntent';
import type { StaticSourceData } from './types';

/** Empty LineString feature, returned when there's no route or no marker. */
function emptyLineFeature(): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: [] },
  };
}

/** Empty FeatureCollection of points, returned when there's no live marker. */
function emptyPointCollection(): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return { type: 'FeatureCollection', features: [] };
}

/** Resolve a `Waypoint`'s map position to lat/lng. Two branches matching
 *  the discriminated `WaypointPosition`:
 *
 *  - `wall_clock_ms` — anchored to the GPX timeline; resolved via
 *    `locationAt(ms, route, fallback)` where the fallback is the waypoint's
 *    own `fallback_gps` (typically the clip's embedded GPS for clip-sourced
 *    entries). Returns null when the route is missing AND no fallback is
 *    set.
 *  - `fixed` — pinned to a literal lat/lng. Always resolves.
 *
 *  Pure. Both preview and renderer call this; nothing here depends on
 *  React or MapLibre. */
export function waypointLocation(
  wp: Waypoint,
  route: IndexedRoute | null,
): ResolvedLocation | null {
  if (wp.position.kind === 'fixed') {
    return { lat: wp.position.lat, lng: wp.position.lng, source: 'fallback' };
  }
  const fallback = wp.position.fallback_gps ?? null;
  return locationAt(wp.position.ms, route, fallback);
}

/** Build the full waypoints FeatureCollection (one Point per waypoint
 *  whose location can be resolved). Properties: `{ id, index, clipId? }`
 *  where `index` is the waypoint's position in the input array — used by
 *  the `waypoints-secondary` layer's `text-field` expression when
 *  `label_mode === 'numbered'`. `clipId` is set when the waypoint was
 *  sourced from a clip; unused by the layer today but available to future
 *  data-driven expressions (e.g. an active-clip highlight). `label` rides
 *  the feature too so `label_mode === 'labeled'` resolves via
 *  `['get', 'label']`.
 *
 *  Visited-mode filtering is *not* applied here — that's a per-frame
 *  concern. */
function buildWaypointsCollection(
  waypoints: Waypoint[],
  indexedRoute: IndexedRoute | null,
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
  waypoints.forEach((wp, index) => {
    const loc = waypointLocation(wp, indexedRoute);
    if (!loc) return;
    // Per-waypoint Mercator-parameterized trail fraction. Consumed by the
    // gradient `interpolate` arm of the waypoint `circle-color` expression
    // in `buildPerFramePaints` — matches the parameterization MapLibre's
    // `line-progress` evaluator uses on the route line, so waypoint dot
    // colors and the line-gradient colors agree at the same fraction.
    // Falls back to 0 for `fixed` waypoints or `wall_clock_ms` waypoints
    // outside the route's covered range — they take the gradient's start
    // color (acceptable since their route position is undefined).
    const progress =
      wp.position.kind === 'wall_clock_ms' && indexedRoute
        ? progressUpTo(wp.position.ms, indexedRoute)
        : 0;
    features.push({
      type: 'Feature',
      properties: {
        id: wp.id,
        index,
        clipId: wp.clip_id ?? null,
        label: wp.label,
        progress,
        // Per-waypoint solid overrides baked into the feature so the
        // primary/secondary color case expressions in `buildPerFramePaints`
        // can read them via `['get', 'override_color']` /
        // `['get', 'override_secondary_color']`. `null` when unset so the
        // guard `['!=', ['get', '...'], null]` falls through to the active
        // / base arms. Must match the visited-mode rebuild below or visited
        // mode silently loses the override.
        override_color: wp.color ?? null,
        override_secondary_color: wp.secondary_color ?? null,
        // Per-waypoint shape override. `null` when unset so the
        // icon-image `coalesce(get(override_shape), projectShape)` in
        // `resolveStaticPaints` falls through to the project default.
        override_shape: wp.shape ?? null,
      },
      geometry: { type: 'Point', coordinates: [loc.lng, loc.lat] },
    });
  });
  return { type: 'FeatureCollection', features };
}

/** Build full-route LineString from a `Route`'s trackpoints. Returns an
 *  empty LineString feature when the route is null or has no trackpoints —
 *  same shape MapView uses today so the consumer can `setData` it
 *  unconditionally. */
function buildFullRouteFeature(
  route: Route | null,
): GeoJSON.Feature<GeoJSON.LineString> {
  if (!route || route.trackpoints.length === 0) return emptyLineFeature();
  const coordinates = route.trackpoints.map(
    (tp) => [tp.lng, tp.lat] as [number, number],
  );
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates },
  };
}

/** Static source data — what the consumer pushes via `setData` on
 *  `route-full` and `waypoints` whenever route/waypoints/mapSettings change.
 *  Pure function of inputs. */
export function buildStaticSourceData(args: {
  route: Route | null;
  waypoints: Waypoint[];
  mapSettings: MapSettings;
}): StaticSourceData {
  const { route, waypoints, mapSettings } = args;
  const indexedRoute = indexRoute(route);
  // `none` hides waypoints entirely; `visited` seeds empty and the per-frame
  // pass fills in only the visited subset; `full` (default) seeds the full
  // collection.
  const wpCollection =
    mapSettings.waypoints.mode === 'none'
      ? emptyPointCollection()
      : buildWaypointsCollection(waypoints, indexedRoute);
  return {
    'route-full': buildFullRouteFeature(route),
    waypoints: wpCollection,
  };
}

/** Trace of the marker's wall-clock anchor — produced by `wallClockTrace`
 *  in perFrame.ts. Re-declared here to avoid a circular import. */
export interface WallClockTrace {
  wallMs: number;
  clipId: string;
}

/** Decide whether a waypoint has been "passed" by the current marker. Only
 *  wall-clock-anchored waypoints participate — fixed-position waypoints
 *  count as always-visible in 'visited' mode and never as "passed" in the
 *  active-waypoint comparison (no route-distance resolution in v1). */
function waypointPassed(wp: Waypoint, markerWallMs: number): boolean {
  if (wp.position.kind === 'wall_clock_ms') {
    return wp.position.ms <= markerWallMs;
  }
  // Fixed waypoints are always considered passed for visited-mode visibility
  // — they exist independent of the route timeline. They're excluded from
  // active-waypoint selection by `pickActiveWaypoint` below.
  return true;
}

/** Pick the active waypoint per the project's `active_waypoint_mode`. Only
 *  the `'latest_passed'` mode selects a non-null id; `'none'` always returns
 *  null. Latest-passed compares wall-clock against `markerTrace.wallMs` and
 *  returns the id of the wall-clock-anchored waypoint with the largest ms
 *  still ≤ the marker. Fixed waypoints never participate. */
export function pickActiveWaypoint(
  waypoints: Waypoint[],
  markerTrace: WallClockTrace | null,
  mapSettings: MapSettings,
): string | null {
  if (mapSettings.waypoints.active_mode !== 'latest_passed') return null;
  if (!markerTrace) return null;
  const marker = markerTrace.wallMs;
  let bestId: string | null = null;
  let bestMs = -Infinity;
  for (const wp of waypoints) {
    if (wp.position.kind !== 'wall_clock_ms') continue;
    const ms = wp.position.ms;
    if (ms > marker) continue;
    if (ms > bestMs) {
      bestMs = ms;
      bestId = wp.id;
    }
  }
  return bestId;
}

/** Per-frame source data. Always returns `route-trail` and `live-marker`;
 *  conditionally includes `waypoints` (visited-filtered) when
 *  `mapSettings.waypoints_mode === 'visited'`.
 *
 *  Visited predicate (v7): a wall-clock-anchored waypoint is visible once
 *  the marker's wall-clock reaches its anchor; a fixed-position waypoint is
 *  always visible in 'visited' mode. The pre-v7 predicate compared against
 *  the compiled `ClipSpan.startMs`, which doesn't generalize to waypoints
 *  decoupled from clips. */
export function buildPerFrameSourceData(args: {
  markerTrace: WallClockTrace | null;
  indexedRoute: IndexedRoute | null;
  clips: Clip[];
  waypoints: Waypoint[];
  mapSettings: MapSettings;
  timeline: CompiledTimeline;
  projectTimeMs: number | null;
}): Record<string, GeoJSON.GeoJsonObject> {
  const {
    markerTrace,
    indexedRoute,
    clips,
    waypoints,
    mapSettings,
  } = args;

  // ---- route-trail ----
  // Empty unless we're in visited mode AND we have a marker AND a route.
  // `trailUpTo` is the same pure helper the rest of the app uses so the
  // export gets pixel-identical trail geometry.
  let trailFeature: GeoJSON.Feature<GeoJSON.LineString>;
  if (
    mapSettings.route.mode === 'visited' &&
    markerTrace &&
    indexedRoute
  ) {
    trailFeature = trailUpTo(markerTrace.wallMs, indexedRoute);
  } else {
    trailFeature = emptyLineFeature();
  }

  // ---- live-marker ----
  // Single-point FeatureCollection at the resolved location, or empty when
  // no marker resolves. Mirrors the DOM-marker fallback chain pre-refactor:
  // GPX position with the active clip's embedded `gps` as a fallback for
  // out-of-range / large-gap regions of the route.
  let liveMarker: GeoJSON.FeatureCollection<GeoJSON.Point>;
  if (markerTrace) {
    const fallbackClip = clips.find((c) => c.id === markerTrace.clipId) ?? null;
    const fallback = fallbackClip?.gps ?? null;
    const resolved = locationAt(markerTrace.wallMs, indexedRoute, fallback);
    if (resolved) {
      liveMarker = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { clipId: markerTrace.clipId },
            geometry: {
              type: 'Point',
              coordinates: [resolved.lng, resolved.lat],
            },
          },
        ],
      };
    } else {
      liveMarker = emptyPointCollection();
    }
  } else {
    liveMarker = emptyPointCollection();
  }

  const out: Record<string, GeoJSON.GeoJsonObject> = {
    'route-trail': trailFeature,
    'live-marker': liveMarker,
  };

  // ---- waypoints (visited mode only) ----
  // 'visited': a waypoint is included once the marker has reached its
  // anchor (wall-clock-anchored waypoints) or unconditionally (fixed
  // waypoints — see `waypointPassed`). Wall-clock-only filtering replaces
  // the pre-v7 `ClipSpan.startMs` predicate, which doesn't apply to
  // waypoints decoupled from clips.
  if (mapSettings.waypoints.mode === 'visited') {
    const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
    if (markerTrace) {
      waypoints.forEach((wp, index) => {
        const loc = waypointLocation(wp, indexedRoute);
        if (!loc) return;
        if (!waypointPassed(wp, markerTrace.wallMs)) return;
        // Mirror the static-build path so the gradient/override expressions
        // resolve identically whether the waypoint flows through the full
        // collection or the visited subset.
        const progress =
          wp.position.kind === 'wall_clock_ms' && indexedRoute
            ? progressUpTo(wp.position.ms, indexedRoute)
            : 0;
        features.push({
          type: 'Feature',
          properties: {
            id: wp.id,
            index,
            clipId: wp.clip_id ?? null,
            label: wp.label,
            progress,
            override_color: wp.color ?? null,
            override_shape: wp.shape ?? null,
          },
          geometry: { type: 'Point', coordinates: [loc.lng, loc.lat] },
        });
      });
    }
    const waypointsCollection: GeoJSON.FeatureCollection<GeoJSON.Point> = {
      type: 'FeatureCollection',
      features,
    };
    out.waypoints = waypointsCollection;
  }

  return out;
}
