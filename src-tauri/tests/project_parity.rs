// Project wire-shape parity test (ship review Phase 2a, defect 3).
//
// Loads the shared fixture at `tests/fixtures/project_parity.json` — a full
// `Project` with EVERY persisted field populated and non-default — and pins
// the persistence contract from the Rust side:
//
//   1. `project_wire_shape_round_trips_every_field`: deserialize →
//      re-serialize must reproduce the fixture EXACTLY. A field the Rust
//      shape drops, renames, or silently defaults fails per-key.
//   2. `save_then_load_round_trip_preserves_fixture_fields`: the same
//      fixture pushed through the real `load_project` / `save_project`
//      commands (tempdir bundle, atomic write) must land on disk intact.
//
// The TS counterpart (`src/lib/__tests__/projectPersistence.test.ts`) loads
// the SAME fixture and asserts the canonical auto-save payload path
// (`hydrateProjectState` → `buildSavePayload`) reproduces it deep-equally —
// the exact regression class that silently erased `working_color_space` /
// `start_camera` / `default_entry_transition` (ship review §1.4a).
//
// Pattern copied from the layout gold standard (`layout_parity.json` +
// `layout_parity.rs` + `layout.test.ts`). Adding a persisted Project field
// = add it to the fixture (and the TS key map); both suites pick it up.
//
// Loud-failure contract: a missing or unparsable fixture PANICS — never a
// silent skip.

use std::path::PathBuf;

use trail_cut_lib::{load_project, save_project, Project, WorkingColorSpaceId, CURRENT_SCHEMA_VERSION};

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("project_parity.json")
}

fn load_fixture_project_value() -> serde_json::Value {
    let path = fixture_path();
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {:?}: {}", path, e));
    let fixture: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {:?}: {}", path, e));
    fixture
        .get("project")
        .unwrap_or_else(|| panic!("fixture {:?} must contain a `project` object", path))
        .clone()
}

/// `working_color_space` exception: the enum has a single variant today, so
/// `skip_serializing_if = "is_default_working_color_space"` ALWAYS drops it
/// on serialize. The fixture still carries it (the TS save path must forward
/// it), so the exact-equality comparisons below remove the key — after
/// asserting it holds the expected value. When a second working space lands,
/// point the fixture at the non-default value and DELETE this exception so
/// the field round-trips like every other.
fn strip_always_skipped_working_color_space(wire: &mut serde_json::Value) {
    let wcs = wire
        .as_object_mut()
        .expect("fixture project must be an object")
        .remove("working_color_space")
        .expect("fixture must populate working_color_space");
    assert_eq!(
        wcs,
        serde_json::json!("linear_bt2020_full"),
        "fixture working_color_space drifted from the single known variant"
    );
}

/// Per-key comparison so a regression names the lost field instead of
/// dumping two multi-hundred-line JSON blobs.
fn assert_same_fields(got: &serde_json::Value, expected: &serde_json::Value, context: &str) {
    let expected_obj = expected.as_object().expect("expected must be an object");
    let got_obj = got.as_object().expect("got must be an object");
    for (key, want) in expected_obj {
        assert_eq!(
            got_obj.get(key),
            Some(want),
            "{}: field `{}` was lost or mutated",
            context,
            key
        );
    }
    for key in got_obj.keys() {
        assert!(
            expected_obj.contains_key(key),
            "{}: unexpected extra field `{}` — add it to project_parity.json so it is covered",
            context,
            key
        );
    }
}

#[test]
fn fixture_is_authored_at_current_schema() {
    let wire = load_fixture_project_value();
    assert_eq!(
        wire.get("schema_version").and_then(|v| v.as_u64()),
        Some(CURRENT_SCHEMA_VERSION as u64),
        "project_parity.json must be re-authored at CURRENT_SCHEMA_VERSION so the \
         parity contract tracks the live wire shape (don't just bump the number — \
         populate any new fields too)"
    );
}

#[test]
fn project_wire_shape_round_trips_every_field() {
    let wire = load_fixture_project_value();

    let project: Project = serde_json::from_value(wire.clone())
        .unwrap_or_else(|e| panic!("fixture project must deserialize as models::Project: {}", e));
    assert_eq!(
        project.working_color_space,
        WorkingColorSpaceId::LinearBt2020Full,
        "deserialization must read the fixture's working_color_space"
    );

    let reserialized =
        serde_json::to_value(&project).expect("Project must serialize back to JSON");

    let mut expected = wire;
    strip_always_skipped_working_color_space(&mut expected);
    assert_same_fields(&reserialized, &expected, "serde round-trip");
}

#[test]
fn save_then_load_round_trip_preserves_fixture_fields() {
    let wire = load_fixture_project_value();

    let dir = std::env::temp_dir().join(format!(
        "trailcut-parity-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::fs::create_dir_all(&dir).expect("create temp bundle dir");
    std::fs::write(
        dir.join("project.json"),
        serde_json::to_string_pretty(&wire).unwrap(),
    )
    .expect("seed bundle with fixture project.json");

    let dir_str = dir.to_string_lossy().into_owned();
    let loaded = load_project(dir_str.clone()).expect("fixture bundle must load");
    save_project(loaded, dir_str).expect("save must succeed");

    let on_disk: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("project.json")).expect("read saved project.json"),
    )
    .expect("saved project.json must parse");

    let mut expected = wire;
    strip_always_skipped_working_color_space(&mut expected);
    // `save_project` intentionally clears `route` — the canonical copy lives
    // in the bundle's route.gpx, re-parsed on every load.
    expected
        .as_object_mut()
        .unwrap()
        .remove("route")
        .expect("fixture must populate route");

    assert_same_fields(&on_disk, &expected, "load_project → save_project round-trip");

    // Atomic-write hygiene: the temp file must have been renamed away.
    assert!(
        !dir.join(".project.json.tmp").exists(),
        "atomic save must not leave a temp file behind"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn project_deserializes_without_vestigial_version_field() {
    // The wire `version` field is meaningless (see models.rs) but used to be
    // mandatory — a payload without it hard-failed IPC deserialization. Pin
    // the serde default that retired that trap.
    let p: Project = serde_json::from_value(serde_json::json!({ "clips": [] }))
        .expect("a minimal project without `version` must deserialize");
    assert_eq!(p.version, 1);
}
