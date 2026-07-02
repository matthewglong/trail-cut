// Native rendering backend — maplibre-gl-native (mbgl) driven IN-PROCESS,
// replacing the Chrome/CDP/page hop of chromeBackend.ts. Same setup payload,
// same per-frame tuples (scene.ts), same wire bytes to the orchestrator.
//
// This is the Phase 5 renderer strangle. Both viability gates (speed 57×,
// jitter) and the mechanical-correctness gate are GREEN — measured, not
// assumed: .spike/native-gl/{jitter-report,MECHANICAL_VERDICT,
// PRODUCTION_PATH}.md. The five port contracts implemented here all come
// from those measurements:
//
//   1. `setGestureInProgress(true)` once after construction, unconditionally
//      — the raster anti-snap knob (satellite sawtooth 0.93 → 0.0795 px
//      RMS). Requires the PATCHED binding (native/ensure-binding.mjs);
//      fail loud if absent, never render snapped frames silently.
//   2. `buffer: 0` on point GeoJSON sources — translucent circle layers
//      draw once per overlapping tile in native (n≈4 at tile corners,
//      brightness pops G 138→192 under follow-cam). buffer:0 → n≈1 with
//      the circle body complete (circle quads aren't clipped; zero buffer
//      just deduplicates ownership).
//   3. Native's GeoJSON conversion rejects the app's empty-LineString
//      placeholder — normalize degenerate lines to an empty
//      FeatureCollection HERE, at the native boundary only (sources.ts
//      feeds the preview too and stays untouched).
//   4. No GeoJSON `setData` in the node binding — per-frame source refresh
//      = removeLayer(s) → removeSource → addSource → addLayer(s) →
//      re-apply paints/layouts. Measured jitter-free at 4K. The binding's
//      addLayer takes NO beforeId, so refreshing a non-topmost source
//      (route-trail sits under the waypoint/marker layers) rebuilds the
//      decoration stack from the lowest changed source upward — our layers
//      occupy the contiguous top of the style, so re-adding in static
//      order restores exact stacking.
//   5. `addImage` hard-caps textures at 1024×1024 texels; SDF icons are
//      128 × pixelRatio, so pixelRatio > 8 must fail loud (production
//      pixelRatio = resolution multiplier × SSAA factor, ≤ 4 today).
//      Signature is (id, Buffer, {width, height, pixelRatio, sdf}).
//
// SSAA: the Map's constructor-time `ratio` carries the full pixelRatio
// (resolution multiplier × supersample factor), so native renders at
// `framebuffer` dims; this backend downsamples to `readback` dims in the
// worker with an exact integer box filter (the factor is an integer by
// construction — framebuffer = slot × factor in build_setup_payload).
//
// ALPHA CONVENTION (decide once, document loudly): the native readback is
// PREMULTIPLIED RGBA, sRGB-encoded, gamma-space-blended — byte-identical to
// GL JS `gl.readPixels` on every colorimetry probe (MECHANICAL_VERDICT §2).
// The box downsample averages in that same premultiplied gamma space, and
// the buffer stays premultiplied on the wire. Exposure downstream is nil
// today: the map paints an opaque basemap (alpha=255 everywhere), and the
// composite replaces map alpha wholesale with the Rust-side corner mask
// (corner_mask.rs + alphamerge) — premultiplied-vs-straight is
// indistinguishable for opaque pixels. (The chrome SSAA path returns
// straight alpha via 2D-canvas getImageData; the divergence class is
// corner-AA fringes only, and those pixels' alpha is discarded. Flagged in
// MECHANICAL_VERDICT §2; revisit only if the map background ever goes
// transparent.)
//
// Windows note: this file has no darwin-only logic — the platform bound is
// the binding artifact itself (Metal build today; upstream's prebuilt
// matrix includes win32/ANGLE, task 130 + PRODUCTION_PATH route 2). The
// spike's numbers are darwin-arm64; re-run the oracles per platform when
// those artifacts exist.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type {
  FramePayload,
  RenderedFrame,
  RendererBackend,
  SetupCmd,
} from './backend';
import { VERBOSE, verbose } from './backend';
import {
  buildStaticScene,
  type DecorationLayerSpec,
  type StaticScene,
} from './scene';
import { buildAllShapeIcons } from '../../../src/lib/mapVisuals/shapes';
import type { TileCache } from './tileCache';
import { fetchUrl } from './fetchUrl';

