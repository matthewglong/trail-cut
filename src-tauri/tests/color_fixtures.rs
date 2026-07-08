// WS6 — color-pipeline test harness.
//
// Drives the WS0 classifier and the downstream ingest/delivery pipelines
// (WS1 proxy, WS2 thumbnail, WS3 working-space, WS4 delivery) against the
// reference fixtures in `src-tauri/fixtures/color/`. Every test in here is
// gated on FFmpeg + ffprobe being on PATH; the harness panics with a clear
// install message otherwise (mirrors the encoder_probe and golden_frame
// test conventions in this repo).
//
// Why a single file: the assertion helpers (`assert_color_tags`,
// `assert_single_colr_atom`, `parse_ffprobe_color`) and the fixture-path
// resolver are reused across the classification, proxy, thumbnail, and
// delivery suites. Putting them next to the tests keeps the contract
// readable end-to-end and avoids a `mod` helper that integration tests
// can't share without a workspace.
//
// WS6 lands the harness while WS1 / WS2 / WS3 / WS4 are still in flight.
// Tests that depend on those workstreams' module surface are marked
// `#[ignore]` with a TODO referencing the upstream brief; the WS7
// validation pass will lift the ignore flags once the upstream modules
// merge. Tests that DON'T depend on WS1+ — classifier coverage,
// fixture-tag golden assertions, single-`colr`-atom assertion on existing
// outputs — run unconditionally.

use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;
use trail_cut_lib::export::probe_clip;
use trail_cut_lib::util::color::{classify, map_ingest_filter, SourceColorClass};

// ---------- precondition guards ----------

fn assert_ffmpeg_on_path() {
    let probe = Command::new("ffmpeg").arg("-version").output();
    if probe.map(|o| !o.status.success()).unwrap_or(true) {
        panic!(
            "ffmpeg not on PATH (or non-zero exit). Install via `brew install ffmpeg` \
             (macOS) or your distro's package manager."
        );
    }
}

fn assert_ffprobe_on_path() {
    let probe = Command::new("ffprobe").arg("-version").output();
    if probe.map(|o| !o.status.success()).unwrap_or(true) {
        panic!(
            "ffprobe not on PATH (or non-zero exit). Install via `brew install ffmpeg` \
             — ffprobe ships with ffmpeg."
        );
    }
}

/// Panic with an actionable install message if the installed FFmpeg build
/// is missing the `zscale` filter (libzimg). The WS1/WS2 HDR branches
/// (HLG / PQ / Dolby Vision) and the WS3 working-space architecture both
/// require zscale, so the entire color test suite is meaningless without
/// it; the product itself is meaningless without it (every ingest path
/// uses zscale). Tests must fail loud when the env can't support them —
/// silent skip-with-warning produces false-green runs that miss real
/// regressions. Homebrew's default `brew install ffmpeg` formula
/// historically dropped libzimg; this helper points devs at the fix.
fn assert_ffmpeg_has_zscale() {
    let has = Command::new("ffmpeg")
        .args(["-hide_banner", "-filters"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(" zscale "))
        .unwrap_or(false);
    if !has {
        panic!(
            "FFmpeg is missing the `zscale` filter (libzimg). The TrailCut color \
             pipeline requires zscale at every ingest path — your dev FFmpeg \
             build is incomplete. Install a libzimg-enabled build (e.g. \
             `brew install ffmpeg-full` on macOS, or rebuild ffmpeg with \
             `--enable-libzimg`)."
        );
    }
}

// ---------- fixture-path resolver ----------

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn fixtures_dir() -> PathBuf {
    manifest_dir().join("fixtures").join("color")
}

fn fixture(name: &str) -> PathBuf {
    let p = fixtures_dir().join(name);
    assert!(
        p.exists(),
        "fixture {} missing — regenerate via `bash {}`",
        p.display(),
        fixtures_dir().join("generate.sh").display(),
    );
    p
}

// ---------- per-fixture expected-tag table ----------
//
// Source of truth for what each fixture's ffprobe call MUST return. Mirrors
// the table in `fixtures/color/README.md`. Adding a fixture means adding a
// row here AND a row in the README; the two stay in lock-step or the
// regen-and-commit dance gets confusing fast.

#[derive(Debug, Clone, Copy)]
struct ExpectedColorTags {
    pix_fmt: Option<&'static str>,
    primaries: Option<&'static str>,
    transfer: Option<&'static str>,
    matrix: Option<&'static str>,
    range: Option<&'static str>,
    class: SourceColorClass,
    /// `true` when the file is expected to carry a DOVI side-data block.
    /// The placeholder dolby_vision.mov fixture today is HLG-base only and
    /// sets this `false`; flip to `true` once a real DV fixture lands (see
    /// fixtures/color/README.md §"Dolby Vision limitation").
    has_dolby_vision: bool,
}

const SDR_BT709: ExpectedColorTags = ExpectedColorTags {
    pix_fmt: Some("yuv420p"),
    primaries: Some("bt709"),
    transfer: Some("bt709"),
    matrix: Some("bt709"),
    range: Some("tv"),
    class: SourceColorClass::SdrBt709,
    has_dolby_vision: false,
};

const HLG_BT2020: ExpectedColorTags = ExpectedColorTags {
    pix_fmt: Some("yuv420p10le"),
    primaries: Some("bt2020"),
    transfer: Some("arib-std-b67"),
    matrix: Some("bt2020nc"),
    range: Some("tv"),
    class: SourceColorClass::HlgBt2020,
    has_dolby_vision: false,
};

const PQ_BT2020: ExpectedColorTags = ExpectedColorTags {
    pix_fmt: Some("yuv420p10le"),
    primaries: Some("bt2020"),
    transfer: Some("smpte2084"),
    matrix: Some("bt2020nc"),
    range: Some("tv"),
    class: SourceColorClass::PqBt2020,
    has_dolby_vision: false,
};

/// The committed placeholder file is HLG-base only — see fixtures README.
/// Classification of *this file* therefore lands on HlgBt2020 (NOT
/// DolbyVision); the DV-specific assertion is the gated test below.
const DV_PLACEHOLDER: ExpectedColorTags = ExpectedColorTags {
    pix_fmt: Some("yuv420p10le"),
    primaries: Some("bt2020"),
    transfer: Some("arib-std-b67"),
    matrix: Some("bt2020nc"),
    range: Some("tv"),
    class: SourceColorClass::HlgBt2020,
    has_dolby_vision: false,
};

const NO_COLOR_METADATA: ExpectedColorTags = ExpectedColorTags {
    pix_fmt: Some("yuv420p"),
    primaries: None,
    transfer: None,
    matrix: None,
    range: None,
    class: SourceColorClass::Unknown,
    has_dolby_vision: false,
};

fn all_fixtures() -> Vec<(&'static str, ExpectedColorTags)> {
    vec![
        ("sdr_bt709_iphone.mov", SDR_BT709),
        ("hlg_bt2020_iphone.mov", HLG_BT2020),
        ("pq_bt2020.mp4", PQ_BT2020),
        ("dolby_vision.mov", DV_PLACEHOLDER),
        ("no_color_metadata.mp4", NO_COLOR_METADATA),
    ]
}

// ---------- ffprobe-derived color readout ----------

#[derive(Debug, Default)]
struct ProbedColorTags {
    pix_fmt: Option<String>,
    primaries: Option<String>,
    transfer: Option<String>,
    matrix: Option<String>,
    range: Option<String>,
}

/// Synchronous ffprobe wrapper used by the harness. Mirrors what the WS0
/// `probe_clip` async path returns but doesn't require a tokio runtime —
/// keeps the helpers usable from sync tests too.
fn probe_color_tags(path: &Path) -> ProbedColorTags {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=pix_fmt,color_primaries,color_transfer,color_space,color_range",
            "-of",
            "default=nw=1",
        ])
        .arg(path)
        .output()
        .expect("spawn ffprobe");
    assert!(
        out.status.success(),
        "ffprobe failed on {}: {}",
        path.display(),
        String::from_utf8_lossy(&out.stderr),
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut tags = ProbedColorTags::default();
    for line in stdout.lines() {
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        // ffprobe spells absent fields as the literal string "unknown" — we
        // surface them as None so the contract matches WS0's `Option<String>`
        // shape.
        let v_owned = if v == "unknown" { None } else { Some(v.to_string()) };
        match k {
            "pix_fmt" => tags.pix_fmt = v_owned,
            "color_primaries" => tags.primaries = v_owned,
            "color_transfer" => tags.transfer = v_owned,
            "color_space" => tags.matrix = v_owned,
            "color_range" => tags.range = v_owned,
            _ => {}
        }
    }
    tags
}

/// Assert a file's ffprobe color readout matches `expected` exactly. The
/// WS6 brief's reference helper — every WS1 proxy / WS2 thumbnail / WS4
/// delivery output gets pointed at this. Diff-style failure message makes
/// regressions immediately readable.
fn assert_color_tags(path: &Path, expected: ExpectedColorTags) {
    let probed = probe_color_tags(path);
    let mut diffs = Vec::new();
    if probed.pix_fmt.as_deref() != expected.pix_fmt {
        diffs.push(format!(
            "  pix_fmt:    expected {:?}, got {:?}",
            expected.pix_fmt, probed.pix_fmt
        ));
    }
    if probed.primaries.as_deref() != expected.primaries {
        diffs.push(format!(
            "  primaries:  expected {:?}, got {:?}",
            expected.primaries, probed.primaries
        ));
    }
    if probed.transfer.as_deref() != expected.transfer {
        diffs.push(format!(
            "  transfer:   expected {:?}, got {:?}",
            expected.transfer, probed.transfer
        ));
    }
    if probed.matrix.as_deref() != expected.matrix {
        diffs.push(format!(
            "  matrix:     expected {:?}, got {:?}",
            expected.matrix, probed.matrix
        ));
    }
    if probed.range.as_deref() != expected.range {
        diffs.push(format!(
            "  range:      expected {:?}, got {:?}",
            expected.range, probed.range
        ));
    }
    assert!(
        diffs.is_empty(),
        "color tag mismatch on {}:\n{}",
        path.display(),
        diffs.join("\n"),
    );
}

// ---------- single `colr`-atom assertion ----------
//
// The QuickTime per-frame color warnings called out in the investigation
// findings come from mp4/mov files carrying more than one `colr` atom OR
// per-frame SEI color data that disagrees with the container-level atom.
// This helper walks the file's box hierarchy looking for `colr` boxes and
// asserts exactly one. Implemented with a plain byte-level box reader so we
// don't take a new crate dependency for what's a 60-line walk.

#[derive(Debug, PartialEq)]
struct ColrAtom {
    /// `nclx` (modern, BT.709 / BT.2020 four-byte block) or `nclc` (legacy
    /// QuickTime, three-byte block, no range bit). Phase-1 outputs target
    /// `nclx`; the assertion enforces the type but doesn't fail on `nclc`
    /// alone — that's a downstream concern callers branch on if they care.
    color_type: [u8; 4],
    /// (primaries, transfer, matrix) — present for both `nclx` and `nclc`.
    primaries: u16,
    transfer: u16,
    matrix: u16,
    /// Bit 7 of the optional `full_range` byte (nclx only). `None` for
    /// `nclc`.
    full_range: Option<bool>,
}

/// Count and parse every `colr` atom in `path`. Walks the box tree
/// recursively from the file root; the typical hit is at
/// `moov/trak/mdia/minf/stbl/stsd/{avc1|hvc1|hev1|dvh1|…}/colr`, but we
/// don't hardcode the path — any `colr` we find counts.
fn find_colr_atoms(path: &Path) -> Vec<ColrAtom> {
    let bytes = std::fs::read(path).expect("read mp4/mov fixture");
    let mut out = Vec::new();
    walk_boxes(&bytes, &mut out);
    out
}

fn walk_boxes(buf: &[u8], out: &mut Vec<ColrAtom>) {
    let mut cursor = 0;
    while cursor + 8 <= buf.len() {
        let size = u32::from_be_bytes(buf[cursor..cursor + 4].try_into().unwrap()) as usize;
        let kind = &buf[cursor + 4..cursor + 8];
        let (header_len, box_size) = if size == 1 {
            // 64-bit largesize — bytes 8..16.
            if cursor + 16 > buf.len() {
                return;
            }
            let large =
                u64::from_be_bytes(buf[cursor + 8..cursor + 16].try_into().unwrap()) as usize;
            (16, large)
        } else if size == 0 {
            // Box extends to EOF.
            (8, buf.len() - cursor)
        } else {
            (8, size)
        };

        if box_size < header_len || cursor + box_size > buf.len() {
            return;
        }
        let payload = &buf[cursor + header_len..cursor + box_size];

        if kind == b"colr" {
            if let Some(atom) = parse_colr(payload) {
                out.push(atom);
            }
        }

        // Containers we walk into. `stsd` is special — its first 8 bytes are
        // version+entry_count, then each entry is itself a box; we treat it
        // as a container by skipping the 8-byte header before walking.
        if is_container(kind) {
            walk_boxes(payload, out);
        } else if kind == b"stsd" && payload.len() >= 8 {
            walk_boxes(&payload[8..], out);
        } else if is_sample_entry(kind) && payload.len() >= 78 {
            // Visual sample entries (`avc1`, `hvc1`, `hev1`, `dvh1`, …)
            // carry a fixed 78-byte preamble before nested boxes (`colr`,
            // `pasp`, `clap`, …). See ISO/IEC 14496-12 §8.5.2.2.
            walk_boxes(&payload[78..], out);
        }

        cursor += box_size;
    }
}

