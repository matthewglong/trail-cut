// Pure builder for the `render_export` IPC payload (task 060).
//
// Compiles the timeline, picks the layout for the requested aspect (falling
// back to `defaultLayout` if the project hasn't configured one), runs
// `resolveSlots`, and assembles the wire shape Rust's `RenderExportRequest`
// deserializes. Pure: no Tauri imports, no IO. The actual `invoke()` lives
// in the consuming component so error / progress UI can decorate it.

import { compileTimeline, type CompiledTimeline } from './cameraIntent';
import { indexRoute } from './routeLocation';
import {
  defaultLayout,
  legalSplitSides,
  resolveSlots,
  type AspectRatio,
  type LayoutConfig,
  type LayoutDescriptor,
  type OutputResolution,
} from './layout';
import type {
  Clip,
  MapSettings,
  Project,
  Route,
  TransitionFeel,
} from '../types';
import type { ExportJob } from './exportFilenames';

/** Channel selector. Mirrors the Rust enum-by-string in `RenderExportRequest.channel`.
 *  060 implements only `"map_only"`; 070/090 introduce the others. */
export type ExportChannel = 'map_only' | 'video_only' | 'composite';

/** User-selectable video codec preference (Phase 1 scaffolding, export-controls
 *  plan). The string tags match Rust's `CodecPreference` serde shape
 *  (`rename_all = "snake_case"`). Phase 3 wires the value into the composite
 *  branch's encoder selection; Phase 1 only adds it to the wire protocol with
 *  a sensible default (`"auto"`). */
export type CodecPreference = 'auto' | 'h264' | 'hevc';

/** User-selectable frame rate. `auto` resolves to the max source fps, clamped
 *  to {24, 30, 60}, in Phase 2; Phase 1 only carries the choice on the
 *  `ExportInputs` type and resolves the default `explicit 30` for the wire
 *  payload's pre-existing `fps` field. */
export type FrameRateChoice =
  | { kind: 'auto' }
  | { kind: 'explicit'; fps: 24 | 30 | 60 };

/** Phase 1 defaults — exposed for both the builder and tests. */
const DEFAULT_RESOLUTION: OutputResolution = '1080p';
const DEFAULT_CODEC_PREFERENCE: CodecPreference = 'auto';
const DEFAULT_AUDIO_BITRATE_KBPS = 256;
const DEFAULT_FRAME_RATE: FrameRateChoice = { kind: 'explicit', fps: 30 };

/** Inputs the builder needs from the live editor state. Matches what
 *  `ProjectView` already keeps around — no extra plumbing required.
 *
 *  Phase 1 of the export-controls plan added four optional fields
 *  (`resolution`, `codecPreference`, `audioBitrateKbps`, `frameRate`).
 *  All are optional so existing callers keep working unchanged; defaults
 *  preserve current behavior. Phase 2 makes `frameRate` the source of
 *  truth for the wire-level `fps`; the prior `fps: number` input is gone. */
export interface ExportRequestInputs {
  channel: ExportChannel;
  outputPath: string;
  aspect: AspectRatio;
  clips: Clip[];
  route: Route | null;
  mapSettings: MapSettings;
  transitionFeel?: TransitionFeel;
  /** Per-aspect layout configuration, typically `project.layouts`. When the
   *  entry for `aspect` is absent or null, `defaultLayout(aspect)` is used. */
  layouts?: Project['layouts'];
  /** Output resolution. Default `'1080p'`. Phase 4 consumes it (canvas
   *  size); Phase 1 only round-trips the value to Rust. */
  resolution?: OutputResolution;
  /** Video codec preference. Default `'auto'`. Phase 3 consumes it. */
  codecPreference?: CodecPreference;
  /** AAC audio bitrate in kbps. Default `256`. Phase 3 consumes it. */
  audioBitrateKbps?: number;
  /** Frame rate. Default `{ kind: 'explicit', fps: 30 }`. Phase 2 resolves
   *  `{ kind: 'auto' }` to a concrete fps against visible clips' source
   *  frame rates and emits a warning when an explicit fps exceeds the max
   *  source fps. */
  frameRate?: FrameRateChoice;
}

