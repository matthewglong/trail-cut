use crate::export::layout::{default_pip_layout, AspectRatio};
use crate::models::*;
use crate::util::fs::ensure_dir;
use std::path::Path;

/// Create a new project bundle directory
#[tauri::command]
pub fn create_project(project_dir: String) -> Result<(), String> {
    let dir = Path::new(&project_dir);
    ensure_dir(dir)?;
    ensure_dir(&dir.join("proxies"))?;
    ensure_dir(&dir.join("thumbnails"))?;

    let project = Project::default();
    let json = serde_json::to_string_pretty(&project)
        .map_err(|e| format!("Failed to serialize project: {}", e))?;
    std::fs::write(dir.join("project.json"), json)
        .map_err(|e| format!("Failed to write project.json: {}", e))?;

    Ok(())
}

/// Save project to project bundle. Always writes `schema_version =
/// CURRENT_SCHEMA_VERSION` regardless of what came in from the frontend.
/// Also clears the in-memory `route` field before serialization — the
/// canonical route lives in `<bundle>/route.gpx`, and `Project.route` has
/// `skip_serializing_if = "Option::is_none"` so `None` drops the key.
#[tauri::command]
pub fn save_project(mut project: Project, project_dir: String) -> Result<(), String> {
    project.schema_version = CURRENT_SCHEMA_VERSION;
    project.route = None;
    let path = Path::new(&project_dir).join("project.json");
    let json = serde_json::to_string_pretty(&project)
        .map_err(|e| format!("Failed to serialize project: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write project file: {}", e))?;
    Ok(())
}

/// Load project from project bundle. Reads the `schema_version` field, runs
/// any required one-shot migrations, then re-parses the bundle's `route.gpx`
/// (if present) into the in-memory `route` field. Files lacking the schema
/// field are read as v1 and migrated to v2.
#[tauri::command]
pub fn load_project(project_dir: String) -> Result<Project, String> {
    let dir = Path::new(&project_dir);
    let path = dir.join("project.json");
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read project file: {}", e))?;
    let raw: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse project: {}", e))?;
    let version = raw
        .get("schema_version")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32)
        .unwrap_or(1);

    // Pre-100 detection (task 100). The `selected_export_aspect` field was
    // introduced by 100; bundles without it pre-date the configurator's
    // ability to express "the user has explicitly cleared this aspect".
    // Post-100, a missing aspect entry inside `layouts` is intentional user
    // intent (set via a future 110 affordance) and must be preserved on
    // reload. Pre-100, missing aspect entries are just unseeded — the
    // backfill below brings them up to the new "all three aspects seeded"
    // shape from `Project::default`. Captured before any migration consumes
    // `raw` because the field can only appear on v4-shaped projects, but the
    // detection rule applies uniformly across all versions.
    let is_pre_100 = raw.get("selected_export_aspect").is_none();

    let mut project = match version {
        1 => {
            // Chain v1 → v2 → v3 → v4 → v5 → v6. Each step is value-level
            // until the final `from_value` so a partially-migrated bundle
            // (e.g. an interrupted save) reads through cleanly.
            let v2 = migrate_v1_to_v2_value(raw)?;
            let v3 = migrate_v2_to_v3_value(v2)?;
            let v4 = migrate_v3_to_v4_value(v3)?;
            let v5 = migrate_v4_to_v5_value(v4)?;
            migrate_v5_to_v6(v5)?
        }
        2 => {
            let v3 = migrate_v2_to_v3_value(raw)?;
            let v4 = migrate_v3_to_v4_value(v3)?;
            let v5 = migrate_v4_to_v5_value(v4)?;
            migrate_v5_to_v6(v5)?
        }
        3 => {
            let v4 = migrate_v3_to_v4_value(raw)?;
            let v5 = migrate_v4_to_v5_value(v4)?;
            migrate_v5_to_v6(v5)?
        }
        4 => {
            let v5 = migrate_v4_to_v5_value(raw)?;
            migrate_v5_to_v6(v5)?
        }
        5 => migrate_v5_to_v6(raw)?,
        6 => serde_json::from_value::<Project>(raw)
            .map_err(|e| format!("Failed to parse v6 project: {}", e))?,
        _ => {
            return Err(format!(
                "Unknown project schema version {} (this app supports v1–v6)",
                version
            ));
        }
    };

    // Task 080 + 100 backfill. Read-time only — disk is untouched until the
    // next `save_project` (auto-save fires within ~1s of any mutation). Two
    // cases:
    //
    //   1. Outer `layouts` absent (pre-080 v4 bundles, all v1–v3 bundles
    //      after migration): seed all three aspects from
    //      `Project::default`'s shape. 080 only seeded 9:16; 100 expands
    //      this because the matrix is fully exercised end-to-end and the
    //      configurator (110) will mutate any aspect.
    //
    //   2. Outer `layouts` present but individual aspect entries are null
    //      *and* this is a pre-100 bundle: seed 4_5 / 16_9 with the default
    //      PiP starter. Pre-100 users had no UI to clear an aspect to null,
    //      so a null entry on a pre-100 bundle is just unseeded state;
    //      filling it brings the bundle up to the post-100 shape. 9_16 is
    //      not auto-seeded here — pre-080 bundles get it via case (1), and a
    //      pre-100 bundle with an explicit `9_16: null` is an edge-case
    //      hand-edit we preserve for safety.
    //
    //   3. Post-100 bundles (`selected_export_aspect` field present): null
    //      aspect entries are user intent — the configurator UI lets the
    //      user clear an aspect, and re-seeding on every load would
    //      override that. Skip the per-aspect backfill entirely.
    if project.layouts.is_none() {
        project.layouts = Some(seeded_layouts());
    } else if is_pre_100 {
        if let Some(layouts) = project.layouts.as_mut() {
            if layouts.aspect_4_5.is_none() {
                layouts.aspect_4_5 = Some(default_pip_layout(AspectRatio::FourFive));
            }
            if layouts.aspect_16_9.is_none() {
                layouts.aspect_16_9 = Some(default_pip_layout(AspectRatio::SixteenNine));
            }
        }
    }
    // `selected_export_aspect` itself is supplied by serde's `default`
    // annotation when missing — no manual backfill needed for that field.

    // Route is not persisted in project.json. Re-parse from the bundle's
    // route.gpx as the canonical source. Missing file → None.
    let route_path = dir.join("route.gpx");
    if route_path.exists() {
        project.route = Some(super::gpx::parse_gpx_internal(&route_path)?);
    }

    Ok(project)
}

