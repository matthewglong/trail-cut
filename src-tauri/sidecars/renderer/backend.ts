// Shared contract between the renderer worker's protocol shell (index.ts)
// and its two rendering backends (chromeBackend.ts, nativeBackend.ts).
//
// The strangle shape (Phase 5 renderer lane): index.ts owns the stdio
// protocol to the Rust orchestrator and the engine-agnostic per-frame
// mapVisuals translation (scene.ts); a backend owns only "given this scene
// and this frame's tuples, produce readback-sized RGBA bytes". The wire
// format to Rust is identical for every backend — the orchestrator cannot
// tell which engine rendered a frame.
//
// Backend selection: TRAILCUT_RENDERER_BACKEND = 'chrome' (default) |
// 'native'. Default stays chrome until Matthew signs off on the cutover
// (which is additionally gated on the cross-engine golden-frame gate that
// cannot exist until the color lane lands — see PROGRESS.md).

import type { CompiledTimeline } from '../../../src/lib/cameraIntent';
import type { Clip, Route, MapSettings, Waypoint } from '../../../src/types';

// ---- Protocol types (wire shapes from the Rust orchestrator) --------------

export interface SetupCmd {
  cmd: 'setup';
  /** CSS-pixel viewport dimensions the renderer is laid out at. `w`
   *  always equals `canonicalMapCssWidth(aspect)`; `h` is derived from the
   *  framebuffer height divided by `pixelRatio` so map_slot's own aspect
   *  (which can differ from the full export's aspect in composite layouts)
   *  is preserved. */
  cssViewport: { w: number; h: number };
  /** High-res drawing buffer the renderer paints into — the map slot
   *  pixel dims × the SSAA supersample factor. */
  framebuffer: { w: number; h: number };
  /** Dims the renderer downsamples `framebuffer` to and writes back —
   *  equals the map slot pixel dims. The returned RGBA buffer is sized to
   *  these (`readback.w * readback.h * 4`), so supersampling never inflates
   *  the wire. */
  readback: { w: number; h: number };
  /** `framebuffer.w / cssViewport.w` (a float; carries the supersample
   *  factor, so > 1 for every supersampled export). Chrome: MapLibre's
   *  `pixelRatio` constructor arg + `deviceScaleFactor`. Native: the Map's
   *  constructor-time `ratio` (the same lever — measured equivalent,
   *  .spike/native-gl/MECHANICAL_VERDICT.md §3). */
  pixelRatio: number;
  fps: number;
  timeline: CompiledTimeline;
  route: Route | null;
  clips: Clip[];
  mapSettings: MapSettings;
  /** First-class waypoints (schema v7). Always present (`[]` when the
   *  project has none). */
  waypoints: Waypoint[];
}

export interface RenderCmd {
  cmd: 'render';
  frame_index: number;
  project_time_ms: number;
}
export interface RecycleCmd { cmd: 'recycle' }
export interface ShutdownCmd { cmd: 'shutdown' }
export type Cmd = SetupCmd | RenderCmd | RecycleCmd | ShutdownCmd;

// ---- Per-frame payload (engine-agnostic tuple translation) -----------------

/** The per-frame state both backends consume — the exact shape the chrome
 *  page's `__applyFrame` has always received. Built once per frame by
 *  scene.ts `buildFramePayload` from the shared mapVisuals surface; backends
 *  apply the tuples through their engine's API and never re-derive them. */
export interface FramePayload {
  /** project_time_ms — chrome feeds it to maplibregl.setNow (frozen clock);
   *  native has no wall-clock animations to freeze (every animated value
   *  arrives pre-resolved in `paints`). */
  t: number;
  /** Per-frame GeoJSON updates, `[sourceId, data]`. */
  sources: Array<[string, unknown]>;
  /** Paint property triplets `[layerId, prop, value]` — includes the
   *  re-resolved static paints so per-clip overrides take effect at cuts. */
  paints: Array<[string, string, unknown]>;
  /** Layout property triplets `[layerId, prop, value]`. */
  layouts: Array<[string, string, unknown]>;
  /** `line-gradient` values `[layerId, expressionOrNull]`. */
  gradients: Array<[string, unknown]>;
  camera: {
    center: { lng: number; lat: number };
    zoom: number;
    bearing: number;
    pitch: number;
  };
}

// ---- Backend interface ------------------------------------------------------

export interface RenderedFrame {
  /** Readback-sized RGBA bytes (`readback.w * readback.h * 4`), top-down row
   *  order — exactly what goes on the wire to the orchestrator. */
  rgba: Buffer;
  /** Transport-specific timing detail spliced into the worker's always-on
   *  per-frame summary line (e.g. `eval=12ms decode=3ms`). */
  detail: string;
}

export interface RendererBackend {
  /** Boot the engine for this export job. Called once per `setup` command;
   *  the backend must retain what it needs for `recycle()`. */
  setup(payload: SetupCmd): Promise<void>;
  /** Render one frame. Sequential — the protocol never overlaps calls. */
  renderFrame(frame: FramePayload, frameIndex: number): Promise<RenderedFrame>;
  /** Orchestrator-cadence resource reset (default: every 60 frames). */
  recycle(): Promise<void>;
  shutdown(): Promise<void>;
}

// ---- Shared flags ----------------------------------------------------------

/** Diagnostic verbosity — mirrors the pre-split TRAILCUT_RENDERER_VERBOSE. */
export const VERBOSE = process.env.TRAILCUT_RENDERER_VERBOSE === '1';
export function verbose(msg: string): void {
  if (VERBOSE) process.stderr.write(msg);
}