/** The shape Rust's `RenderExportRequest` deserializes. Matches the IPC
 *  contract in PLAN.md §"IPC contract". `timeline`, `route`, `clips`, and
 *  `mapSettings` are forwarded opaquely to the renderer worker; only
 *  `timeline.totalDurationMs` is read on the Rust side.
 *
 *  Phase 1 of the export-controls plan adds `codec_preference`,
 *  `audio_bitrate_kbps`, and a `warnings: string[]` field. Resolution lives
 *  inside `layout` (the `LayoutDescriptor` carries it). All new fields are
 *  populated with sensible defaults so existing exports are unchanged. */
export interface RenderExportRequest {
  channel: ExportChannel;
  fps: number;
  output_path: string;
  layout: LayoutDescriptor;
  codec_preference: CodecPreference;
  audio_bitrate_kbps: number;
  /** Compile-time warnings (e.g. "fps exceeds source"); Phase 2 populates,
   *  Phase 1 defaults to `[]`. Nothing reads it yet. */
  warnings: string[];
  // Flattened project state — same fields the renderer worker's `setup`
  // command consumes (see `src-tauri/sidecars/renderer/__tests__/setupFixture.ts`).
  timeline: CompiledTimeline;
  route: Route | null;
  clips: Clip[];
  mapSettings: MapSettings;
}

/** Resolve a `FrameRateChoice` to a concrete output fps against the project's
 *  visible clips. Pure, no IO.
 *
 *  - `{ kind: 'auto' }`: pick the max `frame_rate` reported across visible
 *    clips and snap it down to {24, 30, 60}. Snapping rule: ≥60 → 60, ≥30
 *    → 30, else → 24. When no visible clip reports a source fps (empty
 *    list or all `null`), default to 30 — matches the prior hardcoded
 *    behavior so a project with no fps metadata exports identically to
 *    before Phase 2.
 *  - `{ kind: 'explicit', fps }`: use the user-chosen fps verbatim. Emit a
 *    warning when it exceeds the max source fps (FFmpeg will duplicate
 *    frames to fill the gap; the user should know).
 *
 *  Warnings surface on the compiled `RenderExportRequest.warnings` array;
 *  nothing consumes them in Phase 2 — the UI session will. */
export function resolveFrameRate(
  choice: FrameRateChoice,
  visibleClips: Clip[],
): { fps: number; warnings: string[] } {
  if (choice.kind === 'explicit') {
    const maxSource = maxSourceFps(visibleClips);
    const warnings: string[] = [];
    if (maxSource != null && choice.fps > maxSource) {
      warnings.push(
        `Output fps ${choice.fps} exceeds max source fps ${maxSource}; frames will be duplicated.`,
      );
    }
    return { fps: choice.fps, warnings };
  }
  // Auto: snap max source fps down to {24, 30, 60}. Missing metadata → 30.
  const maxSource = maxSourceFps(visibleClips) ?? 30;
  const snapped = maxSource >= 60 ? 60 : maxSource >= 30 ? 30 : 24;
  return { fps: snapped, warnings: [] };
}

/** Max `frame_rate` across `clips.filter(c => c.visible)`, or `null` when
 *  no visible clip reports a numeric source fps. Used by `resolveFrameRate`. */
function maxSourceFps(clips: Clip[]): number | null {
  const vals: number[] = [];
  for (const c of clips) {
    if (!c.visible) continue;
    if (typeof c.frame_rate === 'number') vals.push(c.frame_rate);
  }
  if (vals.length === 0) return null;
  return Math.max(...vals);
}

/** Pick the layout for `aspect`, falling back to `defaultLayout(aspect)`. */
export function pickLayout(
  layouts: Project['layouts'] | undefined,
  aspect: AspectRatio,
): LayoutConfig {
  return layouts?.[aspect] ?? defaultLayout(aspect);
}

