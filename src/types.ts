export interface GpsCoord {
  lat: number;
  lng: number;
}

/** Source color regime — populated at import time by the WS0 color-pipeline
 *  foundation. Every downstream ingest formula (WS1 proxy, WS2 thumbnail,
 *  WS3 working-space export) branches on this string to select the right
 *  transform.
 *
 *  Wire format is snake_case to match the Rust `SourceColorClass` enum's
 *  serde rename in `src-tauri/src/util/color.rs`. The variants:
 *  - `'sdr_bt709'`     — Standard dynamic range, Rec.709.
 *  - `'hlg_bt2020'`    — HDR via HLG (ARIB STD-B67) on BT.2020.
 *  - `'pq_bt2020'`     — HDR via PQ (SMPTE ST 2084) on BT.2020.
 *  - `'dolby_vision'`  — Dolby Vision (Phase 1 treats as HLG base layer).
 *  - `'unknown'`       — No usable color metadata; treat as SDR.
 *
 *  Phase 2 log variants (defined now, populated only via user override —
 *  log formats can't be auto-detected, see ARCHITECTURE.md §"Phase 2
 *  additions"):
 *  - `'d_log'` | `'c_log'` | `'c_log2'` | `'c_log3'` — DJI / Canon log.
 *  - `'gp_log'`                                      — GoPro log.
 *  - `'v_log'`                                       — Panasonic V-Log.
 *  - `'s_log2'` | `'s_log3'`                         — Sony S-Log. */
export type SourceColorClass =
  | 'sdr_bt709'
  | 'hlg_bt2020'
  | 'pq_bt2020'
  | 'dolby_vision'
  | 'unknown'
  | 'd_log' | 'c_log' | 'c_log2' | 'c_log3'
  | 'gp_log' | 'v_log' | 's_log2' | 's_log3';

/** Per-clip color-space override (schema v9). Each axis is an optional zscale
 *  token (e.g. `'bt709'`, `'arib-std-b67'`, `'tv'`, `'bt2020nc'`) that patches
 *  that single axis of the clip's auto-detected source color space on the Rust
 *  side (`Clip::effective_color_space`). This is the "automatic from metadata,
 *  but overridable" surface — detection populates the base, the user corrects
 *  individual mistagged axes without disturbing the rest. The `inferred_*`
 *  flags record which axes detection guessed (the file tag was absent) so the
 *  UI can badge them for review. Mirrors the Rust `PerAxisOverride` struct. */
export interface PerAxisOverride {
  primaries?: string;
  transfer?: string;
  range?: string;
  matrix?: string;
  inferred_primaries?: boolean;
  inferred_transfer?: boolean;
  inferred_range?: boolean;
  inferred_matrix?: boolean;
}

/** Project-level working-color-space discriminant (schema v9). The export
 *  pipeline composites in this space. Today the only value is
 *  `'linear_bt2020_full'` (linear-light BT.2020 full-range float —
 *  byte-identical to the pre-v9 hardcoded working space). Absent on disk when
 *  equal to the default; consumers treat absent/undefined as
 *  `'linear_bt2020_full'`. A future wider working space (e.g. an ACEScg AP1
 *  tier) is one more union member here. Mirrors the Rust `WorkingColorSpaceId`
 *  enum. */
export type WorkingColorSpaceId = 'linear_bt2020_full';

/** WS9 — Per-camera source-format preset. One entry per
 *  `(camera_make, camera_model)` pair the user has confirmed via the
 *  group-level import UI's "Remember this for future X imports" checkbox.
 *  Persisted to `~/.trailcut/camera_presets.json` by the Rust commands in
 *  `commands::camera_presets`. Wire shape matches the Rust struct; snake_case
 *  `color_class` matches the `SourceColorClass` enum's serde rename. */
export interface CameraPreset {
  make: string;
  model: string;
  color_class: SourceColorClass;
}

/** Delivery target — color regime + codec + container only. Aspect comes
 *  from the outer export grid (`9_16 / 4_5 / 16_9`); resolution comes
 *  from the inner Quality picker (`720p / 1080p / 1440p / 2160p`). The
 *  output canvas is `outputDims(aspect, resolution)` — see
 *  `src/lib/layout.ts`.
 *
 *  Wire format is snake_case to match the Rust `DeliveryTarget` enum in
 *  `src-tauri/src/export/delivery.rs`. The variants:
 *  - `'sdr_h265'` — 8-bit BT.709, HEVC (videotoolbox / libx265) in mp4.
 *    Default for composite — modern efficiency, native on Apple / modern
 *    Android / Chrome / Edge.
 *  - `'sdr_h264'` — 8-bit BT.709, libx264 in mp4. Universal compatibility,
 *    including Windows default player without the Microsoft Store HEVC
 *    extension.
 *  - `'hdr_hlg'`  — 10-bit BT.2020 HLG, HEVC main10 in mp4. YouTube HDR
 *    convention.
 *  - `'hdr_pq'`   — 10-bit BT.2020 PQ / HDR10 (SMPTE ST 2084), HEVC main10 in
 *    mp4. Streaming / HDR10 convention. Same encoder shape as HLG, differing
 *    only in the color regime.
 *  - `'prores'`   — ProRes 4444 with alpha, yuva444p10le in mov. Archival
 *    master + the only legal target for map_only / video_only (lossless
 *    compositing intermediates).
 *
 *  Channel × target compatibility (enforced by `validate_target_for_channel`
 *  in `src-tauri/src/export/mod.rs`):
 *  - `composite`               → any codec target
 *  - `map_only` / `video_only` → `'prores'` only */
