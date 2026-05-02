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
  type IndexedRoute,
  type ResolvedLocation,
} from '../lib/routeLocation';
import {
  cameraAt,
  resolveIntent,
  type CompiledTimeline,
  type Viewport,
} from '../lib/cameraIntent';

interface MapViewProps {
  /** The compiled project-time timeline. Single source of truth for camera
   *  scheduling — the ease loop below evaluates `cameraAt(timeline, t)`
   *  every tick. See `COMPILED_TIMELINE_PLAN.md` §"Data Model → Compiled
   *  Data". */
  timeline: CompiledTimeline;
  /** Project-time playhead (ms). null when no clip is selected or the
   *  selected clip is not compilable. The ease loop falls back to the
   *  selected clip's `canonicalSeekMs` when this is null but a clip is
   *  selected, so the camera lands on the right initial frame even before
   *  the video element fires its first time-update. */
  playheadMs: number | null;
  mapSettings: MapSettings;
  /** The user's persistent selection. Drives the playhead-bootstrap fallback
   *  in `currentProjectMs` (when no playhead has fired yet, the ease loop
   *  targets this clip's `canonicalSeekMs`). For waypoint highlighting use
   *  `activeClipId` instead — the two diverge during an auto-advance
   *  transition. */
  selectedClipId: string | null;
  /** The clip whose camera state is current at this moment in project-time
   *  per `activeClipIdAt`. During a transition this is the destination clip;
   *  outside a transition it equals `selectedClipId`. Drives waypoint
   *  highlighting only — the ease loop reads project-time directly. */
  activeClipId: string | null;
  route: Route | null;
  /** Per-clip data (id, gps) for the waypoint layer's circle features and
   *  the marker's GPS fallback. The compiled timeline carries clip ids and
   *  spans but not embedded GPS, so we still need the clip list here. */
  clips: Clip[];
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

export default function MapView({
  timeline,
  clips,
  selectedClipId,
  activeClipId,
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
  // Tracks the last route reference we framed via the region-intent jumpTo
  // below. Idempotence guard: we only refit once per unique route.
  const appliedRouteRef = useRef<Route | null>(null);

  const indexedRoute: IndexedRoute | null = useMemo(() => indexRoute(route), [route]);

  // Effective project-time the ease loop should target. When the video is
  // playing this mirrors the playhead. When no playhead has fired yet (e.g.
  // right after project load or a clip selection), fall back to the selected
  // clip span's `canonicalSeekMs` so the first ease-loop tick targets the
  // user's intent rather than the previous clip's last frame.
  const currentProjectMs = useMemo<number | null>(() => {
    if (playheadMs != null) return playheadMs;
    if (!selectedClipId) return null;
    const span = timeline.clipSpans.find((s) => s.clipId === selectedClipId);
    return span ? span.canonicalSeekMs : null;
  }, [playheadMs, timeline, selectedClipId]);
  const currentProjectMsRef = useRef(currentProjectMs);
  currentProjectMsRef.current = currentProjectMs;

  // Project-time → wall-clock for the live marker and slime trail. The pre-
  // cut half of a transition span lives inside the source clip's project-
  // time, so a clip-span lookup catches it and the marker tracks the source
  // clip's live position right up to the cut. The project-start → clip-1
  // transition's window also falls inside clip 1's span (cutMs = 0 = clip
  // 1's startMs), so the marker tracks clip 1 from the very first frame.
  const markerTrace = useMemo<{ wallMs: number; clipId: string } | null>(() => {
    if (currentProjectMs == null) return null;
    if (currentProjectMs < 0) return null;
    if (timeline.clipSpans.length === 0) return null;
    if (currentProjectMs >= timeline.totalDurationMs) {
      const last = timeline.clipSpans[timeline.clipSpans.length - 1];
      return {
        wallMs: last.wallClockBaseMs + last.mediaOutMs,
        clipId: last.clipId,
      };
    }
    // Active clip span — translate project-time to clip-local to wall-clock.
    // This branch wins over a transition's pre-cut half: the source clip's
    // span covers `[startMs, endMs)` and the pre-cut window ends at the cut
    // (== prevSpan.endMs), so the source clip's live position is shown right
    // up to the cut.
    for (let i = 0; i < timeline.clipSpans.length; i++) {
      const span = timeline.clipSpans[i];
      const isLast = i === timeline.clipSpans.length - 1;
      const inside =
        currentProjectMs >= span.startMs &&
        (isLast ? currentProjectMs <= span.endMs : currentProjectMs < span.endMs);
      if (inside) {
        const clipLocalMs =
          (currentProjectMs - span.startMs) * span.speed + span.mediaInMs;
        return {
          wallMs: span.wallClockBaseMs + clipLocalMs,
          clipId: span.clipId,
        };
      }
    }
    // Post-cut half of a transition: source clip's media has ended but the
    // camera arc is still landing. Hold the source clip's terminal position.
    for (const ts of timeline.transitionSpans) {
      if (ts.effectiveDurationMs <= 0) continue;
      if (ts.fromClipId == null) continue;
      if (currentProjectMs >= ts.cutMs && currentProjectMs <= ts.endMs) {
        const prev = timeline.clipSpans.find((s) => s.clipId === ts.fromClipId);
        if (!prev) return null;
        return {
          wallMs: prev.wallClockBaseMs + prev.mediaOutMs,
          clipId: prev.clipId,
        };
      }
    }
    return null;
  }, [currentProjectMs, timeline]);

  // ---- Initialize map ----
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleForId(mapStyleIdRef.current),
      center: [-122.4194, 37.7749],
      zoom: 10,
      bearing: 0,
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

  // ---- Update full-route line + region-intent fit when route changes ----
  // On a new route, frame the full bounds via a `region` CameraIntent
  // resolved through the same pipeline the ease loop uses. jumpTo (not
  // easeTo) is intentional: the initial fit has no continuity to preserve,
  // and the ease loop picks up smoothly from this state on the next tick
  // once anchors exist. Padding 0.06 matches the follow-anchor default — at
  // a typical map pane this is comparable to today's 60 px inset.
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
  // 'visited' mode: a clip counts as visited once the project-time playhead
  // has crossed into its compiled span. Pre-540 this used wall-clock; the
  // semantics are the same (a clip becomes visible at its scheduled start).
  const positionedWaypoints = useMemo(() => {
    if (mapSettings.waypoints_mode === 'none') return [];
    return clips
      .map((clip, originalIndex) => {
        const loc = clipWaypointLocation(clip, indexedRoute);
        if (!loc) return null;
        if (mapSettings.waypoints_mode === 'visited') {
          if (currentProjectMs == null) return null;
          const span = timeline.clipSpans.find((s) => s.clipId === clip.id);
          if (!span || span.startMs > currentProjectMs) return null;
        }
        return { clip, originalIndex, loc };
      })
      .filter((x): x is { clip: Clip; originalIndex: number; loc: ResolvedLocation } => x !== null);
  }, [clips, indexedRoute, mapSettings.waypoints_mode, currentProjectMs, timeline]);

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
  // Highlights the project-time-derived `activeClipId`, not the persistent
  // `selectedClipId`. During an auto-advance transition the two diverge —
  // the highlight follows the destination so the user's eye tracks where
  // the camera is heading instead of where it left.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      if (!map.getLayer('waypoints-circle')) return;
      const active: unknown = activeClipId ?? '';
      map.setPaintProperty('waypoints-circle', 'circle-radius', [
        'case', ['==', ['get', 'id'], active], 14, 11,
      ]);
      map.setPaintProperty('waypoints-circle', 'circle-color', [
        'case', ['==', ['get', 'id'], active], '#4a9eff', colors.accent,
      ]);
      map.setPaintProperty('waypoints-circle', 'circle-stroke-color', [
        'case', ['==', ['get', 'id'], active], '#ffffff', 'rgba(255,255,255,0.85)',
      ]);
    };
    if (styleReadyRef.current) apply();
  }, [activeClipId, styleVersion]);

  // ---- Live preview ease loop ----
  // Every STEP_MS we compute target = cameraAt(timeline, t + lookahead) and
  // fire map.easeTo at the same duration. MapLibre keeps chasing a moving
  // target — clip-to-clip handoff (now via the compiled transition spans),
  // bearing rotation, and within-clip tracking all collapse into this one
  // loop. The pure cameraAt + resolveIntent pipeline is the single source
  // of truth for camera state.
  //
  // Playhead is read off a ref (not via the dep array) so per-frame
  // playhead updates don't restart the loop. Restart only on timeline
  // change (clips/route/settings) — the loop body still picks up the new
  // playhead on the very next tick.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const LOOKAHEAD_MS = 100;
    const STEP_MS = 50;

    let timeoutId = 0;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      // Empty timeline → don't push the camera. The route region-fit jumpTo
      // and the constructor's initial framing remain authoritative until
      // compilable clips exist.
      if (timeline.clipSpans.length === 0) {
        timeoutId = window.setTimeout(tick, STEP_MS);
        return;
      }
      const t = currentProjectMsRef.current ?? 0;
      const intent = cameraAt(timeline, t + LOOKAHEAD_MS);
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
  }, [timeline]);

  // ---- Live playhead marker ----
  // Marker DOM management only. The position comes from the same
  // routeLocation pipeline the export will use; project-time is translated
  // to wall-clock per the active clip span (see `markerTrace` above), then
  // `locationAt` resolves the GPX position. During a transition the marker
  // holds the previous clip's last position — see the `markerTrace` doc.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const fallbackClip =
      markerTrace ? clips.find((c) => c.id === markerTrace.clipId) ?? null : null;
    const fallback = fallbackClip?.gps ?? null;
    const resolved =
      markerTrace ? locationAt(markerTrace.wallMs, indexedRoute, fallback) : null;

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
  }, [markerTrace, indexedRoute, clips]);

  // ---- Slime trail data updates ----
  // Geometric clipping: rebuild the polyline up to the head's wall-clock
  // position and upload it via setData. Pays a per-frame upload cost but
  // gives a pixel-precise cutoff at the marker — line-gradient on a static
  // polyline can't, because MapLibre rasterizes the gradient to a 256-texel
  // 1D texture and bilinear-samples it (the transition smears across one
  // texel = 1/256 of total polyline length, which is tens of pixels of
  // ghost past the marker on long routes).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource('route-trail') as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      if (!indexedRoute || mapSettings.route_mode !== 'visited' || !markerTrace) {
        src.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } });
        return;
      }
      src.setData(trailUpTo(markerTrace.wallMs, indexedRoute));
    };
    if (styleReadyRef.current) apply();
  }, [markerTrace, indexedRoute, mapSettings.route_mode, styleVersion]);

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
