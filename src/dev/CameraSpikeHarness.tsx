// Dev-only spike harness for the cameraIntent migration. Two MapLibre
// instances driven by the same `cameraAt(track, t)` and a single shared
// playhead clock — one rendered at the live container's aspect, one at a
// fixed 360x640 9:16 box. Pass criteria live in
// docs/MAP_ARCHITECTURE_MIGRATION.md §6.1.
//
// This file is a HARD STOP. Do not modify MapView.tsx — the whole point of
// this spike is to compare the new pipeline against the existing imperative
// writers in parallel.

import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Clip, Route, MapSettings, MapStyleId } from '../types';
import {
  buildMapTrack,
  cameraAt,
  resolveIntent,
  type MapTrack,
  type Viewport,
  type CameraIntent,
} from '../lib/cameraIntent';
import { indexRoute } from '../lib/routeLocation';

interface Props {
  clips: Clip[];
  route: Route | null;
  mapSettings: MapSettings;
  onClose?: () => void;
}

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
  return DEFAULT_STYLE_URL;
}

const STEP_MS = 50;
const LOOKAHEAD_MS = 100;

interface PaneOverlay {
  intentKind: CameraIntent['kind'];
  zoom: number;
  bearing: number;
  easeBudgetMs: number;
}

/** Mounts a MapLibre instance into the given container and runs the §3.5
 *  ease loop against the shared playhead. Pure dev code — no event recording,
 *  no waypoint markers, no route line. The point of the spike is camera math,
 *  not full rendering parity (§6.1 explicitly tests handoff + aspect framing).
 */
function useEaseLoopMap(
  containerRef: React.RefObject<HTMLDivElement | null>,
  track: MapTrack,
  mapStyleId: MapStyleId,
  playheadRef: React.MutableRefObject<number>,
  viewportFor: (map: maplibregl.Map) => Viewport,
  onTick: (intent: CameraIntent, resolvedZoom: number, resolvedBearing: number, easeBudgetMs: number) => void,
) {
  const trackRef = useRef(track);
  trackRef.current = track;
  const viewportForRef = useRef(viewportFor);
  viewportForRef.current = viewportFor;
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleForId(mapStyleId),
      center: [-122.4194, 37.7749],
      zoom: 10,
      attributionControl: false,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }));

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(containerRef.current);

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = () => {
      if (stopped) return;
      const t0 = performance.now();
      const t = playheadRef.current;
      const intent = cameraAt(trackRef.current, t + LOOKAHEAD_MS);
      const viewport = viewportForRef.current(map);
      // Skip ticks against a 0×0 viewport — would produce -Infinity zooms.
      if (viewport.width > 0 && viewport.height > 0) {
        const target = resolveIntent(intent, viewport);
        map.easeTo({
          center: [target.center.lng, target.center.lat],
          zoom: target.zoom,
          bearing: target.bearing,
          pitch: target.pitch,
          duration: STEP_MS,
          essential: true,
        });
        const easeBudget = performance.now() - t0;
        onTickRef.current(intent, target.zoom, target.bearing, easeBudget);
      }
      timer = setTimeout(tick, STEP_MS);
    };
    // Defer first tick until the style has loaded, otherwise easeTo's first
    // call can fire before tile sources are ready and produce a flash of the
    // default San Francisco view.
    map.once('style.load', () => {
      tick();
    });

    return () => {
      stopped = true;
      if (timer != null) clearTimeout(timer);
      ro.disconnect();
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapStyleId]);
}