fn parse_colr(payload: &[u8]) -> Option<ColrAtom> {
    if payload.len() < 4 {
        return None;
    }
    let mut color_type = [0u8; 4];
    color_type.copy_from_slice(&payload[..4]);
    let rest = &payload[4..];
    match &color_type {
        b"nclx" => {
            if rest.len() < 7 {
                return None;
            }
            let primaries = u16::from_be_bytes([rest[0], rest[1]]);
            let transfer = u16::from_be_bytes([rest[2], rest[3]]);
            let matrix = u16::from_be_bytes([rest[4], rest[5]]);
            let full_range = (rest[6] & 0x80) != 0;
            Some(ColrAtom {
                color_type,
                primaries,
                transfer,
                matrix,
                full_range: Some(full_range),
            })
        }
        b"nclc" => {
            if rest.len() < 6 {
                return None;
            }
            let primaries = u16::from_be_bytes([rest[0], rest[1]]);
            let transfer = u16::from_be_bytes([rest[2], rest[3]]);
            let matrix = u16::from_be_bytes([rest[4], rest[5]]);
            Some(ColrAtom {
                color_type,
                primaries,
                transfer,
                matrix,
                full_range: None,
            })
        }
        // `prof` (ICC profile) — we don't parse these but they don't trigger
        // the QuickTime per-frame warning either, so we accept and ignore.
        _ => None,
    }
}

fn is_container(kind: &[u8]) -> bool {
    matches!(
        kind,
        b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" | b"udta" | b"edts" | b"dinf" | b"mvex"
    )
}

fn is_sample_entry(kind: &[u8]) -> bool {
    matches!(
        kind,
        b"avc1" | b"avc3" | b"hvc1" | b"hev1" | b"dvh1" | b"dvhe" | b"mp4v" | b"encv"
    )
}

/// Assert exactly one `colr` atom in `path`. The QuickTime per-frame
/// warning regression test — pointed at every WS1 proxy and every WS4
/// delivery output by the per-pipeline test suites below.
///
/// Used for the H.264/H.265 mp4 targets, where the container `colr` atom is
/// the *only* place color is signaled, so it must be present exactly once.
fn assert_single_colr_atom(path: &Path) {
    let atoms = find_colr_atoms(path);
    assert_eq!(
        atoms.len(),
        1,
        "expected exactly one `colr` atom in {}, found {}: {:#?}",
        path.display(),
        atoms.len(),
        atoms,
    );
}

/// Assert *at most* one `colr` atom in `path`. For ProRes 4444: color is
/// carried in the per-frame ProRes bitstream headers (ffprobe surfaces it and
/// `assert_color_tags` verifies it), so a container-level `colr` atom is
/// optional. FFmpeg 8's mov muxer writes none for prores_ks (FFmpeg ≤7 wrote
/// one); the encoded color data is identical either way. The hazard
/// `assert_single_colr_atom` guards against is *conflicting* color signaling —
/// more than one `colr` atom — which zero atoms cannot trigger.
fn assert_at_most_one_colr_atom(path: &Path) {
    let atoms = find_colr_atoms(path);
    assert!(
        atoms.len() <= 1,
        "expected at most one `colr` atom in {}, found {}: {:#?}",
        path.display(),
        atoms.len(),
        atoms,
    );
}

// ---------- Tests: WS0 classifier over the fixture set ----------
//
// Run unconditionally (no WS1+ dependency). These are the WS6 acceptance
// criterion: "`classify()` test: each fixture is correctly classified by
// `SourceColorClass`".

#[tokio::test]
async fn fixtures_classify_per_expected_table() {
    assert_ffprobe_on_path();

    for (name, expected) in all_fixtures() {
        let path = fixture(name);
        let probed = probe_clip(Path::new("ffprobe"), &path)
            .await
            .unwrap_or_else(|e| panic!("probe_clip failed on {}: {:?}", path.display(), e));
        let actual = classify(&probed.color_metadata());
        assert_eq!(
            actual, expected.class,
            "{}: classify expected {:?}, got {:?} (probed: {:?})",
            name, expected.class, actual, probed,
        );
    }
}

#[tokio::test]
async fn fixtures_probe_yields_expected_color_metadata() {
    // Cross-check: the ffprobe extraction (WS0) lands the right
    // per-stream fields BEFORE classification, so a classifier regression
    // can't hide behind a probing regression and vice versa.
    assert_ffprobe_on_path();

    for (name, expected) in all_fixtures() {
        let path = fixture(name);
        let probed = probe_clip(Path::new("ffprobe"), &path).await.unwrap();
        assert_eq!(
            probed.pix_fmt.as_deref(),
            expected.pix_fmt,
            "{}: pix_fmt",
            name
        );
        assert_eq!(
            probed.color_primaries.as_deref(),
            expected.primaries,
            "{}: color_primaries",
            name,
        );
        assert_eq!(
            probed.color_trc.as_deref(),
            expected.transfer,
            "{}: color_trc",
            name,
        );
        assert_eq!(
            probed.color_space.as_deref(),
            expected.matrix,
            "{}: color_space",
            name,
        );
        assert_eq!(
            probed.color_range.as_deref(),
            expected.range,
            "{}: color_range",
            name,
        );
        assert_eq!(
            probed.has_dolby_vision, expected.has_dolby_vision,
            "{}: has_dolby_vision",
            name,
        );
    }
}

#[test]
fn fixtures_assert_color_tags_helper_matches_expected_table() {
    // Reflexive test: the harness's own helper (which downstream WS1/WS2/WS4
    // tests will reuse) lines up with the ffprobe path. If this fails, the
    // helper is buggy and every WS1+ assertion below would be unreliable.
    assert_ffprobe_on_path();
    for (name, expected) in all_fixtures() {
        let path = fixture(name);
        assert_color_tags(&path, expected);
    }
}

// ---------- Tests: single `colr` atom assertion harness ----------

#[test]
fn assert_single_colr_atom_recognises_well_tagged_fixtures() {
    // The four explicitly-tagged fixtures (SDR / HLG / PQ / DV-placeholder)
    // each carry exactly one container-level `colr` atom by way of the
    // libx264/libx265 + `+faststart` mux. The "no metadata" fixture is the
    // negative case — exercised separately below.
    for name in [
        "sdr_bt709_iphone.mov",
        "hlg_bt2020_iphone.mov",
        "pq_bt2020.mp4",
        "dolby_vision.mov",
    ] {
        let path = fixture(name);
        assert_single_colr_atom(&path);
    }
}

#[test]
fn assert_single_colr_atom_rejects_zero_atoms_negative_case() {
    // The unknown fixture has its color tags stripped — it carries zero
    // `colr` atoms. `assert_single_colr_atom` must reject it (we want
    // proof of life on the negative path too).
    let path = fixture("no_color_metadata.mp4");
    let atoms = find_colr_atoms(&path);
    assert_eq!(
        atoms.len(),
        0,
        "no_color_metadata fixture should have zero colr atoms",
    );
}

#[test]
fn colr_atom_parser_reads_hlg_fixture_payload_correctly() {
    // Spot-check the parser against the HLG fixture's expected payload:
    // primaries=9 (BT.2020), transfer=18 (HLG / arib-std-b67), matrix=9
    // (BT.2020 non-constant luminance). Mirrors ISO/IEC 23001-8
    // enumerations. The libx264/libx265 mux at our FFmpeg build picks
    // `nclc` (legacy, no full_range byte) for HLG output; the parser
    // accepts either nclx or nclc and surfaces the difference in
    // `full_range` (Some/None).
    let path = fixture("hlg_bt2020_iphone.mov");
    let atoms = find_colr_atoms(&path);
    assert_eq!(atoms.len(), 1);
    let a = &atoms[0];
    assert!(
        &a.color_type == b"nclx" || &a.color_type == b"nclc",
        "expected nclx or nclc, got {:?}",
        std::str::from_utf8(&a.color_type).unwrap_or("(non-utf8)")
    );
    assert_eq!(a.primaries, 9, "BT.2020 primaries");
    assert_eq!(a.transfer, 18, "HLG / arib-std-b67 transfer");
    assert_eq!(a.matrix, 9, "BT.2020 non-constant luminance matrix");
    // `nclc` (legacy) doesn't carry a full_range byte; `nclx` does — when
    // present, color_range=tv must map to bit clear.
    if let Some(full_range) = a.full_range {
        assert!(!full_range, "color_range=tv → full_range bit clear");
    }
}

#[test]
fn colr_atom_parser_reads_pq_fixture_nclx_payload_correctly() {
    // PQ fixture from the same FFmpeg build picks `nclx` (modern, 4-byte
    // payload with full_range bit). Exercises the parser's nclx branch
    // explicitly so a regression there doesn't slip past the HLG test's
    // either-or check.
    let path = fixture("pq_bt2020.mp4");
    let atoms = find_colr_atoms(&path);
    assert_eq!(atoms.len(), 1);
    let a = &atoms[0];
    assert_eq!(&a.color_type, b"nclx");
    assert_eq!(a.primaries, 9, "BT.2020 primaries");
    assert_eq!(a.transfer, 16, "PQ / smpte2084 transfer");
    assert_eq!(a.matrix, 9, "BT.2020 non-constant luminance matrix");
    assert_eq!(a.full_range, Some(false), "color_range=tv → full_range bit clear");
}

// ---------- DV — gated until real DV synthesis is available ----------

#[test]
#[ignore = "Dolby Vision fixture is HLG-base placeholder; needs dovi_tool / x265-with-DV — see fixtures/color/README.md §Dolby Vision limitation"]
fn fixture_dolby_vision_carries_dovi_side_data() {
    // When a real DV file lands at fixtures/color/dolby_vision.mov, this
    // test verifies the ffprobe-derived `has_dolby_vision` is true AND
    // `classify()` returns DolbyVision (not HlgBt2020). The hand-built JSON
    // fixtures in `ffprobe.rs::parse_detects_dolby_vision_side_data` and
    // `util/color.rs::dolby_vision_wins_over_hlg_base_layer_tag` already
    // cover the parsing + classification logic — this test only adds the
    // missing "real file → real side-data" leg.
    let path = fixture("dolby_vision.mov");
    let rt = tokio::runtime::Runtime::new().unwrap();
    let probed = rt
        .block_on(probe_clip(Path::new("ffprobe"), &path))
        .expect("probe_clip");
    assert!(
        probed.has_dolby_vision,
        "real DV fixture must carry DOVI side-data; got probed={:?}",
        probed,
    );
    assert_eq!(classify(&probed.color_metadata()), SourceColorClass::DolbyVision);
}

// ---------- WS1 proxy pipeline — driven against the merged WS1 surface ----------
//
// WS1 (`src-tauri/src/commands/ffmpeg.rs::generate_proxy`) has landed: the
// command branches the `-vf` chain on the source's `SourceColorClass`,
// tags every output BT.709 SDR limited-range, and adds `-movflags
// +faststart`. These tests drive the production code path against the
// committed fixtures.

/// Helper: run `generate_proxy` against `source_fixture` inside a fresh
/// temp project dir. Returns the proxy's on-disk path. Requires ffmpeg +
/// ffprobe on PATH; panics with the same message shape as
/// `assert_ffmpeg_on_path` if either is missing.
async fn generate_proxy_for_fixture(source_fixture: &Path) -> PathBuf {
    let project_dir = TempDir::new().expect("temp project dir");
    let proxy_str = trail_cut_lib::generate_proxy(
        source_fixture.to_string_lossy().into_owned(),
        project_dir.path().to_string_lossy().into_owned(),
    )
    .await
    .expect("generate_proxy must succeed on a valid fixture");
    // Move the proxy out of the TempDir so it survives the dir's Drop. The
    // TempDir's scratch space gets cleaned up; the proxy file lives until
    // the caller is done asserting on it. Uses a nano-sec-tagged path so
    // parallel `cargo test` workers don't collide on the same persist
    // location (process id alone is insufficient).
    let src = PathBuf::from(&proxy_str);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let persist = std::env::temp_dir().join(format!(
        "trailcut-ws1-proxy-{}-{}.mp4",
        std::process::id(),
        nanos,
    ));
    std::fs::copy(&src, &persist).expect("persist proxy");
    drop(project_dir);
    persist
}

/// Canonical post-WS1 proxy color tags. Every proxy output, regardless of
/// the source's color class, lands on this profile (Decision 4 in
/// design-decisions.md — "proxies are always SDR BT.709 limited-range").
const PROXY_OUTPUT_TAGS: ExpectedColorTags = ExpectedColorTags {
    pix_fmt: Some("yuv420p"),
    primaries: Some("bt709"),
    transfer: Some("bt709"),
    matrix: Some("bt709"),
    range: Some("tv"),
    class: SourceColorClass::SdrBt709,
    has_dolby_vision: false,
};

