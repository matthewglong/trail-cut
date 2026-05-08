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

    let mut project = match version {
        1 => {
            // Chain v1 → v2 → v3 → v4. Each step is value-level until the
            // final `from_value` so a partially-migrated bundle (e.g. an
            // interrupted save) reads through cleanly.
            let v2 = migrate_v1_to_v2_value(raw)?;
            let v3 = migrate_v2_to_v3_value(v2)?;
            migrate_v3_to_v4(v3)?
        }
        2 => {
            let v3 = migrate_v2_to_v3_value(raw)?;
            migrate_v3_to_v4(v3)?
        }
        3 => migrate_v3_to_v4(raw)?,
        4 => serde_json::from_value::<Project>(raw)
            .map_err(|e| format!("Failed to parse v4 project: {}", e))?,
        _ => {
            return Err(format!(
                "Unknown project schema version {} (this app supports v1–v4)",
                version
            ));
        }
    };

    // Task 080 backfill. Projects created between 050 (which added the
    // optional `layouts` field) and 080 carry `layouts: None` on disk; bring
    // them up to the seeded "9:16 only" shape on read so the editor and
    // export both have a real value to consume. Read-time only — disk is
    // untouched until the next `save_project` (auto-save fires within ~1s of
    // any mutation, so the gap is small in practice). Aspect-level nulls are
    // preserved: a user who explicitly clears one aspect via a future
    // configurator action keeps that null. The backfill only triggers when
    // the outer `layouts` field itself is absent.
    if project.layouts.is_none() {
        project.layouts = Some(seeded_layouts());
    }

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

