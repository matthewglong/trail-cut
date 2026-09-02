use crate::export::delivery::DeliveryTarget;
use crate::export::layout::{default_split_layout, AspectRatio, ProjectLayouts};
use crate::export::resolution::OutputResolution;
use crate::util::color::{source_color_space_for, SourceColorClass};
use crate::util::color_space::ColorSpace;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpsCoord {
    pub lat: f64,
    pub lng: f64,
}

/// Per-clip color-space override (schema v9). Each axis is an optional zscale
/// token; when present it patches that single axis of the clip's auto-detected
/// source [`ColorSpace`] (see `Clip::effective_color_space`). This is the
/// "automatic from metadata, but overridable" surface: detection populates the
/// base, the user corrects individual axes for mistagged clips without
/// disturbing the others. The `inferred_*` flags record which axes detection
/// GUESSED (the file tag was absent) so the UI can badge them for review.
///
/// Unrecognized tokens are ignored at apply time (the base axis is kept) — no
/// unvalidated string ever reaches FFmpeg (see `ColorSpace::with_overrides`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PerAxisOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primaries: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transfer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matrix: Option<String>,
    #[serde(default)]
    pub inferred_primaries: bool,
    #[serde(default)]
    pub inferred_transfer: bool,
    #[serde(default)]
    pub inferred_range: bool,
    #[serde(default)]
    pub inferred_matrix: bool,
}

impl PerAxisOverride {
    /// `true` iff at least one color axis is actually overridden. A `Some`
    /// override with every axis `None` (e.g. a UI that set then cleared all
    /// axes, or a hand-edited `"color_space_override": {}`) is treated as "no
    /// override" so the export ingest keeps the class-based path (and its
    /// log-LUT development) instead of silently reinterpreting the clip.
    pub fn has_any_axis(&self) -> bool {
        self.primaries.is_some()
            || self.transfer.is_some()
            || self.range.is_some()
            || self.matrix.is_some()
    }
}

/// Project-level working-color-space discriminant (schema v9). The pipeline
/// composites in this space; today the only value is `LinearBt2020Full`
/// (linear-light BT.2020 full-range GBR float — byte-identical to the
/// pre-v9 hardcoded working space). A future wider working space (e.g. an
/// ACEScg AP1 tier for cinema-log projects) is one more enum arm here plus its
/// `to_color_space` mapping, and nothing else changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkingColorSpaceId {
    LinearBt2020Full,
}

impl Default for WorkingColorSpaceId {
    fn default() -> Self {
        WorkingColorSpaceId::LinearBt2020Full
    }
}

impl WorkingColorSpaceId {
    /// Resolve to the concrete [`ColorSpace`] the export pipeline composites in.
    pub fn to_color_space(self) -> ColorSpace {
        match self {
            WorkingColorSpaceId::LinearBt2020Full => ColorSpace::WORKING,
        }
    }
}

fn default_working_color_space() -> WorkingColorSpaceId {
    WorkingColorSpaceId::LinearBt2020Full
}

fn is_default_working_color_space(id: &WorkingColorSpaceId) -> bool {
    *id == WorkingColorSpaceId::LinearBt2020Full
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
    // ---- Color metadata (WS0 — color pipeline foundation) ----
    //
    // Populated at import time by `commands::media::import_media` /
    // `scan_directory` from the ffprobe call in
    // `crate::export::ffprobe::probe_clip`. Each field round-trips through
    // serde as-is. `source_color_class` is derived from the raw fields via
    // `crate::util::color::classify` so the import path commits one decision
    // and downstream consumers (proxy/thumbnail/export — WS1/WS2/WS3) branch
    // on the enum rather than re-running the classifier.
    //
    // All fields are `#[serde(default)]` so legacy import results (and tests
    // that hand-build `ClipMetadata` for non-color cases) keep deserialising.
    #[serde(default)]
    pub pix_fmt: Option<String>,
    #[serde(default)]
    pub color_primaries: Option<String>,
    #[serde(default)]
    pub color_trc: Option<String>,
    #[serde(default)]
    pub color_space: Option<String>,
    #[serde(default)]
    pub color_range: Option<String>,
    #[serde(default)]
    pub has_dolby_vision: bool,
    #[serde(default)]
    pub camera_make: Option<String>,
    #[serde(default)]
    pub camera_model: Option<String>,
    /// Auto-detected color regime, run through `util::color::classify` at
    /// import time. Defaults to `Unknown` for legacy bundles via
    /// `default_unknown_color_class` so `effective_color_class()` always has
    /// a value to fall back to.
    #[serde(default = "default_unknown_color_class")]
    pub source_color_class: SourceColorClass,
    /// User-set override of the auto-detected class. Phase 1 always leaves
    /// this `None`; Phase 2's source-format UI populates it for log formats
    /// (which can't be auto-detected — see ARCHITECTURE.md §"Phase 2
    /// additions"). `effective_color_class()` reads override first, falls
    /// back to `source_color_class`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_color_class_override: Option<SourceColorClass>,
    /// WS8 — suggested log encoding for this clip, derived from the camera
    /// make/model + 10-bit pix_fmt knowledge base in
    /// `crate::util::log_detection`. UI-only hint: WS9 surfaces this as a
    /// "Looks like D-Log — apply?" affordance. **Never auto-applied**;
    /// `effective_color_class()` ignores this field entirely and reads
    /// override > source_color_class only. None for the vast majority of
    /// clips (iPhone, GoPro 8-bit, unrecognised cameras, all HDR-tagged
    /// footage). Populated at import time by `populate_color_metadata`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_log_class: Option<SourceColorClass>,
    /// Per-axis color-space override (schema v9). See [`PerAxisOverride`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_space_override: Option<PerAxisOverride>,
}

/// Serde default for `source_color_class` — used by legacy bundles that
/// pre-date WS0 and any code path that hand-builds `ClipMetadata` /
/// `Clip` without populating the field. Treated as SDR by downstream
/// consumers (see `SourceColorClass::Unknown`'s docs).
fn default_unknown_color_class() -> SourceColorClass {
    SourceColorClass::Unknown
}