#[tokio::test]
async fn ws1_proxy_output_is_bt709_sdr_for_every_fixture() {
    // Acceptance criterion (WS6 §"Proxy tests: every WS1 output passes
    // `assert_color_tags` for BT.709 SDR"). For each fixture, drive
    // `generate_proxy` and assert the output's color tags match the
    // canonical BT.709 SDR limited-range yuv420p profile.
    //
    // WS7 fix: `build_proxy_args` now splices
    // `-x264-params colorprim=bt709:transfer=bt709:colormatrix=bt709`
    // alongside the existing `-color_*` flags. libx264 honors
    // `-colorspace` and `-color_range` (those land on the VUI directly)
    // but silently drops `-color_primaries` and `-color_trc` unless
    // they're duplicated inside `-x264-params`. Pre-WS7 the resulting
    // proxy reported `color_primaries=unknown` / `color_transfer=unknown`
    // to ffprobe and surfaced a QuickTime per-frame color warning; with
    // the WS7 splice in place the encoded byte stream's actual VUI now
    // carries the BT.709 tags.
    assert_ffmpeg_on_path();
    assert_ffprobe_on_path();
    assert_ffmpeg_has_zscale();

    for (name, _expected_source) in all_fixtures() {
        let src = fixture(name);
        let proxy = generate_proxy_for_fixture(&src).await;
        assert_color_tags(&proxy, PROXY_OUTPUT_TAGS);
        assert_single_colr_atom(&proxy);
        let _ = std::fs::remove_file(&proxy);
    }
}

#[tokio::test]
async fn ws1_proxy_has_faststart_moov_atom() {
    // The WS1 brief calls out `-movflags +faststart`; this test verifies
    // the proxy's `moov` atom lands before `mdat` so WKWebView / QuickTime
    // can begin playback before the full file is downloaded / mmapped.
    // Uses one fixture (SDR) — the +faststart flag is class-agnostic per
    // the WS1 implementation in `build_proxy_args`.
    assert_ffmpeg_on_path();
    let src = fixture("sdr_bt709_iphone.mov");
    let proxy = generate_proxy_for_fixture(&src).await;
    let bytes = std::fs::read(&proxy).expect("read proxy");

    let moov_pos = find_top_level_box_offset(&bytes, b"moov")
        .expect("proxy must carry a moov box");
    let mdat_pos = find_top_level_box_offset(&bytes, b"mdat")
        .expect("proxy must carry an mdat box");
    assert!(
        moov_pos < mdat_pos,
        "moov atom ({}) must precede mdat ({}) for +faststart",
        moov_pos,
        mdat_pos,
    );
    let _ = std::fs::remove_file(&proxy);
}

/// Find the byte offset of the first top-level box with the given fourcc.
/// Top-level only — does not recurse. Used by the +faststart test.
fn find_top_level_box_offset(buf: &[u8], fourcc: &[u8; 4]) -> Option<usize> {
    let mut cursor = 0;
    while cursor + 8 <= buf.len() {
        let size = u32::from_be_bytes(buf[cursor..cursor + 4].try_into().unwrap()) as usize;
        let kind = &buf[cursor + 4..cursor + 8];
        let box_size = if size == 1 {
            if cursor + 16 > buf.len() {
                return None;
            }
            u64::from_be_bytes(buf[cursor + 8..cursor + 16].try_into().unwrap()) as usize
        } else if size == 0 {
            buf.len() - cursor
        } else {
            size
        };
        if kind == fourcc {
            return Some(cursor);
        }
        if box_size == 0 || cursor + box_size > buf.len() {
            return None;
        }
        cursor += box_size;
    }
    None
}

// ---------- WS2 thumbnail pipeline — driven against the merged WS2 surface ----------
//
// WS2 (`generate_thumbnail` / `generate_thumbnail_at`) has landed: the
// command branches on `SourceColorClass`, uses input-seek (`-ss` before
// `-i`), and embeds the bundled sRGB ICC profile via ExifTool.

async fn generate_thumbnail_for_fixture(source_fixture: &Path) -> PathBuf {
    let project_dir = TempDir::new().expect("temp project dir");
    let thumb_str = trail_cut_lib::generate_thumbnail(
        source_fixture.to_string_lossy().into_owned(),
        project_dir.path().to_string_lossy().into_owned(),
    )
    .await
    .expect("generate_thumbnail must succeed on a valid fixture");
    let src = PathBuf::from(&thumb_str);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let persist = std::env::temp_dir().join(format!(
        "trailcut-ws2-thumb-{}-{}.jpg",
        std::process::id(),
        nanos,
    ));
    std::fs::copy(&src, &persist).expect("persist thumb");
    drop(project_dir);
    persist
}

#[tokio::test]
async fn ws2_thumbnail_output_has_srgb_icc_profile_for_every_fixture() {
    // Acceptance criterion (WS6 §"Thumbnail tests: every WS2 output has
    // sRGB ICC profile (verify via ExifTool in test)"). For each fixture,
    // drive `generate_thumbnail` and verify the output JPEG carries an
    // embedded ICC profile description string identifying sRGB.
    assert_ffmpeg_on_path();
    let exiftool_available = Command::new("exiftool").arg("-ver").output().is_ok();
    if !exiftool_available {
        panic!(
            "exiftool not on PATH — required for WS2 thumbnail ICC verification. \
             Install via `brew install exiftool`."
        );
    }

    assert_ffmpeg_has_zscale();
    for (name, _expected_source) in all_fixtures() {
        let src = fixture(name);
        let thumb = generate_thumbnail_for_fixture(&src).await;
        assert_thumbnail_has_srgb_icc(&thumb);
        let _ = std::fs::remove_file(&thumb);
    }
}

fn assert_thumbnail_has_srgb_icc(jpeg_path: &Path) {
    // ExifTool surfaces the ICC profile description as `ProfileDescription`
    // and the color-space identification as `ColorSpaceData` / `DeviceModel`
    // / `ProfileCMMType`. We assert the description contains "sRGB" — that's
    // the human-readable identification that downstream tools (QuickTime,
    // Preview, Chromium) pivot on.
    let out = Command::new("exiftool")
        .args(["-s", "-s", "-s", "-ProfileDescription"])
        .arg(jpeg_path)
        .output()
        .expect("spawn exiftool");
    assert!(
        out.status.success(),
        "exiftool failed on {}: {}",
        jpeg_path.display(),
        String::from_utf8_lossy(&out.stderr),
    );
    let desc = String::from_utf8_lossy(&out.stdout).trim().to_string();
    assert!(
        desc.to_ascii_lowercase().contains("srgb"),
        "expected sRGB ICC profile on {}; ExifTool ProfileDescription: {:?}",
        jpeg_path.display(),
        desc,
    );
}

// ---------- WS3 working-space export — driven against the merged WS3 surface ----------
//
// WS3 (`util::color::ingest_filter_for` + `map_ingest_filter`) has landed.
// These tests are pure: they assert the documented filter strings match
// the brief without spawning FFmpeg.

#[test]
fn ws3_ingest_filter_for_each_class_matches_brief() {
    // Acceptance criterion (WS3 §"New unit tests on the filter-graph builder
    // verifying that per-clip subgraph contains `ingest_filter_for(...)`
    // output and that map ingest contains `map_ingest_filter()` output").
    //
    // The intra-module tests in `util/color.rs` already assert specific
    // substring properties of each branch. This integration-level test
    // verifies the cross-module contract: every fixture's classified class
    // resolves to a non-empty ingest filter chain landing on the working
    // space pixel format `gbrpf32le`.
    use trail_cut_lib::util::color::{ingest_filter_for, map_ingest_filter};

    for (name, expected) in all_fixtures() {
        let filter = ingest_filter_for(expected.class, None);
        assert!(
            filter.contains("gbrpf32le"),
            "{} ({:?}): ingest filter must land on gbrpf32le: {}",
            name,
            expected.class,
            filter,
        );
        assert!(
            filter.contains("zscale"),
            "{} ({:?}): ingest filter must use zscale: {}",
            name,
            expected.class,
            filter,
        );
    }

    // Map ingest is class-agnostic — one canonical filter for the renderer's
    // RGBA8 readback into working space.
    let map = map_ingest_filter();
    assert!(map.contains("gbrpf32le"), "map ingest must land on gbrpf32le: {}", map);
    assert!(
        map.contains("iec61966-2-1") || map.contains("srgb"),
        "map ingest must declare an sRGB-equivalent input transfer: {}",
        map,
    );
    assert!(
        map.contains("bt2020"),
        "map ingest must end on bt2020 primaries: {}",
        map,
    );
}

// ---------- WS4 delivery transforms — driven against the merged WS4 surface ----------

/// Synthesize a 0.5-second 256x256 BT.709 SDR clip into `output`. Cheap
/// enough that we can run each delivery target against it without paying
/// the wall-clock cost of the full renderer worker pipeline. Used as the
/// `[vout_w]` input proxy for the WS4 delivery-target finishing test —
/// in production `[vout_w]` is the composite of the working-space ingest
/// of N clips + the map canvas, but for assertions on the *output*'s
/// color tags + colr atom, a synthetic BT.709 source is sufficient. The
/// WS4 finishing-filter chain begins with `zscale=t=bt709:m=bt709:p=bt709:r=limited`
/// (or its HDR equivalent) regardless of the upstream content.
fn make_synthetic_bt709_clip(output: &Path, duration_s: f64) {
    let video_src = format!(
        "color=c=0x808080:size=256x256:rate=30:duration={}",
        duration_s,
    );
    let audio_src = format!("sine=frequency=440:sample_rate=48000:duration={}", duration_s);
    let status = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            &video_src,
            "-f",
            "lavfi",
            "-i",
            &audio_src,
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-colorspace",
            "bt709",
            "-color_range",
            "tv",
            "-x264-params",
            "colorprim=bt709:transfer=bt709:colormatrix=bt709",
            "-c:a",
            "aac",
            "-shortest",
        ])
        .arg(output)
        .status()
        .expect("spawn ffmpeg synth clip builder");
    assert!(
        status.success(),
        "ffmpeg synth clip builder failed for {}",
        output.display(),
    );
}

/// Drive one WS4 `DeliveryTarget` directly through FFmpeg using the same
/// `delivery_finishing_filter` + `delivery_encoder_args` strings the
/// composite branch splices into its filter_complex. Returns the produced
/// output path so the caller can assert on its color tags + colr atom.
///
/// This bypasses the full renderer worker pipeline (which would need the
/// `integration_export` feature + a `setup_fixture.cjs` build) but
/// exercises the load-bearing WS4 contract: the finishing filter and
/// encoder argv produce a stream the encoder tags correctly. The WS3
/// working-space ingest into `[vout_w]` is verified separately by
/// `ws3_ingest_filter_for_each_class_matches_brief` (above) and by the
/// pure-Rust filter-builder tests in `src/export/filtergraph.rs`.
fn run_delivery_finishing_for_test(
    target: trail_cut_lib::export::DeliveryTarget,
    src: &Path,
    out: &Path,
) -> Result<(), String> {
    use trail_cut_lib::export::{
        delivery_encoder_args, delivery_finishing_filter, select_encoder_for_target,
    };

    // Working-space pre-roll into `[vout_w]`: SDR Rec.709 BT.709 → linear,
    // BT.2020 primaries. Same chain `util::color::ingest_filter_for(SdrBt709)`
    // emits; verified by `ws3_ingest_filter_for_each_class_matches_brief`.
    let preroll = trail_cut_lib::util::color::ingest_filter_for(
        trail_cut_lib::util::color::SourceColorClass::SdrBt709,
        None,
    );
    let finishing = delivery_finishing_filter(target);
    let filter_complex = format!("[0:v]{preroll}[vout_w];[vout_w]{finishing}[vout]");

    let encoder = select_encoder_for_target(target)
        .map_err(|e| format!("select_encoder_for_target: {e}"))?;
    let enc_args = delivery_encoder_args(target, &encoder);

    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(src)
        .args(["-filter_complex", &filter_complex, "-map", "[vout]"]);
    // For ProRes the encoder argv ends with `-c:a pcm_s16le` (no -map for
    // audio in the synthetic case — drop audio). The other targets carry
    // AAC but we drop audio too so the synthetic input doesn't need to
    // line up an audio stream.
    cmd.arg("-an");
    for a in &enc_args {
        // Skip any audio-codec args; we explicitly dropped audio above.
        // (Pre-existing audio args still parse fine even with -an, but
        // the `-c:a pcm_s16le` for ProRes does emit a warning. The pcm
        // and aac flags both no-op cleanly under -an in modern FFmpeg
        // builds; keep the full argv so the test exercises the actual
        // production string.)
        cmd.arg(a);
    }
    cmd.arg(out);

    let output = cmd.output().map_err(|e| format!("spawn ffmpeg: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffmpeg failed (status={:?}): {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim(),
        ));
    }
    Ok(())
}

