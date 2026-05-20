use crate::export::layout::{default_split_layout, AspectRatio, ProjectLayouts};
use crate::export::resolution::OutputResolution;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpsCoord {
    pub lat: f64,
    pub lng: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipMetadata {
    pub id: String,
    pub path: String,
    pub filename: String,
    pub created_at: Option<String>,
    pub duration_ms: Option<u64>,
    pub gps: Option<GpsCoord>,
    pub resolution: Option<String>,
    pub frame_rate: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrimRange {
    pub in_ms: u64,
    pub out_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FocalPoint {
    pub x: f64,
    pub y: f64,
    #[serde(default = "default_zoom")]
    pub zoom: f64,
}

fn default_zoom() -> f64 {
    1.0
}

fn default_visible() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StabilizeSettings {
    pub enabled: bool,
    pub shakiness: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Effects {
    pub stabilize: StabilizeSettings,
    pub speed: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Clip {
    pub id: String,
    pub path: String,
    pub filename: String,
    pub created_at: Option<String>,
    pub duration_ms: Option<u64>,
    pub gps: Option<GpsCoord>,
    pub resolution: Option<String>,
    pub frame_rate: Option<f64>,
    pub trim: Option<TrimRange>,
    pub focal_point: FocalPoint,
    pub effects: Effects,
    #[serde(default = "default_visible")]
    pub visible: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_overrides: Option<MapOverrides>,
    /// Per-clip entry-transition authoring. Project-level
    /// `default_entry_transition` still applies for unset fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_transition: Option<ClipEntryTransition>,
}

impl From<ClipMetadata> for Clip {
    fn from(meta: ClipMetadata) -> Self {
        let trim = meta.duration_ms.map(|d| TrimRange { in_ms: 0, out_ms: d });
        Clip {
            id: meta.id,
            path: meta.path,
            filename: meta.filename,
            created_at: meta.created_at,
            duration_ms: meta.duration_ms,
            gps: meta.gps,
            resolution: meta.resolution,
            frame_rate: meta.frame_rate,
            trim,
            focal_point: FocalPoint { x: 0.5, y: 0.5, zoom: 1.0 },
            effects: Effects {
                stabilize: StabilizeSettings {
                    enabled: false,
                    shakiness: 5,
                },
                speed: 1.0,
            },
            visible: true,
            map_overrides: None,
            entry_transition: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackPoint {
    pub lat: f64,
    pub lng: f64,
    pub elevation: Option<f64>,
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Route {
    pub source_path: String,
    pub format: String,
    pub trackpoints: Vec<TrackPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GradientStop {
    pub fraction: f64,
    pub color: String,
}

/// Decoration color (`mode: "solid"` | `mode: "gradient"`). On disk:
/// `{ "mode": "solid", "solid": "#bced09" }` or
/// `{ "mode": "gradient", "stops": [{ "fraction": 0, "color": "#..." }, ...] }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum DecorationColor {
    Solid { solid: String },
    Gradient { stops: Vec<GradientStop> },
}

impl Default for DecorationColor {
    fn default() -> Self {
        DecorationColor::Solid { solid: default_accent_color() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraSettings {
    #[serde(default = "default_true")]
    pub follow_playhead: bool,
    #[serde(default = "default_map_style")]
    pub map_style: String,
    #[serde(default = "default_map_zoom")]
    pub zoom: f64,
    #[serde(default = "default_bearing_mode")]
    pub bearing_mode: String,
    #[serde(default = "default_bearing_degrees")]
    pub bearing_degrees: f64,
    #[serde(default = "default_bearing_stops")]
    pub bearing_stops: u32,
}

impl Default for CameraSettings {
    fn default() -> Self {
        CameraSettings {
            follow_playhead: true,
            map_style: default_map_style(),
            zoom: default_map_zoom(),
            bearing_mode: default_bearing_mode(),
            bearing_degrees: default_bearing_degrees(),
            bearing_stops: default_bearing_stops(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteSize {
    #[serde(default = "default_overlay_route_width", alias = "full_width")]
    pub width: f64,
}

impl Default for RouteSize {
    fn default() -> Self {
        RouteSize {
            width: default_overlay_route_width(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteSettings {
    #[serde(default = "default_full")]
    pub mode: String,
    #[serde(default)]
    pub color: DecorationColor,
    #[serde(default)]
    pub size: RouteSize,
    /// UI affordance — stash of the last gradient stop array, populated when
    /// the user toggles GRADIENT → SOLID in the panel so toggling back
    /// restores the prior gradient. Never read by the renderer; see
    /// `color-gradient.md` §13. Optional and additive — round-trips
    /// transparently when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_stops_cache: Option<Vec<GradientStop>>,
}

impl Default for RouteSettings {
    fn default() -> Self {
        RouteSettings {
            mode: default_full(),
            color: DecorationColor::default(),
            size: RouteSize::default(),
            color_stops_cache: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaypointsSize {
    #[serde(default = "default_overlay_waypoint_circle_radius")]
    pub circle_radius: f64,
    #[serde(default = "default_overlay_waypoint_active_radius")]
    pub active_radius: f64,
    #[serde(default = "default_overlay_waypoint_stroke_width")]
    pub stroke_width: f64,
    #[serde(default = "default_overlay_waypoint_label_size")]
    pub label_size: f64,
}

impl Default for WaypointsSize {
    fn default() -> Self {
        WaypointsSize {
            circle_radius: default_overlay_waypoint_circle_radius(),
            active_radius: default_overlay_waypoint_active_radius(),
            stroke_width: default_overlay_waypoint_stroke_width(),
            label_size: default_overlay_waypoint_label_size(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaypointsSettings {
    #[serde(default = "default_full")]
    pub mode: String,
    #[serde(default)]
    pub color: DecorationColor,
    #[serde(default = "default_waypoint_shape")]
    pub shape: String,
    #[serde(default)]
    pub size: WaypointsSize,
    #[serde(default = "default_label_mode")]
    pub label_mode: String,
    #[serde(default = "default_active_waypoint_mode")]
    pub active_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_color: Option<String>,
    /// UI affordance — stash of the last gradient stop array, populated when
    /// the user toggles GRADIENT → SOLID in the panel so toggling back
    /// restores the prior gradient. Never read by the renderer; see
    /// `color-gradient.md` §13. Optional and additive — round-trips
    /// transparently when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_stops_cache: Option<Vec<GradientStop>>,
}

impl Default for WaypointsSettings {
    fn default() -> Self {
        WaypointsSettings {
            mode: default_full(),
            color: DecorationColor::default(),
            shape: default_waypoint_shape(),
            size: WaypointsSize::default(),
            label_mode: default_label_mode(),
            active_mode: default_active_waypoint_mode(),
            active_color: None,
            color_stops_cache: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PovSize {
    #[serde(default = "default_overlay_live_marker_pulse_radius")]
    pub pulse_radius: f64,
    #[serde(default = "default_overlay_live_marker_dot_radius")]
    pub dot_radius: f64,
    #[serde(default = "default_overlay_live_marker_dot_stroke_width")]
    pub dot_stroke_width: f64,
    #[serde(default = "default_overlay_pulse_start_radius")]
    pub pulse_start_radius: f64,
    #[serde(default = "default_overlay_pulse_end_radius")]
    pub pulse_end_radius: f64,
}

impl Default for PovSize {
    fn default() -> Self {
        PovSize {
            pulse_radius: default_overlay_live_marker_pulse_radius(),
            dot_radius: default_overlay_live_marker_dot_radius(),
            dot_stroke_width: default_overlay_live_marker_dot_stroke_width(),
            pulse_start_radius: default_overlay_pulse_start_radius(),
            pulse_end_radius: default_overlay_pulse_end_radius(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PovSettings {
    #[serde(default = "default_accent_color")]
    pub color: String,
    #[serde(default)]
    pub size: PovSize,
    #[serde(default = "default_pulse_style")]
    pub pulse_style: String,
    #[serde(default = "default_pulse_rate")]
    pub pulse_rate: String,
}

impl Default for PovSettings {
    fn default() -> Self {
        PovSettings {
            color: default_accent_color(),
            size: PovSize::default(),
            pulse_style: default_pulse_style(),
            pulse_rate: default_pulse_rate(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapSettings {
    #[serde(default)]
    pub camera: CameraSettings,
    #[serde(default)]
    pub route: RouteSettings,
    #[serde(default)]
    pub waypoints: WaypointsSettings,
    #[serde(default)]
    pub pov: PovSettings,
}

fn default_full() -> String {
    "full".to_string()
}

fn default_true() -> bool {
    true
}

fn default_map_style() -> String {
    "default".to_string()
}

fn default_map_zoom() -> f64 {
    14.0
}

fn default_bearing_mode() -> String {
    "fixed".to_string()
}

fn default_bearing_degrees() -> f64 {
    0.0
}

fn default_bearing_stops() -> u32 {
    3
}

fn default_overlay_route_width() -> f64 {
    0.004
}
fn default_overlay_waypoint_circle_radius() -> f64 {
    0.015
}
fn default_overlay_waypoint_active_radius() -> f64 {
    0.019
}
fn default_overlay_waypoint_stroke_width() -> f64 {
    0.003
}
fn default_overlay_waypoint_label_size() -> f64 {
    0.014
}
fn default_overlay_live_marker_pulse_radius() -> f64 {
    0.012
}
fn default_overlay_live_marker_dot_radius() -> f64 {
    0.013
}
fn default_overlay_live_marker_dot_stroke_width() -> f64 {
    0.004
}
fn default_overlay_pulse_start_radius() -> f64 {
    0.012
}
fn default_overlay_pulse_end_radius() -> f64 {
    0.033
}
fn default_label_mode() -> String {
    "numbered".to_string()
}
fn default_active_waypoint_mode() -> String {
    "latest_passed".to_string()
}
fn default_waypoint_shape() -> String {
    "circle".to_string()
}
fn default_accent_color() -> String {
    "#bced09".to_string()
}
fn default_pulse_style() -> String {
    "sonar".to_string()
}
fn default_pulse_rate() -> String {
    "medium".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CameraOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follow_playhead: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zoom: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bearing_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bearing_degrees: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bearing_stops: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RouteSizeOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "full_width")]
    pub width: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RouteOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<RouteSizeOverrides>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WaypointsSizeOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub circle_radius: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_radius: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_size: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WaypointsOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<WaypointsSizeOverrides>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PovSizeOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pulse_radius: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dot_radius: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dot_stroke_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pulse_start_radius: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pulse_end_radius: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PovOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<PovSizeOverrides>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pulse_style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pulse_rate: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MapOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera: Option<CameraOverrides>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<RouteOverrides>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waypoints: Option<WaypointsOverrides>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pov: Option<PovOverrides>,
}

/// Position anchor for a waypoint. Two variants:
///
/// - `WallClockMs`: anchored to a wall-clock timestamp on the GPX timeline.
///   Resolved at render time via `locationAt(ms, route, fallback_gps)` —
///   the fallback covers projects without a GPX route or with the
///   waypoint's timestamp outside the route's covered range.
/// - `Fixed`: pinned to a literal lat/lng. Doesn't move with the route
///   timeline and doesn't participate in "visited" filtering or
///   "latest passed" active highlighting.
///
/// On-disk shape uses the serde tag = "kind" convention with snake_case
/// variants so the JSON reads as
/// `{ "kind": "wall_clock_ms", "ms": …, "fallback_gps": {…} }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WaypointPosition {
    WallClockMs {
        ms: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fallback_gps: Option<GpsCoord>,
    },
    Fixed {
        lat: f64,
        lng: f64,
    },
}

/// First-class waypoint. Decoupled from clips: every clip-sourced waypoint
/// is seeded once on import / project-load and then survives independent of
/// the clip's later lifecycle. Deletion is sticky (manual edits aren't
/// undone by trims or re-imports). See `src/lib/waypoints.ts` for the
/// frontend sync rules.
///
/// `source` records provenance ("clip" | "gpx" | "manual"); the renderer
/// doesn't care which one set the position. `clip_id` is populated for
/// `source == "clip"` waypoints so the sync helper can find and re-anchor
/// (or drop) them when the underlying clip is trimmed or removed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Waypoint {
    pub id: String,
    pub position: WaypointPosition,
    #[serde(default)]
    pub label: String,
    pub source: String, // "clip" | "gpx" | "manual"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_id: Option<String>,
    /// Per-waypoint solid color override. None falls through to the project
    /// default at render time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Per-waypoint shape override. None falls through to the project default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<String>,
}

/// Project-level "transition feel" knob. Drives the duration multiplier for
/// cross-anchor Van Wijk arcs in the live preview and the export render.
/// Persisted as the lowercase string variant so the on-disk JSON matches the
/// frontend's literal union.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransitionFeel {
    Natural,
    Snappy,
    Slow,
}

/// Authored override of the project's start camera (the camera held at
/// project-time `t < 0` and used as the "from" endpoint of clip 1's entry
/// transition arc). Persisted only when the user overrides the computed
/// default — see `docs/migration/COMPILED_TIMELINE_PLAN.md` §"Project Start
/// Camera". The compiler synthesizes a default when this field is `None`.
///
/// Field names are snake_case on disk (Rust serde default) to match the
/// rest of project.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectStartCamera {
    pub center: GpsCoord,
    pub zoom: f64,
    pub bearing: f64,
    pub pitch: f64,
}

/// Per-clip (and project-default) authoring of an entry transition. All
/// fields are clip-local; nothing here lives on project-time. The compiler
/// (task 520) consumes these together with media duration and clip ordering
/// to produce a TransitionSpan on the project-time axis. See
/// `docs/migration/COMPILED_TIMELINE_PLAN.md` §"Data Model → Authored Data".
///
/// `entry_bias` is expected in `[-1, 1]`. No runtime clamping here; the
/// compiler clamps when materializing the TransitionSpan boundary.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ClipEntryTransition {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_bias: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feel: Option<TransitionFeel>,
}

/// Export-pipeline channel selector. Mirrors the TypeScript `ExportChannel`
/// union in `src/types.ts`. Used for `Project.last_export_selection` (task
/// 280) — the persistence path. The ad-hoc `RenderExportRequest.channel`
/// string field stays as-is; this typed enum lives only on the project file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExportChannel {
    Composite,
    MapOnly,
    VideoOnly,
}

/// One configured chip within a grid cell. The Export modal's secondary
/// "Configure export" panel writes these — each holds an output resolution
/// and frame rate. `id` is a UUID minted at chip creation time so multiple
/// chips can coexist in the same cell without React-key collisions, even
/// mid-edit when `(quality, fps)` values transiently overlap. Mirrors the
/// TypeScript `ExportConfig` in `src/types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExportConfig {
    pub id: String,
    pub quality: OutputResolution,
    /// 24 | 30 | 60 — narrower than the wire-level `RenderExportRequest.fps`
    /// but stored as plain `u32` here for serde simplicity. The TS layer
    /// constrains the literal at the type level.
    pub fps: u32,
}

/// User's last-confirmed Export modal selection — the 3×3 cell grid plus
/// the chosen output folder. Schema v6 replaced the prior flat
/// `{ aspects, channels }` shape with this map; the v5→v6 migration drops
/// any prior value rather than attempting a structural transform (the old
/// shape conveys "all selected" intent that doesn't deterministically map
/// to per-cell chip configs).
///
/// Cell keys are flat `"{aspect}-{channel}"` strings to round-trip cleanly
/// as JSON object keys. The TS side stores them in
/// `Partial<Record<CellKey, ExportConfig[]>>`; the on-wire shape is
/// `HashMap<String, Vec<ExportConfig>>`.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct ExportGrid {
    #[serde(default)]
    pub cells: HashMap<String, Vec<ExportConfig>>,
    pub output_dir: Option<PathBuf>,
}

/// Current persisted-project schema version. Bump when a field's *shape*
/// changes (not just additive). v3 adds the compiled-timeline authored
/// fields (`start_camera`, `default_entry_transition`, per-clip
/// `entry_transition`) — all optional, so the v2→v3 migration is purely
/// additive. v4 drops the placeholder `exports` array (no UI ever wrote it)
/// and adds the per-aspect `layouts` field per
/// `docs/export/LAYOUT.md` and task 050. v5 added `last_export_selection`
/// (per-project memory of the last successful Export modal selection) as
/// the flat `{ aspects, channels, output_dir }` shape. v6 replaces that
/// shape with the per-cell `ExportGrid` to support the configure-grid
/// redesign — the migration drops the v5 value rather than transforming it
/// (the flat shape's intent doesn't map cleanly to per-cell chip configs).
/// v7 promotes waypoints to a first-class project entity (was: derived from
/// clip starts at render time). Purely additive: the v6→v7 migration stamps
/// the version, and load_project seeds `waypoints` from clips when absent.
pub const CURRENT_SCHEMA_VERSION: u32 = 8;

fn default_schema_version() -> u32 {
    // Legacy files lack the field; treat them as v1 for migration purposes.
    1
}

impl Default for MapSettings {
    fn default() -> Self {
        MapSettings {
            camera: CameraSettings::default(),
            route: RouteSettings::default(),
            waypoints: WaypointsSettings::default(),
            pov: PovSettings::default(),
        }
    }
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    /// Persisted-schema version. See `CURRENT_SCHEMA_VERSION` and the v1→v2
    /// migration in `commands/project.rs::load_project`. Defaults to 1 on
    /// deserialize so legacy bundles read as v1 and get migrated.
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub version: u32,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub thumbnail: Option<String>,
    pub clips: Vec<Clip>,
    /// In-memory only as of v2. The canonical source is the `route.gpx`
    /// file in the bundle, re-parsed by `load_project` on every load.
    /// `save_project` clears this to `None` before writing so the
    /// `skip_serializing_if` below drops the key from on-disk JSON. The
    /// field still rides Tauri's IPC serialization to the frontend, which
    /// distinguishes `null` from `undefined` at the call site.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<Route>,
    /// Per-aspect layout configuration (v4+). Always populated post-100 —
    /// fresh projects ship with all three aspects seeded; the load path
    /// backfills pre-080 bundles where the field was absent or null. Each
    /// aspect entry stays `Option` so a user can explicitly clear an aspect
    /// via the configurator (110) — that null is preserved on subsequent
    /// loads. See `docs/export/LAYOUT.md` §4.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layouts: Option<ProjectLayouts>,
    /// Aspect that the export pipeline targets (v4 + 100). Creative-content
    /// state — travels with the project bundle so opening a `.trailcut`
    /// preserves "this video is for Reels (9:16)" vs "for IG feed (4:5)". The
    /// serde default handles pre-100 bundles (field absent → 9:16); a future
    /// aspect-picker UI mutates this; the export handlers in `ProjectView`
    /// read it.
    #[serde(default = "default_selected_aspect")]
    pub selected_export_aspect: AspectRatio,
    #[serde(default)]
    pub map_settings: Option<MapSettings>,
    /// `None` on disk for v1 projects pre-dating the camera migration. The
    /// frontend resolves `None` to `'natural'` at the call site rather than
    /// defaulting here, so save round-trips are observable (an unset field
    /// stays unset on disk).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_feel: Option<TransitionFeel>,
    /// Optional override of the computed project start camera. Compiler
    /// synthesizes a default (centroid of clip starts, zoom 12, bearing 0,
    /// pitch 0/60-by-style) when this field is `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_camera: Option<ProjectStartCamera>,
    /// Project-level defaults for every clip's entry transition. Each
    /// clip's own `entry_transition` overrides individual fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_entry_transition: Option<ClipEntryTransition>,
    /// Last user-confirmed Export modal selection (schema v6: the 3×3 cell
    /// grid replaces the prior `{ aspects, channels }` shape). `None` until
    /// the user completes their first export; the modal prefills from this
    /// on subsequent opens. The v5→v6 migration drops any prior flat value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_export_selection: Option<ExportGrid>,
    /// First-class waypoints (schema v7). Each waypoint carries a position,
    /// label, source provenance, and an optional `clip_id` linking it back to
    /// the clip whose creation seeded it. Default is `[]`. Legacy bundles
    /// (pre-v7) lack the field; `load_project` seeds it from `clips` so the
    /// first save round-trips the populated list. See `src/lib/waypoints.ts`
    /// for the sync rules on the frontend side.
    #[serde(default)]
    pub waypoints: Vec<Waypoint>,
}

impl Default for Project {
    fn default() -> Self {
        Project {
            schema_version: CURRENT_SCHEMA_VERSION,
            version: 1,
            name: String::new(),
            thumbnail: None,
            clips: Vec::new(),
            route: None,
            // Seed all three aspects (task 100). 080's "9:16 only on creation"
            // rule retired now that the export matrix is paved end-to-end and
            // the configurator (110) lets users mutate any aspect — the
            // starter is no longer "aesthetic imposition" but "the value the
            // configurator opens with."
            layouts: Some(seeded_layouts()),
            selected_export_aspect: default_selected_aspect(),
            map_settings: None,
            transition_feel: None,
            start_camera: None,
            default_entry_transition: None,
            last_export_selection: None,
            waypoints: Vec::new(),
        }
    }
}

/// First-contact `ProjectLayouts` shape: all three aspects seeded with
/// `default_split_layout`. Used by `Project::default` (new projects) and
/// `load_project`'s backfill paths.
pub fn seeded_layouts() -> ProjectLayouts {
    ProjectLayouts {
        aspect_9_16: Some(default_split_layout(AspectRatio::NineSixteen)),
        aspect_4_5: Some(default_split_layout(AspectRatio::FourFive)),
        aspect_16_9: Some(default_split_layout(AspectRatio::SixteenNine)),
    }
}

/// Default for `selected_export_aspect` (task 100). Pre-100 projects lack
/// the field; serde supplies this on deserialize. New projects also pick
/// `9_16` via `Project::default`.
pub fn default_selected_aspect() -> AspectRatio {
    AspectRatio::NineSixteen
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub clip_count: u32,
    pub last_opened: String,
    #[serde(default)]
    pub thumbnail: Option<String>,
    #[serde(default)]
    pub first_clip_date: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_channel_serializes_as_snake_case() {
        // The TS `ExportChannel` union is `'composite' | 'map_only' |
        // 'video_only'`. The Rust enum's snake_case rename must match so
        // round-tripping `last_export_selection` between TS and Rust is
        // wire-stable.
        let composite = serde_json::to_string(&ExportChannel::Composite).unwrap();
        let map_only = serde_json::to_string(&ExportChannel::MapOnly).unwrap();
        let video_only = serde_json::to_string(&ExportChannel::VideoOnly).unwrap();
        assert_eq!(composite, "\"composite\"");
        assert_eq!(map_only, "\"map_only\"");
        assert_eq!(video_only, "\"video_only\"");
    }

    #[test]
    fn export_grid_round_trips_through_serde() {
        let mut cells = HashMap::new();
        cells.insert(
            "9_16-composite".to_string(),
            vec![
                ExportConfig {
                    id: "cfg-a".to_string(),
                    quality: OutputResolution::P1080,
                    fps: 30,
                },
                ExportConfig {
                    id: "cfg-b".to_string(),
                    quality: OutputResolution::P2160,
                    fps: 60,
                },
            ],
        );
        cells.insert(
            "4_5-map_only".to_string(),
            vec![ExportConfig {
                id: "cfg-c".to_string(),
                quality: OutputResolution::P1080,
                fps: 30,
            }],
        );
        let grid = ExportGrid {
            cells,
            output_dir: Some(PathBuf::from("/Users/u/Movies/Hike2026")),
        };
        let json = serde_json::to_string(&grid).unwrap();
        let parsed: ExportGrid = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.output_dir, grid.output_dir);
        assert_eq!(parsed.cells.len(), 2);
        assert_eq!(
            parsed.cells.get("9_16-composite").map(|v| v.len()),
            Some(2),
        );
        assert_eq!(
            parsed.cells.get("4_5-map_only").map(|v| v.len()),
            Some(1),
        );
    }

    #[test]
    fn export_grid_round_trips_with_null_output_dir() {
        // The persistence layer treats `None` output_dir as legal even
        // though the modal blocks Render until a folder is chosen.
        let grid = ExportGrid {
            cells: HashMap::new(),
            output_dir: None,
        };
        let json = serde_json::to_string(&grid).unwrap();
        let parsed: ExportGrid = serde_json::from_str(&json).unwrap();
        assert!(parsed.output_dir.is_none());
        assert!(parsed.cells.is_empty());
    }

    #[test]
    fn project_loads_without_last_export_selection_field() {
        // Backward-compat for v4 (and earlier-migrated) bundles: the field
        // didn't exist before v5. `#[serde(default)]` must supply `None` on
        // deserialize without erroring. The v5→v6 migration in
        // `commands/project.rs` handles the case where a v5 file *does*
        // carry an incompatible value.
        let raw = r#"{
            "schema_version": 4,
            "version": 1,
            "name": "Pre-grid Project",
            "thumbnail": null,
            "clips": [],
            "map_settings": null
        }"#;
        let parsed: Project = serde_json::from_str(raw).expect("must deserialize");
        assert!(parsed.last_export_selection.is_none());
    }

    #[test]
    fn route_settings_color_stops_cache_round_trips_through_serde() {
        // Schema v8 + Step 7 added an optional `color_stops_cache` to
        // RouteSettings as a UI affordance — populated on the gradient →
        // solid toggle so a later solid → gradient toggle restores the
        // user's prior stops. Serde-optional with skip-when-none, so it
        // round-trips transparently for projects that never used it.
        let route = RouteSettings {
            mode: "full".to_string(),
            color: DecorationColor::Solid {
                solid: "#bced09".to_string(),
            },
            size: RouteSize::default(),
            color_stops_cache: Some(vec![
                GradientStop {
                    fraction: 0.0,
                    color: "#ff715b".to_string(),
                },
                GradientStop {
                    fraction: 1.0,
                    color: "#2f52e0".to_string(),
                },
            ]),
        };
        let json = serde_json::to_string(&route).unwrap();
        assert!(json.contains("color_stops_cache"));
        let parsed: RouteSettings = serde_json::from_str(&json).unwrap();
        let cache = parsed.color_stops_cache.expect("cache must survive");
        assert_eq!(cache.len(), 2);
        assert_eq!(cache[0].color, "#ff715b");
        assert_eq!(cache[1].fraction, 1.0);
    }

    #[test]
    fn route_settings_color_stops_cache_absent_when_none() {
        // skip_serializing_if = "Option::is_none" — JSON should NOT carry
        // the field when the cache is None. Existing v8 projects without
        // the cache stay byte-identical after the Step 7 type addition.
        let route = RouteSettings::default();
        let json = serde_json::to_string(&route).unwrap();
        assert!(
            !json.contains("color_stops_cache"),
            "JSON must omit color_stops_cache when None — got {json}"
        );
    }

    #[test]
    fn waypoints_settings_color_stops_cache_round_trips_through_serde() {
        let wp = WaypointsSettings {
            mode: "full".to_string(),
            color: DecorationColor::Solid {
                solid: "#bced09".to_string(),
            },
            shape: "circle".to_string(),
            size: WaypointsSize::default(),
            label_mode: "numbered".to_string(),
            active_mode: "latest_passed".to_string(),
            active_color: None,
            color_stops_cache: Some(vec![
                GradientStop {
                    fraction: 0.0,
                    color: "#000000".to_string(),
                },
                GradientStop {
                    fraction: 1.0,
                    color: "#ffffff".to_string(),
                },
            ]),
        };
        let json = serde_json::to_string(&wp).unwrap();
        let parsed: WaypointsSettings = serde_json::from_str(&json).unwrap();
        let cache = parsed.color_stops_cache.expect("cache must survive");
        assert_eq!(cache.len(), 2);
        assert_eq!(cache[1].color, "#ffffff");
    }

    #[test]
    fn route_settings_deserializes_pre_step7_json_without_color_stops_cache() {
        // Old project.json bundles (any v8 file written before Step 7) lack
        // `color_stops_cache`. Deserialization must succeed with None.
        let raw = r##"{
            "mode": "full",
            "color": { "mode": "solid", "solid": "#bced09" },
            "size": { "full_width": 0.004, "trail_width": 0.0055 }
        }"##;
        let parsed: RouteSettings = serde_json::from_str(raw).expect("must deserialize");
        assert_eq!(parsed.size.width, 0.004);
        assert!(parsed.color_stops_cache.is_none());
    }

    #[test]
    fn project_round_trips_with_last_export_selection() {
        // Full save/load round-trip: write a Project with a populated
        // `last_export_selection` (grid shape), parse back, confirm every
        // field survives. The modal relies on this on prefill.
        let mut cells = HashMap::new();
        cells.insert(
            "9_16-composite".to_string(),
            vec![ExportConfig {
                id: "cfg-1".to_string(),
                quality: OutputResolution::P1080,
                fps: 30,
            }],
        );
        let project = Project {
            last_export_selection: Some(ExportGrid {
                cells,
                output_dir: Some(PathBuf::from("/tmp/exports")),
            }),
            ..Project::default()
        };
        let json = serde_json::to_string(&project).unwrap();
        let parsed: Project = serde_json::from_str(&json).unwrap();
        let sel = parsed
            .last_export_selection
            .expect("last_export_selection must round-trip");
        assert_eq!(sel.output_dir, Some(PathBuf::from("/tmp/exports")));
        assert_eq!(sel.cells.get("9_16-composite").map(|v| v.len()), Some(1));
    }
}