export type DeliveryTarget =
  | 'sdr_h265'
  | 'sdr_h264'
  | 'hdr_hlg'
  | 'hdr_pq'
  | 'prores';

/** Metadata about a single delivery target — picker dropdown row. Mirrors
 *  the Rust `DeliveryTarget` impl's `label()` / `short_label()` /
 *  `container_extension()` getters. Post-Issue-2: target carries color
 *  regime + codec + container only; aspect (outer grid) and resolution
 *  (Quality picker) are tracked independently and combine into the output
 *  canvas via `outputDims(aspect, resolution)` in `src/lib/layout.ts`. */
export interface DeliveryTargetInfo {
  id: DeliveryTarget;
  label: string;
  shortLabel: string;
  containerExtension: 'mp4' | 'mov';
  /** Channels this target is legal for. Composite accepts all targets;
   *  map_only and video_only accept only `'prores'`. */
  allowedChannels: ReadonlyArray<'composite' | 'map_only' | 'video_only'>;
}

/** Catalog of all four delivery targets in display order. The export UI
 *  iterates this and filters by `allowedChannels` to populate the picker.
 *  Keep in lockstep with `DeliveryTarget::all()` in Rust. */
export const DELIVERY_TARGETS: ReadonlyArray<DeliveryTargetInfo> = [
  {
    id: 'sdr_h265',
    label: 'SDR · H.265 (modern, smaller files)',
    shortLabel: 'SDR H.265',
    containerExtension: 'mp4',
    allowedChannels: ['composite'],
  },
  {
    id: 'sdr_h264',
    label: 'SDR · H.264 (universal compatibility)',
    shortLabel: 'SDR H.264',
    containerExtension: 'mp4',
    allowedChannels: ['composite'],
  },
  {
    id: 'hdr_hlg',
    label: 'HDR · HLG (10-bit BT.2020)',
    shortLabel: 'HDR HLG',
    containerExtension: 'mp4',
    allowedChannels: ['composite'],
  },
  {
    id: 'hdr_pq',
    label: 'HDR · PQ / HDR10 (10-bit BT.2020)',
    shortLabel: 'HDR PQ',
    containerExtension: 'mp4',
    allowedChannels: ['composite'],
  },
  {
    id: 'prores',
    label: 'ProRes 4444 (master / intermediate)',
    shortLabel: 'ProRes',
    containerExtension: 'mov',
    allowedChannels: ['composite', 'map_only', 'video_only'],
  },
] as const;