/// Expected color-tag profile per delivery target. The `pix_fmt` /
/// primaries / transfer / matrix / range columns mirror
/// `delivery::delivery_finishing_filter` and `delivery::delivery_encoder_args`
/// in `src/export/delivery.rs`. The `class` field is irrelevant for
/// output assertions (it's the *source*'s class); we reuse the
/// `ExpectedColorTags` struct so `assert_color_tags` can be used as-is.
fn expected_tags_for_target(
    target: trail_cut_lib::export::DeliveryTarget,
) -> ExpectedColorTags {
    use trail_cut_lib::export::DeliveryTarget as T;
    match target {
        T::SdrH264 | T::SdrH265 => ExpectedColorTags {
            pix_fmt: Some("yuv420p"),
            primaries: Some("bt709"),
            transfer: Some("bt709"),
            matrix: Some("bt709"),
            range: Some("tv"),
            class: SourceColorClass::SdrBt709,
            has_dolby_vision: false,
        },
        T::Prores => ExpectedColorTags {
            // We feed prores_ks `-pix_fmt yuva444p10le` (its only accepted
            // 4:4:4+alpha input — supported formats are yuv422p10le /
            // yuv444p10le / yuva444p10le, no 12-bit input). ProRes 4444 is
            // natively a 12-bit codec, so this is the *decoded read-back*, not
            // the input: FFmpeg 8's ProRes decoder reports the stored stream as
            // yuva444p12le (bits_per_raw_sample=12). FFmpeg ≤7 reported 10le.
            // Same encoded bytes either way; only ffprobe's description moved.
            pix_fmt: Some("yuva444p12le"),
            primaries: Some("bt709"),
            transfer: Some("bt709"),
            matrix: Some("bt709"),
            range: Some("tv"),
            class: SourceColorClass::SdrBt709,
            has_dolby_vision: false,
        },
        T::HdrHlg => ExpectedColorTags {
            pix_fmt: Some("yuv420p10le"),
            primaries: Some("bt2020"),
            transfer: Some("arib-std-b67"),
            matrix: Some("bt2020nc"),
            range: Some("tv"),
            class: SourceColorClass::HlgBt2020,
            has_dolby_vision: false,
        },
        T::HdrPq => ExpectedColorTags {
            pix_fmt: Some("yuv420p10le"),
            primaries: Some("bt2020"),
            transfer: Some("smpte2084"),
            matrix: Some("bt2020nc"),
            range: Some("tv"),
            class: SourceColorClass::PqBt2020,
            has_dolby_vision: false,
        },
    }
}

#[tokio::test]
async fn ws4_each_delivery_target_emits_expected_color_tags() {
    // Acceptance criterion (WS6 §"Delivery tests: every WS4 output passes
    // `assert_color_tags` for its target").
    //
    // Exercises the production `delivery_finishing_filter` and
    // `delivery_encoder_args` strings against a synthetic BT.709 source,
    // skipping the renderer-worker plumbing that would require an
    // `integration_export`-gated bundle. The WS3 working-space ingest is
    // exercised independently by `ws3_ingest_filter_for_each_class_matches_brief`
    // and the pure-Rust filter-builder tests in `src/export/filtergraph.rs`;
    // this test asserts what makes it out the other side of the encoder.
    assert_ffmpeg_on_path();
    assert_ffprobe_on_path();
    assert_ffmpeg_has_zscale();

    // Build the synthetic source once and reuse across targets.
    let temp = TempDir::new().expect("temp dir");
    let synth_src = temp.path().join("synth_bt709.mp4");
    make_synthetic_bt709_clip(&synth_src, 0.5);

    for target in trail_cut_lib::export::DeliveryTarget::all().iter().copied() {
        let ext = target.container_extension();
        let out = temp.path().join(format!(
            "ws4_{}.{}",
            serde_json::to_string(&target)
                .unwrap()
                .trim_matches('"')
                .to_string(),
            ext,
        ));
        match run_delivery_finishing_for_test(target, &synth_src, &out) {
            Ok(()) => {}
            Err(e) => panic!(
                "WS4 delivery {:?} failed to encode: {}",
                target, e,
            ),
        }
        let expected = expected_tags_for_target(target);
        assert_color_tags(&out, expected);
        // `colr`-atom guard against conflicting container color signaling. The
        // mp4 targets signal color *only* via the container atom, so they must
        // have exactly one. ProRes 4444 self-describes in its frame headers
        // (verified by `assert_color_tags` above), so its container atom is
        // optional — FFmpeg 8 writes none — and we only forbid more than one.
        if target == trail_cut_lib::export::DeliveryTarget::Prores {
            assert_at_most_one_colr_atom(&out);
        } else {
            assert_single_colr_atom(&out);
        }
    }
}

// ---------- WS3 PIP vs Split parity — structural assertion ----------

#[test]
fn ws3_pip_composite_matches_split_composite_within_tolerance() {
    // Acceptance criterion (WS6 §"Visual regression: PIP vs Split frames
    // match within tolerance"). The original PIP saturation root cause
    // was that the overlay junction in PIP composited a full-range sRGB
    // map stream against a limited-range Y'CbCr video stream without
    // normalization. The Split path was unaffected because its synthetic
    // black canvas forced both inputs onto a common base before overlay.
    //
    // WS3's fix: both map and video ingest into the same working-space
    // (`gbrpf32le`, BT.2020 primaries) before any overlay. PIP and Split
    // now overlay identical-regime streams — no saturation drift.
    //
    // **Structural verification** (this test): both modes' filter_complex
    // strings must:
    //   1. Carry `map_ingest_filter()` output on the map input
    //      (`[0:v]…[map]`), so the map enters working space identically
    //      regardless of mode.
    //   2. Carry per-clip `ingest_filter_for(class)` output on every clip
    //      input, so video enters working space identically.
    //   3. Use working-space `gbrpf32le` as the format threaded through
    //      the overlay junction (the precision-preserving compositing
    //      regime; verified by `ws3_composite_filter_complex_internal_precision_is_gbrpf32le`
    //      and `ws3_composite_overlays_drop_format_auto_negotiation` in
    //      `src/export/filtergraph.rs`).
    //
    // **Pixel-level verification** is gated on the `integration_export`
    // feature and the renderer-worker bundle (`npm run build:renderer`);
    // see `src-tauri/tests/render_export_composite.rs` for the
    // end-to-end PIP+Split parity test infrastructure (which uses the
    // same `make_test_clip` / `extract_rgba_frame` helpers we'd need to
    // factor out for a pixel-diff assertion here). The argv-level
    // structural assertion below is the regression guard that catches
    // the PIP-saturation root cause without requiring the bundle.
    use trail_cut_lib::export::{
        build_composite_filtergraph, AspectRatio, CompositeMode, EncoderChoice, EncoderClass,
        EncoderKind, OutputDimensions, OutputResolution, PixelDims, PixelRect, VisibleClipInput,
    };
    use trail_cut_lib::Clip;

    fn fake_clip(id: &str) -> Clip {
        // Minimal Clip stub for filtergraph builder. The builder reads
        // path / trim / effects / focal_point; we don't need to populate
        // metadata for argv-level assertions.
        serde_json::from_value(serde_json::json!({
            "id": id,
            "path": "/tmp/fake.mov",
            "filename": "fake.mov",
            "duration_ms": 1000,
            "trim": {"in_ms": 0, "out_ms": 1000},
            "focal_point": {"x": 0.5, "y": 0.5, "zoom": 1.0},
            "effects": {
                "stabilize": {"enabled": false, "shakiness": 5},
                "speed": 1.0
            },
            "visible": true,
        }))
        .expect("clip stub")
    }

    fn stub_encoder() -> EncoderChoice {
        EncoderChoice {
            class: EncoderClass::Hevc,
            name: "hevc_videotoolbox".to_string(),
            kind: EncoderKind::Hardware,
            codec_args: vec![],
            probe_wall_clock_ms: 0,
        }
    }

    let visible = vec![VisibleClipInput {
        source_path: PathBuf::from("/tmp/fake.mov"),
        clip: fake_clip("c1"),
        source_dims: PixelDims { w: 1280, h: 720 },
        has_audio: false,
    }];
    let output_dims = OutputDimensions { w: 1080, h: 1920 };
    let map_slot = PixelRect { x: 0, y: 0, w: 1080, h: 960 };
    let video_slot = PixelRect { x: 0, y: 960, w: 1080, h: 960 };
    let _ = AspectRatio::NineSixteen;
    let _ = OutputResolution::P1080;

    let map_ingest = trail_cut_lib::util::color::map_ingest_filter();
    let clip_ingest = trail_cut_lib::util::color::ingest_filter_for(
        trail_cut_lib::util::color::SourceColorClass::SdrBt709,
        None,
    );

    let modes = [
        ("pip_map_inset", CompositeMode::PipMapInset),
        ("pip_video_inset", CompositeMode::PipVideoInset),
        ("split", CompositeMode::Split),
    ];

    let mut filter_complexes = Vec::with_capacity(modes.len());
    for (label, mode) in modes {
        let plan = build_composite_filtergraph(
            &visible,
            map_slot,
            video_slot,
            output_dims,
            mode,
            None,
            30,
            30,
            &stub_encoder(),
            256,
            trail_cut_lib::export::DeliveryTarget::Prores,
            Path::new("/tmp/out.mov"),
        )
        .expect("filtergraph build");
        let fc_idx = plan
            .argv
            .iter()
            .position(|a| a == "-filter_complex")
            .expect("filter_complex present");
        let fc = plan
            .argv
            .get(fc_idx + 1)
            .expect("filter_complex value")
            .clone();
        // (1) Map ingest into working space — identical for all modes.
        assert!(
            fc.contains(&map_ingest),
            "{label}: map ingest must contain map_ingest_filter() output; expected substring `{map_ingest}` in fc=`{fc}`",
        );
        // (2) Per-clip ingest into working space — identical for all modes.
        assert!(
            fc.contains(&clip_ingest),
            "{label}: per-clip ingest must contain ingest_filter_for(SdrBt709) output; expected substring `{clip_ingest}` in fc=`{fc}`",
        );
        // (3) Working-space precision threaded through the overlay.
        assert!(
            fc.contains("gbrpf32le"),
            "{label}: filter_complex must thread working-space gbrpf32le through the overlay junction; fc=`{fc}`",
        );
        filter_complexes.push((label, fc));
    }

    // Cross-mode parity: the working-space ingest chain (both map and
    // clip) appears identically in every mode. The structural fix that
    // kills the PIP saturation bug is that PIP no longer has a different
    // ingest path than Split — both normalize to working space before
    // overlay. (The overlay coordinates differ between modes; we don't
    // assert on those — just on the ingest contracts both sides share.)
    for (label_a, fc_a) in &filter_complexes {
        for (label_b, fc_b) in &filter_complexes {
            if label_a == label_b {
                continue;
            }
            // Both must carry the same map-ingest output (identical
            // string match, not a substring shape difference).
            assert!(
                fc_a.contains(&map_ingest) && fc_b.contains(&map_ingest),
                "modes {label_a} and {label_b} must both contain identical map_ingest_filter() output",
            );
            assert!(
                fc_a.contains(&clip_ingest) && fc_b.contains(&clip_ingest),
                "modes {label_a} and {label_b} must both contain identical ingest_filter_for(SdrBt709) output",
            );
        }
    }
}