// ---- Minimal binding surface ------------------------------------------------
//
// The npm package's index.d.ts is STALE (it omits runtime methods like
// setPaintProperty — verified via nm/prototype in the spike; trust the
// runtime, not the .d.ts). We declare exactly the surface we use.

interface MbglRequest {
  url: string;
  /** mbgl::Resource::Kind — 0 Unknown, 1 Style, 2 Source, 3 Tile,
   *  4 Glyphs, 5 SpriteImage, 6 SpriteJSON. */
  kind: number;
}
type MbglRequestCallback = (
  err: Error | null,
  res?: { data?: Buffer; modified?: Date; expires?: Date; etag?: string },
) => void;

interface MbglMap {
  load(style: unknown): void;
  render(
    options: {
      width: number;
      height: number;
      center: [number, number];
      zoom: number;
      bearing: number;
      pitch: number;
    },
    cb: (err: Error | null, buffer?: Buffer) => void,
  ): void;
  release(): void;
  addSource(id: string, spec: unknown): void;
  removeSource(id: string): void;
  addLayer(layer: unknown): void;
  removeLayer(id: string): void;
  addImage(
    id: string,
    data: Buffer,
    options: { width: number; height: number; pixelRatio: number; sdf: boolean },
  ): void;
  setPaintProperty(layerId: string, prop: string, value: unknown): void;
  setLayoutProperty(layerId: string, prop: string, value: unknown): void;
  setGestureInProgress?(inProgress: boolean): void;
}

interface MbglModule {
  Map: new (options: {
    ratio: number;
    request: (req: MbglRequest, callback: MbglRequestCallback) => void;
  }) => MbglMap;
}

const RESOURCE_KIND_TILE = 3;

/** addImage texture cap in the node binding (node_map.cpp) — icons are
 *  128 × pixelRatio texels per side. */
const NATIVE_ADDIMAGE_MAX_PIXEL_RATIO = 8;

// ---- Binding resolution ------------------------------------------------------

function hostTargetTriple(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'aarch64-apple-darwin';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'x86_64-apple-darwin';
  throw new Error(
    `native backend: unsupported host platform=${process.platform} arch=${process.arch} ` +
    '(darwin only until task 130 lands the Windows binding artifact)',
  );
}

/** Resolve the patched binding package dir. The orchestrator passes
 *  TRAILCUT_MBGL_NATIVE_DIR (it owns prod-vs-dev filesystem concerns, same
 *  as TRAILCUT_CHROME_BIN); the __dirname fallback covers standalone runs
 *  of the bundled worker from the source tree (dist/ → src-tauri/binaries). */
function bindingDir(): string {
  const fromEnv = process.env.TRAILCUT_MBGL_NATIVE_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  return join(__dirname, '..', '..', '..', 'binaries', `mbgl-native-${hostTargetTriple()}`);
}

function loadBinding(): MbglModule {
  const dir = bindingDir();
  if (!existsSync(dir)) {
    throw new Error(
      `native backend: patched maplibre-gl-native binding not found at ${dir}. ` +
      'Run `npm run build:native-binding` (or `npm run build:renderer`) to provision it, ' +
      'or set TRAILCUT_MBGL_NATIVE_DIR. There is no fallback — refusing to render.',
    );
  }
  // Runtime require of a computed path — esbuild leaves dynamic requires
  // in place for platform=node CJS bundles.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(dir) as MbglModule;
}

// ---- GeoJSON normalization at the native boundary (port contract 3) ---------

function normalizeGeojson(data: unknown): unknown {
  const d = data as {
    type?: string;
    geometry?: { type?: string; coordinates?: unknown[] };
  } | null;
  if (
    d && d.type === 'Feature' && d.geometry
    && d.geometry.type === 'LineString'
    && Array.isArray(d.geometry.coordinates)
    && d.geometry.coordinates.length < 2
  ) {
    return { type: 'FeatureCollection', features: [] };
  }
  return data;
}

// ---- Source-spec overrides at the native boundary (port contract 2) ----------
//
// `buffer: 0` on the point sources that feed translucent circle layers.
//   - live-marker: pulse/pulse-b circles cross tile-buffer bands constantly
//     under follow-cam — the measured brightness-pop case.
//   - waypoints: feeds the active-halo circle layer (same defect class) AND
//     two symbol layers. Symbol quads aren't clipped at tile edges and
//     placement dedupes through the cross-tile index, so buffer:0 is safe
//     for symbols — verified empirically by the waypoints-buffer probe run
//     against this backend (see .spike/native-gl production-worker oracles).
const NATIVE_SOURCE_BUFFER_ZERO = new Set(['live-marker', 'waypoints']);

