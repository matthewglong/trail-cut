// Golden-frame regeneration helper (task 117). Renders the golden frames
// listed in golden_frame_parity.rs and writes them back to the fixture
// directory, overwriting the committed PNGs.
//
// `#[ignore]`-by-default so it never runs in routine CI; intended as a
// manual operation when:
//   - bumping maplibre-gl,
//   - making a deliberate visual change to mapVisuals/,
//   - OpenFreeMap changes its style or tile data.
//
// Run (manual):
//   TRAILCUT_CHROME_BIN=/path/to/chrome \
//     cargo test --test golden_frame_regenerate --features integration_export -- --ignored --nocapture
//
// After a regen: `git diff` the four PNG fixtures, eyeball them (open in
// Preview), and commit if they look correct. The byte-comparison parity
// test is what gates correctness from there on.
//
// macOS-only — same constraint as the parity test.

#![cfg(feature = "integration_export")]
#![cfg(target_os = "macos")]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::collections::HashMap;

use serde_json::Value;

use trail_cut_lib::export::{
    canonical_map_viewport, render_map_frames, AspectRatio, FrameSink, OrchestratorConfig,
    OutputResolution, SetupPayload, SinkError, Viewport,
};

const GOLDEN_FRAME_INDICES: &[u32] = &[0, 30, 60, 120];
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
            "Chromium renderer bundle missing. Run `npm run build:renderer` first."
        );
    }
}

fn assert_chrome_bin_env() {
    if std::env::var("TRAILCUT_CHROME_BIN").is_err() {
        panic!("TRAILCUT_CHROME_BIN env var not set.");
    }
}

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
        obj.remove("pixelRatio");
        obj.remove("fps");
    }
    let aspect = AspectRatio::NineSixteen;
    let framebuffer = Viewport { w: VIEWPORT_W, h: VIEWPORT_H };
    let canonical =
        canonical_map_viewport(aspect, framebuffer.w, framebuffer.h, OutputResolution::P1080);
    let css_viewport = Viewport { w: canonical.css_w, h: canonical.css_h };
    let pixel_ratio = canonical.pixel_ratio;
    SetupPayload {
        css_viewport,
        framebuffer,
        pixel_ratio,
        fps: FPS,
        project_state: value,
    }
}

fn encode_rgba_png(rgba: &[u8], w: u32, h: u32, out: &PathBuf) -> std::io::Result<()> {
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

struct CapturingSink {
    wanted: Vec<u32>,
    captured: Arc<Mutex<HashMap<u32, Vec<u8>>>>,
}

impl CapturingSink {
    fn new(wanted: &[u32]) -> Self {
        let mut sorted: Vec<u32> = wanted.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        Self {
            wanted: sorted,
            captured: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn handle(&self) -> Arc<Mutex<HashMap<u32, Vec<u8>>>> {
        self.captured.clone()
    }
}

impl FrameSink for CapturingSink {
    fn write_frame(&mut self, frame_index: u32, rgba: &[u8]) -> Result<(), SinkError> {
        if self.wanted.binary_search(&frame_index).is_ok() {
            self.captured.lock().unwrap().insert(frame_index, rgba.to_vec());
        }
        Ok(())
    }

    fn finish(self: Box<Self>) -> Result<(), SinkError> {
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "regen is manual; runs only with --ignored"]
async fn regenerate_golden_frames() {
    assert_chromium_bundle_present();
    assert_chrome_bin_env();

    let setup = load_setup_payload();
    let sink = CapturingSink::new(GOLDEN_FRAME_INDICES);
    let captured = sink.handle();

    let frames_written = render_map_frames(
        setup,
        TOTAL_FRAMES,
        OrchestratorConfig::default(),
        Box::new(sink),
        None,
    )
    .await
    .expect("render_map_frames");
    assert_eq!(frames_written, TOTAL_FRAMES);

    let captured_map = captured.lock().unwrap().clone();
    assert_eq!(captured_map.len(), GOLDEN_FRAME_INDICES.len());

    let dir = fixture_dir();
    for &idx in GOLDEN_FRAME_INDICES {
        let rgba = captured_map.get(&idx).expect("captured frame");
        let path = dir.join(format!("frame-{:04}.png", idx));
        encode_rgba_png(rgba, VIEWPORT_W, VIEWPORT_H, &path)
            .unwrap_or_else(|e| panic!("write {}: {}", path.display(), e));
        eprintln!("wrote {}", path.display());
    }
    eprintln!(
        "Regen complete. Inspect each PNG visually (open in Preview), then commit. \
         Re-run `cargo test --test golden_frame_parity --features integration_export` \
         to confirm parity holds."
    );
}
