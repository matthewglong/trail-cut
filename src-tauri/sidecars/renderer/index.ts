// Renderer worker. Long-running Node sidecar that produces map frames
// headlessly via puppeteer-core driving a full Chrome (new headless mode)
// instance running maplibre-gl-js. Communicates with the Rust orchestrator
// over a line-delimited-JSON-on-stdin / length-prefixed-RGBA-on-stdout
// protocol.
//
// Why full Chrome and not chrome-headless-shell: shell has no GPU path on
// macOS, so WebGL falls back to SwiftShader (software). Maplibre's first
// paint stalls badly on software WebGL — readPixels takes seconds, the GPU
// process can crash, the page tears down mid-evaluate. New headless mode
// (`headless: true` in puppeteer ≥22) routes WebGL through ANGLE→Metal on
// Apple Silicon and avoids the entire failure mode.
//
// Why headless-Chromium and not maplibre-native: the C++ engine (used
// through tasks 010–117) produces visible wobble on slow camera pans
// (sub-pixel deltas snap to the integer pixel grid). The browser painter,
// with `options.moving = true` forced via a 4-line monkey-patch in
// page/init.ts, does not. See docs/export/plans/chromium-renderer.md for
// the full migration history; tasks 115–119 ran the cutover.
//
// Visual parity by import — the load-bearing invariant. Every visual
// decision (style spec, layer specs, source data, animation curves,
// camera math) lives in src/lib/mapVisuals/, src/lib/cameraIntent.ts,
// src/lib/routeLocation.ts. This worker imports the same modules the
// preview's MapView.tsx uses; it never redefines them.
//
// Process model: one Browser per worker, one Page per browser. Recycle
// closes and reopens the Page (cheap: clears per-page allocations,
// preserves browser state). Every M=10 page-recycles, also relaunch the
// Browser (layered defense against accumulated allocator fragmentation).
// Orchestrator never sees the inner browser-restart — same wire format
// either way.

import readline from 'node:readline';
import https from 'node:https';
import http from 'node:http';
import zlib from 'node:zlib';

import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { PNG } from 'pngjs';

// ---- Verbose-mode flag ----------------------------------------------------
//
// Default OFF. Diagnostic breadcrumbs (per-frame eval/screenshot/decode
// markers, page-side __init/__applyFrame chatter, idle-wait diagnostic,
// heartbeat) are gated behind this. Always-on output is limited to one
// summary timing line per frame (renderFrame) plus errors/protocol traffic.
// Toggle with `TRAILCUT_RENDERER_VERBOSE=1`.
const VERBOSE = process.env.TRAILCUT_RENDERER_VERBOSE === '1';
function verbose(msg: string): void {
  if (VERBOSE) process.stderr.write(msg);
}

// Pixel-readback transport. Default = `readpixels` (page-side gl.readPixels
// → base64 → Node base64-decode). Set TRAILCUT_RENDERER_TRANSPORT=png to
// fall back to the original Page.captureScreenshot + pngjs decode path
// (kept as an escape hatch / for parity comparisons). The readpixels path
// skips two encode/decode hops (Chrome PNG encode + pngjs decode) and is
// the highest-leverage perf fix from the chromium-renderer perf review.
const TRANSPORT: 'readpixels' | 'png' =
  process.env.TRAILCUT_RENDERER_TRANSPORT === 'png' ? 'png' : 'readpixels';

// `page.evaluate` callbacks run in the browser context, where `window` and
// our injected globals (__init, __applyFrame, trailcutFetch) live. The
// worker's tsconfig is Node-only; this minimal declaration tells tsc not
// to error on cross-context references inside evaluate callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const window: any;

import {
  buildStyleSpec,
  buildStaticSourceData,
  buildPerFrameState,
  buildAllShapeIcons,
  DEFAULT_OUTLINE_THICKNESS,
  resolveStaticPaints,
  BUILDINGS_LAYER_SPEC,
  LIVE_MARKER_PULSE_LAYER,
  LIVE_MARKER_PULSE_B_LAYER,
  LIVE_MARKER_DOT_LAYER,
  ROUTE_FULL_LAYER,
  ROUTE_TRAIL_LAYER,
  WAYPOINTS_ACTIVE_HALO_LAYER,
  WAYPOINTS_PRIMARY_LAYER,
  WAYPOINTS_SECONDARY_LAYER,
} from '../../../src/lib/mapVisuals';
import {
  activeClipIdAt,
  type CompiledTimeline,
} from '../../../src/lib/cameraIntent';
import { indexRoute, type IndexedRoute } from '../../../src/lib/routeLocation';
import { resolveMapSettings, type Clip, type Route, type MapSettings, type Waypoint } from '../../../src/types';

import { createTileCache, defaultCacheDir, type TileCache } from './tileCache';
import { bridgeFetchFactory } from './trailcutFetch';
import { buildBootstrapHtml } from './bootstrap.html';

// ---- Protocol types -------------------------------------------------------

