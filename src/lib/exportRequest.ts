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

/** Build the payload for the `render_export` Tauri command. Pure. */
export function buildExportRequest(inputs: ExportRequestInputs): RenderExportRequest {
  const layoutCfg = pickLayout(inputs.layouts, inputs.aspect);
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
