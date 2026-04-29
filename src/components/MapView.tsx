import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Clip, Route, MapSettings, MapStyleId } from '../types';
import { colors } from '../theme/tokens';
import {
  indexRoute,
  locationAt,
  trailUpTo,
  clipWaypointLocation,
  parseTimestamp,
  type IndexedRoute,
  type ResolvedLocation,
} from '../lib/routeLocation';
import {
  cameraAt,
  resolveIntent,
  type MapTrack,
  type Viewport,
} from '../lib/cameraIntent';
import type { MapRecorder } from '../hooks/useMapRecorder';

interface MapViewProps {
  /** Pure timeline of camera anchors built upstream by `buildMapTrack`. The
   *  imperative writers in this file still drive the camera today; tasks
   *  310-320 will replace them with a single ease loop that consumes this. */
  track: MapTrack;
  clips: Clip[];
  selectedClipId: string | null;
  route: Route | null;
  /** Wall-clock playback time in ms (clip start + media time). null when no
   *  clip is selected or its created_at is missing. */
  playheadMs: number | null;
  mapSettings: MapSettings;
  /** Effective bearing the map should face, in degrees [0, 360). Resolved
   *  upstream in ProjectView from `bearing_mode`/`bearing_degrees` and the
   *  live GPX heading. */
  mapBearing: number;
  onSelectClip?: (clipId: string) => void;
  recorder?: MapRecorder;
}

const TRAIL_COLOR = colors.accent;
const FULL_ROUTE_COLOR = colors.accent;

const DEFAULT_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

