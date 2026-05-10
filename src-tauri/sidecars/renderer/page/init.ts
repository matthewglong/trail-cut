// Page-side bootstrap. Runs inside headless Chromium in the page
// constructed by the Node worker (../index.ts). Bundled to
// dist/page-init.bundle.js by build.mjs, then inlined into the
// BOOTSTRAP_HTML the worker hands to page.setContent().
//
// Communicates with the worker through three globals on `window`:
//   - window.trailcutFetch(url)   — exposed from Node via page.exposeFunction.
//                                   Returns { ok, dataB64? | error? }.
//   - window.__init(payload)      — called by the worker's setup handler.
//                                   Constructs the Map (with transformRequest
//                                   rewriting all http(s) URLs into
//                                   trailcut:// URLs and addProtocol serving
//                                   their bytes), applies the painter patch,
//                                   awaits 'load', adds dynamic sources/
//                                   layers seeded with empty data.
//   - window.__applyFrame(state)  — called by the worker per render. Pushes
//                                   per-frame source/paint updates, jumps
//                                   the camera, awaits idle + 2 rAFs.
//
// All maplibre-gl-js usage lives here; Node imports nothing from this
// module.

import maplibregl from 'maplibre-gl';

import { applyPainterPatch } from './painterPatch';

// ---------------------------------------------------------------------------
// Types — local copies of the shapes the worker passes in. Keep them small
// and structural; importing maplibre-gl types here pulls in DOM types we
// don't want bleeding everywhere on the Node side.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyJSON = any;

interface InitPayload {
  /** Style spec — either a URL string (DEFAULT_STYLE_URL for default/3d
   *  modes) or a parsed StyleSpecification object (SATELLITE_STYLE for
   *  satellite mode). transformRequest rewrites the URL fetch in either
   *  case; the parsed-object case skips one level of fetching but the
   *  inner URLs (sources, glyphs, sprite) still flow through the rewriter
   *  the moment maplibre needs them. */
  style: AnyJSON;
  /** Map slot pixel dims; the page's <div id="map"> sizes to this. */
  viewport: { w: number; h: number };
  /** True if `mapSettings.map_style === '3d'`. Toggles
   *  BUILDINGS_LAYER_SPEC addition post-style-load. */
  add3dBuildings: boolean;
  /** Static source data — added once at init: route-full plus seeded
   *  placeholders for the dynamic sources that __applyFrame later
   *  updates via getSource(id).setData(...). */
  staticSources: Array<[string, AnyJSON]>;
  /** Layer specs to add post-style-load, in stacking order. */
  staticLayers: AnyJSON[];
  /** [layerId, visibility] one-shot at init time. */
  visibility: Array<[string, 'visible' | 'none']>;
  /** Just the BUILDINGS_LAYER_SPEC if add3dBuildings; null otherwise. */
  buildingsLayer: AnyJSON | null;
}

interface FramePayload {
  /** project_time_ms — fed to maplibregl.setNow for a frozen clock. */
  t: number;
  /** Per-frame GeoJSON updates. Replaces the existing source via setData. */
  sources: Array<[string, AnyJSON]>;
  /** Per-frame paint property triplets [layerId, propName, value]. */
  paints: Array<[string, string, AnyJSON]>;
  /** Camera target. */
  camera: {
    center: { lng: number; lat: number };
    zoom: number;
    bearing: number;
    pitch: number;
  };
}

declare global {
  interface Window {
    maplibregl: typeof maplibregl;
    trailcutFetch: (url: string) => Promise<{
      ok: boolean;
      dataB64?: string;
      error?: string;
    }>;
    __init: (payload: InitPayload) => Promise<void>;
    __applyFrame: (frame: FramePayload) => Promise<void>;
    __map: maplibregl.Map | null;
  }
}

// ---------------------------------------------------------------------------
// URL rewriting — every http(s) URL maplibre is about to fetch becomes a
// trailcut:// URL whose `?u=` parameter base64url-encodes the original
// (UTF-8). Run inside transformRequest, which is called *after* maplibre
// interpolates `{z}/{x}/{y}` tile placeholders and `{fontstack}/{range}`
// glyph placeholders, so the encoded payload is always the fully-resolved
// URL the cache should key on.