interface SetupCmd {
  cmd: 'setup';
  /** CSS-pixel viewport dimensions the renderer page is laid out at. `w`
   *  always equals `canonicalMapCssWidth(aspect)`; `h` is derived from the
   *  framebuffer height divided by `pixelRatio` so map_slot's own aspect
   *  (which can differ from the full export's aspect in composite layouts)
   *  is preserved. */
  cssViewport: { w: number; h: number };
  /** High-res WebGL drawing buffer the renderer paints into — the map slot
   *  pixel dims × the SSAA supersample factor. */
  framebuffer: { w: number; h: number };
  /** Dims the renderer downsamples `framebuffer` to (on-GPU) and writes back
   *  — equals the map slot pixel dims. The returned RGBA buffer is sized to
   *  these (`readback.w * readback.h * 4`), so supersampling never inflates
   *  the wire. */
  readback: { w: number; h: number };
  /** `framebuffer.w / cssViewport.w` (a float; carries the supersample
   *  factor, so > 1 for every supersampled export). Fed to MapLibre's
   *  `pixelRatio` constructor arg and to `page.setViewport`'s
   *  `deviceScaleFactor`. */
  pixelRatio: number;
  fps: number;
  timeline: CompiledTimeline;
  route: Route | null;
  clips: Clip[];
  mapSettings: MapSettings;
  /** First-class waypoints (schema v7). Drives the `waypoints` GeoJSON
   *  source; replaces the pre-v7 clip-derived list. Always present (`[]`
   *  when the project has none) so the worker doesn't need to handle a
   *  missing field. */
  waypoints: Waypoint[];
}
interface RenderCmd {
  cmd: 'render';
  frame_index: number;
  project_time_ms: number;
}
interface RecycleCmd { cmd: 'recycle' }
interface ShutdownCmd { cmd: 'shutdown' }
type Cmd = SetupCmd | RenderCmd | RecycleCmd | ShutdownCmd;

// ---- Config knobs ---------------------------------------------------------

/** Recycle the Browser entirely after this many Page recycles. Layered
 *  defense per docs/export/plans/chromium-renderer.md §2.2; the
 *  orchestrator already issues `recycle` on its own cadence (default 60
 *  frames per task 030), so this counts orchestrator-driven recycles.
 *  10 page recycles ≈ 600 frames between browser restarts at default
 *  cadence — plenty for any single export, near-zero overhead. */
const BROWSER_RESTART_EVERY_RECYCLES = 10;

// ---- State ----------------------------------------------------------------

let browser: Browser | null = null;
let page: Page | null = null;
let setupPayload: SetupCmd | null = null;
let indexedRoute: IndexedRoute | null = null;
let recycleCountThisBrowser = 0;

// Signal-based completion handshake for __init. We can't `await` the
// Promise returned by `page.evaluate((p) => window.__init(p))` directly
// because puppeteer's evaluate sets `awaitPromise: true` on the CDP
// `Runtime.callFunctionOn` call, and V8's Inspector can GC the awaited
// Promise before it observes resolution under heap pressure (the page is
// allocating freely while maplibre boots its tile cache, decodes glyphs
// and sprites through trailcutFetch, builds source/layer state). The
// failure surfaces as `ProtocolError: Promise was collected` *after*
// __init has logged its final `done` breadcrumb — proof the page-side
// function ran fine; only the protocol-level Promise tracking lost it.
// (When Chrome doesn't notice the GC at all, no response is sent and the
// symptom is `Runtime.callFunctionOn timed out` after protocolTimeout —
// same root cause, different observation.)
//
// Workaround: have the page kick off __init fire-and-forget (the outer
// evaluate returns `undefined` synchronously, no awaitPromise needed),
// then call this exposed function on completion. The worker awaits a
// local Node-side Promise, which has no V8-GC vulnerability.
let pendingInitSignal:
  | ((status: { ok: boolean; error?: string }) => void)
  | null = null;

// Same handshake, applied to __applyFrame. The first __applyFrame call
// after setup/recycle hits the same heap-pressure window as __init: cold
// tile cache fills as the actual viewport's tiles flow through
// trailcutFetch, raster + glyph decodes pile up, the awaited Promise is
// vulnerable to V8 Inspector GC. Steady-state __applyFrame doesn't
// allocate as much, but using the same handshake unconditionally costs
// only one extra CDP round-trip per frame (~1 ms; dwarfed by the ~100 ms
// render cost) and removes the failure mode entirely. The result —
// `{ rgbaB64: string | null } | null` — flows through the exposed
// function arg, which goes through the same CDP serialization the
// evaluate return value would have used.
let pendingApplyFrameSignal:
  | ((status: {
      ok: boolean;
      result?: { rgbaB64: string | null } | null;
      error?: string;
    }) => void)
  | null = null;

// Liveness telemetry. The orchestrator and the worker talk over pipes;
// from the operator's seat, a stalled export looks identical to a busy
// one — both are silent. `currentActivity` describes what the worker
// thinks it is doing, `activityStartedAt` is the wall-clock when that
// activity began. The heartbeat interval (set up at module bottom)
// prints both every N seconds, so a hang has visible elapsed-in-state.
let currentActivity = 'starting';
let activityStartedAt = Date.now();
function setActivity(label: string): void {
  currentActivity = label;
  activityStartedAt = Date.now();
}
const tileCache: TileCache = createTileCache({
  dir: process.env.TRAILCUT_TILE_CACHE_DIR ?? defaultCacheDir(),
  offline: process.env.TRAILCUT_TILE_CACHE_OFFLINE === '1',
});

// ---- Tile fetcher (cache miss path) ---------------------------------------

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

// ---- Browser / Page lifecycle --------------------------------------------

function chromeBinaryPath(): string {
  const p = process.env.TRAILCUT_CHROME_BIN;
  if (!p) {
    throw new Error(
      'TRAILCUT_CHROME_BIN env var not set. The orchestrator is responsible ' +
      'for resolving the bundled Chrome binary and passing it to the worker; ' +
      'in dev, set it manually to a Chrome executable path (e.g. ' +
      '<repo>/src-tauri/binaries/chrome-<triple>/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing).',
    );
  }
  return p;
}