/// v3 → v4 migration. Drops the placeholder `exports` array (the field has
/// always been a placeholder; no UI ever wrote it). Adds an absent `layouts`
/// field — existing v3 projects post-migration carry `layouts: None` and the
/// user reconfigures via the configurator UI in task 110. Stamps
/// `schema_version: 4`. See `docs/export/tasks/050-layout-descriptor-types.md`.
fn migrate_v3_to_v4(mut raw: serde_json::Value) -> Result<Project, String> {
    if let Some(obj) = raw.as_object_mut() {
        obj.remove("exports");
        obj.insert("schema_version".into(), serde_json::Value::from(4u32));
    } else {
        return Err("v3 project root is not a JSON object".into());
    }
    let mut project: Project = serde_json::from_value(raw)
        .map_err(|e| format!("Failed to parse v3 project during v4 migration: {}", e))?;
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
        assert_eq!(project.schema_version, CURRENT_SCHEMA_VERSION);
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
    fn save_then_load_round_trip_writes_v4() {
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
        // chained v1 → v2 → v3 → v4 path).
        std::fs::write(dir.join("project.json"), V1_PROJECT_JSON).unwrap();

        let dir_str = dir.to_string_lossy().into_owned();
        let loaded = load_project(dir_str.clone()).expect("load v1 must succeed");
        assert_eq!(
            loaded.schema_version, CURRENT_SCHEMA_VERSION,
            "load must surface migrated v4 in memory"
        );
        assert!(loaded.start_camera.is_none());
        assert!(loaded.default_entry_transition.is_none());
        // 080 backfill: a v1 file pre-dates layouts entirely; load brings it
        // to the seeded shape (9:16 populated, 4:5 / 16:9 still None).
        let layouts = loaded
            .layouts
            .as_ref()
            .expect("layouts must be backfilled on load");
        assert!(layouts.aspect_9_16.is_some());
        assert!(layouts.aspect_4_5.is_none());
        assert!(layouts.aspect_16_9.is_none());

        save_project(loaded, dir_str.clone()).expect("save must succeed");

        // After save, the on-disk file is v4 and has no top-level `route` or `exports`.
        let on_disk = std::fs::read_to_string(dir.join("project.json")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&on_disk).unwrap();
        assert_eq!(
            parsed.get("schema_version").and_then(|v| v.as_u64()),
            Some(4),
            "save must write schema_version: 4"
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
        // 080: backfilled layouts are persisted on the next save, with
        // unconfigured aspects still omitted via per-field skip_serializing_if.
        let on_disk_layouts = parsed
            .get("layouts")
            .expect("save must persist backfilled layouts");
        assert!(on_disk_layouts.get("9_16").is_some());
        assert!(on_disk_layouts.get("4_5").is_none());
        assert!(on_disk_layouts.get("16_9").is_none());

        // Reload — the round-trip must keep the schema at v4.
        let reloaded = load_project(dir_str).expect("reload v4 must succeed");
        assert_eq!(reloaded.schema_version, 4);

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
        assert_eq!(loaded.schema_version, 4);
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
        save_project(project.clone(), dir_str.clone()).expect("save v4 must succeed");
        let reloaded = load_project(dir_str).expect("reload v4 must succeed");
        assert_eq!(reloaded.schema_version, 4);
        let layouts = reloaded.layouts.expect("layouts must round-trip");
        assert!(layouts.aspect_9_16.is_some());
        assert!(layouts.aspect_4_5.is_none());
        assert!(layouts.aspect_16_9.is_none());

        let _ = std::fs::remove_dir_all(&dir);
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
        assert_eq!(loaded.schema_version, 4);
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
    fn project_default_seeds_9_16_layout() {
        // 080 turns Project::default() into the source of truth for "what
        // does a fresh project carry on disk." Aspect 9:16 must be populated;
        // 4:5 / 16:9 stay None until the user picks them in the configurator.
        use crate::export::layout::{resolve_slots, AspectRatio};

        let project = Project::default();
        let layouts = project
            .layouts
            .expect("Project::default must seed layouts (080)");
        let nine_sixteen = layouts
            .aspect_9_16
            .as_ref()
            .expect("9:16 must be seeded by default");
        assert!(layouts.aspect_4_5.is_none(), "4:5 stays None by default");
        assert!(layouts.aspect_16_9.is_none(), "16:9 stays None by default");

        // Non-degenerate slot rect — guards against a future refactor that
        // accidentally seeds the wrong shape (e.g., a zero-size inset).
        let slots = resolve_slots(nine_sixteen, AspectRatio::NineSixteen);
        assert_eq!(slots.output.w, 1080);
        assert_eq!(slots.output.h, 1920);
        assert!(slots.map_slot.w > 0 && slots.map_slot.h > 0);
        assert!(slots.video_slot.w > 0 && slots.video_slot.h > 0);
        assert!(slots.corner_radius_px > 0);
    }

    #[test]
    fn load_backfills_layouts_for_v4_with_null_layouts_field() {
        // A v4 project on disk that pre-dates 080: the field exists in the
        // schema (since 050) but the producer didn't seed it. Load must
        // surface it as Some(seeded). This is the core 080 backfill case.
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
        assert_eq!(loaded.schema_version, 4);
        let layouts = loaded
            .layouts
            .expect("backfill must populate layouts on load");
        assert!(layouts.aspect_9_16.is_some(), "9:16 must be seeded");
        assert!(layouts.aspect_4_5.is_none());
        assert!(layouts.aspect_16_9.is_none());

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
    fn load_preserves_explicit_aspect_nulls_inside_layouts() {
        // The backfill triggers when the outer `layouts` is None. If the
        // user has explicitly cleared individual aspects (or just hasn't
        // configured them yet) the inner nulls survive untouched. This guards
        // against a future "reset on every load" behavior — that's a
        // configurator UI feature, not load-side normalization.
        let dir = std::env::temp_dir().join(format!(
            "trailcut-test-{}-{}-v4innernull",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&dir).unwrap();

        // All three aspects null but the field itself is present — backfill
        // must NOT seed 9:16 in this case (different from `"layouts": null`).
        let v4_inner_nulls = r#"{
            "schema_version": 4,
            "version": 1,
            "name": "User-cleared layouts",
            "thumbnail": null,
            "clips": [],
            "layouts": { "9_16": null, "4_5": null, "16_9": null },
            "map_settings": null
        }"#;
        std::fs::write(dir.join("project.json"), v4_inner_nulls).unwrap();

        let dir_str = dir.to_string_lossy().into_owned();
        let loaded = load_project(dir_str).expect("load must succeed");
        let layouts = loaded.layouts.expect("layouts must be present");
        assert!(layouts.aspect_9_16.is_none(), "explicit null must survive");
        assert!(layouts.aspect_4_5.is_none());
        assert!(layouts.aspect_16_9.is_none());

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
}