function utf8ToBase64Url(s: string): string {
  // TextEncoder gives us UTF-8 bytes; btoa needs a binary string. Loop is
  // safer than spread for URLs with surrogate pairs (rare for tile URLs but
  // theoretically possible if a glyph fontstack name contains them).
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function rewriteForTrailcut(url: string): string {
  return `trailcut://r?u=${utf8ToBase64Url(url)}`;
}

function shouldRewrite(url: string): boolean {
  // Anything maplibre tries to fetch over http(s) — covers the OpenFreeMap
  // style/sprite/glyphs/tiles, plus the satellite-mode ArcGIS tiles, plus
  // the demotiles glyphs URL the satellite style pulls in. Mirrors the
  // native renderer's request callback, which doesn't filter.
  return url.startsWith('http://') || url.startsWith('https://');
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

maplibregl.addProtocol('trailcut', async (params) => {
  const result = await window.trailcutFetch(params.url);
  if (!result.ok) {
    throw new Error(result.error ?? 'trailcutFetch failed');
  }
  if (!result.dataB64) {
    throw new Error('trailcutFetch ok but no data');
  }
  const bytes = base64ToBytes(result.dataB64);

  // Maplibre's resource pipeline expects a different `data` shape per
  // resource type — see node_modules/maplibre-gl/src/util/ajax.ts. For
  // `json` (style + glyph metadata + sprite metadata), the caller expects
  // a parsed object; for `arrayBuffer`/`image` (tiles, sprite PNG, glyph
  // PBF), it expects an ArrayBuffer. Default to ArrayBuffer for unknown.
  // Returning the wrong shape produces "missing required property" errors
  // because the caller path-accesses the result as an object.
  if (params.type === 'json') {
    const text = new TextDecoder().decode(bytes);
    return { data: JSON.parse(text) };
  }
  if (params.type === 'arrayBuffer' || params.type === 'image' || !params.type) {
    return { data: bytes.buffer };
  }
  // 'text' or any other future type — decode to string.
  return { data: new TextDecoder().decode(bytes) };
});

window.maplibregl = maplibregl;
window.__map = null;

// ---------------------------------------------------------------------------
// __init — construct map with transformRequest + addProtocol, apply patch,
// seed sources/layers.

window.__init = async (payload: InitPayload): Promise<void> => {
  const t0 = Date.now();
  const bc = (msg: string): void => {
    // console.log is captured by the page-side console listener attached
    // in index.ts buildPage; that re-emits as `[console:log] ...` on the
    // worker's stderr.
    console.log(`[__init +${Date.now() - t0}ms] ${msg}`);
  };

  try {
    bc('entry');

    const container = document.getElementById('map');
    if (!container) throw new Error('no #map container in page');

    // Set the container's pixel size so the map's WebGL framebuffer matches
    // the worker's viewport. The body CSS is 100% of the iframe; this div
    // pins the map to exactly viewport.w × viewport.h.
    container.style.width = `${payload.viewport.w}px`;
    container.style.height = `${payload.viewport.h}px`;
    bc(`container sized ${payload.viewport.w}x${payload.viewport.h}`);

    const map = new maplibregl.Map({
      container,
      style: payload.style,
      interactive: false,
      attributionControl: false,
      pixelRatio: 1,
      // Disable label fade so deterministic project-time → identical output.
      fadeDuration: 0,
      transformRequest: (url) => {
        if (shouldRewrite(url)) {
          return { url: rewriteForTrailcut(url) };
        }
        return { url };
      },
    });
    bc('Map constructor returned');

    applyPainterPatch((map as unknown as { painter: AnyJSON }).painter);
    bc('applyPainterPatch done');

    await new Promise<void>((resolve, reject) => {
      map.once('load', () => resolve());
      map.once('error', (e: AnyJSON) => reject(new Error(`map error: ${e?.error?.message ?? 'unknown'}`)));
    });
    bc("map 'load' resolved");

    // Disable paint transitions for every layer. Transitions are a
    // wall-clock animation construct (prior value + cubic-eased
    // interpolation over time, controlled by the global stylesheet
    // transition spec). For a deterministic per-frame export where the
    // worker is asking for specific project_time_ms snapshots, transitions
    // add nothing but bookkeeping — every paint change should snap to its
    // final value instantly.
    //
    // The previous attempt overrode `stylesheet.transition.duration = 0`
    // and trusted that the path through TransitioningPropertyValue would
    // produce hasTransition()=false. It does not, in practice: that
    // constructor (properties.ts line 232–240) has `+` / `||` precedence
    // quirks (`begin = now + delay || 0`, `end = begin + duration || 0`)
    // and a `prior` assignment guarded on `(transition.delay ||
    // transition.duration)` that interact in ways that leave
    // `hasTransition()` permanently true. With it stuck true, _styleDirty
    // is reasserted every render (map.ts ~3700) → the next render is
    // scheduled → idle never fires → __applyFrame's `await once('idle')`
    // hangs forever.
    //
    // Right fix: monkey-patch each layer's `updateTransitions` to skip the
    // transition path entirely and produce the untransitioned() result
    // (instant final value, prior=null, hasTransition()=false). Same
    // shape of fix as applyPainterPatch — small, contained, kills a
    // feature we don't want.
    const styleAny = (map as AnyJSON).style;
    if (styleAny) {
      // Style.getTransition() also reads stylesheet.transition. Zero it as
      // defense-in-depth; the layer-level patch is what actually does the
      // work, but a future maplibre release that grows new transition
      // sites should still see duration=0 here.
      if (styleAny.stylesheet) {
        styleAny.stylesheet.transition = { duration: 0, delay: 0 };
      }
      const layers: Record<string, AnyJSON> = styleAny._layers ?? {};
      for (const id of Object.keys(layers)) {
        const layer = layers[id];
        if (!layer) continue;
        layer.updateTransitions = function (this: AnyJSON): void {
          this._transitioningPaint = this._transitionablePaint.untransitioned();
        };
        // Flush any default-state transitioning paint that was assigned
        // during initial layer construction.
        if (layer._transitionablePaint) {
          layer._transitioningPaint = layer._transitionablePaint.untransitioned();
        }
      }
      // Light/sky also contribute to style.hasTransitions(). Defensive
      // patch — these are usually absent in our styles, but if a future
      // style spec adds them the same idle deadlock would resurface.
      for (const sub of [styleAny.light, styleAny.sky]) {
        if (sub) {
          sub.updateTransitions = function (this: AnyJSON): void {
            this._transitioning = this._transitionable.untransitioned();
          };
          if (sub._transitionable) {
            sub._transitioning = sub._transitionable.untransitioned();
          }
        }
      }

      // Raster tile fade-in. style.hasTransitions() also iterates
      // `tileManagers` and any raster-typed manager checks
      // `hasRasterTransition` against its `_rasterFadeDuration`. The
      // default raster-fade-duration is 300 ms; while any in-view tile's
      // fadeEndTime is in the future, hasRasterTransition returns true,
      // which keeps style.hasTransitions() true, which blocks idle.
      // hasRasterTransition (tile_manager_raster.ts:210) short-circuits
      // to false when rasterFadeDuration <= 0, so zeroing it is the
      // cleanest kill. Cosmetic on a single-frame export anyway — fades
      // are a UX nicety for live panning.
      const tileManagers: Record<string, AnyJSON> = styleAny.tileManagers ?? {};
      for (const id of Object.keys(tileManagers)) {
        const tm = tileManagers[id];
        if (tm && typeof tm.setRasterFadeDuration === 'function') {
          tm.setRasterFadeDuration(0);
        }
      }
    }
    bc('paint+raster transitions disabled');

    if (payload.add3dBuildings && payload.buildingsLayer) {
      try {
        map.addLayer(payload.buildingsLayer);
        bc('3d buildings layer added');
      } catch {
        // 3d layer expects 'openmaptiles' source; not all styles have it.
        bc('3d buildings layer add threw (ignored)');
      }
    }

    for (const [id, spec] of payload.staticSources) {
      map.addSource(id, spec);
      bc(`addSource ${id}`);
    }
    for (const layer of payload.staticLayers) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const layerId = (layer as any)?.id ?? '<no-id>';
      map.addLayer(layer as AnyJSON);
      bc(`addLayer ${layerId}`);
    }
    for (const [layerId, vis] of payload.visibility) {
      map.setLayoutProperty(layerId, 'visibility', vis);
      bc(`setVisibility ${layerId}=${vis}`);
    }

    window.__map = map;
    bc('done');
  } catch (e) {
    // Re-throw, but first surface the error with a clear prefix so the
    // worker-side pageerror handler isn't the only diagnostic.
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error && e.stack ? e.stack : '<no stack>';
    console.error(`[__init throw] ${msg}\n${stack}`);
    throw e;
  }
};

// ---------------------------------------------------------------------------
// __applyFrame — per-frame deltas + camera + idle + two rAFs.

function nextRaf(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

window.__applyFrame = async (frame: FramePayload): Promise<void> => {
  const t0 = Date.now();
  const bc = (msg: string): void => {
    console.log(`[__applyFrame t=${frame.t} +${Date.now() - t0}ms] ${msg}`);
  };

  try {
    bc('entry');

    const map = window.__map;
    if (!map) throw new Error('__applyFrame before __init');

    maplibregl.setNow(frame.t);
    bc('setNow done');

    for (const [sourceId, data] of frame.sources) {
      const source = map.getSource(sourceId) as AnyJSON;
      if (!source) {
        throw new Error(`__applyFrame: unknown source ${sourceId}`);
      }
      source.setData(data);
      bc(`setData ${sourceId}`);
    }
    for (const [layerId, prop, value] of frame.paints) {
      map.setPaintProperty(layerId, prop, value);
      bc(`setPaint ${layerId}.${prop}`);
    }

    map.jumpTo({
      center: [frame.camera.center.lng, frame.camera.center.lat],
      zoom: frame.camera.zoom,
      bearing: frame.camera.bearing,
      pitch: frame.camera.pitch,
    });
    bc('jumpTo done');

    // Force a repaint scheduling: once('idle') only fires the *next* time idle
    // is dispatched, not if the map happens to already be idle. Calling
    // triggerRepaint here guarantees a render pass — the post-render check at
    // map.ts ~line 3718 then fires idle once the dirty flags settle.
    map.triggerRepaint();
    bc('triggerRepaint done');

    // Periodic in-flight diagnostics — if 'idle' never fires we want to
    // know what maplibre thinks is still pending. style.hasTransitions()
    // and the source dataloading flags are the usual culprits. Tick at
    // 5 s so a healthy frame (typically <500 ms) never logs, but a hung
    // frame surfaces its blockers without further code changes.
    const idleStart = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapAny = map as any;
    const diagTimer = setInterval(() => {
      const elapsed = Date.now() - idleStart;
      let hasTransitions: string;
      try { hasTransitions = String(mapAny.style?.hasTransitions?.()); }
      catch (e) { hasTransitions = `<threw: ${(e as Error).message}>`; }
      let loaded: string;
      try { loaded = String(mapAny.loaded?.()); }
      catch (e) { loaded = `<threw: ${(e as Error).message}>`; }
      let areTilesLoaded: string;
      try { areTilesLoaded = String(mapAny.areTilesLoaded?.()); }
      catch (e) { areTilesLoaded = `<threw: ${(e as Error).message}>`; }
      let tmFlags: string;
      try {
        const tms = mapAny.style?.tileManagers ?? {};
        tmFlags = Object.entries(tms).map(([k, v]) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tm = v as any;
          const loadedFn = tm?.loaded?.();
          const hasT = tm?.hasTransition?.();
          const fade = tm?._rasterFadeDuration;
          return `${k}=loaded:${loadedFn},hasT:${hasT},fade:${fade}`;
        }).join(' | ');
      } catch (e) { tmFlags = `<threw: ${(e as Error).message}>`; }
      // Per-layer hasTransition flags — pinpoint which layer is keeping it true.
      let layerFlags: string;
      try {
        const layers = mapAny.style?._layers ?? {};
        layerFlags = Object.entries(layers)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter(([, v]) => (v as any)?.hasTransition?.())
          .map(([k]) => k)
          .join(',');
      } catch (e) { layerFlags = `<threw: ${(e as Error).message}>`; }
      console.warn(
        `[__applyFrame t=${frame.t} idle-wait +${elapsed}ms] ` +
        `hasTransitions=${hasTransitions} loaded=${loaded} ` +
        `areTilesLoaded=${areTilesLoaded} layersWithTransition=[${layerFlags}] ` +
        `tileManagers={${tmFlags}}`,
      );
    }, 5_000);

    try {
      await new Promise<void>((resolve) => map.once('idle', () => resolve()));
    } finally {
      clearInterval(diagTimer);
    }
    bc(`idle resolved (${Date.now() - idleStart}ms wait)`);

    await nextRaf();
    bc('rAF 1');

    await nextRaf();
    bc('rAF 2');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error && e.stack ? e.stack : '<no stack>';
    console.error(`[__applyFrame throw t=${frame.t}] ${msg}\n${stack}`);
    throw e;
  }
};