export interface ClipMetadata {
  id: string;
  path: string;
  filename: string;
  created_at: string | null;
  duration_ms: number | null;
  gps: GpsCoord | null;
  resolution: string | null;
  frame_rate: number | null;
  // ---- Color metadata (WS0) ----
  //
  // Populated at import by `import_media` / `scan_directory` after the
  // ExifTool pass. `source_color_class` is the result of running the raw
  // fields through `crate::util::color::classify` on the Rust side; the
  // frontend treats it as the source of truth for the clip's color regime.
  //
  // All fields are nullable because legacy clips (imported before WS0) and
  // any clip whose ffprobe pass failed at import time will carry the
  // defaults (`source_color_class: 'unknown'`, every raw tag `null`).
  pix_fmt: string | null;
  color_primaries: string | null;
  color_trc: string | null;
  color_space: string | null;
  color_range: string | null;
  has_dolby_vision: boolean;
  camera_make: string | null;
  camera_model: string | null;
  source_color_class: SourceColorClass;
  /** Phase 2 — user override of the auto-detected class. None/undefined in
   *  Phase 1; the Phase 2 source-format UI populates it for log formats.
   *  Consumers should prefer this when set and fall back to
   *  `source_color_class`. */
  user_color_class_override?: SourceColorClass;
  /** WS8 — suggested log encoding for the clip, derived from the camera
   *  make/model + 10-bit pix_fmt knowledge base on the Rust side
   *  (`crate::util::log_detection`). UI-only hint: WS9's source-format
   *  affordance reads this to show "Looks like D-Log — apply?" prompts.
   *  **Never auto-applied** — the export/preview pipeline ignores this
   *  field. The user confirms before the suggestion gets promoted to
   *  `user_color_class_override`.
   *
   *  `undefined` (or absent) for the vast majority of clips: iPhone, GoPro
   *  8-bit, unrecognised cameras, anything already tagged HDR. */
  suggested_log_class?: SourceColorClass;
  /** Per-axis color-space override (schema v9). See {@link PerAxisOverride}. */
  color_space_override?: PerAxisOverride;
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
  // ---- Color metadata (WS0) ----
  //
  // Mirrors `ClipMetadata`'s color fields. Persisted in `project.json` so
  // every clip in a saved project carries its color regime. Legacy bundles
  // (pre-WS0) deserialize with `source_color_class: 'unknown'` and the raw
  // tags `null` — Rust serde annotations handle the defaults.
  pix_fmt: string | null;
  color_primaries: string | null;
  color_trc: string | null;
  color_space: string | null;
  color_range: string | null;
  has_dolby_vision: boolean;
  camera_make: string | null;
  camera_model: string | null;
  source_color_class: SourceColorClass;
  /** Phase 2 user override; see `ClipMetadata.user_color_class_override`. */
  user_color_class_override?: SourceColorClass;
  /** WS8 — mirror of `ClipMetadata.suggested_log_class`. Persisted in
   *  `project.json` so the suggestion survives save/load (the Rust import
   *  pass isn't re-run on project open). WS9's source-format UI reads this
   *  to surface the "Looks like D-Log — apply?" affordance after a re-open.
   *  UI-only; never consulted by the ingest pipeline. */
  suggested_log_class?: SourceColorClass;
  /** Per-axis color-space override (schema v9). See {@link PerAxisOverride}.
   *  When set, the export ingest resolves this clip's source color space from
   *  the patched axes instead of the auto-detected class. */
  color_space_override?: PerAxisOverride;
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

/** Render mode for the waypoint label text. `numbered` writes the
 *  waypoint's 1-based index; `labeled` writes its `label` text (empty → blank,
 *  which MapLibre renders as no glyphs). The label rides the
 *  `waypoints-secondary` symbol layer (icon + text co-placed as one
 *  placement unit) and the per-frame swap is via
 *  `setLayoutProperty('waypoints-secondary', 'text-field', expr)`. */
export type WaypointLabelMode = 'numbered' | 'labeled';

/** Strategy for picking which waypoint (if any) is rendered at the "active"
 *  radius/colors per frame. `'none'` disables the highlight entirely;
 *  `'latest_passed'` picks the wall-clock-anchored waypoint with the largest
 *  anchor still ≤ the current marker's wall-clock. Fixed-position waypoints
 *  never participate in the latest-passed comparison in v1. */
export type ActiveWaypointMode = 'none' | 'latest_passed';

/** Position anchor for a `Waypoint`. Discriminated by `kind`:
 *
 *  - `wall_clock_ms` — anchored to the GPX timeline. Renders at the
 *    interpolated route position for `ms`. `fallback_gps` is the position
 *    used when GPX is missing or `ms` falls outside the route's covered
 *    range — mirrors the legacy clip→waypoint behavior where embedded clip
 *    GPS picked up wherever the GPX gap was.
 *  - `fixed` — pinned to a literal lat/lng. Does not participate in
 *    visited/latest-passed comparisons in v1. */
export type WaypointPosition =
  | { kind: 'wall_clock_ms'; ms: number; fallback_gps?: GpsCoord }
  | { kind: 'fixed'; lat: number; lng: number };

/** First-class waypoint. Owned by the project (not derived from clips at
 *  render time). `source` tracks provenance; `clip_id` is set when
 *  `source === 'clip'` so the sync helper in `src/lib/waypoints.ts` can find
 *  and re-anchor (or drop) the waypoint when the underlying clip is trimmed
 *  or removed. Deletion is sticky — re-trimming a clip whose waypoint was
 *  manually removed does NOT resurrect it. */
export interface Waypoint {
  id: string;
  position: WaypointPosition;
  label: string;
  source: 'clip' | 'gpx' | 'manual';
  clip_id?: string;
  /** Per-waypoint solid color override. When set, this waypoint paints its
   *  PRIMARY slot in this color regardless of `mapSettings.waypoints.color`.
   *  Solid only — a single point has no anchor to gradient across. */
  color?: string;
  /** Per-waypoint solid secondary-color override. When set, this waypoint
   *  paints its SECONDARY slot (the outline / accent element on shapes that
   *  define one) in this color regardless of
   *  `mapSettings.waypoints.secondary_color`. Solid only, same reason as
   *  `color`. Has no visible effect on one-color shapes (`ring`). */
  secondary_color?: string;
  /** Per-waypoint shape override. When set, wins over
   *  `mapSettings.waypoints.shape`. */
  shape?: WaypointShape;
}

// ---------- shared decoration value types ----------

export type SolidColor = { mode: 'solid'; solid: string };
export type GradientColor = { mode: 'gradient'; stops: GradientStop[] };
export type DecorationColor = SolidColor | GradientColor;

export interface GradientStop {
  /** Web Mercator line-progress fraction in [0, 1]. */
  fraction: number;
  /** CSS color string (hex or rgb()). */
  color: string;
}

/** Waypoint shape roster. Each name resolves to a `ShapeDescriptor` in
 *  `src/lib/mapVisuals/shapes.ts`, which carries the primary + (optional)
 *  secondary SDF rasterizers.
 *
 *  `'numbered-circle'` was removed in this iteration — numbering rides on
 *  the label layer, not the shape silhouette, so the dedicated shape was
 *  redundant. Legacy projects that persisted `'numbered-circle'` on disk
 *  are coerced to `'circle'` defensively in the icon-image expression
 *  emitted by `resolveStaticPaints`, so they keep rendering without a
 *  data-migration step. */
export type WaypointShape =
  | 'circle'
  | 'ring'
  | 'pin'
  | 'square'
  | 'diamond';

/** Available POV pulse animation roster. See `shapes-pov.md` Part 2. */
export type PovPulseStyle = 'steady' | 'throb' | 'sonar' | 'heartbeat';

/** POV pulse rate buckets. `'medium'` is today's hardcoded 1600ms period. */
export type PovPulseRate = 'slow' | 'medium' | 'fast';

// ---------- per-block setting types ----------

export interface CameraSettings {
  follow_playhead: boolean;
  map_style: MapStyleId;
  zoom: number;
  bearing_mode: BearingMode;
  bearing_degrees: number;
  bearing_stops: number;
}

export interface RouteSize {
  width: number;
}

export interface RouteSettings {
  mode: TriMode;
  color: DecorationColor;
  size: RouteSize;
  /** UI affordance — stash of the last gradient stop array, populated when
   *  the user toggles GRADIENT → SOLID so toggling back restores the prior
   *  gradient. Never read by the renderer — see `color-gradient.md` §13.
   *  Optional and additive; existing v8 projects round-trip unchanged with
   *  this field absent. */
  color_stops_cache?: GradientStop[];
}

export interface WaypointsSize {
  circle_radius: number;
  active_radius: number;
  /** Outline (secondary slot) thickness, expressed as a fraction of
   *  `PAINT_REFERENCE_WIDTH` like every other waypoint size field. The
   *  rendered outline is `stroke_width × PAINT_REFERENCE_WIDTH` CSS px at
   *  the canonical 1080p export width — independent of `circle_radius`, so
   *  enlarging the waypoint doesn't proportionally fatten its outline.
   *
   *  Implementation: thickness is baked into the secondary SDF icon at
   *  rasterize time (canvas-px thickness = `(stroke_width / circle_radius)
   *  × SHAPE_CANONICAL_RADIUS`). Preview and export each re-run
   *  `buildAllShapeIcons({ outlineThickness })` and re-register the atlas
   *  when this value (or `circle_radius`, which co-determines the canvas
   *  conversion) changes. */
  stroke_width: number;
  label_size: number;
}

export interface WaypointsSettings {
  mode: TriMode;
  /** Primary color — tints the waypoint's filled silhouette (every shape's
   *  primary SDF slot). Solid or gradient. Per-feature override via
   *  `Waypoint.color`. */
  color: DecorationColor;
  /** Secondary color — tints the waypoint's outline / accent element (every
   *  shape's secondary SDF slot). Solid or gradient. Per-feature override via
   *  `Waypoint.secondary_color`. One-color shapes (`ring`) ignore this. */
  secondary_color: DecorationColor;
  shape: WaypointShape;
  size: WaypointsSize;
  label_mode: WaypointLabelMode;
  active_mode: ActiveWaypointMode;
  /** Optional active-waypoint primary-color highlight. Falls back to the
   *  waypoint's resolved primary color at render time when unset. */
  active_color?: string;
  /** Optional active-waypoint secondary-color highlight. Falls back to the
   *  waypoint's resolved secondary color at render time when unset. Mirrors
   *  `active_color` so the two slots flip together when the user activates
   *  a waypoint. */
  active_secondary_color?: string;
  /** UI affordance — stash of the last gradient stop array for the PRIMARY
   *  color, populated when the user toggles GRADIENT → SOLID so toggling
   *  back restores the prior gradient. Never read by the renderer — see
   *  `color-gradient.md` §13. */
  color_stops_cache?: GradientStop[];
  /** UI affordance — stash for the SECONDARY color's gradient stops. Same
   *  semantics as `color_stops_cache` but for the secondary slot. */
  secondary_color_stops_cache?: GradientStop[];
}

export interface PovSize {
  pulse_radius: number;
  dot_radius: number;
  dot_stroke_width: number;
  pulse_start_radius: number;
  pulse_end_radius: number;
}

export interface PovSettings {
  /** Primary color — tints the POV marker's body (today's `live-marker-dot`
   *  fill; once POV gains shape variants, the primary SDF slot). Solid only:
   *  the POV marker is a single point and there's nothing to gradient
   *  across. */
  color: string;
  /** Secondary color — tints the POV marker's accent (today's
   *  `live-marker-dot` stroke; with POV shape variants, the secondary SDF
   *  slot). Solid only, same reason. Defaults to white to match the
   *  pre-refactor hard-coded white dot fill. */
  secondary_color: string;
  size: PovSize;
  pulse_style: PovPulseStyle;
  pulse_rate: PovPulseRate;
}

// ---------- top-level types ----------

export interface MapSettings {
  camera: CameraSettings;
  route: RouteSettings;
  waypoints: WaypointsSettings;
  pov: PovSettings;
}

/** Hand-curated nested override shape. Color and shape on waypoints live on
 *  the `Waypoint` entity, not here. */
export interface MapOverrides {
  camera?: Partial<CameraSettings>;
  map_style?: MapStyleId;
  route?: {
    mode?: TriMode;
    size?: Partial<RouteSize>;
  };
  waypoints?: {
    mode?: TriMode;
    size?: Partial<WaypointsSize>;
    label_mode?: WaypointLabelMode;
    active_mode?: ActiveWaypointMode;
    active_color?: string;
    active_secondary_color?: string;
  };
  pov?: {
    color?: string;
    secondary_color?: string;
    size?: Partial<PovSize>;
    pulse_style?: PovPulseStyle;
    pulse_rate?: PovPulseRate;
  };
}

export const DEFAULT_MAP_SETTINGS: MapSettings = {
  camera: {
    follow_playhead: true,
    map_style: 'default',
    zoom: 14,
    bearing_mode: 'fixed',
    bearing_degrees: 0,
    bearing_stops: 3,
  },
  route: {
    mode: 'full',
    color: { mode: 'solid', solid: '#bced09' },
    size: { width: 0.004 },
  },
  waypoints: {
    mode: 'full',
    color: { mode: 'solid', solid: '#bced09' },
    // Secondary defaults to white so the out-of-the-box look — accent-tinted
    // body with a clean white outline — matches what the native circle layer
    // produced before the shape-descriptor refactor.
    secondary_color: { mode: 'solid', solid: '#ffffff' },
    shape: 'circle',
    size: {
      circle_radius: 0.015,
      active_radius: 0.019,
      stroke_width: 0.003,
      label_size: 0.014,
    },
    label_mode: 'numbered',
    active_mode: 'latest_passed',
  },
  pov: {
    color: '#bced09',
    // Matches the pre-refactor hard-coded white dot fill on `live-marker-dot`.
    secondary_color: '#ffffff',
    size: {
      pulse_radius: 0.012,
      dot_radius: 0.013,
      dot_stroke_width: 0.004,
      pulse_start_radius: 0.012,
      pulse_end_radius: 0.033,
    },
    pulse_style: 'sonar',
    pulse_rate: 'medium',
  },
};

/** Minimum fractional separation enforced between adjacent gradient stops.
 *  Mirrors `color-gradient.md` §7b's drag-collision guard so the editor and
 *  the validator agree on what "two stops are too close" means. Stop
 *  fractions are stored at 4-decimal precision, so 0.005 leaves slack. */
const MIN_STOP_SEPARATION = 0.005;

/** Validate the invariants `color-gradient.md` and `data-model.md` rely on
 *  for a `GradientColor` payload to be renderable. Returns the validated
 *  color (with stops sorted by fraction) on success, or a sensible solid
 *  fallback on failure — never throws.
 *
 *  Failures we tolerate by falling back to solid:
 *  - fewer than 2 stops (a single point has no gradient)
 *  - any fraction outside [0, 1]
 *  - missing endpoint stop (no `fraction === 0` or no `fraction === 1`)
 *  - stops not sorted ascending after fixing
 *  - adjacent stops closer than `MIN_STOP_SEPARATION`
 *  - any color not a 6- or 7-character hex string
 *
 *  The fallback is `{ mode: 'solid', solid: stops[0]?.color ?? projectDefault }`
 *  so the user keeps at least the first stop's intent. */
function validateGradient(
  color: DecorationColor,
  projectDefaultSolid: string,
): DecorationColor {
  if (color.mode !== 'gradient') return color;
  const raw = color.stops;

  const fallback = (): DecorationColor => ({
    mode: 'solid',
    solid: isValidHex(raw[0]?.color ?? '')
      ? (raw[0].color.toLowerCase())
      : projectDefaultSolid,
  });

  if (!Array.isArray(raw) || raw.length < 2) return fallback();

  for (const stop of raw) {
    if (
      typeof stop?.fraction !== 'number' ||
      !Number.isFinite(stop.fraction) ||
      stop.fraction < 0 ||
      stop.fraction > 1
    ) {
      return fallback();
    }
    if (typeof stop.color !== 'string' || !isValidHex(stop.color)) {
      return fallback();
    }
  }

  // Defensive sort so an out-of-order array doesn't fail the separation
  // check by accident. The renderer also sorts; sorting here makes the
  // resolved value stable for downstream consumers.
  const sorted = [...raw].sort((a, b) => a.fraction - b.fraction);

  // Require both endpoints. Without them the gradient doesn't cover the
  // whole route, which is the design contract from §7b ("pinned endpoints").
  if (sorted[0].fraction !== 0 || sorted[sorted.length - 1].fraction !== 1) {
    return fallback();
  }

  // Adjacent-stop separation. Strictly less than MIN means a drag-collision
  // got past the editor guard (or a hand-edited project.json). Equal
  // fractions count as a collision — no two stops may share a fraction.
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].fraction - sorted[i - 1].fraction < MIN_STOP_SEPARATION) {
      return fallback();
    }
  }

  return { mode: 'gradient', stops: sorted };
}