impl ClipMetadata {
    /// Resolved color class — user override wins, falls back to the
    /// auto-detected value. Every downstream ingest formula (proxy /
    /// thumbnail / export) MUST branch on this method's result, NOT on
    /// `source_color_class` directly, so a Phase 2 user override takes
    /// effect uniformly.
    pub fn effective_color_class(&self) -> SourceColorClass {
        self.user_color_class_override.unwrap_or(self.source_color_class)
    }
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
    // ---- Color metadata (WS0 — color pipeline foundation) ----
    //
    // Mirrors the fields on `ClipMetadata`. Stored on `Clip` (not just
    // `ClipMetadata`) because `Clip` is what persists in `project.json` —
    // `ClipMetadata` is the import-time DTO, then `Clip::from(meta)` lifts
    // it into the project. Every field is `#[serde(default)]` so legacy
    // pre-WS0 project bundles deserialize cleanly (no schema bump needed —
    // the fields are purely additive on disk).
    #[serde(default)]
    pub pix_fmt: Option<String>,
    #[serde(default)]
    pub color_primaries: Option<String>,
    #[serde(default)]
    pub color_trc: Option<String>,
    #[serde(default)]
    pub color_space: Option<String>,
    #[serde(default)]
    pub color_range: Option<String>,
    #[serde(default)]
    pub has_dolby_vision: bool,
    #[serde(default)]
    pub camera_make: Option<String>,
    #[serde(default)]
    pub camera_model: Option<String>,
    #[serde(default = "default_unknown_color_class")]
    pub source_color_class: SourceColorClass,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_color_class_override: Option<SourceColorClass>,
    /// WS8 — mirror of `ClipMetadata::suggested_log_class`. Persisted on the
    /// Clip so the suggestion travels with the project across save/load and
    /// WS9's UI can re-surface it after a re-open (the import-time camera
    /// metadata isn't re-probed on load — the suggestion has to ride along
    /// in `project.json`). UI-only; never consulted by the ingest pipeline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_log_class: Option<SourceColorClass>,
    /// Per-axis color-space override (schema v9). See [`PerAxisOverride`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_space_override: Option<PerAxisOverride>,
}

impl Clip {
    /// Resolved color class — user override wins, falls back to the
    /// auto-detected value. Mirrors `ClipMetadata::effective_color_class`.
    /// Every downstream ingest formula (WS1 proxy, WS2 thumbnail, WS3
    /// export) MUST consult this method, not `source_color_class` directly.
    pub fn effective_color_class(&self) -> SourceColorClass {
        self.user_color_class_override.unwrap_or(self.source_color_class)
    }

    /// Resolved source [`ColorSpace`] the export pipeline ingests this clip
    /// from. Starts from the auto-detected class (+ the legacy-transfer hint),
    /// then applies any per-axis [`PerAxisOverride`]. This is the load-bearing
    /// "automatic, but overridable" resolution the clip ingest consumes — the
    /// coarse `effective_color_class()` remains for the UI / log-LUT routing.
    pub fn effective_color_space(&self) -> ColorSpace {
        let base = source_color_space_for(self.effective_color_class(), self.color_trc.as_deref());
        match &self.color_space_override {
            Some(ov) => base.with_overrides(
                ov.primaries.as_deref(),
                ov.transfer.as_deref(),
                ov.range.as_deref(),
                ov.matrix.as_deref(),
            ),
            None => base,
        }
    }
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
            // WS0 — carry the import-time color signals onto the persisted
            // clip. Without this propagation `project.json` would carry no
            // color info and downstream ingest would always see `Unknown`.
            pix_fmt: meta.pix_fmt,
            color_primaries: meta.color_primaries,
            color_trc: meta.color_trc,
            color_space: meta.color_space,
            color_range: meta.color_range,
            has_dolby_vision: meta.has_dolby_vision,
            camera_make: meta.camera_make,
            camera_model: meta.camera_model,
            source_color_class: meta.source_color_class,
            user_color_class_override: meta.user_color_class_override,
            // WS8 — carry the import-time log-format suggestion across to
            // the persisted Clip so WS9's UI can re-surface it after a
            // project save/load round-trip (we don't re-probe ffprobe on
            // load — the hint has to ride in project.json).
            suggested_log_class: meta.suggested_log_class,
            color_space_override: meta.color_space_override,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GradientStop {
    pub fraction: f64,
    pub color: String,
}

/// Decoration color (`mode: "solid"` | `mode: "gradient"`). On disk:
/// `{ "mode": "solid", "solid": "#bced09" }` or
/// `{ "mode": "gradient", "stops": [{ "fraction": 0, "color": "#..." }, ...] }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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

/// Optional halo effect behind a decoration — carried by all three
/// decorations (`route.halo`, `waypoints.halo`, `pov.halo`). Mirrors
/// `HaloSettings` in `src/types.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HaloSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_halo_color")]
    pub color: DecorationColor,
    /// Spread beyond the decoration's own edge, fraction of the paint
    /// reference width (like every other size field).
    #[serde(default = "default_halo_size")]
    pub size: f64,
    /// Softness in [0, 1]: 0 = crisp edge, 1 = fully diffuse glow.
    #[serde(default = "default_halo_fade")]
    pub fade: f64,
    /// Halo line-opacity in [0, 1].
    #[serde(default = "default_halo_opacity")]
    pub opacity: f64,
    /// Radial falloff in [0, 1]: 0 = single even band (pre-falloff
    /// behavior), 1 = bright core hugging the decoration + faint wide
    /// skirt. Defaults to 0 so pre-falloff halo blocks render unchanged.
    #[serde(default)]
    pub falloff: f64,
    /// Screen-space halo offset, X component — signed fraction of the paint
    /// reference width (positive = right). Viewport-anchored drop-shadow
    /// direction; see `src/types.ts`.
    #[serde(default)]
    pub offset_x: f64,
    /// Screen-space halo offset, Y component (positive = down).
    #[serde(default)]
    pub offset_y: f64,
    /// UI affordance — same GRADIENT → SOLID stash/restore semantics as
    /// `RouteSettings.color_stops_cache`. Never read by the renderer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_stops_cache: Option<Vec<GradientStop>>,
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
    /// Optional halo behind the route line. Absent ⇒ disabled — additive,
    /// no schema bump (same precedent as `color_stops_cache`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub halo: Option<HaloSettings>,
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
            halo: None,
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
    /// Secondary color slot — tints the waypoint's outline / accent element.
    /// Defaults to solid white via `default_white_decoration`; legacy v8
    /// projects deserialize with that default so the field is always present
    /// after a load+save round-trip. See `shapes.ts`.
    #[serde(default = "default_white_decoration")]
    pub secondary_color: DecorationColor,
    #[serde(default = "default_waypoint_shape")]
    pub shape: String,
    #[serde(default)]
    pub size: WaypointsSize,
    #[serde(default = "default_label_mode")]
    pub label_mode: String,
    #[serde(default = "default_active_waypoint_mode")]
    pub active_mode: String,
    /// Project-level marker-image selection (schema v11) — id of a
    /// `MapSettings.marker_images` entry. When set, wins over `shape`.
    /// The UI keeps the pair mutually exclusive (picking a shape clears it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marker_image_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_color: Option<String>,
    /// Active-waypoint secondary highlight — mirrors `active_color` for the
    /// secondary slot. Optional; when unset the secondary slot keeps its
    /// resolved per-waypoint color during the active state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_secondary_color: Option<String>,
    /// Optional halo behind every waypoint marker. Absent ⇒ disabled —
    /// additive, no schema bump (same precedent as `route.halo`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub halo: Option<HaloSettings>,
    /// UI affordance — stash of the last gradient stop array, populated when
    /// the user toggles GRADIENT → SOLID in the panel so toggling back
    /// restores the prior gradient. Never read by the renderer; see
    /// `color-gradient.md` §13. Optional and additive — round-trips
    /// transparently when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_stops_cache: Option<Vec<GradientStop>>,
    /// Mirror of `color_stops_cache` for the secondary color slot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secondary_color_stops_cache: Option<Vec<GradientStop>>,
}