async function launchBrowser(): Promise<Browser> {
  // ANGLE backend per platform. On macOS (the only supported host today),
  // Metal is the hardware path; ANGLE routes WebGL through it. On other
  // platforms we let Chrome pick the default — task 130 will revisit when
  // Windows/Linux land.
  const angleArg = process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=default';

  const browser = await puppeteer.launch({
    executablePath: chromeBinaryPath(),
    // New headless mode (puppeteer ≥22). Unlike `headless: 'shell'`, this
    // runs full Chrome with GPU access available — exactly the property
    // the chrome-headless-shell path lacked, which is why software WebGL
    // was the only option there and why first-paint kept tearing the
    // page down on slow ReadPixels.
    headless: true,
    args: [
      // Determinism / off-screen rendering.
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu-vsync',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      // Hardware GPU via ANGLE. On Apple Silicon this lights up Metal.
      angleArg,
      // Force enable WebGL for headless. Default in new headless mode is
      // already enabled, but explicit costs nothing.
      '--enable-webgl',
    ],
    // Forward Chrome's own stderr (renderer crash logs, GPU process
    // failures, OOM signals from the OS) into the worker's stderr so the
    // orchestrator's stderr ring captures it. Without this, a renderer-
    // process death surfaces only as the opaque "Promise was collected"
    // ProtocolError that puppeteer raises when its CDP target detaches.
    dumpio: true,
    // Don't time out on launch — slow CI hosts can take a while.
    timeout: 60_000,
    // Per-CDP-command timeout. Cold-start first paint can still take
    // double-digit seconds on the GPU path; default 180s is enough but
    // 600s gives headroom for cold caches on large multi-clip projects
    // where the first __applyFrame fans out tens of concurrent tile
    // fetches through trailcutFetch. The signal-handshake workaround in
    // renderFrame (and applySetup) is the actual fix for V8-Inspector
    // GC of awaited Promises; this timeout is now defense in depth for
    // genuine slow paths (network-bound tile cold-fetches).
    protocolTimeout: 600_000,
  });

  // Surface tear-down diagnostics. Without these, a renderer-subprocess
  // crash lands as a generic "Promise was collected" with no clue why.
  browser.on('disconnected', () => {
    process.stderr.write('[renderer] browser disconnected\n');
  });
  browser.on('targetdestroyed', (target) => {
    process.stderr.write(`[renderer] target destroyed: ${target.type()} ${target.url()}\n`);
  });

  return browser;
}