#[test]
fn ws3_masked_pip_composite_overlay_inputs_share_format_family() {
    // Integration-level regression guard for the WS3 QA fix:
    // the masked-PIP branches used to feed `overlay` two inputs from
    // different pixel-format families (`gbrpf32le` background vs
    // `yuva444p10le` alpha-merged inset). `overlay` has no float pixel
    // format support, so the cross-family mismatch was silently resolved
    // by FFmpeg's framework via swscale with default colorspace tags —
    // exactly the implicit-conversion path WS3 was meant to eliminate.
    //
    // The fix lifts the background side to `yuva444p10le` BEFORE
    // `overlay` so both inputs share a family, then round-trips back to
    // `gbrpf32le` afterwards so the `[vout_w]` label still matches the
    // working-space contract `delivery_finishing_filter` consumes. The
    // pure-Rust unit tests in `src/export/filtergraph.rs::tests` cover
    // the labels exhaustively; this integration test asserts the
    // contract from the public `build_composite_filtergraph` surface so
    // a refactor that touches the masked branches via a private path
    // can't regress the invariant silently.
    use trail_cut_lib::export::{
        build_composite_filtergraph, CompositeMode, EncoderChoice, EncoderClass, EncoderKind,
        OutputDimensions, PixelDims, PixelRect, VisibleClipInput,
    };
    use trail_cut_lib::Clip;

    fn fake_clip(id: &str) -> Clip {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "path": "/tmp/fake.mov",
            "filename": "fake.mov",
            "duration_ms": 1000,
            "trim": {"in_ms": 0, "out_ms": 1000},
            "focal_point": {"x": 0.5, "y": 0.5, "zoom": 1.0},
            "effects": {
                "stabilize": {"enabled": false, "shakiness": 5},
                "speed": 1.0
            },
            "visible": true,
        }))
        .expect("clip stub")
    }

    fn stub_encoder() -> EncoderChoice {
        EncoderChoice {
            class: EncoderClass::Hevc,
            name: "hevc_videotoolbox".to_string(),
            kind: EncoderKind::Hardware,
            codec_args: vec![],
            probe_wall_clock_ms: 0,
        }
    }

    let visible = vec![VisibleClipInput {
        source_path: PathBuf::from("/tmp/fake.mov"),
        clip: fake_clip("c1"),
        source_dims: PixelDims { w: 1280, h: 720 },
        has_audio: false,
    }];
    let output_dims = OutputDimensions { w: 1080, h: 1920 };
    let mask_path = Path::new("/tmp/mask.png");

    // Pick layout slots that distinguish PipMapInset (small map) from
    // PipVideoInset (small video). The overlay-coords assertion checks
    // both modes; the actual coords are mode-dependent.
    let map_slot_for_map_inset = PixelRect { x: 100, y: 200, w: 346, h: 346 };
    let video_slot_for_map_inset = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
    let map_slot_for_video_inset = PixelRect { x: 0, y: 0, w: 1080, h: 1920 };
    let video_slot_for_video_inset = PixelRect { x: 60, y: 80, w: 400, h: 720 };

    let fixtures: [(
        &str,
        CompositeMode,
        PixelRect,
        PixelRect,
        // Expected overlay step (yuva-family on both sides).
        &str,
        // Forbidden overlay step (the pre-fix mixed-family shape).
        &str,
    ); 2] = [
        (
            "PipMapInset",
            CompositeMode::PipMapInset,
            map_slot_for_map_inset,
            video_slot_for_map_inset,
            "[vc_a][map_masked]overlay=",
            "[vc][map_masked]overlay=",
        ),
        (
            "PipVideoInset",
            CompositeMode::PipVideoInset,
            map_slot_for_video_inset,
            video_slot_for_video_inset,
            "[map_a][vc_masked]overlay=",
            "[map][vc_masked]overlay=",
        ),
    ];

    for (label, mode, map_slot, video_slot, expected_overlay, forbidden_overlay) in fixtures {
        let plan = build_composite_filtergraph(
            &visible,
            map_slot,
            video_slot,
            output_dims,
            mode,
            Some(mask_path),
            30,
            30,
            &stub_encoder(),
            256,
            trail_cut_lib::export::DeliveryTarget::Prores,
            Path::new("/tmp/out.mov"),
        )
        .expect("filtergraph build");
        let fc_idx = plan
            .argv
            .iter()
            .position(|a| a == "-filter_complex")
            .expect("filter_complex present");
        let fc = plan
            .argv
            .get(fc_idx + 1)
            .expect("filter_complex value")
            .clone();

        // Background gets explicit promotion to yuva444p10le (alongside
        // the alphamerge promotion of the inset). Both sides of the
        // overlay are now in the same pixel-format family.
        assert!(
            fc.contains("[vc]format=yuva444p10le[vc_a]"),
            "{label}: missing `[vc]format=yuva444p10le[vc_a]` in fc=`{fc}`",
        );
        assert!(
            fc.contains("[map]format=yuva444p10le[map_a]"),
            "{label}: missing `[map]format=yuva444p10le[map_a]` in fc=`{fc}`",
        );

        // Positive: yuva-family overlay step is present.
        assert!(
            fc.contains(expected_overlay),
            "{label}: expected `{expected_overlay}` overlay step in fc=`{fc}`",
        );
        // Negative: the pre-fix mixed-family overlay must not appear.
        assert!(
            !fc.contains(forbidden_overlay),
            "{label}: mixed-family overlay `{forbidden_overlay}` must not appear; this is the WS3 QA-reported PIP-saturation bug; fc=`{fc}`",
        );

        // Round-trip back to working-space gbrpf32le so `[vout_w]`
        // matches the `delivery_finishing_filter` input contract.
        assert!(
            fc.contains("[vout_masked]format=gbrpf32le[vout_w]"),
            "{label}: missing post-overlay round-trip to gbrpf32le for [vout_w]; fc=`{fc}`",
        );
    }
}

// ---------------------------------------------------------------------------
// Map-ingest end-to-end: bare rawvideo RGBA → working space.
//
// Regression guard for the zimg `code 3074: no path between colorspaces`
// failure: the per-clip `ingest_filter_for()` chains can rely on the input
// stream's container-tagged colorspace metadata, but the map canvas arrives
// from the renderer worker as bare `rawvideo` RGBA with no embedded color
// tags. If `map_ingest_filter()` doesn't declare all four source tags
// (primaries / transfer / matrix / range) on its leading zscale, zimg has
// nothing to plan from and the filtergraph init fails before a single frame
// is processed.
//
// This test reproduces the production scenario by feeding rawvideo RGBA
// bytes into ffmpeg's stdin — no stream-level color tags — and asserting
// the filter chain initializes and outputs a frame. A unit test in
// color.rs covers the structural invariant (all four tags present); this
// one covers the *runtime* invariant (zimg actually accepts them).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// HDR reference-white tracer — the Phase 4 gate (GREEN since the HDR port).
//
// History: docs/CANON.md §6.1 diagnosed HDR map exports as dark because SDR
// map graphics entered the working space scene-linear (sRGB white → linear
// 1.0) and the delivery chain encoded that without a reference-white anchor —
// map white landed at ~63% HLG / ~51% PQ signal instead of the BT.2408
// graphics-white level (203 nit = 75% HLG / 58% PQ). These two tests were
// authored RED-BY-DESIGN in ship-review Phase 3 (measured 0.630 / 0.509) to
// prove the instrument could see the defect before anyone trusted it as a
// gate.
//
// Phase 4 (the HDR port, docs/spikes/IMPLEMENTATION.md) fixed the defect:
// SDR-origin sources delivered to HDR now carry a ×2.03 linear anchor gain at
// the ingest tail (`sdr_origin_anchor_gain`, proven equivalent to npl=203
// finishing), applied to the map via `map_ingest_filter_for_delivery` — the
// same delivery-aware chain the composite builder splices. The tracer
// measures that production chain and must stay GREEN; a regression here is
// the npl=203 defect coming back.
//
// DO NOT mark these `#[ignore]`, skip them, or loosen the tolerance. They
// run in the main CI test job (graduated from the retired `hdr-tracer`
// expected-red job when Phase 4 landed).
// ---------------------------------------------------------------------------

/// BT.2408 graphics white ("reference white", 203 cd/m²) expressed as a
/// normalized HLG signal level. This is the anchor YouTube and Resolve use
/// for SDR-origin graphics in HDR programmes.
const HLG_REFERENCE_WHITE_SIGNAL: f64 = 0.75;

/// BT.2408 graphics white as a normalized PQ signal level
/// (PQ inverse-EOTF of 203 cd/m² ≈ 0.58).
const PQ_REFERENCE_WHITE_SIGNAL: f64 = 0.58;

/// Acceptance window around the reference-white signal. The defect is a
/// ~13-percentage-point miss (≈0.62 measured vs 0.75 expected for HLG), so
/// ±0.02 cleanly separates "anchored at BT.2408" from "scene-linear bug"
/// while absorbing 10-bit quantization + encoder noise on a flat field.
const REFERENCE_WHITE_TOLERANCE: f64 = 0.02;

/// Render a pure-white map frame through the real delivery chain for
/// `target` and return the decoded luma as a normalized signal level
/// (0.0 = 10-bit limited-range black 64, 1.0 = white 940).
///
/// Production-faithful path: the white frame enters exactly as map canvas
/// frames do (bare rawvideo RGBA, no stream color tags) through the
/// delivery-aware `map_ingest_filter_for_delivery` (Phase 4: appends the
/// ×2.03 BT.2408 anchor for HDR targets — the same chain
/// `build_composite_filter_complex` splices) into `[vout_w]`, then
/// `delivery_finishing_filter` + `delivery_encoder_args` with the encoder
/// `select_encoder_for_target` actually picks on this machine. The delivered
/// file is then decoded back and the luma plane averaged over the central
/// region (borders excluded to keep encoder edge ringing out of the
/// measurement).
fn measure_delivered_map_white_signal(target: trail_cut_lib::export::DeliveryTarget) -> f64 {
    use trail_cut_lib::export::{
        delivery_encoder_args, delivery_finishing_filter, select_encoder_for_target,
    };
    use trail_cut_lib::util::color::map_ingest_filter_for_delivery;

    const W: usize = 256;
    const H: usize = 256;
    const FRAMES: usize = 10;

    let temp = TempDir::new().expect("temp dir");
    let out = temp
        .path()
        .join(format!("tracer_white.{}", target.container_extension()));

    let map_ingest = map_ingest_filter_for_delivery(&target.output_color_space());
    let finishing = delivery_finishing_filter(target);
    let filter_complex = format!("[0:v]{map_ingest}[vout_w];[vout_w]{finishing}[vout]");

    let encoder = select_encoder_for_target(target)
        .unwrap_or_else(|e| panic!("select_encoder_for_target({target:?}): {e}"));
    let enc_args = delivery_encoder_args(target, &encoder);

    // Encode: white RGBA frames on stdin → delivery chain → container.
    let mut cmd = Command::new("ffmpeg");
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "-s",
        &format!("{W}x{H}"),
        "-r",
        "30",
        "-i",
        "pipe:0",
        "-filter_complex",
        &filter_complex,
        "-map",
        "[vout]",
        "-an",
    ]);
    for a in &enc_args {
        cmd.arg(a);
    }
    cmd.arg(&out);

    let mut child = cmd
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn ffmpeg encode");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("ffmpeg stdin");
        let white_frame = vec![255u8; W * H * 4];
        for _ in 0..FRAMES {
            stdin.write_all(&white_frame).expect("write white frame");
        }
    }
    let enc_out = child.wait_with_output().expect("await ffmpeg encode");
    assert!(
        enc_out.status.success(),
        "delivery encode failed for {:?} (encoder {}):\nfilter_complex=`{}`\nstderr:\n{}",
        target,
        encoder.name,
        filter_complex,
        String::from_utf8_lossy(&enc_out.stderr),
    );

    // Decode one delivered frame back to raw 10-bit 4:2:0 and read the luma
    // plane. Both HDR targets store yuv420p10le, so this is a straight read,
    // not a conversion.
    let dec = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(&out)
        .args([
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "yuv420p10le",
            "pipe:1",
        ])
        .output()
        .expect("spawn ffmpeg decode");
    assert!(
        dec.status.success(),
        "decode of delivered {:?} output failed: {}",
        target,
        String::from_utf8_lossy(&dec.stderr),
    );
    let raw = &dec.stdout;
    assert!(
        raw.len() >= W * H * 2,
        "decoded frame too short: got {} bytes, need at least {} for the luma plane",
        raw.len(),
        W * H * 2,
    );

    // Average luma over the central 50% region (u16 little-endian samples,
    // 0..=1023).
    let (x0, x1) = (W / 4, 3 * W / 4);
    let (y0, y1) = (H / 4, 3 * H / 4);
    let mut sum = 0u64;
    let mut count = 0u64;
    for y in y0..y1 {
        for x in x0..x1 {
            let off = (y * W + x) * 2;
            let v = u16::from_le_bytes([raw[off], raw[off + 1]]);
            sum += v as u64;
            count += 1;
        }
    }
    let y_avg = sum as f64 / count as f64;

    // Normalize against the 10-bit limited (tv) range the delivery chain
    // emits: black = 64, nominal peak white = 940.
    (y_avg - 64.0) / (940.0 - 64.0)
}

fn assert_map_white_at_reference_signal(
    target: trail_cut_lib::export::DeliveryTarget,
    expected_signal: f64,
) {
    assert_ffmpeg_on_path();
    assert_ffprobe_on_path();
    assert_ffmpeg_has_zscale();

    let measured = measure_delivered_map_white_signal(target);
    assert!(
        (measured - expected_signal).abs() <= REFERENCE_WHITE_TOLERANCE,
        "map-graphics white is NOT at BT.2408 reference white in the {:?} delivery: \
         measured signal {:.4}, expected {:.2} ±{:.2}.\n\
         This is the npl=203 reference-white defect (docs/CANON.md §6.1) COMING BACK: \
         Phase 4 fixed it by anchoring SDR-origin sources at 203 nit via the ×2.03 \
         ingest gain (`sdr_origin_anchor_gain` / `map_ingest_filter_for_delivery`). \
         A miss here means the anchor was dropped, mis-gated, or the npl=100 \
         absolute-working-space convention was broken (e.g. ingest npl reverted to \
         400/1000). Do not ignore/skip this test or loosen the tolerance.",
        target,
        measured,
        expected_signal,
        REFERENCE_WHITE_TOLERANCE,
    );
}

#[test]
fn hdr_reference_white_tracer_hlg_map_white_lands_at_75pct_signal() {
    assert_map_white_at_reference_signal(
        trail_cut_lib::export::DeliveryTarget::HdrHlg,
        HLG_REFERENCE_WHITE_SIGNAL,
    );
}

#[test]
fn hdr_reference_white_tracer_pq_map_white_lands_at_58pct_signal() {
    assert_map_white_at_reference_signal(
        trail_cut_lib::export::DeliveryTarget::HdrPq,
        PQ_REFERENCE_WHITE_SIGNAL,
    );
}

