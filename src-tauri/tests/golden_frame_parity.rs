// Golden-frame parity test (task 117 + Phase 5 renderer strangle) — the
// pixel-level regression guard for the export renderer.
//
// What this protects: the rendered bytes for a known slow-pan camera path
// are pinned against committed truth (native-frame-XXXX.png). Any silent
// drift in the render stack (maplibre-gl-native binding bumps,
// `setGestureInProgress(true)` no-oping, the buffer:0 point-source
// contract, the remove/re-add source refresh, style/tile-cache
// regressions, per-frame paint-application changes — CANON §2.5 port
// contracts) shows up as a pixel mismatch on a committed PNG.
//
// History: until the Phase 5 cutover this file also pinned the chrome
// backend (frame-XXXX.png, byte-identical — GL JS rendered
// byte-deterministically). The chrome backend, its goldens, and its
// `TRAILCUT_CHROME_BIN` precondition were removed with the cutover; git
// history has them if an engine comparison is ever needed.
//
// NOTE: this is a RAW RENDERER FRAME pin — frames are captured from
// `render_map_frames` before any FFmpeg compositing or delivery-target
// color handling. It has no dependency on the HDR color lane; a
// delivered-look approval gate is a separate, deferred piece of work.
//
// Determinism contract: same (setup.json, frame_index) produces the same
// pixels every time, modulo a measured ±1-LSB GPU wobble (see
// `run_golden_parity`). Enforced structurally by:
//   - no wall-clock animation state (every animated value arrives
//     pre-resolved in the per-frame paint tuples from scene.ts),
//   - the on-disk tile cache (no network races on warm runs),
//   - the hand-authored timeline in the fixture (point intents, no Van
//     Wijk arcs, no time-based curves at all).
//
// macOS-only for v1 — cross-platform pixel determinism is task 130's
// concern. Skipped cleanly on other platforms via cfg(target_os).
//
// Gated on `--features integration_export` so routine `cargo test`
// doesn't pay the renderer-boot + 150-frame render cost.
//
// Preconditions (loud panic, never skip — docs/CANON.md §1.11):
//   - `npm run build:renderer` has produced
//     src-tauri/sidecars/renderer/dist/renderer.cjs AND staged the patched
//     maplibre-gl-native binding at src-tauri/binaries/mbgl-native-<triple>/.
//   - Network access on first run to populate OpenFreeMap tile cache;
//     subsequent runs work offline against `~/.cache/trailcut/tiles/`.
//
// Run:
//   cargo test --test golden_frame_parity --features integration_export -- --nocapture

#![cfg(feature = "integration_export")]
#![cfg(target_os = "macos")]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use trail_cut_lib::export::{
    canonical_map_viewport, render_map_frames, AspectRatio, FrameSink, OrchestratorConfig,
    OutputResolution, RendererBackend, SetupPayload, SinkError, Viewport,
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

fn renderer_cjs() -> PathBuf {
    manifest_dir()
        .join("sidecars")
        .join("renderer")
        .join("dist")
        .join("renderer.cjs")
}

fn assert_renderer_bundle_present() {
    let r = renderer_cjs();
    if !r.exists() {
        panic!(
            "Renderer bundle missing. Run `npm run build:renderer` first.\n\
             Expected: {}",
            r.display(),
        );
    }
}

/// Panic with an actionable message if the patched maplibre-gl-native binding
/// isn't staged where the orchestrator resolves it (TRAILCUT_MBGL_NATIVE_DIR
/// override or the dev layout under src-tauri/binaries/). Loud-failure rule
/// (docs/CANON.md §1.11): running `cargo test --features integration_export`
/// on a machine that can't support the test must FAIL, not silently pass —
/// the feature flag itself is the deliberate opt-in; once opted in, a green
/// run must mean the pixels were actually compared.
fn assert_native_binding_present(config: &OrchestratorConfig) {
    if !config.mbgl_native_dir.exists() {
        panic!(
            "Patched maplibre-gl-native binding missing at {} — \
             golden_frame_parity_native cannot run without it. Run \
             `npm run build:renderer` (or `npm run build:native-binding`) to \
             provision it, or set TRAILCUT_MBGL_NATIVE_DIR. Run `cargo test` \
             without `--features integration_export` if you did not intend to \
             run the renderer integration tests.",
            config.mbgl_native_dir.display(),
        );
    }
}

