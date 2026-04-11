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
} from '../lib/routeLocation';

interface MapViewProps {
  clips: Clip[];
  selectedClipId: string | null;
  route: Route | null;
  /** Wall-clock playback time in ms (clip start + media time). null when no
   *  clip is selected or its created_at is missing. */
  playheadMs: number | null;
  mapSettings: MapSettings;
  onSelectClip?: (clipId: string) => void;
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

// ---- Clip-transition camera animation ----
// When switching between clips, if the destination waypoint is outside the
// current viewport, arc the camera out to a zoom level that fits both the
// current and next points, then back in to the target — a single Van Wijk
// flyTo with minZoom pinning the peak. Duration scales with the sum of the
// zoom work (out + in) so short hops stay snappy and long jumps get room to
// breathe. Within-clip tracking uses a separate 220 ms easeTo and is not
// affected.
interface MapTransitionConfig {
  baseMs: number;           // floor duration when zoomSum = 0
  msPerZoomLevel: number;   // added per zoom level of work (out + in)
  minDurationMs: number;    // clamp floor
  maxDurationMs: number;    // clamp ceiling
  fitPaddingPx: number;     // padding for cameraForBounds when computing peak
  curve: number;            // flyTo arc aggressiveness
}

const DEFAULT_MAP_TRANSITION: MapTransitionConfig = {
  baseMs: 1100,
  msPerZoomLevel: 580,
  minDurationMs: 1100,
  maxDurationMs: 7000,
  fitPaddingPx: 80,
  curve: 1.42,
};

function runClipTransition(
  map: maplibregl.Map,
  start: { lng: number; lat: number },
  end: { lng: number; lat: number },
  startZoom: number,
  targetZoom: number,
  cfg: MapTransitionConfig = DEFAULT_MAP_TRANSITION,
): void {
  const endLngLat: [number, number] = [end.lng, end.lat];
  const clampDuration = (raw: number) =>
    Math.max(cfg.minDurationMs, Math.min(cfg.maxDurationMs, raw));

  // Fast path: target already inside the current viewport → flat ease, no arc.
  if (map.getBounds().contains(endLngLat)) {
    const duration = clampDuration(
      cfg.baseMs + Math.abs(targetZoom - startZoom) * cfg.msPerZoomLevel,
    );
    map.easeTo({ center: endLngLat, zoom: targetZoom, duration, essential: true });
    return;
  }

  // Compute the zoom level that fits both points with padding.
  const fitBounds = new maplibregl.LngLatBounds()
    .extend([start.lng, start.lat])
    .extend(endLngLat);
  const cam = map.cameraForBounds(fitBounds, { padding: cfg.fitPaddingPx });
  const boundsZoom =
    cam && typeof cam.zoom === 'number' ? cam.zoom : Math.min(startZoom, targetZoom);

  // Only zoom out as far as needed — never below what fits both points.
  const peakZoom = Math.min(startZoom, targetZoom, boundsZoom);

  const zoomOut = Math.max(0, startZoom - peakZoom);
  const zoomIn = Math.max(0, targetZoom - peakZoom);
  const zoomSum = zoomOut + zoomIn;

  const duration = clampDuration(cfg.baseMs + zoomSum * cfg.msPerZoomLevel);

  map.flyTo({
    center: endLngLat,
    zoom: targetZoom,
    minZoom: peakZoom, // pins the peak of the Van Wijk arc
    duration,
    curve: cfg.curve,
    essential: true,
  });
}

export default function MapView({
  clips,
  selectedClipId,
  route,
  playheadMs,
  mapSettings,
  onSelectClip,
}: MapViewProps) {
  const onSelectClipRef = useRef(onSelectClip);
  onSelectClipRef.current = onSelectClip;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const styleReadyRef = useRef(false);
  const [styleVersion, setStyleVersion] = useState(0);
  const mapStyleId = mapSettings.map_style;
  const mapStyleIdRef = useRef(mapStyleId);
  mapStyleIdRef.current = mapStyleId;

  const liveMarkerRef = useRef<maplibregl.Marker | null>(null);
  const liveMarkerElRef = useRef<HTMLDivElement | null>(null);
  const lastFitRouteRef = useRef<Route | null>(null);
  const lastFollowAtRef = useRef<number>(0);
  const lastFollowedClipRef = useRef<string | null>(null);
  const prevZoomRef = useRef<number>(mapSettings.zoom);

  const indexedRoute: IndexedRoute | null = useMemo(() => indexRoute(route), [route]);
  const routeLoaded = indexedRoute !== null;

  // ---- Initialize map ----
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleForId(mapStyleIdRef.current),
      center: [-122.4194, 37.7749],
      zoom: 10,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }));

    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);
    mapRef.current = map;

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

  // ---- Update full-route line + fit bounds when route changes ----
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

      if (lastFitRouteRef.current !== route) {
        lastFitRouteRef.current = route;
        const bounds = new maplibregl.LngLatBounds();
        coordinates.forEach((c) => bounds.extend(c));
        map.fitBounds(bounds, { padding: 60, duration: 0 });
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
      .filter((x): x is { clip: Clip; originalIndex: number; loc: { lat: number; lng: number } } => x !== null);
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

  // ---- Live zoom updates from the toolbar ----
  // When the user changes the zoom stepper, snap to the new zoom immediately
  // without waiting for a clip transition. Uses setZoom (instant) rather than
  // easeTo because in clip scope the stepper triggers a setClips update, which
  // re-fires the playhead marker effect below — its center-only easeTo would
  // otherwise cancel an in-flight zoom animation and leave the zoom stuck.
  // Skips the mount render so the initial DEFAULT_MAP_SETTINGS value doesn't
  // fight the route fitBounds.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (prevZoomRef.current === mapSettings.zoom) return;
    prevZoomRef.current = mapSettings.zoom;
    map.setZoom(mapSettings.zoom);
  }, [mapSettings.zoom]);

  // ---- Fly to selected clip's waypoint on manual selection change ----
  // Only runs when follow is OFF — when following, the playhead effect below
  // handles camera movement (including a longer ease on clip transitions).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedClipId) return;
    if (mapSettings.follow_playhead) return;
    const clip = clips.find((c) => c.id === selectedClipId);
    if (!clip) return;
    const loc = clipWaypointLocation(clip, indexedRoute);
    if (!loc) return;
    const startCenter = map.getCenter();
    runClipTransition(
      map,
      { lng: startCenter.lng, lat: startCenter.lat },
      { lng: loc.lng, lat: loc.lat },
      map.getZoom(),
      mapSettings.zoom,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClipId]);

  // ---- Live playhead marker ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Resolve current location
    const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null;
    const fallback = selectedClip?.gps ?? null;
    const resolved =
      playheadMs != null ? locationAt(playheadMs, indexedRoute, fallback) : null;

    // Hide marker if nothing to show
    if (!resolved) {
      if (liveMarkerRef.current) {
        liveMarkerRef.current.remove();
        liveMarkerRef.current = null;
        liveMarkerElRef.current = null;
      }
      return;
    }

    // Lazy-create marker element
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

    // Follow playhead. On clip boundary crossings (selection change) do a
    // longer ease so it reads as a deliberate transition between clips;
    // within a single clip, throttle to ~10Hz for smooth tracking.
    if (mapSettings.follow_playhead) {
      const selectionChanged = lastFollowedClipRef.current !== selectedClipId;
      lastFollowedClipRef.current = selectedClipId;
      if (selectionChanged) {
        // Target the clip's waypoint location (GPX-snapped) rather than the
        // current playhead, which may not have caught up to the seek yet.
        const wp = selectedClip ? clipWaypointLocation(selectedClip, indexedRoute) : null;
        const target = wp ?? resolved;
        lastFollowAtRef.current = performance.now();
        const startCenter = map.getCenter();
        runClipTransition(
          map,
          { lng: startCenter.lng, lat: startCenter.lat },
          { lng: target.lng, lat: target.lat },
          map.getZoom(),
          mapSettings.zoom,
        );
      } else {
        const now = performance.now();
        if (now - lastFollowAtRef.current > 100) {
          lastFollowAtRef.current = now;
          map.easeTo({ center: [resolved.lng, resolved.lat], duration: 220 });
        }
      }
    } else {
      lastFollowedClipRef.current = selectedClipId;
    }
  }, [playheadMs, indexedRoute, clips, selectedClipId, mapSettings.follow_playhead]);

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