impl Default for WaypointsSettings {
    fn default() -> Self {
        WaypointsSettings {
            mode: default_full(),
            color: DecorationColor::default(),
            secondary_color: default_white_decoration(),
            shape: default_waypoint_shape(),
            size: WaypointsSize::default(),
            label_mode: default_label_mode(),
            active_mode: default_active_waypoint_mode(),
            marker_image_id: None,
            active_color: None,
            active_secondary_color: None,
            halo: None,
            color_stops_cache: None,
            secondary_color_stops_cache: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    /// Custom-image marker size (schema v10) — the image's LONGEST side as
    /// a fraction of the 1080 paint reference width, like every other size
    /// field. Only consumed while the POV marker is a library image
    /// (`PovSettings.marker` = `PovMarker::Image`).
    #[serde(default = "default_overlay_pov_image_size")]
    pub image_size: f64,
}

impl Default for PovSize {
    fn default() -> Self {
        PovSize {
            pulse_radius: default_overlay_live_marker_pulse_radius(),
            dot_radius: default_overlay_live_marker_dot_radius(),
            dot_stroke_width: default_overlay_live_marker_dot_stroke_width(),
            pulse_start_radius: default_overlay_pulse_start_radius(),
            pulse_end_radius: default_overlay_pulse_end_radius(),
            image_size: default_overlay_pov_image_size(),
        }
    }
}

/// One entry of the shared project-level marker-image library
/// (`MapSettings.marker_images`, schema v11 — generalized from the v10
/// single `PovSettings.image`). Both files live in the bundle's `assets/`
/// directory (copied by `import_marker_image`); paths are BUNDLE-RELATIVE
/// so the `.trailcut` bundle stays self-contained and relocatable.
/// `icon_file` is the baked render asset (always PNG, longest side ≤ 1024
/// texels — the export renderer's addImage texture cap); `source_file`
/// preserves the original upload (`.png`/`.svg`) for provenance and future
/// re-bakes. `id` is the 16-hex content hash of the original upload — the
/// entry's stable identity (content-addressed, so re-imports dedupe) and
/// the basis of the MapLibre icon id `marker-image-<id>` on both surfaces.
///
/// NOTE: the TypeScript mirror (`MarkerImageRef` in `src/types.ts`) carries
/// an additional TRANSIENT `path` field — the absolute icon path injected by
/// `buildExportRequest` for the renderer sidecar. It is deliberately absent
/// here so a save can never persist an absolute path into the bundle.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkerImage {
    pub id: String,
    pub icon_file: String,
    pub source_file: String,
    pub source_name: String,
    pub width: u32,
    pub height: u32,
}

/// POV marker selection (schema v11) — a built-in shape preset or an
/// uploaded image from the shared library. `None` on `PovSettings.marker`
/// means the default dot. On-disk shape uses the serde tag = "kind"
/// convention (like `WaypointPosition`):
/// `{ "kind": "shape", "shape": "ring" }` /
/// `{ "kind": "image", "image_id": "<16-hex>" }`.
/// Shape names: "dot" | "ring" | "square" | "diamond" (the dot IS the
/// circle; validated by the frontend roster, stored as a plain string like
/// every other shape name in this file).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PovMarker {
    Shape { shape: String },
    Image { image_id: String },
}

/// One seam-ease config (`TransitionSettings.ease_in` / `ease_out`) — how
/// the POV marker animates in/out at clip seams. `style` is one of
/// "pop" | "fade" | "grow"; `speed` one of "slow" | "medium" | "fast"
/// (validated by the frontend roster, stored as plain strings like every
/// other style name in this file). Absent ⇒ none (the marker jumps).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SeamEase {
    pub style: String,
    pub speed: String,
}

/// The TRANSITION decoration (a top-level `MapSettings` block): everything
/// that happens to the playhead at clip seams, as three optional stacking
/// layers — route travel (`travel`), and the seam eases (`ease_in` /
/// `ease_out`; per-clip semantics: `travel` + `ease_in` govern the seam
/// INTO a clip, `ease_out` the seam OUT of it). Absent ⇒ off — additive,
/// no schema bump (same precedent as the halo blocks). Atomic per-clip
/// override blob via `MapOverrides.transition`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransitionSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub travel: Option<TravelSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ease_in: Option<SeamEase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ease_out: Option<SeamEase>,
}

/// The travel layer of the Transition decoration: when enabled, the
/// traveling playhead runs along the route path across the transition
/// window INTO a clip instead of teleporting at the cut; the route trail
/// can draw along with it. The DESTINATION clip's resolved value governs
/// the whole window.
///
/// The three optional toggles default to TRUE when absent (mirrors the
/// `travelShowPlayhead`/`travelSync`/`travelDrawRoute` normalizers in
/// `src/types.ts`), so a hand-written `{ "enabled": true }` reads as the
/// full default behavior.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TravelSettings {
    #[serde(default)]
    pub enabled: bool,
    /// Show the traveling playhead marker during the window.
    #[serde(default = "default_true")]
    pub show_playhead: bool,
    /// true: the traveling playhead wears the destination clip's full
    /// resolved POV look for the whole window. false: `playhead` below
    /// styles it.
    #[serde(default = "default_true")]
    pub sync: bool,
    /// Custom traveling-playhead style (full POV capability), consumed only
    /// while `sync` is false. Inside this block `marker: None` means the
    /// default dot — normal `PovSettings` semantics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playhead: Option<PovSettings>,
    /// Draw the route trail along with the travel (forced visible during
    /// the window even when the route decoration mode is 'none').
    #[serde(default = "default_true")]
    pub draw_route: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PovSettings {
    #[serde(default = "default_accent_color")]
    pub color: String,
    /// Secondary color — tints the POV marker's accent (today the
    /// `live-marker-dot` stroke). Defaults to white to match the pre-refactor
    /// hard-coded dot fill so existing projects look identical after the
    /// load + first-save round-trip introduces this field.
    #[serde(default = "default_white_color")]
    pub secondary_color: String,
    #[serde(default)]
    pub size: PovSize,
    #[serde(default = "default_pulse_style")]
    pub pulse_style: String,
    #[serde(default = "default_pulse_rate")]
    pub pulse_rate: String,
    /// Marker selection (schema v11) — shape preset or library image.
    /// `None` means the default dot. Per-clip overridable via
    /// `PovOverrides.marker`: every used texture registers once at export
    /// setup, so per-clip swaps are plain icon-image layout changes at
    /// cuts, not per-frame re-registration. Replaced the v10 single
    /// `image: Option<PovImage>` field (migration v10→v11 moves that ref
    /// into `MapSettings.marker_images` and points `marker` at it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marker: Option<PovMarker>,
    /// Optional halo behind the POV marker. Absent ⇒ disabled — additive,
    /// no schema bump (same precedent as `route.halo`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub halo: Option<HaloSettings>,
}

