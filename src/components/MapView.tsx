import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Clip, Route, MapSettings } from '../types';
import {
  resolveIntent,
  type CompiledTimeline,
  type Viewport,
} from '../lib/cameraIntent';
import { indexRoute } from '../lib/routeLocation';
import { livePlayheadMs } from '../lib/livePlayhead';
import {
  buildStyleSpec,
  buildStaticSourceData,
  buildPerFrameState,
  BUILDINGS_LAYER_SPEC,
  LIVE_MARKER_PULSE_LAYER,
  LIVE_MARKER_DOT_LAYER,
  ROUTE_FULL_LAYER,
  ROUTE_TRAIL_LAYER,
  WAYPOINTS_CIRCLE_LAYER,
  WAYPOINTS_LABEL_LAYER,
} from '../lib/mapVisuals';

interface MapViewProps {
  /** The compiled project-time timeline. Single source of truth for camera
   *  scheduling — the per-frame loop below evaluates `cameraAt(timeline, t)`
   *  every animation frame. See `COMPILED_TIMELINE_PLAN.md` §"Data Model →
   *  Compiled Data". */
  timeline: CompiledTimeline;
  /** Project-time playhead (ms). null when no clip is selected or the
   *  selected clip is not compilable. The render loop falls back to the
   *  selected clip's `canonicalSeekMs` when this is null but a clip is
   *  selected, so the camera lands on the right initial frame even before
   *  the video element fires its first time-update. */
  playheadMs: number | null;
  mapSettings: MapSettings;
  /** The user's persistent selection. Drives the playhead-bootstrap fallback
   *  in `currentProjectMs` (when no playhead has fired yet, the render loop
   *  targets this clip's `canonicalSeekMs`). For waypoint highlighting use
   *  `activeClipId` instead — the two diverge during an auto-advance
   *  transition. */
  selectedClipId: string | null;
  /** The clip whose camera state is current at this moment in project-time
   *  per `activeClipIdAt`. During a transition this is the destination clip;
   *  outside a transition it equals `selectedClipId`. Drives waypoint
   *  highlighting only — the render loop reads project-time directly. */
  activeClipId: string | null;
  route: Route | null;
  /** Per-clip data (id, gps) for the waypoint layer's circle features and
   *  the marker's GPS fallback. The compiled timeline carries clip ids and
   *  spans but not embedded GPS, so we still need the clip list here. */
  clips: Clip[];
  onSelectClip?: (clipId: string) => void;
}

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
  useEffect(() => {
    onSelectClipRef.current = onSelectClip;
  }, [onSelectClip]);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const styleReadyRef = useRef(false);
  const [styleVersion, setStyleVersion] = useState(0);
  const mapStyleId = mapSettings.map_style;

  // Tracks the last route reference we framed via the region-intent jumpTo
  // below. Idempotence guard: we only refit once per unique route.
  const appliedRouteRef = useRef<Route | null>(null);

  // Mirror props on refs so the per-frame render loop reads fresh values
  // without re-subscribing on every prop change. The loop only restarts when
  // `timeline` changes; everything else flows through refs. Refresh runs in
  // a passive useEffect (post-paint) so worst-case staleness is one frame.
  const mapSettingsRef = useRef(mapSettings);
  const clipsRef = useRef(clips);
  const routeRef = useRef(route);
  const activeClipIdRef = useRef(activeClipId);
  const currentProjectMsRef = useRef<number | null>(null);
  useEffect(() => {
    mapSettingsRef.current = mapSettings;
  }, [mapSettings]);
  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);
  useEffect(() => {
    routeRef.current = route;
  }, [route]);
  useEffect(() => {
    activeClipIdRef.current = activeClipId;
  }, [activeClipId]);
  // Effective project-time the render loop should target. When the video is
  // playing this mirrors the playhead. When no playhead has fired yet (e.g.
  // right after project load or a clip selection), fall back to the selected
  // clip span's `canonicalSeekMs` so the first frame targets the user's
  // intent rather than the previous clip's last frame.
  useEffect(() => {
    if (playheadMs != null) {
      currentProjectMsRef.current = playheadMs;
    } else if (selectedClipId) {
      const span = timeline.clipSpans.find((s) => s.clipId === selectedClipId);
      currentProjectMsRef.current = span ? span.canonicalSeekMs : null;
    } else {
      currentProjectMsRef.current = null;
    }
  }, [playheadMs, selectedClipId, timeline]);

  // ---- Initialize map ----
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const initial = buildStyleSpec(mapSettingsRef.current);
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: initial.style,
      center: [-122.4194, 37.7749],
      zoom: 10,
      bearing: 0,
      pitch: initial.defaultPitch,
      attributionControl: false,
    });
    // Defeat MapLibre's "we're at rest, take shortcuts" heuristics. Three
    // separate code paths read the map's motion flags via `painter.options`:
    //
    //  - `moving` (= map.isMoving()) gates `align` in draw_raster.ts:96 and
    //    its hillshade/color-relief siblings. align=true uses
    //    `_alignedProjMatrix`, which `Math.round`s camera position to integer
    //    CSS pixels (mercator_transform.ts:677–681) — visible as 1-pixel
    //    raster wobble under our per-frame jumpTo loop.
    //  - `zooming` and `rotating` (= map.isZooming/isRotating) gate the icon
    //    atlas texture filter in draw_symbol.ts:365,370. At rest the engine
    //    picks `gl.NEAREST`, which aliases against the texel grid as the
    //    icon's screen position drifts sub-pixel between frames — visible as
    //    POI shimmer/jitter on the default vector style.
    //
    // Our deterministic per-frame jumpTo loop never enters easeTo/flyTo, so
    // every frame reads as at-rest. Forcing all three true keeps the
    // unsnapped raster matrix AND `gl.LINEAR` icon sampling. Camera math
    // (jumpTo, cameraAt) is unchanged, so determinism is preserved.
    map.isMoving = () => true;
    map.isZooming = () => true;
    map.isRotating = () => true;
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }));

    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);
    mapRef.current = map;

    const emptyLine: GeoJSON.Feature<GeoJSON.LineString> = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [] },
    };
    const emptyFc: GeoJSON.FeatureCollection<GeoJSON.Point> = {
      type: 'FeatureCollection',
      features: [],
    };

    const onStyleLoad = () => {
      styleReadyRef.current = true;

      // 3D-buildings layer for `'3d'` mode. The buildings source only exists
      // in the OpenFreeMap liberty style — guarded + try/catch so satellite
      // and other raster styles silently skip it.
      if (mapSettingsRef.current.map_style === '3d') {
        try {
          if (!map.getLayer('3d-buildings') && map.getSource('openmaptiles')) {
            map.addLayer(BUILDINGS_LAYER_SPEC);
          }
        } catch {
          // building source not available in this style — ignore
        }
      }

      // Pre-create source/layer pairs. Stacking order: routes → waypoints →
      // live-marker (marker on top).
      if (!map.getSource('route-full')) {
        map.addSource('route-full', { type: 'geojson', data: emptyLine });
        map.addLayer(ROUTE_FULL_LAYER);
      }
      if (!map.getSource('route-trail')) {
        map.addSource('route-trail', { type: 'geojson', data: emptyLine });
        map.addLayer(ROUTE_TRAIL_LAYER);
      }
      if (!map.getSource('waypoints')) {
        map.addSource('waypoints', { type: 'geojson', data: emptyFc });
        map.addLayer(WAYPOINTS_CIRCLE_LAYER);
        map.addLayer(WAYPOINTS_LABEL_LAYER);
      }
      if (!map.getSource('live-marker')) {
        map.addSource('live-marker', { type: 'geojson', data: emptyFc });
        map.addLayer(LIVE_MARKER_PULSE_LAYER);
        map.addLayer(LIVE_MARKER_DOT_LAYER);
      }

      // Seed static data once. Route-fit + waypoint-seed effects below redo
      // this on subsequent route/clips/styleVersion changes.
      const staticData = buildStaticSourceData({
        route: routeRef.current,
        clips: clipsRef.current,
        mapSettings: mapSettingsRef.current,
      });
      (map.getSource('route-full') as maplibregl.GeoJSONSource | undefined)
        ?.setData(staticData['route-full']);
      (map.getSource('waypoints') as maplibregl.GeoJSONSource | undefined)
        ?.setData(staticData.waypoints);

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
    };
  }, []);

  // ---- Switch base map style ----
  const lastAppliedStyleRef = useRef(mapStyleId);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const { style, defaultPitch } = buildStyleSpec(mapSettings);
    if (lastAppliedStyleRef.current === mapStyleId) {
      // First mount: style was set in the constructor; just sync pitch.
      map.easeTo({ pitch: defaultPitch, duration: 0 });
      return;
    }
    lastAppliedStyleRef.current = mapStyleId;
    styleReadyRef.current = false;
    map.setStyle(style);
    map.easeTo({ pitch: defaultPitch, duration: 400 });
  }, [mapStyleId, mapSettings]);

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

      // Source data comes from the shared module — preserves visual parity
      // with the export renderer and keeps LineString construction in one
      // place.
      const staticData = buildStaticSourceData({ route, clips, mapSettings });
      src.setData(staticData['route-full']);

      if (!route || route.trackpoints.length === 0) return;

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
  }, [route, clips, mapSettings, styleVersion]);

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

  // ---- Waypoint static seed ----
  // Whenever clips/route/mapSettings/styleVersion changes, push the full
  // waypoints FeatureCollection. Per-frame `visited` filtering happens in
  // the ease-loop tick automatically (the module returns a 'waypoints' key
  // in `sources` when mode is 'visited').
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource('waypoints') as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      const staticData = buildStaticSourceData({ route, clips, mapSettings });
      src.setData(staticData.waypoints);
    };
    if (styleReadyRef.current) apply();
  }, [clips, route, mapSettings, styleVersion]);

  // ---- Per-frame render loop ----
  // Each animation frame we compose a per-frame snapshot via
  // `buildPerFrameState(timeline, projectTimeMs, …)` and apply it:
  // `jumpTo` for camera, `setData` for sources, `setPaintProperty` for
  // paints. No smoothing in the apply step — the only allowed source of
  // visual smoothness is `cameraAt(t)` itself, since export samples the
  // same function per frame. Anything we layered on top here (e.g.
  // `easeTo`'s default interpolation) would be preview-only and would
  // diverge from the export. Refs feed per-frame inputs; loop only
  // restarts on timeline change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    let rafId = 0;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      // Empty timeline → don't push the camera. The route region-fit jumpTo
      // and the constructor's initial framing remain authoritative until
      // compilable clips exist.
      if (timeline.clipSpans.length === 0) {
        rafId = window.requestAnimationFrame(tick);
        return;
      }
      // Prefer livePlayheadMs — it's written from inside usePlayback's rAF
      // tick (no React state in between), so during follow playback the map
      // reads the same frame's playhead instead of one set two commits ago.
      // Fall back to currentProjectMsRef for the bootstrap case (no playhead
      // has fired yet — selected clip's canonicalSeekMs) and the seek case
      // (user clicks a clip without playing).
      const projectTimeMs =
        livePlayheadMs.current ?? currentProjectMsRef.current ?? 0;
      const container = map.getContainer();
      const viewport: Viewport = {
        width: container.clientWidth,
        height: container.clientHeight,
        dpr: window.devicePixelRatio || 1,
      };
      const state = buildPerFrameState(
        timeline,
        projectTimeMs,
        activeClipIdRef.current,
        indexRoute(routeRef.current),
        clipsRef.current,
        mapSettingsRef.current,
        viewport,
      );

      map.jumpTo({
        center: [state.camera.center.lng, state.camera.center.lat],
        zoom: state.camera.zoom,
        bearing: state.camera.bearing,
        pitch: state.camera.pitch,
      });

      // Sources / paints. Guard with styleReadyRef — setStyle() drops
      // sources/layers and the loop fires before they're re-added.
      if (styleReadyRef.current) {
        for (const [id, data] of Object.entries(state.sources)) {
          const src = map.getSource(id) as
            | maplibregl.GeoJSONSource
            | undefined;
          // Module returns `GeoJSON.GeoJsonObject`; `setData` wants
          // `GeoJSON.GeoJSON`. Runtime-equivalent — cast through unknown.
          if (src) src.setData(data as unknown as GeoJSON.GeoJSON);
        }
        if (map.getLayer('waypoints-circle')) {
          map.setPaintProperty('waypoints-circle', 'circle-radius',
            state.paints.waypointCircleRadius);
          map.setPaintProperty('waypoints-circle', 'circle-color',
            state.paints.waypointCircleColor);
          map.setPaintProperty('waypoints-circle', 'circle-stroke-color',
            state.paints.waypointCircleStrokeColor);
        }
        if (map.getLayer('live-marker-pulse')) {
          map.setPaintProperty('live-marker-pulse', 'circle-radius',
            state.paints.pulseRadius);
          map.setPaintProperty('live-marker-pulse', 'circle-opacity',
            state.paints.pulseOpacity);
        }
      }

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      stopped = true;
      window.cancelAnimationFrame(rafId);
    };
  }, [timeline]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        minHeight: '300px',
        position: 'relative',
      }}
    />
  );
}

