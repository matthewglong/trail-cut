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
use trail_cut_lib::export::layout::{
    canonical_map_viewport, resolve_slots, AspectRatio, LayoutConfig, SlotResolution,
};
use trail_cut_lib::export::resolution::OutputResolution;

#[derive(Debug, Deserialize)]
struct ExpectedCanonicalMapViewport {
    css_w: u32,
    css_h: u32,
    pixel_ratio: f64,
}

#[derive(Debug, Deserialize)]
struct FixtureCase {
    name: String,
    aspect: AspectRatio,
    #[serde(default)]
    resolution: OutputResolution,
    layout: LayoutConfig,
    expected: SlotResolution,
    /// Per-case expected output of `canonical_map_viewport(aspect, map_slot.w,
    /// map_slot.h)`. Float comparison uses an epsilon (`< 1e-9`) because
    /// legitimate non-integer ratios like 0.32037037... don't survive strict
    /// `f64` equality across JSON-round-trip.
    #[serde(default)]
    expected_canonical_map_viewport: Option<ExpectedCanonicalMapViewport>,
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
        let got = resolve_slots(&case.layout, case.aspect, case.resolution);
        assert_eq!(got, case.expected, "case {} resolved to {:?}", case.name, got);
    }
}

#[test]
fn canonical_map_viewport_matches_shared_fixture() {
    // Parity-anchored counterpart of `resolve_slots_matches_shared_fixture`.
    // For every case the TS test (`src/lib/__tests__/layout.test.ts`) runs
    // the same comparison against `canonicalMapViewport`; drift between the
    // ports surfaces as a per-case failure here AND there.
    let fixture = load_fixture();
    let mut covered = 0usize;
    for case in &fixture.cases {
        let Some(expected) = case.expected_canonical_map_viewport.as_ref() else {
            // Tolerated for forward-compat — new fixture cases can land
            // before being annotated. Existing cases all carry the field;
            // the count-check below catches regressions.
            continue;
        };
        covered += 1;
        let map_slot = case.expected.map_slot;
        let got = canonical_map_viewport(case.aspect, map_slot.w, map_slot.h, case.resolution);
        assert_eq!(
            got.css_w, expected.css_w,
            "case {} css_w: got {} expected {}",
            case.name, got.css_w, expected.css_w,
        );
        assert_eq!(
            got.css_h, expected.css_h,
            "case {} css_h: got {} expected {}",
            case.name, got.css_h, expected.css_h,
        );
        // Epsilon: pixel_ratio is a non-integer ratio like 0.32037... in
        // many cases; strict equality would fail after JSON round-trip.
        // 1e-9 is well above f64 round-trip precision (~1e-15) and tight
        // enough to catch any real drift.
        assert!(
            (got.pixel_ratio - expected.pixel_ratio).abs() < 1e-9,
            "case {} pixel_ratio: got {} expected {} (diff {})",
            case.name,
            got.pixel_ratio,
            expected.pixel_ratio,
            (got.pixel_ratio - expected.pixel_ratio).abs(),
        );
    }
    assert!(
        covered >= fixture.cases.len(),
        "every fixture case must carry `expected_canonical_map_viewport` (got {} of {})",
        covered,
        fixture.cases.len(),
    );
}