export default function CameraSpikeHarness({ clips, route, mapSettings, onClose }: Props) {
  // ---- Build the pure track once ------------------------------------------
  const indexedRoute = useMemo(() => indexRoute(route), [route]);
  const track = useMemo(
    () => buildMapTrack(clips, indexedRoute, mapSettings, 'natural'),
    [clips, indexedRoute, mapSettings],
  );

  // ---- Shared playhead clock ----------------------------------------------
  // Anchored at the FIRST anchor's timeMs so the harness has something to
  // show even if the project's wall-clock timestamps are years in the past.
  // Advances at 1× wall-clock when playing.
  const baseTime = track.anchors[0]?.timeMs ?? 0;
  const trackEndTime =
    track.anchors[track.anchors.length - 1]?.endTimeMs ?? baseTime;
  const trackDurationMs = Math.max(0, trackEndTime - baseTime);

  const [playheadMs, setPlayheadMs] = useState<number>(baseTime);
  const [playing, setPlaying] = useState<boolean>(false);
  const playheadRef = useRef<number>(baseTime);
  playheadRef.current = playheadMs;

  // RAF loop advancing the shared clock. Both panes read playheadRef.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      setPlayheadMs((prev) => {
        let next = prev + dt;
        // Loop at the end of the track so a paused user gets a continuous
        // demo. If the track is empty, keep the base time.
        if (trackDurationMs > 0 && next > trackEndTime) {
          next = baseTime + ((next - baseTime) % trackDurationMs);
        }
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, baseTime, trackEndTime, trackDurationMs]);

  // ---- Pane overlays (debug HUDs) -----------------------------------------
  const [paneAOverlay, setPaneAOverlay] = useState<PaneOverlay>({
    intentKind: 'point',
    zoom: 0,
    bearing: 0,
    easeBudgetMs: 0,
  });
  const [paneBOverlay, setPaneBOverlay] = useState<PaneOverlay>({
    intentKind: 'point',
    zoom: 0,
    bearing: 0,
    easeBudgetMs: 0,
  });

  const paneARef = useRef<HTMLDivElement | null>(null);
  const paneBRef = useRef<HTMLDivElement | null>(null);

  // Pane A: viewport from the live container.
  useEaseLoopMap(
    paneARef,
    track,
    mapSettings.map_style,
    playheadRef,
    (map) => ({
      width: map.getContainer().clientWidth,
      height: map.getContainer().clientHeight,
      dpr: window.devicePixelRatio,
    }),
    (intent, zoom, bearing, easeBudgetMs) => {
      setPaneAOverlay({ intentKind: intent.kind, zoom, bearing, easeBudgetMs });
    },
  );

  // Pane B: hardcoded 360x640 9:16 viewport. Critical: we DO NOT scale —
  // the whole point is to prove the same intent produces different framing
  // at different aspects (§6.1 criterion B).
  useEaseLoopMap(
    paneBRef,
    track,
    mapSettings.map_style,
    playheadRef,
    () => ({ width: 360, height: 640, dpr: window.devicePixelRatio }),
    (intent, zoom, bearing, easeBudgetMs) => {
      setPaneBOverlay({ intentKind: intent.kind, zoom, bearing, easeBudgetMs });
    },
  );

  // ---- Active anchor (for the overlay) ------------------------------------
  const activeAnchor = useMemo(() => {
    for (const a of track.anchors) {
      if (playheadMs >= a.timeMs && playheadMs <= a.endTimeMs) return a;
    }
    return null;
  }, [track, playheadMs]);

  const activeClipId = useMemo(() => {
    if (!activeAnchor) return null;
    // Find the clip that starts at activeAnchor.timeMs (modulo trim.in_ms).
    // We don't have a back-pointer; instead, scan clips in time order.
    return clips.find((c) => {
      if (!c.created_at) return false;
      const inMs = c.trim?.in_ms ?? 0;
      const baseMs = Date.parse(c.created_at);
      if (Number.isNaN(baseMs)) return false;
      return Math.abs(baseMs + inMs - activeAnchor.timeMs) < 5;
    })?.id ?? null;
  }, [activeAnchor, clips]);

  // ---- Heap memory (Chromium only) ----------------------------------------
  const [heapMb, setHeapMb] = useState<number | null>(null);
  useEffect(() => {
    const id = setInterval(() => {
      const mem = (performance as Performance & {
        memory?: { usedJSHeapSize: number };
      }).memory;
      if (mem) setHeapMb(mem.usedJSHeapSize / (1024 * 1024));
    }, 500);
    return () => clearInterval(id);
  }, []);

  // ---- Empty-track fallback -----------------------------------------------
  // No anchors means no clips with timestamps + non-degenerate trims. Show
  // a clear message rather than a blank dual-pane.
  if (track.anchors.length === 0) {
    return (
      <div style={hostStyle}>
        <div style={{ padding: 24, color: '#ddd', fontFamily: 'system-ui' }}>
          <h2 style={{ marginTop: 0 }}>CameraSpikeHarness</h2>
          <p>
            No anchors built. The project needs at least one visible clip with
            a parseable <code>created_at</code> and a non-degenerate trim.
          </p>
          <p>Remove <code>?camera-spike=1</code> from the URL to return to the project view.</p>
          {onClose && (
            <button onClick={onClose} style={buttonStyle}>Exit harness</button>
          )}
        </div>
      </div>
    );
  }

  const playheadOffsetMs = playheadMs - baseTime;

  return (
    <div style={hostStyle}>
      {/* ---- Toolbar ------------------------------------------------------ */}
      <div style={toolbarStyle}>
        <strong style={{ marginRight: 12 }}>CameraSpikeHarness</strong>
        <button
          onClick={() => setPlaying((p) => !p)}
          style={buttonStyle}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          onClick={() => {
            setPlaying(false);
            setPlayheadMs(baseTime);
          }}
          style={buttonStyle}
        >
          Reset
        </button>
        <label style={{ marginLeft: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          Jump to clip:
          <select
            value={activeAnchor?.timeMs ?? ''}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (!Number.isNaN(v)) {
                setPlaying(false);
                setPlayheadMs(v);
              }
            }}
            style={{ padding: 4, fontSize: 12 }}
          >
            <option value="">— select —</option>
            {track.anchors.map((a, i) => (
              <option key={i} value={a.timeMs}>
                Anchor {i + 1} ({a.intent.kind})
              </option>
            ))}
          </select>
        </label>
        <input
          type="range"
          min={0}
          max={trackDurationMs}
          step={50}
          value={Math.max(0, Math.min(trackDurationMs, playheadOffsetMs))}
          onChange={(e) => {
            setPlaying(false);
            setPlayheadMs(baseTime + Number(e.target.value));
          }}
          style={{ flex: 1, marginLeft: 12 }}
        />
        <span style={{ marginLeft: 12, fontVariantNumeric: 'tabular-nums' }}>
          t={Math.round(playheadOffsetMs)}ms / {Math.round(trackDurationMs)}ms
        </span>
        <span style={{ marginLeft: 12 }}>
          heap={heapMb != null ? `${heapMb.toFixed(1)}MB` : 'n/a'}
        </span>
        <span style={{ marginLeft: 12 }}>
          activeClip={activeClipId ?? 'none'}
        </span>
        {onClose && (
          <button onClick={onClose} style={{ ...buttonStyle, marginLeft: 12 }}>
            Exit
          </button>
        )}
      </div>

      {/* ---- Two panes side-by-side -------------------------------------- */}
      <div style={panesRowStyle}>
        <div style={paneAStyle}>
          <div ref={paneARef} style={mapBoxStyle} />
          <PaneOverlayHUD label="A · live aspect" overlay={paneAOverlay} />
        </div>
        <div style={paneBOuterStyle}>
          <div style={paneBInnerStyle}>
            <div ref={paneBRef} style={mapBoxStyle} />
            <PaneOverlayHUD label="B · 360×640 (9:16)" overlay={paneBOverlay} />
          </div>
        </div>
      </div>
    </div>
  );
}