function isValidHex(s: string): boolean {
  // Accept #RRGGBB or RRGGBB. (`color-gradient.md` §12 strips leading `#` on
  // ingest but we validate both shapes here so disk-shape variation doesn't
  // break us.)
  return /^#?[0-9a-fA-F]{6}$/.test(s);
}

/** Merge project defaults with per-clip overrides. Block-level spreads —
 *  no recursion. Also validates `route.color` and `waypoints.color`
 *  defensively (per `color-gradient.md` §13) so a malformed gradient on
 *  disk degrades gracefully to solid rather than crashing the renderer. */
export function resolveMapSettings(
  defaults: MapSettings,
  overrides: MapOverrides | null | undefined,
): MapSettings {
  // The "project default solid" we degrade to on a malformed gradient is
  // taken from the project's *solid* mode value when present. Falling back
  // to a gradient's first stop would inherit the malformed input we're
  // trying to escape from, so we use the canonical chartreuse literal
  // when the project itself is in gradient mode (i.e. the validator is
  // saving the renderer from disk corruption with no other source of truth).
  const projectRouteSolid =
    defaults.route.color.mode === 'solid'
      ? defaults.route.color.solid
      : '#bced09';
  const projectWaypointsSolid =
    defaults.waypoints.color.mode === 'solid'
      ? defaults.waypoints.color.solid
      : '#bced09';
  // The secondary slot's solid-fallback default is white rather than the
  // accent color — secondary is conceptually the outline, and reverting a
  // corrupted gradient to the project's primary color would blend the two
  // slots together. White matches the DEFAULT_MAP_SETTINGS seed and is the
  // sensible "neutral outline" choice when there's no other signal.
  const projectWaypointsSecondarySolid =
    defaults.waypoints.secondary_color.mode === 'solid'
      ? defaults.waypoints.secondary_color.solid
      : '#ffffff';

  if (!overrides) {
    return {
      camera: defaults.camera,
      route: {
        ...defaults.route,
        color: validateGradient(defaults.route.color, projectRouteSolid),
      },
      waypoints: {
        ...defaults.waypoints,
        color: validateGradient(defaults.waypoints.color, projectWaypointsSolid),
        secondary_color: validateGradient(
          defaults.waypoints.secondary_color,
          projectWaypointsSecondarySolid,
        ),
      },
      pov: defaults.pov,
    };
  }
  return {
    camera: { ...defaults.camera, ...overrides.camera },
    route: {
      ...defaults.route,
      ...overrides.route,
      color: validateGradient(defaults.route.color, projectRouteSolid),
      size: { ...defaults.route.size, ...overrides.route?.size },
    },
    waypoints: {
      ...defaults.waypoints,
      ...overrides.waypoints,
      color: validateGradient(defaults.waypoints.color, projectWaypointsSolid),
      secondary_color: validateGradient(
        defaults.waypoints.secondary_color,
        projectWaypointsSecondarySolid,
      ),
      size: { ...defaults.waypoints.size, ...overrides.waypoints?.size },
    },
    pov: {
      ...defaults.pov,
      ...overrides.pov,
      size: { ...defaults.pov.size, ...overrides.pov?.size },
    },
  };
}

