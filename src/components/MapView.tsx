import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Clip, Route } from '../types';

interface MapViewProps {
  clips: Clip[];
  selectedClipId: string | null;
  route: Route | null;
}

export default function MapView({ clips, selectedClipId, route }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);

  // Initialize map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [-122.4194, 37.7749], // Default: San Francisco
      zoom: 10,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Update markers when clips change
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Clear old markers
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    const clipsWithGps = clips.filter((c) => c.gps !== null);
    if (clipsWithGps.length === 0) return;

    // Add markers
    clipsWithGps.forEach((clip, index) => {
      if (!clip.gps) return;

      const isSelected = clip.id === selectedClipId;

      const el = document.createElement('div');
      el.style.width = isSelected ? '28px' : '22px';
      el.style.height = isSelected ? '28px' : '22px';
      el.style.borderRadius = '50%';
      el.style.backgroundColor = isSelected ? '#4a9eff' : '#ff6b35';
      el.style.border = `2px solid ${isSelected ? '#fff' : 'rgba(255,255,255,0.8)'}`;
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.justifyContent = 'center';
      el.style.fontSize = '11px';
      el.style.fontWeight = 'bold';
      el.style.color = '#fff';
      el.style.cursor = 'pointer';
      el.style.transition = 'all 0.15s';
      el.textContent = String(index + 1);

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([clip.gps.lng, clip.gps.lat])
        .addTo(map);

      markersRef.current.push(marker);
    });

    // Fit bounds to show all markers
    if (clipsWithGps.length === 1) {
      const c = clipsWithGps[0].gps!;
      map.flyTo({ center: [c.lng, c.lat], zoom: 14 });
    } else {
      const bounds = new maplibregl.LngLatBounds();
      clipsWithGps.forEach((clip) => {
        if (clip.gps) bounds.extend([clip.gps.lng, clip.gps.lat]);
      });
      map.fitBounds(bounds, { padding: 60 });
    }
  }, [clips, selectedClipId]);

  // Draw route when available
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const addRoute = () => {
      // Remove existing route layer/source
      if (map.getLayer('route-line')) map.removeLayer('route-line');
      if (map.getSource('route')) map.removeSource('route');

      if (!route || route.trackpoints.length === 0) return;

      const coordinates = route.trackpoints.map((tp) => [tp.lng, tp.lat]);

      map.addSource('route', {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates,
          },
        },
      });

      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: {
          'line-join': 'round',
          'line-cap': 'round',
        },
        paint: {
          'line-color': '#ff6b35',
          'line-width': 3,
          'line-opacity': 0.8,
        },
      });

      // Fit to route bounds
      const bounds = new maplibregl.LngLatBounds();
      coordinates.forEach((c) => bounds.extend(c as [number, number]));
      map.fitBounds(bounds, { padding: 60 });
    };

    if (map.isStyleLoaded()) {
      addRoute();
    } else {
      map.on('load', addRoute);
    }
  }, [route]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        minHeight: '300px',
      }}
    />
  );
}
