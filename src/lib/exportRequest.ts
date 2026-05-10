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

/** Inputs the builder needs from the live editor state. Matches what
 *  `ProjectView` already keeps around — no extra plumbing required. */
export interface ExportRequestInputs {
  channel: ExportChannel;
  fps: number;
  outputPath: string;
  aspect: AspectRatio;
  clips: Clip[];
  route: Route | null;
  mapSettings: MapSettings;
  transitionFeel?: TransitionFeel;
  /** Per-aspect layout configuration, typically `project.layouts`. When the
   *  entry for `aspect` is absent or null, `defaultLayout(aspect)` is used. */
  layouts?: Project['layouts'];
}

/** The shape Rust's `RenderExportRequest` deserializes. Matches the IPC
 *  contract in PLAN.md §"IPC contract". `timeline`, `route`, `clips`, and
 *  `mapSettings` are forwarded opaquely to the renderer worker; only
 *  `timeline.totalDurationMs` is read on the Rust side. */
export interface RenderExportRequest {
  channel: ExportChannel;
  fps: number;
  output_path: string;
  layout: LayoutDescriptor;
  // Flattened project state — same fields the renderer worker's `setup`
  // command consumes (see `src-tauri/sidecars/renderer/__tests__/setupFixture.ts`).
  timeline: CompiledTimeline;
  route: Route | null;
  clips: Clip[];
  mapSettings: MapSettings;
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
  const resolved = resolveSlots(layoutCfg, inputs.aspect);
  const layout: LayoutDescriptor = {
    aspect: inputs.aspect,
    layout: layoutCfg,
    resolved,
  };

  const timeline = compileTimeline(
    inputs.clips,
    indexRoute(inputs.route),
    inputs.mapSettings,
    { transition_feel: inputs.transitionFeel ?? 'natural' },
  );

  return {
    channel: inputs.channel,
    fps: inputs.fps,
    output_path: inputs.outputPath,
    layout,
    timeline,
    route: inputs.route,
    clips: inputs.clips,
    mapSettings: inputs.mapSettings,
  };
}

/** Project context shared across every job in a render queue (task 270). */
export interface ExportRequestContext {
  fps: number;
  clips: Clip[];
  route: Route | null;
  mapSettings: MapSettings;
  transitionFeel?: TransitionFeel;
  layouts?: Project['layouts'];
}

/** Build a per-job request closure. The compiled timeline doesn't depend on
 *  the chosen aspect/channel, so callers that drive a multi-job queue (270's
 *  `useExportQueue`) get one wrapper that produces a `RenderExportRequest`
 *  per `ExportJob`. Call sites still go through `buildExportRequest` so the
 *  Split-legality check and `pickLayout` fallback remain in one place. */
export function buildJobRequest(
  context: ExportRequestContext,
  job: ExportJob,
): RenderExportRequest {
  return buildExportRequest({
    channel: job.channel,
    fps: context.fps,
    outputPath: job.outputPath,
    aspect: job.aspect,
    clips: context.clips,
    route: context.route,
    mapSettings: context.mapSettings,
    transitionFeel: context.transitionFeel,
    layouts: context.layouts,
  });
}
