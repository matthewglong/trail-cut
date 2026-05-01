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
            // Chain v1 → v2 → v3. Each step is purely additive at this
            // point, so chaining is safe; future shape changes may collapse
            // into per-version `migrate_vN_to_vM` bodies.
            let v2 = migrate_v1_to_v2_value(raw)?;
            migrate_v2_to_v3(v2)?
        }
        2 => migrate_v2_to_v3(raw)?,
        3 => serde_json::from_value::<Project>(raw)
            .map_err(|e| format!("Failed to parse v3 project: {}", e))?,
        _ => {
            return Err(format!(
                "Unknown project schema version {} (this app supports v1, v2, and v3)",
                version
            ));
        }
    };

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
/// absent thanks to `#[serde(default)]`. We only need to lift the version
/// number on the JSON value before letting serde finalize it.
fn migrate_v2_to_v3(mut raw: serde_json::Value) -> Result<Project, String> {
    if let Some(obj) = raw.as_object_mut() {
        obj.insert("schema_version".into(), serde_json::Value::from(3u32));
    } else {
        return Err("v2 project root is not a JSON object".into());
    }
    let mut project: Project = serde_json::from_value(raw)
        .map_err(|e| format!("Failed to parse v2 project during v3 migration: {}", e))?;
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
    /// `route` field present.
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
        assert_eq!(project.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(project.schema_version, 3);
        // Original fields preserved.
        assert_eq!(project.name, "Mid Project");
        assert!(matches!(project.transition_feel, Some(TransitionFeel::Snappy)));
        // New v3 fields default to None.
        assert!(project.start_camera.is_none());
        assert!(project.default_entry_transition.is_none());
    }

    #[test]
    fn save_then_load_round_trip_writes_v3() {
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
        // chained v1 → v2 → v3 path).
        std::fs::write(dir.join("project.json"), V1_PROJECT_JSON).unwrap();

        let dir_str = dir.to_string_lossy().into_owned();
        let loaded = load_project(dir_str.clone()).expect("load v1 must succeed");
        assert_eq!(
            loaded.schema_version, CURRENT_SCHEMA_VERSION,
            "load must surface migrated v3 in memory"
        );
        assert!(loaded.start_camera.is_none());
        assert!(loaded.default_entry_transition.is_none());

        save_project(loaded, dir_str.clone()).expect("save must succeed");

        // After save, the on-disk file is v3 and has no top-level `route`.
        let on_disk = std::fs::read_to_string(dir.join("project.json")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&on_disk).unwrap();
        assert_eq!(
            parsed.get("schema_version").and_then(|v| v.as_u64()),
            Some(3),
            "save must write schema_version: 3"
        );
        assert!(
            parsed.get("route").is_none(),
            "save must omit the `route` key (re-parsed from route.gpx on load)"
        );
        // Empty options stay omitted from the on-disk JSON.
        assert!(parsed.get("start_camera").is_none());
        assert!(parsed.get("default_entry_transition").is_none());

        // Reload — the round-trip must keep the schema at v3.
        let reloaded = load_project(dir_str).expect("reload v3 must succeed");
        assert_eq!(reloaded.schema_version, 3);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn v2_project_loads_as_v3_in_memory() {
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
        assert_eq!(loaded.schema_version, 3);
        assert!(matches!(loaded.transition_feel, Some(TransitionFeel::Snappy)));
        assert_eq!(loaded.name, "Mid Project");

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