/** Leaf-path enumeration of every override key in a `MapOverrides`. Used by
 *  the toolbar's override-highlight rollup. */
export type OverridePath =
  | `camera.${keyof CameraSettings}`
  | 'map_style'
  | 'route.mode'
  | `route.size.${keyof RouteSize}`
  | 'waypoints.mode'
  | 'waypoints.label_mode'
  | 'waypoints.active_mode'
  | 'waypoints.active_color'
  | 'waypoints.active_secondary_color'
  | `waypoints.size.${keyof WaypointsSize}`
  | 'pov.color'
  | 'pov.secondary_color'
  | 'pov.pulse_style'
  | 'pov.pulse_rate'
  | `pov.size.${keyof PovSize}`;

export function leafPaths(overrides: MapOverrides): Set<OverridePath> {
  const out = new Set<OverridePath>();
  if (overrides.camera) {
    for (const k of Object.keys(overrides.camera) as (keyof CameraSettings)[]) {
      out.add(`camera.${k}` as OverridePath);
    }
  }
  if (overrides.map_style !== undefined) out.add('map_style');
  if (overrides.route?.mode !== undefined) out.add('route.mode');
  if (overrides.route?.size) {
    for (const k of Object.keys(overrides.route.size) as (keyof RouteSize)[]) {
      out.add(`route.size.${k}` as OverridePath);
    }
  }
  if (overrides.waypoints) {
    if (overrides.waypoints.mode !== undefined) out.add('waypoints.mode');
    if (overrides.waypoints.label_mode !== undefined) out.add('waypoints.label_mode');
    if (overrides.waypoints.active_mode !== undefined) out.add('waypoints.active_mode');
    if (overrides.waypoints.active_color !== undefined) out.add('waypoints.active_color');
    if (overrides.waypoints.active_secondary_color !== undefined) {
      out.add('waypoints.active_secondary_color');
    }
    if (overrides.waypoints.size) {
      for (const k of Object.keys(overrides.waypoints.size) as (keyof WaypointsSize)[]) {
        out.add(`waypoints.size.${k}` as OverridePath);
      }
    }
  }
  if (overrides.pov) {
    if (overrides.pov.color !== undefined) out.add('pov.color');
    if (overrides.pov.secondary_color !== undefined) out.add('pov.secondary_color');
    if (overrides.pov.pulse_style !== undefined) out.add('pov.pulse_style');
    if (overrides.pov.pulse_rate !== undefined) out.add('pov.pulse_rate');
    if (overrides.pov.size) {
      for (const k of Object.keys(overrides.pov.size) as (keyof PovSize)[]) {
        out.add(`pov.size.${k}` as OverridePath);
      }
    }
  }
  return out;
}

