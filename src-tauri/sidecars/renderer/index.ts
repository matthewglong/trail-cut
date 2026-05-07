// Renderer worker. Long-running Node sidecar that produces map frames
// headlessly via @maplibre/maplibre-gl-native, driven by a line-delimited
// JSON protocol on stdin and writing length-prefixed raw RGBA buffers to
// stdout. Spawned by the Rust orchestrator (task 030); spec at
// docs/export/tasks/020-renderer-worker.md.
//
// Load-bearing invariant — visual parity by import. Every visual decision
// (layer specs, paint expressions, source-data computation, animation
// curves, camera math) lives in src/lib/mapVisuals/, src/lib/cameraIntent.ts,
// and src/lib/routeLocation.ts. This file MUST NOT redefine any of them; it
// only applies what those modules return. A change to marker color, slime-
// trail paint, pulse curve, or active-clip highlighting is a one-PR change
// in the shared module — both preview and worker pick it up via build graph.
//
// Camera: cameraAt(timeline, t) is the single evaluator; preview applies via
// jumpTo, this worker via map.render({...camera}). Neither side eases.
//
// API note — maplibre-native vs maplibre-gl: the native binding's surface is
// noticeably narrower than the JS browser package. Two divergences shape the
// shape of this file:
//   1. No `style.load` event, no event emitter on Map. `map.load(style)` is
//      synchronous; tile fetches happen lazily during render. The setup-
//      ready handshake is therefore immediate after addSource/addLayer.
//   2. No `getSource(id)`, no per-source `setData`. The documented mechanism
//      for changing GeoJSON source data is removeLayer+removeSource+addSource
//      +addLayer. We do that for the per-frame dynamic sources (route-trail,
//      live-marker, visited-mode waypoints).
//   3. setPaintProperty exists at runtime, even though the published .d.ts
//      omits it. We use it for waypoint highlight + pulse paint.

import readline from 'node:readline';
import https from 'node:https';
import http from 'node:http';
import zlib from 'node:zlib';
import * as mbgl from '@maplibre/maplibre-gl-native';

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
} from '../../../src/lib/mapVisuals';
import {
  activeClipIdAt,
  type CompiledTimeline,
} from '../../../src/lib/cameraIntent';
import { indexRoute, type IndexedRoute } from '../../../src/lib/routeLocation';
import type { Clip, Route, MapSettings } from '../../../src/types';
import { createTileCache, defaultCacheDir } from './tileCache';

// ---- Protocol types -------------------------------------------------------

interface SetupCmd {
  cmd: 'setup';
  /** Map-slot pixel dims (PLAN.md §"Performance considerations" #1 — render
   *  at slot size, not output size; orchestrator scales later). */
  viewport: { w: number; h: number };
  /** Echoed for diagnostics; the worker doesn't act on fps directly. */
  fps: number;
  timeline: CompiledTimeline;
  route: Route | null;
  clips: Clip[];
  mapSettings: MapSettings;
}
interface RenderCmd {
  cmd: 'render';
  frame_index: number;
  project_time_ms: number;
}
interface RecycleCmd { cmd: 'recycle' }
interface ShutdownCmd { cmd: 'shutdown' }
type Cmd = SetupCmd | RenderCmd | RecycleCmd | ShutdownCmd;

// ---- State ----------------------------------------------------------------

// Cached at boot; doubles as the recycle blueprint per spec §"Recycle".
let setupPayload: SetupCmd | null = null;
// `mbgl.Map`. Typed as `any` because the published .d.ts is missing
// setPaintProperty (and a few others) that exist at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let map: any = null;
let indexedRoute: IndexedRoute | null = null;

// ---- Tile fetch + cache ---------------------------------------------------
//
// All URLs maplibre-native asks for via request() (style JSON, sprites,
// glyphs, vector/raster tiles) flow through a hash-keyed on-disk cache; the
// network fetcher below is the cache's miss path. See tileCache.ts and
// docs/export/tasks/035-shared-tile-cache.md for the design.
//
// Cache instance is constructed once at module load. Tests override location
// and offline behavior via TRAILCUT_TILE_CACHE_DIR / TRAILCUT_TILE_CACHE_OFFLINE
// env knobs; production uses the default ~/.trailcut/tile-cache and online
// behavior.

const tileCache = createTileCache({
  dir: process.env.TRAILCUT_TILE_CACHE_DIR ?? defaultCacheDir(),
  offline: process.env.TRAILCUT_TILE_CACHE_OFFLINE === '1',
});