impl Default for PovSettings {
    fn default() -> Self {
        PovSettings {
            color: default_accent_color(),
            secondary_color: default_white_color(),
            size: PovSize::default(),
            pulse_style: default_pulse_style(),
            pulse_rate: default_pulse_rate(),
            marker: None,
            halo: None,
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
    /// The Transition decoration — travel + seam eases. Absent ⇒ off;
    /// additive, no schema bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition: Option<TransitionSettings>,
    /// Shared project-level marker-image library (schema v11). Both the POV
    /// and Waypoints decorations select from this one list. Skipped when
    /// empty so pre-v11 bundles round-trip byte-identically until a first
    /// upload.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub marker_images: Vec<MarkerImage>,
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
    0.006
}
fn default_overlay_waypoint_circle_radius() -> f64 {
    0.02
}
fn default_overlay_waypoint_active_radius() -> f64 {
    0.025
}
fn default_overlay_waypoint_stroke_width() -> f64 {
    0.004
}
fn default_overlay_waypoint_label_size() -> f64 {
    0.018
}
fn default_overlay_live_marker_pulse_radius() -> f64 {
    0.016
}
fn default_overlay_live_marker_dot_radius() -> f64 {
    0.017
}
fn default_overlay_live_marker_dot_stroke_width() -> f64 {
    0.005
}
fn default_overlay_pulse_start_radius() -> f64 {
    0.016
}
fn default_overlay_pulse_end_radius() -> f64 {
    0.044
}
/// Custom POV image longest side: ~86 CSS px at the 1080 reference width.
/// Mirrors `DEFAULT_MAP_SETTINGS.pov.size.image_size` in `src/types.ts`.
fn default_overlay_pov_image_size() -> f64 {
    0.08
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
/// Default for `secondary_color` slots that take a plain hex string (POV).
/// White is the historical pre-refactor default for the dot fill and the
/// universal "neutral outline" choice when the secondary slot isn't doing
/// anything more specific.
fn default_white_color() -> String {
    "#ffffff".to_string()
}
/// Default for `secondary_color` slots that take a `DecorationColor` (waypoints).
/// Solid white — see `default_white_color` for rationale.
fn default_white_decoration() -> DecorationColor {
    DecorationColor::Solid { solid: default_white_color() }
}
fn default_pulse_style() -> String {
    "sonar".to_string()
}
fn default_pulse_rate() -> String {
    "medium".to_string()
}
/// Halo defaults mirror `DEFAULT_ROUTE_HALO` in `src/types.ts` — a soft
/// white glow. They only matter for partially-written halo blocks (the UI
/// always writes the full object).
fn default_halo_color() -> DecorationColor {
    default_white_decoration()
}
fn default_halo_size() -> f64 {
    0.004
}
fn default_halo_fade() -> f64 {
    0.5
}
fn default_halo_opacity() -> f64 {
    0.6
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
    /// Per-clip route color (solid or gradient) — full capability parity
    /// with the project-level `RouteSettings.color`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<DecorationColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<RouteSizeOverrides>,
    /// Per-clip route halo — a complete `HaloSettings` blob (overrides are
    /// atomic per halo, not per halo field).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub halo: Option<HaloSettings>,
}

/// Per-clip override of the project-default waypoint marker. Atomic:
/// `shape` + `marker_image_id` are a mutually-exclusive pair (image wins),
/// captured wholesale so a sparse override can express "image cleared, use
/// my shape". Mirrors `WaypointMarkerOverride` in `src/types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaypointsMarkerOverride {
    pub shape: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marker_image_id: Option<String>,
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
    /// Clip-level default color for ALL waypoints while the clip plays;
    /// per-`Waypoint` entity colors still win per feature.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<DecorationColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secondary_color: Option<DecorationColor>,
    /// Clip-level default marker (atomic shape/image pair).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marker: Option<WaypointsMarkerOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_secondary_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<WaypointsSizeOverrides>,
    /// Per-clip waypoints halo — complete `HaloSettings` blob.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub halo: Option<HaloSettings>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_size: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PovOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secondary_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<PovSizeOverrides>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pulse_style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pulse_rate: Option<String>,
    /// Per-clip POV marker override (schema v11) — shape preset or library
    /// image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marker: Option<PovMarker>,
    /// Per-clip POV halo — complete `HaloSettings` blob (solid color only,
    /// same POV rule as the project-level halo).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub halo: Option<HaloSettings>,
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
    /// Per-clip Transition override — `travel` + `ease_in` govern the seam
    /// INTO this clip, `ease_out` the seam OUT of it. Atomic blob (halo
    /// precedent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition: Option<TransitionSettings>,
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
    /// Per-waypoint solid PRIMARY-color override. None falls through to the
    /// project default at render time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Per-waypoint solid SECONDARY-color override (the outline / accent slot
    /// on shapes that define one). None falls through to the project default.
    /// Solid only — single-point gradients don't apply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secondary_color: Option<String>,
    /// Per-waypoint shape override. None falls through to the project default.
    /// Mutually exclusive with `marker_image_id` (UI clears one when setting
    /// the other).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<String>,
    /// Per-waypoint marker-image override (schema v11) — id of a
    /// `MapSettings.marker_images` entry. When set, wins over both `shape`
    /// and the project-level waypoint marker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marker_image_id: Option<String>,
}

/// A clip group: a contiguous, timeline-ordered run of ≥2 clip ids that acts
/// as ONE camera-stop generator — the camera glides continuously across the
/// member cuts instead of arcing per clip (`docs/CLIP_GROUPS_HANDOFF.md` §1).
/// No per-group settings in v1; the glide's shape comes entirely from the
/// members' resolved MapSettings. Referential integrity (dropping ids of
/// removed clips, re-splitting runs after an import re-sort, dissolving runs
/// with <2 members) is the frontend's `normalizeClipGroups`
/// (`src/lib/clipGroups.ts`) — the Rust side only persists the list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClipGroup {
    pub id: String,
    pub clip_ids: Vec<String>,
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
/// "Configure export" panel writes these — each holds an output resolution,
/// frame rate, and (WS5) delivery target. `id` is a UUID minted at chip
/// creation time so multiple chips can coexist in the same cell without
/// React-key collisions, even mid-edit when `(quality, fps, delivery_target)`
/// values transiently overlap. Mirrors the TypeScript `ExportConfig` in
/// `src/types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExportConfig {
    pub id: String,
    pub quality: OutputResolution,
    /// 24 | 30 | 60 — narrower than the wire-level `RenderExportRequest.fps`
    /// but stored as plain `u32` here for serde simplicity. The TS layer
    /// constrains the literal at the type level.
    pub fps: u32,
    /// Delivery target (color regime + codec + container). Optional so
    /// projects persisted without an explicit target round-trip cleanly;
    /// consumers (the TS picker, `deriveJobs`, `select_encoder_for_target`)
    /// treat a missing value as the channel default (composite → `sdr_h265`,
    /// map_only/video_only → `prores`). `skip_serializing_if = "Option::is_none"`
    /// keeps the on-disk JSON quiet when a chip uses its channel default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_target: Option<DeliveryTarget>,
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
/// v9 adds the project-level `working_color_space` and the per-clip
/// `color_space_override` (atomic-axes color matrix). Purely additive: both
/// default to their pre-v9 behavior (linear BT.2020 working space; no
/// override), so the v8→v9 migration just stamps the version and existing
/// exports stay byte-identical.
/// v10 adds the custom POV marker image (v10's `PovSettings.image`, an
/// optional bundle-asset reference) and `PovSize.image_size` (+ its
/// per-clip override). Purely additive — the v9→v10 migration just stamps
/// the version; projects without an image render exactly as before.
/// v11 generalizes that single image into the shared marker library:
/// `MapSettings.marker_images` (uploads selectable by BOTH decorations),
/// `PovSettings.marker` (shape preset or library image, per-clip
/// overridable via `PovOverrides.marker`), and
/// `WaypointsSettings.marker_image_id` / `Waypoint.marker_image_id`. The
/// v10→v11 migration moves `pov.image` into the library and points
/// `pov.marker` at it; everything else is additive.
pub const CURRENT_SCHEMA_VERSION: u32 = 11;

fn default_schema_version() -> u32 {
    // Legacy files lack the field; treat them as v1 for migration purposes.
    1
}

fn default_project_version() -> u32 {
    // The vestigial `version` field has been 1 since the first release.
    1
}

impl Default for MapSettings {
    fn default() -> Self {
        MapSettings {
            camera: CameraSettings::default(),
            route: RouteSettings::default(),
            waypoints: WaypointsSettings::default(),
            pov: PovSettings::default(),
            transition: None,
            marker_images: Vec::new(),
        }
    }
}


fn default_magnification() -> f64 {
    // Identity — the export renders the canonical viewport verbatim.
    1.0
}

/// Per-aspect map magnification factor `k`. Magnifies the whole exported map
/// render: the renderer's css viewport shrinks by `k` while `pixelRatio` grows
/// by `k`, so the framebuffer stays slot-sized but every element (basemap,
/// labels, decorations, world scale) lands `k`× larger relative to the frame.
/// It is the third lever on top of the resolution multiplier and the SSAA
/// factor — see `build_setup_payload` in `export/mod.rs`.
///
/// Unlike [`ProjectLayouts`] there is no "cleared" state: an aspect the user
/// has never touched is `1.0`, which is also what the pipeline renders, so the
/// leaves are plain `f64` with a serde default rather than `Option`. The
/// carrying field on [`Project`] stays `Option` so bundles that never set a
/// magnification round-trip without gaining the key.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MapMagnifications {
    #[serde(rename = "9_16", default = "default_magnification")]
    pub aspect_9_16: f64,
    #[serde(rename = "4_5", default = "default_magnification")]
    pub aspect_4_5: f64,
    #[serde(rename = "16_9", default = "default_magnification")]
    pub aspect_16_9: f64,
}

impl Default for MapMagnifications {
    fn default() -> Self {
        MapMagnifications {
            aspect_9_16: default_magnification(),
            aspect_4_5: default_magnification(),
            aspect_16_9: default_magnification(),
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
    /// Vestigial pre-`schema_version` marker — every bundle and the TS
    /// mirror carry `version: 1` and nothing reads it. Serde-defaulted so a
    /// wire payload without it no longer hard-fails deserialization (it had
    /// no default, making the meaningless field load-bearing for IPC).
    #[serde(default = "default_project_version")]
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
    /// Per-aspect map magnification. Absent ⇒ every aspect renders at `1.0`
    /// — additive, no schema bump (same precedent as `RouteSettings.halo` and
    /// `MapSettings.marker_images`). `buildExportRequest` reads the entry for
    /// the exported aspect into `LayoutDescriptor.magnification`; nothing else
    /// consumes it. See [`MapMagnifications`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_magnification: Option<MapMagnifications>,
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
    /// Project-level working color space (schema v9). The pipeline composites
    /// in this space. Omitted from on-disk JSON when equal to the default
    /// (`linear_bt2020_full`) so existing bundles are untouched; consumers
    /// treat absent as the default. See [`WorkingColorSpaceId`].
    #[serde(
        default = "default_working_color_space",
        skip_serializing_if = "is_default_working_color_space"
    )]
    pub working_color_space: WorkingColorSpaceId,
    /// Clip groups (camera glide). Absent on disk ⇔ empty — additive, no
    /// schema bump (same precedent as `map_magnification` and
    /// `MapSettings.marker_images`). Members are clip ids in timeline order;
    /// hidden members STAY persisted (hide is a soft toggle — the compiler
    /// re-normalizes per compile). See [`ClipGroup`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub clip_groups: Vec<ClipGroup>,
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
            // Not seeded: absent and all-`1.0` are the same render, so a fresh
            // bundle stays free of the key until the user moves a slider.
            map_magnification: None,
            selected_export_aspect: default_selected_aspect(),
            map_settings: None,
            transition_feel: None,
            start_camera: None,
            default_entry_transition: None,
            last_export_selection: None,
            waypoints: Vec::new(),
            working_color_space: WorkingColorSpaceId::LinearBt2020Full,
            clip_groups: Vec::new(),
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
                    delivery_target: Some(DeliveryTarget::SdrH264),
                },
                ExportConfig {
                    id: "cfg-b".to_string(),
                    quality: OutputResolution::P2160,
                    fps: 60,
                    delivery_target: Some(DeliveryTarget::HdrHlg),
                },
            ],
        );
        cells.insert(
            "4_5-map_only".to_string(),
            vec![ExportConfig {
                id: "cfg-c".to_string(),
                quality: OutputResolution::P1080,
                fps: 30,
                delivery_target: None,
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
        // WS5 — explicit targets round-trip; missing target stays None.
        let cell = parsed.cells.get("9_16-composite").unwrap();
        assert_eq!(
            cell[0].delivery_target,
            Some(DeliveryTarget::SdrH264),
        );
        assert_eq!(
            cell[1].delivery_target,
            Some(DeliveryTarget::HdrHlg),
        );
        let map_only_cell = parsed.cells.get("4_5-map_only").unwrap();
        assert_eq!(map_only_cell[0].delivery_target, None);
    }

    #[test]
    fn export_config_round_trips_without_delivery_target_field() {
        // Back-compat: a pre-WS5 ExportConfig JSON lacks `delivery_target`.
        // serde(default) must accept it and populate `None`, and re-serializing
        // a `None` value must omit the field (skip_serializing_if).
        let raw = r#"{"id":"cfg","quality":"1080p","fps":30}"#;
        let parsed: ExportConfig = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.delivery_target, None);
        let reserialized = serde_json::to_string(&parsed).unwrap();
        assert!(
            !reserialized.contains("delivery_target"),
            "None target must not appear in JSON: {}",
            reserialized,
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
    fn map_settings_transition_is_additive() {
        // A v11 bundle written before the Transition decoration has no
        // `map_settings.transition` — serde(default) must supply `None`,
        // and a `None` must not reappear on save (skip_serializing_if), so
        // untouched projects round-trip byte-identically. No schema bump.
        let parsed: MapSettings = serde_json::from_str(r#"{}"#).expect("must deserialize");
        assert!(parsed.transition.is_none());
        let reserialized = serde_json::to_string(&parsed).unwrap();
        assert!(
            !reserialized.contains("transition"),
            "absent transition must not appear in JSON: {}",
            reserialized,
        );

        // A minimal travel `{ "enabled": true }` reads as the full default
        // behavior: playhead shown, synced, route drawn (default_true on
        // every optional toggle — mirrors the TS normalizers). Eases stay
        // absent (= none).
        let parsed: MapSettings = serde_json::from_str(
            r#"{ "transition": { "travel": { "enabled": true } } }"#,
        )
        .unwrap();
        let transition = parsed.transition.clone().expect("transition must parse");
        let travel = transition.travel.clone().expect("travel must parse");
        assert!(travel.enabled);
        assert!(travel.show_playhead);
        assert!(travel.sync);
        assert!(travel.draw_route);
        assert!(travel.playhead.is_none());
        assert!(transition.ease_in.is_none());
        assert!(transition.ease_out.is_none());

        // A fully-configured block (custom unsynced playhead style + both
        // seam eases) round-trips whole.
        let with_style = r##"{
            "transition": {
                "travel": {
                    "enabled": true,
                    "show_playhead": true,
                    "sync": false,
                    "draw_route": false,
                    "playhead": {
                        "color": "#ff715b",
                        "secondary_color": "#ffffff",
                        "pulse_style": "heartbeat",
                        "pulse_rate": "fast",
                        "marker": { "kind": "shape", "shape": "ring" }
                    }
                },
                "ease_in": { "style": "pop", "speed": "fast" },
                "ease_out": { "style": "fade", "speed": "slow" }
            }
        }"##;
        let parsed: MapSettings = serde_json::from_str(with_style).unwrap();
        let transition = parsed.transition.clone().expect("transition must parse");
        let travel = transition.travel.as_ref().expect("travel must parse");
        assert!(!travel.sync);
        assert!(!travel.draw_route);
        let playhead = travel.playhead.as_ref().expect("playhead style must parse");
        assert_eq!(playhead.pulse_style, "heartbeat");
        assert_eq!(
            playhead.marker,
            Some(PovMarker::Shape { shape: "ring".to_string() }),
        );
        assert_eq!(
            transition.ease_in,
            Some(SeamEase { style: "pop".to_string(), speed: "fast".to_string() }),
        );
        assert_eq!(
            transition.ease_out,
            Some(SeamEase { style: "fade".to_string(), speed: "slow".to_string() }),
        );
        let round: MapSettings =
            serde_json::from_str(&serde_json::to_string(&parsed).unwrap()).unwrap();
        assert_eq!(round.transition, parsed.transition);

        // Same additivity on the per-clip override mirror (top-level
        // `MapOverrides.transition`, atomic blob).
        let overrides: MapOverrides = serde_json::from_str(r#"{}"#).unwrap();
        assert!(overrides.transition.is_none());
        let overrides: MapOverrides = serde_json::from_str(
            r#"{ "transition": { "ease_in": { "style": "grow", "speed": "medium" } } }"#,
        )
        .unwrap();
        let t = overrides.transition.expect("override transition must parse");
        assert!(t.travel.is_none());
        assert_eq!(
            t.ease_in,
            Some(SeamEase { style: "grow".to_string(), speed: "medium".to_string() }),
        );
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
            halo: None,
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
            secondary_color: DecorationColor::Solid {
                solid: "#ffffff".to_string(),
            },
            shape: "circle".to_string(),
            size: WaypointsSize::default(),
            label_mode: "numbered".to_string(),
            active_mode: "latest_passed".to_string(),
            marker_image_id: None,
            active_color: None,
            active_secondary_color: None,
            halo: None,
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
            secondary_color_stops_cache: None,
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
                delivery_target: Some(DeliveryTarget::SdrH264),
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

    // ---- WS0: color metadata round-trip + effective-class tests ----

    fn color_clip(class: SourceColorClass) -> Clip {
        Clip {
            id: "color-clip".to_string(),
            path: "/tmp/c.mov".to_string(),
            filename: "c.mov".to_string(),
            created_at: None,
            duration_ms: Some(2000),
            gps: None,
            resolution: Some("3840x2160".to_string()),
            frame_rate: Some(30.0),
            trim: Some(TrimRange { in_ms: 0, out_ms: 2000 }),
            focal_point: FocalPoint { x: 0.5, y: 0.5, zoom: 1.0 },
            effects: Effects {
                stabilize: StabilizeSettings { enabled: false, shakiness: 5 },
                speed: 1.0,
            },
            visible: true,
            map_overrides: None,
            entry_transition: None,
            pix_fmt: Some("yuv420p10le".to_string()),
            color_primaries: Some("bt2020".to_string()),
            color_trc: Some("arib-std-b67".to_string()),
            color_space: Some("bt2020nc".to_string()),
            color_range: Some("tv".to_string()),
            has_dolby_vision: matches!(class, SourceColorClass::DolbyVision),
            camera_make: Some("Apple".to_string()),
            camera_model: Some("iPhone 15 Pro".to_string()),
            source_color_class: class,
            user_color_class_override: None,
            // WS8 — color_clip is always Apple/iPhone, which the knowledge
            // base intentionally never suggests a log format for. Leaving
            // this as None reflects the import-path reality and keeps the
            // helper a stand-in for the common "no suggestion" case.
            suggested_log_class: None,
            color_space_override: None,
        }
    }

    #[test]
    fn clip_color_fields_round_trip_through_project_json() {
        // Acceptance criterion: "Saving and reloading a project preserves
        // the color fields (JSON round-trip works)." Direct serde test —
        // no filesystem so it stays fast in CI.
        let mut project = Project::default();
        project.clips.push(color_clip(SourceColorClass::HlgBt2020));

        let json = serde_json::to_string_pretty(&project).expect("serialize");
        // Spot-check the on-disk shape carries the new keys.
        assert!(json.contains("\"source_color_class\": \"hlg_bt2020\""));
        assert!(json.contains("\"color_trc\": \"arib-std-b67\""));
        assert!(json.contains("\"has_dolby_vision\": false"));

        let parsed: Project = serde_json::from_str(&json).expect("deserialize");
        let clip = &parsed.clips[0];
        assert_eq!(clip.pix_fmt.as_deref(), Some("yuv420p10le"));
        assert_eq!(clip.color_primaries.as_deref(), Some("bt2020"));
        assert_eq!(clip.color_trc.as_deref(), Some("arib-std-b67"));
        assert_eq!(clip.color_space.as_deref(), Some("bt2020nc"));
        assert_eq!(clip.color_range.as_deref(), Some("tv"));
        assert!(!clip.has_dolby_vision);
        assert_eq!(clip.camera_make.as_deref(), Some("Apple"));
        assert_eq!(clip.camera_model.as_deref(), Some("iPhone 15 Pro"));
        assert_eq!(clip.source_color_class, SourceColorClass::HlgBt2020);
        assert!(clip.user_color_class_override.is_none());
        assert_eq!(clip.effective_color_class(), SourceColorClass::HlgBt2020);
    }

    #[test]
    fn clip_deserialises_when_color_fields_absent() {
        // Backwards compatibility: a clip persisted before WS0 has none of
        // the new color keys in its JSON. serde defaults must fill them in
        // and `effective_color_class()` must return `Unknown` (the
        // documented "treat as SDR downstream" sentinel).
        let raw = r#"{
            "id": "legacy",
            "path": "/tmp/legacy.mov",
            "filename": "legacy.mov",
            "created_at": null,
            "duration_ms": 1000,
            "gps": null,
            "resolution": null,
            "frame_rate": null,
            "trim": null,
            "focal_point": {"x": 0.5, "y": 0.5, "zoom": 1.0},
            "effects": {"stabilize": {"enabled": false, "shakiness": 5}, "speed": 1.0}
        }"#;
        let clip: Clip = serde_json::from_str(raw).expect("legacy clip must deserialize");
        assert!(clip.pix_fmt.is_none());
        assert!(clip.color_primaries.is_none());
        assert!(clip.color_trc.is_none());
        assert!(!clip.has_dolby_vision);
        assert_eq!(clip.source_color_class, SourceColorClass::Unknown);
        assert_eq!(clip.effective_color_class(), SourceColorClass::Unknown);
    }

    #[test]
    fn effective_color_class_prefers_user_override() {
        // Phase 2 contract preview: when the user sets a log-format
        // override on an otherwise-SDR-tagged clip, `effective_color_class`
        // must surface the override. Every downstream ingest formula
        // branches on this method, so the override propagates end-to-end.
        let mut clip = color_clip(SourceColorClass::SdrBt709);
        assert_eq!(clip.effective_color_class(), SourceColorClass::SdrBt709);
        clip.user_color_class_override = Some(SourceColorClass::DLog);
        assert_eq!(clip.effective_color_class(), SourceColorClass::DLog);
    }

    #[test]
    fn effective_color_space_applies_per_axis_override() {
        use crate::util::color_space::{Matrix, Primaries, Range, Transfer};
        // No override: derive from the detected class. SDR ⇒ BT.709 limited.
        let mut clip = color_clip(SourceColorClass::SdrBt709);
        let base = clip.effective_color_space();
        assert_eq!(base.primaries, Primaries::Bt709);
        assert_eq!(base.transfer, Transfer::Bt709);
        assert_eq!(base.range, Range::Limited);
        assert_eq!(base.matrix, Matrix::Bt709);

        // User corrects a mistagged clip: it's actually full-range. ONLY the
        // range axis changes; the others stay at the detected base.
        clip.color_space_override = Some(PerAxisOverride {
            range: Some("full".to_string()),
            inferred_range: true,
            ..Default::default()
        });
        let patched = clip.effective_color_space();
        assert_eq!(patched.range, Range::Full);
        assert_eq!(patched.primaries, Primaries::Bt709);
        assert_eq!(patched.transfer, Transfer::Bt709);
        assert_eq!(patched.matrix, Matrix::Bt709);
    }

    #[test]
    fn clip_metadata_to_clip_propagates_color_fields() {
        // The `From<ClipMetadata> for Clip` impl is the import path's
        // load-bearing seam: ffprobe lands color fields on `ClipMetadata`,
        // then the project lifts the metadata into a `Clip`. The lift must
        // carry color through — otherwise the persisted clip in
        // `project.json` loses the import-time decision.
        let meta = ClipMetadata {
            id: "m".to_string(),
            path: "/tmp/m.mov".to_string(),
            filename: "m.mov".to_string(),
            created_at: None,
            duration_ms: Some(1500),
            gps: None,
            resolution: None,
            frame_rate: None,
            pix_fmt: Some("yuv420p10le".to_string()),
            color_primaries: Some("bt2020".to_string()),
            color_trc: Some("smpte2084".to_string()),
            color_space: Some("bt2020nc".to_string()),
            color_range: Some("tv".to_string()),
            has_dolby_vision: false,
            camera_make: Some("Apple".to_string()),
            camera_model: Some("iPhone 15 Pro".to_string()),
            source_color_class: SourceColorClass::PqBt2020,
            user_color_class_override: None,
            suggested_log_class: None,
            color_space_override: None,
        };
        let clip = Clip::from(meta);
        assert_eq!(clip.color_trc.as_deref(), Some("smpte2084"));
        assert_eq!(clip.source_color_class, SourceColorClass::PqBt2020);
        assert_eq!(clip.effective_color_class(), SourceColorClass::PqBt2020);
    }

    // ---- WS8: suggested_log_class round-trip + propagation ----

    #[test]
    fn suggested_log_class_round_trips_through_project_json() {
        // The suggestion field must survive project save → load so WS9's UI
        // can re-surface the "Looks like D-Log — apply?" affordance after a
        // re-open. ffprobe doesn't re-run on load; the hint has to ride in
        // project.json.
        let mut clip = color_clip(SourceColorClass::SdrBt709);
        clip.suggested_log_class = Some(SourceColorClass::DLog);
        let mut project = Project::default();
        project.clips.push(clip);

        let json = serde_json::to_string_pretty(&project).expect("serialize");
        assert!(
            json.contains("\"suggested_log_class\": \"d_log\""),
            "suggested_log_class must appear in JSON: {json}"
        );

        let parsed: Project = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(
            parsed.clips[0].suggested_log_class,
            Some(SourceColorClass::DLog),
        );
    }

    #[test]
    fn suggested_log_class_omitted_from_json_when_none() {
        // `skip_serializing_if = "Option::is_none"` — the field stays out of
        // project.json for the common no-suggestion case (iPhone, GoPro
        // 8-bit, etc.). Keeps the on-disk shape byte-identical to pre-WS8
        // bundles for everything except clips with an actual suggestion.
        let mut project = Project::default();
        project.clips.push(color_clip(SourceColorClass::HlgBt2020));
        let json = serde_json::to_string(&project).expect("serialize");
        assert!(
            !json.contains("suggested_log_class"),
            "None suggestion must be absent from JSON: {json}"
        );
    }

    #[test]
    fn suggested_log_class_does_not_affect_effective_color_class() {
        // Contract: the suggestion is a UI hint, never auto-applied.
        // `effective_color_class()` reads `user_color_class_override` >
        // `source_color_class` and never consults `suggested_log_class`.
        let mut clip = color_clip(SourceColorClass::SdrBt709);
        clip.suggested_log_class = Some(SourceColorClass::DLog);
        assert_eq!(clip.effective_color_class(), SourceColorClass::SdrBt709);
        // ...and once the user confirms the suggestion (via WS9's UI), they
        // set the override explicitly — *then* the pipeline branches on it.
        clip.user_color_class_override = Some(SourceColorClass::DLog);
        assert_eq!(clip.effective_color_class(), SourceColorClass::DLog);
    }

    #[test]
    fn suggested_log_class_propagates_through_clip_metadata_to_clip() {
        // The `From<ClipMetadata> for Clip` lift is the import path's seam.
        // suggest_log_format() lands a value on `ClipMetadata` in
        // `populate_color_metadata`; the lift must carry it onto the Clip so
        // it persists in project.json.
        let meta = ClipMetadata {
            id: "m".to_string(),
            path: "/tmp/m.mov".to_string(),
            filename: "m.mov".to_string(),
            created_at: None,
            duration_ms: Some(1500),
            gps: None,
            resolution: None,
            frame_rate: None,
            pix_fmt: Some("yuv420p10le".to_string()),
            color_primaries: Some("bt709".to_string()),
            color_trc: Some("bt709".to_string()),
            color_space: Some("bt709".to_string()),
            color_range: Some("tv".to_string()),
            has_dolby_vision: false,
            camera_make: Some("DJI".to_string()),
            camera_model: Some("Mavic 3".to_string()),
            source_color_class: SourceColorClass::SdrBt709,
            user_color_class_override: None,
            suggested_log_class: Some(SourceColorClass::DLog),
            color_space_override: None,
        };
        let clip = Clip::from(meta);
        assert_eq!(clip.suggested_log_class, Some(SourceColorClass::DLog));
        // Pipeline still sees SDR (the auto-detected class) until the user
        // confirms — propagation doesn't change the effective class.
        assert_eq!(clip.effective_color_class(), SourceColorClass::SdrBt709);
    }

    // ---- clip_groups: additive-field persistence contract ----------------

    #[test]
    fn clip_groups_absent_reads_as_empty_and_stays_absent_on_reserialize() {
        // Additive-field contract (same as map_magnification): a bundle that
        // never grouped anything reads as `[]` and must not gain the key when
        // the app re-saves it.
        let raw = r#"{
            "schema_version": 11,
            "version": 1,
            "name": "No Groups",
            "clips": []
        }"#;
        let parsed: Project = serde_json::from_str(raw).expect("must deserialize");
        assert!(parsed.clip_groups.is_empty());
        let json = serde_json::to_string(&parsed).unwrap();
        assert!(
            !json.contains("clip_groups"),
            "empty clip_groups must not be serialized: {}",
            json,
        );
        assert!(Project::default().clip_groups.is_empty());
    }

    #[test]
    fn clip_groups_round_trip_in_member_order() {
        let project = Project {
            clip_groups: vec![ClipGroup {
                id: "g-1".into(),
                clip_ids: vec!["clip-b".into(), "clip-c".into(), "clip-d".into()],
            }],
            ..Project::default()
        };
        let json = serde_json::to_string(&project).unwrap();
        assert!(json.contains("\"clip_groups\""), "{}", json);
        let parsed: Project = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.clip_groups, project.clip_groups);
    }

    // ---- map_magnification: additive-field persistence contract ----------

    #[test]
    fn map_magnification_absent_reads_as_none() {
        let raw = r#"{
            "schema_version": 11,
            "version": 1,
            "name": "No Magnification",
            "clips": []
        }"#;
        let parsed: Project = serde_json::from_str(raw).expect("must deserialize");
        assert!(parsed.map_magnification.is_none());
    }

    #[test]
    fn map_magnification_absent_stays_absent_on_reserialize() {
        // The additive-field contract: a bundle that never set a magnification
        // must not gain the key when the app re-saves it. Byte-level, because
        // an `Option` without `skip_serializing_if` would emit `null` here and
        // silently rewrite every existing project file.
        let project = Project::default();
        assert!(project.map_magnification.is_none());
        let json = serde_json::to_string(&project).unwrap();
        assert!(
            !json.contains("map_magnification"),
            "absent magnification must not be serialized: {}",
            json,
        );
    }

    #[test]
    fn map_magnification_round_trips_per_aspect() {
        let project = Project {
            map_magnification: Some(MapMagnifications {
                aspect_9_16: 1.4,
                aspect_4_5: 0.75,
                aspect_16_9: 2.0,
            }),
            ..Project::default()
        };
        let json = serde_json::to_string(&project).unwrap();
        assert!(json.contains("\"map_magnification\""), "{}", json);
        // Aspect keys use the same wire names as `ProjectLayouts`.
        assert!(json.contains("\"9_16\":1.4"), "{}", json);
        let parsed: Project = serde_json::from_str(&json).unwrap();
        assert_eq!(
            parsed.map_magnification,
            Some(MapMagnifications {
                aspect_9_16: 1.4,
                aspect_4_5: 0.75,
                aspect_16_9: 2.0,
            }),
        );
    }

    #[test]
    fn map_magnification_partial_object_defaults_missing_aspects_to_identity() {
        // A frontend that only ever wrote the aspect the user touched must not
        // read back as 0.0 on the other two.
        let raw = r#"{
            "schema_version": 11,
            "version": 1,
            "name": "Partial",
            "clips": [],
            "map_magnification": {"9_16": 1.6}
        }"#;
        let parsed: Project = serde_json::from_str(raw).expect("must deserialize");
        let m = parsed.map_magnification.expect("field present");
        assert_eq!(m.aspect_9_16, 1.6);
        assert_eq!(m.aspect_4_5, 1.0);
        assert_eq!(m.aspect_16_9, 1.0);
        assert_eq!(MapMagnifications::default(), MapMagnifications {
            aspect_9_16: 1.0,
            aspect_4_5: 1.0,
            aspect_16_9: 1.0,
        });
    }
}
