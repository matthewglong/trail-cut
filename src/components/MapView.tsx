import { useEffect, useMemo, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Clip, Route, MapSettings } from '../types';
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
}

const TRAIL_COLOR = colors.accent;
const FULL_ROUTE_COLOR = colors.accent;
const LIVE_MARKER_PULSE_KEYFRAMES = `
@keyframes trailcut-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(255, 107, 53, 0.55); }
  70%  { box-shadow: 0 0 0 14px rgba(255, 107, 53, 0); }
  100% { box-shadow: 0 0 0 0 rgba(255, 107, 53, 0); }
}
`;

export default function MapView({
  clips,
  selectedClipId,
  route,
  playheadMs,
  mapSettings,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const styleReadyRef = useRef(false);

  const waypointMarkersRef = useRef<maplibregl.Marker[]>([]);
  const liveMarkerRef = useRef<maplibregl.Marker | null>(null);
  const liveMarkerElRef = useRef<HTMLDivElement | null>(null);
  const lastFollowAtRef = useRef<number>(0);

  const indexedRoute: IndexedRoute | null = useMemo(() => indexRoute(route), [route]);
  const routeLoaded = indexedRoute !== null;

  // ---- Initialize map ----
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [-122.4194, 37.7749],
      zoom: 10,
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    mapRef.current = map;

    map.on('load', () => {
      styleReadyRef.current = true;
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
    });

    return () => {
      map.remove();
      mapRef.current = null;
      styleReadyRef.current = false;
      waypointMarkersRef.current = [];
      liveMarkerRef.current = null;
      liveMarkerElRef.current = null;
    };
  }, []);

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

      const bounds = new maplibregl.LngLatBounds();
      coordinates.forEach((c) => bounds.extend(c));
      map.fitBounds(bounds, { padding: 60, duration: 0 });
    };

    if (styleReadyRef.current) apply();
    else map.once('load', apply);
  }, [route]);

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
    else map.once('load', apply);
  }, [mapSettings.route_mode]);

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

  // Stable key so the marker-rendering effect only runs when the visible set
  // (or selection) actually changes — not on every playhead tick.
  const waypointsKey = positionedWaypoints.map((p) => p.clip.id).join(',') + '|' + selectedClipId;

  // ---- Waypoint markers (one per clip, snapped to GPX when possible) ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Clear existing
    waypointMarkersRef.current.forEach((m) => m.remove());
    waypointMarkersRef.current = [];

    const positioned = positionedWaypoints;

    if (positioned.length === 0) return;

    positioned.forEach(({ clip, originalIndex, loc }) => {
      const isSelected = clip.id === selectedClipId;
      const el = document.createElement('div');
      el.style.width = isSelected ? '28px' : '22px';
      el.style.height = isSelected ? '28px' : '22px';
      el.style.borderRadius = '50%';
      el.style.backgroundColor = isSelected ? '#4a9eff' : colors.accent;
      el.style.border = `2px solid ${isSelected ? '#fff' : 'rgba(255,255,255,0.85)'}`;
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.justifyContent = 'center';
      el.style.fontSize = '11px';
      el.style.fontWeight = 'bold';
      el.style.color = '#fff';
      el.style.cursor = 'pointer';
      el.style.boxShadow = '0 1px 3px rgba(0,0,0,0.4)';
      el.style.transition = 'all 0.15s';
      el.textContent = String(originalIndex + 1);

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([loc.lng, loc.lat])
        .addTo(map);
      waypointMarkersRef.current.push(marker);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waypointsKey]);

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

    // Follow playhead — throttle to ~10Hz
    if (mapSettings.follow_playhead) {
      const now = performance.now();
      if (now - lastFollowAtRef.current > 100) {
        lastFollowAtRef.current = now;
        map.easeTo({ center: [resolved.lng, resolved.lat], duration: 220 });
      }
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
    else map.once('load', apply);
  }, [playheadMs, indexedRoute, mapSettings.route_mode]);

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
