// Integration test for the Channel B (map-only) end-to-end pipeline (task 060).
//
// Drives `render_export` against the real bundled renderer + system FFmpeg,
// produces a `.mov` on disk, and asserts FFprobe reports the expected
// (width, height, codec, pixel format with alpha, duration). Reads frame 30
// of the output and spot-checks alpha=0 outside the inset rect, alpha=255
// inside.
//
// Gated on `--features integration_export` so routine `cargo test` doesn't
// pay the ~5–15s wall clock and the dependency on FFmpeg + Node + maplibre-
// native + network (cold tile fetches). Mirrors 030's bundle-guard pattern.
//
// PRECONDITIONS (run once before this test):
//   npm run build:renderer
//   ffmpeg / ffprobe on PATH
//
// Run:
//   cargo test --test render_export_map_only --features integration_export -- --nocapture

#![cfg(feature = "integration_export")]

use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;
use tempfile::TempDir;
use trail_cut_lib::export::{
    default_layout, default_pip_layout, default_split_layout, output_dims, render_export_inner,
    resolve_slots, AspectRatio, CodecPreference, DeliveryTarget, LayoutConfig, LayoutDescriptor,
    OutputResolution, RenderExportRequest,
};

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

fn assert_bundle_present() {
    let renderer = renderer_cjs();
    let fixture = setup_fixture_cjs();
    if !renderer.exists() || !fixture.exists() {
        panic!(
            "Renderer bundle artifacts missing. Run `npm run build:renderer` first.\n\
             Expected: {}\n\
             Expected: {}",
            renderer.display(),
            fixture.display(),
        );
    }
}

fn assert_ffmpeg_on_path() {
    let probe = Command::new("ffmpeg").arg("-version").output();
    if probe.map(|o| !o.status.success()).unwrap_or(true) {
        panic!("ffmpeg not on PATH (or non-zero exit). Install via `brew install ffmpeg`.");
    }
    let probe = Command::new("ffprobe").arg("-version").output();
    if probe.map(|o| !o.status.success()).unwrap_or(true) {
        panic!("ffprobe not on PATH (ships with ffmpeg).");
    }
}

/// Build the Rust-side `RenderExportRequest` by exec'ing the same JS fixture
/// builder the orchestrator integration test uses, then wrapping its output
/// with a 9:16 PiP layout descriptor and the export envelope keys.
fn build_request(output_path: &str) -> RenderExportRequest {
    assert_bundle_present();
    let fixture = setup_fixture_cjs();
    let output = Command::new("node")
        .arg(&fixture)
        .output()
        .expect("spawn node fixture");
    if !output.status.success() {
        panic!(
            "fixture builder failed: {}",
            String::from_utf8_lossy(&output.stderr),
        );
    }
    let mut setup_value: Value = serde_json::from_slice(&output.stdout)
        .expect("fixture stdout → JSON");
    // Strip wire-only keys the renderer worker expects but `render_export`
    // doesn't (the SetupPayload re-injects `cmd`/`cssViewport`/`framebuffer`/
    // `pixelRatio` itself).
    if let Some(obj) = setup_value.as_object_mut() {
        obj.remove("cmd");
        obj.remove("cssViewport");
        obj.remove("framebuffer");
        obj.remove("readback");
        obj.remove("pixelRatio");
        obj.remove("fps");
    }

    let aspect = AspectRatio::NineSixteen;
    let layout = default_layout(aspect);
    let resolved = resolve_slots(&layout, aspect, OutputResolution::default());
    let layout_descriptor = LayoutDescriptor {
        aspect,
        resolution: OutputResolution::default(),
        layout,
        resolved,
    };

    // Build the request manually — `RenderExportRequest` uses
    // `#[serde(flatten)]` for project_state, so we can pass the whole
    // setup object as that field.
    RenderExportRequest {
        channel: "map_only".to_string(),
        fps: 30,
        output_path: output_path.to_string(),
        layout: layout_descriptor,
        codec_preference: CodecPreference::default(),
        audio_bitrate_kbps: 256,
        // WS4: map_only is locked to ProresMaster (lossless intermediate).
        delivery_target: DeliveryTarget::Prores,
        project_state: setup_value,
    }
}

fn ffprobe_streams(path: &PathBuf) -> Value {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_streams",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .expect("spawn ffprobe");
    if !out.status.success() {
        panic!(
            "ffprobe failed for {}:\n{}",
            path.display(),
            String::from_utf8_lossy(&out.stderr),
        );
    }
    serde_json::from_slice(&out.stdout).expect("ffprobe stdout → JSON")
}

