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
}

impl Default for MapSettings {
    fn default() -> Self {
        MapSettings {
            route_mode: default_full(),
            waypoints_mode: default_full(),
            follow_playhead: true,
            map_style: default_map_style(),
            zoom: default_map_zoom(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub version: u32,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub thumbnail: Option<String>,
    pub clips: Vec<Clip>,
    pub route: Option<Route>,
    pub exports: Vec<ExportConfig>,
    #[serde(default)]
    pub map_settings: Option<MapSettings>,
}

impl Default for Project {
    fn default() -> Self {
        Project {
            version: 1,
            name: String::new(),
            thumbnail: None,
            clips: Vec::new(),
            route: None,
            exports: Vec::new(),
            map_settings: None,
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
