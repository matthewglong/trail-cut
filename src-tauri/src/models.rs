use serde::{Deserialize, Serialize};

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
pub struct ExportLayout {
    pub video_pct: u8,
    pub map_position: String,
    pub map_visible: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportResolution {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportConfig {
    pub name: String,
    pub aspect_ratio: String,
    pub resolution: ExportResolution,
    pub layout: ExportLayout,
    pub codec: String,
    pub quality: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapSettings {
    #[serde(default = "default_full")]
    pub route_mode: String, // "none" | "visited" | "full"
    #[serde(default = "default_full")]
    pub waypoints_mode: String, // "none" | "visited" | "full"
    #[serde(default = "default_true")]
    pub follow_playhead: bool,
    #[serde(default = "default_map_style")]
    pub map_style: String, // "default" | "3d" | "satellite"
    #[serde(default = "default_map_zoom")]
    pub zoom: f64,
    #[serde(default = "default_bearing_mode")]
    pub bearing_mode: String, // "auto" | "fixed"
    #[serde(default = "default_bearing_degrees")]
    pub bearing_degrees: f64,
    #[serde(default = "default_bearing_stops")]
    pub bearing_stops: u32,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MapOverrides {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waypoints_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub follow_playhead: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub map_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zoom: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bearing_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bearing_degrees: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bearing_stops: Option<u32>,
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

/// Current persisted-project schema version. Bump when a field's *shape*
/// changes (not just additive). v3 adds the compiled-timeline authored
/// fields (`start_camera`, `default_entry_transition`, per-clip
/// `entry_transition`) — all optional, so the v2→v3 migration is purely
/// additive.
pub const CURRENT_SCHEMA_VERSION: u32 = 3;

fn default_schema_version() -> u32 {
    // Legacy files lack the field; treat them as v1 for migration purposes.
    1
}

impl Default for MapSettings {
    fn default() -> Self {
        MapSettings {
            route_mode: default_full(),
            waypoints_mode: default_full(),
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
    pub exports: Vec<ExportConfig>,
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
    /// Project-level default for the live preview camera's per-tick
    /// easing duration (ms). Frontend's `MapView` ease loop reads this
    /// to size both `easeTo`'s `duration` argument and its lookahead
    /// (so the camera's arrival point lines up with the playhead at
    /// easing completion). Absent on disk for projects pre-dating this
    /// field; the frontend falls back to a 50 ms baseline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_ease_duration_ms: Option<u64>,
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
            exports: Vec::new(),
            map_settings: None,
            transition_feel: None,
            start_camera: None,
            default_entry_transition: None,
            default_ease_duration_ms: None,
        }
    }
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
