// Golden-frame parity test (task 117) — the regression guard for the
// chromium renderer's wobble fix.
//
// What this protects: the painter monkey-patch in
// src-tauri/sidecars/renderer/page/painterPatch.ts forces
// `options.moving = true` to defeat sub-pixel snap on slow camera pans.
// If that patch silently no-ops (or maplibre-gl-js drifts on a version
// bump), the rendered bytes for a known slow-pan camera path change.
// Comparing against committed truth catches that.
//
// Determinism contract: same (setup.json, frame_index) produces the same
// RGBA bytes every time. Enforced structurally by:
//   - the chromium worker's frozen clock (`maplibregl.setNow(t)`),
//   - the page-level paint-transition stub (`stylesheet.transition =
//     {duration:0,delay:0}`),
//   - the on-disk tile cache (no network races on warm runs),
//   - the hand-authored timeline in the fixture (point intents, no Van
//     Wijk arcs, no time-based curves at all).
//
// macOS-only for v1 — cross-platform pixel determinism is task 130's
// concern. Skipped cleanly on other platforms via cfg(target_os).
//
// Gated on `--features integration_export` so routine `cargo test`
// doesn't pay the Chromium cold-launch cost (~5s warm, ~60s cold +
// network).
//
// Preconditions:
//   - `npm run build:renderer` has produced
//     src-tauri/sidecars/renderer/dist/{renderer.cjs,
//     page-init.bundle.js}.
//   - `TRAILCUT_CHROME_BIN` env var points at a Chrome binary (task 118
//     resolves this from the binary bundled into src-tauri/binaries/ by
//     `npm run build:renderer`).
//   - Network access on first run to populate OpenFreeMap tile cache;
//     subsequent runs work offline against `~/.cache/trailcut/tiles/`.
//
// Run:
//   TRAILCUT_CHROME_BIN=/path/to/chrome \
//     cargo test --test golden_frame_parity --features integration_export -- --nocapture

#![cfg(feature = "integration_export")]
#![cfg(target_os = "macos")]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use trail_cut_lib::export::{
    render_map_frames, FrameSink, OrchestratorConfig, SetupPayload, SinkError, Viewport,
};

/// Frame indices the fixture commits PNGs for. Times: 0s, 1s, 2s, 4s.
const GOLDEN_FRAME_INDICES: &[u32] = &[0, 30, 60, 120];

/// Total frames the orchestrator drives. fps=30, total=5s → 150 frames.
const TOTAL_FRAMES: u32 = 150;

const VIEWPORT_W: u32 = 540;
const VIEWPORT_H: u32 = 960;
const FPS: u32 = 30;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn fixture_dir() -> PathBuf {
    manifest_dir().join("tests").join("fixtures").join("golden-frames")
}

fn renderer_chromium_cjs() -> PathBuf {
    manifest_dir()
        .join("sidecars")
        .join("renderer")
        .join("dist")
        .join("renderer.cjs")
}

fn page_init_bundle() -> PathBuf {
    manifest_dir()
        .join("sidecars")
        .join("renderer")
        .join("dist")
        .join("page-init.bundle.js")
}

fn assert_chromium_bundle_present() {
    let r = renderer_chromium_cjs();
    let p = page_init_bundle();
    if !r.exists() || !p.exists() {
        panic!(
            "Chromium renderer bundle missing. Run `npm run build:renderer` first.\n\
             Expected: {}\n\
             Expected: {}",
            r.display(),
            p.display(),
        );
    }
}