fn extract_rgba_frame(input: &PathBuf, frame_idx: u32, w: u32, h: u32) -> Vec<u8> {
    // FFmpeg pipeline: select the requested frame, decode to rawvideo rgba.
    let out = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
        ])
        .arg(input)
        .args([
            "-vf",
            &format!("select=eq(n\\,{})", frame_idx),
            "-vsync",
            "0",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-",
        ])
        .output()
        .expect("spawn ffmpeg frame extract");
    if !out.status.success() {
        panic!(
            "ffmpeg frame-extract failed: {}",
            String::from_utf8_lossy(&out.stderr),
        );
    }
    let expected = (w as usize) * (h as usize) * 4;
    assert_eq!(out.stdout.len(), expected, "extracted frame size mismatch");
    out.stdout
}

fn alpha_at(rgba: &[u8], w: u32, x: u32, y: u32) -> u8 {
    rgba[((y * w + x) as usize) * 4 + 3]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn map_only_export_produces_valid_mov() {
    assert_ffmpeg_on_path();
    assert_bundle_present();

    let tmp = TempDir::new().expect("tempdir");
    let output_path = tmp.path().join("map_only.mov");
    let req = build_request(output_path.to_string_lossy().as_ref());
    // 2-second route in the fixture × 30 fps = 60 frames expected.
    let resolved = req.layout.resolved.clone();

    let summary = render_export_inner(req, None)
        .await
        .expect("render_export should succeed end-to-end");
    assert_eq!(summary.frames_written, 60);

    // ---- ffprobe assertions ----
    let probe = ffprobe_streams(&output_path);
    let streams = probe["streams"].as_array().expect("streams array");
    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video")
        .expect("video stream");
    let audio_count = streams.iter().filter(|s| s["codec_type"] == "audio").count();
    assert_eq!(audio_count, 0, "Channel B is silent: -an should yield 0 audio streams");

    assert_eq!(video["codec_name"], "prores");
    // ProRes 4444 (with alpha) is identified by `codec_tag_string="ap4h"` and
    // `profile="4444"` — both encoded into the file's container metadata and
    // stable across FFmpeg versions. The probed `pix_fmt` is *not* stable:
    // FFmpeg's prores decoder upcasts samples to 12-bit on read, so
    // FFmpeg ≥ 8.0 reports `yuva444p12le` even for streams encoded as
    // `yuva444p10le` (which is what `prores_ks -profile:v 4444` writes — see
    // `encoder.rs::candidates_for(ProResAlpha)`). The codec_tag is what
    // actually distinguishes 4444 from 4444 XQ (`ap4x`).
    assert_eq!(video["codec_tag_string"], "ap4h", "expected ProRes 4444 (ap4h)");
    assert_eq!(video["profile"], "4444");
    assert!(
        video["pix_fmt"] == "yuva444p10le" || video["pix_fmt"] == "yuva444p12le",
        "unexpected pix_fmt {} — ProRes 4444 reads as 10le on FFmpeg < 8 and 12le on >= 8",
        video["pix_fmt"],
    );
    assert_eq!(video["width"].as_u64().unwrap(), 1080);
    assert_eq!(video["height"].as_u64().unwrap(), 1920);

    let nb_frames = video["nb_frames"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .or_else(|| video["nb_frames"].as_u64())
        .expect("nb_frames present");
    assert_eq!(nb_frames, 60);

    let duration = video["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .or_else(|| video["duration"].as_f64())
        .expect("duration present");
    assert!(
        (1.99..=2.01).contains(&duration),
        "duration {} not in [1.99, 2.01]",
        duration,
    );

    // ---- frame-30 alpha spot check ----
    // Outside the inset (default 9:16 layout puts map_slot at roughly
    // (702, 1497, 346, 346)): pixel (10, 10) must be alpha=0.
    // Inside the inset center: alpha=255 and non-zero RGB.
    let frame = extract_rgba_frame(&output_path, 30, 1080, 1920);
    let outside_a = alpha_at(&frame, 1080, 10, 10);
    assert_eq!(
        outside_a, 0,
        "pixel (10,10) outside inset must be transparent"
    );

    let cx = resolved.map_slot.x + resolved.map_slot.w / 2;
    let cy = resolved.map_slot.y + resolved.map_slot.h / 2;
    let center_a = alpha_at(&frame, 1080, cx, cy);
    assert_eq!(
        center_a, 255,
        "inset center must be fully opaque (got {})",
        center_a,
    );
    let i = ((cy * 1080 + cx) as usize) * 4;
    let (r, g, b) = (frame[i], frame[i + 1], frame[i + 2]);
    assert!(
        !(r == 0 && g == 0 && b == 0),
        "inset center should have non-zero RGB (map rendered something), got ({},{},{})",
        r,
        g,
        b,
    );
}

/// Build a Channel B request at an arbitrary `(aspect, layout)` cell. The
/// fixture's project state (clips, route, mapSettings) is aspect-agnostic;
/// only the layout descriptor varies. Used by the task 100 matrix tests.
#[cfg(feature = "integration_export_matrix")]
fn build_request_with_layout(
    output_path: &str,
    aspect: AspectRatio,
    layout: LayoutConfig,
) -> RenderExportRequest {
    assert_bundle_present();
    let fixture = setup_fixture_cjs();
    let output = Command::new("node")
        .arg(&fixture)
        .output()
        .expect("spawn node fixture");
    if !output.status.success() {
        panic!(
            "fixture builder failed: {}",
            String::from_utf8_lossy(&output.stderr),
        );
    }
    let mut setup_value: Value =
        serde_json::from_slice(&output.stdout).expect("fixture stdout → JSON");
    if let Some(obj) = setup_value.as_object_mut() {
        obj.remove("cmd");
        obj.remove("cssViewport");
        obj.remove("framebuffer");
        obj.remove("readback");
        obj.remove("pixelRatio");
        obj.remove("fps");
    }

    let resolved = resolve_slots(&layout, aspect, OutputResolution::default());
    let layout_descriptor = LayoutDescriptor {
        aspect,
        resolution: OutputResolution::default(),
        layout,
        resolved,
    };
    RenderExportRequest {
        channel: "map_only".to_string(),
        fps: 30,
        output_path: output_path.to_string(),
        layout: layout_descriptor,
        codec_preference: CodecPreference::default(),
        audio_bitrate_kbps: 256,
        // WS4: map_only is locked to ProresMaster (lossless intermediate).
        delivery_target: DeliveryTarget::Prores,
        project_state: setup_value,
    }
}

/// Task 100 matrix: render Channel B at every (PiP, Split) × (9:16, 4:5,
/// 16:9) cell and verify FFprobe sees the correct dims, codec, and pixel
/// format. Existing 9:16-PiP smoke test stays as the unconditional baseline;
/// this matrix runs only under `--features integration_export_matrix`.
#[cfg(feature = "integration_export_matrix")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn channel_b_full_matrix() {
    assert_ffmpeg_on_path();
    assert_bundle_present();

    let aspects = [
        AspectRatio::NineSixteen,
        AspectRatio::FourFive,
        AspectRatio::SixteenNine,
    ];
    for aspect in aspects {
        for (mode, layout) in [
            ("pip", default_pip_layout(aspect)),
            ("split", default_split_layout(aspect)),
        ] {
            let tmp = TempDir::new().expect("tempdir");
            let output_path = tmp
                .path()
                .join(format!("map_only_{:?}_{}.mov", aspect, mode));
            let req = build_request_with_layout(
                output_path.to_string_lossy().as_ref(),
                aspect,
                layout,
            );

            render_export_inner(req, None).await.unwrap_or_else(|e| {
                panic!("render_export failed for ({:?}, {}): {:?}", aspect, mode, e)
            });

            let probe = ffprobe_streams(&output_path);
            let streams = probe["streams"].as_array().expect("streams array");
            let video = streams
                .iter()
                .find(|s| s["codec_type"] == "video")
                .unwrap_or_else(|| panic!("no video stream for ({:?}, {})", aspect, mode));
            assert_eq!(video["codec_name"], "prores", "{:?} {}", aspect, mode);
            // See the unconditional smoke test for the FFmpeg-version pix_fmt
            // caveat — assert on codec_tag_string + profile, accept either bit
            // depth in pix_fmt.
            assert_eq!(
                video["codec_tag_string"], "ap4h",
                "{:?} {} codec_tag mismatch",
                aspect,
                mode,
            );
            assert_eq!(video["profile"], "4444", "{:?} {} profile", aspect, mode);
            assert!(
                video["pix_fmt"] == "yuva444p10le" || video["pix_fmt"] == "yuva444p12le",
                "{:?} {}: unexpected pix_fmt {}",
                aspect,
                mode,
                video["pix_fmt"],
            );

            let dims = output_dims(aspect, OutputResolution::default());
            assert_eq!(
                video["width"].as_u64().unwrap() as u32,
                dims.w,
                "{:?} {} width",
                aspect,
                mode,
            );
            assert_eq!(
                video["height"].as_u64().unwrap() as u32,
                dims.h,
                "{:?} {} height",
                aspect,
                mode,
            );
            // Audio stream: Channel B is silent end-to-end.
            let audio_count = streams.iter().filter(|s| s["codec_type"] == "audio").count();
            assert_eq!(audio_count, 0, "{:?} {} should be silent", aspect, mode);
        }
    }
}