async function buildPage(b: Browser): Promise<Page> {
  const p = await b.newPage();

  // Forward page console + page errors to worker stderr so failures are
  // diagnosable. Orchestrator forwards worker stderr to its own stderr
  // already. In quiet mode, drop console.log/info/debug (the page-side
  // breadcrumbs that follow the same VERBOSE gate); always keep warn/
  // error/assert so unexpected page-side output still surfaces.
  p.on('console', (msg) => {
    const t = msg.type();
    if (!VERBOSE && (t === 'log' || t === 'info' || t === 'debug')) return;
    process.stderr.write(`[console:${t}] ${msg.text()}\n`);
  });
  p.on('pageerror', (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? `\n${err.stack}` : '';
    process.stderr.write(`[pageerror] ${msg}${stack}\n`);
  });
  p.on('error', (err: unknown) => {
    // 'error' fires on page crash (Chrome process killed, OOM). Without
    // this listener, page crashes surface only as "Promise was collected".
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[page-crash] ${msg}\n`);
  });

  // Expose the cache bridge before setting content so the page-side
  // addProtocol loader can call window.trailcutFetch synchronously after
  // page-script execution.
  await p.exposeFunction('trailcutFetch', bridgeFetchFactory(tileCache, fetchUrl));

  // Completion signal for __init — see `pendingInitSignal` comment above.
  // Registered once per page; applySetup wires up the resolver per call.
  await p.exposeFunction(
    '__signalInitDone',
    (status: { ok: boolean; error?: string }) => {
      const cb = pendingInitSignal;
      pendingInitSignal = null;
      if (cb) cb(status);
      else process.stderr.write('[renderer] __signalInitDone fired with no pending listener\n');
    },
  );

  // Completion signal for __applyFrame — same shape as the __init handshake,
  // sidestepping the V8-Inspector-GC vulnerability that the protocolTimeout
  // surfaced as `Runtime.callFunctionOn timed out` on cold-start frame 0 of
  // a 71-clip export. renderFrame wires up the resolver per call.
  await p.exposeFunction(
    '__signalApplyFrameDone',
    (status: {
      ok: boolean;
      result?: { rgbaB64: string | null } | null;
      error?: string;
    }) => {
      const cb = pendingApplyFrameSignal;
      pendingApplyFrameSignal = null;
      if (cb) cb(status);
      else process.stderr.write('[renderer] __signalApplyFrameDone fired with no pending listener\n');
    },
  );

  await p.setContent(buildBootstrapHtml(), { waitUntil: 'load' });
  return p;
}

async function applySetup(p: Page, payload: SetupCmd): Promise<void> {
  const t0 = Date.now();
  const stamp = (msg: string): void => {
    verbose(`[renderer applySetup +${Date.now() - t0}ms] ${msg}\n`);
  };

  // Match the Page's viewport to the requested CSS-viewport dims, with
  // `deviceScaleFactor` set to the export's `pixelRatio`. Together these
  // give MapLibre a framebuffer of `cssViewport.w * pixelRatio` ×
  // `cssViewport.h * pixelRatio`, which (by construction in build_setup_payload)
  // matches the requested map_slot pixel dims.
  stamp(
    `before setViewport css=${payload.cssViewport.w}x${payload.cssViewport.h} ` +
    `dpr=${payload.pixelRatio} fb=${payload.framebuffer.w}x${payload.framebuffer.h}`,
  );
  await p.setViewport({
    width: payload.cssViewport.w,
    height: payload.cssViewport.h,
    deviceScaleFactor: payload.pixelRatio,
  });
  stamp('after setViewport');

  const { style } = buildStyleSpec(payload.mapSettings);

  const staticData = buildStaticSourceData({
    route: payload.route,
    waypoints: payload.waypoints,
    mapSettings: payload.mapSettings,
  });
  stamp('static source data built');

  const emptyLine: GeoJSON.Feature<GeoJSON.LineString> = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: [] },
  };
  const emptyFc: GeoJSON.FeatureCollection<GeoJSON.Point> = {
    type: 'FeatureCollection',
    features: [],
  };

  // Static sources/layers — order matches renderer/index.ts buildMap so
  // stacking is identical.
  //
  // `lineMetrics: true` on both route sources is mandatory for the
  // `line-gradient` paint expression `resolveStaticPaints` emits in
  // gradient mode. It MUST be set at `addSource` time — adding it later is
  // a no-op. Preview-side, MapView.tsx adds the same flag on its own
  // addSource sites; both sides must match for preview/export parity.
  const staticSources: Array<[string, unknown]> = [
    ['route-full', { type: 'geojson', data: staticData['route-full'], lineMetrics: true }],
    ['route-trail', { type: 'geojson', data: emptyLine, lineMetrics: true }],
    ['waypoints', { type: 'geojson', data: staticData.waypoints }],
    ['live-marker', { type: 'geojson', data: emptyFc }],
  ];
  // Layer stack on the shared `waypoints` source mirrors MapView.tsx
  // (bottom → top):
  //   waypoints-active-halo → waypoints-primary → waypoints-secondary → waypoints-label
  // Both primary and secondary are SDF symbol layers; primary paints the
  // filled silhouette tinted by the primary color, secondary stacks above
  // and paints the outline / accent tinted by the secondary color. Shapes
  // without a declared secondary rasterizer register a transparent
  // placeholder so the secondary layer stays valid. The halo sits BELOW
  // the shape layers; the label rides on the secondary symbol layer so
  // icon + text share one placement unit (see WAYPOINTS_SECONDARY_LAYER).
  const staticLayers: unknown[] = [
    ROUTE_FULL_LAYER,
    ROUTE_TRAIL_LAYER,
    WAYPOINTS_ACTIVE_HALO_LAYER,
    WAYPOINTS_PRIMARY_LAYER,
    WAYPOINTS_SECONDARY_LAYER,
    LIVE_MARKER_PULSE_LAYER,
    LIVE_MARKER_PULSE_B_LAYER,
    LIVE_MARKER_DOT_LAYER,
  ];

  // SDF icon payload — every waypoint shape × both slots (primary +
  // secondary). Each entry is [id, { width, height, data: Uint8Array },
  // options] — the exact shape `map.addImage(id, image, options)` accepts.
  // Pixels come from `buildAllShapeIcons` in shapes.ts (a pure function
  // shared with the preview); each side passes its own framebuffer
  // pixelRatio so the resulting texture density matches the framebuffer
  // it'll be drawn into. MapLibre normalizes back to a constant CSS-px
  // display size via the matching `options.pixelRatio`.
  //
  // The Uint8Array survives `JSON.stringify` in page.evaluate as a plain
  // {0:n, 1:n, ...} object; page-side __init reconstructs a Uint8Array
  // from it before handing the buffer to `map.addImage()`. Atlas size
  // scales with pixelRatio²: at pixelRatio=2 each icon is 256×256×4 B =
  // 256 KB raw (5 shapes × 2 slots = 2.5 MB raw, ~10 MB after JSON
  // expansion) — well under CDP's argument-size threshold.
  // Rasterize the SDF atlas at the EXPORT framebuffer's pixelRatio so the
  // icons get the same texel density the map tiles render at. Without the
  // matching `pixelRatio` in addImage's options below, MapLibre would treat
  // the atlas as 1:1 and silently upscale at draw time — the icons would
  // sample at half (or third) framebuffer density while the vector tiles
  // render at native density, producing visibly grainy waypoint/POI edges
  // against a crisp map. The icon-size formula in paints.ts is invariant
  // under pixelRatio because addImage's `pixelRatio` field normalizes the
  // icon's natural CSS-px display size back to a constant.
  const staticImages: Array<[
    string,
    { width: number; height: number; data: Uint8Array },
    { sdf: boolean; pixelRatio: number },
  ]> = buildAllShapeIcons({
    outlineThickness: DEFAULT_OUTLINE_THICKNESS,
    pixelRatio: payload.pixelRatio,
  }).map(({ id, icon, options }) => [
    id,
    { width: icon.width, height: icon.height, data: icon.data },
    options,
  ]);

  // Static paint sizing + layouts — layer specs ship placeholder values for
  // every paint/layout property that derives from `mapSettings`
  // (placeholder `1`s for sizes, `''` for the label text-field). Real
  // values come from `resolveStaticPaints(mapSettings)`, which is the
  // single source of truth shared with MapView.tsx; the page applies the
  // returned tuples via setPaintProperty / setLayoutProperty after
  // style.load, before the first frame. This is the *initial seed* using
  // project defaults — per-frame the renderer re-resolves with each active
  // clip's `map_overrides` and ships the updated values inside
  // `frame.paints` / `frame.layouts`, so per-clip overrides of any field
  // (overlay sizes, route_mode visibility, label_mode expression, etc.)
  // take effect at the cut.
  const staticPaintResolution = resolveStaticPaints(payload.mapSettings);

  const initPayload = {
    style,
    cssViewport: payload.cssViewport,
    framebuffer: payload.framebuffer,
    readback: payload.readback,
    pixelRatio: payload.pixelRatio,
    add3dBuildings: payload.mapSettings.camera.map_style === '3d',
    staticSources,
    staticLayers,
    staticPaints: staticPaintResolution.paints,
    staticLayouts: staticPaintResolution.layouts,
    // Line-gradient expressions for `route-full-line` / `route-trail-line`.
    // Gradient mode ships an `interpolate` expression; solid mode ships
    // `null` so the page's __init clears any stale `line-gradient` from a
    // prior style (defense-in-depth — at first init the property is unset
    // anyway). Same per-frame channel below (`frame.gradients`) re-resolves
    // these against the active clip's `MapSettings`, so per-clip overrides
    // (none today, but the wiring stays consistent with paints/layouts).
    staticGradients: staticPaintResolution.gradients,
    // SDF icons for the waypoint primary + secondary symbol layers.
    // [id, { width, height, data },
    // options] tuples. Built once here from `buildAllWaypointSdfIcons()` —
    // the same pure function MapView.tsx calls in onStyleLoad — so preview
    // and export register bit-identical pixels. The page's __init loops
    // over this AFTER static layers are added and calls
    // `map.addImage(name, image, options)`. Re-shipped on every applySetup
    // (including post-recycle) so the SDF atlas is restored when a fresh
    // page is constructed.
    staticImages,
    buildingsLayer: payload.mapSettings.camera.map_style === '3d' ? BUILDINGS_LAYER_SPEC : null,
    // Page-side opts. `verbose` gates the page's __init/__applyFrame
    // breadcrumbs and the in-flight idle-wait diagnostic. `transport`
    // selects the readback path: 'readpixels' (default) returns raw RGBA
    // via gl.readPixels + base64 over CDP; 'png' is the legacy escape
    // hatch — page-side code in 'png' mode skips the readback entirely
    // and the worker takes a screenshot.
    verbose: VERBOSE,
    transport: TRANSPORT,
  };

  // Surface initPayload size — `page.evaluate` ships the argument through
  // CDP's Runtime.callFunctionOn as serialized JSON. Big LineStrings (a
  // 6000-point GPX route is ~12000 numbers ≈ 200 KB serialized) plus an
  // inlined style spec can push past CDP's argument-size threshold; if
  // this is large, the very next evaluate is the prime suspect for
  // "Promise was collected".
  const initPayloadJson = JSON.stringify(initPayload);
  const routeFullBytes = JSON.stringify(staticData['route-full']).length;
  const styleBytes = JSON.stringify(style).length;
  // Count route coordinates if shape matches.
  let routeCoordCount = 0;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g: any = (staticData['route-full'] as any).geometry;
    if (g && Array.isArray(g.coordinates)) routeCoordCount = g.coordinates.length;
  } catch { /* ignore */ }
  stamp(
    `initPayload built: total=${initPayloadJson.length}B ` +
    `style=${styleBytes}B route-full=${routeFullBytes}B routeCoords=${routeCoordCount} ` +
    `staticLayers=${staticLayers.length} ` +
    `staticPaints=${staticPaintResolution.paints.length} ` +
    `staticLayouts=${staticPaintResolution.layouts.length} ` +
    `staticImages=${staticImages.length}`,
  );

  // Set up the signal-based handshake BEFORE kicking off __init so we
  // can't miss a fast resolution. See `pendingInitSignal` comment.
  if (pendingInitSignal) {
    // Defensive — applySetup is awaited sequentially per worker, so this
    // should never fire. Drop the stale resolver if it does.
    process.stderr.write('[renderer] applySetup: dropping stale pendingInitSignal\n');
    pendingInitSignal = null;
  }
  const initSignal = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    pendingInitSignal = resolve;
  });

  stamp('before page.evaluate(__init kickoff)');
  // Fire-and-forget. The outer arrow function returns `undefined`
  // synchronously, so CDP's awaitPromise has nothing to track — no
  // long-running Promise for V8 to GC. The page-side __init runs to
  // completion in the background and signals via window.__signalInitDone,
  // which resolves `initSignal` on the Node side.
  await p.evaluate((payload: typeof initPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    void w.__init(payload).then(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => w.__signalInitDone({ ok: true }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e: any) => w.__signalInitDone({
        ok: false,
        error: String((e && e.message) ?? e),
      }),
    );
  }, initPayload);
  stamp('kickoff evaluate returned, awaiting __signalInitDone');

  const status = await initSignal;
  stamp(`__init signal received: ${status.ok ? 'ok' : `error=${status.error}`}`);
  if (!status.ok) {
    throw new Error(`__init failed in page: ${status.error ?? 'unknown'}`);
  }
  stamp('after page.evaluate(__init) resolved');
}

// ---- Setup / recycle ------------------------------------------------------

async function setup(payload: SetupCmd): Promise<void> {
  const t0 = Date.now();
  setupPayload = payload;
  if (!browser) {
    browser = await launchBrowser();
    verbose(`[renderer] browser launched at ${Date.now() - t0}ms\n`);
  }
  if (page) {
    try { await page.close(); } catch { /* ignore */ }
    page = null;
  }
  page = await buildPage(browser);
  verbose(`[renderer] page ready at ${Date.now() - t0}ms\n`);
  await applySetup(page, payload);
  // Always emit a single setup-summary line — useful for spotting cold-
  // start cost in the orchestrator log without enabling verbose mode.
  process.stderr.write(`[renderer] setup done in ${Date.now() - t0}ms (transport=${TRANSPORT}, verbose=${VERBOSE})\n`);
  indexedRoute = indexRoute(payload.route);
}

async function recycle(): Promise<void> {
  if (!setupPayload) {
    process.stderr.write('[renderer] recycle without prior setup, ignoring\n');
    return;
  }
  recycleCountThisBrowser += 1;

  // Layered defense — every Nth recycle, also relaunch the browser. The
  // orchestrator never sees the difference; same wire bytes either way.
  const shouldRestartBrowser =
    recycleCountThisBrowser >= BROWSER_RESTART_EVERY_RECYCLES;

  if (page) {
    try { await page.close(); } catch { /* ignore */ }
    page = null;
  }
  if (shouldRestartBrowser && browser) {
    try { await browser.close(); } catch { /* ignore */ }
    browser = null;
    recycleCountThisBrowser = 0;
  }
  if (!browser) {
    browser = await launchBrowser();
  }
  page = await buildPage(browser);
  await applySetup(page, setupPayload);
  indexedRoute = indexRoute(setupPayload.route);
}

// ---- Per-frame render -----------------------------------------------------

async function renderFrame(cmd: RenderCmd): Promise<void> {
  const tStart = Date.now();
  const fstamp = (msg: string): void => {
    verbose(
      `[renderer renderFrame f=${cmd.frame_index} +${Date.now() - tStart}ms] ${msg}\n`,
    );
  };
  if (!setupPayload || !page) {
    process.stderr.write('[renderer] render before setup, exiting\n');
    process.exit(1);
  }
  const t = cmd.project_time_ms;
  const payload = setupPayload;
  // Camera math runs in CSS-pixel space, matching the preview MapView. dpr
  // is the export pixelRatio so any zoom-correction helpers downstream that
  // multiply by dpr get the framebuffer's actual scale.
  const viewport = {
    width: payload.cssViewport.w,
    height: payload.cssViewport.h,
    dpr: payload.pixelRatio,
  };

  const activeClipId = activeClipIdAt(payload.timeline, t);

  // Resolve the active clip's MapSettings (project defaults merged with
  // that clip's `map_overrides`), so per-clip overlay-size variations
  // render correctly. Outside a clip (gap, pre-roll), fall back to project
  // defaults — those frames are typically held end-states between transitions.
  const activeClip = activeClipId
    ? payload.clips.find((c) => c.id === activeClipId) ?? null
    : null;
  const resolvedMapSettings: MapSettings = resolveMapSettings(
    payload.mapSettings,
    activeClip?.map_overrides,
  );

  const state = buildPerFrameState(
    payload.timeline,
    t,
    indexedRoute,
    payload.clips,
    payload.waypoints,
    resolvedMapSettings,
    viewport,
  );

  // `activeClipId` was the pre-v7 selector for the waypoint highlight; the
  // active-waypoint highlight is now driven inside `buildPerFrameState` via
  // the marker's wall-clock comparison + `active_waypoint_mode`. Keep the
  // local resolved here for the existing per-clip `map_overrides` lookup
  // above; nothing else reads it.
  void activeClipId;

  // Re-resolve static paints from the active clip's settings. The page
  // applies these as setPaintProperty / setLayoutProperty per frame so any
  // per-clip overlay-size override (route line width, waypoint stroke,
  // dot radius / stroke, label size) takes effect at the cut. Cost is
  // ~7 setPaintProperty + 1 setLayoutProperty calls per frame; maplibre
  // no-ops same-value writes internally.
  const staticResolution = resolveStaticPaints(resolvedMapSettings);

  // Translate state.sources (Record) and state.paints (named fields) into
  // serializable arrays for the page-side __applyFrame. The wire format
  // here is JSON; tuples beat objects for compactness across page.evaluate.
  const sources: Array<[string, unknown]> = Object.entries(state.sources);
  const paints: Array<[string, string, unknown]> = [
    ...staticResolution.paints,
    // Primary + secondary `icon-color` flow as data-driven case expressions
    // from buildPerFramePaints (override > active > base for each slot).
    // The SDF tint at draw time turns the white-ink rasters into the
    // user's chosen colors, identically across preview and export.
    ['waypoints-primary', 'icon-color', state.paints.waypointPrimaryColor],
    ['waypoints-secondary', 'icon-color', state.paints.waypointSecondaryColor],
    // Active-waypoint halo ([DECIDED] Q2). Always-seeded layer; radius and
    // opacity collapse to 0 when no waypoint is active, so the layer stays
    // invisible without `visibility` toggling. Color tracks the active
    // primary's resolved color (or `mapSettings.waypoints.active_color`
    // when set) so preview and export composite identically.
    ['waypoints-active-halo', 'circle-radius', state.paints.waypointHaloRadius],
    ['waypoints-active-halo', 'circle-color', state.paints.waypointHaloColor],
    ['waypoints-active-halo', 'circle-opacity', state.paints.waypointHaloOpacity],
    ['live-marker-pulse', 'circle-radius', state.paints.pulseRadius],
    ['live-marker-pulse', 'circle-opacity', state.paints.pulseOpacity],
    // B-ring always seeded; opacity 0 outside heartbeat style.
    ['live-marker-pulse-b', 'circle-radius', state.paints.pulseRadiusB],
    ['live-marker-pulse-b', 'circle-opacity', state.paints.pulseOpacityB],
    // Dot opacity oscillates in `throb` (sine wave 0.35 → 1.0); held at
    // 1.0 in steady / sonar / heartbeat per shapes-pov.md Part 2 §2.
    ['live-marker-dot', 'circle-opacity', state.paints.dotOpacity],
  ];
  // `icon-size` is a layout property (not paint), so the active-state size
  // bump rides the layouts channel. Both symbol layers get the same value
  // so the outline tracks the fill at every size.
  const layouts: Array<[string, string, unknown]> = [
    ...staticResolution.layouts,
    ['waypoints-primary', 'icon-size', state.paints.waypointIconSize],
    ['waypoints-secondary', 'icon-size', state.paints.waypointIconSize],
    // `symbol-sort-key` channels for the two waypoint symbol layers.
    // Primary (filled silhouette) uses the DRAW key (negative distance —
    // higher sort-key paints later, on top) because the layer keeps
    // `icon-allow-overlap: true` and every fill must render. Secondary
    // (outline + label, co-placed in one symbol layer) uses the PLACEMENT
    // key (positive distance — lower sort-key wins placement) because
    // that layer runs with `allow-overlap: false` on both icon and text,
    // leaning on MapLibre's collision detection to hide back markers that
    // would otherwise paint over the front fill. See `paints.ts`.
    ['waypoints-primary', 'symbol-sort-key', state.paints.waypointSortKey],
    ['waypoints-secondary', 'symbol-sort-key', state.paints.waypointPlacementKey],
  ];
  // Per-frame line-gradient expressions. Re-resolved from the active clip's
  // merged `MapSettings` so any future per-clip route-color override flows
  // through the same channel paints/layouts use. Today's MapOverrides shape
  // doesn't expose `route.color` (route is one continuous geometry; per-clip
  // route color would force invented boundaries), so per-frame the value
  // always matches the static seed — MapLibre no-ops same-value writes.
  const gradients: Array<[string, unknown]> = staticResolution.gradients;

  const framePayload = {
    t,
    sources,
    paints,
    layouts,
    gradients,
    camera: {
      center: { lng: state.camera.center.lng, lat: state.camera.center.lat },
      zoom: state.camera.zoom,
      bearing: state.camera.bearing,
      pitch: state.camera.pitch,
    },
  };

  fstamp(`entry t=${t}ms activeClip=${activeClipId ?? 'none'}`);

  // ---- 1) page.evaluate(__applyFrame): apply deltas + camera + idle ----
  // In readpixels mode, __applyFrame *also* performs the readback and
  // returns a base64-encoded RGBA buffer. In png mode it returns null and
  // the worker takes a Page.captureScreenshot below.
  //
  // Fire-and-forget + signal handshake (mirrors applySetup's __init
  // pattern) — the outer evaluate returns synchronously so puppeteer's
  // CDP `Runtime.callFunctionOn` sets `awaitPromise: false` and is not
  // exposed to V8-Inspector GC of the awaited Promise. Page-side
  // __applyFrame's actual completion is signaled via __signalApplyFrameDone
  // (an exposeFunction registered in buildPage), which resolves a Node-
  // local Promise this `await` is on. See `pendingApplyFrameSignal` and
  // the matching __init plumbing for the failure mode this protects
  // against.
  if (pendingApplyFrameSignal) {
    process.stderr.write('[renderer] renderFrame: dropping stale pendingApplyFrameSignal\n');
    pendingApplyFrameSignal = null;
  }
  const evalStart = Date.now();
  const applySignal = new Promise<{ rgbaB64: string | null } | null>(
    (resolve, reject) => {
      pendingApplyFrameSignal = (status) => {
        if (status.ok) resolve(status.result ?? null);
        else reject(new Error(status.error ?? 'unknown __applyFrame error'));
      };
    },
  );
  await page.evaluate((p: typeof framePayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    void w.__applyFrame(p).then(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (r: any) => w.__signalApplyFrameDone({ ok: true, result: r ?? null }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e: any) => w.__signalApplyFrameDone({
        ok: false,
        error: String((e && e.message) ?? e),
      }),
    );
  }, framePayload);
  const applyResult = await applySignal;
  const evalMs = Date.now() - evalStart;
  fstamp(`applyFrame returned (${evalMs}ms, transport=${TRANSPORT})`);

  // ---- 2) Pixel readback ----
  let rgba: Buffer;
  let shotMs = 0;
  let decodeMs = 0;
  let pngBytes = 0;
  if (TRANSPORT === 'readpixels') {
    if (!applyResult || !applyResult.rgbaB64) {
      throw new Error('readpixels mode: __applyFrame did not return rgbaB64');
    }
    // Buffer.from(b64, 'base64') is native C++; ~10 MB base64 → 8 MB RGBA
    // in single-digit ms on M-series silicon. The cost we just shed: a
    // PNG encode in Chrome's GPU process (libpng, single-threaded) plus
    // a JS pngjs decode (zlib + filter pass on the Node thread). Both
    // were dwarfing the actual map render.
    const decodeStart = Date.now();
    rgba = Buffer.from(applyResult.rgbaB64, 'base64');
    decodeMs = Date.now() - decodeStart;
    // The page downsamples the supersampled framebuffer to `readback` (slot)
    // dims on-GPU before returning, so the buffer is readback-sized.
    const expected = payload.readback.w * payload.readback.h * 4;
    if (rgba.length !== expected) {
      throw new Error(
        `readpixels: got ${rgba.length}B, expected ${expected}B (${payload.readback.w}x${payload.readback.h}*4)`,
      );
    }
    fstamp(`readpixels decode ${rgba.length}B in ${decodeMs}ms`);
  } else {
    // Legacy PNG transport — Page.captureScreenshot then pngjs. The clip
    // rect is in CSS-pixel space; Chrome's screenshot encodes at the page's
    // device-scale-factor, so the decoded PNG is framebuffer-sized. The
    // on-GPU SSAA downsample lives only in the readpixels path's
    // captureFramebufferIntoBuf, so PNG can't produce readback-sized frames
    // when supersampling is active — fail loudly rather than emit wrong dims.
    if (payload.framebuffer.w !== payload.readback.w
      || payload.framebuffer.h !== payload.readback.h) {
      throw new Error(
        'PNG transport does not support SSAA supersampling '
        + `(framebuffer ${payload.framebuffer.w}x${payload.framebuffer.h} != `
        + `readback ${payload.readback.w}x${payload.readback.h}); use the default readpixels transport`,
      );
    }
    const shotStart = Date.now();
    const pngBuf = (await page.screenshot({
      type: 'png',
      captureBeyondViewport: false,
      omitBackground: true,
      fullPage: false,
      clip: { x: 0, y: 0, width: payload.cssViewport.w, height: payload.cssViewport.h },
    })) as Buffer;
    shotMs = Date.now() - shotStart;
    pngBytes = pngBuf.length;
    fstamp(`screenshot ${pngBuf.length}B in ${shotMs}ms`);
    const decodeStart = Date.now();
    rgba = await decodePngToRgba(pngBuf, payload.framebuffer.w, payload.framebuffer.h);
    decodeMs = Date.now() - decodeStart;
    fstamp(`png decoded ${rgba.length}B in ${decodeMs}ms`);
  }

  // ---- 3) Write RGBA to stdout ----
  const writeStart = Date.now();
  writeFrame(rgba);
  const writeMs = Date.now() - writeStart;
  fstamp('writeFrame done');

  // Always-on per-frame summary. Future perf work has data without
  // re-instrumenting; deliberately concise (one line, named fields).
  const totalMs = Date.now() - tStart;
  const tx = TRANSPORT === 'png'
    ? `shot=${shotMs}ms png=${pngBytes}B`
    : `read=embedded`;
  process.stderr.write(
    `[renderer] frame ${cmd.frame_index} t=${t}ms total=${totalMs}ms eval=${evalMs}ms ${tx} decode=${decodeMs}ms write=${writeMs}ms rgba=${rgba.length}B ` +
    `zoom=${state.camera.zoom.toFixed(3)} center=${state.camera.center.lng.toFixed(5)},${state.camera.center.lat.toFixed(5)} ` +
    `bearing=${state.camera.bearing.toFixed(1)} pitch=${state.camera.pitch.toFixed(1)} ` +
    `css=${payload.cssViewport.w}x${payload.cssViewport.h} fb=${payload.framebuffer.w}x${payload.framebuffer.h} dpr=${payload.pixelRatio}\n`,
  );
}

function decodePngToRgba(png: Buffer, expectedW: number, expectedH: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new PNG().parse(png, (err, parsed) => {
      if (err) return reject(err);
      if (parsed.width !== expectedW || parsed.height !== expectedH) {
        return reject(new Error(
          `PNG decoded size mismatch: got ${parsed.width}x${parsed.height}, expected ${expectedW}x${expectedH}`,
        ));
      }
      // pngjs always normalizes to RGBA8 internally. parsed.data is a
      // Buffer of length width*height*4 in RGBA byte order — exactly the
      // wire format.
      resolve(parsed.data);
    });
  });
}

// ---- Stdout writes --------------------------------------------------------

function writeReady(): void {
  process.stdout.write('{"ready":true}\n');
}

function writeFrame(buf: Uint8Array): void {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(buf.byteLength, 0);
  process.stdout.write(prefix);
  process.stdout.write(buf);
}

// ---- Stdin loop -----------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin });

const queue: string[] = [];
let busy = false;
let stdinClosed = false;

function processNext(): void {
  if (busy) return;
  const line = queue.shift();
  if (line === undefined) {
    if (stdinClosed) {
      void shutdownAndExit(0);
    }
    return;
  }
  busy = true;
  let cmd: Cmd;
  try {
    cmd = JSON.parse(line) as Cmd;
  } catch (e) {
    process.stderr.write(`[renderer] malformed JSON: ${(e as Error).message}\n`);
    process.exit(1);
  }
  switch (cmd.cmd) {
    case 'setup':
      setActivity('setup');
      setup(cmd).then(
        () => {
          setActivity('idle (post-setup)');
          writeReady();
          busy = false;
          processNext();
        },
        (e: Error) => {
          process.stderr.write(`[renderer] setup failed: ${e.message}\n${e.stack ?? ''}\n`);
          // Defer exit so Chrome's pipe-forwarded stderr (which carries
          // GPU-process death / OOM / target-destroyed lines) has a chance
          // to flush before we tear down. Without this delay, the stderr
          // ring only captures the puppeteer ProtocolError, not the
          // root cause.
          setTimeout(() => process.exit(1), 500);
        },
      );
      break;
    case 'render':
      setActivity(`render frame=${cmd.frame_index} t=${cmd.project_time_ms}ms`);
      renderFrame(cmd).then(
        () => {
          setActivity(`idle (post-frame ${cmd.frame_index})`);
          busy = false;
          processNext();
        },
        (e: Error) => {
          process.stderr.write(
            `[renderer] render error at frame ${cmd.frame_index} t=${cmd.project_time_ms}: ${e.message}\n${e.stack ?? ''}\n`,
          );
          setTimeout(() => process.exit(1), 500);
        },
      );
      break;
    case 'recycle':
      setActivity('recycle');
      recycle().then(
        () => {
          setActivity('idle (post-recycle)');
          writeReady();
          busy = false;
          processNext();
        },
        (e: Error) => {
          process.stderr.write(`[renderer] recycle failed: ${e.message}\n${e.stack ?? ''}\n`);
          setTimeout(() => process.exit(1), 500);
        },
      );
      break;
    case 'shutdown':
      setActivity('shutdown');
      void shutdownAndExit(0);
      break;
    default: {
      const c: { cmd?: string } = cmd as { cmd?: string };
      process.stderr.write(`[renderer] unknown cmd, ignoring: ${c.cmd}\n`);
      busy = false;
      processNext();
    }
  }
}

async function shutdownAndExit(code: number): Promise<void> {
  if (page) {
    try { await page.close(); } catch { /* ignore */ }
    page = null;
  }
  if (browser) {
    try { await browser.close(); } catch { /* ignore */ }
    browser = null;
  }
  process.exit(code);
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  queue.push(line);
  processNext();
});

rl.on('close', () => {
  stdinClosed = true;
  if (!busy && queue.length === 0) {
    void shutdownAndExit(0);
  }
});

// Heartbeat — prints current activity + how long we've been in it. Tuned
// to 15 s so a healthy export (frames flow every ~hundreds of ms) buries
// the heartbeat in real frame breadcrumbs, while a stalled worker stands
// out as a heartbeat ticking against a stuck activity ("render frame=42
// t=… elapsed=120000ms" → frame 42's evaluate or screenshot is hung).
// `unref` so the timer doesn't block shutdown.
//
// Gated behind TRAILCUT_RENDERER_VERBOSE=1: the per-frame summary line is
// already a healthy-export liveness signal. The heartbeat earns its keep
// during diagnosis of hangs, where verbose mode is appropriate.
if (VERBOSE) {
  setInterval(() => {
    const elapsed = Date.now() - activityStartedAt;
    process.stderr.write(
      `[renderer heartbeat] activity="${currentActivity}" elapsed=${elapsed}ms ` +
      `busy=${busy} queueDepth=${queue.length}\n`,
    );
  }, 15_000).unref();
}