/** Diff a fully-resolved `next` against project defaults to produce a sparse
 *  `MapOverrides`. Used in clip scope when the toolbar emits a complete
 *  `MapSettings` and we want to persist only what diverges. */
export function computeClipOverrides(
  next: MapSettings,
  project: MapSettings,
): MapOverrides {
  const out: MapOverrides = {};

  // camera
  const camera: Partial<CameraSettings> = {};
  const cameraKeys: (keyof CameraSettings)[] = [
    'follow_playhead',
    'map_style',
    'zoom',
    'bearing_mode',
    'bearing_degrees',
    'bearing_stops',
  ];
  for (const k of cameraKeys) {
    if (next.camera[k] !== project.camera[k]) {
      (camera as Record<string, unknown>)[k] = next.camera[k];
    }
  }
  if (Object.keys(camera).length) out.camera = camera;

  // route
  const route: NonNullable<MapOverrides['route']> = {};
  if (next.route.mode !== project.route.mode) route.mode = next.route.mode;
  const routeSize = diffPartial(next.route.size, project.route.size);
  if (routeSize) route.size = routeSize;
  if (Object.keys(route).length) out.route = route;

  // waypoints (no color, no shape — those live on Waypoint)
  const wp: NonNullable<MapOverrides['waypoints']> = {};
  if (next.waypoints.mode !== project.waypoints.mode) wp.mode = next.waypoints.mode;
  if (next.waypoints.label_mode !== project.waypoints.label_mode) {
    wp.label_mode = next.waypoints.label_mode;
  }
  if (next.waypoints.active_mode !== project.waypoints.active_mode) {
    wp.active_mode = next.waypoints.active_mode;
  }
  if (next.waypoints.active_color !== project.waypoints.active_color) {
    wp.active_color = next.waypoints.active_color;
  }
  if (
    next.waypoints.active_secondary_color !==
    project.waypoints.active_secondary_color
  ) {
    wp.active_secondary_color = next.waypoints.active_secondary_color;
  }
  const wpSize = diffPartial(next.waypoints.size, project.waypoints.size);
  if (wpSize) wp.size = wpSize;
  if (Object.keys(wp).length) out.waypoints = wp;

  // pov (fully overridable; color is a plain hex string)
  const pov: NonNullable<MapOverrides['pov']> = {};
  if (next.pov.color !== project.pov.color) pov.color = next.pov.color;
  if (next.pov.secondary_color !== project.pov.secondary_color) {
    pov.secondary_color = next.pov.secondary_color;
  }
  if (next.pov.pulse_style !== project.pov.pulse_style) {
    pov.pulse_style = next.pov.pulse_style;
  }
  if (next.pov.pulse_rate !== project.pov.pulse_rate) {
    pov.pulse_rate = next.pov.pulse_rate;
  }
  const povSize = diffPartial(next.pov.size, project.pov.size);
  if (povSize) pov.size = povSize;
  if (Object.keys(pov).length) out.pov = pov;

  return out;
}

