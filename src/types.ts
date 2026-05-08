export interface GpsCoord {
  lat: number;
  lng: number;
}

export interface ClipMetadata {
  id: string;
  path: string;
  filename: string;
  created_at: string | null;
  duration_ms: number | null;
  gps: GpsCoord | null;
  resolution: string | null;
  frame_rate: number | null;
}

export interface TrimRange {
  in_ms: number;
  out_ms: number;
}

export interface FocalPoint {
  x: number;
  y: number;
  zoom: number;
}

export interface StabilizeSettings {
  enabled: boolean;
  shakiness: number;
}

export interface Effects {
  stabilize: StabilizeSettings;
  speed: number;
}

export type MapOverrides = Partial<MapSettings>;

export interface Clip {
  id: string;
  path: string;
  filename: string;
  created_at: string | null;
  duration_ms: number | null;
  gps: GpsCoord | null;
  resolution: string | null;
  frame_rate: number | null;
  trim: TrimRange | null;
  focal_point: FocalPoint;
  effects: Effects;
  visible: boolean;
  map_overrides: MapOverrides | null;
  /** Optional per-clip entry-transition authoring. See
   *  `ClipEntryTransition`. Project-level defaults still apply for unset
   *  fields. */
  entry_transition?: ClipEntryTransition;
}

export interface TrackPoint {
  lat: number;
  lng: number;
  elevation: number | null;
  timestamp: string | null;
}

export interface Route {
  source_path: string;
  format: string;
  trackpoints: TrackPoint[];
}

export type TriMode = 'none' | 'visited' | 'full';

export type MapStyleId = 'default' | '3d' | 'satellite';

export type BearingMode = 'auto' | 'fixed';

export interface MapSettings {
  route_mode: TriMode;
  waypoints_mode: TriMode;
  follow_playhead: boolean;
  map_style: MapStyleId;
  /** Zoom level the map animates to when a clip becomes active. */
  zoom: number;
  /** How the map's bearing is determined:
   *  - 'fixed'  → pinned to `bearing_degrees` (default: 0 = north up)
   *  - 'auto'   → tracks GPX direction of travel at the current playhead */
  bearing_mode: BearingMode;
  /** Fixed-mode bearing in degrees, normalized 0–359. Ignored when
   *  `bearing_mode` is 'auto'. */
  bearing_degrees: number;
  /** Number of bearing keyframes (stops) used in auto mode. The clip's
   *  trail segment is divided into this many chunks, each with a
   *  representative bearing. The map arcs smoothly between them.
   *  1 = single fixed bearing for the whole clip. */
  bearing_stops: number;
}

export const DEFAULT_MAP_SETTINGS: MapSettings = {
  route_mode: 'full',
  waypoints_mode: 'full',
  follow_playhead: true,
  map_style: 'default',
  zoom: 14,
  bearing_mode: 'fixed',
  bearing_degrees: 0,
  bearing_stops: 3,
};

/** Merge project defaults with per-clip overrides. */
export function resolveMapSettings(defaults: MapSettings, overrides: MapOverrides | null | undefined): MapSettings {
  if (!overrides) return defaults;
  return { ...defaults, ...overrides };
}

/** Re-exported from `lib/layout.ts` so `types.ts` stays the single import
 *  surface for project-shape types. The `Project.layouts` field below stores
 *  one optional layout per output aspect (task 050). */
export type {
  AspectRatio,
  LayoutConfig,
  PipLayout,
  SplitLayout,
  ProjectLayouts,
  SlotResolution,
  PixelRect,
  OutputDimensions,
  LayoutDescriptor,
  NormalizedRect,
} from './lib/layout';

import type { ProjectLayouts } from './lib/layout';

/** Project-level "transition feel" knob. Drives the duration multiplier for
 *  cross-anchor Van Wijk arcs. Mirrors the union in cameraIntent.ts;
 *  duplicated here so types.ts stays free of cameraIntent imports
 *  (cameraIntent itself imports from types.ts). */
export type TransitionFeel = 'natural' | 'snappy' | 'slow';

/** The fully-resolved camera the compiled timeline holds before clip 1 (and
 *  uses as the "from" endpoint of clip 1's entry transition). Persisted only
 *  when the user overrides the computed default. See
 *  `docs/migration/COMPILED_TIMELINE_PLAN.md` §"Project Start Camera". */
export interface ProjectStartCamera {
  center: GpsCoord;
  zoom: number;
  bearing: number;
  pitch: number;
}

/** Per-clip (and project-default) authoring of an entry transition. All
 *  fields are clip-local; nothing here lives on project-time. The compiler
 *  (task 520) consumes these together with media duration and clip ordering
 *  to produce a TransitionSpan on the project-time axis.
 *
 *  Field semantics (per `COMPILED_TIMELINE_PLAN.md` §"Data Model"):
 *  - `enabled` — when `false`, the transition window collapses to zero
 *    duration and the camera jumps from previous → current at the cut.
 *  - `duration_ms` — clip-local; if unset, the compiler auto-derives via
 *    `arcDurationMs(arc, feel)`.
 *  - `entry_bias` — float in `[-1, 1]`. -1 = entirely pre-cut, 0 = centered,
 *    +1 = entirely post-cut. Compiler clamps; no runtime clamping here.
 *  - `feel` — optional per-clip override of the project-level feel.
 *    `feel` only affects the auto-derived duration; an authored
 *    `duration_ms` is respected literally.
 *
 *  Field names are snake_case to match the rest of project.json (which is
 *  Rust-serde-serialized) — same convention as `transition_feel`,
 *  `map_overrides`, `bearing_mode`, etc. */
export interface ClipEntryTransition {
  enabled?: boolean;
  duration_ms?: number;
  entry_bias?: number;
  feel?: TransitionFeel;
}

export interface Project {
  version: number;
  name: string;
  thumbnail: string | null;
  clips: Clip[];
  route: Route | null;
  /** Per-aspect layout configuration (v4+). Always populated post-080:
   *  fresh projects ship with `9_16` seeded by `defaultLayout('9_16')` and
   *  `4_5` / `16_9` left null until the user picks those aspects in the
   *  configurator (task 110). The Rust `load_project` backfills pre-080
   *  bundles where the field was absent or null. */
  layouts: ProjectLayouts;
  map_settings?: MapSettings;
  /** Optional: defaults to 'natural' at the consumer. Pre-task-350 projects
   *  on disk lack this field; Rust serde fills in `None` and the frontend
   *  resolves at the call site via `?? 'natural'`. */
  transition_feel?: TransitionFeel;
  /** Optional override of the computed project start camera. When absent,
   *  the compiler synthesizes a sensible default (centroid of clip starts,
   *  zoom 12, bearing 0, pitch 0/60-by-style). */
  start_camera?: ProjectStartCamera;
  /** Project-level defaults for every clip's entry transition. Each clip's
   *  own `entry_transition` overrides individual fields. */
  default_entry_transition?: ClipEntryTransition;
}

export interface RecentProject {
  path: string;
  name: string;
  clip_count: number;
  last_opened: string;
  thumbnail: string | null;
  first_clip_date: string | null;
}
