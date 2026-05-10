use crate::export::layout::{default_pip_layout, AspectRatio, ProjectLayouts};
use serde::{Deserialize, Serialize};
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

/// Last user-confirmed Export modal selection (task 280). Persisted per
/// project so reopening the modal prefills aspects + channels + output folder
/// instead of forcing the user to reselect each time. Written only on a
/// successful queue completion (at least one `done` job); cancel-with-zero-
/// successes does not clobber the previous value.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportSelection {
    pub aspects: Vec<AspectRatio>,
    pub channels: Vec<ExportChannel>,
    pub output_dir: Option<PathBuf>,
}

/// Current persisted-project schema version. Bump when a field's *shape*
/// changes (not just additive). v3 adds the compiled-timeline authored
/// fields (`start_camera`, `default_entry_transition`, per-clip
/// `entry_transition`) — all optional, so the v2→v3 migration is purely
/// additive. v4 drops the placeholder `exports` array (no UI ever wrote it)
/// and adds the per-aspect `layouts` field per
/// `docs/export/LAYOUT.md` and task 050. v5 is purely additive: it adds
/// `last_export_selection` (per-project memory of the last successful Export
/// modal selection — aspects, channels, output folder) per task 280. The
/// field is `Option` with `#[serde(default)]`, so older bundles load cleanly
/// without a value-level migration step.
pub const CURRENT_SCHEMA_VERSION: u32 = 5;

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
    /// Last user-confirmed Export modal selection (task 280, schema v5).
    /// `None` until the user completes their first export; the modal
    /// prefills from this on subsequent opens. Pre-v5 bundles lack the
    /// field — `#[serde(default)]` supplies `None`, no migration step
    /// required.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_export_selection: Option<ExportSelection>,
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
        }
    }
}

/// First-contact `ProjectLayouts` shape (task 100): all three aspects seeded
/// with `default_pip_layout`. Used by `Project::default` (new projects) and
/// `load_project`'s backfill paths.
pub fn seeded_layouts() -> ProjectLayouts {
    ProjectLayouts {
        aspect_9_16: Some(default_pip_layout(AspectRatio::NineSixteen)),
        aspect_4_5: Some(default_pip_layout(AspectRatio::FourFive)),
        aspect_16_9: Some(default_pip_layout(AspectRatio::SixteenNine)),
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
    fn export_selection_round_trips_through_serde() {
        let selection = ExportSelection {
            aspects: vec![AspectRatio::NineSixteen, AspectRatio::FourFive],
            channels: vec![ExportChannel::Composite, ExportChannel::MapOnly],
            output_dir: Some(PathBuf::from("/Users/u/Movies/Hike2026")),
        };
        let json = serde_json::to_string(&selection).unwrap();
        let parsed: ExportSelection = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.aspects, selection.aspects);
        assert_eq!(parsed.channels, selection.channels);
        assert_eq!(parsed.output_dir, selection.output_dir);
    }

    #[test]
    fn export_selection_round_trips_with_null_output_dir() {
        // The user can confirm an export without a folder having been picked
        // in some future flow — and the persisted record must preserve that.
        // (In practice the modal blocks Render until a folder is chosen, but
        // the persistence layer treats `None` as legal.)
        let selection = ExportSelection {
            aspects: vec![AspectRatio::SixteenNine],
            channels: vec![ExportChannel::VideoOnly],
            output_dir: None,
        };
        let json = serde_json::to_string(&selection).unwrap();
        let parsed: ExportSelection = serde_json::from_str(&json).unwrap();
        assert!(parsed.output_dir.is_none());
        assert_eq!(parsed.channels, vec![ExportChannel::VideoOnly]);
    }

    #[test]
    fn project_loads_without_last_export_selection_field() {
        // Backward-compat for v4 (and earlier-migrated) bundles: the field
        // didn't exist before task 280. `#[serde(default)]` must supply
        // `None` on deserialize without erroring — no migration code path is
        // needed for this additive bump.
        let raw = r#"{
            "schema_version": 4,
            "version": 1,
            "name": "Pre-280 Project",
            "thumbnail": null,
            "clips": [],
            "map_settings": null
        }"#;
        let parsed: Project = serde_json::from_str(raw).expect("must deserialize");
        assert!(parsed.last_export_selection.is_none());
    }

    #[test]
    fn project_round_trips_with_last_export_selection() {
        // Full save/load round-trip exercise: write a Project with a
        // populated `last_export_selection`, parse it back, confirm every
        // field survives. This is the contract the Export modal relies on
        // when prefilling on open.
        let project = Project {
            last_export_selection: Some(ExportSelection {
                aspects: vec![AspectRatio::NineSixteen, AspectRatio::SixteenNine],
                channels: vec![ExportChannel::Composite, ExportChannel::VideoOnly],
                output_dir: Some(PathBuf::from("/tmp/exports")),
            }),
            ..Project::default()
        };
        let json = serde_json::to_string(&project).unwrap();
        let parsed: Project = serde_json::from_str(&json).unwrap();
        let sel = parsed
            .last_export_selection
            .expect("last_export_selection must round-trip");
        assert_eq!(
            sel.aspects,
            vec![AspectRatio::NineSixteen, AspectRatio::SixteenNine]
        );
        assert_eq!(
            sel.channels,
            vec![ExportChannel::Composite, ExportChannel::VideoOnly]
        );
        assert_eq!(sel.output_dir, Some(PathBuf::from("/tmp/exports")));
    }
}