/** Build the payload for the `render_export` Tauri command. Pure.
 *  Throws on Split-legality violations (task 100): an inverse-orientation
 *  split (`video_side: 'left'` at 9:16 / 4:5; `video_side: 'top'` at 16:9)
 *  is rejected before the IPC call, mirroring the Rust-side
 *  `validate_request` check. The configurator (110) constrains its swap
 *  toggle via `legalSplitSides` so this throw is normally unreachable from
 *  the UI; it backstops hand-edited project files. */
export function buildExportRequest(inputs: ExportRequestInputs): RenderExportRequest {
  const layoutCfg = pickLayout(inputs.layouts, inputs.aspect);
  if (layoutCfg.mode === 'split') {
    const legal = legalSplitSides(inputs.aspect);
    if (!legal.includes(layoutCfg.video_side)) {
      throw new Error(
        `split layout uses inverse-orientation video_side=${layoutCfg.video_side} for aspect ${inputs.aspect}; legal sides are ${legal.join('/')}`,
      );
    }
  }
  const resolution: OutputResolution = inputs.resolution ?? DEFAULT_RESOLUTION;
  const resolved = resolveSlots(layoutCfg, inputs.aspect, resolution);
  const layout: LayoutDescriptor = {
    aspect: inputs.aspect,
    resolution,
    layout: layoutCfg,
    resolved,
  };

  const timeline = compileTimeline(
    inputs.clips,
    indexRoute(inputs.route),
    inputs.mapSettings,
    { transition_feel: inputs.transitionFeel ?? 'natural' },
  );

  // Phase 2: resolve `inputs.frameRate` (`FrameRateChoice`) to a concrete
  // wire-level `fps`. The default `{ kind: 'explicit', fps: 30 }` preserves
  // pre-Phase-2 behavior (every existing caller that passed `fps: 30`).
  // Warnings surface on the compiled request's `warnings` array — the UI
  // session will consume them; nothing in this layer does.
  const { fps, warnings: fpsWarnings } = resolveFrameRate(
    inputs.frameRate ?? DEFAULT_FRAME_RATE,
    inputs.clips,
  );

  return {
    channel: inputs.channel,
    fps,
    output_path: inputs.outputPath,
    layout,
    codec_preference: inputs.codecPreference ?? DEFAULT_CODEC_PREFERENCE,
    audio_bitrate_kbps: inputs.audioBitrateKbps ?? DEFAULT_AUDIO_BITRATE_KBPS,
    warnings: [...fpsWarnings],
    timeline,
    route: inputs.route,
    clips: inputs.clips,
    mapSettings: inputs.mapSettings,
  };
}

/** Project context shared across every job in a render queue. Per-job
 *  quality and fps live on the `ExportJob` itself (see `exportFilenames.ts`)
 *  rather than here — the grid-modal redesign lets a single queue interleave
 *  jobs at multiple resolutions and frame rates, so the wire-level `fps` and
 *  `LayoutDescriptor.resolution` are derived from the job, not the shared
 *  context. */
export interface ExportRequestContext {
  clips: Clip[];
  route: Route | null;
  mapSettings: MapSettings;
  transitionFeel?: TransitionFeel;
  layouts?: Project['layouts'];
}

/** Build a per-job request closure. The compiled timeline doesn't depend on
 *  the chosen aspect/channel, so callers that drive a multi-job queue (270's
 *  `useExportQueue`) get one wrapper that produces a `RenderExportRequest`
 *  per `ExportJob`. Per-job `quality` (→ `resolution`) and `fps` (→
 *  `frameRate: { kind: 'explicit', fps }`) come from the job; everything
 *  else from the shared context. */
export function buildJobRequest(
  context: ExportRequestContext,
  job: ExportJob,
): RenderExportRequest {
  return buildExportRequest({
    channel: job.channel,
    outputPath: job.outputPath,
    aspect: job.aspect,
    clips: context.clips,
    route: context.route,
    mapSettings: context.mapSettings,
    transitionFeel: context.transitionFeel,
    layouts: context.layouts,
    resolution: job.quality,
    frameRate: { kind: 'explicit', fps: job.fps },
  });
}