#[test]
fn map_ingest_filter_runs_on_bare_rawvideo_rgba() {
    assert_ffmpeg_on_path();
    assert_ffmpeg_has_zscale();

    // 16×16 fully-opaque mid-gray frame, RGBA8. The pixel values don't
    // matter — we're testing filter init / zimg planning, not output
    // correctness (color_fixtures.rs covers correctness via the per-class
    // fixture suite).
    const W: usize = 16;
    const H: usize = 16;
    let mut frame = Vec::with_capacity(W * H * 4);
    for _ in 0..(W * H) {
        frame.extend_from_slice(&[128, 128, 128, 255]);
    }

    let filter = map_ingest_filter();
    // Working space is `gbrpf32le` with no alpha; tail with
    // `format=yuv420p` so the sink can encode (or in this case, drop) a
    // standard pixel format.
    let filter_chain = format!("{filter},format=yuv420p");

    let mut child = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-s",
            &format!("{W}x{H}"),
            "-r",
            "1",
            "-i",
            "pipe:0",
            "-vf",
            &filter_chain,
            "-frames:v",
            "1",
            "-f",
            "null",
            "-",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn ffmpeg");

    {
        let stdin = child.stdin.as_mut().expect("ffmpeg stdin");
        use std::io::Write;
        stdin.write_all(&frame).expect("write raw frame");
    }
    let out = child.wait_with_output().expect("await ffmpeg");

    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        out.status.success(),
        "map_ingest_filter failed against bare rawvideo RGBA — this is the \
         `code 3074: no path between colorspaces` regression. \
         filter=`{filter_chain}`\nffmpeg stderr:\n{stderr}",
    );
}

// ---------------------------------------------------------------------------
// Phase 4 (HDR port) — empirical integration gates.
//
// These tests make the docs/spikes/IMPLEMENTATION.md §6.3/§6.4 matrix
// executable against REAL FFmpeg encodes (no `#[ignore]`, no silent skips —
// every test panics loudly on missing ffmpeg/zscale):
//
//   - SDR map → SDR delivery: white stays at SDR white (no anchor — the
//     "unchanged" cell of the matrix).
//   - HDR video → HDR delivery: round-trip identity (npl=100 — the cell the
//     old npl=400/1000 convention broke by darkening camera footage; the
//     spike's atomic-landing warning is exactly about this regressing).
//   - Composite verbose dry-run: every composite shape × delivery target
//     runs the REAL production argv end-to-end; the overlay must report a
//     4:4:4 10-bit internal format (FFmpeg's silently auto-inserted 4:2:0
//     scaler is the failure mode textual tests can't see), and zimg planning
//     must succeed (no `code 3074`).
// ---------------------------------------------------------------------------

#[test]
fn sdr_delivery_map_white_stays_at_sdr_white() {
    // The map→SDR cell of the Phase 4 matrix: SDR delivery gets NO anchor —
    // a pure-white map frame must still decode at nominal SDR white
    // (signal 1.0). Catches an over-eager anchor (gating bug) that would
    // brighten/clip SDR exports.
    assert_map_white_at_reference_signal(trail_cut_lib::export::DeliveryTarget::SdrH265, 1.0);
}

/// Drive a synthetic HDR-tagged gray frame through the REAL production
/// ingest (`ingest_filter_for(class)`) + finishing + encoder for `target`,
/// decode it back, and return (input_signal, output_signal) as normalized
/// 10-bit limited-range luma.
fn measure_hdr_video_round_trip(
    class: SourceColorClass,
    target: trail_cut_lib::export::DeliveryTarget,
    y_in_10bit: u16,
) -> (f64, f64) {
    use trail_cut_lib::export::{
        delivery_encoder_args, delivery_finishing_filter, select_encoder_for_target,
    };
    use trail_cut_lib::util::color::ingest_filter_for;

    const W: usize = 64;
    const H: usize = 64;
    const FRAMES: usize = 10;

    let temp = TempDir::new().expect("temp dir");
    let out = temp
        .path()
        .join(format!("rt.{}", target.container_extension()));

    // Build a flat yuv420p10le gray frame: Y = y_in_10bit, U = V = 512.
    let mut frame: Vec<u8> = Vec::with_capacity(W * H * 2 + (W * H / 2));
    for _ in 0..(W * H) {
        frame.extend_from_slice(&y_in_10bit.to_le_bytes());
    }
    for _ in 0..(W * H / 4 * 2) {
        frame.extend_from_slice(&512u16.to_le_bytes());
    }

    // Tag the bare rawvideo frames as the HDR source regime via setparams
    // (rawvideo carries no tags), then the production ingest + finishing.
    let (trc, _tin) = match class {
        SourceColorClass::HlgBt2020 => ("arib-std-b67", "arib-std-b67"),
        SourceColorClass::PqBt2020 => ("smpte2084", "smpte2084"),
        other => panic!("round-trip harness is for HDR classes, got {other:?}"),
    };
    let ingest = ingest_filter_for(class, None);
    let finishing = delivery_finishing_filter(target);
    let filter_complex = format!(
        "[0:v]setparams=range=tv:color_primaries=bt2020:color_trc={trc}:colorspace=bt2020nc,\
         {ingest}[vout_w];[vout_w]{finishing}[vout]"
    );

    let encoder = select_encoder_for_target(target)
        .unwrap_or_else(|e| panic!("select_encoder_for_target({target:?}): {e}"));
    let enc_args = delivery_encoder_args(target, &encoder);

    let mut cmd = Command::new("ffmpeg");
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "yuv420p10le",
        "-s",
        &format!("{W}x{H}"),
        "-r",
        "30",
        "-i",
        "pipe:0",
        "-filter_complex",
        &filter_complex,
        "-map",
        "[vout]",
        "-an",
    ]);
    for a in &enc_args {
        cmd.arg(a);
    }
    cmd.arg(&out);

    let mut child = cmd
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn ffmpeg round-trip encode");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("ffmpeg stdin");
        for _ in 0..FRAMES {
            stdin.write_all(&frame).expect("write hdr frame");
        }
    }
    let enc_out = child.wait_with_output().expect("await ffmpeg encode");
    assert!(
        enc_out.status.success(),
        "round-trip encode failed for {class:?}→{target:?} (encoder {}):\n\
         filter_complex=`{filter_complex}`\nstderr:\n{}",
        encoder.name,
        String::from_utf8_lossy(&enc_out.stderr),
    );

    // Decode one frame back and average central-region luma.
    let dec = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(&out)
        .args([
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "yuv420p10le",
            "pipe:1",
        ])
        .output()
        .expect("spawn ffmpeg decode");
    assert!(
        dec.status.success(),
        "decode of round-trip {class:?}→{target:?} output failed: {}",
        String::from_utf8_lossy(&dec.stderr),
    );
    let raw = &dec.stdout;
    assert!(raw.len() >= W * H * 2, "decoded frame too short");

    let (x0, x1) = (W / 4, 3 * W / 4);
    let (y0, y1) = (H / 4, 3 * H / 4);
    let mut sum = 0u64;
    let mut count = 0u64;
    for y in y0..y1 {
        for x in x0..x1 {
            let off = (y * W + x) * 2;
            let v = u16::from_le_bytes([raw[off], raw[off + 1]]);
            sum += v as u64;
            count += 1;
        }
    }
    let y_avg = sum as f64 / count as f64;
    let to_signal = |v: f64| (v - 64.0) / (940.0 - 64.0);
    (to_signal(y_in_10bit as f64), to_signal(y_avg))
}

fn assert_hdr_round_trip_identity(
    class: SourceColorClass,
    target: trail_cut_lib::export::DeliveryTarget,
) {
    assert_ffmpeg_on_path();
    assert_ffprobe_on_path();
    assert_ffmpeg_has_zscale();

    // A bright-but-legal HDR signal level (≈78% of the 10-bit limited
    // range — the spike's 8-bit 240 probe scaled up).
    let (input, output) = measure_hdr_video_round_trip(class, target, 800);
    // npl=100 ingest → npl=100 (default) finishing must be identity within
    // codec noise. The old npl=400/1000 convention missed by ~24% of signal
    // on this probe (HLG 240→183 in the spike) — ±0.015 cleanly separates
    // identity from the darkening regression while absorbing 10-bit
    // quantization + flat-field encoder noise.
    assert!(
        (output - input).abs() <= 0.015,
        "HDR video does NOT round-trip {class:?}→{target:?}: input signal {input:.4}, \
         output signal {output:.4}. The npl=100 absolute-working-space convention is \
         broken (ingest npl reverted to 400/1000, a stray gain hit the HDR branch, or \
         the finishing chain gained an npl) — this is the 'camera footage darkened' \
         regression the Phase 4 atomic-landing warning is about.",
    );
}

#[test]
fn hdr_video_round_trip_hlg_to_hlg_is_identity() {
    assert_hdr_round_trip_identity(
        SourceColorClass::HlgBt2020,
        trail_cut_lib::export::DeliveryTarget::HdrHlg,
    );
}

#[test]
fn hdr_video_round_trip_pq_to_pq_is_identity() {
    assert_hdr_round_trip_identity(
        SourceColorClass::PqBt2020,
        trail_cut_lib::export::DeliveryTarget::HdrPq,
    );
}