/// v1 → v2 migration. v1 is the pre-camera-architecture shape: `route`
/// present in JSON, no `transition_feel`. Today this is effectively additive
/// (serde defaults handle the missing field), but the migration step exists
/// to make the version bump load-bearing for future shape changes. Returns
/// a Value rather than a Project so the caller can chain v2 → v3 without an
/// intermediate deserialize / reserialize round-trip.
fn migrate_v1_to_v2_value(mut raw: serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(obj) = raw.as_object_mut() {
        obj.insert("schema_version".into(), serde_json::Value::from(2u32));
    } else {
        return Err("v1 project root is not a JSON object".into());
    }
    Ok(raw)
}

/// Test/back-compat helper: v1 → v2 migration that returns a parsed
/// Project. Wraps `migrate_v1_to_v2_value` and finalizes via serde so
/// existing callers (and tests) keep working.
#[cfg(test)]
fn migrate_v1_to_v2(raw: serde_json::Value) -> Result<Project, String> {
    let v2 = migrate_v1_to_v2_value(raw)?;
    let mut project: Project = serde_json::from_value(v2)
        .map_err(|e| format!("Failed to parse v1 project: {}", e))?;
    project.schema_version = 2;
    Ok(project)
}

/// v2 → v3 migration. Purely additive: v3 introduces optional
/// `start_camera`, `default_entry_transition`, and per-clip
/// `entry_transition` fields, all of which deserialize as `None` when
/// absent thanks to `#[serde(default)]`. Returns a Value rather than a
/// Project so the caller can chain v3 → v4 without an intermediate
/// deserialize / reserialize round-trip — same shape as
/// `migrate_v1_to_v2_value`.
fn migrate_v2_to_v3_value(mut raw: serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(obj) = raw.as_object_mut() {
        obj.insert("schema_version".into(), serde_json::Value::from(3u32));
    } else {
        return Err("v2 project root is not a JSON object".into());
    }
    Ok(raw)
}

/// Test/back-compat helper: v2 → v3 migration that returns a parsed
/// Project. Wraps `migrate_v2_to_v3_value` and finalizes via serde.
#[cfg(test)]
fn migrate_v2_to_v3(raw: serde_json::Value) -> Result<Project, String> {
    let v3 = migrate_v2_to_v3_value(raw)?;
    let mut project: Project = serde_json::from_value(v3)
        .map_err(|e| format!("Failed to parse v2 project during v3 migration: {}", e))?;
    project.schema_version = 3;
    Ok(project)
}

/// v3 → v4 migration (value-form). Drops the placeholder `exports` array
/// (the field has always been a placeholder; no UI ever wrote it). Adds an
/// absent `layouts` field — existing v3 projects post-migration carry
/// `layouts: None` and the user reconfigures via the configurator UI in task
/// 110. Stamps `schema_version: 4`. Returns a Value so callers can chain
/// v4 → v5 without an intermediate deserialize / reserialize round-trip.
/// See `docs/export/tasks/050-layout-descriptor-types.md`.
fn migrate_v3_to_v4_value(mut raw: serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(obj) = raw.as_object_mut() {
        obj.remove("exports");
        obj.insert("schema_version".into(), serde_json::Value::from(4u32));
    } else {
        return Err("v3 project root is not a JSON object".into());
    }
    Ok(raw)
}

/// Test/back-compat helper: v3 → v4 migration that returns a parsed Project.
/// Wraps `migrate_v3_to_v4_value` and finalizes via serde, stamping the
/// in-memory `schema_version` at v4 (NOT `CURRENT_SCHEMA_VERSION`) so
/// existing tests still observe the per-step bump.
#[cfg(test)]
fn migrate_v3_to_v4(raw: serde_json::Value) -> Result<Project, String> {
    let v4 = migrate_v3_to_v4_value(raw)?;
    let mut project: Project = serde_json::from_value(v4)
        .map_err(|e| format!("Failed to parse v3 project during v4 migration: {}", e))?;
    project.schema_version = 4;
    Ok(project)
}

/// v4 → v5 migration (value-form). Purely additive: v5 introduced
/// `last_export_selection` (flat `{ aspects, channels, output_dir }` shape).
/// The field has `#[serde(default)]` so absence deserializes as `None`. v6
/// later changed the shape; this step stamps v5 only — the v5→v6 step
/// handles the structural break.
fn migrate_v4_to_v5_value(mut raw: serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(obj) = raw.as_object_mut() {
        obj.insert("schema_version".into(), serde_json::Value::from(5u32));
    } else {
        return Err("v4 project root is not a JSON object".into());
    }
    Ok(raw)
}