function diffPartial<T extends object>(next: T, base: T): Partial<T> | null {
  const out: Partial<T> = {};
  let any = false;
  for (const k of Object.keys(next) as (keyof T)[]) {
    if (next[k] !== base[k]) {
      out[k] = next[k];
      any = true;
    }
  }
  return any ? out : null;
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
  OutputResolution,
} from './lib/layout';

import type { AspectRatio, ProjectLayouts, OutputResolution } from './lib/layout';

/** Channel selector for the export pipeline. Mirrors the Rust enum-by-string
 *  in `RenderExportRequest.channel` and the union already exported from
 *  `lib/exportRequest.ts`; redeclared here so the export-modal UI can depend
 *  on `types.ts` without pulling in the request builder. */
export type ExportChannel = 'composite' | 'map_only' | 'video_only';

/** Frame rates surfaced by the Export modal's secondary "configure export"
 *  panel. The wire-level `RenderExportRequest.fps` is a `number`; this
 *  narrower union is the set the UI exposes. */
export type ExportFps = 24 | 30 | 60;

/** A single configured export within a grid cell. The user can add multiple
 *  of these to one cell to render the same (aspect × channel) at several
 *  quality/fps/delivery-target combinations in one queue. `id` is a UUID
 *  minted at chip creation time so React keys, edit-target lookup, and
 *  queue-job ids stay collision-free even when two configs share
 *  `(quality, fps, delivery_target)` mid-edit.
 *
 *  `delivery_target` is the picker selection — color regime + codec +
 *  container. Optional so projects persisted without an explicit target
 *  round-trip cleanly; consumers resolve a missing value by mapping the
 *  cell's channel to its default: composite → `sdr_h265`,
 *  map_only/video_only → `prores` (the only target legal for those
 *  channels per the channel × target compatibility matrix). */
