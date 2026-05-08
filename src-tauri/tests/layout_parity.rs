// Layout parity test (task 050).
//
// Loads the shared fixture at `tests/fixtures/layout_parity.json` and asserts
// `resolve_slots` produces the listed `expected` output for each case. The
// TS test (`src/lib/__tests__/layout.test.ts`) consumes the same fixture and
// asserts the same expected output. Drift between the TS source-of-truth and
// the Rust mirror surfaces here as a per-case failure.
//
// Adding a new case is one PR touching one file; both ports pick it up.

use std::path::PathBuf;

use serde::Deserialize;
use trail_cut_lib::export::layout::{resolve_slots, AspectRatio, LayoutConfig, SlotResolution};

#[derive(Debug, Deserialize)]
struct FixtureCase {
    name: String,
    aspect: AspectRatio,
    layout: LayoutConfig,
    expected: SlotResolution,
}

#[derive(Debug, Deserialize)]
struct Fixture {
    #[allow(dead_code)]
    doc: String,
    cases: Vec<FixtureCase>,
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("layout_parity.json")
}

fn load_fixture() -> Fixture {
    let path = fixture_path();
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {:?}: {}", path, e));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {:?}: {}", path, e))
}

#[test]
fn resolve_slots_matches_shared_fixture() {
    let fixture = load_fixture();
    assert!(
        !fixture.cases.is_empty(),
        "fixture must contain at least one case"
    );
    for case in &fixture.cases {
        let got = resolve_slots(&case.layout, case.aspect);
        assert_eq!(got, case.expected, "case {} resolved to {:?}", case.name, got);
    }
}