/// Test/back-compat helper: v4 → v5 migration that returns a parsed
/// Project at v5. Stamps `schema_version: 5` rather than
/// `CURRENT_SCHEMA_VERSION` so per-step tests observe the per-step bump.
#[cfg(test)]
fn migrate_v4_to_v5(raw: serde_json::Value) -> Result<Project, String> {
    let v5 = migrate_v4_to_v5_value(raw)?;
    let mut project: Project = serde_json::from_value(v5)
        .map_err(|e| format!("Failed to parse v4 project during v5 migration: {}", e))?;
    project.schema_version = 5;
    Ok(project)
}

/// v5 → v6 migration. v6 replaces the flat `last_export_selection` shape
/// (`{ aspects, channels, output_dir }`) with the per-cell `ExportGrid`
/// (`{ cells, output_dir }`). The two shapes are structurally incompatible:
/// the flat selection conveys "every aspect × every channel is enabled"
/// without per-cell chip configuration (`quality`, `fps`), and there's no
/// deterministic way to invent chip configs that match the user's intent.
/// So this migration **drops** any v5 `last_export_selection` value rather
/// than transforming it — users re-configure their grid on first open
/// post-upgrade. The cost is minor (a few seconds re-clicking); the
/// alternative would carry a versioning-shim type that lingers indefinitely.
fn migrate_v5_to_v6(mut raw: serde_json::Value) -> Result<Project, String> {
    if let Some(obj) = raw.as_object_mut() {
        // Drop the v5 flat shape — incompatible with the v6 grid type and
        // not safely transformable.
        obj.remove("last_export_selection");
        obj.insert(
            "schema_version".into(),
            serde_json::Value::from(CURRENT_SCHEMA_VERSION),
        );
    } else {
        return Err("v5 project root is not a JSON object".into());
    }
    let mut project: Project = serde_json::from_value(raw)
        .map_err(|e| format!("Failed to parse v5 project during v6 migration: {}", e))?;
    project.schema_version = CURRENT_SCHEMA_VERSION;
    Ok(project)
}

/// Rename a project by updating its name in project.json
#[tauri::command]
pub fn rename_project(project_dir: String, new_name: String) -> Result<(), String> {
    let project_json = Path::new(&project_dir).join("project.json");
    let content = std::fs::read_to_string(&project_json)
        .map_err(|e| format!("Failed to read project: {}", e))?;
    let mut project: Project = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse project: {}", e))?;

    project.name = new_name;

    let json = serde_json::to_string_pretty(&project)
        .map_err(|e| format!("Failed to serialize project: {}", e))?;
    std::fs::write(&project_json, json)
        .map_err(|e| format!("Failed to write project: {}", e))?;

    // Update recent projects entry
    super::recent::register_recent_project(project_dir)?;

    Ok(())
}

/// Delete a project directory and remove it from recent projects
#[tauri::command]
pub fn delete_project(project_dir: String) -> Result<(), String> {
    let dir = Path::new(&project_dir);
    if dir.exists() {
        std::fs::remove_dir_all(dir)
            .map_err(|e| format!("Failed to delete project: {}", e))?;
    }

    // Remove from recent projects
    let path = crate::util::fs::recent_projects_path()?;
    if path.exists() {
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        let mut projects: Vec<RecentProject> = serde_json::from_str(&content).unwrap_or_default();
        projects.retain(|p| p.path != project_dir);
        let json = serde_json::to_string_pretty(&projects)
            .map_err(|e| format!("Failed to serialize recent projects: {}", e))?;
        std::fs::write(&path, json)
            .map_err(|e| format!("Failed to write recent projects: {}", e))?;
    }

    Ok(())
}

