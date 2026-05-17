// Source-data builders. Two flavors:
//
//  - `buildStaticSourceData` is called at setup-time and on `route` /
//    `clips` / `mapSettings` changes. Produces the full-route LineString and
//    the full waypoints FeatureCollection. Visited-mode filtering of the
//    waypoints is intentionally *not* done here — that's per-frame because
//    "visited" is a function of project-time.
//
//  - `buildPerFrameSourceData` is called every ease-loop tick (preview) or
//    every export frame. Produces the slime-trail LineString and the
//    live-marker single-point FeatureCollection, plus the visited-filtered
//    waypoints when `mapSettings.waypoints_mode === 'visited'`.

import type { Clip, Route, MapSettings } from '../../types';
import {
  indexRoute,
  locationAt,
  trailUpTo,
  clipWaypointLocation,
  type IndexedRoute,
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

/** Build the full waypoints FeatureCollection (one Point per clip whose
 *  location can be resolved). Properties: `{ id, index }` where `index` is
 *  the clip's original position in the input array — used by the
 *  `waypoints-label` layer's `text-field` expression `['+', ['get', 'index'],
 *  1]` to render 1-based ordinals.
 *
 *  Visited-mode filtering is *not* applied here — that's a per-frame
 *  concern. This function returns every clip that has a resolvable
 *  position, and `buildPerFrameSourceData` filters by project-time when
 *  `waypoints_mode === 'visited'`. */
function buildWaypointsCollection(
  clips: Clip[],
  indexedRoute: IndexedRoute | null,
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
  clips.forEach((clip, index) => {
    const loc = clipWaypointLocation(clip, indexedRoute);
    if (!loc) return;
    features.push({
      type: 'Feature',
      properties: { id: clip.id, index },
      geometry: { type: 'Point', coordinates: [loc.lng, loc.lat] },
    });
  });
  return { type: 'FeatureCollection', features };
}

/** Static source data — what the consumer pushes via `setData` on
 *  `route-full` and `waypoints` whenever route/clips/mapSettings change.
 *  Pure function of inputs. Builds the IndexedRoute internally via
 *  `indexRoute(route)` (also pure). */
export function buildStaticSourceData(args: {
  route: Route | null;
  clips: Clip[];
  mapSettings: MapSettings;
}): StaticSourceData {
  const { route, clips, mapSettings } = args;
  const indexedRoute = indexRoute(route);
  // `none` hides waypoints entirely; `visited` seeds empty and the per-frame
  // pass fills in only the visited subset; `all` (default) seeds the full
  // collection.
  const waypoints =
    mapSettings.waypoints_mode === 'none'
      ? emptyPointCollection()
      : buildWaypointsCollection(clips, indexedRoute);
  return {
    'route-full': buildFullRouteFeature(route),
    waypoints,
  };
}

/** Trace of the marker's wall-clock anchor — produced by `wallClockTrace`
 *  in perFrame.ts. Re-declared here to avoid a circular import. */
export interface WallClockTrace {
  wallMs: number;
  clipId: string;
}

/** Per-frame source data. Always returns `route-trail` and `live-marker`;
 *  conditionally includes `waypoints` (visited-filtered) when
 *  `mapSettings.waypoints_mode === 'visited'`.
 *
 *  Filtering predicate for visited waypoints mirrors MapView.tsx pre-
 *  refactor: a clip is visible if its compiled `ClipSpan.startMs <=
 *  projectTimeMs`. Clips without a span (filtered out by the compiler) are
 *  excluded outright. */
export function buildPerFrameSourceData(args: {
  markerTrace: WallClockTrace | null;
  indexedRoute: IndexedRoute | null;
  clips: Clip[];
  mapSettings: MapSettings;
  timeline: CompiledTimeline;
  projectTimeMs: number | null;
}): Record<string, GeoJSON.GeoJsonObject> {
  const {
    markerTrace,
    indexedRoute,
    clips,
    mapSettings,
    timeline,
    projectTimeMs,
  } = args;

  // ---- route-trail ----
  // Empty unless we're in visited mode AND we have a marker AND a route.
  // `trailUpTo` is the same pure helper the rest of the app uses so the
  // export gets pixel-identical trail geometry.
  let trailFeature: GeoJSON.Feature<GeoJSON.LineString>;
  if (
    mapSettings.route_mode === 'visited' &&
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
  // 'visited': a clip counts as visible once project-time has crossed into
  // its compiled span. Mirrors MapView.tsx:495–509 — the predicate to
  // *include* is `span.startMs <= projectTimeMs`, equivalent to "*exclude*
  // when `span.startMs > projectTimeMs`."
  if (mapSettings.waypoints_mode === 'visited') {
    const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
    if (projectTimeMs != null) {
      clips.forEach((clip, index) => {
        const loc = clipWaypointLocation(clip, indexedRoute);
        if (!loc) return;
        const span = timeline.clipSpans.find((s) => s.clipId === clip.id);
        if (!span || span.startMs > projectTimeMs) return;
        features.push({
          type: 'Feature',
          properties: { id: clip.id, index },
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