/// Returns true if the env var is set, false otherwise. Caller skips the
/// test when false. Until task 118 bundles a Chrome binary, this env var is
/// the only way the chromium sidecar finds Chrome — and CI / clean checkouts
/// won't have it set. Skipping (instead of panicking) keeps
/// `cargo test --features integration_export` green by default and makes
/// opting in to this test a deliberate act.
fn chrome_bin_env_present() -> bool {
    std::env::var("TRAILCUT_CHROME_BIN")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

/// Load the committed setup.json fixture and reshape it into a SetupPayload.
/// The wire-only keys (`cmd`, `viewport`, `fps`) are stripped so SetupPayload's
/// flatten+typed wrapper round-trips cleanly.
fn load_setup_payload() -> SetupPayload {
    let path = fixture_dir().join("setup.json");
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
    let mut value: Value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|e| panic!("parse {}: {}", path.display(), e));
    if let Some(obj) = value.as_object_mut() {
        obj.remove("cmd");
        obj.remove("viewport");
        obj.remove("fps");
    }
    SetupPayload {
        viewport: Viewport {
            w: VIEWPORT_W,
            h: VIEWPORT_H,
        },
        fps: FPS,
        project_state: value,
    }
}

/// Decode a PNG file to a flat RGBA8 byte vector. Uses the `png` crate that's
/// already a direct dep (no new crate needed).
fn decode_png_rgba(path: &PathBuf) -> (u32, u32, Vec<u8>) {
    let file = std::fs::File::open(path)
        .unwrap_or_else(|e| panic!("open {}: {}", path.display(), e));
    let decoder = png::Decoder::new(file);
    let mut reader = decoder
        .read_info()
        .unwrap_or_else(|e| panic!("read_info {}: {}", path.display(), e));
    let info = reader.info().clone();

    // We want RGBA8 output. The committed PNGs are written by encode_rgba_png
    // below as Rgba/8, so this is a straight read; defensive code path for
    // anyone hand-crafting a PNG with another color type — convert by way of
    // the `png` crate's transformation hooks would be more robust, but
    // since we own the encoder this is fine.
    if info.color_type != png::ColorType::Rgba || info.bit_depth != png::BitDepth::Eight {
        panic!(
            "{}: expected RGBA/8 PNG (got color_type={:?}, bit_depth={:?})",
            path.display(),
            info.color_type,
            info.bit_depth,
        );
    }

    let mut buf = vec![0u8; reader.output_buffer_size()];
    let frame = reader
        .next_frame(&mut buf)
        .unwrap_or_else(|e| panic!("decode {}: {}", path.display(), e));
    let bytes = buf[..frame.buffer_size()].to_vec();
    (info.width, info.height, bytes)
}

/// PNG-encode an RGBA8 buffer at (w,h). Used to write rendered frames to a
/// temp dir on diff failure (so the dev can eyeball them) and by the regen
/// test to update the committed fixtures.
pub(crate) fn encode_rgba_png(
    rgba: &[u8],
    w: u32,
    h: u32,
    out: &PathBuf,
) -> std::io::Result<()> {
    let file = std::fs::File::create(out)?;
    let buf_writer = std::io::BufWriter::new(file);
    let mut encoder = png::Encoder::new(buf_writer, w, h);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    writer
        .write_image_data(rgba)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    Ok(())
}

/// Sink that captures only specific frame indices (others discarded). Lets us
/// drive the orchestrator over the full 0..150 range while only paying memory
/// for the four frames we'll diff.
pub(crate) struct CapturingSink {
    /// Indices we want to capture, dedup'd and sorted at construction.
    pub(crate) wanted: Vec<u32>,
    /// frame_index → RGBA bytes. Shared for post-run inspection.
    pub(crate) captured: Arc<Mutex<HashMap<u32, Vec<u8>>>>,
}