/// Resolve an export output directory under `base`, auto-numbering when the
/// chosen `name` already exists on disk. Returns a path the caller can show
/// to the user; the directory is **not** created — the renderer creates it
/// later. The probe runs at modal-open and again at render-time (GAP-004).
///
/// Strategy: try `{base}/{name}` first. If it exists, try
/// `{base}/{name} 2`, `{base}/{name} 3`, …, stopping at the first path that
/// doesn't exist on disk. Iteration is bounded to keep a runaway directory
/// (10k+ siblings) from hanging the modal — falls back to a millisecond-
/// suffixed name beyond `MAX_AUTO_INDEX`.
///
/// Inputs:
/// - `base`: parent directory (e.g. `~/Movies/TrailCut`). Tilde is **not**
///   expanded — the frontend resolves it before invoking. Must be absolute.
/// - `name`: leaf name to start from (typically the project name verbatim).
#[tauri::command]
pub fn resolve_output_dir(base: String, name: String) -> Result<String, String> {
    const MAX_AUTO_INDEX: u32 = 1_000;
    let base_path = Path::new(&base);
    if !base_path.is_absolute() {
        return Err(format!(
            "resolve_output_dir: base must be absolute, got {base:?}"
        ));
    }
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("resolve_output_dir: name must be non-empty".into());
    }
    let first = base_path.join(trimmed);
    if !first.exists() {
        return Ok(first.to_string_lossy().into_owned());
    }
    for i in 2..=MAX_AUTO_INDEX {
        let candidate = base_path.join(format!("{trimmed} {i}"));
        if !candidate.exists() {
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }
    // Pathological fallback: every numbered slot below MAX_AUTO_INDEX is
    // taken. Use a timestamp suffix so the export still proceeds.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(base_path
        .join(format!("{trimmed} {stamp}"))
        .to_string_lossy()
        .into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A v1 project on disk: no `schema_version`, no `transition_feel`,
    /// `route` field present, legacy `exports` array present.
    const V1_PROJECT_JSON: &str = r#"{
        "version": 1,
        "name": "Old Project",
        "thumbnail": null,
        "clips": [],
        "route": null,
        "exports": [],
        "map_settings": null
    }"#;

    #[test]
    fn v1_loads_with_default_schema_version_1() {
        let raw: serde_json::Value = serde_json::from_str(V1_PROJECT_JSON).unwrap();
        let version = raw
            .get("schema_version")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32)
            .unwrap_or(1);
        assert_eq!(version, 1, "missing schema_version must default to 1");
    }

    #[test]
    fn migrate_v1_to_v2_lifts_schema_version() {
        let raw: serde_json::Value = serde_json::from_str(V1_PROJECT_JSON).unwrap();
        let project = migrate_v1_to_v2(raw).expect("v1 project must migrate cleanly");
        assert_eq!(project.schema_version, 2);
        assert!(project.transition_feel.is_none());
        assert_eq!(project.name, "Old Project");
    }

    /// A v3 project on disk: post-camera-architecture, optional
    /// compiled-timeline authoring fields can be present, and the legacy
    /// `exports: [...]` placeholder may carry residual data we must drop.
    const V3_PROJECT_JSON: &str = r#"{
        "schema_version": 3,
        "version": 1,
        "name": "V3 Project",
        "thumbnail": null,
        "clips": [],
        "exports": [{
            "name": "legacy",
            "aspect_ratio": "9:16",
            "resolution": { "width": 1080, "height": 1920 },
            "layout": { "video_pct": 70, "map_position": "bottom-right", "map_visible": "always" },
            "codec": "h264",
            "quality": "high"
        }],
        "map_settings": null,
        "transition_feel": "snappy"
    }"#;

    #[test]
    fn migrate_v3_to_v4_drops_exports_and_stamps_schema() {
        let raw: serde_json::Value = serde_json::from_str(V3_PROJECT_JSON).unwrap();
        let project = migrate_v3_to_v4(raw).expect("v3 project must migrate cleanly");
        // Per-step migration helper stamps v4 specifically, not
        // `CURRENT_SCHEMA_VERSION` — the chained `load_project` path is what
        // walks all the way up to the latest schema.
        assert_eq!(project.schema_version, 4);
        // Original fields preserved.
        assert_eq!(project.name, "V3 Project");
        assert!(matches!(project.transition_feel, Some(TransitionFeel::Snappy)));
        // New v4 field defaults to None — the configurator UI (110) is the
        // first writer.
        assert!(project.layouts.is_none());
    }

    /// A v2 project on disk: post-camera-architecture, schema_version: 2,
    /// optional `transition_feel` set, no compiled-timeline authoring fields.
    const V2_PROJECT_JSON: &str = r#"{
        "schema_version": 2,
        "version": 1,
        "name": "Mid Project",
        "thumbnail": null,
        "clips": [],
        "exports": [],
        "map_settings": null,
        "transition_feel": "snappy"
    }"#;

    #[test]
    fn migrate_v2_to_v3_is_purely_additive() {
        let raw: serde_json::Value = serde_json::from_str(V2_PROJECT_JSON).unwrap();
        let project = migrate_v2_to_v3(raw).expect("v2 project must migrate cleanly");
        assert_eq!(project.schema_version, 3);
        // Original fields preserved.
        assert_eq!(project.name, "Mid Project");
        assert!(matches!(project.transition_feel, Some(TransitionFeel::Snappy)));
        // New v3 fields default to None.
        assert!(project.start_camera.is_none());
        assert!(project.default_entry_transition.is_none());
    }

    #[test]
    fn save_then_load_round_trip_writes_current_schema() {
        let dir = std::env::temp_dir().join(format!(
            "trailcut-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&dir).unwrap();

        // Seed the bundle with a v1-shaped project.json (exercises the
        // full chained v1 → … → CURRENT path).
        std::fs::write(dir.join("project.json"), V1_PROJECT_JSON).unwrap();

        let dir_str = dir.to_string_lossy().into_owned();
        let loaded = load_project(dir_str.clone()).expect("load v1 must succeed");
        assert_eq!(
            loaded.schema_version, CURRENT_SCHEMA_VERSION,
            "load must surface migrated CURRENT schema in memory"
        );
        assert!(loaded.start_camera.is_none());
        assert!(loaded.default_entry_transition.is_none());
        // 100 backfill: a v1 file pre-dates layouts entirely; load brings it
        // to the seeded shape (all three aspects populated). 080's "9:16
        // only" behavior was retired now that the export matrix is paved.
        let layouts = loaded
            .layouts
            .as_ref()
            .expect("layouts must be backfilled on load");
        assert!(layouts.aspect_9_16.is_some());
        assert!(layouts.aspect_4_5.is_some(), "100: 4:5 also seeded");
        assert!(layouts.aspect_16_9.is_some(), "100: 16:9 also seeded");
        // selected_export_aspect comes from serde's default annotation since
        // a v1 bundle has no field for it.
        assert!(matches!(
            loaded.selected_export_aspect,
            AspectRatio::NineSixteen
        ));

        save_project(loaded, dir_str.clone()).expect("save must succeed");

        // After save, the on-disk file is at CURRENT schema and has no top-level
        // `route` or `exports`.
        let on_disk = std::fs::read_to_string(dir.join("project.json")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&on_disk).unwrap();
        assert_eq!(
            parsed.get("schema_version").and_then(|v| v.as_u64()),
            Some(CURRENT_SCHEMA_VERSION as u64),
            "save must write schema_version: CURRENT_SCHEMA_VERSION"
        );
        assert!(
            parsed.get("route").is_none(),
            "save must omit the `route` key (re-parsed from route.gpx on load)"
        );
        assert!(
            parsed.get("exports").is_none(),
            "save must omit the legacy `exports` key (dropped at v3→v4)"
        );
        // Empty options stay omitted from the on-disk JSON.
        assert!(parsed.get("start_camera").is_none());
        assert!(parsed.get("default_entry_transition").is_none());
        // 100: backfilled layouts are persisted on the next save with all
        // three aspects populated.
        let on_disk_layouts = parsed
            .get("layouts")
            .expect("save must persist backfilled layouts");
        assert!(on_disk_layouts.get("9_16").is_some());
        assert!(on_disk_layouts.get("4_5").is_some(), "100: 4:5 persists");
        assert!(on_disk_layouts.get("16_9").is_some(), "100: 16:9 persists");
        // selected_export_aspect persists on save (always serialized; no
        // skip_serializing_if).
        assert_eq!(
            parsed
                .get("selected_export_aspect")
                .and_then(|v| v.as_str()),
            Some("9_16"),
        );

        // Reload — the round-trip must keep the schema at CURRENT.
        let reloaded = load_project(dir_str).expect("reload at CURRENT must succeed");
        assert_eq!(reloaded.schema_version, CURRENT_SCHEMA_VERSION);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn v3_project_with_legacy_exports_migrates_to_v4_on_load() {
        let dir = std::env::temp_dir().join(format!(
            "trailcut-test-{}-{}-v3load",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("project.json"), V3_PROJECT_JSON).unwrap();

        let dir_str = dir.to_string_lossy().into_owned();
        let loaded = load_project(dir_str.clone()).expect("load v3 must succeed");
        assert_eq!(loaded.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(loaded.name, "V3 Project");
        // 080 backfill applies to v3-migrated bundles too — the v3→v4
        // migration leaves `layouts: None`, then the post-load backfill seeds.
        assert!(loaded.layouts.is_some());

        // Save round-trip drops the legacy exports field on disk.
        save_project(loaded, dir_str.clone()).expect("save must succeed");
        let on_disk = std::fs::read_to_string(dir.join("project.json")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&on_disk).unwrap();
        assert!(
            parsed.get("exports").is_none(),
            "v3→v4 migration must drop the legacy exports key from on-disk JSON"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn v4_project_round_trips_with_layouts() {
        use crate::export::layout::{default_layout, AspectRatio, ProjectLayouts};

        let dir = std::env::temp_dir().join(format!(
            "trailcut-test-{}-{}-v4layouts",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&dir).unwrap();

        // Mirror 080's "user has cleared 4:5 / 16:9" shape, but as a post-100
        // bundle (selected_export_aspect comes from `Project::default`). The
        // post-100 backfill rule preserves the explicit nulls — that's the
        // user-intent contract.
        let project = Project {
            schema_version: CURRENT_SCHEMA_VERSION,
            layouts: Some(ProjectLayouts {
                aspect_9_16: Some(default_layout(AspectRatio::NineSixteen)),
                aspect_4_5: None,
                aspect_16_9: None,
            }),
            ..Project::default()
        };

        let dir_str = dir.to_string_lossy().into_owned();
        save_project(project.clone(), dir_str.clone()).expect("save must succeed");
        let reloaded = load_project(dir_str).expect("reload must succeed");
        assert_eq!(reloaded.schema_version, CURRENT_SCHEMA_VERSION);
        let layouts = reloaded.layouts.expect("layouts must round-trip");
        assert!(layouts.aspect_9_16.is_some());
        // Post-100 user-intent contract: nulls survive when
        // `selected_export_aspect` is present in the on-disk file.
        assert!(
            layouts.aspect_4_5.is_none(),
            "post-100 explicit null must survive"
        );
        assert!(
            layouts.aspect_16_9.is_none(),
            "post-100 explicit null must survive"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn selected_export_aspect_round_trips() {
        // 100: the project carries the user's choice of "this video targets
        // 9:16 / 4:5 / 16:9" so opening a `.trailcut` preserves the authoring
        // context. Mutate the field, save, reload — value persists.
        use crate::export::layout::AspectRatio;

        let dir = std::env::temp_dir().join(format!(
            "trailcut-test-{}-{}-selectedaspect",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let project = Project {
            selected_export_aspect: AspectRatio::FourFive,
            ..Project::default()
        };

        let dir_str = dir.to_string_lossy().into_owned();
        save_project(project, dir_str.clone()).expect("save must succeed");
        let reloaded = load_project(dir_str).expect("reload must succeed");
        assert!(matches!(
            reloaded.selected_export_aspect,
            AspectRatio::FourFive
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn selected_export_aspect_defaults_when_absent_on_disk() {
        // Pre-100 bundles lack `selected_export_aspect`; serde's
        // `default = "default_selected_aspect"` annotation supplies 9_16 on
        // deserialize without any explicit backfill code.
        let raw = r#"{
            "schema_version": 4,
            "version": 1,
            "name": "Pre-100 v4 Project",
            "thumbnail": null,
            "clips": [],
            "map_settings": null
        }"#;
        let parsed: Project = serde_json::from_str(raw).expect("must deserialize");
        assert!(matches!(
            parsed.selected_export_aspect,
            AspectRatio::NineSixteen
        ));
    }

    #[test]
    fn v2_project_loads_as_v4_in_memory() {
        let dir = std::env::temp_dir().join(format!(
            "trailcut-test-{}-{}-v2load",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("project.json"), V2_PROJECT_JSON).unwrap();

        let dir_str = dir.to_string_lossy().into_owned();
        let loaded = load_project(dir_str).expect("load v2 must succeed");
        assert_eq!(loaded.schema_version, CURRENT_SCHEMA_VERSION);
        assert!(matches!(loaded.transition_feel, Some(TransitionFeel::Snappy)));
        assert_eq!(loaded.name, "Mid Project");
        // 080 backfill: v2 bundles also surface in memory with seeded layouts.
        assert!(loaded.layouts.is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_repopulates_route_from_route_gpx() {
        let dir = std::env::temp_dir().join(format!(
            "trailcut-test-{}-{}-route",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&dir).unwrap();

        // v1 project.json with an obsolete inline route — should be ignored
        // in favor of route.gpx.
        std::fs::write(dir.join("project.json"), V1_PROJECT_JSON).unwrap();

        // Minimal valid GPX with two trackpoints.
        let gpx = r#"<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="trailcut-test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><trkseg>
    <trkpt lat="37.7749" lon="-122.4194"><ele>10</ele><time>2026-04-04T12:00:00Z</time></trkpt>
    <trkpt lat="37.7750" lon="-122.4195"><ele>11</ele><time>2026-04-04T12:00:30Z</time></trkpt>
  </trkseg></trk>
</gpx>"#;
        std::fs::write(dir.join("route.gpx"), gpx).unwrap();

        let dir_str = dir.to_string_lossy().into_owned();
        let loaded = load_project(dir_str).expect("load with route.gpx must succeed");
        let route = loaded.route.expect("route must be populated from route.gpx");
        assert_eq!(route.trackpoints.len(), 2);
        assert_eq!(route.format, "gpx");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_default_seeds_all_three_aspects() {
        // 100: Project::default() now seeds every aspect (080's "9:16 only"
        // rule retired). The configurator (110) can mutate any aspect freely;
        // shipping a starter for each is "the value the configurator opens
        // with," not "an aesthetic imposition." selected_export_aspect
        // defaults to 9:16.
        use crate::export::layout::{resolve_slots, AspectRatio};
        use crate::export::resolution::OutputResolution;

        let project = Project::default();
        let layouts = project
            .layouts
            .expect("Project::default must seed layouts");
        assert!(matches!(
            project.selected_export_aspect,
            AspectRatio::NineSixteen
        ));

        let aspects = [
            (AspectRatio::NineSixteen, &layouts.aspect_9_16),
            (AspectRatio::FourFive, &layouts.aspect_4_5),
            (AspectRatio::SixteenNine, &layouts.aspect_16_9),
        ];
        for (aspect, slot) in aspects {
            let layout = slot.as_ref().unwrap_or_else(|| {
                panic!("{:?} must be seeded by Project::default", aspect)
            });
            // Non-degenerate slot rect — guards against a future refactor
            // that accidentally seeds the wrong shape.
            let slots = resolve_slots(layout, aspect, OutputResolution::default());
            assert!(slots.map_slot.w > 0 && slots.map_slot.h > 0);
            assert!(slots.video_slot.w > 0 && slots.video_slot.h > 0);
        }
    }

    #[test]
    fn load_backfills_layouts_for_v4_with_null_layouts_field() {
        // A v4 project on disk that pre-dates 080: the field exists in the
        // schema (since 050) but the producer didn't seed it. Load must
        // surface it as Some(seeded). 100 expands the seeded shape from
        // "9:16 only" to "all three aspects".
        let dir = std::env::temp_dir().join(format!(
            "trailcut-test-{}-{}-v4backfill",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&dir).unwrap();

        // Explicit `"layouts": null` rather than absent — exercises the
        // None-after-deserialize path the backfill is designed to fix.
        let v4_null_layouts = r#"{
            "schema_version": 4,
            "version": 1,
            "name": "Pre-080 v4 Project",
            "thumbnail": null,
            "clips": [],
            "layouts": null,
            "map_settings": null
        }"#;
        std::fs::write(dir.join("project.json"), v4_null_layouts).unwrap();

        let dir_str = dir.to_string_lossy().into_owned();
        let loaded = load_project(dir_str).expect("load v4 with null layouts must succeed");
        assert_eq!(loaded.schema_version, CURRENT_SCHEMA_VERSION);
        let layouts = loaded
            .layouts
            .expect("backfill must populate layouts on load");
        assert!(layouts.aspect_9_16.is_some(), "9:16 must be seeded");
        assert!(layouts.aspect_4_5.is_some(), "100: 4:5 also seeded");
        assert!(layouts.aspect_16_9.is_some(), "100: 16:9 also seeded");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_seeds_missing_aspects_on_pre_100_bundle() {
        // 100 pre-100 detection: a bundle with `layouts` present but 4_5 /
        // 16_9 entries null *and* no `selected_export_aspect` field is a
        // pre-100 / post-080 bundle. The backfill seeds the missing aspect
        // entries (so editors and the configurator UI open with usable
        // starters) while preserving the existing 9_16.
        let dir = std::env::temp_dir().join(format!(
            "trailcut-test-{}-{}-pre100seed",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let pre_100 = r#"{
            "schema_version": 4,
            "version": 1,
            "name": "Pre-100 / Post-080 Project",
            "thumbnail": null,
            "clips": [],
            "layouts": {
                "9_16": {
                    "mode": "pip",
                    "inset_source": "map",
                    "inset": { "x": 0.65, "y": 0.78, "w": 0.32, "h": 0.18 },
                    "corner_radius": 0.012
                }
            },
            "map_settings": null
        }"#;
        std::fs::write(dir.join("project.json"), pre_100).unwrap();

        let dir_str = dir.to_string_lossy().into_owned();
        let loaded = load_project(dir_str).expect("load must succeed");
        let layouts = loaded.layouts.expect("layouts must be present");
        assert!(layouts.aspect_9_16.is_some());
        assert!(
            layouts.aspect_4_5.is_some(),
            "pre-100 bundle: 4:5 backfilled"
        );
        assert!(
            layouts.aspect_16_9.is_some(),
            "pre-100 bundle: 16:9 backfilled"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_preserves_post_100_user_cleared_aspects() {
        // 100 post-100 contract: a bundle with `selected_export_aspect`
        // present is post-100. Null aspect entries inside `layouts` are user
        // intent (set via a future configurator affordance). The backfill
        // must NOT re-seed them — that would override the user's choice
        // every time they reopen the project.
        let dir = std::env::temp_dir().join(format!(
            "trailcut-test-{}-{}-post100keep",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let post_100_user_cleared = r#"{
            "schema_version": 4,
            "version": 1,
            "name": "Post-100 user-cleared",
            "thumbnail": null,
            "clips": [],
            "layouts": {
                "9_16": {
                    "mode": "pip",
                    "inset_source": "map",
                    "inset": { "x": 0.65, "y": 0.78, "w": 0.32, "h": 0.18 },
                    "corner_radius": 0.012
                },
                "4_5": null,
                "16_9": null
            },
            "selected_export_aspect": "9_16",
            "map_settings": null
        }"#;
        std::fs::write(dir.join("project.json"), post_100_user_cleared).unwrap();

        let dir_str = dir.to_string_lossy().into_owned();
        let loaded = load_project(dir_str).expect("load must succeed");
        let layouts = loaded.layouts.expect("layouts must be present");
        assert!(layouts.aspect_9_16.is_some());
        assert!(
            layouts.aspect_4_5.is_none(),
            "post-100 explicit null must survive"
        );
        assert!(
            layouts.aspect_16_9.is_none(),
            "post-100 explicit null must survive"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_does_not_overwrite_disk_when_backfilling_layouts() {
        // The backfill is read-time only: the in-memory project is normalized,
        // but the on-disk file is untouched until save_project runs. A user
        // who opens a project and immediately closes it without any edits
        // leaves disk as-is — important because it makes load a non-side-
        // effecting operation tests and tooling can rely on.
        let dir = std::env::temp_dir().join(format!(
            "trailcut-test-{}-{}-v4noskew",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let v4_null_layouts = r#"{
            "schema_version": 4,
            "version": 1,
            "name": "Pre-080 v4 Project",
            "thumbnail": null,
            "clips": [],
            "layouts": null,
            "map_settings": null
        }"#;
        let json_path = dir.join("project.json");
        std::fs::write(&json_path, v4_null_layouts).unwrap();
        let pre_load_bytes = std::fs::read(&json_path).unwrap();

        let dir_str = dir.to_string_lossy().into_owned();
        let _loaded = load_project(dir_str).expect("load must succeed");

        let post_load_bytes = std::fs::read(&json_path).unwrap();
        assert_eq!(
            pre_load_bytes, post_load_bytes,
            "load_project must not write to disk when backfilling layouts"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_pre_100_inner_nulls_seeds_4_5_and_16_9_only() {
        // Edge case: a pre-100 bundle (no `selected_export_aspect`) with all
        // three aspects null. Pre-100 had no UI to clear 9_16 to null, so an
        // explicit `9_16: null` is treated as a hand-edit — the conservative
        // rule preserves it (don't second-guess hand edits). The pre-100
        // backfill seeds 4_5 / 16_9 only, which were always-null on pre-080
        // bundles.
        let dir = std::env::temp_dir().join(format!(
            "trailcut-test-{}-{}-v4innernull",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let v4_inner_nulls = r#"{
            "schema_version": 4,
            "version": 1,
            "name": "Pre-100 hand-edited",
            "thumbnail": null,
            "clips": [],
            "layouts": { "9_16": null, "4_5": null, "16_9": null },
            "map_settings": null
        }"#;
        std::fs::write(dir.join("project.json"), v4_inner_nulls).unwrap();

        let dir_str = dir.to_string_lossy().into_owned();
        let loaded = load_project(dir_str).expect("load must succeed");
        let layouts = loaded.layouts.expect("layouts must be present");
        assert!(
            layouts.aspect_9_16.is_none(),
            "explicit 9_16 null preserved (hand-edit / pre-080 conservative rule)"
        );
        assert!(
            layouts.aspect_4_5.is_some(),
            "pre-100 backfill seeds 4_5"
        );
        assert!(
            layouts.aspect_16_9.is_some(),
            "pre-100 backfill seeds 16_9"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_v4_bundle_loads_with_none_last_export_selection() {
        // v4 bundles on disk lack the `last_export_selection` field. The
        // chained v4 → v5 → v6 migration is purely additive on this field —
        // load must succeed and surface `None` without error.
        let dir = std::env::temp_dir().join(format!(
            "trailcut-test-{}-{}-v4nolastexport",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let v4_no_export_selection = r#"{
            "schema_version": 4,
            "version": 1,
            "name": "Pre-grid v4 Project",
            "thumbnail": null,
            "clips": [],
            "selected_export_aspect": "9_16",
            "map_settings": null
        }"#;
        std::fs::write(dir.join("project.json"), v4_no_export_selection).unwrap();

        let dir_str = dir.to_string_lossy().into_owned();
        let loaded = load_project(dir_str).expect("v4 → v6 load must succeed");
        assert_eq!(loaded.schema_version, CURRENT_SCHEMA_VERSION);
        assert!(
            loaded.last_export_selection.is_none(),
            "pre-grid bundle must surface None for last_export_selection"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrate_v5_to_v6_drops_flat_export_selection() {
        // The flat v5 shape (`{ aspects, channels, output_dir }`) is
        // structurally incompatible with the v6 `ExportGrid` shape
        // (`{ cells, output_dir }`). The migration must drop the value
        // rather than crashing on the unknown variant. Users re-configure
        // the grid on first open post-upgrade.
        let v5_with_flat_selection = serde_json::json!({
            "schema_version": 5,
            "version": 1,
            "name": "v5 with prior export selection",
            "thumbnail": null,
            "clips": [],
            "selected_export_aspect": "9_16",
            "map_settings": null,
            "last_export_selection": {
                "aspects": ["9_16", "16_9"],
                "channels": ["composite", "video_only"],
                "output_dir": "/Users/u/Movies/Hike"
            }
        });
        let project = migrate_v5_to_v6(v5_with_flat_selection)
            .expect("v5 → v6 migration must succeed when flat selection is present");
        assert_eq!(project.schema_version, CURRENT_SCHEMA_VERSION);
        assert!(
            project.last_export_selection.is_none(),
            "v5 → v6 must drop the incompatible flat last_export_selection value"
        );
    }

    #[test]
    fn load_v5_bundle_with_flat_export_selection_loads_at_v6() {
        // End-to-end variant of the previous test: a v5 bundle on disk
        // with a populated flat `last_export_selection` must load through
        // the chained migration to v6 without error, with the field
        // dropped on the way.
        let dir = std::env::temp_dir().join(format!(
            "trailcut-test-{}-{}-v5flat",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let v5_with_flat = r#"{
            "schema_version": 5,
            "version": 1,
            "name": "v5 flat",
            "thumbnail": null,
            "clips": [],
            "selected_export_aspect": "9_16",
            "map_settings": null,
            "last_export_selection": {
                "aspects": ["9_16"],
                "channels": ["composite"],
                "output_dir": "/Users/u/out"
            }
        }"#;
        std::fs::write(dir.join("project.json"), v5_with_flat).unwrap();

        let dir_str = dir.to_string_lossy().into_owned();
        let loaded = load_project(dir_str).expect("v5 → v6 load must succeed");
        assert_eq!(loaded.schema_version, CURRENT_SCHEMA_VERSION);
        assert!(loaded.last_export_selection.is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_succeeds_when_route_gpx_missing() {
        let dir = std::env::temp_dir().join(format!(
            "trailcut-test-{}-{}-noroute",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("project.json"), V1_PROJECT_JSON).unwrap();

        let dir_str = dir.to_string_lossy().into_owned();
        let loaded = load_project(dir_str).expect("load without route.gpx must succeed");
        assert!(loaded.route.is_none(), "missing route.gpx → route is None");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Unique-per-invocation scratch directory under `std::env::temp_dir()`.
    /// Each test that touches the filesystem must use its own subdir so
    /// parallel `cargo test` runs don't trip over each other.
    fn scratch_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "trailcut-resolve-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolve_output_dir_returns_first_when_no_collision() {
        let base = scratch_dir("no-collision");
        let base_str = base.to_string_lossy().into_owned();
        let got = resolve_output_dir(base_str, "Cascade Pass".into())
            .expect("resolve must succeed");
        assert_eq!(got, base.join("Cascade Pass").to_string_lossy());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn resolve_output_dir_increments_when_name_exists() {
        let base = scratch_dir("collision");
        std::fs::create_dir_all(base.join("Cascade Pass")).unwrap();
        let base_str = base.to_string_lossy().into_owned();
        let got = resolve_output_dir(base_str, "Cascade Pass".into())
            .expect("resolve must succeed");
        // First collision → " 2", not " 1" (matches mockup affordance).
        assert_eq!(got, base.join("Cascade Pass 2").to_string_lossy());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn resolve_output_dir_skips_to_first_free_slot() {
        let base = scratch_dir("multi");
        std::fs::create_dir_all(base.join("Hike")).unwrap();
        std::fs::create_dir_all(base.join("Hike 2")).unwrap();
        std::fs::create_dir_all(base.join("Hike 3")).unwrap();
        let base_str = base.to_string_lossy().into_owned();
        let got = resolve_output_dir(base_str, "Hike".into()).expect("resolve must succeed");
        assert_eq!(got, base.join("Hike 4").to_string_lossy());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn resolve_output_dir_increments_on_file_collision_not_just_dir() {
        // "exists" probes any inode, not just directories — if the user has a
        // file at that path, we still want to advance. GAP-004 calls out the
        // probe runs again at render-time, so this also keeps the modal
        // surface honest about what render-time will see.
        let base = scratch_dir("file");
        std::fs::write(base.join("Trip"), b"sentinel").unwrap();
        let base_str = base.to_string_lossy().into_owned();
        let got = resolve_output_dir(base_str, "Trip".into()).expect("resolve must succeed");
        assert_eq!(got, base.join("Trip 2").to_string_lossy());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn resolve_output_dir_trims_whitespace_in_name() {
        let base = scratch_dir("ws");
        let base_str = base.to_string_lossy().into_owned();
        let got =
            resolve_output_dir(base_str, "  Padded Trip  ".into()).expect("resolve must succeed");
        assert_eq!(got, base.join("Padded Trip").to_string_lossy());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn resolve_output_dir_rejects_relative_base() {
        let err = resolve_output_dir("not/absolute".into(), "Hike".into())
            .expect_err("relative base must error");
        assert!(err.contains("absolute"));
    }

    #[test]
    fn resolve_output_dir_rejects_empty_name() {
        let base = scratch_dir("empty");
        let base_str = base.to_string_lossy().into_owned();
        let err = resolve_output_dir(base_str, "   ".into())
            .expect_err("empty name must error");
        assert!(err.contains("non-empty"));
        let _ = std::fs::remove_dir_all(&base);
    }
}