function fetchUrl(
  url: string,
  cb: (err: Error | null, data?: Buffer) => void,
  redirectsLeft = 5,
): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch (e) { cb(e as Error); return; }
  const proto = parsed.protocol === 'https:' ? https : http;
  proto
    .get(
      url,
      { headers: { 'Accept-Encoding': 'gzip, deflate, br' } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (
          status >= 300 && status < 400 &&
          res.headers.location && redirectsLeft > 0
        ) {
          res.resume();
          fetchUrl(
            new URL(res.headers.location, url).toString(),
            cb,
            redirectsLeft - 1,
          );
          return;
        }
        if (status !== 200 && status !== 204) {
          res.resume();
          cb(new Error(`HTTP ${status} for ${url}`));
          return;
        }
        let stream: NodeJS.ReadableStream = res;
        const enc = res.headers['content-encoding'];
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => cb(null, Buffer.concat(chunks)));
        stream.on('error', (e: Error) => cb(e));
      },
    )
    .on('error', (e) => cb(e));
}

// ---- GeoJSON quirk adapter ------------------------------------------------
//
// maplibre-native rejects `Feature<LineString>` with fewer than two
// coordinates ("A line string must have two or more coordinate points") at
// addSource validation time. The browser maplibre-gl-js silently accepts
// the same payload. Since the shared mapVisuals module's contract is
// "browser-compatible GeoJSON" — and changing it would break parity — the
// worker translates degenerate LineStrings into empty FeatureCollections at
// the addSource boundary. Same data semantically (nothing to draw); only
// the GeoJSON shape changes.
function adaptForNative(
  data: GeoJSON.GeoJsonObject,
): GeoJSON.GeoJsonObject {
  if (data.type === 'Feature') {
    const f = data as GeoJSON.Feature;
    if (
      f.geometry?.type === 'LineString' &&
      ((f.geometry as GeoJSON.LineString).coordinates?.length ?? 0) < 2
    ) {
      const empty: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: [],
      };
      return empty;
    }
  }
  return data;
}

// ---- Map setup / teardown -------------------------------------------------