const SATELLITE_STYLE: maplibregl.StyleSpecification = {
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

function styleForId(id: MapStyleId): string | maplibregl.StyleSpecification {
  if (id === 'satellite') return SATELLITE_STYLE;
  // 'default' and '3d' both use the OpenFreeMap liberty vector style;
  // 3D adds fill-extrusion + pitch on top after style.load.
  return DEFAULT_STYLE_URL;
}

function add3DBuildings(map: maplibregl.Map) {
  if (map.getLayer('3d-buildings')) return;
  // The OpenFreeMap liberty style exposes building polygons under the
  // "openmaptiles" vector source, source-layer "building".
  if (!map.getSource('openmaptiles')) return;
  try {
    map.addLayer({
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
    });
  } catch {
    // building layer not available in this style — ignore
  }
}
const LIVE_MARKER_PULSE_KEYFRAMES = `
@keyframes trailcut-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(255, 107, 53, 0.55); }
  70%  { box-shadow: 0 0 0 14px rgba(255, 107, 53, 0); }
  100% { box-shadow: 0 0 0 0 rgba(255, 107, 53, 0); }
}
`;

export default function MapView({
  track,
  clips,
  selectedClipId,
  route,
  playheadMs,
  mapSettings,
  mapBearing,
  onSelectClip,
  recorder,
}: MapViewProps) {
  const recorderRef = useRef<MapRecorder | undefined>(recorder);
  recorderRef.current = recorder;
  const onSelectClipRef = useRef(onSelectClip);
  onSelectClipRef.current = onSelectClip;
  const mapBearingRef = useRef(mapBearing);
  mapBearingRef.current = mapBearing;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const styleReadyRef = useRef(false);
  const [styleVersion, setStyleVersion] = useState(0);
  const mapStyleId = mapSettings.map_style;
  const mapStyleIdRef = useRef(mapStyleId);
  mapStyleIdRef.current = mapStyleId;

  const liveMarkerRef = useRef<maplibregl.Marker | null>(null);
  const liveMarkerElRef = useRef<HTMLDivElement | null>(null);
  // Tracks the last route reference we framed via the region-intent jumpTo
  // below. Idempotence guard: we only refit once per unique route.
  const appliedRouteRef = useRef<Route | null>(null);

  const indexedRoute: IndexedRoute | null = useMemo(() => indexRoute(route), [route]);

  // Effective wall-clock time the ease loop should target. When the video is
  // playing this mirrors the playhead. When no playhead has fired yet (e.g.
  // right after project load or a clip selection), fall back to the selected
  // clip's start so the first ease-loop tick targets the user's intent rather
  // than the previous clip's last frame.
  const currentTimeMs = useMemo<number | null>(() => {
    if (playheadMs != null) return playheadMs;
    if (!selectedClipId) return null;
    const clip = clips.find((c) => c.id === selectedClipId);
    if (!clip?.created_at) return null;
    const base = parseTimestamp(clip.created_at);
    if (Number.isNaN(base)) return null;
    return base + (clip.trim?.in_ms ?? 0);
  }, [playheadMs, clips, selectedClipId]);
  const currentTimeMsRef = useRef(currentTimeMs);
  currentTimeMsRef.current = currentTimeMs;

  // ---- Initialize map ----
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleForId(mapStyleIdRef.current),
      center: [-122.4194, 37.7749],
      zoom: 10,
      bearing: mapBearingRef.current,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }));

    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);
    mapRef.current = map;

    recorderRef.current?.registerFrameSampler(() => {
      const c = map.getCenter();
      return {
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
        lng: c.lng,
        lat: c.lat,
        isMoving: map.isMoving(),
      };
    });

    const onStyleLoad = () => {
      styleReadyRef.current = true;
      if (mapStyleIdRef.current === '3d') {
        add3DBuildings(map);
      }
      // Pre-create the two route sources/layers so we can update their data
      // dynamically without re-adding layers each time.
      if (!map.getSource('route-full')) {
        map.addSource('route-full', {
          type: 'geojson',
          data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } },
        });
        map.addLayer({
          id: 'route-full-line',
          type: 'line',
          source: 'route-full',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': FULL_ROUTE_COLOR,
            'line-width': 3,
            'line-opacity': 0.8,
          },
        });
      }
      if (!map.getSource('route-trail')) {
        map.addSource('route-trail', {
          type: 'geojson',
          data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } },
        });
        map.addLayer({
          id: 'route-trail-line',
          type: 'line',
          source: 'route-trail',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': TRAIL_COLOR,
            'line-width': 4,
            'line-opacity': 0.95,
          },
        });
      }
      if (!map.getSource('waypoints')) {
        map.addSource('waypoints', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        map.addLayer({
          id: 'waypoints-circle',
          type: 'circle',
          source: 'waypoints',
          paint: {
            'circle-radius': 11,
            'circle-color': colors.accent,
            'circle-stroke-width': 2,
            'circle-stroke-color': 'rgba(255,255,255,0.85)',
          },
        });
        map.addLayer({
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
        });

      }
      // Trigger data effects to re-seed sources after a (re)style.
      setStyleVersion((v) => v + 1);
    };
    map.on('style.load', onStyleLoad);

    // Register layer event listeners once — they resolve the layer by name
    // at dispatch time, so they survive setStyle().
    map.on('click', 'waypoints-circle', (e) => {
      const f = e.features?.[0];
      const id = f?.properties?.id;
      if (typeof id === 'string') onSelectClipRef.current?.(id);
    });
    map.on('mouseenter', 'waypoints-circle', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'waypoints-circle', () => {
      map.getCanvas().style.cursor = '';
    });

    return () => {
      recorderRef.current?.registerFrameSampler(null);
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
      styleReadyRef.current = false;
      liveMarkerRef.current = null;
      liveMarkerElRef.current = null;
    };
  }, []);

  // ---- Switch base map style ----
  const lastAppliedStyleRef = useRef<MapStyleId>(mapStyleId);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (lastAppliedStyleRef.current === mapStyleId) {
      // First mount: style was set in the constructor; just sync pitch.
      map.easeTo({ pitch: mapStyleId === '3d' ? 60 : 0, duration: 0 });
      return;
    }
    lastAppliedStyleRef.current = mapStyleId;
    styleReadyRef.current = false;
    map.setStyle(styleForId(mapStyleId));
    map.easeTo({ pitch: mapStyleId === '3d' ? 60 : 0, duration: 400 });
  }, [mapStyleId]);

  // ---- Update full-route line + region-intent fit when route changes ----
  // On a new route, frame the full bounds via a `region` CameraIntent resolved
  // through the same pipeline the ease loop uses (§6.3 step 3). jumpTo (not
  // easeTo) is intentional: the initial fit has no continuity to preserve,
  // and the §3.5 ease loop picks up smoothly from this state on the next
  // tick once anchors exist. Padding 0.06 matches the follow-anchor default
  // (§3.2) — at a typical map pane this is comparable to today's 60 px inset.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const apply = () => {
      const src = map.getSource('route-full') as maplibregl.GeoJSONSource | undefined;
      if (!src) return;

      if (!route || route.trackpoints.length === 0) {
        src.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } });
        return;
      }
      const coordinates = route.trackpoints.map((tp) => [tp.lng, tp.lat] as [number, number]);
      src.setData({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates },
      });

      if (appliedRouteRef.current !== route) {
        appliedRouteRef.current = route;
        let minLng = Infinity;
        let minLat = Infinity;
        let maxLng = -Infinity;
        let maxLat = -Infinity;
        for (const tp of route.trackpoints) {
          if (tp.lng < minLng) minLng = tp.lng;
          if (tp.lng > maxLng) maxLng = tp.lng;
          if (tp.lat < minLat) minLat = tp.lat;
          if (tp.lat > maxLat) maxLat = tp.lat;
        }
        // Skip degenerate routes (single point or zero extent on either axis)
        // — `cameraForBounds` would return -Infinity zoom on a zero span.
        if (Number.isFinite(minLng) && maxLng > minLng && maxLat > minLat) {
          const viewport: Viewport = {
            width: map.getContainer().clientWidth,
            height: map.getContainer().clientHeight,
            dpr: window.devicePixelRatio,
          };
          const target = resolveIntent(
            {
              kind: 'region',
              bounds: {
                sw: { lng: minLng, lat: minLat },
                ne: { lng: maxLng, lat: maxLat },
              },
              padding: 0.06,
              bearing: 0,
              pitch: 0,
            },
            viewport,
          );
          map.jumpTo({
            center: [target.center.lng, target.center.lat],
            zoom: target.zoom,
            bearing: target.bearing,
            pitch: target.pitch,
          });
        }
      }
    };

    if (styleReadyRef.current) apply();
  }, [route, styleVersion]);

  // ---- Update route-line visibility based on route_mode ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      if (!map.getLayer('route-full-line')) return;
      map.setLayoutProperty(
        'route-full-line',
        'visibility',
        mapSettings.route_mode === 'full' ? 'visible' : 'none',
      );
      if (map.getLayer('route-trail-line')) {
        map.setLayoutProperty(
          'route-trail-line',
          'visibility',
          mapSettings.route_mode === 'visited' ? 'visible' : 'none',
        );
      }
    };
    if (styleReadyRef.current) apply();
  }, [mapSettings.route_mode, styleVersion]);

  // Compute the set of visible waypoints. Memoized so effect deps are stable.
  const positionedWaypoints = useMemo(() => {
    if (mapSettings.waypoints_mode === 'none') return [];
    return clips
      .map((clip, originalIndex) => {
        const loc = clipWaypointLocation(clip, indexedRoute);
        if (!loc) return null;
        if (mapSettings.waypoints_mode === 'visited') {
          if (playheadMs == null) return null;
          const startMs = parseTimestamp(clip.created_at);
          if (Number.isNaN(startMs) || startMs > playheadMs) return null;
        }
        return { clip, originalIndex, loc };
      })
      .filter((x): x is { clip: Clip; originalIndex: number; loc: ResolvedLocation } => x !== null);
  }, [clips, indexedRoute, mapSettings.waypoints_mode, playheadMs]);

  // ---- Waypoint source data (one feature per visible clip) ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource('waypoints') as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      src.setData({
        type: 'FeatureCollection',
        features: positionedWaypoints.map(({ clip, originalIndex, loc }) => ({
          type: 'Feature',
          properties: { id: clip.id, index: originalIndex },
          geometry: { type: 'Point', coordinates: [loc.lng, loc.lat] },
        })),
      });
    };
    if (styleReadyRef.current) apply();
  }, [positionedWaypoints, styleVersion]);

  // ---- Waypoint selection styling (data-driven, no re-render) ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      if (!map.getLayer('waypoints-circle')) return;
      const selected: unknown = selectedClipId ?? '';
      map.setPaintProperty('waypoints-circle', 'circle-radius', [
        'case', ['==', ['get', 'id'], selected], 14, 11,
      ]);
      map.setPaintProperty('waypoints-circle', 'circle-color', [
        'case', ['==', ['get', 'id'], selected], '#4a9eff', colors.accent,
      ]);
      map.setPaintProperty('waypoints-circle', 'circle-stroke-color', [
        'case', ['==', ['get', 'id'], selected], '#ffffff', 'rgba(255,255,255,0.85)',
      ]);
    };
    if (styleReadyRef.current) apply();
  }, [selectedClipId, styleVersion]);

  // ---- Live preview ease loop (replaces Writers 1, 4, 5, 6) ----
  // Per §3.5: every STEP_MS we compute target = cameraAt(track, t + lookahead)
  // and fire map.easeTo at the same duration. MapLibre keeps chasing a moving
  // target — clip-to-clip handoff, bearing rotation, and within-clip tracking
  // all collapse into this one loop. The pure cameraAt + resolveIntent
  // pipeline is the single source of truth for camera state.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const LOOKAHEAD_MS = 100;
    const STEP_MS = 50;

    let timeoutId = 0;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      // No anchors → don't push the camera. The route region-fit jumpTo and
      // the constructor's initial framing remain authoritative until clips
      // with timestamps exist.
      if (track.anchors.length === 0) {
        timeoutId = window.setTimeout(tick, STEP_MS);
        return;
      }
      const t = currentTimeMsRef.current ?? track.anchors[0].timeMs;
      const intent = cameraAt(track, t + LOOKAHEAD_MS);
      const viewport: Viewport = {
        width: map.getContainer().clientWidth,
        height: map.getContainer().clientHeight,
        dpr: window.devicePixelRatio,
      };
      const target = resolveIntent(intent, viewport);
      map.easeTo({
        center: [target.center.lng, target.center.lat],
        zoom: target.zoom,
        bearing: target.bearing,
        pitch: target.pitch,
        duration: STEP_MS,
        essential: true,
      });
      timeoutId = window.setTimeout(tick, STEP_MS);
    };

    tick();
    return () => {
      stopped = true;
      window.clearTimeout(timeoutId);
    };
  }, [track]);

  // ---- Live playhead marker ----
  // Marker DOM management only. Position derives from the same routeLocation
  // pipeline the camera reads, so the marker stays anchored to the resolved
  // GPX location while the ease loop above handles the camera itself.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null;
    const fallback = selectedClip?.gps ?? null;
    const resolved =
      playheadMs != null ? locationAt(playheadMs, indexedRoute, fallback) : null;

    if (!resolved) {
      if (liveMarkerRef.current) {
        liveMarkerRef.current.remove();
        liveMarkerRef.current = null;
        liveMarkerElRef.current = null;
      }
      return;
    }

    if (!liveMarkerRef.current) {
      const el = document.createElement('div');
      el.style.width = '18px';
      el.style.height = '18px';
      el.style.borderRadius = '50%';
      el.style.backgroundColor = '#fff';
      el.style.border = `3px solid ${colors.accent}`;
      el.style.boxShadow = '0 0 0 2px rgba(0,0,0,0.35), 0 2px 6px rgba(0,0,0,0.5)';
      el.style.animation = 'trailcut-pulse 1.6s ease-out infinite';
      el.style.pointerEvents = 'none';
      liveMarkerElRef.current = el;
      liveMarkerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat([resolved.lng, resolved.lat])
        .addTo(map);
    } else {
      liveMarkerRef.current.setLngLat([resolved.lng, resolved.lat]);
    }
  }, [playheadMs, indexedRoute, clips, selectedClipId]);

  // ---- Slime trail data updates ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource('route-trail') as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      if (!indexedRoute || mapSettings.route_mode !== 'visited' || playheadMs == null) {
        src.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } });
        return;
      }
      src.setData(trailUpTo(playheadMs, indexedRoute));
    };
    if (styleReadyRef.current) apply();
  }, [playheadMs, indexedRoute, mapSettings.route_mode, styleVersion]);

  return (
    <>
      <style>{LIVE_MARKER_PULSE_KEYFRAMES}</style>
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          minHeight: '300px',
        }}
      />
    </>
  );
}
