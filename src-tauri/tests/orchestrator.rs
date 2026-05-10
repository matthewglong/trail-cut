// Integration test for the export orchestrator (task 030).
//
// Drives the real bundled worker (src-tauri/sidecars/renderer/dist/renderer.cjs)
// through the Rust orchestrator end-to-end. Verifies wire format, frame
// ordering across multiple workers, and the recycle loop.
//
// PRECONDITIONS (run these before `cargo test`):
//   npm run build:renderer
// The build emits BOTH dist/renderer.cjs (the worker) and
// dist/setup_fixture.cjs (the synthetic 1-clip / 2s / 3-trackpoint fixture
// shared with the JS protocol test). The test refuses to run without them.
//
// Test scope is "the orchestrator drives the protocol correctly + ordering
// is preserved across N workers." Visual correctness of map rendering is
// covered by 020's protocol test plus task 120's parity verification.

use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;
use trail_cut_lib::export::{
    render_map_frames, OrchestratorConfig, SetupPayload, VecSink,
};

const VIEWPORT_W: u32 = 540;
const VIEWPORT_H: u32 = 960;
const EXPECTED_FRAME_BYTES: usize = (VIEWPORT_W as usize) * (VIEWPORT_H as usize) * 4;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn renderer_cjs() -> PathBuf {
    manifest_dir()
        .join("sidecars")
        .join("renderer")
        .join("dist")
        .join("renderer.cjs")
}

fn setup_fixture_cjs() -> PathBuf {
    manifest_dir()
        .join("sidecars")
        .join("renderer")
        .join("dist")
        .join("setup_fixture.cjs")
}

/// Invoke the bundled fixture builder via `node`, parse its stdout as JSON.
/// Reuses the same compileTimeline path the JS protocol test uses, so the two
/// test sites can't drift on what "the synthetic fixture" means.
fn build_setup_payload() -> SetupPayload {
    let fixture = setup_fixture_cjs();
    let renderer = renderer_cjs();
    if !fixture.exists() || !renderer.exists() {
        panic!(
            "Renderer bundle artifacts missing. Run `npm run build:renderer` first.\n\
             Expected: {}\n\
             Expected: {}",
            renderer.display(),
            fixture.display(),
        );
    }
    let output = Command::new("node")
        .arg(&fixture)
        .output()
        .expect("spawn node for fixture builder");
    if !output.status.success() {
        panic!(
            "fixture builder failed (exit {:?}):\nstderr:\n{}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr),
        );
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .expect("parse fixture stdout as JSON");
    serde_json::from_value(value).expect("fixture JSON → SetupPayload")
}

fn config_with(worker_count: usize, recycle_every: u32) -> OrchestratorConfig {
    // Inherit chrome_path from Default so the same dev/env resolution lookup
    // applies to integration tests; we only override the worker_count +
    // recycle cadence + renderer.cjs path.
    OrchestratorConfig {
        worker_count,
        recycle_every,
        renderer_cjs_path: renderer_cjs(),
        node_path: PathBuf::from("node"),
        ..OrchestratorConfig::default()
    }
}

fn assert_in_order_and_well_formed(frames: &[(u32, Vec<u8>)], expected_count: u32) {
    assert_eq!(
        frames.len() as u32,
        expected_count,
        "frame count mismatch (got {}, expected {})",
        frames.len(),
        expected_count,
    );
    for (i, (idx, bytes)) in frames.iter().enumerate() {
        assert_eq!(
            *idx, i as u32,
            "frame at position {} has frame_index={} (out of order)",
            i, idx,
        );
        assert_eq!(
            bytes.len(),
            EXPECTED_FRAME_BYTES,
            "frame {} has wrong size: got {} bytes, expected {}",
            idx,
            bytes.len(),
            EXPECTED_FRAME_BYTES,
        );
    }
    // First frame must not be all-zero (default style backgrounds paint
    // something well above #00000000). Mirrors the assertion in 020's
    // protocol.test.ts — confirms tile fetches succeeded and the worker
    // actually rendered, not just zero-filled the buffer.
    let first_all_zero = frames[0].1.iter().all(|b| *b == 0);
    assert!(!first_all_zero, "first rendered frame is all-zero RGBA");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn n1_four_frames_with_mid_run_recycle() {
    // 4 frames, 1 worker, recycle every 2 → forces a recycle between
    // frames 1 and 2. Asserts the recycle ready handshake doesn't disrupt
    // the frame stream and ordering is preserved.
    let setup = build_setup_payload();
    let sink = VecSink::new();
    let inspector = sink.clone();
    let config = config_with(1, 2);

    let count = render_map_frames(setup, 4, config, Box::new(sink))
        .await
        .expect("orchestrator run");
    assert_eq!(count, 4);

    let frames = inspector.frames();
    assert_in_order_and_well_formed(&frames, 4);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn n2_ten_frames_orders_across_workers_with_recycle() {
    // 10 frames, 2 workers (ranges 0..5 and 5..10), recycle every 4 →
    // each worker recycles once mid-range (after frame 3 in worker 0,
    // after frame 8 in worker 1; the final frame's recycle is suppressed
    // by the is_last guard). Frames may arrive interleaved from the two
    // workers; the ordering buffer must still emit in 0..10 order.
    let setup = build_setup_payload();
    let sink = VecSink::new();
    let inspector = sink.clone();
    let config = config_with(2, 4);

    let count = render_map_frames(setup, 10, config, Box::new(sink))
        .await
        .expect("orchestrator run");
    assert_eq!(count, 10);

    let frames = inspector.frames();
    assert_in_order_and_well_formed(&frames, 10);
}