function fetchStyleJson(url: string): Promise<object> {
  // Style JSON is the largest single boot-phase response (~400 KB) and a
  // perfect cache citizen — it's URL-versioned by upstream just like tiles.
  // Route it through the same cache as the per-Map request() callback so
  // repeat exports skip the boot fetch entirely.
  return new Promise((resolveStyle, rejectStyle) => {
    tileCache.get(url, fetchUrl, (err, data) => {
      if (err || !data) {
        rejectStyle(err ?? new Error('no data'));
        return;
      }
      try {
        resolveStyle(JSON.parse(data.toString('utf8')));
      } catch (e) {
        rejectStyle(e as Error);
      }
    });
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildMap(payload: SetupCmd): Promise<any> {
  const { style } = buildStyleSpec(payload.mapSettings);

  // maplibre-native's `load(style)` only accepts a parsed style object, not
  // a URL (a URL string fails JSON parsing at offset 0). For URL-based modes
  // ('default' / '3d' → OpenFreeMap liberty) we fetch the style JSON here
  // and pass the parsed object. Subsequent sprite/glyph/source/tile requests
  // still flow through the per-Map `request` callback below.
  const styleSpec: object =
    typeof style === 'string' ? await fetchStyleJson(style) : style;

  const newMap = new mbgl.Map({
    request: (req: { url: string }, callback: (err?: Error, response?: { data: Buffer }) => void) => {
      tileCache.get(req.url, fetchUrl, (err, data) => {
        if (err || !data) {
          callback(err ?? new Error('no data'));
          return;
        }
        callback(undefined, { data });
      });
    },
    ratio: 1,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  // Synchronous; tile fetches happen lazily during render. (No `style.load`
  // event the way maplibre-gl-js has — see file header note.)
  newMap.load(styleSpec);

  // 3D buildings, when applicable. The base style URL populates the
  // `openmaptiles` source at first render; addLayer just enqueues the layer
  // spec referencing that source by name. Try/catch in case the source isn't
  // available in this style (mirrors MapView.tsx).
  if (payload.mapSettings.map_style === '3d') {
    try { newMap.addLayer(BUILDINGS_LAYER_SPEC); } catch { /* not in style */ }
  }

  const staticData = buildStaticSourceData({
    route: payload.route,
    clips: payload.clips,
    mapSettings: payload.mapSettings,
  });

  const emptyLine: GeoJSON.Feature<GeoJSON.LineString> = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: [] },
  };
  const emptyFc: GeoJSON.FeatureCollection<GeoJSON.Point> = {
    type: 'FeatureCollection',
    features: [],
  };

  // Static (route-full) — added once; per-frame doesn't touch. Adapted in
  // case the route is null/empty (degenerate LineString → empty FC).
  newMap.addSource('route-full', { type: 'geojson', data: adaptForNative(staticData['route-full']) });
  newMap.addLayer(ROUTE_FULL_LAYER);

  // Dynamic (route-trail, live-marker, optionally waypoints in 'visited' mode)
  // — seeded with empty placeholders. Per-frame replaces via remove/re-add.
  newMap.addSource('route-trail', { type: 'geojson', data: adaptForNative(emptyLine) });
  newMap.addLayer(ROUTE_TRAIL_LAYER);

  // waypoints — seeded with the static collection (full features in 'all'
  // mode, empty in 'none' mode). In 'visited' mode the per-frame loop
  // overrides with the visited subset.
  newMap.addSource('waypoints', { type: 'geojson', data: staticData.waypoints });
  newMap.addLayer(WAYPOINTS_CIRCLE_LAYER);
  newMap.addLayer(WAYPOINTS_LABEL_LAYER);

  newMap.addSource('live-marker', { type: 'geojson', data: emptyFc });
  newMap.addLayer(LIVE_MARKER_PULSE_LAYER);
  newMap.addLayer(LIVE_MARKER_DOT_LAYER);

  // Visibility — mirrors MapView.tsx's route-mode effect. `route-full-line`
  // is added once and stays put, so its visibility settles here. `route-
  // trail-line` is re-added every frame in applyDynamicSource (no setData on
  // the native binding), so its visibility is re-applied there via
  // visibilityFor — setting it here would be overwritten on frame 0.
  newMap.setLayoutProperty(
    'route-full-line', 'visibility',
    visibilityFor('route-full-line', payload.mapSettings),
  );

  return newMap;
}

async function setup(payload: SetupCmd): Promise<void> {
  setupPayload = payload;
  map = await buildMap(payload);
  indexedRoute = indexRoute(payload.route);
}

async function recycle(): Promise<void> {
  if (!setupPayload) {
    process.stderr.write('[renderer] recycle without prior setup, ignoring\n');
    return;
  }
  if (map) {
    try { map.release(); } catch { /* ignore */ }
    map = null;
  }
  map = await buildMap(setupPayload);
  indexedRoute = indexRoute(setupPayload.route);
}

// ---- Per-frame source/paint application -----------------------------------

// For each dynamic GeoJSON source, the layers that depend on it. Per-frame
// updates do removeLayer (reverse) + removeSource + addSource + addLayer
// (forward) — that's the only way to push new data without getSource(id).
// Layer ids and stacking order match MapView.tsx setup.
const DYNAMIC_LAYERS_BY_SOURCE: Record<string, string[]> = {
  'route-trail': ['route-trail-line'],
  'waypoints': ['waypoints-circle', 'waypoints-label'],
  'live-marker': ['live-marker-pulse', 'live-marker-dot'],
};
const LAYER_SPEC_BY_ID: Record<string, object> = {
  'route-trail-line': ROUTE_TRAIL_LAYER,
  'waypoints-circle': WAYPOINTS_CIRCLE_LAYER,
  'waypoints-label': WAYPOINTS_LABEL_LAYER,
  'live-marker-pulse': LIVE_MARKER_PULSE_LAYER,
  'live-marker-dot': LIVE_MARKER_DOT_LAYER,
};

// Visibility rules — mirrors MapView.tsx's route-mode effect. The shared
// layer specs in src/lib/mapVisuals/styleSpec.ts intentionally don't carry
// `layout.visibility` (preview toggles via setLayoutProperty as a render-
// mode decision, not a layer-spec decision). Since the worker re-adds
// dynamic layers on every frame, addLayer's default-visible behavior would
// override any one-shot setLayoutProperty call from setup. Re-apply here.
function visibilityFor(
  layerId: string,
  settings: MapSettings,
): 'visible' | 'none' {
  if (layerId === 'route-full-line') {
    return settings.route_mode === 'full' ? 'visible' : 'none';
  }
  if (layerId === 'route-trail-line') {
    return settings.route_mode === 'visited' ? 'visible' : 'none';
  }
  return 'visible';
}

function applyDynamicSource(
  sourceId: string,
  data: GeoJSON.GeoJsonObject,
): void {
  const layerIds = DYNAMIC_LAYERS_BY_SOURCE[sourceId];
  if (!layerIds) {
    process.stderr.write(`[renderer] unknown dynamic source: ${sourceId}\n`);
    return;
  }
  for (let i = layerIds.length - 1; i >= 0; i--) {
    try { map.removeLayer(layerIds[i]); } catch { /* not present */ }
  }
  try { map.removeSource(sourceId); } catch { /* not present */ }
  map.addSource(sourceId, { type: 'geojson', data: adaptForNative(data) });
  for (const id of layerIds) {
    map.addLayer(LAYER_SPEC_BY_ID[id]);
    map.setLayoutProperty(
      id, 'visibility', visibilityFor(id, setupPayload!.mapSettings),
    );
  }
}

// ---- Stdout writes --------------------------------------------------------

function writeReady(): void {
  process.stdout.write('{"ready":true}\n');
}

function writeFrame(buf: Uint8Array): void {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(buf.byteLength, 0);
  // Two sequential writes on the same stream are concatenated in order on
  // the receiving end. The orchestrator reads `[4-byte BE length][N bytes]`.
  process.stdout.write(prefix);
  process.stdout.write(buf);
}

// ---- Render dispatch ------------------------------------------------------

function renderFrame(cmd: RenderCmd, done: () => void): void {
  if (!setupPayload || !map) {
    process.stderr.write('[renderer] render before setup, exiting\n');
    process.exit(1);
  }
  const t = cmd.project_time_ms;
  const payload = setupPayload;
  const viewport = {
    width: payload.viewport.w,
    height: payload.viewport.h,
    dpr: 1,
  };

  const activeClipId = activeClipIdAt(payload.timeline, t);
  const state = buildPerFrameState(
    payload.timeline,
    t,
    activeClipId,
    indexedRoute,
    payload.clips,
    payload.mapSettings,
    viewport,
  );

  // Per-frame source data — entries vary by mapSettings (always route-trail
  // + live-marker; waypoints only in 'visited' mode, per buildPerFrameState).
  for (const [sourceId, data] of Object.entries(state.sources)) {
    applyDynamicSource(sourceId, data);
  }

  // Per-frame paint deltas.
  map.setPaintProperty('waypoints-circle', 'circle-radius', state.paints.waypointCircleRadius);
  map.setPaintProperty('waypoints-circle', 'circle-color', state.paints.waypointCircleColor);
  map.setPaintProperty('waypoints-circle', 'circle-stroke-color', state.paints.waypointCircleStrokeColor);
  map.setPaintProperty('live-marker-pulse', 'circle-radius', state.paints.pulseRadius);
  map.setPaintProperty('live-marker-pulse', 'circle-opacity', state.paints.pulseOpacity);

  map.render(
    {
      zoom: state.camera.zoom,
      bearing: state.camera.bearing,
      pitch: state.camera.pitch,
      center: [state.camera.center.lng, state.camera.center.lat],
      width: viewport.width,
      height: viewport.height,
    },
    (err: Error | undefined, buf: Uint8Array | undefined) => {
      if (err || !buf) {
        process.stderr.write(
          `[renderer] render error at frame ${cmd.frame_index} t=${t}: ${err?.message ?? 'no buffer'}\n`,
        );
        process.exit(1);
      }
      writeFrame(buf);
      done();
    },
  );
}

// ---- Stdin loop -----------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin });

// Render commands have async completion (the maplibre-native render callback
// fires after tile fetches resolve). We serialize commands by buffering
// stdin lines and processing one at a time. setup/recycle/shutdown are
// synchronous from our POV; render is async-with-callback.
const queue: string[] = [];
let busy = false;
let stdinClosed = false;

function processNext(): void {
  if (busy) return;
  const line = queue.shift();
  if (line === undefined) {
    if (stdinClosed) {
      if (map) { try { map.release(); } catch { /* ignore */ } }
      process.exit(0);
    }
    return;
  }
  busy = true;
  let cmd: Cmd;
  try {
    cmd = JSON.parse(line) as Cmd;
  } catch (e) {
    // Malformed JSON is a fail-fast contract violation per spec
    // §"Implementation notes" → discriminator behavior.
    process.stderr.write(`[renderer] malformed JSON: ${(e as Error).message}\n`);
    process.exit(1);
  }
  switch (cmd.cmd) {
    case 'setup':
      setup(cmd).then(
        () => {
          writeReady();
          busy = false;
          processNext();
        },
        (e: Error) => {
          process.stderr.write(`[renderer] setup failed: ${e.message}\n`);
          process.exit(1);
        },
      );
      break;
    case 'render':
      renderFrame(cmd, () => {
        busy = false;
        processNext();
      });
      break;
    case 'recycle':
      recycle().then(
        () => {
          writeReady();
          busy = false;
          processNext();
        },
        (e: Error) => {
          process.stderr.write(`[renderer] recycle failed: ${e.message}\n`);
          process.exit(1);
        },
      );
      break;
    case 'shutdown':
      if (map) { try { map.release(); } catch { /* ignore */ } }
      process.exit(0);
      break;
    default: {
      const c: { cmd?: string } = cmd as { cmd?: string };
      process.stderr.write(`[renderer] unknown cmd, ignoring: ${c.cmd}\n`);
      busy = false;
      processNext();
    }
  }
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  queue.push(line);
  processNext();
});

// EOF handling: drain queued commands first, then exit cleanly. If we
// process.exit immediately on rl close, in-flight async work (setup's style
// fetch, render's tile fetches) gets cancelled silently. Setting a flag
// causes processNext to exit once the queue empties and no command is busy.
rl.on('close', () => {
  stdinClosed = true;
  if (!busy && queue.length === 0) {
    if (map) { try { map.release(); } catch { /* ignore */ } }
    process.exit(0);
  }
});