function nativeSourceSpec(id: string, spec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...spec,
    data: normalizeGeojson(spec.data),
  };
  if (NATIVE_SOURCE_BUFFER_ZERO.has(id)) out.buffer = 0;
  return out;
}

// ---- Exact integer box downsample (SSAA) -------------------------------------

/** Downsample `src` (actualW×actualH, top-down premultiplied RGBA) to
 *  `outW×outH` with an exact `factor`× box filter, padding/cropping the
 *  source to `expW×expH` (= outW*factor × outH*factor) first. Padding
 *  pixels are transparent black — same convention as the chrome page's
 *  captureFramebufferIntoBuf, and only reachable on the ≤1 px dim drift the
 *  css×ratio rounding can produce. Averaging happens in gamma (sRGB) space
 *  on premultiplied components — matching the engines' own gamma-space
 *  blending (see ALPHA CONVENTION header). */
export function boxDownsample(
  src: Buffer,
  actualW: number,
  actualH: number,
  expW: number,
  expH: number,
  factor: number,
): Buffer {
  const outW = expW / factor;
  const outH = expH / factor;
  if (!Number.isInteger(outW) || !Number.isInteger(outH)) {
    throw new Error(
      `boxDownsample: framebuffer ${expW}x${expH} not divisible by factor ${factor}`,
    );
  }
  const out = Buffer.alloc(outW * outH * 4);
  const n = factor * factor;
  const half = n >> 1;
  // Accumulator for one output row. Max sum = 255 * factor^2 (factor ≤ 3
  // today) — comfortably within Uint32.
  const acc = new Uint32Array(outW * 4);
  for (let oy = 0; oy < outH; oy++) {
    acc.fill(0);
    const syBase = oy * factor;
    for (let k = 0; k < factor; k++) {
      const sy = syBase + k;
      if (sy >= actualH) continue; // zero-pad rows contribute nothing
      const rowStart = sy * actualW * 4;
      const copyW = Math.min(expW, actualW);
      for (let sx = 0; sx < copyW; sx++) {
        const ox4 = ((sx / factor) | 0) * 4;
        const s = rowStart + sx * 4;
        acc[ox4] += src[s];
        acc[ox4 + 1] += src[s + 1];
        acc[ox4 + 2] += src[s + 2];
        acc[ox4 + 3] += src[s + 3];
      }
    }
    const outRow = oy * outW * 4;
    for (let i = 0; i < outW * 4; i++) {
      out[outRow + i] = ((acc[i] + half) / n) | 0;
    }
  }
  return out;
}

/** Infer the actual pixel dims of a native render buffer from its byte
 *  length. Expected = the orchestrator's `framebuffer`; mbgl sizes its
 *  buffer from `round(css × ratio)` per axis, which can drift ≤1 px from
 *  the exact slot×factor dims when css dims were rounded (same drift the
 *  chrome page pads/crops — init.ts captureFramebufferIntoBuf). */
export function resolveActualDims(
  byteLength: number,
  expW: number,
  expH: number,
  cssW: number,
  cssH: number,
  ratio: number,
): { w: number; h: number } {
  const px = byteLength / 4;
  if (px === expW * expH) return { w: expW, h: expH };
  const candW = new Set<number>([
    expW, expW - 1, expW + 1,
    Math.floor(cssW * ratio), Math.round(cssW * ratio), Math.ceil(cssW * ratio),
  ]);
  const candH = new Set<number>([
    expH, expH - 1, expH + 1,
    Math.floor(cssH * ratio), Math.round(cssH * ratio), Math.ceil(cssH * ratio),
  ]);
  for (const w of candW) {
    if (w <= 0 || px % w !== 0) continue;
    const h = px / w;
    if (candH.has(h)) return { w, h };
  }
  throw new Error(
    `native backend: cannot resolve render buffer dims — ${byteLength} bytes ` +
    `(${px} px) vs expected ${expW}x${expH} (css ${cssW}x${cssH} × ratio ${ratio}). ` +
    'A drift this large indicates a viewport setup bug, not rounding.',
  );
}

// ---- The backend --------------------------------------------------------------

