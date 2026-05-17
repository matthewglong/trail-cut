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
//                                   the camera, awaits idle + 1 rAF, then
//                                   reads pixels via gl.readPixels and
//                                   returns them base64-encoded (or null
//                                   when transport='png' — see InitPayload).
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
  /** CSS-pixel dims at which `#map` is laid out. Combined with `pixelRatio`,
   *  these determine the WebGL drawing-buffer size — `cssViewport * pixelRatio
   *  = framebuffer`. The page sizes the container in CSS pixels; MapLibre
   *  scales internally by its `pixelRatio` constructor arg. */
  cssViewport: { w: number; h: number };
  /** Actual WebGL drawing-buffer pixel dims. Equal to the map slot pixel
   *  dims; the readback path is sized to these. */
  framebuffer: { w: number; h: number };
  /** `framebuffer.w / cssViewport.w`. Passed to MapLibre's `pixelRatio`
   *  constructor arg so map tile selection + label sizing honor the export's
   *  effective DPR. Can be < 1 (downscaled insets) or > 1 (high-res). */
  pixelRatio: number;
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
  /** Resolved static paint values — applied via setPaintProperty after the
   *  static layers are added. The layer specs ship placeholder `1`s for
   *  every size-based property, so these MUST be applied before the first
   *  frame or the map will render with 1-pixel lines and 1-pixel circles. */
  staticPaints: Array<[string, string, number]>;
  /** Resolved static layout values (text-size on waypoints-label). Same
   *  contract as staticPaints — applied via setLayoutProperty. */
  staticLayouts: Array<[string, string, number]>;
  /** Just the BUILDINGS_LAYER_SPEC if add3dBuildings; null otherwise. */
  buildingsLayer: AnyJSON | null;
  /** When true, page-side __init/__applyFrame log diagnostic breadcrumbs
   *  via console.log, and __applyFrame runs an idle-wait diagnostic timer.
   *  When false (default), the page is quiet — no per-frame chatter, no
   *  setInterval per frame. Mirrors the worker's TRAILCUT_RENDERER_VERBOSE. */
  verbose?: boolean;
  /** Pixel-readback transport. 'readpixels' (default) reads the WebGL
   *  framebuffer via gl.readPixels at the end of __applyFrame and returns
   *  base64-encoded RGBA bytes. 'png' returns null and the worker takes a
   *  Page.captureScreenshot afterwards (legacy path). */
  transport?: 'readpixels' | 'png';
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
    __applyFrame: (frame: FramePayload) => Promise<{ rgbaB64: string | null } | null>;
    __map: maplibregl.Map | null;
    /** Sticky verbose flag. Set by __init from InitPayload.verbose. Read
     *  by __applyFrame so we don't have to thread the flag through every
     *  frame. */
    __verbose: boolean;
    /** Sticky transport mode. Set by __init from InitPayload.transport. */
    __transport: 'readpixels' | 'png';
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
window.__verbose = false;
window.__transport = 'readpixels';

// Expected framebuffer dims, captured at __init. The orchestrator (Node side)
// validates that the readback buffer is exactly framebuffer.w*h*4 bytes, so
// the page must always honor those dims regardless of how the browser/MapLibre
// rounded the actual `gl.drawingBufferWidth/Height`. For canonical-css-width
// exports the math doesn't always round-trip cleanly (e.g. css_h=3413,
// pixel_ratio=27/128 → 719.93, which Chromium has been seen to floor to 719),
// so captureFramebufferIntoBuf pads/crops by ≤1 row/col to match.
let expectedFbW = 0;
let expectedFbH = 0;
let mismatchWarned = false;

// ---------------------------------------------------------------------------
// __init — construct map with transformRequest + addProtocol, apply patch,
// seed sources/layers.