function PaneOverlayHUD({ label, overlay }: { label: string; overlay: PaneOverlay }) {
  return (
    <div style={hudStyle}>
      <div style={{ fontWeight: 600 }}>{label}</div>
      <div>kind: {overlay.intentKind}</div>
      <div>zoom: {overlay.zoom.toFixed(2)}</div>
      <div>bearing: {overlay.bearing.toFixed(0)}°</div>
      <div>easeTo: {overlay.easeBudgetMs.toFixed(1)}ms</div>
    </div>
  );
}

// ---- Styles (inline to keep the harness self-contained) -------------------

const hostStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  background: '#111',
  color: '#eee',
  fontFamily: 'system-ui, sans-serif',
  fontSize: 13,
};

const toolbarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '8px 12px',
  background: '#1c1c1e',
  borderBottom: '1px solid #2a2a2c',
  gap: 4,
};

const buttonStyle: React.CSSProperties = {
  padding: '4px 10px',
  background: '#2a2a2c',
  color: '#eee',
  border: '1px solid #3a3a3c',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12,
};

const panesRowStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  minHeight: 0,
};

const paneAStyle: React.CSSProperties = {
  flex: 1,
  position: 'relative',
  borderRight: '1px solid #2a2a2c',
  minWidth: 0,
};

const paneBOuterStyle: React.CSSProperties = {
  width: 400,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#0a0a0a',
};

const paneBInnerStyle: React.CSSProperties = {
  width: 360,
  height: 640,
  position: 'relative',
  border: '1px solid #3a3a3c',
};

const mapBoxStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
};

const hudStyle: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  left: 8,
  padding: '6px 8px',
  background: 'rgba(0,0,0,0.65)',
  color: '#fff',
  borderRadius: 4,
  fontSize: 11,
  fontVariantNumeric: 'tabular-nums',
  pointerEvents: 'none',
  lineHeight: 1.4,
};