export interface ExportConfig {
  id: string;
  quality: OutputResolution;
  fps: ExportFps;
  delivery_target?: DeliveryTarget;
}

/** Default delivery target for a freshly-added chip in the given channel.
 *  Composite cells default to `sdr_h265` — modern efficiency (roughly
 *  half the file size of H.264 at equivalent quality), native playback on
 *  iPhone / modern Android / macOS / Chrome / Edge. Users uploading to
 *  social platforms hit this default and the platform's server-side
 *  transcode handles compat for viewers. map_only and video_only cells
 *  default to (and are locked to) `prores`, the only target legal for
 *  those channels (lossless compositing intermediates). */
export function defaultDeliveryTargetForChannel(channel: ExportChannel): DeliveryTarget {
  return channel === 'composite' ? 'sdr_h265' : 'prores';
}

/** Resolve a chip's delivery target — explicit value when set, channel
 *  default otherwise. Single source of truth so the picker, filename
 *  derivation, and wire builder agree on the fallback. */
export function resolveDeliveryTarget(
  config: ExportConfig,
  channel: ExportChannel,
): DeliveryTarget {
  return config.delivery_target ?? defaultDeliveryTargetForChannel(channel);
}

/** Grid cell key: `"{aspect}-{channel}"`. The flat-string form serializes
 *  cleanly through Rust serde as a HashMap key, works as a React key without
 *  joining at the call site, and avoids the nested-record gymnastics that a
 *  `Record<AspectRatio, Record<ExportChannel, ...>>` would force. */
export type CellKey = `${AspectRatio}-${ExportChannel}`;

/** User's pending (or last-confirmed) Export modal selection. The 3×3 grid
 *  (aspect × channel) is stored as a sparse map: only occupied cells appear
 *  in `cells`; each entry holds the chips the user has added. `output_dir`
 *  is snake_case to match the Rust serde wire format. Persisted per project
 *  as `Project.last_export_selection` (schema v6) so reopening the modal
 *  prefills the prior choice. */
export interface ExportGrid {
  cells: Partial<Record<CellKey, ExportConfig[]>>;
  output_dir: string | null;
}


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
  /** Per-aspect layout configuration (v4+). Always populated post-100:
   *  fresh projects ship with all three aspects seeded by
   *  `defaultPipLayout(aspect)`. Each entry stays nullable so the
   *  configurator (110) can express "the user has explicitly cleared this
   *  aspect" — the Rust `load_project` backfill respects post-100 nulls but
   *  re-seeds them for pre-100 bundles. */
  layouts: ProjectLayouts;
  /** Aspect that the export pipeline targets (task 100). Creative-content
   *  state — travels with the project bundle. The Rust side guarantees this
   *  field is populated on every load (serde default for pre-100 bundles
   *  fills `'9_16'`); the TS type is non-optional. */
  selected_export_aspect: AspectRatio;
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
  /** Last user-confirmed Export modal selection. `null` until the user
   *  completes their first successful export; set on `queueState === 'done'`
   *  with at least one done job. The Export modal prefills the grid + output
   *  folder from this on subsequent opens. Schema v6 replaced the flat
   *  `{aspects, channels}` shape with the 3×3 cell map; the v5→v6 migration
   *  drops any prior value rather than attempting a structural transform. */
  last_export_selection: ExportGrid | null;
  /** First-class waypoints (schema v7). One entry per visible map waypoint;
   *  clip-sourced entries are kept in sync with `clips` via the helpers in
   *  `src/lib/waypoints.ts`. Empty array (not `undefined`) for projects with
   *  no waypoints. Legacy bundles arrive with `[]` from Rust; the load path
   *  seeds from clips before first use. */
  waypoints: Waypoint[];
  /** Project-level working color space (schema v9). Omitted on disk when
   *  equal to the default (`'linear_bt2020_full'`); consumers treat
   *  absent/undefined as the default. See {@link WorkingColorSpaceId}. */
  working_color_space?: WorkingColorSpaceId;
}

export interface RecentProject {
  path: string;
  name: string;
  clip_count: number;
  last_opened: string;
  thumbnail: string | null;
  first_clip_date: string | null;
}