/// Load the committed setup.json fixture and reshape it into a SetupPayload.
/// The wire-only keys (`cmd`, `cssViewport`, `framebuffer`, `readback`,
/// `pixelRatio`, `fps`) are stripped so SetupPayload's flatten+typed wrapper
/// round-trips cleanly (a leaked duplicate key wins over the typed field on
/// re-serialization — the exact bug class Phase 5 fixed in
/// render_export_composite.rs).
fn load_setup_payload() -> SetupPayload {
    let path = fixture_dir().join("setup.json");
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
    let mut value: Value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|e| panic!("parse {}: {}", path.display(), e));
    if let Some(obj) = value.as_object_mut() {
        obj.remove("cmd");
        obj.remove("cssViewport");
        obj.remove("framebuffer");
        obj.remove("readback");
        obj.remove("pixelRatio");
        obj.remove("fps");
    }
    // 9_16 aspect, framebuffer = VIEWPORT_W × VIEWPORT_H. Under the
    // multiplier model `canonical_map_viewport` is the single source of
    // truth for (css_viewport, pixel_ratio); the golden fixture was
    // captured at the canonical 1080p reference resolution.
    let aspect = AspectRatio::NineSixteen;
    let framebuffer = Viewport { w: VIEWPORT_W, h: VIEWPORT_H };
    let canonical =
        canonical_map_viewport(aspect, framebuffer.w, framebuffer.h, OutputResolution::P1080);
    let css_viewport = Viewport { w: canonical.css_w, h: canonical.css_h };
    let pixel_ratio = canonical.pixel_ratio;
    SetupPayload {
        css_viewport,
        // Fixture predates SSAA — captured at supersample factor 1, so the
        // renderer paints and reads back at the same slot-sized buffer the
        // committed 540×960 golden PNGs were taken from.
        readback: framebuffer,
        framebuffer,
        pixel_ratio,
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

/// Drive the full fixture camera path through `config`'s renderer and diff
/// the captured frames against the committed `{golden_prefix}-XXXX.png` set.
///
/// Tolerance (mbgl/Metal): the GPU rasterizer has a measured ±1-LSB wobble
/// on a handful of AA edge pixels across identical runs (observed 0–10 px
/// of 518,400 per frame, always channel delta 1, over repeated runs
/// 2026-07-02). The pin allows exactly that class and nothing more:
/// per-channel delta ≤ 1 AND ≤ 0.01% of pixels differing. Any real
/// regression — a sub-pixel snap, a style/paint change, placement drift —
/// moves hundreds of pixels or produces deltas ≥ 2, and fails. (The retired
/// chrome/GL JS pin was byte-identical; that stack rendered
/// byte-deterministically.)
async fn run_golden_parity(
    config: OrchestratorConfig,
    golden_prefix: &str,
    max_chan_delta: i32,
    max_diff_pixel_fraction: f64,
) {
    let setup = load_setup_payload();
    let sink = CapturingSink::new(GOLDEN_FRAME_INDICES);
    let captured = sink.handle();

    let frames_written = render_map_frames(
        setup,
        TOTAL_FRAMES,
        config,
        Box::new(sink),
        None,
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

    let tmp = tempfile::tempdir().expect("tempdir");
    let mut failures: Vec<String> = Vec::new();
    for &idx in GOLDEN_FRAME_INDICES {
        let rendered = captured_map
            .get(&idx)
            .unwrap_or_else(|| panic!("missing captured frame {}", idx));
        let golden_path = fixture_dir().join(format!("{}-{:04}.png", golden_prefix, idx));
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
            let max_diff_pixels = (pixel_count as f64 * max_diff_pixel_fraction) as usize;
            let mut diff_pixels = 0usize;
            let mut frame_max_delta: i32 = 0;
            for i in 0..pixel_count {
                let off = i * 4;
                let mut pixel_diff = false;
                for c in 0..4 {
                    let d = (rendered[off + c] as i32 - golden_rgba[off + c] as i32).abs();
                    if d != 0 {
                        pixel_diff = true;
                        if d > frame_max_delta {
                            frame_max_delta = d;
                        }
                    }
                }
                if pixel_diff {
                    diff_pixels += 1;
                }
            }
            if frame_max_delta <= max_chan_delta && diff_pixels <= max_diff_pixels {
                eprintln!(
                    "frame {}: within tolerance ({} of {} pixels differ, max channel delta {} \
                     — allowed: delta ≤ {}, pixels ≤ {})",
                    idx, diff_pixels, pixel_count, frame_max_delta, max_chan_delta, max_diff_pixels,
                );
                continue;
            }
            // Write the rendered PNG to tmp for inspection.
            let dump = tmp
                .path()
                .join(format!("rendered-{}-{:04}.png", golden_prefix, idx));
            let _ = encode_rgba_png(rendered, VIEWPORT_W, VIEWPORT_H, &dump);
            failures.push(format!(
                "frame {}: byte mismatch ({} of {} pixels differ, max channel delta {}; \
                 allowed: delta ≤ {}, pixels ≤ {}). \
                 Rendered written to {}; compare against {}.",
                idx,
                diff_pixels,
                pixel_count,
                frame_max_delta,
                max_chan_delta,
                max_diff_pixels,
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
            "golden-frame parity ({}) failed:\n  - {}\n\nRendered frames preserved at: {}",
            golden_prefix,
            failures.join("\n  - "),
            kept.display(),
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn golden_frame_parity_native() {
    assert_renderer_bundle_present();
    let config = OrchestratorConfig {
        // Pin the backend on the worker child's env (never process-global —
        // tests share one process) so a stale parent env can never decide
        // what this test renders with.
        renderer_backend: Some(RendererBackend::Native),
        ..OrchestratorConfig::default()
    };
    assert_native_binding_present(&config);
    // ±1-LSB GPU wobble tolerance — see run_golden_parity docs for the
    // measured basis. 0.0001 of 518,400 px = 51 px ceiling vs observed ≤ 10.
    run_golden_parity(config, "native-frame", 1, 0.0001).await;
}