impl CapturingSink {
    pub(crate) fn new(wanted: &[u32]) -> Self {
        let mut sorted: Vec<u32> = wanted.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        Self {
            wanted: sorted,
            captured: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub(crate) fn handle(&self) -> Arc<Mutex<HashMap<u32, Vec<u8>>>> {
        self.captured.clone()
    }
}

impl FrameSink for CapturingSink {
    fn write_frame(&mut self, frame_index: u32, rgba: &[u8]) -> Result<(), SinkError> {
        if self.wanted.binary_search(&frame_index).is_ok() {
            self.captured
                .lock()
                .unwrap()
                .insert(frame_index, rgba.to_vec());
        }
        Ok(())
    }

    fn finish(self: Box<Self>) -> Result<(), SinkError> {
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn golden_frame_parity_chromium() {
    if !chrome_bin_env_present() {
        eprintln!(
            "SKIP golden_frame_parity_chromium: TRAILCUT_CHROME_BIN not set. \
             Set it to a Chrome binary path to run this test. See \
             docs/export/tasks/117-golden-frame-parity.md for the dev-mode path."
        );
        return;
    }
    assert_chromium_bundle_present();

    let setup = load_setup_payload();
    let sink = CapturingSink::new(GOLDEN_FRAME_INDICES);
    let captured = sink.handle();

    let frames_written = render_map_frames(
        setup,
        TOTAL_FRAMES,
        OrchestratorConfig::default(),
        Box::new(sink),
    )
    .await
    .expect("render_map_frames");
    assert_eq!(frames_written, TOTAL_FRAMES, "all frames should be emitted");

    let captured_map = captured.lock().unwrap().clone();
    assert_eq!(
        captured_map.len(),
        GOLDEN_FRAME_INDICES.len(),
        "expected to capture {} frames, got {}",
        GOLDEN_FRAME_INDICES.len(),
        captured_map.len(),
    );

    // Diff each captured frame against the committed PNG. Byte-identical
    // (no tolerance) per task 117 — we're snapshotting a deterministic
    // chromium render against itself; any drift is information.
    let tmp = tempfile::tempdir().expect("tempdir");
    let mut failures: Vec<String> = Vec::new();
    for &idx in GOLDEN_FRAME_INDICES {
        let rendered = captured_map
            .get(&idx)
            .unwrap_or_else(|| panic!("missing captured frame {}", idx));
        let golden_path = fixture_dir().join(format!("frame-{:04}.png", idx));
        let (gw, gh, golden_rgba) = decode_png_rgba(&golden_path);
        if gw != VIEWPORT_W || gh != VIEWPORT_H {
            failures.push(format!(
                "frame {}: golden PNG dims mismatch ({}x{} vs expected {}x{})",
                idx, gw, gh, VIEWPORT_W, VIEWPORT_H,
            ));
            continue;
        }
        if rendered.len() != golden_rgba.len() {
            failures.push(format!(
                "frame {}: rendered len {} != golden len {}",
                idx,
                rendered.len(),
                golden_rgba.len(),
            ));
            continue;
        }
        if rendered.as_slice() != golden_rgba.as_slice() {
            // Count differing pixels so the failure message is diagnostic.
            let pixel_count = (VIEWPORT_W * VIEWPORT_H) as usize;
            let mut diff_pixels = 0usize;
            let mut max_chan_delta: i32 = 0;
            for i in 0..pixel_count {
                let off = i * 4;
                let mut pixel_diff = false;
                for c in 0..4 {
                    let d = (rendered[off + c] as i32 - golden_rgba[off + c] as i32).abs();
                    if d != 0 {
                        pixel_diff = true;
                        if d > max_chan_delta {
                            max_chan_delta = d;
                        }
                    }
                }
                if pixel_diff {
                    diff_pixels += 1;
                }
            }
            // Write the rendered PNG to tmp for inspection.
            let dump = tmp.path().join(format!("rendered-frame-{:04}.png", idx));
            let _ = encode_rgba_png(rendered, VIEWPORT_W, VIEWPORT_H, &dump);
            failures.push(format!(
                "frame {}: byte mismatch ({} of {} pixels differ, max channel delta {}). \
                 Rendered written to {}; compare against {}.",
                idx,
                diff_pixels,
                pixel_count,
                max_chan_delta,
                dump.display(),
                golden_path.display(),
            ));
        }
    }

    if !failures.is_empty() {
        // Keep the tempdir so the dump survives test exit — the dev path here
        // is to inspect the dumped PNGs against the committed fixtures.
        let kept = tmp.keep();
        panic!(
            "golden-frame parity failed:\n  - {}\n\nRendered frames preserved at: {}",
            failures.join("\n  - "),
            kept.display(),
        );
    }
}
