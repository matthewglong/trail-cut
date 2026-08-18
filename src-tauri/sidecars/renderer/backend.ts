// Shared contract between the renderer worker's protocol shell (index.ts)
// and its rendering backend (nativeBackend.ts).
//
// The strangle shape (Phase 5 renderer lane, completed): index.ts owns the
// stdio protocol to the Rust orchestrator and the engine-agnostic per-frame
// mapVisuals translation (scene.ts); a backend owns only "given this scene
// and this frame's tuples, produce readback-sized RGBA bytes". The wire
// format to Rust is backend-invariant — the orchestrator cannot tell which
// engine rendered a frame. The chrome backend was removed post-cutover
// (git history has it); the interface stays because it is the seam the
// next engine swap would use.
//
// Backend selection: TRAILCUT_RENDERER_BACKEND = 'native' (default and
// only value). Kept as a loud single-value switch — see selectBackendName.

import type { CompiledTimeline } from '../../../src/lib/cameraIntent';
import type { Clip, Route, MapSettings, Waypoint } from '../../../src/types';
import type { BasemapSpec, HaloCompositeGroup } from '../../../src/lib/mapVisuals';

// ---- Protocol types (wire shapes from the Rust orchestrator) --------------

export interface SetupCmd {
  cmd: 'setup';
  /** CSS-pixel viewport dimensions the renderer is laid out at: the MAP
   *  SLOT's canonical (1080p-class) CSS dims under the lever model —
   *  `canonicalMapViewport` in `src/lib/layout.ts` (slot px ÷ resolution
   *  multiplier), NOT the full frame's `canonicalMapCssWidth`. This is the
   *  reference space: zoom and decoration sizes apply verbatim in it, and
   *  the preview resolves intents against the same dims
   *  (`canonicalSlotCss`) while displaying at its own fixed scale. */
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
   *  factor, so > 1 for every supersampled export). Applied as the Map's
   *  constructor-time `ratio` — the same lever GL JS exposes as the
   *  `pixelRatio` constructor arg (measured equivalent,
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
  /** project_time_ms. Native has no wall-clock animations to freeze —
   *  every animated value arrives pre-resolved in `paints`. (The retired
   *  chrome backend fed this to maplibregl.setNow as a frozen clock.) */
  t: number;
  /** The basemap the ACTIVE clip resolves to at `t` — `map_style` is
   *  per-clip overridable (`MapOverrides.camera.map_style`) and the active
   *  clip flips at the cut, so this can differ frame to frame. Backends
   *  compare `basemap.styleId` against the style they currently have loaded
   *  and reload only on a change; a reload wipes every source, layer and
   *  registered image, so the whole scene has to go back on (see
   *  nativeBackend's `applyScene`). Values are module constants from
   *  `buildBasemapSpec`, so an unchanged basemap costs nothing to carry. */
  basemap: BasemapSpec;
  /** Per-frame GeoJSON updates, `[sourceId, data]`. */
  sources: Array<[string, unknown]>;
  /** Paint property triplets `[layerId, prop, value]` — includes the
   *  re-resolved static paints so per-clip overrides take effect at cuts. */
  paints: Array<[string, string, unknown]>;
  /** Layout property triplets `[layerId, prop, value]`. */
  layouts: Array<[string, string, unknown]>;
  /** `line-gradient` values `[layerId, expressionOrNull]`. */
  gradients: Array<[string, unknown]>;
  /** Engine-level group-opacity composite config for the four halo layer
   *  pairs, re-resolved per frame from the active clip's merged
   *  MapSettings — same re-resolve-at-every-frame treatment as `paints`
   *  (`staticResolution` in `scene.ts` `buildFramePayload`), because halo
   *  opacity is a per-clip-overridable field (`MapOverrides.route/waypoints/
   *  pov.halo`). Backends apply it as a config swap only when the JSON
   *  differs from what they last applied — cheap engine-side, but not worth
   *  re-sending unchanged every frame. */
  haloComposites: HaloCompositeGroup[];
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

// ---- Backend selection -------------------------------------------------------

export type BackendName = 'native';

/** Resolve the TRAILCUT_RENDERER_BACKEND env value to a backend name.
 *  Pure (unit-tested in __tests__/backendSelect.test.ts); the worker entry
 *  point turns the throw into a loud stderr + exit(1). 'native' is the
 *  default and the only value — the chrome backend was removed at the
 *  Phase 5 cutover, and a stale 'chrome' (or any typo) must throw rather
 *  than silently render on an engine the caller didn't ask for. */
export function selectBackendName(raw: string | undefined): BackendName {
  const v = (raw ?? 'native').trim();
  if (v === '' || v === 'native') return 'native';
  if (v === 'chrome') {
    throw new Error(
      "TRAILCUT_RENDERER_BACKEND='chrome': the chrome backend was removed at " +
      'the Phase 5 cutover (native is the only engine). Check out a pre-cutover ' +
      'commit to compare engines.',
    );
  }
  throw new Error(
    `unknown TRAILCUT_RENDERER_BACKEND='${v}' (expected 'native')`,
  );
}

// ---- Shared flags ----------------------------------------------------------

/** Diagnostic verbosity — mirrors the pre-split TRAILCUT_RENDERER_VERBOSE. */
export const VERBOSE = process.env.TRAILCUT_RENDERER_VERBOSE === '1';
export function verbose(msg: string): void {
  if (VERBOSE) process.stderr.write(msg);
}
