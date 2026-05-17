// Integration test for the encoder probe + cache (task 040).
//
// Drives `trail_cut_lib::export::probe_all` and `select_encoder` against the
// real `ffmpeg` on PATH. Verifies:
//   - probe returns a working choice for each of Hevc / H264 / ProResAlpha
//   - the cache file is written
//   - a second `select_encoder` call hits the cache (sub-50ms)
//   - mutating `ffmpeg_version` on disk forces a re-probe
//
// PRECONDITION: `ffmpeg -version` must succeed on PATH. The test panics with a
// clear "install ffmpeg" message if it doesn't (mirrors 030's renderer-bundle
// guard so missing-toolchain failures don't masquerade as logic regressions).
//
// To keep the test hermetic, the encoder cache is redirected to a per-test
// tempdir via `set_cache_path_for_test` rather than writing to the user's real
// `~/.trailcut/encoder.json`. The cache-path override is process-global, so
// the assertions live in a single `#[test]` to keep them off cargo's default
// parallel test runner.

use std::path::PathBuf;
use std::process::Command;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use trail_cut_lib::export::{
    probe_all, select_encoder, set_cache_path_for_test, EncoderClass, EncoderKind, EncoderProbe,
};

fn assert_ffmpeg_available() {
    let out = Command::new("ffmpeg").arg("-version").output();
    match out {
        Ok(o) if o.status.success() => {}
        Ok(o) => panic!(
            "`ffmpeg -version` exited non-zero (code {:?}); install via your package manager",
            o.status.code(),
        ),
        Err(e) => panic!(
            "ffmpeg not on PATH ({}). Install with `brew install ffmpeg` (macOS) or your distro's package manager.",
            e
        ),
    }
}

/// Per-test scratch directory under `std::env::temp_dir()`. Avoids a `tempfile`
/// crate dependency (spec: no new deps) while still isolating the test from
/// the user's production cache.
fn scratch_cache_path() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("trailcut-encoder-test-{}", nanos));
    std::fs::create_dir_all(&dir).expect("create scratch dir");
    dir.join("encoder.json")
}

fn assert_choice_macos(probe: &EncoderProbe) {
    let hevc = probe.choices.get(&EncoderClass::Hevc).expect("hevc choice");
    assert!(
        hevc.name == "hevc_videotoolbox" || hevc.name == "libx265",
        "macOS HEVC must be hevc_videotoolbox or libx265, got {}",
        hevc.name
    );
    let h264 = probe.choices.get(&EncoderClass::H264).expect("h264 choice");
    assert!(
        h264.name == "h264_videotoolbox" || h264.name == "libx264",
        "macOS H264 must be h264_videotoolbox or libx264, got {}",
        h264.name
    );
    let prores = probe
        .choices
        .get(&EncoderClass::ProResAlpha)
        .expect("prores choice");
    assert_eq!(prores.name, "prores_ks");
    assert_eq!(prores.kind, EncoderKind::Software);
}

fn assert_choice_linux(probe: &EncoderProbe) {
    let hevc = probe.choices.get(&EncoderClass::Hevc).expect("hevc choice");
    assert_eq!(hevc.name, "libx265");
    let h264 = probe.choices.get(&EncoderClass::H264).expect("h264 choice");
    assert_eq!(h264.name, "libx264");
    let prores = probe
        .choices
        .get(&EncoderClass::ProResAlpha)
        .expect("prores choice");
    assert_eq!(prores.name, "prores_ks");
}

fn assert_wall_clock_sane(probe: &EncoderProbe) {
    for (class, choice) in &probe.choices {
        assert!(
            choice.probe_wall_clock_ms > 0 && choice.probe_wall_clock_ms < 30_000,
            "probe_wall_clock_ms for {:?} out of expected range: {}",
            class,
            choice.probe_wall_clock_ms,
        );
    }
}

#[test]
fn probe_caches_and_reprobes_on_version_mismatch() {
    assert_ffmpeg_available();
    let cache_path = scratch_cache_path();
    set_cache_path_for_test(Some(cache_path.clone()));

    // --- 1. Cold probe yields a choice per class with sane wall-clocks ---
    let probe = probe_all().expect("probe_all should succeed");
    assert!(probe.choices.contains_key(&EncoderClass::Hevc));
    assert!(probe.choices.contains_key(&EncoderClass::H264));
    assert!(probe.choices.contains_key(&EncoderClass::ProResAlpha));
    assert_wall_clock_sane(&probe);
    if cfg!(target_os = "macos") {
        assert_choice_macos(&probe);
    } else if cfg!(target_os = "linux") {
        assert_choice_linux(&probe);
    }

    // --- 2. Cache file lands at the redirected path ---
    assert!(
        cache_path.exists(),
        "cache file should exist at {}",
        cache_path.display()
    );

    // --- 3. Second select_encoder hits the cache (sub-50ms) ---
    let start = Instant::now();
    let choice = select_encoder(EncoderClass::Hevc).expect("cached select");
    let cached_elapsed_ms = start.elapsed().as_millis();
    assert_eq!(choice.class, EncoderClass::Hevc);
    assert!(
        cached_elapsed_ms < 50,
        "cached select_encoder should be <50ms, was {}ms",
        cached_elapsed_ms
    );

    // --- 4. Mutating ffmpeg_version forces a re-probe on next select ---
    let raw = std::fs::read(&cache_path).expect("read cache");
    let mut mutated: EncoderProbe = serde_json::from_slice(&raw).expect("parse cache");
    mutated.ffmpeg_version = "ffmpeg version FAKE_FOR_TEST".to_string();
    mutated.probed_at_unix_ms = 1; // sentinel — re-probe must overwrite
    let mutation_ts_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    std::fs::write(&cache_path, serde_json::to_vec_pretty(&mutated).unwrap())
        .expect("write mutated cache");

    let _ = select_encoder(EncoderClass::Hevc).expect("re-probe on stale cache");

    let raw_after = std::fs::read(&cache_path).expect("read re-probed cache");
    let after: EncoderProbe =
        serde_json::from_slice(&raw_after).expect("parse re-probed cache");
    assert_ne!(
        after.ffmpeg_version, "ffmpeg version FAKE_FOR_TEST",
        "re-probe should have overwritten the fake version"
    );
    assert!(
        after.probed_at_unix_ms >= mutation_ts_ms,
        "fresh probe's probed_at_unix_ms ({}) should be >= mutation timestamp ({})",
        after.probed_at_unix_ms,
        mutation_ts_ms,
    );

    set_cache_path_for_test(None);
}