export class NativeBackend implements RendererBackend {
  private map: MbglMap | null = null;
  private setupPayload: SetupCmd | null = null;
  private scene: StaticScene | null = null;
  /** Source ids in add order (stack order of their layer blocks). */
  private sourceOrder: string[] = [];
  private layersBySource = new Map<string, DecorationLayerSpec[]>();
  /** JSON of each dynamic source's current data — refresh dedup. */
  private lastSourceJson = new Map<string, string>();

  constructor(private tileCache: TileCache) {}

  // ---- mbgl request bridge: same cache, same keys as the chrome path ----
  //
  // The chrome path caches on the ORIGINAL url (trailcutFetch unwraps the
  // trailcut:// rewrite before tileCache.get) — native requests arrive as
  // original urls already, so both backends share one on-disk cache and
  // produce identical bytes for identical URLs.
  private request = (req: MbglRequest, callback: MbglRequestCallback): void => {
    this.tileCache.get(req.url, fetchUrl, (err, data) => {
      if (err) {
        // Missing TILES are normal beyond a source's coverage — respond
        // "no content" so mbgl renders the empty region instead of failing
        // the frame. Anything else (style, sprite, glyphs, or a non-404
        // tile error) is a real failure and must stay loud.
        if (req.kind === RESOURCE_KIND_TILE && /HTTP 404 /.test(err.message)) {
          callback(null, {});
          return;
        }
        callback(err);
        return;
      }
      if (!data || data.length === 0) {
        // HTTP 204 — empty tile.
        callback(null, {});
        return;
      }
      callback(null, { data });
    });
  };