window.__init = async (payload: InitPayload): Promise<void> => {
  // Record sticky page-wide options. These outlive the __init call and
  // are read by __applyFrame on every frame.
  window.__verbose = !!payload.verbose;
  window.__transport = payload.transport ?? 'readpixels';
  expectedFbW = payload.framebuffer.w;
  expectedFbH = payload.framebuffer.h;
  mismatchWarned = false;

  const t0 = Date.now();
  const bc = (msg: string): void => {
    // console.log is captured by the page-side console listener attached
    // in index.ts buildPage; that re-emits as `[console:log] ...` on the
    // worker's stderr. Gated behind verbose to avoid 15× CDP round-trips
    // per frame in the steady state.
    if (window.__verbose) {
      console.log(`[__init +${Date.now() - t0}ms] ${msg}`);
    }
  };

  try {
    bc('entry');

    const container = document.getElementById('map');
    if (!container) throw new Error('no #map container in page');

    // Set the container's CSS-pixel size. MapLibre multiplies this by its
    // `pixelRatio` constructor arg (below) to size the WebGL drawing buffer,
    // which is what __applyFrame's gl.readPixels reads back. This is the
    // decoupling that lets `mapSettings.zoom` mean the same thing across
    // export resolutions: zoom is interpreted at `cssViewport`, then the
    // framebuffer scales independently via `pixelRatio`.
    container.style.width = `${payload.cssViewport.w}px`;
    container.style.height = `${payload.cssViewport.h}px`;
    bc(`container sized css=${payload.cssViewport.w}x${payload.cssViewport.h} dpr=${payload.pixelRatio} → fb=${payload.framebuffer.w}x${payload.framebuffer.h}`);

    const map = new maplibregl.Map({
      container,
      style: payload.style,
      interactive: false,
      attributionControl: false,
      pixelRatio: payload.pixelRatio,
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

    // Static paint sizing. Layer specs ship placeholder `1`s for every
    // size-based property (line-width, circle-radius, circle-stroke-width,
    // text-size). The real values are
    // `PAINT_SIZE_FRACTIONS.<name> * cssViewport.w` — resolved on the
    // worker side and shipped here as ready-to-apply triplets. Skipping
    // this would render the map with 1-pixel lines and 1-pixel circles.
    for (const [layerId, prop, value] of payload.staticPaints) {
      map.setPaintProperty(layerId, prop, value);
      bc(`setStaticPaint ${layerId}.${prop}=${value}`);
    }
    for (const [layerId, prop, value] of payload.staticLayouts) {
      map.setLayoutProperty(layerId, prop, value);
      bc(`setStaticLayout ${layerId}.${prop}=${value}`);
    }

    // ---- Sticky 'render' listener for the readpixels transport ----
    //
    // Why subscribe here, in __init, instead of inside __applyFrame: WebGL
    // with the default `preserveDrawingBuffer: false` is allowed to clear
    // the framebuffer between presentations. By the time __applyFrame's
    // `await once('idle')` resolves and runs a microtask continuation,
    // we are no longer inside the rAF callback that called painter.render
    // — the browser may have already composited and discarded the buffer
    // (verified empirically: gl.readPixels returned all-zero bytes when
    // called from the post-idle continuation, producing a fully blank
    // export frame).
    //
    // Setting `preserveDrawingBuffer: true` would be the obvious
    // alternative but produces a pathological hang — maplibre's first
    // render never fires (verified: 'load' never resolved, no render
    // events ever observed in __init load-wait diagnostic).
    //
    // Workaround that works: piggy-back on maplibre's 'render' event,
    // which fires SYNCHRONOUSLY inside maplibre's _render method
    // immediately after `painter.render()` returns and before any
    // additional async work that would let the browser composite. At
    // that instant the WebGL framebuffer holds the pixels we want; we
    // call gl.readPixels into a sticky module-scope buffer here, and
    // __applyFrame just bytes-to-base64s that buffer after idle.
    //
    // The render event fires 1+ times per maplibre tick (each tile load
    // can trigger one). The last fire before 'idle' is the canonical
    // end-of-frame state, which is exactly what __applyFrame returns.
    // There's a small wasted-work cost when many 'render' events fire
    // back-to-back during a multi-tile frame — each one does a
    // gl.readPixels — but in steady-state cached-tile mode the count is
    // 1–2 per frame and the cost is dominated by the single readPixels
    // we'd do anyway. (Future optimization: throttle to last-render-
    // before-idle by hooking 'idle' to commit; the current shape favors
    // simplicity over micro-optimization.)
    if (window.__transport === 'readpixels') {
      (map as AnyJSON).on('render', () => {
        try {
          captureFramebufferIntoBuf(map as AnyJSON);
        } catch (e) {
          // Don't let a readback error tear down the render loop.
          console.error(
            `[render readpixels] capture failed: ${(e as Error).message}`,
          );
        }
      });
      bc('readpixels render-listener attached');
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
// __applyFrame — per-frame deltas + camera + idle + one rAF + readPixels.

function nextRaf(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// Reusable readback buffer — allocated lazily to match the WebGL canvas
// pixel size, then reused on every frame to avoid per-frame GC pressure
// from 8 MB+ Uint8Array churn at 1080p.
let readbackBuf: Uint8Array | null = null;
let readbackBufW = 0;
let readbackBufH = 0;

/** Encode a Uint8Array to a standard base64 string using Chrome's native
 *  btoa (C++ implementation). btoa wants a "binary string" where each
 *  character's code unit is the byte value (0..255).
 *
 *  Caveat — `new TextDecoder('latin1')` looks like the natural bridge but
 *  it is NOT (per WHATWG): 'latin1' is an alias for windows-1252, where
 *  bytes 0x80–0x9F map to specific Unicode code points outside U+0000–
 *  U+00FF (e.g. 0x80 → U+20AC €), which btoa then rejects with
 *  "characters outside of the Latin1 range". The empirical proof:
 *  swapping in TextDecoder('latin1') threw InvalidCharacterError on the
 *  first frame.
 *
 *  Correct + fast path: chunked String.fromCharCode.apply. Each chunk is
 *  one V8 spread-arg call. Chunks of 32 KB stay below V8's spread-arg
 *  call-stack limit (~64–128 KB depending on stack budget) and minimize
 *  the number of intermediate string allocations. ~30–40 ms on an 8 MB
 *  RGBA buffer on M-series silicon — comparable to a screenshot+decode
 *  pass but skips the entire Chrome screenshot color-management pipeline. */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000; // 32 KB; safely below V8's spread-arg limit.
  let binStr = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bytes.length);
    binStr += String.fromCharCode.apply(
      null,
      bytes.subarray(i, end) as unknown as number[],
    );
  }
  return btoa(binStr);
}

// Sticky scratch buffer for the GL-native bottom-up read. Reused alongside
// readbackBuf to avoid per-frame Uint8Array churn; sized lazily.
let readScratch: Uint8Array | null = null;

/** Read the WebGL framebuffer into the module-scope `readbackBuf`,
 *  top-to-bottom row order (matching the screenshot/PNG byte layout the
 *  orchestrator expects). gl.readPixels reads from the bottom-left
 *  origin, so we flip rows here.
 *
 *  Called synchronously from the maplibre 'render' event handler — at
 *  that instant the framebuffer holds the just-painted pixels and the
 *  browser hasn't yet composited (so the default
 *  preserveDrawingBuffer:false hasn't cleared anything).
 *
 *  Output buffer is always sized to the orchestrator-supplied
 *  `framebuffer.w × framebuffer.h × 4` (captured at __init), not to the
 *  actual `gl.drawingBufferWidth/Height`. The two can differ by ≤1 px on
 *  axes where the canonical-css-width math can't round-trip exactly
 *  through the browser's deviceScaleFactor (e.g. slot 405×720 → css_h
 *  3413 × pr 27/128 = 719.93, which Chromium has been observed to floor
 *  to 719). Map content is copied into the intersection rectangle (top-
 *  left aligned after row flip); any extra rows/cols stay zero-filled. */
function captureFramebufferIntoBuf(map: AnyJSON): void {
  const canvas = map.getCanvas() as HTMLCanvasElement;
  // The map's WebGL context was created in maplibre's _setupPainter; we
  // ask the same canvas for it again. Asking with no attributes returns
  // the existing context regardless of attributes; passing 'webgl2' or
  // falling back to 'webgl' covers maplibre's default contextType.
  const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null
    ?? (canvas.getContext('webgl') as WebGLRenderingContext | null);
  if (!gl) throw new Error('readPixels: map canvas has no WebGL context');

  const actualW = gl.drawingBufferWidth;
  const actualH = gl.drawingBufferHeight;
  if (actualW === 0 || actualH === 0) {
    // Pre-load tick — framebuffer not yet sized. Skip silently; a real
    // render with non-zero dims will fire later.
    return;
  }

  // Expected dims govern the output buffer size — the orchestrator
  // strictly validates `framebuffer.w*h*4` on the Node side.
  const expW = expectedFbW || actualW;
  const expH = expectedFbH || actualH;
  const expLen = expW * expH * 4;
  if (!readbackBuf || readbackBufW !== expW || readbackBufH !== expH) {
    readbackBuf = new Uint8Array(expLen);
    readbackBufW = expW;
    readbackBufH = expH;
  } else {
    // Zero-fill so any padding rows/cols (when actual < expected) are
    // transparent black rather than stale pixels from a prior frame.
    readbackBuf.fill(0);
  }

  // Scratch is sized to the *actual* drawing buffer — gl.readPixels with
  // a width/height beyond the framebuffer has implementation-defined
  // behavior, so we never ask for more than is actually there.
  const actualLen = actualW * actualH * 4;
  if (!readScratch || readScratch.length !== actualLen) {
    readScratch = new Uint8Array(actualLen);
  }
  const scratch = readScratch;
  gl.readPixels(0, 0, actualW, actualH, gl.RGBA, gl.UNSIGNED_BYTE, scratch);

  // Copy the intersection of (actual, expected). Map content is top-left
  // aligned in the output; row flip happens here (gl.readPixels is
  // bottom-up, our consumers want top-down).
  const copyW = Math.min(actualW, expW);
  const copyH = Math.min(actualH, expH);
  const copyRowBytes = copyW * 4;
  const srcRowBytes = actualW * 4;
  const dstRowBytes = expW * 4;
  const out = readbackBuf;
  for (let y = 0; y < copyH; y++) {
    const srcStart = (actualH - 1 - y) * srcRowBytes;
    const dstStart = y * dstRowBytes;
    out.set(scratch.subarray(srcStart, srcStart + copyRowBytes), dstStart);
  }

  if (!mismatchWarned && (actualW !== expW || actualH !== expH)) {
    mismatchWarned = true;
    console.warn(
      `[readpixels] drawing-buffer dims ${actualW}x${actualH} differ from ` +
      `expected framebuffer ${expW}x${expH} — padding/cropping to match. ` +
      `This is benign at ≤1px (canonical-css rounding) but a larger drift ` +
      `indicates a viewport setup bug.`,
    );
  }
}

window.__applyFrame = async (frame: FramePayload): Promise<{ rgbaB64: string | null } | null> => {
  const t0 = Date.now();
  const VERBOSE_PAGE = window.__verbose;
  const bc = (msg: string): void => {
    if (VERBOSE_PAGE) {
      console.log(`[__applyFrame t=${frame.t} +${Date.now() - t0}ms] ${msg}`);
    }
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tr: AnyJSON = (map as any).transform;
    bc(
      `jumpTo done zoom=${frame.camera.zoom.toFixed(3)} ` +
      `center=${frame.camera.center.lng.toFixed(5)},${frame.camera.center.lat.toFixed(5)} ` +
      `bearing=${frame.camera.bearing.toFixed(1)} pitch=${frame.camera.pitch.toFixed(1)} ` +
      `transformW=${tr?.width} transformH=${tr?.height} ` +
      `tileSize=${tr?.tileSize} pixelRatio=${map.getPixelRatio().toFixed(3)}`
    );

    // Force a repaint scheduling: once('idle') only fires the *next* time idle
    // is dispatched, not if the map happens to already be idle. Calling
    // triggerRepaint here guarantees a render pass — the post-render check at
    // map.ts ~line 3718 then fires idle once the dirty flags settle.
    map.triggerRepaint();
    bc('triggerRepaint done');

    // Periodic in-flight diagnostics — if 'idle' never fires we want to
    // know what maplibre thinks is still pending. Gated behind verbose:
    // creating a setInterval per frame plus the diag closure costs a few
    // ms in the steady state, and a healthy export (frames typically
    // <500 ms) never observes a tick anyway.
    const idleStart = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapAny = map as any;
    let diagTimer: ReturnType<typeof setInterval> | null = null;
    if (VERBOSE_PAGE) {
      diagTimer = setInterval(() => {
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
    }

    try {
      await new Promise<void>((resolve) => map.once('idle', () => resolve()));
    } finally {
      if (diagTimer) clearInterval(diagTimer);
    }
    bc(`idle resolved (${Date.now() - idleStart}ms wait)`);

    // Single rAF after idle — gives Chrome's compositor one frame to flush
    // any post-idle paint dispatched during the idle handler. The
    // previous code used two rAFs as defense-in-depth before the
    // raster-fade + transitions fixes landed; with those in place one is
    // sufficient. Skipping it produced visible tearing in test runs;
    // keeping one is cheap (~16 ms wall, ~0 ms compute) and worth it.
    await nextRaf();
    bc('rAF 1');

    // ---- Pixel readback (in-page) ----
    // The readpixels transport's actual gl.readPixels happens
    // synchronously inside the 'render' event handler attached in
    // __init — at that instant the WebGL framebuffer is guaranteed to
    // hold the pixels maplibre just drew, before any compositor sweep
    // could clear it. Here we just bytes-to-base64 the sticky buffer
    // (last write wins, which is the canonical end-of-frame state).
    if (window.__transport === 'readpixels') {
      if (!readbackBuf) {
        throw new Error(
          'readpixels: no framebuffer captured by render listener — did the map render at all?',
        );
      }
      const encStart = Date.now();
      const rgbaB64 = bytesToBase64(readbackBuf);
      bc(`base64 encoded ${rgbaB64.length}ch in ${Date.now() - encStart}ms`);
      return { rgbaB64 };
    }

    return { rgbaB64: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error && e.stack ? e.stack : '<no stack>';
    console.error(`[__applyFrame throw t=${frame.t}] ${msg}\n${stack}`);
    throw e;
  }
};