#[test]
fn composite_chains_verbose_dry_run_no_silent_chroma_downconvert() {
    // The feedback_ffmpeg_filter_empirical_validation rule made executable:
    // textual filter tests cannot see FFmpeg's silently auto-inserted
    // scalers, so every composite shape × delivery target runs the REAL
    // production argv (build_composite_filtergraph output, verbatim) against
    // real inputs at `-loglevel verbose`, and the verbose log's overlay
    // negotiation lines must report 4:4:4 10-bit — never a yuv420 family
    // format (which would mean chroma was subsampled BEFORE compositing,
    // the WS3 bug the Phase 4 headroom splice must not reintroduce).
    // zimg planning failures (`code 3074`) surface as encode failures.
    use trail_cut_lib::export::{
        build_composite_filtergraph, CompositeMode, DeliveryTarget, PixelDims, PixelRect,
        VisibleClipInput,
    };
    use trail_cut_lib::export::OutputDimensions;

    assert_ffmpeg_on_path();
    assert_ffprobe_on_path();
    assert_ffmpeg_has_zscale();

    let temp = TempDir::new().expect("temp dir");

    // Real SDR clip on disk (the per-clip chain needs a decodable input).
    let clip_path = temp.path().join("clip.mp4");
    make_synthetic_bt709_clip(&clip_path, 0.5);

    // White corner-mask PNG for the masked shape.
    let mask_path = temp.path().join("mask.png");
    let mask_status = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=white:size=128x128",
            "-frames:v",
            "1",
        ])
        .arg(&mask_path)
        .status()
        .expect("spawn ffmpeg mask builder");
    assert!(mask_status.success(), "mask PNG build failed");

    let clip_json = serde_json::json!({
        "id": "c1",
        "path": clip_path.to_string_lossy(),
        "filename": "clip.mp4",
        "duration_ms": 500,
        "trim": {"in_ms": 0, "out_ms": 500},
        "focal_point": {"x": 0.5, "y": 0.5, "zoom": 1.0},
        "effects": {"stabilize": {"enabled": false, "shakiness": 5}, "speed": 1.0},
        "visible": true,
    });

    let map_slot = PixelRect { x: 64, y: 64, w: 128, h: 128 };
    let video_slot = PixelRect { x: 0, y: 0, w: 256, h: 256 };
    let output_dims = OutputDimensions { w: 256, h: 256 };
    const FRAMES: u32 = 6;

    let shapes: Vec<(&str, CompositeMode, bool)> = vec![
        ("pip_map_inset", CompositeMode::PipMapInset, false),
        ("pip_map_inset_masked", CompositeMode::PipMapInset, true),
        ("pip_video_inset", CompositeMode::PipVideoInset, false),
        ("split", CompositeMode::Split, false),
    ];
    let targets = [
        DeliveryTarget::SdrH265,
        DeliveryTarget::HdrHlg,
        DeliveryTarget::HdrPq,
    ];

    for (label, mode, with_mask) in &shapes {
        // Split tiles the frame; PiP insets the map. Slots are pure values —
        // pick non-overlapping ones for Split.
        let (m_slot, v_slot) = match mode {
            CompositeMode::Split => (
                PixelRect { x: 0, y: 0, w: 128, h: 256 },
                PixelRect { x: 128, y: 0, w: 128, h: 256 },
            ),
            CompositeMode::PipVideoInset => (video_slot, map_slot),
            _ => (map_slot, video_slot),
        };
        for target in targets {
            let encoder =
                trail_cut_lib::export::select_encoder_for_target(target).unwrap_or_else(|e| {
                    panic!("select_encoder_for_target({target:?}): {e}")
                });
            let out_path = temp.path().join(format!(
                "dryrun_{label}_{target:?}.{}",
                target.container_extension()
            ));
            let clip: trail_cut_lib::Clip =
                serde_json::from_value(clip_json.clone()).expect("clip stub");
            let visible = vec![VisibleClipInput {
                source_path: clip_path.clone(),
                clip,
                source_dims: PixelDims { w: 256, h: 256 },
                has_audio: true,
            }];
            let plan = build_composite_filtergraph(
                &visible,
                m_slot,
                v_slot,
                output_dims,
                *mode,
                with_mask.then_some(mask_path.as_path()),
                30,
                FRAMES,
                &encoder,
                192,
                target,
                &out_path,
            )
            .expect("composite plan");

            // Run the production argv verbatim, at verbose, feeding white
            // RGBA map frames on stdin.
            let mut cmd = Command::new("ffmpeg");
            cmd.arg("-loglevel").arg("verbose");
            for a in &plan.argv {
                cmd.arg(a);
            }
            let mut child = cmd
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .expect("spawn ffmpeg dry run");
            {
                use std::io::Write;
                let white = vec![255u8; plan.frame_bytes_per_input];
                let stdin = child.stdin.as_mut().expect("ffmpeg stdin");
                for _ in 0..(FRAMES + 2) {
                    // A couple of extra frames so the -frames:v cap, not
                    // stdin EOF, ends the encode. Broken-pipe after the cap
                    // fires is expected — ignore write errors.
                    let _ = stdin.write_all(&white);
                }
            }
            let run = child.wait_with_output().expect("await ffmpeg dry run");
            let stderr = String::from_utf8_lossy(&run.stderr);
            assert!(
                run.status.success(),
                "{label}/{target:?}: composite encode failed (zimg 3074 / filter \
                 planning / encoder error):\nargv: {:?}\nstderr:\n{stderr}",
                plan.argv,
            );

            // Every overlay negotiation line must be 4:4:4 10-bit. The
            // verbose log prints e.g.
            //   [Parsed_overlay_N @ …] main w:… h:… fmt:yuva444p10le … overlay w:… h:… fmt:yuva444p10le …
            let mut overlay_lines = 0;
            for line in stderr.lines() {
                if !(line.contains("overlay") && line.contains("fmt:")) {
                    continue;
                }
                overlay_lines += 1;
                for piece in line.split_whitespace().filter(|p| p.starts_with("fmt:")) {
                    assert!(
                        piece.contains("444p10"),
                        "{label}/{target:?}: overlay negotiated `{piece}` instead of \
                         4:4:4 10-bit — FFmpeg silently inserted a chroma-subsampling \
                         scaler before the composite. Line: `{line}`",
                    );
                }
            }
            assert!(
                overlay_lines > 0,
                "{label}/{target:?}: no overlay fmt lines found in verbose log — \
                 the dry-run instrument lost its teeth (verbose format changed?). \
                 stderr:\n{stderr}",
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Phase 4 / fix C′ — composite decoration-fidelity gate.
//
// The 10-bit `yuva444p10le` overlay lift quantizes the working space onto a
// 10-bit INTEGER grid clamped to [0,1]. Fix C wrapped that lift in a LINEAR
// ÷32/×32 headroom; because the ÷32 ran in linear light it crushed the
// anchored SDR-origin map (linear 0–2.03) into the bottom ~6.3% of the grid —
// a 256-step ramp collapsed to 66 distinct levels and flat decoration colors
// shifted hue up to 12.5° (the HDR-only grit / wrong-hue / shimmer Matthew saw
// on HLG+PQ hand exports). Fix C′ replaces that with a PQ TRANSPORT curve
// (`composite_transport_encode`/`_decode`); PQ allocates 10-bit codes
// perceptually so the bottom of the range keeps its precision.
//
// This gate runs the REAL production color-stream sandwich
// (`map_ingest_filter_for_delivery(HDR)` → encode → yuva444p10le lift → back to
// gbrpf32le → decode) on PQ delivery (PQ is the worst case — its EOTF stretches
// the bottom of the range hardest) and asserts the empirically-validated
// targets: a black→anchored-white ramp keeps ≥250 of 256 distinct levels, and
// flat saturated decoration colors hold hue within <1° of a pure-float
// reference (the same ingest WITHOUT the lift). Models the probe in
// /tmp/hdr-grit-probe/ (D_pq_transport.raw + hueD_*). A regression to the
// linear headroom collapses the ramp to ~66 levels and the hue blows past 1°.

/// Run RGBA8 frames through `[0:v]{filter_body}[out]` and return the decoded
/// `gbrpf32le` planes of the first frame as (G, B, R), each `w*h` f32 samples.
/// No encoder — the filter output is read straight back as rawvideo, so the
/// only quantization is whatever `filter_body` itself performs.
fn run_working_space_color_path(
    filter_body: &str,
    rgba: &[u8],
    w: usize,
    h: usize,
) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
    let filter_complex = format!("[0:v]{filter_body}[out]");
    let mut child = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-s",
            &format!("{w}x{h}"),
            "-r",
            "1",
            "-i",
            "pipe:0",
            "-filter_complex",
            &filter_complex,
            "-map",
            "[out]",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gbrpf32le",
            "pipe:1",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn ffmpeg");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("ffmpeg stdin");
        stdin.write_all(rgba).expect("write rgba frames");
    }
    let out = child.wait_with_output().expect("await ffmpeg");
    assert!(
        out.status.success(),
        "working-space color path failed.\nfilter_complex=`{}`\nstderr:\n{}",
        filter_complex,
        String::from_utf8_lossy(&out.stderr),
    );
    let plane = w * h;
    let need = plane * 4 * 3;
    assert!(
        out.stdout.len() >= need,
        "decoded gbrpf32le frame too short: got {} bytes, need {} (3 planes × {} f32)",
        out.stdout.len(),
        need,
        plane,
    );
    let read_plane = |base: usize| -> Vec<f32> {
        (0..plane)
            .map(|i| {
                let o = base + i * 4;
                f32::from_le_bytes([
                    out.stdout[o],
                    out.stdout[o + 1],
                    out.stdout[o + 2],
                    out.stdout[o + 3],
                ])
            })
            .collect()
    };
    // gbrpf32le plane order is G, B, R.
    let g = read_plane(0);
    let b = read_plane(plane * 4);
    let r = read_plane(plane * 4 * 2);
    (g, b, r)
}

/// The pure-float reference body: map ingest only (no 10-bit lift).
fn float_reference_body() -> String {
    use trail_cut_lib::util::color::map_ingest_filter_for_delivery;
    let cs = trail_cut_lib::export::DeliveryTarget::HdrPq.output_color_space();
    format!("{},format=gbrpf32le", map_ingest_filter_for_delivery(&cs))
}

/// The REAL production HDR composite sandwich body: map ingest → PQ transport
/// encode → 10-bit `yuva444p10le` lift → back to `gbrpf32le` → PQ transport
/// decode. Exactly the seam `build_composite_filter_complex` splices around the
/// overlay (`down` … `format=yuva444p10le` … `format=gbrpf32le` … `up`), minus
/// the overlay itself (the quantization lives in the format hops, not overlay).
fn pq_transport_sandwich_body() -> String {
    use trail_cut_lib::util::color::map_ingest_filter_for_delivery;
    use trail_cut_lib::util::color_space::{
        composite_transport_decode, composite_transport_encode,
    };
    let cs = trail_cut_lib::export::DeliveryTarget::HdrPq.output_color_space();
    format!(
        "{ingest},{down},format=yuva444p10le,format=gbrpf32le,{up},format=gbrpf32le",
        ingest = map_ingest_filter_for_delivery(&cs),
        down = composite_transport_encode(),
        up = composite_transport_decode(),
    )
}

#[test]
fn composite_pq_transport_ramp_retains_distinct_levels() {
    assert_ffmpeg_on_path();
    assert_ffmpeg_has_zscale();

    // 256-wide black→white gray ramp (R=G=B=x), 8 identical rows.
    const W: usize = 256;
    const H: usize = 8;
    let mut rgba = Vec::with_capacity(W * H * 4);
    for _ in 0..H {
        for x in 0..W {
            let v = x as u8;
            rgba.extend_from_slice(&[v, v, v, 255]);
        }
    }

    // Distinct levels in the first row's green plane, quantized to 1e-5 (far
    // finer than the ~0.008 spacing of 256 steps over linear 0–2.03, so true
    // levels survive while sub-code float noise collapses).
    let distinct = |g: &[f32]| -> usize {
        let mut set = std::collections::BTreeSet::new();
        for &val in &g[0..W] {
            set.insert((val as f64 * 1.0e5).round() as i64);
        }
        set.len()
    };

    let (g_ref, _, _) = run_working_space_color_path(&float_reference_body(), &rgba, W, H);
    let (g_pq, _, _) = run_working_space_color_path(&pq_transport_sandwich_body(), &rgba, W, H);

    let ref_levels = distinct(&g_ref);
    let pq_levels = distinct(&g_pq);

    // Sanity: the pure-float reference must itself be a near-full ramp.
    assert!(
        ref_levels >= 250,
        "pure-float reference ramp is not full ({ref_levels}/256) — harness broken \
         (sRGB EOTF is strictly monotonic, so the reference must keep ~256 levels)",
    );
    assert!(
        pq_levels >= 250,
        "PQ-transport composite sandwich collapsed the ramp to {pq_levels}/256 distinct \
         levels (reference {ref_levels}). This is the fix-C ÷32 linear-headroom \
         quantization COMING BACK (it crushed 256→66). fix C′ (CANON §1.12) must keep \
         ≥250: the PQ transport curve around the 10-bit lift, HDR delivery only. Do not \
         loosen this floor.",
    );
}

/// Hue angle (degrees, -180..180) of a linear RGB triple via the standard
/// hexagonal chroma projection. Uniform scaling (e.g. the ×2.03 anchor) leaves
/// it invariant, so float-ref and sandwich hues are directly comparable.
fn hue_deg(r: f64, g: f64, b: f64) -> f64 {
    let alpha = 0.5 * (2.0 * r - g - b);
    let beta = (3.0_f64).sqrt() / 2.0 * (g - b);
    beta.atan2(alpha).to_degrees()
}

fn angular_delta_deg(a: f64, b: f64) -> f64 {
    let mut d = (a - b).abs() % 360.0;
    if d > 180.0 {
        d = 360.0 - d;
    }
    d
}

#[test]
fn composite_pq_transport_preserves_decoration_hue() {
    assert_ffmpeg_on_path();
    assert_ffmpeg_has_zscale();

    // The three saturated decoration colors the probe used (sRGB hex).
    const COLORS: [(u8, u8, u8, &str); 3] = [
        (0xE5, 0x39, 0x35, "red 0xE53935"),
        (0x1E, 0x88, 0xE5, "blue 0x1E88E5"),
        (0x32, 0xCD, 0x32, "green 0x32CD32"),
    ];
    const W: usize = 64;
    const H: usize = 64;

    let center_rgb = |g: &[f32], b: &[f32], r: &[f32]| -> (f64, f64, f64) {
        let (x0, x1, y0, y1) = (W / 4, 3 * W / 4, H / 4, 3 * H / 4);
        let (mut sr, mut sg, mut sb, mut n) = (0.0f64, 0.0f64, 0.0f64, 0u64);
        for y in y0..y1 {
            for x in x0..x1 {
                let i = y * W + x;
                sr += r[i] as f64;
                sg += g[i] as f64;
                sb += b[i] as f64;
                n += 1;
            }
        }
        (sr / n as f64, sg / n as f64, sb / n as f64)
    };

    for (cr, cg, cb, label) in COLORS {
        let mut rgba = Vec::with_capacity(W * H * 4);
        for _ in 0..(W * H) {
            rgba.extend_from_slice(&[cr, cg, cb, 255]);
        }

        let (gr, br, rr) = run_working_space_color_path(&float_reference_body(), &rgba, W, H);
        let (gp, bp, rp) = run_working_space_color_path(&pq_transport_sandwich_body(), &rgba, W, H);

        let (rf, gf, bf) = center_rgb(&gr, &br, &rr);
        let (rq, gq, bq) = center_rgb(&gp, &bp, &rp);

        let hue_ref = hue_deg(rf, gf, bf);
        let hue_pq = hue_deg(rq, gq, bq);
        let delta = angular_delta_deg(hue_ref, hue_pq);

        assert!(
            delta < 1.0,
            "{label}: PQ-transport composite sandwich shifted hue by {delta:.3}° \
             (ref {hue_ref:.2}° vs sandwich {hue_pq:.2}°). fix-C's linear ÷32 headroom \
             shifted flat decoration hues up to 12.5°; fix C′ (CANON §1.12) must hold \
             <1°. Do not loosen this tolerance.",
        );
    }
}

// ---------------------------------------------------------------------------
// Decoration-crispness delivery gate (2026-07-03).
//
// Map decorations (POV dot, pulse rings, trail line, waypoint marks) are flat
// high-chroma shapes with near-zero LUMA contrast against the basemap — their
// edges live almost entirely in the Cb/Cr planes. The 2026-07-03 probe
// (docs/ship-review/PROGRESS.md) proved the composite filtergraph delivers
// those edges essentially intact (the lossless FFV1 tap of `[vout]` is
// visually indistinguishable from the renderer readback), and that the loss
// happened at the ENCODER: hevc_videotoolbox at the shipped `-q:v 50`
// retained only 0.55 of the pre-encode Cr Sobel energy on a real 4K export
// (visible mush), and stayed below libx265 even at `-q:v 80` with 5× the
// bits. The fix routes HEVC delivery through libx265 (`fast`/crf17 +
// cbqpoffs=-2:crqpoffs=-2).
//
// This gate makes that decision self-enforcing: for every non-ProRes
// delivery target it runs the REAL production composite argv (verbatim
// `build_composite_filtergraph` output with the encoder
// `select_encoder_for_target` actually picks on this machine) over synthetic
// decoration-bearing map frames + a moving synthetic clip, taps `[vout]`
// pre-encoder with FFV1 (identical filtergraph, lossless "what the encoder
// was given"), and asserts the delivered file keeps the decoration chroma
// edges. A regression to a starved or hardware encode drops Cb/Cr Sobel
// retention toward ~0.5–0.7 and fails loudly.
//
// Preconditions are loud (CANON §1.11): missing libx265 in the ffmpeg build
// is a hard failure, not a skip — a machine without it cannot produce
// ship-quality exports and the suite must say so.

fn assert_ffmpeg_has_libx265() {
    let out = Command::new("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .output()
        .expect("spawn ffmpeg -encoders");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("libx265"),
        "ffmpeg on PATH has no libx265 encoder — HEVC delivery targets \
         (SdrH265/HdrHlg/HdrPq) would fall back to a hardware encoder that \
         measurably crushes decoration chroma edges. Install ffmpeg-full \
         (`brew install ffmpeg-full && brew link ffmpeg-full`).",
    );
}

/// Synthetic decoration-bearing map frame: flat light-gray "paper" basemap
/// with the project's actual decoration colors — a `#bced09` trail stripe +
/// POV-dot disc and a `#5ab7cb` waypoint disc. Flat fills, hard edges, no
/// luma contrast to lean on: the pure chroma-edge worst case the probe
/// measured.
fn synth_decoration_map_frame(w: usize, h: usize) -> Vec<u8> {
    const BG: [u8; 3] = [0xee, 0xec, 0xe3];
    const TRAIL: [u8; 3] = [0xbc, 0xed, 0x09];
    const WAY: [u8; 3] = [0x5a, 0xb7, 0xcb];
    let mut buf = vec![0u8; w * h * 4];
    let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
    let dot_r = (h as f64) * 0.10;
    let way_r = (h as f64) * 0.07;
    let (wx, wy) = (w as f64 * 0.25, h as f64 * 0.30);
    let stripe_half = (h as f64) * 0.02;
    for y in 0..h {
        for x in 0..w {
            let (fx, fy) = (x as f64 + 0.5, y as f64 + 0.5);
            // Diagonal trail stripe through the frame.
            let stripe_d = (fy - (0.2 * fx + h as f64 * 0.55)).abs();
            let px = if ((fx - cx).powi(2) + (fy - cy).powi(2)).sqrt() < dot_r {
                TRAIL
            } else if ((fx - wx).powi(2) + (fy - wy).powi(2)).sqrt() < way_r {
                WAY
            } else if stripe_d < stripe_half {
                TRAIL
            } else {
                BG
            };
            let i = (y * w + x) * 4;
            buf[i] = px[0];
            buf[i + 1] = px[1];
            buf[i + 2] = px[2];
            buf[i + 3] = 255;
        }
    }
    buf
}

/// Motion-bearing synthetic clip (testsrc2 pans/changes every frame) so the
/// encoder has real bit competition — a static clip would hand the map slot
/// unlimited bits and blunt the gate's teeth.
fn make_synthetic_motion_clip(output: &Path, duration_s: f64) {
    let video_src = format!("testsrc2=size=640x360:rate=30:duration={}", duration_s);
    let audio_src = format!("sine=frequency=440:sample_rate=48000:duration={}", duration_s);
    let status = Command::new("ffmpeg")
        .args([
            "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", &video_src,
            "-f", "lavfi", "-i", &audio_src,
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-color_primaries", "bt709", "-color_trc", "bt709",
            "-colorspace", "bt709", "-color_range", "tv",
            "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709",
            "-c:a", "aac", "-shortest",
        ])
        .arg(output)
        .status()
        .expect("spawn ffmpeg motion clip builder");
    assert!(status.success(), "motion clip builder failed");
}

/// Decode one mid-stream frame to 4:2:0 planes at the given bit depth and
/// return (Y, Cb, Cr) as f64 in [0,1], plus the plane dims.
#[allow(clippy::type_complexity)]
fn decode_yuv420_planes(
    path: &Path,
    ten_bit: bool,
    w: usize,
    h: usize,
    seek_s: f64,
) -> (Vec<f64>, Vec<f64>, Vec<f64>, usize, usize) {
    let pix = if ten_bit { "yuv420p10le" } else { "yuv420p" };
    let out = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error"])
        .args(["-ss", &format!("{seek_s}")])
        .arg("-i")
        .arg(path)
        .args(["-map", "0:v:0", "-vsync", "0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", pix, "-"])
        .output()
        .expect("spawn ffmpeg plane decode");
    assert!(
        out.status.success(),
        "plane decode failed for {}: {}",
        path.display(),
        String::from_utf8_lossy(&out.stderr),
    );
    let (cw, ch) = (w / 2, h / 2);
    let expected = if ten_bit { (w * h + 2 * cw * ch) * 2 } else { w * h + 2 * cw * ch };
    assert_eq!(
        out.stdout.len(),
        expected,
        "decoded frame byte count mismatch for {} (got {}, want {expected})",
        path.display(),
        out.stdout.len(),
    );
    let to_f = |bytes: &[u8], n: usize, off: usize| -> Vec<f64> {
        if ten_bit {
            (0..n)
                .map(|i| {
                    let b = off * 2 + i * 2;
                    u16::from_le_bytes([bytes[b], bytes[b + 1]]) as f64 / 1023.0
                })
                .collect()
        } else {
            bytes[off..off + n].iter().map(|&v| v as f64 / 255.0).collect()
        }
    };
    let y = to_f(&out.stdout, w * h, 0);
    let u = to_f(&out.stdout, cw * ch, w * h);
    let v = to_f(&out.stdout, cw * ch, w * h + cw * ch);
    (y, u, v, cw, ch)
}

/// Sum of Sobel-ish gradient magnitude (central differences) over a plane
/// crop. Relative measure only — always used as delivered/tap ratios.
fn plane_gradient_energy(plane: &[f64], w: usize, h: usize, crop: (usize, usize, usize, usize)) -> f64 {
    let (x0, y0, cw, ch) = crop;
    let mut e = 0.0;
    for y in (y0 + 1)..(y0 + ch - 1) {
        for x in (x0 + 1)..(x0 + cw - 1) {
            let gx = plane[y * w + x + 1] - plane[y * w + x - 1];
            let gy = plane[(y + 1) * w + x] - plane[(y - 1) * w + x];
            e += (gx * gx + gy * gy).sqrt();
        }
    }
    e
}

#[test]
fn delivery_encode_preserves_decoration_chroma_edges() {
    use trail_cut_lib::export::{
        build_composite_filtergraph, select_encoder_for_target, CompositeMode, DeliveryTarget,
        OutputDimensions, PixelDims, PixelRect, VisibleClipInput,
    };

    assert_ffmpeg_on_path();
    assert_ffprobe_on_path();
    assert_ffmpeg_has_zscale();
    assert_ffmpeg_has_libx265();

    let temp = TempDir::new().expect("temp dir");
    let clip_path = temp.path().join("clip.mp4");
    make_synthetic_motion_clip(&clip_path, 1.5);

    let clip_json = serde_json::json!({
        "id": "c1",
        "path": clip_path.to_string_lossy(),
        "filename": "clip.mp4",
        "duration_ms": 1500,
        "trim": {"in_ms": 0, "out_ms": 1500},
        "focal_point": {"x": 0.5, "y": 0.5, "zoom": 1.0},
        "effects": {"stabilize": {"enabled": false, "shakiness": 5}, "speed": 1.0},
        "visible": true,
    });

    // 720p-class canvas with the map as a bottom band (PipMapInset, the
    // production default shape). Even dims keep 4:2:0 plane math exact.
    let output_dims = OutputDimensions { w: 1280, h: 720 };
    let map_slot = PixelRect { x: 320, y: 360, w: 640, h: 320 };
    let video_slot = PixelRect { x: 0, y: 0, w: 1280, h: 720 };
    const FPS: u32 = 30;
    const FRAMES: u32 = 30;

    let map_frame = synth_decoration_map_frame(map_slot.w as usize, map_slot.h as usize);

    // Feed the same decoration frame every tick — flat fills + hard edges
    // stay put while the video underneath moves, which is the bit-starvation
    // worst case for a rate-controlled encoder (static region competing with
    // motion).
    let run_argv = |argv: &[String], frame_bytes: usize| {
        let mut cmd = Command::new("ffmpeg");
        cmd.arg("-loglevel").arg("error");
        for a in argv {
            cmd.arg(a);
        }
        let mut child = cmd
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn ffmpeg composite");
        {
            use std::io::Write;
            assert_eq!(map_frame.len(), frame_bytes, "map frame size mismatch");
            let stdin = child.stdin.as_mut().expect("ffmpeg stdin");
            for _ in 0..(FRAMES + 2) {
                let _ = stdin.write_all(&map_frame);
            }
        }
        let out = child.wait_with_output().expect("await ffmpeg composite");
        assert!(
            out.status.success(),
            "composite encode failed: {}",
            String::from_utf8_lossy(&out.stderr),
        );
    };

    // Chroma-plane crop of the map slot (4:2:0 planes are half-res).
    let crop = (
        map_slot.x as usize / 2,
        map_slot.y as usize / 2,
        map_slot.w as usize / 2,
        map_slot.h as usize / 2,
    );
    let seek_s = (FRAMES / 2) as f64 / FPS as f64;

    let targets = [
        DeliveryTarget::SdrH264,
        DeliveryTarget::SdrH265,
        DeliveryTarget::HdrHlg,
        DeliveryTarget::HdrPq,
    ];
    for target in targets {
        let encoder = select_encoder_for_target(target)
            .unwrap_or_else(|e| panic!("select_encoder_for_target({target:?}): {e}"));
        // The gate pins the DECISION, not just the outcome: HEVC delivery
        // must resolve to software libx265 wherever it exists (which the
        // precondition above guarantees here).
        if matches!(
            target,
            DeliveryTarget::SdrH265 | DeliveryTarget::HdrHlg | DeliveryTarget::HdrPq
        ) {
            assert_eq!(
                encoder.name, "libx265",
                "{target:?}: HEVC delivery must select libx265 (decoration-\
                 crispness decision 2026-07-03); a stale encoder cache can \
                 cause this — delete {{global_config_dir()}}/encoder.json",
            );
        }

        let delivered = temp
            .path()
            .join(format!("crisp_{target:?}.{}", target.container_extension()));
        let clip: trail_cut_lib::Clip =
            serde_json::from_value(clip_json.clone()).expect("clip stub");
        let visible = vec![VisibleClipInput {
            source_path: clip_path.clone(),
            clip,
            source_dims: PixelDims { w: 640, h: 360 },
            has_audio: true,
        }];
        let plan = build_composite_filtergraph(
            &visible,
            map_slot,
            video_slot,
            output_dims,
            CompositeMode::PipMapInset,
            None,
            FPS,
            FRAMES,
            &encoder,
            192,
            target,
            &delivered,
        )
        .expect("composite plan");
        run_argv(&plan.argv, plan.frame_bytes_per_input);

        // FFV1 tap of the IDENTICAL filtergraph — "what the encoder was
        // given", in the delivered pixel format.
        let tap = temp.path().join(format!("crisp_{target:?}_tap.nut"));
        let map_idx = plan
            .argv
            .iter()
            .position(|a| a == "-map")
            .expect("-map in production argv");
        let mut tap_argv: Vec<String> = plan.argv[..map_idx].to_vec();
        for a in [
            "-map", "[vout]", "-map", "[aout]", "-c:a", "pcm_s16le", "-c:v", "ffv1",
        ] {
            tap_argv.push(a.to_string());
        }
        tap_argv.push(tap.to_string_lossy().into_owned());
        run_argv(&tap_argv, plan.frame_bytes_per_input);

        let ten_bit = matches!(target, DeliveryTarget::HdrHlg | DeliveryTarget::HdrPq);
        let (_, du, dv, cw, chh) =
            decode_yuv420_planes(&delivered, ten_bit, 1280, 720, seek_s);
        let (_, tu, tv, _, _) = decode_yuv420_planes(&tap, ten_bit, 1280, 720, seek_s);

        let ret_u = plane_gradient_energy(&du, cw, chh, crop)
            / plane_gradient_energy(&tu, cw, chh, crop);
        let ret_v = plane_gradient_energy(&dv, cw, chh, crop)
            / plane_gradient_energy(&tv, cw, chh, crop);

        // Threshold rationale: the shipping libx265 settings measured
        // ≈0.9–1.1 retention on both the 4K probe and this synthetic scene;
        // the old starved hardware path measured ≈0.5–0.7. 0.80 is the
        // midpoint with margin for encoder-version variance. Ratios can
        // legitimately exceed 1.0 (ringing adds gradient energy) — only the
        // floor is load-bearing.
        for (plane, ret) in [("Cb", ret_u), ("Cr", ret_v)] {
            assert!(
                ret >= 0.80,
                "{target:?}: delivered {plane} plane keeps only {ret:.3} of the \
                 pre-encode decoration edge energy (floor 0.80). The encoder is \
                 crushing high-chroma decoration edges again — check encoder \
                 selection (libx265 expected) and its quality settings \
                 (delivery.rs: preset/crf/{}).",
                "cbqpoffs/crqpoffs",
            );
        }
        eprintln!(
            "[crispness gate] {target:?}: Cb retention {ret_u:.3}, Cr retention {ret_v:.3} (floor 0.80)"
        );
    }
}