  private async fetchStyleObject(style: unknown): Promise<unknown> {
    if (typeof style !== 'string') return style;
    // URL style (DEFAULT_STYLE_URL) — fetch through the shared tile cache
    // (same cache key the chrome path uses for the style document).
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      this.tileCache.get(style, fetchUrl, (err, data) => {
        if (err || !data) reject(err ?? new Error('style fetch returned no data'));
        else resolve(data);
      });
    });
    return JSON.parse(bytes.toString('utf8'));
  }

  async setup(payload: SetupCmd): Promise<void> {
    const t0 = Date.now();
    this.setupPayload = payload;

    // Port contract 5 precondition: SDF icons rasterize at 128 × pixelRatio
    // texels and the binding's addImage rejects textures over 1024 — check
    // BEFORE building anything so the failure names the actual constraint.
    if (payload.pixelRatio > NATIVE_ADDIMAGE_MAX_PIXEL_RATIO) {
      throw new Error(
        `native backend: pixelRatio ${payload.pixelRatio} exceeds ${NATIVE_ADDIMAGE_MAX_PIXEL_RATIO} — ` +
        'SDF shape icons (128 × pixelRatio texels) would blow the binding\'s 1024-texel addImage cap. ' +
        'Production pixelRatio (resolution multiplier × SSAA factor) is ≤ 4 today; hitting this means ' +
        'the lever math changed and the icon atlas needs re-tiling (see MECHANICAL_VERDICT §5).',
      );
    }

    const mbgl = loadBinding();
    if (this.map) {
      this.map.release();
      this.map = null;
    }

    const scene = buildStaticScene(payload);
    this.scene = scene;
    const styleObject = await this.fetchStyleObject(scene.style);

    const map = new mbgl.Map({
      // The `ratio` lever — the native analogue of the GL JS `pixelRatio`
      // constructor arg (constructor-time, one Map per export job; measured
      // equivalent in MECHANICAL_VERDICT §3). Carries resolution multiplier
      // × SSAA factor.
      ratio: payload.pixelRatio,
      request: this.request,
    });
    map.load(styleObject);

    // Port contract 1 — the raster anti-snap knob. Unconditional, once,
    // right after construction, exactly as painterPatch.ts forces
    // `moving: true` in the GL JS preview (which stays untouched). A
    // binding without the patch must NOT silently render: satellite
    // exports would sawtooth at ±0.5 CSS px (measured 0.93 px RMS).
    if (typeof map.setGestureInProgress !== 'function') {
      map.release();
      throw new Error(
        'native backend: binding lacks setGestureInProgress — this is an UNPATCHED ' +
        '@maplibre/maplibre-gl-native build. Run `npm run build:native-binding` to provision ' +
        'the patched binding (native/expose-setGestureInProgress.patch). Refusing to render ' +
        'raster-snapped frames.',
      );
    }
    map.setGestureInProgress(true);

    // 3D buildings (map_style === '3d') — same soft-failure semantics as
    // the chrome page (__init): the layer expects the 'openmaptiles'
    // source; not all styles have it.
    if (scene.add3dBuildings && scene.buildingsLayer) {
      try {
        map.addLayer(scene.buildingsLayer);
      } catch {
        verbose('[renderer native] 3d buildings layer add threw (ignored)\n');
      }
    }

    // Sources → layers → images → static paints/layouts/gradients — the
    // same order as the chrome page's __init (and MapView's onStyleLoad),
    // so atlas layout and layer stacking are identical.
    this.sourceOrder = scene.staticSources.map(([id]) => id);
    this.lastSourceJson.clear();
    for (const [id, spec] of scene.staticSources) {
      map.addSource(id, nativeSourceSpec(id, spec));
      // Seed the refresh dedup with the init-time data so frame 0 only
      // refreshes sources that actually differ.
      this.lastSourceJson.set(id, JSON.stringify(spec.data));
    }
    this.layersBySource.clear();
    for (const layer of scene.staticLayers) {
      map.addLayer(layer);
      const arr = this.layersBySource.get(layer.source) ?? [];
      arr.push(layer);
      this.layersBySource.set(layer.source, arr);
    }

    // SDF shape icons — the same pure rasterizer the preview and the chrome
    // page run (`buildAllShapeIcons`), executed in-process. Port contract
    // 5: Buffer + dims-in-options signature.
    for (const { id, icon, options } of buildAllShapeIcons({
      outlineThickness: scene.shapeOutlineThickness,
      pixelRatio: payload.pixelRatio,
    })) {
      const data = icon.data as Uint8Array | Uint8ClampedArray;
      map.addImage(
        id,
        Buffer.from(data.buffer, data.byteOffset, data.byteLength),
        {
          width: icon.width,
          height: icon.height,
          pixelRatio: (options as { pixelRatio: number }).pixelRatio,
          sdf: Boolean((options as { sdf?: boolean }).sdf),
        },
      );
    }

    this.applyStatics(map, scene);

    this.map = map;
    process.stderr.write(
      `[renderer] setup done in ${Date.now() - t0}ms (backend=native, verbose=${VERBOSE})\n`,
    );
  }

  private applyStatics(map: MbglMap, scene: StaticScene): void {
    for (const [layerId, prop, value] of scene.staticPaints) {
      map.setPaintProperty(layerId, prop, value);
    }
    for (const [layerId, prop, value] of scene.staticLayouts) {
      map.setLayoutProperty(layerId, prop, value);
    }
    for (const [layerId, value] of scene.staticGradients) {
      map.setPaintProperty(layerId, 'line-gradient', value);
    }
  }

  /** Port contract 4 — per-frame source refresh without setData, stacking-
   *  order-preserving. Removes every decoration layer from the lowest
   *  changed source's block upward (they form a contiguous suffix of the
   *  style's layer list), swaps the changed sources, re-adds the removed
   *  layers in static order. Paints/layouts/gradients are re-applied by the
   *  caller every frame, which also restores any placeholder values the
   *  re-added layer specs carry. */
  private refreshSources(map: MbglMap, frame: FramePayload): number {
    const changed: string[] = [];
    for (const [sourceId, data] of frame.sources) {
      const json = JSON.stringify(data);
      if (this.lastSourceJson.get(sourceId) !== json) {
        this.lastSourceJson.set(sourceId, json);
        changed.push(sourceId);
      }
    }
    if (changed.length === 0) return 0;

    let lowest = this.sourceOrder.length;
    for (const id of changed) {
      const idx = this.sourceOrder.indexOf(id);
      if (idx === -1) throw new Error(`native backend: unknown per-frame source ${id}`);
      if (idx < lowest) lowest = idx;
    }
    const changedSet = new Set(changed);
    const affectedSources = this.sourceOrder.slice(lowest);
    const affectedLayers: DecorationLayerSpec[] = [];
    for (const sourceId of affectedSources) {
      affectedLayers.push(...(this.layersBySource.get(sourceId) ?? []));
    }
    // Remove top-down, re-add bottom-up.
    for (let i = affectedLayers.length - 1; i >= 0; i--) {
      map.removeLayer(affectedLayers[i].id);
    }
    for (const sourceId of affectedSources) {
      if (!changedSet.has(sourceId)) continue;
      map.removeSource(sourceId);
      const specTemplate = this.scene?.staticSources.find(([sid]) => sid === sourceId);
      if (!specTemplate) throw new Error(`native backend: no source template for ${sourceId}`);
      const data = frame.sources.find(([sid]) => sid === sourceId)?.[1];
      map.addSource(sourceId, nativeSourceSpec(sourceId, { ...specTemplate[1], data }));
    }
    for (const layer of affectedLayers) {
      map.addLayer(layer);
    }
    return changed.length;
  }

  async renderFrame(frame: FramePayload, frameIndex: number): Promise<RenderedFrame> {
    const map = this.map;
    const payload = this.setupPayload;
    if (!map || !payload) {
      throw new Error('native backend: renderFrame before setup');
    }
    const tStart = Date.now();

    const refreshed = this.refreshSources(map, frame);
    // Re-apply paints/layouts/gradients every frame — carries per-clip
    // overrides at cuts AND restores real values on any layers the source
    // refresh re-added with placeholder specs.
    for (const [layerId, prop, value] of frame.paints) {
      map.setPaintProperty(layerId, prop, value);
    }
    for (const [layerId, prop, value] of frame.layouts) {
      map.setLayoutProperty(layerId, prop, value);
    }
    for (const [layerId, value] of frame.gradients) {
      map.setPaintProperty(layerId, 'line-gradient', value);
    }
    const applyMs = Date.now() - tStart;

    const renderStart = Date.now();
    const raw = await new Promise<Buffer>((resolve, reject) => {
      map.render(
        {
          width: payload.cssViewport.w,
          height: payload.cssViewport.h,
          center: [frame.camera.center.lng, frame.camera.center.lat],
          zoom: frame.camera.zoom,
          bearing: frame.camera.bearing,
          pitch: frame.camera.pitch,
        },
        (err, buffer) => {
          if (err || !buffer) reject(err ?? new Error('native render returned no buffer'));
          else resolve(buffer);
        },
      );
    });
    const renderMs = Date.now() - renderStart;

    // ---- SSAA downsample: framebuffer dims → readback dims ----
    const downStart = Date.now();
    const fb = payload.framebuffer;
    const rb = payload.readback;
    const factorW = fb.w / rb.w;
    const factorH = fb.h / rb.h;
    if (factorW !== factorH || !Number.isInteger(factorW) || factorW < 1) {
      throw new Error(
        `native backend: non-integer/anisotropic SSAA factor (fb ${fb.w}x${fb.h}, readback ${rb.w}x${rb.h})`,
      );
    }
    const factor = factorW;
    const actual = resolveActualDims(
      raw.length, fb.w, fb.h,
      payload.cssViewport.w, payload.cssViewport.h, payload.pixelRatio,
    );
    let rgba: Buffer;
    if (factor === 1 && actual.w === fb.w && actual.h === fb.h) {
      rgba = raw;
    } else {
      rgba = boxDownsample(raw, actual.w, actual.h, fb.w, fb.h, factor);
    }
    const downMs = Date.now() - downStart;

    const expected = rb.w * rb.h * 4;
    if (rgba.length !== expected) {
      throw new Error(
        `native backend: frame ${frameIndex} produced ${rgba.length}B, expected ${expected}B ` +
        `(${rb.w}x${rb.h}*4)`,
      );
    }
    verbose(
      `[renderer native f=${frameIndex}] apply=${applyMs}ms render=${renderMs}ms ` +
      `down=${downMs}ms actual=${actual.w}x${actual.h} refreshed=${refreshed}\n`,
    );
    return {
      rgba,
      detail: `apply=${applyMs}ms render=${renderMs}ms down=${downMs}ms refresh=${refreshed}`,
    };
  }

  async recycle(): Promise<void> {
    // The orchestrator's recycle cadence exists to bound renderer memory
    // growth. Native holds far less steady-state than a Chrome page, but a
    // full rebuild is cheap (style + tiles come from the disk cache) and
    // keeps the two backends' recycle semantics identical.
    if (!this.setupPayload) {
      process.stderr.write('[renderer] recycle without prior setup, ignoring\n');
      return;
    }
    await this.setup(this.setupPayload);
  }

  async shutdown(): Promise<void> {
    if (this.map) {
      this.map.release();
      this.map = null;
    }
  }
}
